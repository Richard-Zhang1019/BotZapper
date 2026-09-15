/**
 * 推妖镜 BotZapper · 内容脚本主逻辑
 *
 * 职责：监听 X 的 SPA DOM 流 → 抽取每条推文的语言学特征 → 本地评分 →
 * 把节点渲染到目标状态（clean/flag/blocked）。识别阶段零网络请求。
 * 拉黑动作全部交给 service worker 的串行队列。
 */
(function (root) {
  'use strict';

  var BZ = root.BotZapper;
  if (!BZ || !BZ.detector || !BZ.ui || !BZ.storage) return; // 依赖未就绪（脚本顺序错误）

  var DOC = root.document;
  if (!DOC || !DOC.body) return;

  // —— 运行时缓存（storage 的本地镜像，storage.onChanged 时刷新）——
  var settings = Object.assign({}, BZ.storage.DEFAULT_SETTINGS);
  var marks = {};
  var whitelist = {};
  var queueState = BZ.storage.defaultQueueState();
  var stats = { totalBlocked: 0, dailyDate: '', dailyBlocked: 0 };
  var pendingSet = new Set();   // 已入队、等待结果确认的账号
  var loginHandle = null;       // 当前登录用户（强制白名单）
  var badge = null;
  var scanTimer = null;

  function threshold() {
    return BZ.storage.THRESHOLD_BY_SENSITIVITY[settings.sensitivity] || BZ.detector.DEFAULT_THRESHOLD;
  }

  function getCsrf() {
    var m = DOC.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /**
   * 从页面同源上下文发起原生拉黑（cookie 附着最有保证）。
   * 由 service worker 队列通过 FIRE_BLOCK 消息调度，时序控制权仍在 SW。
   */
  function fireBlockFromPage(screenName) {
    var csrf = getCsrf();
    if (!csrf) return Promise.resolve({ status: 'auth_error' });
    var auth = BZ.auth;
    return fetch(auth.BLOCK_PATH, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'authorization': 'Bearer ' + auth.WEB_BEARER,
        'x-csrf-token': csrf,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ screen_name: screenName, skip_status: '1' }).toString()
    }).then(function (res) {
      return auth.mapResponse(res);
    }).catch(function () {
      return { status: 'network_error' };
    });
  }

  if (root.chrome && root.chrome.runtime && root.chrome.runtime.onMessage) {
    root.chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (msg && msg.type === 'FIRE_BLOCK' && msg.screenName) {
        fireBlockFromPage(msg.screenName).then(sendResponse);
        return true; // 异步响应
      }
    });
  }

  function detectLoginUser() {
    if (loginHandle) return loginHandle;
    var link = DOC.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (link) {
      var m = (link.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (m) loginHandle = m[1];
    }
    return loginHandle;
  }

  // —— DOM 抽取 ——

  function extractInfo(article) {
    var authorLink = null;
    var links = article.querySelectorAll('a[href^="/"]');
    for (var i = 0; i < links.length; i++) {
      var m = (links[i].getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (m) { authorLink = links[i]; break; } // DOM 顺序上作者链接最早出现
    }
    if (!authorLink) return null;
    var textEl = article.querySelector('[data-testid="tweetText"]');
    return {
      handle: authorLink.hostname === root.location.hostname ? authorLink.pathname.slice(1) : authorLink.getAttribute('href').slice(1),
      displayName: (authorLink.textContent || '').trim().slice(0, 60),
      text: textEl ? (textEl.innerText || '').slice(0, 2000) : ''
    };
  }

  // —— 状态判定 ——
  // 返回 'clean' | 'flag' | 'blocked'，以及 flag 时的检测结果
  function decide(article) {
    var info = extractInfo(article);
    if (!info) return null;
    var key = info.handle.toLowerCase();
    info.key = key;

    var me = detectLoginUser();
    if (me && key === me.toLowerCase()) return { state: 'clean', info: info };
    if (whitelist[key]) return { state: 'clean', info: info };
    if (marks[key]) return { state: 'blocked', info: info };

    var result = BZ.detector.analyze({ text: info.text, displayName: info.displayName }, threshold());
    if (!result.flagged) return { state: 'clean', info: info };
    return { state: 'flag', info: info, result: result };
  }

  function scan() {
    var articles = DOC.querySelectorAll('article[data-testid="tweet"]');
    var flaggedCount = 0;

    for (var i = 0; i < articles.length; i++) {
      var article = articles[i];
      var verdict = decide(article);
      if (!verdict) continue;

      if (!settings.enabled || verdict.state === 'clean') {
        if (article.dataset.tz) BZ.ui.renderArticle(article, { state: 'clean' }, actions);
        continue;
      }
      if (verdict.state === 'blocked') {
        BZ.ui.renderArticle(article, { state: 'blocked', handle: verdict.info.handle }, actions);
        continue;
      }
      // flag
      flaggedCount++;
      BZ.ui.renderArticle(article, {
        state: 'flag',
        handle: verdict.info.handle,
        score: verdict.result.score,
        hits: verdict.result.hits,
        pending: pendingSet.has(verdict.info.key)
      }, actions);
    }

    if (badge) {
      badge.update({
        visible: settings.enabled && settings.showBadge,
        enabled: settings.enabled,
        count: flaggedCount,
        loggedIn: !!getCsrf(),
        queuePaused: !!queueState.paused,
        pauseReason: queueState.reason,
        pauseNote: queueState.lastError,
        dailyReached: stats.dailyBlocked >= settings.dailyLimit,
        pendingAny: pendingSet.size > 0
      });
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      scan();
    }, 300);
  }

  // —— 与后台队列通信 ——

  function send(msg) {
    return new Promise(function (resolve) {
      try {
        root.chrome.runtime.sendMessage(msg, function (res) {
          void chrome.runtime.lastError; // 弹窗关闭等场景忽略
          resolve(res || { ok: false });
        });
      } catch (e) {
        resolve({ ok: false });
      }
    });
  }

  var actions = {
    onBlock: function (handle) {
      var csrf = getCsrf();
      if (!csrf) return;
      pendingSet.add(handle.toLowerCase());
      scan();
      send({ type: 'ENQUEUE_BLOCKS', users: [{ screenName: handle }], csrf: csrf }).then(function (res) {
        if (!res.ok) { pendingSet.delete(handle.toLowerCase()); scan(); }
      });
    },
    onBlockAll: function () {
      var csrf = getCsrf();
      if (!csrf) return;
      var users = [];
      var articles = DOC.querySelectorAll('article[data-testid="tweet"][data-tz="flag"]');
      for (var i = 0; i < articles.length; i++) {
        var verdict = decide(articles[i]);
        if (verdict && verdict.state === 'flag' && !pendingSet.has(verdict.info.key)) {
          users.push({ screenName: verdict.info.handle });
          pendingSet.add(verdict.info.key);
        }
      }
      if (!users.length) return;
      scan();
      send({ type: 'ENQUEUE_BLOCKS', users: users, csrf: csrf }).then(function (res) {
        if (!res.ok) { users.forEach(function (u) { pendingSet.delete(u.screenName.toLowerCase()); }); scan(); }
      });
    },
    onPardon: function (handle) {
      BZ.storage.addWhitelist(handle, 'user').then(function () {
        // storage.onChanged 会触发重扫；这里本地同步改一份，即时反馈
        whitelist[handle.toLowerCase()] = { ts: Date.now(), source: 'user' };
        pendingSet.delete(handle.toLowerCase());
        scan();
      });
    }
  };

  // —— 缓存刷新 ——

  function refreshCaches() {
    return Promise.all([
      BZ.storage.getSettings().then(function (s) { settings = s; }),
      BZ.storage.getMarks().then(function (m) { marks = m; }),
      BZ.storage.getWhitelist().then(function (w) { whitelist = w; }),
      BZ.storage.getQueueState().then(function (q) { queueState = q; }),
      BZ.storage.getStats().then(function (s) { stats = s; })
    ]);
  }

  function teardown() {
    var articles = DOC.querySelectorAll('article[data-testid="tweet"]');
    for (var i = 0; i < articles.length; i++) {
      BZ.ui.renderArticle(articles[i], { state: 'clean' }, actions);
    }
  }

  // —— 启动 ——

  function init() {
    BZ.ui.ensureStyles(DOC);
    badge = BZ.ui.createBadge(DOC, actions);
    refreshCaches().then(scan);

    var observer = new MutationObserver(scheduleScan);
    observer.observe(DOC.body, { childList: true, subtree: true });

    BZ.storage.onChange(function (changes) {
      var relevant = ['settings', 'marks', 'whitelist', 'queueState', 'stats', 'queue'];
      var touched = relevant.some(function (k) { return changes[k]; });
      if (!touched) return;
      // 拉黑结果确认：marks 出现即移出 pending
      if (changes.marks) {
        Object.keys(changes.marks.newValue || {}).forEach(function (sn) { pendingSet.delete(sn); });
      }
      refreshCaches().then(scan);
    });
  }

  init();

  // 供 fixture 测试页手动重扫
  root.BotZapper.content = { scan: scan, actions: actions, extractInfo: extractInfo };
})(typeof self !== 'undefined' ? self : globalThis);

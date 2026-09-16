/**
 * 推妖镜 BotZapper · 内容脚本主逻辑
 *
 * 职责：监听 X 的 SPA DOM 流 → 抽取每条推文的语言学特征 → 本地评分 →
 * 把节点渲染到目标状态（clean/flag/blocked）。识别阶段零网络请求。
 * 拉黑/撤销动作全部交给 service worker 的串行队列。
 *
 * 性能设计：
 *   - 两阶段扫描：第一阶段只做轻量抽取并统计「同页复读」聚类，第二阶段评分
 *   - 指纹短路：已评分推文按 (账号+文本哈希+复读计数+缓存代数) 跳过重算，
 *     仅在存储变更（marks/白名单/词库/设置）时提升缓存代数强制全量重算
 */
(function (root) {
  'use strict';

  var BZ = root.BotZapper;
  if (!BZ || !BZ.detector || !BZ.ui || !BZ.storage) return; // 依赖未就绪（脚本顺序错误）

  var DOC = root.document;
  if (!DOC || !DOC.body) return;

  var REPETITION_MIN_LEN = 8; // 复读聚类的最小 compact 长度（排除"哈哈哈"类短句）
  var REPETITION_COUNT = 3;   // 同文出现次数阈值

  // —— 运行时缓存（storage 的本地镜像，storage.onChanged 时刷新）——
  var settings = Object.assign({}, BZ.storage.DEFAULT_SETTINGS);
  var marks = {};
  var whitelist = {};
  var customRules = [];         // 用户自定义违规词（弹窗管理，改动即时生效）
  var remoteRules = BZ.storage.defaultRemoteRules(); // 远程词库（热更新）
  var extraRules = { text: [], name: [] };           // 远程+自定义合并后传给识别引擎
  var queueState = BZ.storage.defaultQueueState();
  var stats = { totalBlocked: 0, dailyDate: '', dailyBlocked: 0 };
  var pendingSet = new Set();   // 已入队、等待结果确认的账号
  var loginHandle = null;       // 当前登录用户（强制白名单）
  var badge = null;
  var scanTimer = null;
  var observer = null;
  var shutdownDone = false;
  var cacheEpoch = 0;           // 缓存代数：+1 表示所有推文需要重新评分
  var lastStoredCsrf = null;    // 避免重复写 session

  function threshold() {
    return BZ.storage.THRESHOLD_BY_SENSITIVITY[settings.sensitivity] || BZ.detector.DEFAULT_THRESHOLD;
  }

  function getCsrf() {
    var m = DOC.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function persistSession() {
    var csrf = getCsrf();
    if (csrf && csrf !== lastStoredCsrf) {
      lastStoredCsrf = csrf;
      BZ.storage.setSession({ csrf: csrf }); // 供 popup 撤销拉黑、SW 兜底请求复用
    }
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
    // 真实 X DOM 中第一个作者链接是头像链接（无文字），因此：
    //   handle —— 取第一个裸用户链接（含头像链接）的路径
    //   昵称   —— 优先在 User-Name 容器内找第一个「带文字」的裸用户链接
    var links = article.querySelectorAll('a[href^="/"]');
    var handle = null;
    for (var i = 0; i < links.length; i++) {
      var m = (links[i].getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (m) { handle = m[1]; break; }
    }
    if (!handle) return null;

    var nameEl = article.querySelector('[data-testid="User-Name"]');
    var nameLinks = nameEl ? nameEl.querySelectorAll('a[href^="/"]') : links;
    var displayName = '';
    for (var j = 0; j < nameLinks.length; j++) {
      var mm = (nameLinks[j].getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (mm) {
        var t = (nameLinks[j].textContent || '').trim();
        if (t) { displayName = t.slice(0, 60); break; }
      }
    }

    var textEl = article.querySelector('[data-testid="tweetText"]');
    return {
      handle: handle,
      displayName: displayName,
      text: textEl ? (textEl.innerText || '').slice(0, 2000) : ''
    };
  }

  function hashStr(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // —— 状态判定 ——
  function decide(info, repeated) {
    var key = info.handle.toLowerCase();
    info.key = key;

    var me = detectLoginUser();
    if (me && key === me.toLowerCase()) return { state: 'clean', info: info };
    if (whitelist[key]) return { state: 'clean', info: info };
    if (marks[key]) return { state: 'blocked', info: info };

    var result = BZ.detector.analyze(
      { text: info.text, displayName: info.displayName },
      threshold(),
      extraRules,
      { repeatedText: !!repeated }
    );
    if (!result.flagged) return { state: 'clean', info: info };
    return { state: 'flag', info: info, result: result };
  }

  function scan() {
    if (!BZ.storage.isAlive()) return shutdown(); // 扩展被重载：本实例已是僵尸，善终

    var articles = DOC.querySelectorAll('article[data-testid="tweet"]');

    // 阶段一：轻量抽取 + 同页复读聚类
    var infos = new Array(articles.length);
    var repCount = {};
    for (var r = 0; r < articles.length; r++) {
      var ri = extractInfo(articles[r]);
      infos[r] = ri;
      if (!ri) continue;
      var comp = BZ.normalize(ri.text).compact;
      ri.compact = comp;
      if (comp.length >= REPETITION_MIN_LEN) repCount[comp] = (repCount[comp] || 0) + 1;
    }

    // 阶段二：指纹短路 + 评分渲染
    var flaggedCount = 0;
    for (var i = 0; i < articles.length; i++) {
      var article = articles[i];
      var info = infos[i];
      if (!info) continue;

      if (!settings.enabled) {
        if (article.dataset.tz) BZ.ui.renderArticle(article, { state: 'clean' }, actions);
        delete article.dataset.tzFp;
        delete article.dataset.tzEpoch;
        continue;
      }

      var rep = repCount[info.compact] || 0;
      var fp = info.handle + '|' + hashStr(info.text) + '|' + rep + (pendingSet.has(info.handle.toLowerCase()) ? '|p' : '');
      if (article.dataset.tzFp === fp && article.dataset.tzEpoch === String(cacheEpoch)) {
        if (article.dataset.tz === 'flag') flaggedCount++;
        continue; // 内容与会话均未变化，沿用既有 UI
      }

      var verdict = decide(info, rep >= REPETITION_COUNT);
      if (verdict.state === 'clean') {
        if (article.dataset.tz) BZ.ui.renderArticle(article, { state: 'clean' }, actions);
      } else if (verdict.state === 'blocked') {
        BZ.ui.renderArticle(article, { state: 'blocked', handle: verdict.info.handle }, actions);
      } else {
        flaggedCount++;
        BZ.ui.renderArticle(article, {
          state: 'flag',
          handle: verdict.info.handle,
          score: verdict.result.score,
          hits: verdict.result.hits,
          pending: pendingSet.has(verdict.info.key)
        }, actions);
      }
      article.dataset.tzFp = fp;
      article.dataset.tzEpoch = String(cacheEpoch);
    }

    persistSession();

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

  /** 从页面同源上下文执行原生拉黑/撤销（cookie 附着最有保证），由 SW 队列调度 */
  function fireFromPage(action, screenName) {
    var csrf = getCsrf();
    if (!csrf) return Promise.resolve({ status: 'auth_error' });
    var auth = BZ.auth;
    var path = action === 'unblock' ? '/i/api/1.1/blocks/destroy.json' : auth.BLOCK_PATH;
    return fetch(path, {
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
      if (msg && msg.screenName && (msg.type === 'FIRE_BLOCK' || msg.type === 'FIRE_UNBLOCK')) {
        fireFromPage(msg.type === 'FIRE_UNBLOCK' ? 'unblock' : 'block', msg.screenName).then(sendResponse);
        return true; // 异步响应
      }
    });
  }

  var actions = {
    onBlock: function (handle) {
      var csrf = getCsrf();
      if (!csrf) return;
      pendingSet.add(handle.toLowerCase());
      scan(); // fp 含 pending 标记，会触发该条重渲染为「排队中」
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
        var info = extractInfo(articles[i]);
        if (info && !pendingSet.has(info.handle.toLowerCase())) {
          users.push({ screenName: info.handle });
          pendingSet.add(info.handle.toLowerCase());
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
        // storage.onChanged 也会触发全量重扫；这里本地同步一份 + 提升缓存代数，即时反馈
        whitelist[handle.toLowerCase()] = { ts: Date.now(), source: 'user' };
        pendingSet.delete(handle.toLowerCase());
        cacheEpoch++;
        scan();
      });
    }
  };

  // —— 缓存刷新 ——

  function rebuildExtraRules() {
    var text = [];
    var name = [];
    var rd = remoteRules.data;
    if (rd) {
      (rd.textRules || []).forEach(function (r) {
        text.push({ pattern: r.pattern, weight: r.weight, label: '远程词库' });
      });
      (rd.nameRules || []).forEach(function (r) {
        name.push({ pattern: r.pattern, weight: r.weight, label: '远程词库' });
      });
    }
    // 自定义词放在远程之后：同形时自定义覆盖远程（后来者优先）
    customRules.forEach(function (r) {
      text.push({ pattern: r.pattern, weight: r.weight, label: '自定义词' });
    });
    extraRules = { text: text, name: name };
  }

  function refreshCaches() {
    return Promise.all([
      BZ.storage.getSettings().then(function (s) { settings = s; }),
      BZ.storage.getMarks().then(function (m) { marks = m; }),
      BZ.storage.getWhitelist().then(function (w) { whitelist = w; }),
      BZ.storage.getCustomRules().then(function (c) { customRules = c; }),
      BZ.storage.getRemoteRules().then(function (rd) { remoteRules = rd; }),
      BZ.storage.getQueueState().then(function (q) { queueState = q; }),
      BZ.storage.getStats().then(function (s) { stats = s; }),
      BZ.storage.getSession().then(function (s) {
        if (!lastStoredCsrf && s.csrf) lastStoredCsrf = s.csrf;
      })
    ]).then(function () {
      rebuildExtraRules();
      cacheEpoch++; // 存储已变化：所有推文的指纹短路失效，下一轮 scan 全量重算
    });
  }

  function teardown() {
    var articles = DOC.querySelectorAll('article[data-testid="tweet"]');
    for (var i = 0; i < articles.length; i++) {
      BZ.ui.renderArticle(articles[i], { state: 'clean' }, actions);
      delete articles[i].dataset.tzFp;
      delete articles[i].dataset.tzEpoch;
    }
  }

  /**
   * 善终：扩展重载/更新后，旧内容脚本的 chrome.* 上下文已失效，
   * 安静地断开监听、撤掉 UI，把页面还给新版实例（或用户）。
   */
  function shutdown() {
    if (shutdownDone) return;
    shutdownDone = true;
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    if (observer) observer.disconnect();
    if (badge) badge.destroy();
  }

  // —— 启动 ——

  // 最后防线：扩展重载后，僵尸内容脚本实例中任何漏网的 chrome.* 调用都会产生
  // 「Extension context invalidated」promise 拒绝。该错误已知且无害，静默吞掉，
  // 不让它污染控制台。监听器注册在隔离世界，只影响本脚本，不会掩盖页面自身错误。
  function installInvalidationFilter() {
    if (!root.addEventListener) return;
    root.addEventListener('unhandledrejection', function (e) {
      var reason = e && e.reason;
      var msg = reason && (reason.message || String(reason));
      if (msg && /Extension context invalidated/i.test(msg)) e.preventDefault();
    });
  }

  function init() {
    installInvalidationFilter();
    BZ.ui.ensureStyles(DOC);
    badge = BZ.ui.createBadge(DOC, actions);
    refreshCaches().then(scan).catch(function () {});

    observer = new MutationObserver(scheduleScan);
    observer.observe(DOC.body, { childList: true, subtree: true });

    BZ.storage.onChange(function (changes) {
      var relevant = ['settings', 'marks', 'whitelist', 'customRules', 'remoteRules', 'queueState', 'stats', 'queue'];
      var touched = relevant.some(function (k) { return changes[k]; });
      if (!touched) return;
      // 拉黑结果确认：marks 出现即移出 pending
      if (changes.marks) {
        Object.keys(changes.marks.newValue || {}).forEach(function (sn) { pendingSet.delete(sn); });
      }
      refreshCaches().then(scan).catch(function () {});
    });
  }

  init();

  // 供 fixture 测试页手动重扫
  root.BotZapper.content = { scan: scan, actions: actions, extractInfo: extractInfo };
})(typeof self !== 'undefined' ? self : globalThis);

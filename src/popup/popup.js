/**
 * 推妖镜 BotZapper · 弹窗面板
 */
(function () {
  'use strict';

  var BZ = window.BotZapper;
  var $ = function (id) { return document.getElementById(id); };

  var HINTS = {
    loose: '宽松：只标注多特征叠加的高置信账号，最少打扰。',
    standard: '标准：推荐档。单词强信号或两个中信号组合才标注。',
    strict: '严格：单个中信号即标注，可能误伤，请配合「误判」按钮使用。'
  };

  var WEIGHT_NAMES = { 4: '强', 2: '中', 1: '弱' };
  var WHERE_NAMES = { text: '正文', name: '昵称', meta: '元特征' };

  function send(msg) {
    return new Promise(function (resolve) {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        return resolve({ ok: false }); // 无扩展环境（如直接打开页面预览）
      }
      chrome.runtime.sendMessage(msg, function (res) {
        void chrome.runtime.lastError;
        resolve(res || { ok: false });
      });
    });
  }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function renderWhitelist(wl) {
    var list = $('wlList');
    list.innerHTML = '';
    var names = Object.keys(wl);
    $('wlCount').textContent = names.length + ' 个账号';
    $('wlEmpty').style.display = names.length ? 'none' : '';
    names.sort(function (a, b) { return (wl[b].ts || 0) - (wl[a].ts || 0); });
    names.forEach(function (name) {
      var li = document.createElement('li');
      var span = document.createElement('span');
      span.textContent = '@' + name;
      var del = document.createElement('button');
      del.className = 'del';
      del.textContent = '移除';
      del.addEventListener('click', function () {
        BZ.storage.removeWhitelist(name).then(load);
      });
      li.appendChild(span);
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  function renderCustomRules(rules) {
    var list = $('crList');
    list.innerHTML = '';
    $('crCount').textContent = rules.length + ' 个';
    rules.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); }).forEach(function (r) {
      var li = document.createElement('li');
      var left = document.createElement('span');
      left.textContent = r.pattern;
      var tag = document.createElement('span');
      tag.className = 'wtag';
      tag.textContent = WEIGHT_NAMES[r.weight] || '中';
      left.appendChild(tag);
      var del = document.createElement('button');
      del.className = 'del';
      del.textContent = '移除';
      del.addEventListener('click', function () {
        BZ.storage.getCustomRules().then(function (all) {
          return BZ.storage.saveCustomRules(all.filter(function (x) { return x.pattern !== r.pattern; }));
        }).then(load);
      });
      li.appendChild(left);
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  function renderRecentBlocks(marks) {
    var list = $('mbList');
    list.innerHTML = '';
    var entries = Object.keys(marks)
      .filter(function (k) { return marks[k].status === 'blocked'; })
      .map(function (k) { return { handle: k, ts: marks[k].ts || 0 }; })
      .sort(function (a, b) { return b.ts - a.ts; })
      .slice(0, 20);
    $('mbCount').textContent = entries.length + ' 个';
    $('mbEmpty').style.display = entries.length ? 'none' : '';
    entries.forEach(function (e) {
      var li = document.createElement('li');
      var left = document.createElement('span');
      left.textContent = '@' + e.handle;
      var tag = document.createElement('span');
      tag.className = 'wtag';
      tag.textContent = fmtTime(e.ts);
      left.appendChild(tag);
      var undo = document.createElement('button');
      undo.className = 'del';
      undo.textContent = '撤销';
      undo.addEventListener('click', function () {
        undo.disabled = true;
        undo.textContent = '撤销中…';
        BZ.storage.getSession().then(function (session) {
          if (!session.csrf) {
            undo.disabled = false;
            undo.textContent = '撤销';
            $('mbEmpty').textContent = '尚未检测到 X 登录会话，请先打开一次 x.com。';
            $('mbEmpty').style.display = '';
            return;
          }
          send({
            type: 'ENQUEUE_UNBLOCKS',
            users: [{ screenName: e.handle }],
            csrf: session.csrf
          });
          // 成功后 marks 移除该账号，storage.onChanged 会刷新列表
        });
      });
      li.appendChild(left);
      li.appendChild(undo);
      list.appendChild(li);
    });
  }

  function renderRulesCard(settings, remote) {
    var status = '内置 v' + BZ.rules.version;
    if (settings.remoteRulesUrl && remote.data) {
      status += ' · 远程 v' + remote.data.version + '（' + fmtTime(remote.fetchedAt) + ' 同步）';
    } else if (settings.remoteRulesUrl) {
      status += ' · 远程待同步';
    }
    $('rulesStatus').textContent = status;
    if (document.activeElement !== $('remoteUrl')) $('remoteUrl').value = settings.remoteRulesUrl || '';
  }

  // —— 规则试算器（纯本地，与内容脚本同一套识别引擎）——

  var tryState = { settings: null, extraRules: { text: [], name: [] } };

  /** 与内容脚本 rebuildExtraRules 同序：远程在前、自定义在后，同形时自定义覆盖 */
  function buildExtraRules(cr, remote) {
    var text = [];
    var name = [];
    var rd = remote && remote.data;
    if (rd) {
      (rd.textRules || []).forEach(function (r) {
        text.push({ pattern: r.pattern, weight: r.weight, label: '远程词库' });
      });
      (rd.nameRules || []).forEach(function (r) {
        name.push({ pattern: r.pattern, weight: r.weight, label: '远程词库' });
      });
    }
    (cr || []).forEach(function (r) {
      text.push({ pattern: r.pattern, weight: r.weight, label: '自定义词' });
    });
    return { text: text, name: name };
  }

  function runTry() {
    var text = $('tryText').value;
    var name = $('tryName').value;
    var box = $('tryResult');
    if (!text.trim() && !name.trim()) {
      box.classList.add('hidden');
      return;
    }
    var s = tryState.settings || BZ.storage.DEFAULT_SETTINGS;
    var thr = BZ.storage.THRESHOLD_BY_SENSITIVITY[s.sensitivity] || BZ.detector.DEFAULT_THRESHOLD;
    var r = BZ.detector.analyze(
      { text: text, displayName: name },
      thr,
      tryState.extraRules,
      { repeatedText: $('tryRepeat').checked }
    );

    $('tryScore').textContent = r.score;
    $('tryThreshold').textContent = r.threshold;
    var verdict = $('tryVerdict');
    verdict.textContent = r.flagged ? '疑似妖物 · 会标黄' : '未达阈值 · 不标黄';
    verdict.className = r.flagged ? 'flagged' : 'clean';
    box.classList.remove('hidden');
    box.classList.toggle('flagged', r.flagged);

    var list = $('tryHits');
    list.innerHTML = '';
    if (!r.hits.length) {
      var li = document.createElement('li');
      var empty = document.createElement('span');
      empty.className = 'where';
      empty.textContent = '无命中';
      li.appendChild(empty);
      list.appendChild(li);
      return;
    }
    r.hits.forEach(function (h) {
      var item = document.createElement('li');
      var left = document.createElement('span');
      left.textContent = h.label;
      var where = document.createElement('span');
      where.className = 'where';
      where.textContent = WHERE_NAMES[h.where] || h.where;
      left.appendChild(where);
      var tag = document.createElement('span');
      tag.className = 'wtag';
      tag.textContent = (WEIGHT_NAMES[h.weight] || h.weight) + ' ×' + h.weight;
      item.appendChild(left);
      item.appendChild(tag);
      list.appendChild(item);
    });
  }

  function renderState(settings, stats, queueState, wl, cr, marks, remote) {
    $('enabled').checked = settings.enabled;
    $('sensitivityHint').textContent = HINTS[settings.sensitivity] || '';
    document.querySelectorAll('#sensitivity button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.value === settings.sensitivity);
    });

    if (document.activeElement !== $('dailyLimit')) $('dailyLimit').value = settings.dailyLimit;
    var daily = stats.dailyBlocked + ' / ' + settings.dailyLimit;
    $('dailyText').textContent = daily;
    var pct = Math.min(100, Math.round(stats.dailyBlocked / settings.dailyLimit * 100));
    $('dailyBar').style.width = pct + '%';
    $('totalText').textContent = stats.totalBlocked;

    send({ type: 'GET_STATE' }).then(function (res) {
      $('queueText').textContent = res.ok && res.state.queueLength > 0
        ? '队列待处理 ' + res.state.queueLength : '';
    });

    var paused = queueState.paused;
    var note = $('pauseNote');
    if (paused && queueState.reason === 'rate_limit') {
      note.textContent = '已触发平台限流，队列熔断暂停中，稍后自动恢复。';
      note.classList.remove('hidden');
      $('resumeBtn').classList.remove('hidden');
    } else if (paused && queueState.reason === 'auth_error') {
      note.textContent = queueState.lastError || '登录状态失效，刷新 X 页面后点恢复。';
      note.classList.remove('hidden');
      $('resumeBtn').classList.remove('hidden');
    } else if (!paused && queueState.reason === 'daily_limit') {
      note.textContent = '今日拉黑已达上限，为保护你的账号明日自动恢复。';
      note.classList.remove('hidden');
      $('resumeBtn').classList.add('hidden');
    } else {
      note.classList.add('hidden');
      $('resumeBtn').classList.add('hidden');
    }

    renderRulesCard(settings, remote);
    renderWhitelist(wl);
    renderCustomRules(cr);
    renderRecentBlocks(marks);

    // 试算器跟随最新词库与灵敏度（改动即时反映在已输入的文本上）
    tryState.settings = settings;
    tryState.extraRules = buildExtraRules(cr, remote);
    runTry();
  }

  function load() {
    Promise.all([
      BZ.storage.getSettings(),
      BZ.storage.getStats(),
      BZ.storage.getQueueState(),
      BZ.storage.getWhitelist(),
      BZ.storage.getCustomRules(),
      BZ.storage.getMarks(),
      BZ.storage.getRemoteRules()
    ]).then(function (r) { renderState(r[0], r[1], r[2], r[3], r[4], r[5], r[6]); });
  }

  $('enabled').addEventListener('change', function () {
    BZ.storage.saveSettings({ enabled: this.checked });
  });

  document.querySelectorAll('#sensitivity button').forEach(function (b) {
    b.addEventListener('click', function () {
      BZ.storage.saveSettings({ sensitivity: b.dataset.value }).then(load);
    });
  });

  $('dailyLimit').addEventListener('change', function () {
    var v = Math.max(1, Math.min(500, Number(this.value) || 50));
    BZ.storage.saveSettings({ dailyLimit: v }).then(load);
  });

  $('crAdd').addEventListener('click', addCustomRule);
  $('crInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') addCustomRule();
  });

  $('tryText').addEventListener('input', runTry);
  $('tryName').addEventListener('input', runTry);
  $('tryRepeat').addEventListener('change', runTry);

  function addCustomRule() {
    var input = $('crInput');
    var pattern = input.value.trim();
    if (!pattern) return;
    var weight = Number($('crWeight').value) || 2;
    BZ.storage.getCustomRules().then(function (all) {
      all.push({ pattern: pattern, weight: weight, ts: Date.now() });
      return BZ.storage.saveCustomRules(all);
    }).then(function () {
      input.value = '';
      load();
    });
  }

  $('saveRemoteUrl').addEventListener('click', function () {
    var url = $('remoteUrl').value.trim();
    BZ.storage.saveSettings({ remoteRulesUrl: url }).then(function () {
      if (url) send({ type: 'UPDATE_RULES' }).then(load);
      else load();
    });
  });

  $('updateRules').addEventListener('click', function () {
    var note = $('rulesUpdateNote');
    note.textContent = '同步中…';
    send({ type: 'UPDATE_RULES' }).then(function (res) {
      if (res.ok) note.textContent = res.cached ? '词库已是最新' : '已更新到 v' + res.version;
      else if (res.reason === 'disabled') note.textContent = '未配置地址';
      else note.textContent = '失败：' + res.reason;
      load();
    });
  });

  $('resumeBtn').addEventListener('click', function () {
    send({ type: 'RESUME_QUEUE' }).then(load);
  });

  $('rulesVersion').textContent = BZ.rules.version;

  BZ.storage.onChange(function (changes) {
    if (changes.settings || changes.stats || changes.queueState || changes.whitelist ||
        changes.customRules || changes.marks || changes.remoteRules) load();
  });

  load();
})();

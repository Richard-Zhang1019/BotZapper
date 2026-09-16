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

  var WEIGHT_NAMES = { 4: '强', 2: '中', 1: '弱' };

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

  function renderState(settings, stats, queueState, wl, cr) {
    $('enabled').checked = settings.enabled;
    $('sensitivityHint').textContent = HINTS[settings.sensitivity] || '';
    document.querySelectorAll('#sensitivity button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.value === settings.sensitivity);
    });

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

    renderWhitelist(wl);
    renderCustomRules(cr);
  }

  function load() {
    Promise.all([
      BZ.storage.getSettings(),
      BZ.storage.getStats(),
      BZ.storage.getQueueState(),
      BZ.storage.getWhitelist(),
      BZ.storage.getCustomRules()
    ]).then(function (r) { renderState(r[0], r[1], r[2], r[3], r[4]); });
  }

  $('crAdd').addEventListener('click', addCustomRule);
  $('crInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') addCustomRule();
  });

  $('enabled').addEventListener('change', function () {
    BZ.storage.saveSettings({ enabled: this.checked });
  });

  document.querySelectorAll('#sensitivity button').forEach(function (b) {
    b.addEventListener('click', function () {
      BZ.storage.saveSettings({ sensitivity: b.dataset.value }).then(load);
    });
  });

  $('resumeBtn').addEventListener('click', function () {
    send({ type: 'RESUME_QUEUE' }).then(load);
  });

  $('rulesVersion').textContent = BZ.rules.version;

  BZ.storage.onChange(function (changes) {
    if (changes.settings || changes.stats || changes.queueState || changes.whitelist || changes.customRules) load();
  });

  load();
})();

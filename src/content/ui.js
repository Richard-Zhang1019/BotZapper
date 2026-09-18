/**
 * 推妖镜 BotZapper · 内容脚本 UI
 *
 * 负责把文章节点的 UI 渲染到目标状态（无标注/疑似妖物/已拉黑），
 * 以及页面级浮动徽章。只做 DOM，不做决策——状态判定在 main.js。
 */
(function (root) {
  'use strict';

  var STYLES = [
    // 高亮以 data-tz 属性驱动而非 class：X 的 React 会在 hover 等重渲染时重写
    // article 的 className（会抹掉 classList 加的高亮），而 dataset 属性不受其管理
    'article[data-testid="tweet"][data-tz="flag"],article[data-testid="tweet"][data-tz="blocked"]{',
    'outline:2px solid #f59e0b !important;outline-offset:-2px;border-radius:16px;',
    'background:rgba(245,158,11,.05) !important;}',
    'article[data-testid="tweet"][data-tz="blocked"]{opacity:.5;}',
    '.tz-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:100%;box-sizing:border-box;',
    'padding:6px 4px;font-size:13px;line-height:1.4;color:#f59e0b;}',
    '.tz-toolbar .tz-meta{opacity:.85;}',
    '.tz-toolbar .tz-btn-block{margin-left:auto;}',
    '.tz-btn{border:1px solid transparent;border-radius:9999px;padding:3px 12px;font-size:12px;font-weight:700;',
    'cursor:pointer;font-family:inherit;will-change:transform;',
    'transition:background-color .18s ease,color .18s ease,border-color .18s ease,box-shadow .18s ease,transform .12s ease;}',
    '.tz-btn:active:not(:disabled){transform:scale(.95);}',
    '.tz-btn:focus-visible{outline:2px solid #1d9bf0;outline-offset:2px;}',
    '.tz-btn-block{background:#f4212e;border-color:#f4212e;color:#fff;box-shadow:0 1px 3px rgba(244,33,46,.25);}',
    '.tz-btn-block:hover{background:#d61f2b;border-color:#d61f2b;box-shadow:0 3px 12px rgba(244,33,46,.45);}',
    '.tz-btn-block:disabled{background:#5a2a2e;border-color:#5a2a2e;color:#ffffff99;box-shadow:none;cursor:default;}',
    '.tz-btn-pardon{background:transparent;color:#71767b;border-color:#536471;}',
    '.tz-btn-pardon:hover{background:rgba(245,158,11,.12);color:#f59e0b;border-color:#f59e0b;}',
    '.tz-done{color:#00ba7c;font-weight:700;}',
    '#tz-badge{position:fixed;left:16px;bottom:16px;z-index:2147483646;display:flex;flex-direction:column;gap:6px;',
    'background:rgba(22,24,28,.96);border:1px solid #f59e0b55;border-radius:14px;padding:10px 12px;',
    'font-size:13px;color:#e7e9ea;box-shadow:0 6px 24px rgba(0,0,0,.5);font-family:system-ui,-apple-system,sans-serif;}',
    '#tz-badge .tz-row{display:flex;align-items:center;gap:8px;}',
    '#tz-badge .tz-title{font-weight:800;color:#f59e0b;}',
    '#tz-badge .tz-count{font-weight:700;}',
    '#tz-badge .tz-note{color:#71767b;font-size:12px;max-width:220px;}',
    '#tz-badge button{border:none;border-radius:9999px;padding:5px 14px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;',
    'transition:background-color .18s ease,box-shadow .18s ease,transform .12s ease;}',
    '#tz-badge button:active:not(:disabled){transform:scale(.95);}',
    '#tz-badge .tz-clear{background:#f4212e;color:#fff;}',
    '#tz-badge .tz-clear:hover:not(:disabled){background:#d61f2b;box-shadow:0 3px 12px rgba(244,33,46,.45);}',
    '#tz-badge .tz-clear:disabled{background:#5a2a2e;color:#ffffff99;cursor:default;}',
    '#tz-badge .tz-fold{background:transparent;color:#71767b;border:1px solid #536471;padding:3px 10px;}',
    '#tz-badge.tz-folded{padding:6px 10px;}'
  ].join('');

  function ensureStyles(doc) {
    if (doc.getElementById('tz-styles')) return;
    var style = doc.createElement('style');
    style.id = 'tz-styles';
    style.textContent = STYLES;
    doc.head.appendChild(style);
  }

  function removeToolbar(article) {
    var old = article.querySelector('.tz-toolbar');
    if (old) old.remove();
  }

  /**
   * 工具栏的宿主节点。X 的 article 结构是 article > 行容器 > [头像列, 内容主列]，
   * 若直接 append 到 article（横向 flex），工具栏会被挤成右侧窄列、竖排换行。
   * 放进内容主列（含昵称/正文的纵向 flex）才能横跨推文全宽、出现在操作栏下方。
   */
  function getToolbarHost(article) {
    var anchors = article.querySelectorAll('[data-testid="tweetText"],[data-testid="User-Name"]');
    for (var i = 0; i < anchors.length; i++) {
      var node = anchors[i];
      while (node.parentElement && node.parentElement !== article) {
        if (node.parentElement.parentElement === article) return node; // article 的孙子层 = 内容主列
        node = node.parentElement;
      }
    }
    return article; // 结构不识别时兜底
  }

  function dedupeLabels(hits) {
    var seen = {};
    var out = [];
    (hits || []).forEach(function (h) {
      if (!seen[h.label]) { seen[h.label] = true; out.push(h.label); }
    });
    return out.join('、');
  }

  /**
   * 挂载工具栏并把内容缩进到与正文左缘对齐。宿主列在 X 的不同版式下嵌套深度
   * 不一（可能停在头像列外层），与其硬编码缩进，不如挂载后量出正文与工具栏
   * 的横向差值，用 padding-left 补齐。
   */
  function mountBar(article, bar) {
    getToolbarHost(article).appendChild(bar);
    var anchor = article.querySelector('[data-testid="tweetText"],[data-testid="User-Name"]');
    if (!anchor) return;
    var a = anchor.getBoundingClientRect();
    var b = bar.getBoundingClientRect();
    if (!a.width || !b.width) return;
    var indent = Math.round(a.left - b.left);
    if (indent > 0) bar.style.paddingLeft = indent + 'px';
  }

  /**
   * 把单个推文节点渲染到目标状态。
   * @param {HTMLElement} article
   * @param {{state:'clean'|'flag'|'blocked', handle?:string, score?:number, hits?:Array, pending?:boolean}} model
   * @param {{onBlock:Function, onPardon:Function}} actions
   */
  function renderArticle(article, model, actions) {
    var doc = article.ownerDocument;
    ensureStyles(doc);
    removeToolbar(article);

    if (model.state === 'clean') {
      article.classList.remove('tz-flag', 'tz-dim');
      if (article.dataset.tz) delete article.dataset.tz;
      return;
    }

    article.classList.add('tz-flag');
    if (model.state === 'blocked') article.classList.add('tz-dim');
    else article.classList.remove('tz-dim');
    article.dataset.tz = model.state;

    var bar = doc.createElement('div');
    bar.className = 'tz-toolbar';

    if (model.state === 'blocked') {
      var done = doc.createElement('span');
      done.className = 'tz-done';
      done.textContent = '镜收 ✓ 已拉黑 @' + model.handle;
      bar.appendChild(done);
      mountBar(article, bar);
      return;
    }

    var meta = doc.createElement('span');
    meta.className = 'tz-meta';
    var labels = dedupeLabels(model.hits);
    meta.textContent = '妖气值 ' + model.score + (labels ? ' · ' + labels : '');
    bar.appendChild(meta);

    var blockBtn = doc.createElement('button');
    blockBtn.className = 'tz-btn tz-btn-block';
    blockBtn.textContent = model.pending ? '排队中…' : '拉黑';
    blockBtn.disabled = !!model.pending;
    blockBtn.addEventListener('click', function () { actions.onBlock(model.handle, article); });
    bar.appendChild(blockBtn);

    var pardonBtn = doc.createElement('button');
    pardonBtn.className = 'tz-btn tz-btn-pardon';
    pardonBtn.textContent = '误判';
    pardonBtn.title = '恢复显示并将 @' + model.handle + ' 加入永久白名单';
    pardonBtn.addEventListener('click', function () { actions.onPardon(model.handle, article); });
    bar.appendChild(pardonBtn);

    mountBar(article, bar);
  }

  /**
   * 浮动徽章控制器
   */
  function createBadge(doc, actions) {
    ensureStyles(doc);
    var el = doc.getElementById('tz-badge');
    if (el) el.remove();

    el = doc.createElement('div');
    el.id = 'tz-badge';
    el.innerHTML =
      '<div class="tz-row">' +
      '  <span class="tz-title">🪞 推妖镜</span>' +
      '  <span class="tz-count"></span>' +
      '  <button class="tz-clear">一键清理</button>' +
      '  <button class="tz-fold" title="收起">—</button>' +
      '</div>' +
      '<div class="tz-row"><span class="tz-note"></span></div>';

    doc.body.appendChild(el);

    var countEl = el.querySelector('.tz-count');
    var clearBtn = el.querySelector('.tz-clear');
    var noteEl = el.querySelector('.tz-note');
    var foldBtn = el.querySelector('.tz-fold');

    foldBtn.addEventListener('click', function () {
      el.classList.toggle('tz-folded');
      var folded = el.classList.contains('tz-folded');
      countEl.style.display = folded ? 'none' : '';
      clearBtn.style.display = folded ? 'none' : '';
      noteEl.parentElement.style.display = folded ? 'none' : '';
      foldBtn.textContent = folded ? '镜' : '—';
    });

    clearBtn.addEventListener('click', function () { actions.onBlockAll(); });

    var model = {};
    function refresh() {
      var count = model.count || 0;
      countEl.textContent = '本页妖怪 ' + count + ' 个';
      clearBtn.disabled = count === 0 || !model.loggedIn || model.queuePaused;
      clearBtn.textContent = model.pendingAny ? '清理中…' : '一键清理';

      var notes = [];
      if (!model.enabled) notes.push('已停用');
      if (!model.loggedIn) notes.push('检测到未登录，无法拉黑');
      if (model.queuePaused && model.pauseReason === 'rate_limit') notes.push('触发平台限流，队列已熔断暂停');
      if (model.queuePaused && model.pauseReason === 'auth_error') notes.push(model.pauseNote || '登录状态失效');
      if (model.dailyReached) notes.push('今日拉黑已达上限，明日自动恢复');
      if (model.pendingAny) notes.push('后台串行发送中，可关闭页面');
      noteEl.textContent = notes.join(' · ');
      el.style.display = model.visible === false ? 'none' : '';
    }

    return {
      update: function (patch) {
        Object.assign(model, patch || {});
        refresh();
      },
      destroy: function () { el.remove(); }
    };
  }

  var api = {
    ensureStyles: ensureStyles,
    renderArticle: renderArticle,
    createBadge: createBadge
  };

  root.BotZapper = root.BotZapper || {};
  root.BotZapper.ui = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);

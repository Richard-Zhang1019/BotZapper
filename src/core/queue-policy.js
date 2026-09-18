/**
 * 推妖镜 BotZapper · 拉黑队列决策（纯函数）
 *
 * 从 service-worker 的 processQueue 中抽出的「下一步做什么」「结果如何收尾」
 * 两类决策。不触碰 chrome.*、不改入参、时钟由调用方注入，
 * 让熔断/日限额/持久化恢复这些最危险路径可以在 Node 单测中覆盖。
 */
(function (root) {
  'use strict';

  var MAX_ATTEMPTS = 3; // 网络类临时失败的最多尝试次数
  var RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000; // 默认熔断冷却（与 storage 常量保持一致）
  // 持久化恢复：SW 中途被杀后遗落的 processing 任务，超过该时长视为已死，可重新执行
  var STALE_PROCESSING_MS = 5 * 60 * 1000;
  // 队列总长上限（含撤销任务）：防一键清理把热帖整页数百账号全部入队，
  // 挤占 storage 并让「清理中」状态持续数日（日限额 50 下 100 条已是两天存量）
  var MAX_QUEUE_LEN = 100;

  function defaultDailyLimit(settings) {
    return settings && typeof settings.dailyLimit === 'number' ? settings.dailyLimit : 50;
  }

  /** processing 且超过 STALE_PROCESSING_MS：上次运行被 SW 回收的遗骸，可恢复执行 */
  function isStale(job, now) {
    return !!job.processing && now - (job.startedAt || 0) > STALE_PROCESSING_MS;
  }

  /**
   * 队列下一步动作。
   * @param {{queue:Array, settings?:object, state?:object, stats?:object, now?:number}} input
   * @returns {{verdict:'idle'} | {verdict:'wait_cooldown', resumeAt:number}
   *   | {verdict:'wait_auth'} | {verdict:'daily_limit'} | {verdict:'resume'}
   *   | {verdict:'run_job', job:object, recovered:boolean}}
   */
  function evaluateNext(input) {
    var queue = input.queue || [];
    var settings = input.settings || {};
    var state = input.state || {};
    var stats = input.stats || {};
    var now = input.now || 0;

    var job = null;
    for (var i = 0; i < queue.length; i++) {
      var j = queue[i];
      // 持久化恢复：超时的 processing 任务视同可执行（拉黑接口幂等，重复执行无害），保持队序不插队
      if (!j.processing || isStale(j, now)) { job = j; break; }
    }
    if (!job) return { verdict: 'idle' };

    if (state.paused && state.reason === 'rate_limit') {
      var until = state.pausedUntil || 0;
      if (now < until) return { verdict: 'wait_cooldown', resumeAt: until };
      return { verdict: 'resume' }; // 冷却结束：清掉暂停标记后回到 run_job 判定
    }
    if (state.paused && state.reason === 'auth_error') return { verdict: 'wait_auth' }; // 等用户在弹窗恢复

    // 每日限额只对拉黑任务生效（撤销不占额度）；到量即停，次日 stats 归零自然恢复。
    // 遗留的 stale 拉黑任务也计入，恢复执行同样受限额门控
    var hasBlockingJobs = queue.some(function (x) {
      return x.action !== 'unblock' && (!x.processing || isStale(x, now));
    });
    if (hasBlockingJobs && (stats.dailyBlocked || 0) >= defaultDailyLimit(settings)) {
      return { verdict: 'daily_limit' };
    }

    return { verdict: 'run_job', job: job, recovered: job.processing === true };
  }

  /**
   * 任务执行结果 → 收尾决策。
   * @param {object} job 队列任务（attempts 可能被读取）
   * @param {{status:string}} outcome blockUser 的返回
   * @param {{maxAttempts?:number, cooldownMs?:number}} [opts]
   * @returns {{kind:'complete', effects:{removeMark?:boolean, markStatus?:string, bumpStats?:boolean}}
   *   | {kind:'drop', markStatus:'failed'}
   *   | {kind:'requeue', attempts?:number, pause?:{reason:string, lastError:string, cooldownMs?:number}}}
   */
  function planOutcome(job, outcome, opts) {
    opts = opts || {};
    var maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;
    var cooldownMs = opts.cooldownMs == null ? RATE_LIMIT_COOLDOWN_MS : opts.cooldownMs;
    var isUnblock = job.action === 'unblock';
    var status = outcome && outcome.status;

    if (status === 'blocked') {
      // blocked=接口调用成功（对 unblock 即撤销成功）；撤销不占每日额度
      return { kind: 'complete', effects: isUnblock ? { removeMark: true } : { markStatus: 'blocked', bumpStats: true } };
    }
    if (status === 'not_found') {
      // 账号已注销/被封：拉黑无需再发请求；撤销视为目标已不在黑名单，清掉本地标记
      return { kind: 'complete', effects: isUnblock ? { removeMark: true } : { markStatus: 'not_found' } };
    }
    if (status === 'rate_limited') {
      // 熔断：任务放回队首，绝不盲目重试，冷却后由下一轮循环恢复
      return { kind: 'requeue', pause: { reason: 'rate_limit', lastError: 'rate_limit', cooldownMs: cooldownMs } };
    }
    if (status === 'auth_error') {
      // 登录失效：需用户刷新 X 页面后在弹窗手动恢复
      return { kind: 'requeue', pause: { reason: 'auth_error', lastError: '登录状态失效，请刷新 X 页面后在弹窗恢复队列' } };
    }

    // network_error 等临时失败：计重试次数，超过上限放弃并标记 failed
    var attempts = (job.attempts || 0) + 1;
    if (attempts >= maxAttempts) return { kind: 'drop', markStatus: 'failed' };
    return { kind: 'requeue', attempts: attempts };
  }

  /**
   * 入队筛选：同账号同动作去重（大小写不敏感），队列总长达上限后不再接收。
   * 拉黑与撤销是相反操作，同账号允许两个动作共存（后入队者后执行，符合操作顺序）。
   * @param {Array} queue 现有队列（只读，不改写）
   * @param {Array<string>} incoming 请求入队的 screenName 列表，按传入顺序
   * @param {string} action 'block' | 'unblock'
   * @param {number} [maxLen] 队列总长上限，默认 MAX_QUEUE_LEN
   * @returns {Array<string>} 实际可入队的 screenName（小写，保持传入顺序）
   */
  function selectEnqueue(queue, incoming, action, maxLen) {
    maxLen = maxLen || MAX_QUEUE_LEN;
    var existing = {};
    (queue || []).forEach(function (j) {
      existing[String(j.screenName || '').toLowerCase() + ':' + j.action] = true;
    });
    var accepted = [];
    (incoming || []).forEach(function (sn) {
      var name = String(sn || '').trim().toLowerCase();
      if (!name) return;
      if (existing[name + ':' + action]) return;
      if ((queue || []).length + accepted.length >= maxLen) return;
      existing[name + ':' + action] = true;
      accepted.push(name);
    });
    return accepted;
  }

  var api = {
    MAX_ATTEMPTS: MAX_ATTEMPTS,
    RATE_LIMIT_COOLDOWN_MS: RATE_LIMIT_COOLDOWN_MS,
    STALE_PROCESSING_MS: STALE_PROCESSING_MS,
    MAX_QUEUE_LEN: MAX_QUEUE_LEN,
    evaluateNext: evaluateNext,
    planOutcome: planOutcome,
    selectEnqueue: selectEnqueue
  };

  root.BotZapper = root.BotZapper || {};
  root.BotZapper.queuePolicy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);

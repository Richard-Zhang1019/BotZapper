/**
 * 推妖镜 BotZapper · Service Worker
 *
 * 唯一有权发起「原生拉黑」请求的地方。全浏览器共享同一条串行队列：
 *   - 串行执行，绝不并发
 *   - 相邻请求随机延迟（默认 800–2000ms，模拟人类节奏）
 *   - HTTP 429 立即熔断：暂停队列、绝不盲目重试，10 分钟后自动恢复
 *   - 每日拉黑请求上限（默认 50），到量即停，保护用户主账号
 *   - 队列持久化到 storage.local，service worker 休眠/重启不丢任务
 *
 * 拉黑请求复用用户在 x.com 的登录会话（cookie + ct0），
 * 语义上等价于用户本人在网页上点「拉黑」，插件只是代为点按钮。
 */
'use strict';

importScripts('../core/normalize.js', '../core/rules.js', '../core/auth.js', '../core/storage.js', '../core/queue-policy.js');

var BLOCK_API = 'https://x.com' + self.BotZapper.auth.BLOCK_PATH;
var UNBLOCK_API = 'https://x.com/i/api/1.1/blocks/destroy.json';
var RULES_TTL_MS = 24 * 60 * 60 * 1000; // 远程规则拉取周期

var processing = false;

/**
 * 规则热更新：拉取远程词库 JSON（GitHub Raw / jsDelivr 均带开放 CORS），
 * 经 validateRemote 结构校验后落盘。失败保留上一次的可用副本。
 */
async function maybeUpdateRules(force) {
  var BZS = self.BotZapper.storage;
  var settings = await BZS.getSettings();
  var url = (settings.remoteRulesUrl || '').trim();
  if (!url) return { ok: false, reason: 'disabled' };

  var current = await BZS.getRemoteRules();
  if (!force && current.fetchedAt && Date.now() - current.fetchedAt < RULES_TTL_MS) {
    return { ok: true, cached: true, version: current.data && current.data.version };
  }

  try {
    var res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return { ok: false, reason: 'http_' + res.status };
    var data = await res.json();
    var validated = self.BotZapper.rules.validateRemote(data);
    if (!validated.ok) return { ok: false, reason: validated.reason };
    await BZS.saveRemoteRules({
      fetchedAt: Date.now(),
      data: { version: validated.version, textRules: validated.textRules, nameRules: validated.nameRules }
    });
    return { ok: true, version: validated.version };
  } catch (e) {
    return { ok: false, reason: 'network' };
  }
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function processQueue() {
  if (processing) return;
  processing = true;
  var QP = self.BotZapper.queuePolicy;
  try {
    while (true) {
      var BZS = self.BotZapper.storage;
      var queue = await BZS.getQueue();
      var settings = await BZS.getSettings();
      var state = await BZS.getQueueState();
      var stats = await BZS.getStats();

      var decision = QP.evaluateNext({ queue: queue, settings: settings, state: state, stats: stats, now: Date.now() });

      if (decision.verdict === 'idle' || decision.verdict === 'wait_cooldown' || decision.verdict === 'wait_auth') break;

      if (decision.verdict === 'resume') {
        // 熔断冷却结束：清掉暂停标记，回循环顶部按正常逻辑继续
        await BZS.setQueueState({ paused: false, reason: null, pausedUntil: 0 });
        continue;
      }
      if (decision.verdict === 'daily_limit') {
        await BZS.setQueueState({ reason: 'daily_limit' });
        break;
      }

      // run_job：标记 processing 并持久化，SW 中途被杀也不至于重复请求；
      // 遗留的 processing（持久化恢复）在这里一并覆盖并重新计时
      var job = decision.job;
      job.processing = true;
      job.startedAt = Date.now();
      await BZS.setQueue(queue);

      await sleep(rand(settings.minDelayMs, settings.maxDelayMs));

      var outcome = await blockUser(job);
      var plan = QP.planOutcome(job, outcome, { cooldownMs: BZS.RATE_LIMIT_COOLDOWN_MS });

      // complete/drop：任务离队；requeue：原任务留在队列里改状态后整体写回
      if (plan.kind !== 'requeue') {
        var rest = [];
        for (var k = 0; k < queue.length; k++) {
          if (queue[k].id !== job.id) rest.push(queue[k]);
        }
        await BZS.setQueue(rest);
      }

      if (plan.kind === 'complete') {
        if (plan.effects.removeMark) await BZS.removeMark(job.screenName);
        if (plan.effects.markStatus) await BZS.markBlocked(job.screenName, plan.effects.markStatus);
        if (plan.effects.bumpStats) await BZS.bumpStats({ total: 1, daily: 1 });
        await BZS.setQueueState({ reason: null, lastError: null });
      } else if (plan.kind === 'drop') {
        await BZS.markBlocked(job.screenName, plan.markStatus);
      } else { // requeue
        job.processing = false;
        if (plan.attempts != null) job.attempts = plan.attempts;
        await BZS.setQueue(queue);
        if (plan.pause) {
          await BZS.setQueueState({
            paused: true,
            reason: plan.pause.reason,
            pausedUntil: plan.pause.cooldownMs ? Date.now() + plan.pause.cooldownMs : 0,
            lastError: plan.pause.lastError
          });
        }
      }
    }
  } finally {
    processing = false;
  }
}

/**
 * 对单账号执行队列任务（block=拉黑 / unblock=撤销拉黑）。
 * 优先让「发起任务的那个标签页」从页面同源上下文发请求
 * （cookie 附着行为最有保证），标签页已关闭时由 SW 直接请求兜底。
 */
async function blockUser(job) {
  var isUnblock = job.action === 'unblock';
  if (typeof job.tabId === 'number') {
    var fireType = isUnblock ? 'FIRE_UNBLOCK' : 'FIRE_BLOCK';
    var viaTab = await new Promise(function (resolve) {
      try {
        chrome.tabs.sendMessage(job.tabId, { type: fireType, screenName: job.screenName }, function (res) {
          void chrome.runtime.lastError;
          resolve(res && res.status ? res : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
    if (viaTab) return viaTab;
  }

  // 兜底：SW 直接请求（popup 发起的任务无标签页，csrf 取自内容脚本缓存的会话）
  var csrf = job.csrf || await self.BotZapper.storage.getSession().then(function (s) { return s.csrf; });
  if (!csrf) return { status: 'auth_error' };
  try {
    var res = await fetch(isUnblock ? UNBLOCK_API : BLOCK_API, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'authorization': 'Bearer ' + self.BotZapper.auth.WEB_BEARER,
        'x-csrf-token': csrf,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ screen_name: job.screenName, skip_status: '1' }).toString()
    });
    return self.BotZapper.auth.mapResponse(res);
  } catch (e) {
    return { status: 'network_error' };
  }
}

function enqueueUsers(msg, sender, action) {
  var BZS = self.BotZapper.storage;
  return BZS.getQueue().then(function (queue) {
    var existing = {};
    queue.forEach(function (j) {
      // 同一账号同一动作去重；拉黑与撤销是相反操作，允许共存（后入队者后执行，符合操作顺序）
      existing[j.screenName.toLowerCase() + ':' + j.action] = true;
    });
    var added = 0;
    (msg.users || []).forEach(function (u) {
      var sn = String(u.screenName || '').toLowerCase();
      var key = sn + ':' + action;
      if (!sn || existing[key]) return;
      existing[key] = true;
      queue.push({
        id: Date.now() + '-' + Math.random().toString(36).slice(2),
        action: action,
        screenName: sn,
        csrf: msg.csrf,
        tabId: sender && sender.tab ? sender.tab.id : null,
        attempts: 0, processing: false, ts: Date.now()
      });
      added++;
    });
    return BZS.setQueue(queue).then(function () { return added; });
  });
}

self.chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  (async function () {
    var BZS = self.BotZapper.storage;
    if (!msg || typeof msg.type !== 'string') return sendResponse({ ok: false });

    if (msg.type === 'ENQUEUE_BLOCKS' || msg.type === 'ENQUEUE_UNBLOCKS') {
      var action = msg.type === 'ENQUEUE_UNBLOCKS' ? 'unblock' : 'block';
      var added = await enqueueUsers(msg, sender, action);
      // 新任务入队可能发生在熔断结束后：清掉过期的 rate_limit 暂停标记，交给 processQueue 判断
      await processQueue();
      return sendResponse({ ok: true, queued: added });
    }

    if (msg.type === 'UPDATE_RULES') {
      var result = await maybeUpdateRules(true);
      return sendResponse(result);
    }

    if (msg.type === 'RESUME_QUEUE') {
      await BZS.setQueueState({ paused: false, reason: null, pausedUntil: 0, lastError: null });
      await processQueue();
      return sendResponse({ ok: true });
    }

    if (msg.type === 'GET_STATE') {
      var state = {
        settings: await BZS.getSettings(),
        stats: await BZS.getStats(),
        queueState: await BZS.getQueueState(),
        queueLength: (await BZS.getQueue()).length
      };
      return sendResponse({ ok: true, state: state });
    }

    return sendResponse({ ok: false });
  })();
  return true; // 异步 sendResponse
});

self.chrome.alarms.create('queue-tick', { periodInMinutes: 1 });
self.chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === 'queue-tick') {
    processQueue();
    maybeUpdateRules(false); // 每分钟醒一次时顺带检查规则是否过期（内部有 24h TTL）
  }
});

self.chrome.runtime.onInstalled.addListener(function () {
  self.chrome.alarms.create('queue-tick', { periodInMinutes: 1 });
});
self.chrome.runtime.onStartup.addListener(function () {
  processQueue();
});

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

importScripts('../core/normalize.js', '../core/rules.js', '../core/auth.js', '../core/storage.js');

var BLOCK_API = 'https://x.com' + self.BotZapper.auth.BLOCK_PATH;
var MAX_ATTEMPTS = 3;

var processing = false;

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    while (true) {
      var BZS = self.BotZapper.storage;
      var queue = await BZS.getQueue();
      var settings = await BZS.getSettings();
      var state = await BZS.getQueueState();

      if (queue.length === 0) break;

      // 熔断期未到 → 退出，等下一个 alarm tick 再查
      if (state.paused && state.reason === 'rate_limit' && Date.now() < state.pausedUntil) break;
      // 熔断冷却结束 → 自动恢复
      if (state.paused && state.reason === 'rate_limit' && Date.now() >= state.pausedUntil) {
        state = await BZS.setQueueState({ paused: false, reason: null, pausedUntil: 0 });
      }
      if (state.paused && state.reason === 'auth_error') break; // 需用户在 popup 手动恢复（会话已刷新）

      // 每日限额：到量即停（不设 paused，次日 stats 归零后自然恢复）
      var stats = await BZS.getStats();
      if (stats.dailyBlocked >= settings.dailyLimit) {
        await BZS.setQueueState({ reason: 'daily_limit' });
        break;
      }

      // 取第一个非处理中的任务
      var job = null;
      for (var i = 0; i < queue.length; i++) {
        if (!queue[i].processing) { job = queue[i]; break; }
      }
      if (!job) break;

      // 标记 processing 并持久化，SW 中途被杀也不至于重复请求
      job.processing = true;
      await BZS.setQueue(queue);

      await sleep(rand(settings.minDelayMs, settings.maxDelayMs));

      var outcome = await blockUser(job);

      if (outcome.status === 'rate_limited') {
        // 熔断：任务放回队首，冷却后重试
        job.processing = false;
        await BZS.setQueue(queue);
        await BZS.setQueueState({
          paused: true, reason: 'rate_limit',
          pausedUntil: Date.now() + BZS.RATE_LIMIT_COOLDOWN_MS,
          lastError: 'rate_limit'
        });
        continue;
      }

      // 从队列移除
      var rest = [];
      for (var k = 0; k < queue.length; k++) {
        if (queue[k].id !== job.id) rest.push(queue[k]);
      }
      await BZS.setQueue(rest);

      if (outcome.status === 'blocked') {
        await BZS.markBlocked(job.screenName, 'blocked');
        await BZS.bumpStats({ total: 1, daily: 1 });
        await BZS.setQueueState({ reason: null, lastError: null });
      } else if (outcome.status === 'not_found') {
        // 账号已注销/被封，无需再拉黑，本地打标即可
        await BZS.markBlocked(job.screenName, 'not_found');
      } else if (outcome.status === 'auth_error') {
        job.processing = false;
        await BZS.setQueue(queue);
        await BZS.setQueueState({
          paused: true, reason: 'auth_error', pausedUntil: 0,
          lastError: '登录状态失效，请刷新 X 页面后在弹窗恢复队列'
        });
        continue;
      } else {
        // 网络错误等临时失败：重试计数
        job.attempts = (job.attempts || 0) + 1;
        job.processing = false;
        if (job.attempts >= MAX_ATTEMPTS) {
          var drop = [];
          for (var m = 0; m < queue.length; m++) {
            if (queue[m].id !== job.id) drop.push(queue[m]);
          }
          await BZS.setQueue(drop);
          await BZS.markBlocked(job.screenName, 'failed');
        } else {
          await BZS.setQueue(queue);
        }
      }
    }
  } finally {
    processing = false;
  }
}

/**
 * 拉黑单个账号。优先让「发起任务的那个标签页」从页面同源上下文发请求
 * （cookie 附着行为最有保证），标签页已关闭时由 SW 直接请求兜底。
 */
async function blockUser(job) {
  if (typeof job.tabId === 'number') {
    var viaTab = await new Promise(function (resolve) {
      try {
        chrome.tabs.sendMessage(job.tabId, { type: 'FIRE_BLOCK', screenName: job.screenName }, function (res) {
          void chrome.runtime.lastError;
          resolve(res && res.status ? res : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
    if (viaTab) return viaTab;
  }

  var auth = self.BotZapper.auth;
  if (!job.csrf) return { status: 'auth_error' };
  try {
    var res = await fetch(BLOCK_API, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'authorization': 'Bearer ' + auth.WEB_BEARER,
        'x-csrf-token': job.csrf,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ screen_name: job.screenName, skip_status: '1' }).toString()
    });
    return auth.mapResponse(res);
  } catch (e) {
    return { status: 'network_error' };
  }
}

self.chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  (async function () {
    var BZS = self.BotZapper.storage;
    if (!msg || typeof msg.type !== 'string') return sendResponse({ ok: false });

    if (msg.type === 'ENQUEUE_BLOCKS') {
      var queue = await BZS.getQueue();
      var existing = {};
      queue.forEach(function (j) { existing[j.screenName.toLowerCase()] = true; });
      var added = 0;
      (msg.users || []).forEach(function (u) {
        var sn = String(u.screenName || '').toLowerCase();
        if (!sn || existing[sn]) return;
        existing[sn] = true;
        queue.push({
          id: Date.now() + '-' + Math.random().toString(36).slice(2),
          screenName: sn,
          csrf: msg.csrf,
          tabId: sender && sender.tab ? sender.tab.id : null,
          attempts: 0, processing: false, ts: Date.now()
        });
        added++;
      });
      await BZS.setQueue(queue);
      // 新任务入队可能发生在熔断结束后：清掉过期的 rate_limit 暂停标记，交给 processQueue 判断
      await processQueue();
      return sendResponse({ ok: true, queued: added });
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
  if (alarm.name === 'queue-tick') processQueue();
});

self.chrome.runtime.onInstalled.addListener(function () {
  self.chrome.alarms.create('queue-tick', { periodInMinutes: 1 });
});
self.chrome.runtime.onStartup.addListener(function () {
  processQueue();
});

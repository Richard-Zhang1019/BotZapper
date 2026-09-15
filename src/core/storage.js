/**
 * 推妖镜 BotZapper · 存储层
 *
 * 全部数据落在 chrome.storage.local，不上传任何内容。
 * 依赖 chrome.* 时才触碰，Node 单测环境可安全 require 本文件。
 */
(function (root) {
  'use strict';

  var DEFAULT_SETTINGS = {
    enabled: true,          // 总开关
    sensitivity: 'standard',// loose | standard | strict
    dailyLimit: 50,         // 每日原生拉黑请求上限，保护主账号
    minDelayMs: 800,        // 队列相邻请求最小随机延迟
    maxDelayMs: 2000,       // 队列相邻请求最大随机延迟
    showBadge: true         // 浮动计数徽章
  };

  var THRESHOLD_BY_SENSITIVITY = { loose: 5, standard: 3, strict: 2 };

  var RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000; // 429 熔断冷却：10 分钟

  function hasChrome() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  function rawGet(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, function (items) { resolve(items || {}); });
    });
  }

  function rawSet(obj) {
    return new Promise(function (resolve) {
      chrome.storage.local.set(obj, function () { resolve(); });
    });
  }

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function defaultStats() {
    return { totalBlocked: 0, dailyDate: todayKey(), dailyBlocked: 0 };
  }

  async function getSettings() {
    if (!hasChrome()) return Object.assign({}, DEFAULT_SETTINGS);
    var items = await rawGet('settings');
    return Object.assign({}, DEFAULT_SETTINGS, items.settings || {});
  }

  async function saveSettings(patch) {
    var current = await getSettings();
    var next = Object.assign({}, current, patch || {});
    await rawSet({ settings: next });
    return next;
  }

  async function getStats() {
    if (!hasChrome()) return defaultStats();
    var items = await rawGet('stats');
    var stats = Object.assign(defaultStats(), items.stats || {});
    if (stats.dailyDate !== todayKey()) {
      stats.dailyDate = todayKey();
      stats.dailyBlocked = 0;
    }
    return stats;
  }

  async function bumpStats(delta) {
    var stats = await getStats();
    stats.totalBlocked += delta.total || 0;
    stats.dailyBlocked += delta.daily || 0;
    stats.dailyDate = todayKey();
    await rawSet({ stats: stats });
    return stats;
  }

  // marks: { [screenName]: { ts, status: 'blocked'|'not_found'|'failed' } }
  async function getMarks() {
    if (!hasChrome()) return {};
    var items = await rawGet('marks');
    return items.marks || {};
  }

  async function markBlocked(screenName, status) {
    var marks = await getMarks();
    marks[screenName.toLowerCase()] = { ts: Date.now(), status: status || 'blocked' };
    await rawSet({ marks: marks });
  }

  // whitelist: { [screenName]: { ts, source: 'user'|'community' } }
  async function getWhitelist() {
    if (!hasChrome()) return {};
    var items = await rawGet('whitelist');
    return items.whitelist || {};
  }

  async function addWhitelist(screenName, source) {
    var wl = await getWhitelist();
    wl[screenName.toLowerCase()] = { ts: Date.now(), source: source || 'user' };
    await rawSet({ whitelist: wl });
  }

  async function removeWhitelist(screenName) {
    var wl = await getWhitelist();
    delete wl[screenName.toLowerCase()];
    await rawSet({ whitelist: wl });
  }

  // queueState: { paused, reason, pausedUntil, lastError }
  function defaultQueueState() {
    return { paused: false, reason: null, pausedUntil: 0, lastError: null };
  }

  async function getQueueState() {
    if (!hasChrome()) return defaultQueueState();
    var items = await rawGet('queueState');
    return Object.assign(defaultQueueState(), items.queueState || {});
  }

  async function setQueueState(patch) {
    var state = await getQueueState();
    var next = Object.assign(state, patch || {});
    await rawSet({ queueState: next });
    return next;
  }

  // 持久化队列：service worker 随时可能休眠，任务必须可恢复
  async function getQueue() {
    if (!hasChrome()) return [];
    var items = await rawGet('queue');
    return items.queue || [];
  }

  async function setQueue(jobs) {
    await rawSet({ queue: jobs || [] });
  }

  function onChange(callback) {
    if (!hasChrome()) return function () {};
    var listener = function (changes, area) {
      if (area === 'local') callback(changes);
    };
    chrome.storage.onChanged.addListener(listener);
    return function () { chrome.storage.onChanged.removeListener(listener); };
  }

  var api = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    THRESHOLD_BY_SENSITIVITY: THRESHOLD_BY_SENSITIVITY,
    RATE_LIMIT_COOLDOWN_MS: RATE_LIMIT_COOLDOWN_MS,
    todayKey: todayKey,
    getSettings: getSettings,
    saveSettings: saveSettings,
    getStats: getStats,
    bumpStats: bumpStats,
    getMarks: getMarks,
    markBlocked: markBlocked,
    getWhitelist: getWhitelist,
    addWhitelist: addWhitelist,
    removeWhitelist: removeWhitelist,
    getQueueState: getQueueState,
    setQueueState: setQueueState,
    defaultQueueState: defaultQueueState,
    getQueue: getQueue,
    setQueue: setQueue,
    onChange: onChange
  };

  root.BotZapper = root.BotZapper || {};
  root.BotZapper.storage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);

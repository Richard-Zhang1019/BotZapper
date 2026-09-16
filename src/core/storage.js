/**
 * 推妖镜 BotZapper · 存储层
 *
 * 全部数据落在 chrome.storage.local，不上传任何内容。
 * 依赖 chrome.* 时才触碰，Node 单测环境可安全 require 本文件。
 */
;(function (root) {
  'use strict'

  var DEFAULT_SETTINGS = {
    enabled: true, // 总开关
    sensitivity: 'standard', // loose | standard | strict
    dailyLimit: 50, // 每日原生拉黑请求上限，保护主账号
    minDelayMs: 800, // 队列相邻请求最小随机延迟
    maxDelayMs: 2000, // 队列相邻请求最大随机延迟
    showBadge: true, // 浮动计数徽章
    remoteRulesUrl: '', // 远程规则库地址（空=禁用热更新）
  }

  var THRESHOLD_BY_SENSITIVITY = { loose: 5, standard: 3, strict: 2 }

  var RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000 // 429 熔断冷却：10 分钟

  var contextDead = false // 扩展重载/更新后，旧内容脚本的上下文已失效

  function hasChrome() {
    try {
      return (
        typeof chrome !== 'undefined' &&
        chrome.storage &&
        chrome.storage.local &&
        chrome.runtime &&
        chrome.runtime.id
      )
    } catch (e) {
      return false
    }
  }

  /** 内容脚本可用性探针：上下文失效（扩展被重载）后返回 false */
  function isAlive() {
    return !contextDead && hasChrome()
  }

  /**
   * 包裹 chrome.* 调用：扩展重载后旧上下文的 API 会同步抛
   * 「Extension context invalidated」，此处捕获并静默降级为空结果，
   * 并把 contextDead 置位（内容脚本据此自行停止工作）。
   */
  function guarded(fn, fallback) {
    return function () {
      if (contextDead || !hasChrome()) return Promise.resolve(fallback)
      try {
        return fn.apply(null, arguments)
      } catch (e) {
        contextDead = true
        return Promise.resolve(fallback)
      }
    }
  }

  function rawGet(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, function (items) {
        resolve(items || {})
      })
    })
  }

  function rawSet(obj) {
    return new Promise(function (resolve) {
      chrome.storage.local.set(obj, function () {
        resolve()
      })
    })
  }

  var safeGet = guarded(rawGet, {})
  var safeSet = guarded(rawSet, undefined)

  function todayKey() {
    var d = new Date()
    return (
      d.getFullYear() +
      '-' +
      String(d.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(d.getDate()).padStart(2, '0')
    )
  }

  function defaultStats() {
    return { totalBlocked: 0, dailyDate: todayKey(), dailyBlocked: 0 }
  }

  async function getSettings() {
    if (!hasChrome()) return Object.assign({}, DEFAULT_SETTINGS)
    var items = await safeGet('settings')
    return Object.assign({}, DEFAULT_SETTINGS, items.settings || {})
  }

  async function saveSettings(patch) {
    var current = await getSettings()
    var next = Object.assign({}, current, patch || {})
    await safeSet({ settings: next })
    return next
  }

  async function getStats() {
    if (!hasChrome()) return defaultStats()
    var items = await safeGet('stats')
    var stats = Object.assign(defaultStats(), items.stats || {})
    if (stats.dailyDate !== todayKey()) {
      stats.dailyDate = todayKey()
      stats.dailyBlocked = 0
    }
    return stats
  }

  async function bumpStats(delta) {
    var stats = await getStats()
    stats.totalBlocked += delta.total || 0
    stats.dailyBlocked += delta.daily || 0
    stats.dailyDate = todayKey()
    await safeSet({ stats: stats })
    return stats
  }

  // marks: { [screenName]: { ts, status: 'blocked'|'not_found'|'failed' } }
  async function getMarks() {
    if (!hasChrome()) return {}
    var items = await safeGet('marks')
    return items.marks || {}
  }

  async function markBlocked(screenName, status) {
    var marks = await getMarks()
    marks[screenName.toLowerCase()] = {
      ts: Date.now(),
      status: status || 'blocked',
    }
    await safeSet({ marks: marks })
  }

  async function removeMark(screenName) {
    var marks = await getMarks()
    delete marks[screenName.toLowerCase()]
    await safeSet({ marks: marks })
  }

  // 远程规则库：{ fetchedAt, data: {version, textRules, nameRules} }
  function defaultRemoteRules() {
    return { fetchedAt: 0, data: null }
  }

  async function getRemoteRules() {
    if (!hasChrome()) return defaultRemoteRules()
    var items = await safeGet('remoteRules')
    return Object.assign(defaultRemoteRules(), items.remoteRules || {})
  }

  async function saveRemoteRules(entry) {
    await safeSet({ remoteRules: entry })
  }

  // 页面会话（内容脚本写入，popup/SW 兜底请求时复用）
  async function getSession() {
    if (!hasChrome()) return { csrf: '', updatedAt: 0 }
    var items = await safeGet('session')
    return Object.assign({ csrf: '', updatedAt: 0 }, items.session || {})
  }

  async function setSession(patch) {
    var session = await getSession()
    var next = Object.assign(session, patch || {}, { updatedAt: Date.now() })
    await safeSet({ session: next })
    return next
  }
  // whitelist: { [screenName]: { ts, source: 'user'|'community' } }
  async function getWhitelist() {
    if (!hasChrome()) return {}
    var items = await safeGet('whitelist')
    return items.whitelist || {}
  }

  async function addWhitelist(screenName, source) {
    var wl = await getWhitelist()
    wl[screenName.toLowerCase()] = { ts: Date.now(), source: source || 'user' }
    await safeSet({ whitelist: wl })
  }

  async function removeWhitelist(screenName) {
    var wl = await getWhitelist()
    delete wl[screenName.toLowerCase()]
    await safeSet({ whitelist: wl })
  }

  // queueState: { paused, reason, pausedUntil, lastError }
  function defaultQueueState() {
    return { paused: false, reason: null, pausedUntil: 0, lastError: null }
  }

  async function getQueueState() {
    if (!hasChrome()) return defaultQueueState()
    var items = await safeGet('queueState')
    return Object.assign(defaultQueueState(), items.queueState || {})
  }

  async function setQueueState(patch) {
    var state = await getQueueState()
    var next = Object.assign(state, patch || {})
    await safeSet({ queueState: next })
    return next
  }

  // 持久化队列：service worker 随时可能休眠，任务必须可恢复
  async function getQueue() {
    if (!hasChrome()) return []
    var items = await safeGet('queue')
    return items.queue || []
  }

  async function setQueue(jobs) {
    await safeSet({ queue: jobs || [] })
  }

  // 自定义违规词: [{ pattern, weight, ts }]，weight: 4=强 2=中 1=弱
  async function getCustomRules() {
    if (!hasChrome()) return []
    var items = await safeGet('customRules')
    return items.customRules || []
  }

  async function saveCustomRules(list) {
    var seen = {}
    var out = []
    var nz = root.BotZapper && root.BotZapper.normalize
    ;(list || []).forEach(function (r) {
      var p = String(r.pattern || '')
        .trim()
        .slice(0, 40)
      if (!p) return
      var w = Number(r.weight) || 2
      if ([1, 2, 4].indexOf(w) === -1) w = 2
      var key = nz ? nz(p).compact.toLowerCase() : p.toLowerCase()
      if (!key || seen[key]) return
      seen[key] = true
      out.push({ pattern: p, weight: w, ts: r.ts || Date.now() })
    })
    await safeSet({ customRules: out.slice(0, 100) })
    return out
  }

  function onChange(callback) {
    if (!isAlive()) return function () {}
    try {
      var listener = function (changes, area) {
        if (area === 'local') callback(changes)
      }
      chrome.storage.onChanged.addListener(listener)
      return function () {
        chrome.storage.onChanged.removeListener(listener)
      }
    } catch (e) {
      contextDead = true
      return function () {}
    }
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
    getCustomRules: getCustomRules,
    saveCustomRules: saveCustomRules,
    getRemoteRules: getRemoteRules,
    saveRemoteRules: saveRemoteRules,
    defaultRemoteRules: defaultRemoteRules,
    getSession: getSession,
    setSession: setSession,
    removeMark: removeMark,
    isAlive: isAlive,
    onChange: onChange,
  }

  root.BotZapper = root.BotZapper || {}
  root.BotZapper.storage = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof self !== 'undefined' ? self : globalThis)

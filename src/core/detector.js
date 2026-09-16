/**
 * 推妖镜 BotZapper · 识别引擎
 *
 * 纯本地评分：词库命中只加分，总分 ≥ 阈值才判定为「疑似妖物」。
 * 不发任何网络请求。白名单短路在调用方（content script）完成。
 */
(function (root) {
  'use strict';

  var NZ = root.BotZapper && root.BotZapper.normalize ? root.BotZapper : (typeof require === 'function' ? require('./normalize.js') : null);
  var RULES = root.BotZapper && root.BotZapper.rules ? root.BotZapper.rules : (typeof require === 'function' ? require('./rules.js') : null);

  if (!NZ || !RULES) throw new Error('BotZapper detector: missing normalize/rules dependency');

  var DEFAULT_THRESHOLD = 3; // 标准（standard）档

  function clampWeight(w) {
    var n = Number(w);
    return (n === 1 || n === 2 || n === 4) ? n : 2;
  }

  /**
   * @param {{text: string, displayName: string}} input
   * @param {number} [threshold]
   * @param {Array|{text:Array,name:Array}} [extraRules] 额外词库（远程+自定义合并）。
   *   数组形式视作纯文本词（向后兼容）；对象形式 {text,name}。同形 pattern 后来者覆盖内置/先前项。
   * @param {{repeatedText?:boolean}} [signals] 页面级信号（复读检测等）
   * @returns {{score:number, threshold:number, flagged:boolean, hits:Array<{key:string,weight:number,label:string,where:string}>}}
   */
  function analyze(input, threshold, extraRules, signals) {
    threshold = typeof threshold === 'number' ? threshold : DEFAULT_THRESHOLD;
    var hits = [];
    var score = 0;

    function addHit(rule, where) {
      // 同一条规则只计一次（评论+昵称重复命中同一词不翻倍）
      for (var i = 0; i < hits.length; i++) {
        if (hits[i].key === rule.key) return;
      }
      hits.push({ key: rule.key, weight: rule.weight, label: rule.label, where: where });
      score += rule.weight;
    }

    var text = NZ.normalize(input.text || '');
    var name = NZ.normalize(input.displayName || '');

    var extraText = Array.isArray(extraRules) ? extraRules : (extraRules && extraRules.text) || [];
    var extraName = Array.isArray(extraRules) ? [] : (extraRules && extraRules.name) || [];

    // 文本短语规则（compact 形态）；extraRules 与内置同形时覆盖权重与标签（后来者优先）
    if (extraText.length) {
      var builtinPat = {};
      for (var b = 0; b < RULES.textRules.length; b++) builtinPat[RULES.textRules[b].pattern] = true;
      var byPat = {};
      for (var c = 0; c < extraText.length; c++) {
        var pat = NZ.normalize(extraText[c].pattern).compact;
        if (!pat) continue;
        byPat[pat] = { weight: clampWeight(extraText[c].weight), label: extraText[c].label || '自定义词' };
      }
      for (var i = 0; i < RULES.textRules.length; i++) {
        var r2 = RULES.textRules[i];
        var o = byPat[r2.pattern];
        var eff = o
          ? { key: r2.key, weight: o.weight, label: o.label, pattern: r2.pattern }
          : r2;
        if (text.compact.indexOf(eff.pattern) !== -1) addHit(eff, 'text');
      }
      for (var p in byPat) {
        if (builtinPat[p]) continue; // 同形词已在上方以覆盖方式计分，避免重复
        if (text.compact.indexOf(p) !== -1) {
          addHit({ key: 'x:' + p, weight: byPat[p].weight, label: byPat[p].label, pattern: p }, 'text');
        }
      }
    } else {
      for (var j = 0; j < RULES.textRules.length; j++) {
        if (text.compact.indexOf(RULES.textRules[j].pattern) !== -1) addHit(RULES.textRules[j], 'text');
      }
    }
    // 文本正则规则（norm 形态）
    for (var j = 0; j < RULES.regexRules.length; j++) {
      if (RULES.regexRules[j].re.test(text.norm)) addHit(RULES.regexRules[j], 'text');
    }
    // 文本元特征
    if (text.hasInvisible) addHit(RULES.metaRules.invisible, 'meta');
    if (text.hasFullWidthLetter && (text.compact.indexOf('http') !== -1 || text.compact.indexOf('www') !== -1)) {
      addHit(RULES.metaRules.fwUrl, 'meta');
    }
    // 昵称规则
    for (var k = 0; k < RULES.nameRules.length; k++) {
      if (name.compact.indexOf(RULES.nameRules[k].pattern) !== -1) addHit(RULES.nameRules[k], 'name');
    }
    // 额外昵称规则（远程词库）：与内置同形时跳过，避免重复计分
    if (extraName.length) {
      var builtinName = {};
      for (var n2 = 0; n2 < RULES.nameRules.length; n2++) builtinName[RULES.nameRules[n2].pattern] = true;
      for (var n3 = 0; n3 < extraName.length; n3++) {
        var np = NZ.normalize(extraName[n3].pattern).compact;
        if (!np || builtinName[np]) continue;
        if (name.compact.indexOf(np) !== -1) {
          addHit({ key: 'xn:' + np, weight: clampWeight(extraName[n3].weight), label: extraName[n3].label || '远程词库' }, 'name');
        }
      }
    }
    if (/\d{5,}/.test(name.norm)) addHit(RULES.metaRules.nameDigits, 'name');

    // 页面级信号（复读检测等）
    if (signals && signals.repeatedText) addHit(RULES.metaRules.repetition, 'meta');

    return { score: score, threshold: threshold, flagged: score >= threshold, hits: hits };
  }

  var api = { analyze: analyze, DEFAULT_THRESHOLD: DEFAULT_THRESHOLD };

  root.BotZapper = root.BotZapper || {};
  root.BotZapper.detector = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);

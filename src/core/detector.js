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

  /**
   * @param {{text: string, displayName: string}} input
   * @param {number} [threshold]
   * @returns {{score:number, threshold:number, flagged:boolean, hits:Array<{key:string,weight:number,label:string,where:string}>}}
   */
  function analyze(input, threshold) {
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

    // 文本短语规则（compact 形态）
    for (var i = 0; i < RULES.textRules.length; i++) {
      if (text.compact.indexOf(RULES.textRules[i].pattern) !== -1) addHit(RULES.textRules[i], 'text');
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
    if (/\d{5,}/.test(name.norm)) addHit(RULES.metaRules.nameDigits, 'name');

    return { score: score, threshold: threshold, flagged: score >= threshold, hits: hits };
  }

  var api = { analyze: analyze, DEFAULT_THRESHOLD: DEFAULT_THRESHOLD };

  root.BotZapper = root.BotZapper || {};
  root.BotZapper.detector = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);

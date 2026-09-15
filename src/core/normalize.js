/**
 * 推妖镜 BotZapper · 字符归一化
 *
 * 对抗字符伪装（全角变体、零宽字符、分隔符插空）的第一道防线。
 * 纯函数、零依赖，浏览器内容脚本与 Node 测试共用。
 *
 * 输出两种形态：
 *   norm    —— 全角转半角、去零宽字符、转小写，保留词边界，用于正则类规则
 *   compact —— 在 norm 基础上剥离所有空白与中英文标点，用于黑话短语匹配
 */
(function (root) {
  'use strict';

  // 零宽/不可见字符：零宽空格、零宽连字、BOM、方向标记、阿拉伯数字符等
  var INVISIBLE_RE = /[\u200B-\u200F\u2060\u2066-\u2069\uFEFF\u061C]/g;
  // 全角字母（U+FF41–U+FF5A / U+FF21–U+FF3A），出现即视为伪装信号
  var FULLWIDTH_LETTER_RE = /[\uFF21-\uFF3A\uFF41-\uFF5A]/;
  // 标点/符号（中英文），compact 阶段剥离。保留字母数字与 CJK。
  var SEPARATOR_RE = /[\s\u3000!-/:-@[-`{-~\u3001\u3002\u3008-\u3011\u3014\u3015\u301C\u301D\u301E\u30FB\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\u00B7\u2026\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2E3A\u2E3B]+/g;

  function toHalfWidth(str) {
    var out = '';
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      if (code >= 0xFF01 && code <= 0xFF5E) {
        out += String.fromCharCode(code - 0xFEE0);
      } else if (code === 0x3000) {
        out += ' ';
      } else {
        out += str[i];
      }
    }
    return out;
  }

  /**
   * @param {string} raw 原始文本（评论正文或昵称）
   * @returns {{norm: string, compact: string, hasInvisible: boolean, hasFullWidthLetter: boolean}}
   */
  function normalize(raw) {
    var text = String(raw || '');
    var hasInvisible = INVISIBLE_RE.test(text);
    var hasFullWidthLetter = FULLWIDTH_LETTER_RE.test(text);

    var norm = toHalfWidth(text).replace(INVISIBLE_RE, '').toLowerCase();
    var compact = norm.replace(SEPARATOR_RE, '');

    return { norm: norm, compact: compact, hasInvisible: hasInvisible, hasFullWidthLetter: hasFullWidthLetter };
  }

  var api = { normalize: normalize };

  root.BotZapper = root.BotZapper || {};
  root.BotZapper.normalize = normalize; // 直接挂函数，detector 以 NZ.normalize(text) 调用
  if (typeof module !== 'undefined' && module.exports) module.exports = normalize;
})(typeof self !== 'undefined' ? self : globalThis);

/**
 * 推妖镜 BotZapper · 字符归一化
 *
 * 对抗字符伪装（全角变体、零宽字符、分隔符插空、繁体变体）的第一道防线。
 * 纯函数、零依赖，浏览器内容脚本与 Node 测试共用。
 *
 * 输出两种形态：
 *   norm    —— 繁体折叠、全角转半角、去零宽字符、转小写，保留词边界，用于正则类规则
 *   compact —— 在 norm 基础上剥离所有空白与中英文标点，用于黑话短语匹配
 */
(function (root) {
  'use strict';

  // 零宽/不可见字符：零宽空格、零宽连字、BOM、方向标记、阿拉伯数字符等
  var INVISIBLE_TEST_RE = /[\u200B-\u200F\u2060\u2066-\u2069\uFEFF\u061C]/;
  var INVISIBLE_STRIP_RE = /[\u200B-\u200F\u2060\u2066-\u2069\uFEFF\u061C]/g;
  // 全角字母（U+FF41–U+FF5A / U+FF21–U+FF3A），出现即视为伪装信号
  var FULLWIDTH_LETTER_RE = /[\uFF21-\uFF3A\uFF41-\uFF5A]/;
  // 标点/符号（中英文），compact 阶段剥离。保留字母数字与 CJK。
  var SEPARATOR_RE = /[\s\u3000!-/:-@[-`{-~\u3001\u3002\u3008-\u3011\u3014\u3015\u301C\u301D\u301E\u30FB\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\u00B7\u2026\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2E3A\u2E3B]+/g;
  // emoji 与符号（含增补平面/变体选择符/私有区图标），同样视为插空噪声
  var SYMBOL_RE = /[\u2190-\u2BFF\uFE0E\uFE0F\u20E3\u00A9\u00AE\u2122\u2000-\u200A\u202F\u205F]+/g;
  var EMOJI_RE = /[\u{1F000}-\u{1FFFF}\u{E000}-\u{F8FF}]/gu;

  // 繁体→简体折叠表：只收黑产话术高频变体字（約炮/學生妹/上門服務/電報群/免費領…），
  // 折叠后与内置简体词库共用同一套 pattern，无需为繁体维护第二套词库。
  // 仅收简繁一一对应、合并后在此场景无歧义的字符；人名地名常用字（如 薇）不入表，
  // 避免「薇娅」这类正常昵称被改写。
  var VARIANT_MAP = {
    約: '约', 門: '门', 務: '务', 費: '费', 學: '学', 網: '网', 黃: '黄', 圍: '围', 處: '处',
    點: '点', 頁: '页', 頂: '顶', 簡: '简', 領: '领', 綠: '绿', 軟: '软', 電: '电', 報: '报',
    號: '号', 飛: '飞', 鵝: '鹅', 內: '内', 線: '线', 帶: '带', 單: '单', 師: '师', 職: '职',
    結: '结', 資: '资', 傭: '佣', 戶: '户', 開: '开', 訊: '讯', 聯: '联', 視: '视', 頻: '频',
    錢: '钱', 話: '话', 車: '车', 這: '这', 裡: '里', 裏: '里', 後: '后', 會: '会', 個: '个',
    們: '们', 來: '来', 沒: '没', 樣: '样', 愛: '爱', 無: '无', 禮: '礼', 遊: '游', 戲: '戏',
    導: '导', 賬: '账', 帳: '账', 碼: '码', 幣: '币', 區: '区', 級: '级', 賺: '赚', 險: '险',
    詐: '诈', 騙: '骗', 賭: '赌', 場: '场', 應: '应', 歲: '岁', 親: '亲', 關: '关', 發: '发',
    貼: '贴', 評: '评', 轉: '转', 讚: '赞', 萬: '万', 億: '亿', 圖: '图', 醫: '医', 藥: '药',
    見: '见', 專: '专', 業: '业', 員: '员', 亞: '亚', 傳: '传', 聽: '听', 機: '机', 賣: '卖',
    買: '买', 對: '对', 雙: '双', 臺: '台', 灣: '湾', 給: '给', 麼: '么', 廣: '广', 標: '标',
    週: '周', 風: '风', 經: '经', 濟: '济', 於: '于', 與: '与', 為: '为', 說: '说', 請: '请',
    進: '进', 時: '时', 間: '间', 幹: '干', 廠: '厂', 華: '华', 實: '实', 寧: '宁', 態: '态', 體: '体', 變: '变', 讓: '让'
  };
  var VARIANT_RE = new RegExp('[' + Object.keys(VARIANT_MAP).join('') + ']', 'g');

  /** 繁体变体字折叠为内置词库对应的简体形态 */
  function foldVariants(str) {
    return str.replace(VARIANT_RE, function (ch) { return VARIANT_MAP[ch]; });
  }

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
    var text = foldVariants(String(raw || ''));
    var hasInvisible = INVISIBLE_TEST_RE.test(text);
    var hasFullWidthLetter = FULLWIDTH_LETTER_RE.test(text);

    var norm = toHalfWidth(text).replace(INVISIBLE_STRIP_RE, '').toLowerCase();
    // compact 再剥离 emoji/符号，对抗「不进入生活👋🙅只进入身体」式穿插
    var compact = norm.replace(SEPARATOR_RE, '').replace(SYMBOL_RE, '').replace(EMOJI_RE, '');

    return { norm: norm, compact: compact, hasInvisible: hasInvisible, hasFullWidthLetter: hasFullWidthLetter };
  }

  normalize.foldVariants = foldVariants; // 附挂在函数上：模块导出的就是 normalize 函数本身

  root.BotZapper = root.BotZapper || {};
  root.BotZapper.normalize = normalize; // 直接挂函数，detector 以 NZ.normalize(text) 调用
  if (typeof module !== 'undefined' && module.exports) module.exports = normalize;
})(typeof self !== 'undefined' ? self : globalThis);

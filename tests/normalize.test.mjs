import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import test from 'node:test';
import assert from 'node:assert/strict';

const normalize = require('../src/core/normalize.js');

test('全角转半角', () => {
  const r = normalize('ｈｔｔｐｓ：//example.com');
  assert.equal(r.hasFullWidthLetter, true);
  assert.ok(r.norm.includes('https://example.com'));
});

test('compact 剥离空白与标点，对抗插空混淆', () => {
  const r = normalize('看。我 主.页～有惊喜');
  assert.equal(r.compact, '看我主页有惊喜');
});

test('零宽字符被剥离并标记', () => {
  const r = normalize('加\u200B微\u200C信');
  assert.equal(r.hasInvisible, true);
  assert.equal(r.compact, '加微信');
});

test('全角空格与大小写归一', () => {
  const r = normalize('Check\u3000My\u3000BIO');
  assert.equal(r.compact, 'checkmybio');
});

test('普通文本不误报隐形/全角特征', () => {
  const r = normalize('今天天气不错，适合散步');
  assert.equal(r.hasInvisible, false);
  assert.equal(r.hasFullWidthLetter, false);
});

// —— 繁体变体折叠（黑产常用繁体话术）——

test('繁体折叠：约炮/學生妹/上門/電報群 折叠后与简体词库同形', () => {
  assert.equal(normalize('約炮').compact, '约炮');
  assert.equal(normalize('學生妹上門服務').compact, '学生妹上门服务');
  assert.equal(normalize('電報群免費領福利').compact, '电报群免费领福利');
  assert.equal(normalize('看我主頁').compact, '看我主页');
});

test('繁体折叠不污染正常内容', () => {
  // 繁体日常文本折叠为简体但语义不变，不应命中任何规则
  const r = normalize('這個週末我們一起去後山看風景，很好玩');
  assert.equal(r.compact, '这个周末我们一起去后山看风景很好玩');
  assert.equal(r.hasInvisible, false);
});

test('foldVariants 单独可用且幂等', () => {
  const fold = normalize.foldVariants;
  assert.equal(fold('約炮利器'), '约炮利器');
  assert.equal(fold(fold('約炮利器')), fold('約炮利器'));
  assert.equal(fold('ABC abc 123'), 'ABC abc 123'); // 半角/英文不受影响
});

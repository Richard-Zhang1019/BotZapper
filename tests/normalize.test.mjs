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

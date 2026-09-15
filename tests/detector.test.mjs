import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import test from 'node:test';
import assert from 'node:assert/strict';

const root = globalThis;
require('../src/core/normalize.js');
require('../src/core/rules.js');
require('../src/core/detector.js');
const analyze = root.BotZapper.detector.analyze;

// 标准档阈值 = 3：单词强信号(4)触发；两个中信号(2+2)触发；单词中信号(2)不触发
const STD = 3;

test('强信号单词命中即标黄', () => {
  const r = analyze({ text: '小姐姐看过来，同城约不吃亏', displayName: '小美' }, STD);
  assert.ok(r.flagged);
  assert.ok(r.score >= 4);
});

test('两个中信号组合触发', () => {
  const r = analyze({ text: '看我主页有惊喜，电报群更精彩', displayName: 'x' }, STD);
  assert.ok(r.flagged);
});

test('单词中信号不触发（防误杀）', () => {
  const r = analyze({ text: '需要模板的私信我', displayName: '张三' }, STD);
  assert.ok(!r.flagged);
});

test('完全正常的评论零分', () => {
  const r = analyze({ text: '这条视频拍得太好了，转发了', displayName: '李四' }, STD);
  assert.equal(r.score, 0);
  assert.ok(!r.flagged);
});

test('全角伪装链接被抓（元特征 3 分触发）', () => {
  const r = analyze({ text: '福利在这里 ｈｔｔｐｓ://bit.例/x', displayName: 'x' }, STD);
  assert.ok(r.flagged);
  assert.ok(r.hits.some(h => h.key === 'fwurl'));
});

test('插空混淆的引流话术被 compact 匹配', () => {
  const r = analyze({ text: '看.我 主,页～有！', displayName: 'x' }, STD);
  assert.ok(r.flagged);
});

test('零宽字符辅助加权', () => {
  const r = analyze({ text: '加\u200B微\u200C信看福利', displayName: 'x' }, STD);
  assert.ok(r.flagged);
});

test('昵称特征参与评分', () => {
  const r = analyze({ text: '晚上有空吗', displayName: '上门服务小玉88997' }, STD);
  assert.ok(r.flagged);
  assert.ok(r.hits.some(h => h.where === 'name'));
});

test('宽松档过滤掉两中信号组合，严格档单词中信号即触发', () => {
  const text = { text: '看我主页有惊喜', displayName: 'x' };
  assert.ok(!analyze(text, 5).flagged);   // loose：4 分 < 5
  assert.ok(analyze(text, 3).flagged);    // standard
});

test('「啪啪打脸」等日常用语不触发强信号', () => {
  const r = analyze({ text: '这波被啪啪打脸了吧', displayName: '路人甲' }, STD);
  assert.ok(!r.flagged);
});

test('t.me 正则命中：单词不触发，叠加弱信号才触发（防误杀）', () => {
  const lone = analyze({ text: '快来 t.me/joinchat/abc', displayName: 'x' }, STD);
  assert.ok(lone.hits.some(h => h.key === 'tme'));
  assert.ok(!lone.flagged); // 2 分 < 阈值 3

  const combined = analyze({ text: '福利频道 t.me/joinchat/abc', displayName: 'x' }, STD);
  assert.ok(combined.flagged); // tme(2) + 福利(1) = 3
});

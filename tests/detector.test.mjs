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

test('自定义词：强信号单词即触发', () => {
  const r = analyze({ text: '工作室长期接推广', displayName: 'x' }, STD, [
    { pattern: '接推广', weight: 4 }
  ]);
  assert.ok(r.flagged);
  assert.ok(r.hits.some(h => h.weight === 4 && h.label === '自定义词' && h.where === 'text'));
});

test('自定义词：中信号需组合，与内置词同形时用户权重覆盖内置', () => {
  const lone = analyze({ text: '偶尔接推广', displayName: 'x' }, STD, [{ pattern: '接推广', weight: 2 }]);
  assert.ok(!lone.flagged); // 2 分 < 3

  // 自定义「福利」(中=2) 与内置弱信号(1) 同形 → 用户权重覆盖，不叠加、不忽略
  const dup = analyze({ text: '福利时间', displayName: 'x' }, STD, [{ pattern: '福利', weight: 2 }]);
  assert.equal(dup.score, 2);
  assert.ok(!dup.flagged);

  const strong = analyze({ text: '福利时间', displayName: 'x' }, STD, [{ pattern: '福利', weight: 4 }]);
  assert.ok(strong.flagged); // 覆盖为强信号后单词即触发
});

test('自定义词：匹配同样经过 compact 归一化', () => {
  const r = analyze({ text: '可以 带,货 吗', displayName: 'x' }, STD, [{ pattern: '带货', weight: 4 }]);
  assert.ok(r.flagged);
});

// —— 2026-09-16 真实样本回归 ——

test('emoji 穿插的机器复读文本，自定义强信号词触发', () => {
  const r = analyze({ text: '不进入生活🙅只进入身体', displayName: 'x' }, STD, [
    { pattern: '只进入身体', weight: 4 }
  ]);
  assert.ok(r.flagged); // emoji 被剥离，只进入身体(4) 命中
});

test('自定义中信号单词不触发（用户截图的原始场景）', () => {
  const r = analyze({ text: '不进入生活👋🙅只进入身体', displayName: '普通昵称' }, STD, [
    { pattern: '只进入身体', weight: 2 }
  ]);
  assert.ok(!r.flagged); // 2 分 < 标准阈值 3 —— 想单词触发请选「强」
});

test('真实样本昵称「找炮友」「点主页」直接触发', () => {
  const r = analyze({ text: '你好呀', displayName: '雨萱🍑找炮友🍑点主页' }, STD);
  assert.ok(r.flagged); // n_zhaopaoyou(4)
  assert.ok(r.hits.some(h => h.key === 'n_zhaopaoyou'));
});

test('炮友单词不触发，组合信号触发；破处单词即触发', () => {
  const lone = analyze({ text: '哪有那么多炮友', displayName: '路人' }, STD);
  assert.ok(!lone.flagged); // 2 分

  const combo = analyze({ text: '同城炮友私信我', displayName: '路人' }, STD);
  assert.ok(combo.flagged); // 炮友(2)+同城(1)+私信(1)=4

  const pochu = analyze({ text: '同城免费破处', displayName: 'x' }, STD);
  assert.ok(pochu.flagged); // 破处(4)
});

// —— P1：复读信号与远程词库 ——

test('复读信号(+2)作为组合信号触发，短语过短不参与聚类', () => {
  const text = { text: '速上车，进裙看福利', displayName: '路人甲' }; // 上车1+福利1=2
  assert.ok(!analyze(text, STD).flagged);
  assert.ok(analyze(text, STD, null, { repeatedText: true }).flagged); // +复读2 = 4
  assert.ok(analyze(text, STD, null, { repeatedText: true }).hits.some(h => h.key === 'repetition'));
});

test('extraRules 对象形式：远程文本词 + 远程昵称词 + 标签', () => {
  const r = analyze({ text: '这个可以有', displayName: '小雪嗯嗯' }, STD, {
    text: [{ pattern: '这个可以有', weight: 4, label: '远程词库' }],
    name: [{ pattern: '小雪', weight: 2, label: '远程词库' }]
  });
  assert.ok(r.flagged);
  assert.ok(r.hits.some(h => h.label === '远程词库' && h.where === 'text'));
  assert.ok(r.hits.some(h => h.where === 'name'));
});

test('extraRules 同形覆盖：后来者优先（自定义覆盖远程）', () => {
  const r = analyze({ text: '福利时间', displayName: 'x' }, STD, [
    { pattern: '福利', weight: 4, label: '远程词库' },
    { pattern: '福利', weight: 1, label: '自定义词' }
  ]);
  assert.equal(r.score, 1); // 自定义(1) 最终覆盖远程(4)与内置(1)，且只计一次
  assert.ok(!r.flagged);
});

test('validateRemote：结构校验、权重钳制、拒绝空版本', () => {
  const rules = globalThis.BotZapper.rules;
  const good = rules.validateRemote({
    version: '2026.10.01',
    textRules: [{ pattern: ' ok词 ', weight: 9 }, { pattern: '', weight: 2 }, { pattern: '好词' }],
    nameRules: 'garbage'
  });
  assert.ok(good.ok);
  assert.equal(good.version, '2026.10.01');
  assert.deepEqual(good.textRules.map(r => [r.pattern, r.weight]), [['ok词', 2], ['好词', 2]]);
  assert.deepEqual(good.nameRules, []);

  assert.ok(!rules.validateRemote({ textRules: [] }).ok); // 缺版本号
  assert.ok(!rules.validateRemote(null).ok);
});

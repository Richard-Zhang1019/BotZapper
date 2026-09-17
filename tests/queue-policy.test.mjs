import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import test from 'node:test';
import assert from 'node:assert/strict';

const QP = require('../src/core/queue-policy.js');

const NOW = 1_800_000_000_000;
const SETTINGS = { dailyLimit: 50, minDelayMs: 800, maxDelayMs: 2000 };

function blockJob(overrides) {
  return Object.assign({ id: 'j1', action: 'block', screenName: 'spam1', attempts: 0, processing: false }, overrides);
}

function evaluate(queue, extra) {
  return QP.evaluateNext(Object.assign({
    queue: queue, settings: SETTINGS,
    state: { paused: false, reason: null, pausedUntil: 0 },
    stats: { totalBlocked: 0, dailyBlocked: 0 },
    now: NOW
  }, extra || {}));
}

// —— evaluateNext：基础流转 ——

test('空队列与全 processing（未超时）→ idle', () => {
  assert.equal(evaluate([]).verdict, 'idle');
  const busy = blockJob({ processing: true, startedAt: NOW - 1000 });
  assert.equal(evaluate([busy]).verdict, 'idle');
});

test('正常队列 → run_job 首个任务；头部 processing 时跳过取下一个', () => {
  const d = evaluate([blockJob()]);
  assert.equal(d.verdict, 'run_job');
  assert.equal(d.job.screenName, 'spam1');
  assert.equal(d.recovered, false);

  const busy = blockJob({ screenName: 'busy', processing: true, startedAt: NOW - 1000 });
  const next = blockJob({ id: 'j2', screenName: 'next' });
  const d2 = evaluate([busy, next]);
  assert.equal(d2.verdict, 'run_job');
  assert.equal(d2.job.screenName, 'next');
});

test('持久化恢复：processing 超时或无 startedAt（旧版本遗留）→ 重新执行', () => {
  const stale = blockJob({ processing: true, startedAt: NOW - QP.STALE_PROCESSING_MS - 1 });
  const d = evaluate([stale]);
  assert.equal(d.verdict, 'run_job');
  assert.equal(d.recovered, true);
  assert.equal(d.job.screenName, 'spam1');

  const legacy = blockJob({ processing: true }); // startedAt 缺失 → now-0 远超阈值
  assert.equal(evaluate([legacy]).verdict, 'run_job');
});

// —— evaluateNext：熔断/登录失效/日限额 ——

test('rate_limit 熔断中 → wait_cooldown；冷却结束 → resume', () => {
  const paused = { paused: true, reason: 'rate_limit', pausedUntil: NOW + 60_000 };
  const d = evaluate([blockJob()], { state: paused });
  assert.equal(d.verdict, 'wait_cooldown');
  assert.equal(d.resumeAt, NOW + 60_000);

  const cooled = { paused: true, reason: 'rate_limit', pausedUntil: NOW - 1 };
  assert.equal(evaluate([blockJob()], { state: cooled }).verdict, 'resume');
});

test('auth_error 暂停 → wait_auth，等待用户在弹窗恢复', () => {
  const state = { paused: true, reason: 'auth_error', pausedUntil: 0 };
  assert.equal(evaluate([blockJob()], { state }).verdict, 'wait_auth');
});

test('日限额到量 → daily_limit；纯撤销队列不受限额门控', () => {
  const d = evaluate([blockJob()], { stats: { totalBlocked: 50, dailyBlocked: 50 } });
  assert.equal(d.verdict, 'daily_limit');

  const unblockOnly = evaluate(
    [blockJob({ action: 'unblock', screenName: 'friend1' })],
    { stats: { totalBlocked: 50, dailyBlocked: 50 } }
  );
  assert.equal(unblockOnly.verdict, 'run_job'); // 撤销不占每日额度

  // 处理中的拉黑任务不计入 blocking 判定：队列只剩它时不会误判为 daily_limit
  const busyBlock = blockJob({ processing: true, startedAt: NOW - 1000 });
  const unblock = blockJob({ id: 'j2', action: 'unblock', screenName: 'friend1' });
  assert.equal(
    evaluate([busyBlock, unblock], { stats: { totalBlocked: 50, dailyBlocked: 50 } }).verdict,
    'run_job'
  );
});

test('熔断冷却结束但已达日限额：先 resume 清暂停标记，下一轮再判 daily_limit', () => {
  // SW 循环语义：resume 只负责清标记并重新走一遍判定，不跳过限额检查
  const cooled = { paused: true, reason: 'rate_limit', pausedUntil: NOW - 1 };
  assert.equal(evaluate([blockJob()], { state: cooled, stats: { dailyBlocked: 50 } }).verdict, 'resume');
});

test('恢复执行的遗留拉黑任务同样受限额门控', () => {
  const stale = blockJob({ processing: true, startedAt: NOW - QP.STALE_PROCESSING_MS - 1 });
  const d = evaluate([stale], { stats: { totalBlocked: 50, dailyBlocked: 50 } });
  assert.equal(d.verdict, 'daily_limit');
});

// —— planOutcome：结果收尾 ——

test('blocked：拉黑计数 +1 并标记；撤销则清本地标记、不占额度', () => {
  const p1 = QP.planOutcome(blockJob(), { status: 'blocked' });
  assert.deepEqual(p1, { kind: 'complete', effects: { markStatus: 'blocked', bumpStats: true } });

  const p2 = QP.planOutcome(blockJob({ action: 'unblock' }), { status: 'blocked' });
  assert.deepEqual(p2, { kind: 'complete', effects: { removeMark: true } });
});

test('not_found：拉黑标记 not_found；撤销视为目标已不在黑名单', () => {
  const p1 = QP.planOutcome(blockJob(), { status: 'not_found' });
  assert.deepEqual(p1, { kind: 'complete', effects: { markStatus: 'not_found' } });

  const p2 = QP.planOutcome(blockJob({ action: 'unblock' }), { status: 'not_found' });
  assert.deepEqual(p2, { kind: 'complete', effects: { removeMark: true } });
});

test('rate_limited：放回队列并熔断 10 分钟，绝不盲目重试', () => {
  const p = QP.planOutcome(blockJob(), { status: 'rate_limited' });
  assert.equal(p.kind, 'requeue');
  assert.equal(p.pause.reason, 'rate_limit');
  assert.equal(p.pause.cooldownMs, QP.RATE_LIMIT_COOLDOWN_MS);
  assert.ok(p.attempts === undefined); // 熔断不消耗重试次数
});

test('auth_error：放回队列并等待用户恢复', () => {
  const p = QP.planOutcome(blockJob(), { status: 'auth_error' });
  assert.equal(p.kind, 'requeue');
  assert.equal(p.pause.reason, 'auth_error');
  assert.ok(p.pause.cooldownMs === undefined); // 无自动恢复时间
  assert.ok(p.pause.lastError.includes('登录'));
});

test('网络类临时失败：重试计数，达上限放弃并标记 failed', () => {
  const first = QP.planOutcome(blockJob({ attempts: 0 }), { status: 'network_error' });
  assert.deepEqual(first, { kind: 'requeue', attempts: 1 });

  const second = QP.planOutcome(blockJob({ attempts: 1 }), { status: 'failed' });
  assert.deepEqual(second, { kind: 'requeue', attempts: 2 });

  const third = QP.planOutcome(blockJob({ attempts: 2 }), { status: 'network_error' });
  assert.deepEqual(third, { kind: 'drop', markStatus: 'failed' });

  // 自定义上限
  const tight = QP.planOutcome(blockJob({ attempts: 0 }), { status: 'network_error' }, { maxAttempts: 1 });
  assert.deepEqual(tight, { kind: 'drop', markStatus: 'failed' });
});

test('决策函数不改写输入（纯函数约定）', () => {
  const job = blockJob();
  const queue = [job];
  evaluate(queue);
  assert.deepEqual(job, blockJob()); // 原对象未被标记 processing / 未被改动

  const job2 = blockJob();
  QP.planOutcome(job2, { status: 'network_error' });
  assert.equal(job2.attempts, 0); // attempts 增量由 SW 落库时写入
});

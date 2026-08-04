'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ConflictDetector } = require('../../lib/gateway/conflict-detector');
const { IdempotencyStore } = require('../../lib/gateway/idempotency-store');
const { JobManager } = require('../../lib/gateway/job-manager');
const { getToolPolicy } = require('../../lib/gateway/tool-policies');
const { LockManager } = require('../../lib/gateway/lock-manager');
const { Scheduler } = require('../../lib/gateway/scheduler');

test('conflict detector rejects stale revisions and advances after mutation', () => {
  const detector = new ConflictDetector();
  const initial = detector.snapshot('editor', 'e1', { value: 1 });
  assert.equal(initial.revision, 0);
  const next = detector.commit('editor', 'e1', { value: 2 });
  assert.equal(next.revision, 1);
  assert.equal(detector.check('editor', 'e1', 0).code, 'STALE_EDITOR_STATE');
  assert.equal(detector.check('editor', 'e1', 1), null);
});

test('idempotency store reuses one in-flight mutation and rejects key reuse', async () => {
  const store = new IdempotencyStore();
  let count = 0;
  const first = store.execute('key-1', 'same', async () => { count += 1; return { ok: true }; });
  const second = store.execute('key-1', 'same', async () => { count += 1; return { ok: true }; });
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);
  assert.equal(count, 1);
  await assert.rejects(store.execute('key-1', 'different', async () => ({})), /IDEMPOTENCY_KEY_REUSED/);
});

test('job manager tracks completion, failure, cancellation, and active count', () => {
  const jobs = new JobManager();
  const done = jobs.create({ ownerId: 'agent-a', toolName: 'build' });
  jobs.complete(done.jobId, { artifact: 'build.zip' });
  const failed = jobs.create({ ownerId: 'agent-b', toolName: 'diagnostics' });
  jobs.fail(failed.jobId, Object.assign(new Error('offline'), { code: 'EDITOR_OFFLINE' }));
  const cancelled = jobs.create({ ownerId: 'agent-c', toolName: 'preview' });
  jobs.cancel(cancelled.jobId);
  assert.equal(jobs.countActive(), 0);
  assert.equal(jobs.get(done.jobId).status, 'completed');
  assert.equal(jobs.get(failed.jobId).error.code, 'EDITOR_OFFLINE');
  assert.equal(jobs.get(cancelled.jobId).status, 'cancelled');
});

test('tool policies default unknown mutations to exclusive editor/project resources', () => {
  const read = getToolPolicy('get_hierarchy', { targetId: 'e1', projectId: 'p1' });
  const script = getToolPolicy('execute_javascript', { targetId: 'e1', projectId: 'p1' });
  const unknown = getToolPolicy('future_mutating_tool', { targetId: 'e1', projectId: 'p1' });
  assert.equal(read.access, 'read');
  assert.equal(script.access, 'exclusive');
  assert.equal(unknown.access, 'write');
  assert.ok(script.resources.some((resource) => resource.name === 'editor:e1' && resource.mode === 'exclusive'));
});

test('scheduler cancellation rejects the request and releases its lease', async () => {
  const lockManager = new LockManager({ watchdogIntervalMs: 20 });
  const scheduler = new Scheduler({ lockManager, defaultTimeoutMs: 1000 });
  let cancelSent = 0;
  try {
    const running = scheduler.run({
      requestId: 'cancel-me',
      ownerId: 'agent-cancel',
      toolName: 'future_mutating_tool',
      arguments: { targetId: 'e1', projectId: 'p1' },
      policy: { ...getToolPolicy('future_mutating_tool', { targetId: 'e1', projectId: 'p1' }), timeoutMs: 1000 },
      execute: () => new Promise(() => {}),
      onCancel: async () => { cancelSent += 1; },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scheduler.cancel('cancel-me'), true);
    await assert.rejects(running, (error) => error.code === 'REQUEST_CANCELLED');
    assert.equal(cancelSent, 1);
    assert.equal(lockManager.status().leases.length, 0);
  } finally {
    lockManager.close();
  }
});

test('scheduler timeout rejects an Editor request and releases its lease', async () => {
  const lockManager = new LockManager({ watchdogIntervalMs: 20 });
  const scheduler = new Scheduler({ lockManager, defaultTimeoutMs: 25 });
  try {
    const running = scheduler.run({
      requestId: 'timeout-me',
      ownerId: 'agent-timeout',
      toolName: 'future_mutating_tool',
      arguments: { targetId: 'e1', projectId: 'p1' },
      policy: { ...getToolPolicy('future_mutating_tool', { targetId: 'e1', projectId: 'p1' }), timeoutMs: 25 },
      execute: () => new Promise(() => {}),
    });
    await assert.rejects(running, (error) => error.code === 'REQUEST_TIMEOUT');
    assert.equal(lockManager.status().leases.length, 0);
  } finally {
    lockManager.close();
  }
});

test('scheduler timeout removes a request that is waiting for a held lock', async () => {
  const lockManager = new LockManager({ watchdogIntervalMs: 20 });
  const scheduler = new Scheduler({ lockManager, defaultTimeoutMs: 20 });
  const holder = await lockManager.acquire([{ name: 'editor:e1', mode: 'write' }], { ownerId: 'holder' });
  try {
    const waiting = scheduler.run({
      requestId: 'wait-timeout',
      ownerId: 'agent-wait',
      toolName: 'future_mutating_tool',
      arguments: { targetId: 'e1', projectId: 'p1' },
      policy: { ...getToolPolicy('future_mutating_tool', { targetId: 'e1', projectId: 'p1' }), resources: [{ name: 'editor:e1', mode: 'write' }], timeoutMs: 20 },
      execute: async () => ({ ok: true }),
    });
    await assert.rejects(waiting, (error) => error.code === 'REQUEST_TIMEOUT');
    assert.equal(lockManager.status().waiting.length, 0);
  } finally {
    holder.release();
    lockManager.close();
  }
});

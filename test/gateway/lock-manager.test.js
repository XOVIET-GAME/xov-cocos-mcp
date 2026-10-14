'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { LockManager } = require('../../lib/gateway/lock-manager');

test('multi-resource acquisition is atomic and sorted by fixed resource order', async () => {
  const manager = new LockManager({ defaultTimeoutMs: 50 });
  try {
    const first = await manager.acquire([
      { name: 'file:a', mode: 'write' },
      { name: 'project:p', mode: 'write' },
    ], { ownerId: 'a', leaseMs: 10000 });
    const pending = manager.acquire([
      { name: 'project:p', mode: 'write' },
      { name: 'file:b', mode: 'write' },
    ], { ownerId: 'b', timeoutMs: 20 });
    await assert.rejects(pending, (error) => error.code === 'LOCK_TIMEOUT');
    first.release();
    const next = await manager.acquire(['project:p'], { ownerId: 'c', timeoutMs: 20 });
    assert.ok(next.leaseId);
    next.release();
  } finally {
    manager.close();
  }
});

test('read locks share, write locks serialize, and disconnect releases all leases', async () => {
  const manager = new LockManager({ watchdogIntervalMs: 5, defaultTimeoutMs: 100 });
  try {
    const a = await manager.acquire([{ name: 'editor:e', mode: 'read' }], { ownerId: 'a' });
    const b = await manager.acquire([{ name: 'editor:e', mode: 'read' }], { ownerId: 'b' });
    const waiting = manager.acquire([{ name: 'editor:e', mode: 'write' }], { ownerId: 'c', timeoutMs: 100 });
    assert.equal(manager.releaseOwner('a'), 1);
    b.release();
    const c = await waiting;
    assert.equal(c.ownerId, 'c');
    c.release();
  } finally {
    manager.close();
  }
});

test('expired lease is reclaimed by watchdog', async () => {
  const manager = new LockManager({ watchdogIntervalMs: 5 });
  try {
    const lease = await manager.acquire(['preview:e'], { ownerId: 'dead', leaseMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(manager.status().leases.length, 0);
    assert.equal(lease.released, true);
  } finally {
    manager.close();
  }
});

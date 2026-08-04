'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SessionRegistry } = require('../../lib/gateway/session-registry');

test('agent sessions isolate pinned targets, requests, and cancellation state', () => {
  const registry = new SessionRegistry();
  const a = registry.create({ sessionId: 'session-a', agentId: 'agent-a' });
  const b = registry.create({ sessionId: 'session-b', agentId: 'agent-b' });
  registry.pin(a.sessionId, 'editor-a');
  registry.addRequest(a.sessionId, 'req-a', { targetId: 'editor-a' });
  registry.cancel(a.sessionId, 'req-a');
  assert.equal(registry.get('session-a').pinnedTargetId, 'editor-a');
  assert.equal(registry.get('session-b').pinnedTargetId, '');
  assert.equal(registry.isCancelled('session-a', 'req-a'), true);
  assert.equal(registry.isCancelled('session-b', 'req-a'), false);
  assert.equal(registry.activeRequestCount(), 1);
  registry.removeRequest(a.sessionId, 'req-a');
  registry.disconnect(b.sessionId);
  assert.equal(registry.get('session-b').connected, false);
});

test('stale idle agent sessions are removed while active requests are retained', () => {
  const registry = new SessionRegistry({ ttlMs: 10, scanIntervalMs: 1000 });
  const stale = registry.create({ sessionId: 'stale-agent' });
  stale.lastSeenAt = new Date(Date.now() - 100).toISOString();
  const active = registry.create({ sessionId: 'active-agent' });
  active.lastSeenAt = stale.lastSeenAt;
  registry.addRequest(active.sessionId, 'request-1');
  assert.deepEqual(registry.removeStale(), [stale]);
  assert.ok(registry.get(active.sessionId));
  registry.stop();
});

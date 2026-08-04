'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TargetRegistry } = require('../../lib/gateway/target-registry');

function makeInstance(overrides = {}) {
  return {
    editorInstanceId: overrides.editorInstanceId || 'editor-1',
    projectId: overrides.projectId || 'project-1',
    connectionId: overrides.connectionId || 'conn-1',
    generation: overrides.generation || 'gen-1',
    ...overrides,
  };
}

test('register stores an online instance with stable identity', () => {
  const registry = new TargetRegistry();
  const instance = registry.register(makeInstance());

  assert.equal(registry.count(), 1);
  assert.equal(instance.status, 'online');
  assert.equal(instance.targetId, 'editor-1');
  assert.equal(instance.lastSeenAt, instance.registeredAt);
  assert.deepEqual(instance.capabilities, []);
});

test('register requires editorInstanceId and projectId', () => {
  const registry = new TargetRegistry();
  assert.throws(() => registry.register({ projectId: 'p' }), /editorInstanceId/);
  assert.throws(() => registry.register({ editorInstanceId: 'e' }), /projectId/);
});

test('heartbeat refreshes lastSeenAt and restores online status', () => {
  const registry = new TargetRegistry();
  registry.register(makeInstance());
  const instance = registry.get('editor-1');
  const original = new Date(instance.lastSeenAt).getTime();
  instance.lastSeenAt = new Date(original - 5000).toISOString();

  const refreshed = registry.heartbeat('editor-1');
  assert.equal(refreshed.status, 'online');
  assert.ok(new Date(refreshed.lastSeenAt).getTime() > original - 5000);
});

test('heartbeat for an unknown instance returns null', () => {
  const registry = new TargetRegistry();
  assert.equal(registry.heartbeat('nope'), null);
});

test('unregister removes an instance and returns it', () => {
  const registry = new TargetRegistry();
  registry.register(makeInstance());
  const removed = registry.unregister('editor-1');

  assert.equal(removed.editorInstanceId, 'editor-1');
  assert.equal(registry.count(), 0);
  assert.equal(registry.unregister('editor-1'), null);
});

test('re-register reuses a previous primary-writer role', () => {
  const registry = new TargetRegistry();
  registry.register(makeInstance());
  registry.get('editor-1').role = 'primary-writer';

  const again = registry.register(makeInstance({ connectionId: 'conn-2' }));
  assert.equal(again.role, 'primary-writer');
  assert.equal(again.connectionId, 'conn-2');
});

test('first target becomes project primary and later target is read-only', () => {
  const registry = new TargetRegistry();
  const first = registry.register({ editorInstanceId: 'editor-a', projectId: 'project-shared', connectionId: 'conn-a' });
  const second = registry.register({ editorInstanceId: 'editor-b', projectId: 'project-shared', connectionId: 'conn-b' });
  assert.equal(first.role, 'primary-writer');
  assert.equal(second.role, 'read-only');
  assert.equal(registry.getByTargetId('editor-b').editorInstanceId, 'editor-b');
  registry.claimPrimaryWriter('editor-b');
  assert.equal(registry.get('editor-a').role, 'read-only');
  assert.equal(registry.get('editor-b').role, 'primary-writer');
});

test('removing a primary promotes the next online target for the project', () => {
  const registry = new TargetRegistry({ staleScanIntervalMs: 1000 });
  registry.register(makeInstance({ editorInstanceId: 'editor-primary', projectId: 'project-failover' }));
  registry.register(makeInstance({ editorInstanceId: 'editor-failover', projectId: 'project-failover' }));
  assert.equal(registry.get('editor-failover').role, 'read-only');
  registry.unregister('editor-primary');
  assert.equal(registry.get('editor-failover').role, 'primary-writer');
  registry.stop();
});

test('offline primary promotes the next online target without waiting for TTL', () => {
  const registry = new TargetRegistry({ staleScanIntervalMs: 1000 });
  registry.register(makeInstance({ editorInstanceId: 'editor-primary-offline', projectId: 'project-offline-failover' }));
  registry.register(makeInstance({ editorInstanceId: 'editor-second-offline', projectId: 'project-offline-failover' }));
  registry.markOffline('editor-primary-offline');
  assert.equal(registry.get('editor-second-offline').role, 'primary-writer');
  registry.stop();
});

test('generation mismatch cannot mark a newer connection online', () => {
  const registry = new TargetRegistry();
  registry.register({ editorInstanceId: 'editor-a', projectId: 'project-a', connectionId: 'conn-a', generation: 'new' });
  assert.equal(registry.heartbeat('editor-a', 'old'), null);
  assert.equal(registry.get('editor-a').status, 'online');
});

test('removeStaleInstances removes expired heartbeats and preserves fresh ones', () => {
  const registry = new TargetRegistry({ ttlMs: 100 });
  registry.register(makeInstance({ editorInstanceId: 'stale-1' }));
  registry.register(makeInstance({ editorInstanceId: 'fresh-1' }));

  const stale = registry.get('stale-1');
  stale.lastSeenAt = new Date(Date.now() - 5000).toISOString();

  const removed = registry.removeStaleInstances();
  assert.equal(removed.length, 1);
  assert.equal(removed[0].editorInstanceId, 'stale-1');
  assert.equal(registry.count(), 1);
  assert.equal(registry.get('fresh-1').status, 'online');
});

test('isStale applies the TTL', () => {
  const registry = new TargetRegistry({ ttlMs: 1000 });
  registry.register(makeInstance());
  const instance = registry.get('editor-1');

  assert.equal(registry.isStale(instance, Date.now() + 500), false);
  assert.equal(registry.isStale(instance, Date.now() + 2000), true);
});

test('start and stop manage the periodic stale scan', async () => {
  const registry = new TargetRegistry({ ttlMs: 50, staleScanIntervalMs: 20 });
  registry.register(makeInstance({ editorInstanceId: 'stale-1' }));
  registry.get('stale-1').lastSeenAt = new Date(Date.now() - 10000).toISOString();
  registry.start();

  await new Promise((resolve) => setTimeout(resolve, 120));
  registry.stop();
  assert.equal(registry.count(), 0);
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TargetRegistry } = require('../../lib/gateway/target-registry');
const { LifecycleManager } = require('../../lib/gateway/lifecycle-manager');

function createManager(overrides = {}) {
  const registry = overrides.registry || new TargetRegistry();
  const autoStops = [];
  const manager = new LifecycleManager({
    registry,
    ownership: overrides.ownership !== undefined
      ? overrides.ownership
      : { ownerExtensionId: 'ext', ownerInstanceId: 'ext-1', launchNonce: 'nonce', autoStartedByExtension: true },
    autoStopWhenIdle: overrides.autoStopWhenIdle !== undefined ? overrides.autoStopWhenIdle : true,
    requestCounter: overrides.requestCounter || (() => 0),
    logger: { log() {} },
    onAutoStop: async (reason) => {
      autoStops.push(reason);
    },
  });
  return { registry, manager, autoStops };
}

test('a manually started Gateway is never auto-stopped', async () => {
  const { registry, manager, autoStops } = createManager({
    ownership: { ownerExtensionId: '', ownerInstanceId: '', launchNonce: '', autoStartedByExtension: false },
  });

  assert.equal(manager.shouldAutoStop(), false);
  await manager.maybeAutoStop('test');
  assert.deepEqual(autoStops, []);
  registry.stop();
});

test('auto-stop requires an owner-started Gateway with idle policy enabled', async () => {
  const { registry, manager, autoStops } = createManager({});
  assert.equal(manager.shouldAutoStop(), true);
  await manager.maybeAutoStop('test');
  assert.deepEqual(autoStops, ['test']);
  registry.stop();
});

test('auto-stop is disabled when autoStopWhenIdle is false', async () => {
  const { registry, manager, autoStops } = createManager({ autoStopWhenIdle: false });
  assert.equal(manager.shouldAutoStop(), false);
  await manager.maybeAutoStop('test');
  assert.deepEqual(autoStops, []);
  registry.stop();
});

test('a registered instance prevents idle auto-stop', async () => {
  const { registry, manager, autoStops } = createManager({});
  registry.register({
    editorInstanceId: 'editor-1',
    projectId: 'project-1',
    connectionId: 'conn-1',
  });

  assert.equal(manager.shouldAutoStop(), false);
  await manager.maybeAutoStop('test');
  assert.deepEqual(autoStops, []);
  registry.stop();
});

test('active requests prevent idle auto-stop', async () => {
  const { registry, manager, autoStops } = createManager({ requestCounter: () => 2 });
  assert.equal(manager.shouldAutoStop(), false);
  await manager.maybeAutoStop('test');
  assert.deepEqual(autoStops, []);
  registry.stop();
});

test('activeWorkload reports instance, session, job and request counts', () => {
  const { registry, manager } = createManager({});
  registry.register({
    editorInstanceId: 'editor-1',
    projectId: 'project-1',
    connectionId: 'conn-1',
  });
  const workload = manager.activeWorkload();
  assert.equal(workload.instances, 1);
  assert.equal(workload.sessions, 0);
  assert.equal(workload.jobs, 0);
  assert.equal(workload.activeRequests, 0);
  registry.stop();
});

test('summarize includes ownership and canAutoStop', () => {
  const { registry, manager } = createManager({});
  const summary = manager.summarize();
  assert.equal(summary.ownership.ownerExtensionId, 'ext');
  assert.equal(summary.autoStopWhenIdle, true);
  assert.equal(summary.canAutoStop, true);
  registry.stop();
});

test('non-owner-started Gateways remain alive even when idle', async () => {
  const { registry, manager, autoStops } = createManager({
    ownership: { ownerExtensionId: '', ownerInstanceId: '', launchNonce: '', autoStartedByExtension: false },
  });
  assert.equal(manager.shouldAutoStop(), false);
  await manager.maybeAutoStop('test');
  assert.deepEqual(autoStops, []);
  registry.stop();
});

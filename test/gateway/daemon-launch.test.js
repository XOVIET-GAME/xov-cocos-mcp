'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { GatewayClient } = require('../../lib/extension/gateway-client');
const { createHttpControlTransport } = require('../../lib/gateway/transport');
const { readState, getStatePath } = require('../../lib/gateway/process-manager');

const DAEMON_ENTRY = path.resolve(__dirname, '..', '..', 'lib', 'gateway', 'daemon-entry.js');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-gw-daemon-test-'));
}

function silentLogger() {
  return { log() {}, info() {}, warn() {}, error() {} };
}

async function findFreePort() {
  const net = require('node:net');
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

test('client launches a detached Gateway daemon and registers against it', async () => {
  const dir = createTempDir();
  const port = await findFreePort();
  const gatewayUrl = 'http://127.0.0.1:' + port;
  const client = new GatewayClient({
    gatewayUrl,
    ownershipDir: dir,
    entryPoint: DAEMON_ENTRY,
    transport: createHttpControlTransport(),
    logger: silentLogger(),
    editorInstanceId: 'editor-e2e',
    projectId: 'project-e2e',
    heartbeatIntervalMs: 200,
    reconnectBaseDelayMs: 30,
    reconnectMaxDelayMs: 120,
  });
  try {
    const state = await client.ensure();
    assert.equal(state.connected, true);
    assert.equal(state.registered, true);

    // The daemon wrote an ownership state file with our extension identity.
    const stateFile = readState(dir);
    assert.ok(stateFile);
    assert.equal(stateFile.ownerExtensionId, 'funplay-cocos-mcp');
    assert.ok(stateFile.pid);
    if (process.platform !== 'win32') {
      const stat = fs.statSync(getStatePath(dir));
      assert.equal((stat.mode & 0o777).toString(8), '600');
    }

    // Health through the transport abstraction reports the daemon.
    const health = await client.transport.health(gatewayUrl);
    assert.equal(health.ok, true);
    assert.equal(health.kind, 'cocos-gateway');
    assert.equal(health.instances, 1);

    // A second client connecting to the same live Gateway does NOT launch
    // another daemon (the process single-flight behavior).
    const second = new GatewayClient({
      gatewayUrl,
      ownershipDir: dir,
      entryPoint: DAEMON_ENTRY,
      transport: createHttpControlTransport(),
      logger: silentLogger(),
      editorInstanceId: 'editor-e2e-2',
      projectId: 'project-e2e-2',
      heartbeatIntervalMs: 500,
    });
    const secondState = await second.ensure();
    assert.equal(secondState.connected, true);
    assert.equal(health.instances, 1);
    await second.close();

    // Ownership-aware idle auto-stop: the daemon was launched by this
    // extension (owner-started, autoStopWhenIdle default true). When the last
    // instance unregisters, the daemon should stop itself.
    const daemonPid = stateFile.pid;
    await client.unregister('last-editor-closing');
    await waitForProcessExit(daemonPid, 3000);
    const healthAfter = await client.transport.health(gatewayUrl);
    assert.equal(healthAfter, null);
  } finally {
    await client.close();
    // The daemon is detached; stop it via the health process if still alive.
    const stateFile = readState(dir);
    if (stateFile && stateFile.pid) {
      try {
        process.kill(stateFile.pid, 'SIGTERM');
      } catch (error) {
        // Already gone.
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function waitForProcessExit(pid, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = () => {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (error) {
        alive = false;
      }
      if (!alive) {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

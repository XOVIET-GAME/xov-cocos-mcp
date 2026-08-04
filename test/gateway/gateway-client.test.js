'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { GatewayServer } = require('../../lib/gateway/gateway-server');
const { GatewayClient, isCompatibleGatewayHealth } = require('../../lib/extension/gateway-client');
const { createHttpControlTransport } = require('../../lib/gateway/transport');
const { TargetRegistry } = require('../../lib/gateway/target-registry');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-gw-client-test-'));
}

function silentLogger() {
  return { log() {}, info() {}, warn() {}, error() {} };
}

async function createGateway(ownershipDir) {
  const server = new GatewayServer({
    host: '127.0.0.1',
    port: 0,
    ownershipDir,
    ownershipOverride: {
      ownerExtensionId: 'ext-client-test',
      ownerInstanceId: 'ext-client-instance',
      launchNonce: 'nonce-client',
      autoStartedByExtension: true,
    },
    registry: new TargetRegistry({ ttlMs: 2000, staleScanIntervalMs: 200 }),
    logger: silentLogger(),
    autoStopWhenIdle: true,
  });
  await server.start();
  return server;
}

function createClient(server, overrides = {}) {
  const gatewayUrl = 'http://127.0.0.1:' + server.getPort();
  const client = new GatewayClient({
    gatewayUrl,
    ownershipDir: server.ownershipDir,
    transport: createHttpControlTransport(),
    ownerExtensionId: 'ext-client-test',
    editorInstanceId: overrides.editorInstanceId || 'editor-client-1',
    projectId: overrides.projectId || 'project-client-1',
    logger: silentLogger(),
    autoStart: overrides.autoStart !== undefined ? overrides.autoStart : true,
    heartbeatIntervalMs: overrides.heartbeatIntervalMs || 60,
    reconnectBaseDelayMs: overrides.reconnectBaseDelayMs || 20,
    reconnectMaxDelayMs: overrides.reconnectMaxDelayMs || 80,
    ...overrides,
  });
  return client;
}

test('client health gate requires the Gateway control protocol and version', () => {
  const healthy = { ok: true, kind: 'cocos-gateway', protocolName: 'cocos-gateway-control', protocolVersion: '0.1.0' };
  assert.equal(isCompatibleGatewayHealth(healthy), true);
  assert.equal(isCompatibleGatewayHealth({ ...healthy, protocolName: 'other' }), false);
  assert.equal(isCompatibleGatewayHealth({ ...healthy, protocolVersion: '9.0.0' }), false);
});

test('client registers and reports the control connection state', async () => {
  const dir = createTempDir();
  const server = await createGateway(dir);
  const client = createClient(server);
  try {
    const state = await client.ensure();
    assert.equal(state.connected, true);
    assert.equal(state.registered, true);
    assert.ok(state.connectionId);
    assert.equal(state.editorInstanceId, 'editor-client-1');
    assert.equal(server.registry.count(), 1);
  } finally {
    await client.close();
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('client unregister removes the instance from the Gateway registry', async () => {
  const dir = createTempDir();
  const server = await createGateway(dir);
  const client = createClient(server);
  try {
    await client.ensure();
    assert.equal(server.registry.count(), 1);
    const result = await client.unregister('editor-shutdown');
    assert.equal(result.ok, true);
    assert.equal(server.registry.count(), 0);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('connecting to an already-live Gateway does not launch a new process', async () => {
  const dir = createTempDir();
  const server = await createGateway(dir);
  let launchCount = 0;
  const client = new GatewayClient({
    gatewayUrl: 'http://127.0.0.1:' + server.getPort(),
    ownershipDir: dir,
    transport: createHttpControlTransport(),
    logger: silentLogger(),
    autoStart: true,
    editorInstanceId: 'editor-no-launch',
    projectId: 'project-no-launch',
    launchDetached: async () => {
      launchCount += 1;
      return { pid: 99999, launchNonce: 'should-not-happen' };
    },
  });
  try {
    await client.ensure();
    assert.equal(launchCount, 0);
  } finally {
    await client.close();
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('single-flight: concurrent ensure calls produce one registration', async () => {
  const dir = createTempDir();
  const server = await createGateway(dir);
  const client = createClient(server);
  try {
    const results = await Promise.all([client.ensure(), client.ensure(), client.ensure()]);
    assert.equal(results.length, 3);
    assert.equal(server.registry.count(), 1);
    assert.equal(client.state.registered, true);
  } finally {
    await client.close();
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('client refuses to launch when the Gateway port is occupied by a foreign process', async () => {
  const dir = createTempDir();
  const http = require('node:http');
  const foreign = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve));
  const foreignPort = foreign.address().port;
  const client = new GatewayClient({
    gatewayUrl: 'http://127.0.0.1:' + foreignPort,
    ownershipDir: dir,
    transport: createHttpControlTransport(),
    logger: silentLogger(),
    autoStart: true,
    launchTimeoutMs: 1000,
  });
  try {
    await assert.rejects(() => client.ensure(), /GATEWAY_PORT_CONFLICT|occupied/);
  } finally {
    await new Promise((resolve) => foreign.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('heartbeat failures trigger reconnect and re-registration', async () => {
  const dir = createTempDir();
  let server = await createGateway(dir);
  const client = createClient(server);
  try {
    await client.ensure();
    assert.equal(server.registry.count(), 1);

    // Simulate channel loss by restarting the Gateway. The next heartbeat
    // fails and the client reconnects + re-registers against the new server.
    const oldPort = server.getPort();
    await server.stop();
    const ownership = {
      ownerExtensionId: 'ext-client-test',
      ownerInstanceId: 'ext-client-instance',
      launchNonce: 'nonce-client-2',
      autoStartedByExtension: true,
    };
    const restarted = new GatewayServer({
      host: '127.0.0.1',
      port: oldPort,
      ownershipDir: dir,
      ownershipOverride: ownership,
      registry: new TargetRegistry({ ttlMs: 2000, staleScanIntervalMs: 200 }),
      logger: silentLogger(),
      autoStopWhenIdle: true,
    });
    await restarted.start();
    server = restarted;

    // Wait for the client to reconnect (exponential backoff up to 80ms).
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(server.registry.count(), 1);
    assert.equal(client.state.connected, true);
    assert.equal(client.state.registered, true);
  } finally {
    await client.close();
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

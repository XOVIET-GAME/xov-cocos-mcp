'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { GatewayServer } = require('../../lib/gateway/gateway-server');
const { GatewayClient } = require('../../lib/extension/gateway-client');
const { createWebSocketControlTransport } = require('../../lib/gateway/transport');
const { safeEqualToken } = require('../../lib/gateway/auth');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-ws-control-test-'));
}

function logger() {
  return { log() {}, info() {}, warn() {}, error() {} };
}

function openWebSocket(url, protocols) {
  return new Promise((resolve, reject) => {
    const socket = new globalThis.WebSocket(url, protocols);
    const timeout = setTimeout(() => reject(new Error('WebSocket handshake timed out.')), 3000);
    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve(socket);
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('WebSocket handshake rejected.'));
    }, { once: true });
  });
}

function rawHandshake(port, host, origin) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('WebSocket handshake timed out.')));
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write([
        'GET /control HTTP/1.1',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Host: ' + host,
        ...(origin ? ['Origin: ' + origin] : []),
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(response.split('\r\n', 1)[0]);
      }
    });
  });
}

test('safeEqualToken compares equal, unequal, and different length values safely', () => {
  assert.equal(safeEqualToken('same', 'same'), true);
  assert.equal(safeEqualToken('same', 'else'), false);
  assert.equal(safeEqualToken('short', 'much-longer'), false);
});

const hasWebSocket = typeof globalThis.WebSocket === 'function';

test('WebSocket control channel registers an extension and forwards a command', {
  skip: !hasWebSocket,
}, async () => {
  const ownershipDir = tempDir();
  const server = new GatewayServer({
    host: '127.0.0.1',
    port: 0,
    ownershipDir,
    ownershipOverride: {
      ownerExtensionId: 'ws-test-extension',
      ownerInstanceId: 'ws-test-owner',
      launchNonce: 'ws-test-nonce',
      autoStartedByExtension: true,
    },
    autoStopWhenIdle: false,
    logger: logger(),
  });
  const transport = createWebSocketControlTransport({ WebSocket: globalThis.WebSocket });
  const client = new GatewayClient({
    gatewayUrl: 'http://127.0.0.1:0',
    ownershipDir,
    transport,
    autoStart: false,
    ownerExtensionId: 'ws-test-extension',
    editorInstanceId: 'ws-editor-1',
    projectId: 'ws-project-1',
    logger: logger(),
    onCommandRequest: async (message) => ({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        requestId: message.params.requestId,
        value: { received: message.params.tool.name },
      },
    }),
  });

  try {
    await server.start();
    client.gatewayUrl = 'http://127.0.0.1:' + server.getPort();
    await client.ensure();
    assert.equal(server.registry.count(), 1);
    assert.equal(server.registry.get('ws-editor-1').status, 'online');

    const result = await server.dispatchMcpToolCall({
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: { name: 'probe_tool', arguments: {} },
    }, { sessionId: 'agent-ws-1', agentId: 'agent-ws-1' });
    assert.equal(result.id, 41);
    assert.equal(result.result.structuredContent.received, 'probe_tool');
  } finally {
    await client.close();
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('WebSocket control channel requires the Gateway token for remote binding', {
  skip: !hasWebSocket,
}, async () => {
  const ownershipDir = tempDir();
  const server = new GatewayServer({
    host: '127.0.0.1',
    port: 0,
    authToken: 'ws-secret',
    ownershipDir,
    ownershipOverride: { ownerExtensionId: 'ws-test', ownerInstanceId: 'ws-owner', autoStartedByExtension: true },
    autoStopWhenIdle: false,
    logger: logger(),
  });
  try {
    await server.start();
    const endpoint = 'ws://127.0.0.1:' + server.getPort() + '/control';
    const authenticatedSocket = await openWebSocket(endpoint, ['bearer.ws-secret']);
    assert.equal(authenticatedSocket.protocol, 'bearer.ws-secret');
    authenticatedSocket.close();
    await assert.rejects(openWebSocket(endpoint, ['bearer.wrong-secret']), /rejected/);
    await assert.rejects(openWebSocket(endpoint + '?token=ws-secret'), /rejected/);
    const client = new GatewayClient({
      gatewayUrl: 'http://127.0.0.1:' + server.getPort(),
      ownershipDir,
      transport: createWebSocketControlTransport({ WebSocket: globalThis.WebSocket }),
      authToken: 'ws-secret',
      autoStart: false,
      editorInstanceId: 'ws-auth-editor',
      projectId: 'ws-auth-project',
      logger: logger(),
    });
    try {
      await client.ensure();
      assert.equal(server.registry.count(), 1);
    } finally {
      await client.close();
    }
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('loopback WebSocket upgrade rejects hostile Host and Origin and permits loopback origin', async () => {
  const ownershipDir = tempDir();
  const server = new GatewayServer({
    host: '127.0.0.1',
    port: 0,
    ownershipDir,
    autoStopWhenIdle: false,
    logger: logger(),
  });
  try {
    await server.start();
    const port = server.getPort();
    assert.match(await rawHandshake(port, 'attacker.example:' + port), /^HTTP\/1\.1 403/);
    assert.match(await rawHandshake(port, '127.0.0.1:' + port, 'https://attacker.example'), /^HTTP\/1\.1 403/);
    assert.match(await rawHandshake(port, 'localhost:' + port, 'http://localhost:3000'), /^HTTP\/1\.1 101/);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

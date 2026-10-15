'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { GatewayServer } = require('../../lib/gateway/gateway-server');
const { GatewayClient } = require('../../lib/extension/gateway-client');
const { createWebSocketControlTransport } = require('../../lib/gateway/transport');
const { attachControlWebSocketServer } = require('../../lib/gateway/control-websocket');
const { NodeWebSocket } = require('../../lib/gateway/ws-client');
const { decodeFrame, encodeFrame } = require('../../lib/gateway/ws-frames');

function once(target, name, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for ' + name)), timeoutMs);
    target.addEventListener(name, (event) => {
      clearTimeout(timer);
      resolve(event);
    }, { once: true });
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function echoServer({ authToken = '', onConnection } = {}) {
  const server = http.createServer();
  const attached = attachControlWebSocketServer(server, {
    authToken,
    onConnection: onConnection || ((connection, message) => connection.send(message)),
  });
  return { server, attached };
}

function logger() {
  return { log() {}, info() {}, warn() {}, error() {} };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-ws-client-test-'));
}

function connect(port, token) {
  const socket = new NodeWebSocket('ws://127.0.0.1:' + port + '/control', token ? ['bearer.' + token] : undefined);
  const opened = once(socket, 'open');
  return { socket, opened };
}

async function closeServer(server, attached) {
  attached.close();
  await new Promise((resolve) => server.close(resolve));
}

test('Node WebSocket client negotiates bearer subprotocol and rejects a bad token', async () => {
  const { server, attached } = echoServer({ authToken: 'client-secret' });
  const port = await listen(server);
  try {
    const { socket, opened } = connect(port, 'client-secret');
    await opened;
    assert.equal(socket.protocol, 'bearer.client-secret');
    const closed = once(socket, 'close');
    socket.close();
    await closed;

    const badSocket = new NodeWebSocket('ws://127.0.0.1:' + port + '/control', ['bearer.wrong-secret']);
    const error = once(badSocket, 'error');
    await error;
    assert.equal(badSocket.readyState, NodeWebSocket.CLOSED);
  } finally {
    await closeServer(server, attached);
  }
});

test('Node WebSocket client sends and receives payload lengths across RFC frame boundaries', async () => {
  const { server, attached } = echoServer();
  const port = await listen(server);
  try {
    const { socket, opened } = connect(port);
    await opened;
    for (const size of [0, 125, 126, 65535, 65536, 65537]) {
      const value = 'x'.repeat(size);
      const payload = JSON.stringify(value);
      assert.equal(Buffer.byteLength(payload), size + 2);
      const received = once(socket, 'message', 5000);
      socket.send(payload);
      assert.equal((await received).data, payload);
    }
    const closed = once(socket, 'close');
    socket.close();
    await closed;
  } finally {
    await closeServer(server, attached);
  }
});

test('Node WebSocket client answers ping with pong', async () => {
  let serverConnection;
  const { server, attached } = echoServer({ onConnection(connection, message) {
    if (message && message.type === 'ready-for-ping') serverConnection = connection;
    connection.send(message);
  } });
  const port = await listen(server);
  try {
    const { socket, opened } = connect(port);
    await opened;
    const reply = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'ready-for-ping' }));
    await reply;
    assert.ok(serverConnection);
    let pongSeen = false;
    const originalConsume = serverConnection.consume.bind(serverConnection);
    serverConnection.consume = (chunk) => {
      const parsed = decodeFrame(chunk, { expectMasked: true });
      if (parsed && parsed.opcode === 0xA && parsed.payload.toString() === 'probe') pongSeen = true;
      originalConsume(chunk);
    };
    const pingEvent = once(socket, 'ping');
    serverConnection.socket.write(encodeFrame(0x9, Buffer.from('probe')));
    assert.equal((await pingEvent).data.toString(), 'probe');
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (pongSeen) return resolve();
        if (Date.now() - start > 1000) return reject(new Error('Pong was not observed.'));
        setTimeout(check, 10);
      };
      check();
    });
    const closed = once(socket, 'close');
    socket.close();
    await closed;
  } finally {
    await closeServer(server, attached);
  }
});

test('close handshake initiated by either side fires one client close event', async () => {
  const { server, attached } = echoServer({ onConnection(connection, message) {
    if (message && message.type === 'close-from-server') {
      const closePayload = Buffer.alloc(2);
      closePayload.writeUInt16BE(1000, 0);
      connection.socket.write(encodeFrame(0x8, closePayload));
    } else connection.send(message);
  } });
  const port = await listen(server);
  try {
    const first = connect(port);
    await first.opened;
    let firstCloses = 0;
    first.socket.addEventListener('close', () => { firstCloses += 1; });
    const firstClosed = once(first.socket, 'close');
    first.socket.send(JSON.stringify({ type: 'close-from-server' }));
    await firstClosed;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(firstCloses, 1);

    const second = connect(port);
    await second.opened;
    let secondCloses = 0;
    second.socket.addEventListener('close', () => { secondCloses += 1; });
    const secondClosed = once(second.socket, 'close');
    second.socket.close(1000, 'client done');
    await secondClosed;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(secondCloses, 1);
  } finally {
    await closeServer(server, attached);
  }
});

test('abrupt socket destruction emits close once', async () => {
  const { server, attached } = echoServer();
  const port = await listen(server);
  try {
    const { socket, opened } = connect(port);
    await opened;
    let closes = 0;
    socket.addEventListener('close', () => { closes += 1; });
    const closed = once(socket, 'close');
    for (const connection of attached.connections) connection.socket.destroy();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closes, 1);
  } finally {
    await closeServer(server, attached);
  }
});

test('Node WebSocket control transport forwards tools/call through GatewayServer', async () => {
  const ownershipDir = tempDir();
  const server = new GatewayServer({
    host: '127.0.0.1',
    port: 0,
    ownershipDir,
    ownershipOverride: {
      ownerExtensionId: 'ws-node-test',
      ownerInstanceId: 'ws-node-owner',
      launchNonce: 'ws-node-nonce',
      autoStartedByExtension: true,
    },
    autoStopWhenIdle: false,
    logger: logger(),
  });
  const transport = createWebSocketControlTransport({ WebSocket: NodeWebSocket });
  const client = new GatewayClient({
    gatewayUrl: 'http://127.0.0.1:0',
    ownershipDir,
    transport,
    autoStart: false,
    ownerExtensionId: 'ws-node-test',
    editorInstanceId: 'ws-node-editor',
    projectId: 'ws-node-project',
    logger: logger(),
    onCommandRequest: async (message) => ({
      jsonrpc: '2.0',
      id: message.id,
      result: { requestId: message.params.requestId, value: { received: message.params.tool.name } },
    }),
  });
  try {
    await server.start();
    client.gatewayUrl = 'http://127.0.0.1:' + server.getPort();
    await client.ensure();
    const result = await server.dispatchMcpToolCall({
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: { name: 'probe_tool', arguments: {} },
    }, { sessionId: 'agent-ws-node-1', agentId: 'agent-ws-node-1' });
    assert.equal(result.id, 41);
    assert.equal(result.result.structuredContent.received, 'probe_tool');
  } finally {
    await client.close();
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});


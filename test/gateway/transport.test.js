'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createHttpControlTransport,
  createWebSocketControlTransport,
  parseGatewayUrl,
  classifyMessage,
} = require('../../lib/gateway/transport');

test('parseGatewayUrl extracts hostname and port', () => {
  assert.deepEqual(parseGatewayUrl('http://127.0.0.1:8787'), { hostname: '127.0.0.1', port: 8787 });
  assert.deepEqual(parseGatewayUrl('https://example.com/mcp'), { hostname: 'example.com', port: 443 });
});

test('classifyMessage distinguishes control channel messages', () => {
  assert.equal(classifyMessage({ jsonrpc: '2.0', id: 1, method: 'instance.register' }), 'request');
  assert.equal(classifyMessage({ jsonrpc: '2.0', id: 1, result: {} }), 'response');
  assert.equal(classifyMessage({ jsonrpc: '2.0', method: 'notifications/x' }), 'notification');
});

test('createHttpControlTransport returns a functional request/response transport', async () => {
  const transport = createHttpControlTransport();
  assert.equal(transport.kind, 'http');
  assert.equal(typeof transport.request, 'function');
  assert.equal(typeof transport.health, 'function');
  assert.equal(typeof transport.close, 'function');
});

test('createWebSocketControlTransport requires a WebSocket client', () => {
  const nodeHasWebSocket = typeof globalThis.WebSocket === 'function';
  if (!nodeHasWebSocket) {
    assert.throws(() => createWebSocketControlTransport({ WebSocket: null }), /WebSocket/);
    assert.throws(() => createWebSocketControlTransport({}), /WebSocket/);
    return;
  }
  // Node 25 ships a global WebSocket, so a transport is returned in both cases.
  const factory = createWebSocketControlTransport({ WebSocket: null });
  assert.equal(typeof factory, 'object');
});

test('createWebSocketControlTransport returns a transport factory when provided', () => {
  let ctorArgs;
  class FakeWebSocket {
    constructor(url, protocols) {
      ctorArgs = { url, protocols };
      this.url = url;
      this.readyState = 1;
      this._listeners = {};
      this.sent = [];
    }
    addEventListener(name, fn) {
      this._listeners[name] = fn;
    }
    send(payload) {
      this.sent.push(JSON.parse(payload));
    }
    close() {
      if (this._listeners.close) {
        this._listeners.close();
      }
    }
  }
  const factory = createWebSocketControlTransport({ WebSocket: FakeWebSocket, authToken: 'secret-token' });
  assert.equal(factory.kind, 'websocket');
  const channel = factory.connect('http://127.0.0.1:8787');
  assert.equal(ctorArgs.url, 'ws://127.0.0.1:8787/control');
  assert.deepEqual(ctorArgs.protocols, ['bearer.secret-token']);
  assert.equal(typeof channel.request, 'function');
  assert.equal(typeof channel.health, 'function');
  assert.equal(typeof channel.close, 'function');
  channel.close();
});

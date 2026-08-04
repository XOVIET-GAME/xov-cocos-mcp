'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { GatewayServer } = require('../../lib/gateway/gateway-server');
const { RateLimiter } = require('../../lib/gateway/rate-limiter');
const { TargetRegistry } = require('../../lib/gateway/target-registry');

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname, headers: { Accept: 'application/json' } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.on('error', reject);
  });
}

test('rate limiter returns a retry window after the configured budget', () => {
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.allow('agent').allowed, true);
  assert.equal(limiter.allow('agent').allowed, true);
  const blocked = limiter.allow('agent');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  assert.equal(limiter.allow('other').allowed, true);
});

test('Gateway rejects oversized MCP request bodies with a structured 413', async () => {
  const ownershipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-gateway-body-limit-test-'));
  const server = new GatewayServer({
    host: '127.0.0.1',
    port: 0,
    ownershipDir,
    ownershipOverride: { ownerExtensionId: 'body-limit-test', ownerInstanceId: 'body-owner', autoStartedByExtension: false },
    autoStopWhenIdle: false,
    logger: { log() {} },
  });
  try {
    await server.start();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'too-large', method: 'initialize', padding: 'x'.repeat(270 * 1024) });
    const response = await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port: server.getPort(),
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (result) => {
        const chunks = [];
        result.on('data', (chunk) => chunks.push(chunk));
        result.on('end', () => resolve({ statusCode: result.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      request.on('error', reject);
      request.end(body);
    });
    assert.equal(response.statusCode, 413);
    assert.equal(response.body.error.code, -32030);
    assert.match(response.body.error.message, /REQUEST_TOO_LARGE/);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('target aliases persist across registry instances', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-target-alias-test-'));
  const statePath = path.join(dir, 'targets.json');
  try {
    const first = new TargetRegistry({ statePath });
    first.register({ editorInstanceId: 'editor-1', projectId: 'project-1' });
    first.setAlias('editor-1', 'game-editor');
    const second = new TargetRegistry({ statePath });
    const restored = second.register({ editorInstanceId: 'editor-1', projectId: 'project-1' });
    assert.equal(restored.targetId, 'game-editor');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics endpoint exposes request counters and is protected with the Gateway token', async () => {
  const ownershipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-gateway-metrics-test-'));
  const server = new GatewayServer({
    host: '127.0.0.1',
    port: 0,
    authToken: 'metrics-secret',
    ownershipDir,
    ownershipOverride: { ownerExtensionId: 'metrics-test', ownerInstanceId: 'metrics-owner', autoStartedByExtension: false },
    autoStopWhenIdle: false,
    logger: { log() {} },
  });
  try {
    await server.start();
    const unauthorized = await getJson(server.getPort(), '/metrics');
    assert.equal(unauthorized.statusCode, 401);
    const authorized = await new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port: server.getPort(), path: '/metrics', headers: { Authorization: 'Bearer metrics-secret' } }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      request.on('error', reject);
    });
    assert.equal(authorized.statusCode, 200);
    assert.ok(authorized.body.counters.http_requests_total >= 2);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'funplay-cocos-mcp.js');

function frame(value) {
  const body = JSON.stringify(value);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function parseFrames(text) {
  const results = [];
  let offset = 0;
  while (offset < text.length) {
    const separator = text.indexOf('\r\n\r\n', offset);
    if (separator < 0) break;
    const header = text.slice(offset, separator);
    const match = header.match(/content-length:\s*(\d+)/i);
    assert.ok(match, `missing Content-Length in ${header}`);
    const length = Number.parseInt(match[1], 10);
    const start = separator + 4;
    const body = text.slice(start, start + length);
    if (Buffer.byteLength(body) < length) break;
    results.push(JSON.parse(body));
    offset = start + length;
  }
  return results;
}

function startMockGateway(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}/mcp`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function readRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    request.on('error', reject);
  });
}

function runCli(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [BIN, ...args], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FUNPLAY_COCOS_GATEWAY_URL: '' },
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({
      status,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

test('the public CLI is client-only and has no lifecycle authority', () => {
  const source = require('node:fs').readFileSync(BIN, 'utf8');
  assert.doesNotMatch(source, /router\s+start/i);
  assert.doesNotMatch(source, /router\s+ensure/i);
  assert.doesNotMatch(source, /router\s+stop/i);
  assert.doesNotMatch(source, /gateway\s+start/i);
  assert.doesNotMatch(source, /gateway\s+stop/i);
  assert.doesNotMatch(source, /process-manager/);
  assert.doesNotMatch(source, /daemon-entry/);
  assert.doesNotMatch(source, /gateway-client/);
});

test('the daemon entry is not referenced as a public bin', () => {
  const packageJson = require('../../package.json');
  const bins = packageJson.bin || {};
  assert.ok(bins['funplay-cocos-mcp']);
  assert.ok(bins['cocos-cli']);
  assert.deepEqual(Object.keys(bins), ['funplay-cocos-mcp', 'cocos-cli']);
  assert.equal(bins['funplay-cocos-mcp'], 'bin/funplay-cocos-mcp.js');
  assert.equal(bins['cocos-cli'], 'bin/cocos-cli.js');
});

test('--help documents client-only Gateway commands', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /central Cocos Gateway/i);
  assert.match(result.stderr, /targets list/);
  assert.match(result.stderr, /target health/);
  assert.match(result.stderr, /call <tool>/);
  assert.doesNotMatch(result.stderr, /router\s+(start|ensure|stop)/i);
});

test('stdio mcp forwards initialize, tools/list, tools/call, and notifications to Gateway', async () => {
  const messages = [];
  const gateway = await startMockGateway(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    const message = await readRequest(request);
    messages.push(message);
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
      response.writeHead(202).end();
      return;
    }
    let result;
    if (message.method === 'initialize') {
      result = { protocolVersion: '2025-03-26', serverInfo: { name: 'gateway-test', version: '1' }, capabilities: {} };
    } else if (message.method === 'tools/list') {
      result = { tools: [{ name: 'get_hierarchy', inputSchema: { type: 'object' } }] };
    } else if (message.method === 'tools/call') {
      result = { content: [{ type: 'text', text: 'ok' }], isError: false };
    } else {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-test' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  try {
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_hierarchy', arguments: {} } },
    ].map(frame).join('');
    const result = await runCli(['mcp', '--url', gateway.url, '--timeout-seconds', '5'], input);
    assert.equal(result.status, 0, result.stderr);
    const responses = parseFrames(result.stdout);
    assert.deepEqual(responses.map((item) => item.id), [1, 2, 3]);
    assert.equal(responses[1].result.tools[0].name, 'get_hierarchy');
    assert.equal(responses[2].result.content[0].text, 'ok');
    assert.deepEqual(messages.map((item) => item.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  } finally {
    await gateway.close();
  }
});

test('unreachable Gateway reports deterministic GATEWAY_UNAVAILABLE without spawning a daemon', async () => {
  const result = await runCli(['mcp', '--url', 'http://127.0.0.1:1/mcp', '--timeout-seconds', '1'], frame({
    jsonrpc: '2.0', id: 'unavailable', method: 'initialize', params: {},
  }));
  assert.equal(result.status, 0);
  const response = parseFrames(result.stdout)[0];
  assert.equal(response.error.code, -32050);
  assert.match(response.error.message, /GATEWAY_UNAVAILABLE/);
  assert.match(response.error.message, /open a Cocos Editor/i);
  assert.match(result.stderr, /GATEWAY_UNAVAILABLE/);
});

test('targets list and target health use read-only Gateway health data', async () => {
  const target = {
    targetId: 'editor-1', editorInstanceId: 'editor-1', projectId: 'project-1',
    status: 'online', role: 'read-only', capabilities: ['tools/list'],
  };
  const gateway = await startMockGateway(async (request, response) => {
    assert.equal(request.method, 'GET');
    assert.match(request.url, /^\/health/);
    const url = new URL(request.url, 'http://localhost');
    const payload = { ok: true, targets: [target] };
    if (url.searchParams.get('targetId')) payload.target = target;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  try {
    const list = await runCli(['targets', 'list', '--url', gateway.url, '--timeout-seconds', '5']);
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), [target]);

    const health = await runCli(['target', 'health', 'editor-1', '--url', gateway.url, '--timeout-seconds', '5']);
    assert.equal(health.status, 0, health.stderr);
    assert.deepEqual(JSON.parse(health.stdout), target);
  } finally {
    await gateway.close();
  }
});

test('one-shot call initializes a client session and forwards tool arguments to Gateway', async () => {
  const messages = [];
  const gateway = await startMockGateway(async (request, response) => {
    if (request.method === 'DELETE') {
      response.writeHead(204).end();
      return;
    }
    assert.equal(request.method, 'POST');
    const message = await readRequest(request);
    messages.push(message);
    if (message.method === 'initialize') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'call-session' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25' } }));
      return;
    }
    assert.equal(message.method, 'tools/call');
    assert.equal(message.params.name, 'get_hierarchy');
    assert.equal(message.params.targetId, 'editor-1');
    assert.deepEqual(message.params.arguments, { deep: true });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
  });
  try {
    const result = await runCli(['call', 'get_hierarchy', '{"deep":true}', '--target', 'editor-1', '--url', gateway.url, '--timeout-seconds', '5']);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.result.content[0].text, 'ok');
    assert.deepEqual(messages.map((message) => message.method), ['initialize', 'tools/call']);
  } finally {
    await gateway.close();
  }
});

test('invalid client-only command returns usage without contacting Gateway', async () => {
  const result = await runCli(['targets']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: targets list/);
});

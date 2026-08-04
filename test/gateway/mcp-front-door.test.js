'use strict';

// Phase 1 focused tests: the Gateway MCP front door and command dispatch.
//
// A mock Cocos extension registers against the Gateway with an injected
// control transport. The tests exercise the MCP front door end-to-end:
//   - initialize + notifications/initialized protocol negotiation
//   - tools/list aggregates the mock extension's tool schemas
//   - tools/call routes a command.request to the mock extension and returns the
//     correlated command.result by request id
//   - request correlation / id mismatch detection
//   - unavailable (no target) and ambiguous (multiple targets) errors
//   - protocol behavior (invalid JSON, unsupported methods, notifications)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { GatewayServer } = require('../../lib/gateway/gateway-server');
const { TargetRegistry } = require('../../lib/gateway/target-registry');
const { createRequest, createResponse } = require('../../lib/gateway/extension-protocol');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-gw-mcp-test-'));
}

function silentLogger() {
  return { log() {} };
}

// A mock control transport that stands in for the extension-side transport.
// It answers instance.register/heartbeat/unregister and tools/list, and
// executes command.request by calling the mock editor tool handler.
function createMockExtensionTransport({ toolHandler, tools }) {
  const seenCommands = [];
  return {
    kind: 'mock',
    seenCommands,
    request: async (gatewayUrl, message, sessionId) => {
      if (message.method === 'instance.register') {
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: { ok: true, connectionId: 'mock-conn-' + message.id, sessionId: 'mock-session' },
        };
      }
      if (message.method === 'instance.heartbeat') {
        return { jsonrpc: '2.0', id: message.id, result: { ok: true, lastSeenAt: new Date().toISOString() } };
      }
      if (message.method === 'instance.unregister') {
        return { jsonrpc: '2.0', id: message.id, result: { ok: true, removed: true, canAutoStop: true } };
      }
      if (message.method === 'tools/list') {
        return { jsonrpc: '2.0', id: message.id, result: { tools: tools || [] } };
      }
      if (message.method === 'command.request') {
        seenCommands.push(message);
        const params = message.params || {};
        const toolName = params.tool && params.tool.name;
        let result;
        try {
          const value = toolHandler ? await toolHandler(toolName, params.tool && params.tool.arguments) : { ok: true, name: toolName };
          result = { tool: toolName, value, executedBy: 'mock-editor' };
        } catch (error) {
          result = { tool: toolName, value: null, error: error.message };
        }
        // Echo the request id back so the Gateway can correlate.
        return createResponse(message.id, result);
      }
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found: ' + message.method } };
    },
    health: async () => ({ ok: true }),
    close: async () => {},
  };
}

function createMockTools() {
  return [
    {
      name: 'get_hierarchy',
      description: 'Get the scene hierarchy.',
      inputSchema: { type: 'object', properties: { deep: { type: 'boolean' } }, additionalProperties: false },
      outputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'open_scene',
      description: 'Open a scene.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
      outputSchema: { type: 'object', properties: {} },
    },
  ];
}

function postJson(port, pathWithQuery, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathWithQuery,
        method: 'POST',
        agent: false,
        headers: Object.assign({
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        }, extraHeaders || {}),
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (error) {
            parsed = null;
          }
          resolve({ statusCode: response.statusCode, headers: response.headers, body: parsed });
        });
      }
    );
    request.on('error', reject);
    request.end(body);
  });
}

function getJson(port, pathWithQuery) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathWithQuery,
        method: 'GET',
        agent: false,
        headers: { Accept: 'application/json' },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (error) {
            parsed = null;
          }
          resolve({ statusCode: response.statusCode, headers: response.headers, body: parsed });
        });
      }
    );
    request.on('error', reject);
    request.end();
  });
}

async function createGateway(overrides = {}) {
  const ownershipDir = createTempDir();
  const registry = overrides.registry || new TargetRegistry({ ttlMs: 2000, staleScanIntervalMs: 200 });
  const server = new GatewayServer({
    host: '127.0.0.1',
    port: 0,
    ownershipDir,
    ownershipOverride: {
      ownerExtensionId: 'ext-mcp-test',
      ownerInstanceId: 'ext-mcp-instance',
      launchNonce: 'nonce-mcp',
      autoStartedByExtension: true,
    },
    registry,
    logger: silentLogger(),
    autoStopWhenIdle: false,
    ...overrides,
  });
  server.lifecycle.onAutoStop = async () => {};
  await server.start();
  return { server, registry, ownershipDir };
}

// Registers a mock extension against the Gateway with the given transport.
// The transport is attached in-process to the registry instance, mirroring a
// persistent WebSocket control channel: it cannot be serialized over HTTP.
async function registerMockExtension(server, transport, editorInstanceId, projectId) {
  const response = await postJson(server.getPort(), '/control', createRequest('reg-' + editorInstanceId, 'instance.register', {
    editorInstanceId,
    projectId,
    ownerExtensionId: 'ext-mcp-test',
    ownerInstanceId: 'ext-mcp-instance',
    capabilities: ['scene', 'asset'],
  }));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.result.ok, true);
  const instance = server.registry.get(editorInstanceId);
  assert.ok(instance);
  instance.transport = transport;
  return response.body.result;
}

function mcpHeaders(protocolVersion) {
  return {
    'MCP-Protocol-Version': protocolVersion || '2025-11-25',
    'Mcp-Session-Id': 'session-test-1',
  };
}

test('GET /mcp opens an MCP session', async () => {
  const { server, ownershipDir } = await createGateway();
  try {
    const response = await getJson(server.getPort(), '/mcp');
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.protocolVersion, '2025-11-25');
    assert.ok(response.body.sessionId);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('POST /mcp initialize negotiates protocol version and returns serverInfo', async () => {
  const { server, ownershipDir } = await createGateway();
  try {
    const response = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'test-agent', version: '1.0.0' },
      },
    }, mcpHeaders('2025-06-18'));
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.id, 'init-1');
    assert.equal(response.body.result.protocolVersion, '2025-06-18');
    assert.equal(response.body.result.serverInfo.name, 'funplay-cocos-mcp-gateway');
    assert.ok(response.body.result.capabilities.tools);
    assert.ok(response.headers['mcp-session-id']);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('POST /mcp notifications/initialized is accepted with 202', async () => {
  const { server, ownershipDir } = await createGateway();
  try {
    const response = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }, mcpHeaders());
    assert.equal(response.statusCode, 202);
    assert.equal(response.body, null);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('tools/list aggregates the registered mock extension tool schemas', async () => {
  const { server, ownershipDir } = await createGateway();
  const transport = createMockExtensionTransport({ tools: createMockTools() });
  try {
    await registerMockExtension(server, transport, 'editor-list', 'project-list');
    const response = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      id: 'tools-list-1',
      method: 'tools/list',
      params: {},
    }, mcpHeaders());
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.id, 'tools-list-1');
    const tools = response.body.result.tools;
    assert.ok(tools.length >= 7);
    const forwardedTools = tools.filter((tool) => ['get_hierarchy', 'open_scene'].includes(tool.name));
    assert.equal(forwardedTools.length, 2);
    assert.equal(forwardedTools[0].name, 'get_hierarchy');
    assert.equal(forwardedTools[1].name, 'open_scene');
    assert.equal(forwardedTools[0].inputSchema.type, 'object');
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('tools/call round-trips a command.request and returns the correlated command.result', async () => {
  const { server, ownershipDir } = await createGateway();
  const transport = createMockExtensionTransport({
    tools: createMockTools(),
    toolHandler: async (name, args) => ({ ok: true, name, args }),
  });
  try {
    await registerMockExtension(server, transport, 'editor-call', 'project-call');
    const response = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      id: 'call-1',
      method: 'tools/call',
      params: { name: 'get_hierarchy', arguments: { deep: true } },
    }, mcpHeaders());
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.id, 'call-1');
    assert.equal(response.body.result.structuredContent.ok, true);
    assert.equal(response.body.result.structuredContent.name, 'get_hierarchy');
    assert.equal(response.body.result.structuredContent.args.deep, true);
    assert.equal(response.body.result.content[0].type, 'text');

    // The command.request reached the extension with a requestId.
    assert.equal(transport.seenCommands.length, 1);
    const command = transport.seenCommands[0];
    assert.equal(command.method, 'command.request');
    assert.ok(command.params.requestId);
    assert.equal(command.params.tool.name, 'get_hierarchy');
    assert.equal(command.params.tool.arguments.deep, true);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('tools/call preserves the MCP request id through dispatch and correlation', async () => {
  const { server, ownershipDir } = await createGateway();
  const transport = createMockExtensionTransport({
    tools: createMockTools(),
    toolHandler: async () => ({ ok: true }),
  });
  try {
    await registerMockExtension(server, transport, 'editor-call-2', 'project-call-2');
    const response = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      id: 'mcp-request-42',
      method: 'tools/call',
      params: { name: 'open_scene', arguments: { path: 'scene.scene' } },
    }, mcpHeaders());
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.id, 'mcp-request-42');
    assert.equal(response.body.result.structuredContent.ok, true);
    // The extension saw a fresh command request id.
    assert.notEqual(transport.seenCommands[0].id, 'mcp-request-42');
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('tools/call returns the command.result error as an isError MCP result', async () => {
  const { server, ownershipDir } = await createGateway();
  const transport = createMockExtensionTransport({
    tools: createMockTools(),
    toolHandler: async () => {
      throw new Error('scene already open');
    },
  });
  try {
    await registerMockExtension(server, transport, 'editor-err', 'project-err');
    const response = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      id: 'call-err',
      method: 'tools/call',
      params: { name: 'open_scene', arguments: {} },
    }, mcpHeaders());
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.id, 'call-err');
    assert.equal(response.body.result.isError, true);
    assert.match(response.body.result.content[0].text, /scene already open/);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('tools/call rejects a command.result with a mismatched request id', async () => {
  const { server, ownershipDir } = await createGateway();
  const transport = createMockExtensionTransport({
    tools: createMockTools(),
    toolHandler: async () => ({ ok: true }),
  });
  // Override the request method to answer with a wrong id, simulating a stale
  // or out-of-order response from the extension.
  const originalRequest = transport.request.bind(transport);
  transport.request = async (gatewayUrl, message, sessionId) => {
    if (message.method !== 'command.request') {
      return originalRequest(gatewayUrl, message, sessionId);
    }
    return {
      jsonrpc: '2.0',
      id: 'cmd-wrong-id',
      result: { tool: message.params.tool.name, value: { ok: true } },
    };
  };
  try {
    await registerMockExtension(server, transport, 'editor-mismatch', 'project-mismatch');
    const response = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      id: 'call-mismatch',
      method: 'tools/call',
      params: { name: 'get_hierarchy', arguments: {} },
    }, mcpHeaders());
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.id, 'call-mismatch');
    assert.equal(response.body.error.code, -32003);
    assert.match(response.body.error.message, /id mismatch/);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('tools/call with no registered target returns an unavailable error', async () => {
  const { server, ownershipDir } = await createGateway();
  try {
    const response = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      id: 'call-unavailable',
      method: 'tools/call',
      params: { name: 'get_hierarchy', arguments: {} },
    }, mcpHeaders());
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.id, 'call-unavailable');
    assert.equal(response.body.error.code, -32001);
    assert.match(response.body.error.message, /No Cocos Editor target is available/);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('Editor transport failure marks the selected target offline', async () => {
  const { server, ownershipDir } = await createGateway();
  const offlineTransport = {
    request: async (_gatewayUrl, message) => {
      if (message.method === 'instance.register') {
        return { jsonrpc: '2.0', id: message.id, result: { ok: true, connectionId: 'offline-conn', sessionId: 'offline-session' } };
      }
      const error = new Error('Editor connection lost.');
      error.code = 'ECONNRESET';
      throw error;
    },
  };
  try {
    await registerMockExtension(server, offlineTransport, 'editor-offline', 'project-offline');
    const response = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      id: 'call-offline',
      method: 'tools/call',
      params: { name: 'get_hierarchy', arguments: {} },
    }, mcpHeaders());
    assert.equal(response.body.error.code, -32003);
    assert.equal(server.registry.get('editor-offline').status, 'offline');
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('tools/list with no registered target exposes the unavailable tool surface', async () => {
  const { server, ownershipDir } = await createGateway();
  try {
    const response = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      id: 'tools-unavailable',
      method: 'tools/list',
      params: {},
    }, mcpHeaders());
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.result.tools.length >= 5);
    const targetTool = response.body.result.tools.find((tool) => tool.name === 'cocos_targets');
    assert.ok(targetTool);
    assert.match(targetTool.description, /unavailable/);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('tools/call with multiple registered targets returns an ambiguous error', async () => {
  const { server, ownershipDir } = await createGateway();
  const t1 = createMockExtensionTransport({ tools: createMockTools() });
  const t2 = createMockExtensionTransport({ tools: createMockTools() });
  try {
    await registerMockExtension(server, t1, 'editor-a', 'project-a');
    await registerMockExtension(server, t2, 'editor-b', 'project-b');
    const response = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      id: 'call-ambiguous',
      method: 'tools/call',
      params: { name: 'get_hierarchy', arguments: {} },
    }, mcpHeaders());
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.id, 'call-ambiguous');
    assert.equal(response.body.error.code, -32001);
    assert.match(response.body.error.message, /Multiple Cocos Editor targets/);
    assert.deepEqual(response.body.error.data.targets.sort(), ['editor-a', 'editor-b']);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('tools/call with explicit targetId routes to the selected Editor', async () => {
  const { server, ownershipDir } = await createGateway();
  const first = createMockExtensionTransport({
    tools: createMockTools(),
    toolHandler: async () => ({ editor: 'first' }),
  });
  const second = createMockExtensionTransport({
    tools: createMockTools(),
    toolHandler: async () => ({ editor: 'second' }),
  });
  try {
    await registerMockExtension(server, first, 'editor-route-a', 'project-route');
    await registerMockExtension(server, second, 'editor-route-b', 'project-route');
    const response = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      id: 'call-targeted',
      method: 'tools/call',
      params: { name: 'get_hierarchy', targetId: 'editor-route-b', arguments: { targetId: 'must-not-forward', deep: true } },
    }, mcpHeaders());
    assert.equal(response.body.id, 'call-targeted');
    assert.equal(response.body.result.structuredContent.editor, 'second');
    assert.equal(first.seenCommands.length, 0);
    assert.equal(second.seenCommands.length, 1);
    assert.equal(second.seenCommands[0].params.targetId, 'editor-route-b');
    assert.equal(second.seenCommands[0].params.generation, '');
    assert.equal(second.seenCommands[0].params.tool.arguments.targetId, undefined);
    assert.equal(second.seenCommands[0].params.tool.arguments.deep, true);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('mutation revisions cover file resources and reject stale file state', async () => {
  const { server, ownershipDir } = await createGateway();
  const transport = createMockExtensionTransport({
    tools: createMockTools(),
    toolHandler: async (toolName, args) => ({ toolName, path: args.path, saved: true }),
  });
  const fileResource = 'file:assets/data.json';
  try {
    await registerMockExtension(server, transport, 'editor-resource-revision', 'project-resource-revision');
    const first = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      id: 'write-file-first',
      method: 'tools/call',
      params: { name: 'write_file', targetId: 'editor-resource-revision', arguments: { path: 'assets/data.json', content: '{}' } },
    }, mcpHeaders());
    assert.equal(first.body.result.structuredContent.saved, true);
    assert.equal(first.body.result.revisions[fileResource].revision, 1);

    const second = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      id: 'write-file-second',
      method: 'tools/call',
      params: {
        name: 'write_file',
        targetId: 'editor-resource-revision',
        expectedRevision: { resources: { [fileResource]: { revision: 1 } } },
        arguments: { path: 'assets/data.json', content: '{"version":2}' },
      },
    }, mcpHeaders());
    assert.equal(second.body.result.revisions[fileResource].revision, 2);

    const stale = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      id: 'write-file-stale',
      method: 'tools/call',
      params: {
        name: 'write_file',
        targetId: 'editor-resource-revision',
        expectedRevision: { resources: { [fileResource]: { revision: 1 } } },
        arguments: { path: 'assets/data.json', content: '{"version":3}' },
      },
    }, mcpHeaders());
    assert.equal(stale.body.error.code, -32012);
    assert.equal(stale.body.error.data.code, 'STALE_EDITOR_STATE');
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('project routing prefers the primary writer and read-only agents cannot mutate', async () => {
  const { server, ownershipDir } = await createGateway();
  const first = createMockExtensionTransport({ tools: createMockTools() });
  const second = createMockExtensionTransport({ tools: createMockTools() });
  try {
    await registerMockExtension(server, first, 'editor-primary', 'project-shared');
    await registerMockExtension(server, second, 'editor-readonly', 'project-shared');
    const routed = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      id: 'call-primary',
      method: 'tools/call',
      params: { name: 'open_scene', projectId: 'project-shared', arguments: { path: 'main.scene' } },
    }, mcpHeaders());
    assert.equal(routed.body.result.structuredContent.ok, true);
    assert.equal(first.seenCommands.length, 1);
    assert.equal(second.seenCommands.length, 0);

    const denied = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      id: 'call-readonly',
      method: 'tools/call',
      params: { name: 'open_scene', projectId: 'project-shared', arguments: { path: 'main.scene' } },
    }, { ...mcpHeaders(), 'X-Agent-Permissions': 'read-only', 'Mcp-Session-Id': 'read-only-session' });
    assert.equal(denied.body.error.code, -32014);
    assert.match(denied.body.error.message, /read-only/);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('tools/call without a tool name returns an invalid params error', async () => {
  const { server, ownershipDir } = await createGateway();
  try {
    const response = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      id: 'call-no-name',
      method: 'tools/call',
      params: {},
    }, mcpHeaders());
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.error.code, -32602);
    assert.match(response.body.error.message, /name/);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('POST /mcp with malformed JSON returns a parse error', async () => {
  const { server, ownershipDir } = await createGateway();
  try {
    const body = '{not-json';
    const response = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: server.getPort(),
          path: '/mcp',
          method: 'POST',
          agent: false,
          headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            resolve({ statusCode: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          });
        }
      );
      request.on('error', reject);
      request.end(body);
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error.code, -32700);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('POST /mcp with an unknown method returns method not found', async () => {
  const { server, ownershipDir } = await createGateway();
  try {
    const response = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      id: 'unknown-1',
      method: 'tools/nope',
      params: {},
    }, mcpHeaders());
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.error.code, -32601);
    assert.match(response.body.error.message, /Method not found/);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('the /mcp endpoint advertises MCP protocol metadata on the root route', async () => {
  const { server, ownershipDir } = await createGateway();
  try {
    const response = await getJson(server.getPort(), '/');
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.mcp, '/mcp');
    assert.equal(response.body.mcpProtocolVersion, '2025-11-25');
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('command.result correlation tracks the pending request by request id', async () => {
  const { server, ownershipDir } = await createGateway();
  const transport = createMockExtensionTransport({
    tools: createMockTools(),
    toolHandler: async (name, args) => ({ ok: true, name, args }),
  });
  try {
    await registerMockExtension(server, transport, 'editor-correlate', 'project-correlate');
    const response = await postJson(server.getPort(), '/mcp', {
      jsonrpc: '2.0',
      id: 'correlate-7',
      method: 'tools/call',
      params: { name: 'get_hierarchy', arguments: {} },
    }, mcpHeaders());
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.id, 'correlate-7');
    assert.equal(response.body.result.structuredContent.ok, true);

    // Simulate an out-of-band command.result arriving through the control
    // channel (as a WebSocket transport would deliver). The Gateway should
    // recognize it and clean up the pending entry.
    const commandId = transport.seenCommands[0].id;
    server.pendingCommands.set(commandId, { mcpId: 'correlate-7', toolName: 'get_hierarchy', createdAt: Date.now() });
    await postJson(server.getPort(), '/control', createResponse(commandId, {
      requestId: commandId,
      tool: 'get_hierarchy',
      value: { ok: true },
    }));
    assert.equal(server.pendingCommands.has(commandId), false);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

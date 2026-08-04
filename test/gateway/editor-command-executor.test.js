'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createEditorCommandExecutor } = require('../../lib/extension/editor-command-executor');

test('executor forwards a command request to the editor tool registry', async () => {
  const calls = [];
  const executor = createEditorCommandExecutor({
    toolRegistry: {
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { ok: true, name };
      },
    },
    getStatus: () => ({ projectName: 'game' }),
    logger: { log() {} },
  });
  const result = await executor.execute({
    jsonrpc: '2.0',
    id: 'cmd-1',
    method: 'command.request',
    params: { tool: { name: 'get_hierarchy', arguments: { deep: true } } },
  });
  assert.equal(result.id, 'cmd-1');
  assert.equal(result.result.tool, 'get_hierarchy');
  assert.equal(result.result.value.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { name: 'get_hierarchy', args: { deep: true } });
});

test('executor returns a protocol error for a missing tool name', async () => {
  const executor = createEditorCommandExecutor({ toolRegistry: { callTool: async () => {} } });
  const result = await executor.execute({
    jsonrpc: '2.0',
    id: 'cmd-2',
    method: 'command.request',
    params: {},
  });
  assert.equal(result.error.code, -32602);
});

test('executor surfaces tool execution failures as result errors', async () => {
  const executor = createEditorCommandExecutor({
    toolRegistry: {
      callTool: async () => {
        throw new Error('boom');
      },
    },
  });
  const result = await executor.execute({
    jsonrpc: '2.0',
    id: 'cmd-3',
    method: 'command.request',
    params: { tool: { name: 'execute_javascript', arguments: {} } },
  });
  assert.equal(result.result.error, 'boom');
});

test('executor rejects a command whose Gateway deadline has expired', async () => {
  let called = false;
  const executor = createEditorCommandExecutor({
    toolRegistry: { callTool: async () => { called = true; } },
  });
  const result = await executor.execute({
    jsonrpc: '2.0',
    id: 'cmd-expired',
    method: 'command.request',
    params: { deadline: new Date(Date.now() - 1000).toISOString(), tool: { name: 'get_hierarchy', arguments: {} } },
  });
  assert.equal(result.error.code, -32011);
  assert.equal(called, false);
});

test('executor marks an in-flight command cancelled and suppresses its late result', async () => {
  let resolveTool;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const executor = createEditorCommandExecutor({
    toolRegistry: {
      callTool: async () => {
        started();
        return new Promise((resolve) => { resolveTool = resolve; });
      },
    },
  });
  const running = executor.execute({
    jsonrpc: '2.0',
    id: 'cmd-cancel',
    method: 'command.request',
    params: { requestId: 'cmd-cancel', tool: { name: 'build_project', arguments: {} } },
  });
  await startedPromise;
  assert.equal(executor.cancel('cmd-cancel'), true);
  resolveTool({ ok: true });
  const result = await running;
  assert.equal(result.error.code, -32015);
});

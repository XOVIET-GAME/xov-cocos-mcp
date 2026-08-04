'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  VALID_LIFECYCLE_METHODS,
  VALID_COMMAND_METHODS,
  classify,
  createError,
  createMessageId,
  createRequest,
  createResponse,
  errorFromValidation,
  isValidId,
  validateLifecycleParams,
} = require('../../lib/gateway/extension-protocol');

test('protocol constants describe the Phase 0 control contract', () => {
  assert.equal(typeof PROTOCOL_VERSION, 'string');
  assert.ok(PROTOCOL_VERSION.length > 0);
  assert.equal(PROTOCOL_NAME, 'cocos-gateway-control');
  assert.deepEqual(
    Array.from(VALID_LIFECYCLE_METHODS).sort(),
    ['instance.heartbeat', 'instance.register', 'instance.unregister'].sort()
  );
});

test('Phase 1 command methods define the tool forwarding contract', () => {
  assert.deepEqual(
    Array.from(VALID_COMMAND_METHODS).sort(),
    ['command.cancel', 'command.request', 'command.result'].sort()
  );
});

test('createMessageId is unique and prefixed', () => {
  const a = createMessageId('abc');
  const b = createMessageId('abc');
  assert.match(a, /^abc-/);
  assert.notEqual(a, b);
});

test('classify distinguishes requests, responses, and notifications', () => {
  assert.equal(classify(createRequest(1, 'instance.register', {})), 'request');
  assert.equal(classify(createResponse(1, { ok: true })), 'response');
  assert.equal(classify({ jsonrpc: '2.0', method: 'notifications/initialized' }), 'notification');
  assert.equal(classify({ jsonrpc: '2.0', id: 1 }), 'invalid');
  assert.equal(classify(null), 'invalid');
});

test('validateLifecycleParams accepts valid lifecycle payloads', () => {
  assert.equal(
    validateLifecycleParams('instance.register', {
      editorInstanceId: 'e1',
      projectId: 'p1',
      ownerExtensionId: 'ext',
      ownerInstanceId: 'ext-1',
    }),
    null
  );
  assert.equal(validateLifecycleParams('instance.heartbeat', { editorInstanceId: 'e1' }), null);
  assert.equal(
    validateLifecycleParams('instance.unregister', {
      editorInstanceId: 'e1',
      sessionToken: 'conn-1',
    }),
    null
  );
});

test('validateLifecycleParams rejects malformed payloads', () => {
  const register = validateLifecycleParams('instance.register', { projectId: 'p1' });
  assert.equal(register.code, -32602);
  assert.match(register.message, /editorInstanceId/);

  const heartbeat = validateLifecycleParams('instance.heartbeat', {});
  assert.equal(heartbeat.code, -32602);

  const unregister = validateLifecycleParams('instance.unregister', { editorInstanceId: 'e1' });
  assert.equal(unregister.code, -32602);
  assert.match(unregister.message, /sessionToken/);

  const unknown = validateLifecycleParams('instance.nope', {});
  assert.equal(unknown.code, -32601);
});

test('errorFromValidation maps a validation result to a JSON-RPC error', () => {
  const validation = { code: -32602, message: 'bad params' };
  const error = errorFromValidation('id-1', validation);
  assert.deepEqual(error, {
    jsonrpc: '2.0',
    id: 'id-1',
    error: { code: -32602, message: 'bad params' },
  });
});

test('createError supports optional data', () => {
  const error = createError(7, -32001, 'unknown instance', { editorInstanceId: 'e1' });
  assert.equal(error.error.data.editorInstanceId, 'e1');
});

test('isValidId accepts strings and numbers only', () => {
  assert.equal(isValidId('abc'), true);
  assert.equal(isValidId(42), true);
  assert.equal(isValidId(null), false);
  assert.equal(isValidId(undefined), false);
  assert.equal(isValidId({}), false);
});

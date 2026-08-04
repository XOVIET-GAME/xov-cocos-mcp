'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createExtensionId,
  createEditorInstanceId,
  buildRegistration,
} = require('../../lib/extension/instance-registration');

test('createExtensionId returns a unique prefixed id', () => {
  const a = createExtensionId();
  const b = createExtensionId();
  assert.match(a, /^ext-/);
  assert.notEqual(a, b);
});

test('createEditorInstanceId derives a stable short hash', () => {
  const a = createEditorInstanceId('D:/projects/game');
  const b = createEditorInstanceId('D:/projects/game');
  assert.equal(a, b);
  assert.match(a, /^editor-/);
  assert.notEqual(a, createEditorInstanceId('D:/projects/other'));
});

test('buildRegistration produces a Gateway-ready register payload', () => {
  const registration = buildRegistration({
    extensionName: 'funplay-cocos-mcp',
    editorInstanceId: 'editor-abc',
    projectIdentity: 'project-abc',
    cocosVersion: '3.8.6',
    capabilities: ['scene', 'asset'],
  });
  assert.equal(registration.editorInstanceId, 'editor-abc');
  assert.equal(registration.projectId, 'project-abc');
  assert.equal(registration.ownerExtensionId, 'funplay-cocos-mcp');
  assert.equal(registration.cocosVersion, '3.8.6');
  assert.deepEqual(registration.capabilities, ['scene', 'asset']);
  assert.ok(registration.ownerInstanceId.startsWith('ext-'));
  assert.ok(Number.isFinite(registration.pid));
});

test('buildRegistration falls back when identity inputs are missing', () => {
  const registration = buildRegistration({ extensionName: 'ext', projectPath: 'D:/p' });
  assert.ok(registration.editorInstanceId.startsWith('editor-'));
  assert.match(registration.projectId, /^[a-f0-9]{24}$/);
});

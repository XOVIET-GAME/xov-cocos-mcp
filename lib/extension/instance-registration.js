'use strict';

// Builds the extension registration payload for the Gateway. Kept separate so
// the extension host can construct a consistent identity across the control
// channel and the existing browser.js runtime context.

const crypto = require('crypto');

function createExtensionId() {
  if (typeof crypto.randomUUID === 'function') {
    return 'ext-' + crypto.randomUUID();
  }
  return 'ext-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function createEditorInstanceId(seed) {
  const source = String(seed || (typeof process !== 'undefined' && process.pid) || 'editor');
  return 'editor-' + crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
}

// Builds registration params from the extension runtime context.
function buildRegistration({ extensionName, editorInstanceId, projectIdentity, projectPath, cocosVersion, capabilities, pid, metadata, generation, role }) {
  const editorId = editorInstanceId || createEditorInstanceId(projectPath || pid);
  return {
    editorInstanceId: editorId,
    projectId: projectIdentity || crypto.createHash('sha256').update(String(projectPath || '')).digest('hex').slice(0, 24),
    ownerExtensionId: extensionName || 'funplay-cocos-mcp',
    ownerInstanceId: createExtensionId(),
    cocosVersion: cocosVersion || 'unknown',
    capabilities: Array.isArray(capabilities) ? capabilities : ['scene', 'asset', 'preview', 'screenshot'],
    pid: Number(pid) || (typeof process !== 'undefined' ? process.pid : 0),
    metadata: metadata || {},
    generation: generation === undefined ? 1 : generation,
    role: role || undefined,
  };
}

module.exports = {
  createExtensionId,
  createEditorInstanceId,
  buildRegistration,
};

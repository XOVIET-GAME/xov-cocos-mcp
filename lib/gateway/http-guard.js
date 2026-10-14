'use strict';

const os = require('os');
const { createMessageId } = require('./extension-protocol');
const { safeEqualToken } = require('./auth');
const {
  getStatePath,
  isProcessAlive,
  readState,
} = require('./process-manager');

function createControlSessionId() {
  return createMessageId('conn').replace(/[^a-zA-Z0-9-]/g, '');
}

function createServerInstanceId() {
  return os.hostname() + '-' + process.pid + '-' + Date.now().toString(36);
}

function isLoopbackHost(host) {
  const normalized = String(host || '').replace(/^\[([^\]]+)\]$/, '$1').toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '::ffff:127.0.0.1';
}

function isAuthorized(request, token) {
  const header = request.headers && (request.headers.authorization || request.headers.Authorization);
  return typeof header === 'string' && header.startsWith('Bearer ') && safeEqualToken(header.slice('Bearer '.length), token);
}

function isSafeLoopbackRequest(request) {
  const hostHeader = request.headers && request.headers.host;
  if (typeof hostHeader !== 'string' || !hostHeader) return false;
  let host;
  try {
    host = new URL('http://' + hostHeader);
  } catch (error) {
    return false;
  }
  if (host.username || host.password || !isLoopbackHost(host.hostname.toLowerCase())) return false;

  const origin = request.headers && request.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string' || origin === 'null') return false;
  try {
    const parsedOrigin = new URL(origin);
    return (parsedOrigin.protocol === 'http:' || parsedOrigin.protocol === 'https:')
      && !parsedOrigin.username && !parsedOrigin.password
      && parsedOrigin.pathname === '/' && !parsedOrigin.search && !parsedOrigin.hash
      && isLoopbackHost(parsedOrigin.hostname.toLowerCase());
  } catch (error) {
    return false;
  }
}

function isReadOnlyPermission(permission) {
  if (Array.isArray(permission)) return permission.includes('read-only') && !permission.includes('write');
  const normalized = String(permission || '').trim().toLowerCase();
  return normalized === 'read-only' || normalized === 'readonly' || normalized === 'read';
}

// Keep control transports and other process-local handles out of the public
// health response. The CLI uses this read-only projection for targets list and
// target health; command routing remains an internal Gateway concern.
function serializeTarget(instance) {
  return {
    targetId: instance.targetId,
    editorInstanceId: instance.editorInstanceId,
    projectId: instance.projectId,
    status: instance.status,
    role: instance.role,
    generation: instance.generation,
    ownerExtensionId: instance.ownerExtensionId,
    ownerInstanceId: instance.ownerInstanceId,
    cocosVersion: instance.cocosVersion,
    capabilities: Array.isArray(instance.capabilities) ? instance.capabilities.slice() : [],
    pid: instance.pid,
    metadata: instance.metadata || {},
    registeredAt: instance.registeredAt,
    lastSeenAt: instance.lastSeenAt,
  };
}

function loadOwnership(ownershipDir, override) {
  if (override) {
    return Object.assign({}, override);
  }
  const state = readState(ownershipDir);
  if (!state || !state.ownerExtensionId || !state.ownerInstanceId) {
    return null;
  }
  if (state.pid && Number(state.pid) !== process.pid && !isProcessAlive(state.pid)) {
    return null;
  }
  return {
    ownerExtensionId: state.ownerExtensionId,
    ownerInstanceId: state.ownerInstanceId,
    launchNonce: state.launchNonce || '',
    autoStartedByExtension: state.autoStartedByExtension !== false,
    statePath: getStatePath(ownershipDir),
    ownershipDir,
  };
}

module.exports = {
  createControlSessionId,
  createServerInstanceId,
  isAuthorized,
  isLoopbackHost,
  isReadOnlyPermission,
  isSafeLoopbackRequest,
  loadOwnership,
  serializeTarget,
};

'use strict';

// Protocol for the bidirectional control channel between a Cocos Creator
// extension (client) and the Gateway daemon (server).
//
// Phase 0 covers lifecycle primitives only:
//   instance.register / instance.heartbeat / instance.unregister
//
// Phase 1 adds command.request / command.result for tool forwarding. The
// method names, envelope shape, and message ids below are the stable contract
// for later phases to build on.

const crypto = require('crypto');

const PROTOCOL_VERSION = '0.1.0';
const PROTOCOL_NAME = 'cocos-gateway-control';

const VALID_LIFECYCLE_METHODS = new Set([
  'instance.register',
  'instance.heartbeat',
  'instance.unregister',
]);

// Phase 1 command channel methods. The Gateway forwards MCP tools/call messages
// to a registered extension as command.request; the extension executes the tool
// inside the Cocos Editor context and returns command.result.
const VALID_COMMAND_METHODS = new Set([
  'command.request',
  'command.result',
  'command.cancel',
]);

const GATEWAY_SERVER_KIND = 'cocos-gateway';

// Prefix for request/response ids. Every message on the control channel is a
// JSON-RPC 2.0 request with an id so the peer can correlate the response.
function createMessageId(prefix) {
  const randomPart =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix || 'msg'}-${randomPart}`;
}

function isValidId(id) {
  return typeof id === 'string' || typeof id === 'number';
}

// Builds a JSON-RPC 2.0 request envelope for the control channel.
function createRequest(id, method, params) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: params || {},
  };
}

function createResponse(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result: result === undefined ? null : result,
  };
}

function createError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return {
    jsonrpc: '2.0',
    id,
    error,
  };
}

// Distinguishes requests, responses, and notifications in JSON-RPC 2.0.
function classify(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
    return 'invalid';
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  if (typeof message.method === 'string') {
    return hasId ? 'request' : 'notification';
  }
  if (hasId && (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'))) {
    return 'response';
  }
  return 'invalid';
}

// Validates the params of a lifecycle method.
// Returns null when the params are valid, otherwise an Error-like object with
// a `code` and a `message`.
function validateLifecycleParams(method, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { code: -32602, message: `Invalid params for ${method}: expected an object.` };
  }

  if (method === 'instance.register') {
    if (!params.editorInstanceId || typeof params.editorInstanceId !== 'string') {
      return { code: -32602, message: "Invalid params for instance.register: 'editorInstanceId' (string) is required." };
    }
    if (!params.projectId || typeof params.projectId !== 'string') {
      return { code: -32602, message: "Invalid params for instance.register: 'projectId' (string) is required." };
    }
    return null;
  }

  if (method === 'instance.heartbeat') {
    if (!params.editorInstanceId || typeof params.editorInstanceId !== 'string') {
      return { code: -32602, message: "Invalid params for instance.heartbeat: 'editorInstanceId' (string) is required." };
    }
    return null;
  }

  if (method === 'instance.unregister') {
    if (!params.editorInstanceId || typeof params.editorInstanceId !== 'string') {
      return { code: -32602, message: "Invalid params for instance.unregister: 'editorInstanceId' (string) is required." };
    }
    if (!params.sessionToken || typeof params.sessionToken !== 'string') {
      return { code: -32602, message: "Invalid params for instance.unregister: 'sessionToken' (string) is required." };
    }
    return null;
  }

  return { code: -32601, message: `Method not found: ${method}` };
}

// Maps a protocol error to a JSON-RPC response for a rejected request.
function errorFromValidation(id, validation) {
  return createError(id, validation.code, validation.message);
}

module.exports = {
  PROTOCOL_VERSION,
  PROTOCOL_NAME,
  GATEWAY_SERVER_KIND,
  VALID_LIFECYCLE_METHODS,
  VALID_COMMAND_METHODS,
  createMessageId,
  createRequest,
  createResponse,
  createError,
  classify,
  isValidId,
  validateLifecycleParams,
  errorFromValidation,
};

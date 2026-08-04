'use strict';

// MCP Streamable HTTP front door for the central Gateway.
//
// Phase 1 brings the Gateway's public MCP surface online: agents connect over
// Streamable HTTP and speak MCP to this front door. The front door preserves
// the protocol negotiation, request classification, structured errors,
// notifications, and tool schemas established by the existing
// lib/server.js MCP server:
//
//   - MCP-Protocol-Version header negotiation with initialize
//   - JSON-RPC request / notification / response classification
//   - structured JSON-RPC 2.0 errors
//   - notifications/* accepted (including notifications/initialized)
//   - initialize returns serverInfo + capabilities
//
// tools/list and tools/call are delegated to a dispatcher supplied by the
// Gateway (see GatewayServer.createMcpFrontDoor). The front door stays
// transport-agnostic: it reads the request body, produces a response body or
// null (for notifications), and lets the caller write the HTTP response.

const crypto = require('crypto');

const MCP_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = [
  MCP_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

class McpFrontDoor {
  constructor(options = {}) {
    this.serverName = options.serverName || 'funplay-cocos-mcp-gateway';
    this.serverVersion = options.serverVersion || '0.4.5';
    this.projectName = options.projectName || '';
    this.enableSessions = options.enableSessions !== false;
    this.dispatcher = options.dispatcher || null;
    this.logger = options.logger || { log() {} };
    this.sessions = new Set();
    this.negotiatedProtocolVersion = MCP_PROTOCOL_VERSION;
  }

  log(level, message) {
    if (this.logger && typeof this.logger.log === 'function') {
      this.logger.log(level, '[mcp-front-door] ' + message);
    }
  }

  isRunning() {
    return true;
  }

  getPort() {
    return null;
  }

  getSessionId(request) {
    const value = request.headers && (request.headers['mcp-session-id'] || request.headers['Mcp-Session-Id']);
    if (Array.isArray(value)) {
      return value[0] || '';
    }
    return value ? String(value) : '';
  }

  createSessionId() {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return crypto.randomBytes(16).toString('hex');
  }

  getSession(request) {
    return this.getSessionId(request);
  }

  // Entry point for a single MCP message. Returns { statusCode, headers,
  // body } where body is null for notification-only responses (HTTP 202).
  async handleMessage(request, rpc, responseHeaders, context = {}) {
    const headers = responseHeaders || {};

    if (!this.enableSessions && rpc && rpc.method === 'notifications/initialized') {
      return { statusCode: 202, headers, body: null };
    }

    const messageType = this.classifyJsonRpcMessage(rpc);
    if (messageType === 'response') {
      return { statusCode: 202, headers, body: null };
    }

    if (messageType === 'notification') {
      const notificationError = this.handleRpcNotification(rpc);
      if (notificationError) {
        return this.respondError(rpc && rpc.id, notificationError, headers);
      }
      return { statusCode: 202, headers, body: null };
    }

    if (messageType !== 'request') {
      return this.respondError(rpc && rpc.id, this.createError(-32600, 'Invalid Request'), headers);
    }

    const result = await this.handleRpcRequest(request, rpc, context);
    if (result == null) {
      return { statusCode: 202, headers, body: null };
    }

    const extraHeaders = Object.assign({}, headers);
    if (this.enableSessions && rpc.method === 'initialize' && result && !result.error) {
      const sessionId = this.createSessionId();
      this.sessions.add(sessionId);
      extraHeaders['Mcp-Session-Id'] = sessionId;
    }

    return { statusCode: 200, headers: extraHeaders, body: result };
  }

  respondError(id, errorPayload, baseHeaders) {
    return {
      statusCode: 200,
      headers: baseHeaders || {},
      body: this.createError(id, errorPayload.code, errorPayload.message),
    };
  }

  createError(id, code, message, data) {
    const error = { code, message };
    if (data !== undefined) {
      error.data = data;
    }
    return {
      jsonrpc: '2.0',
      id: id === undefined ? null : id,
      error,
    };
  }

  createResult(id, result) {
    return {
      jsonrpc: '2.0',
      id,
      result,
    };
  }

  classifyJsonRpcMessage(message) {
    if (!message || message.jsonrpc !== '2.0') {
      return 'invalid';
    }
    if (typeof message.method === 'string') {
      return Object.prototype.hasOwnProperty.call(message, 'id') ? 'request' : 'notification';
    }
    if (
      Object.prototype.hasOwnProperty.call(message, 'id') &&
      (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'))
    ) {
      return 'response';
    }
    return 'invalid';
  }

  handleRpcNotification(notification) {
    if (!notification || notification.jsonrpc !== '2.0' || typeof notification.method !== 'string') {
      return this.createError(-32600, 'Invalid Request');
    }
    if (notification.method.startsWith('notifications/')) {
      return null;
    }
    return this.createError(-32601, 'Notification method not found: ' + notification.method);
  }

  async handleRpcRequest(request, rpc, context = {}) {
    if (!rpc || rpc.jsonrpc !== '2.0') {
      return this.createError(request && request.id, -32600, 'Invalid Request');
    }

    const method = rpc.method;
    if (typeof method !== 'string' || !method) {
      return this.createError(rpc.id, -32600, 'Invalid Request: method is required');
    }

    if (method === 'initialize') {
      this.negotiatedProtocolVersion = this.negotiateProtocolVersion(rpc.params && rpc.params.protocolVersion);
      return this.createResult(rpc.id, {
        protocolVersion: this.negotiatedProtocolVersion,
        serverInfo: {
          name: this.serverName,
          version: this.serverVersion,
        },
        funplay: {
          server: 'funplay-cocos-mcp-gateway',
          projectName: this.projectName,
        },
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      });
    }

    if (method.startsWith('notifications/')) {
      return null;
    }

    if (method === 'tools/list') {
      return this.handleToolsList(rpc, context);
    }

    if (method === 'tools/call') {
      return this.handleToolsCall(rpc, context);
    }

    if (method === 'resources/list') {
      const resources = this.dispatcher && typeof this.dispatcher.listResources === 'function'
        ? await this.dispatcher.listResources(rpc, context)
        : [];
      return this.createResult(rpc.id, { resources });
    }

    if (method === 'resources/templates/list') {
      const resourceTemplates = this.dispatcher && typeof this.dispatcher.listResourceTemplates === 'function'
        ? await this.dispatcher.listResourceTemplates(rpc, context)
        : [];
      return this.createResult(rpc.id, { resourceTemplates });
    }

    if (method === 'resources/read') {
      if (!this.dispatcher || typeof this.dispatcher.readResource !== 'function') {
        return this.createError(rpc.id, -32001, 'Gateway resource dispatcher is not available.');
      }
      return this.dispatcher.readResource(rpc, context);
    }

    if (method === 'prompts/list') {
      return this.createResult(rpc.id, { prompts: [] });
    }

    return this.createError(rpc.id, -32601, 'Method not found: ' + method);
  }

  async handleToolsList(rpc, context = {}) {
    if (!this.dispatcher || typeof this.dispatcher.listTools !== 'function') {
      return this.createResult(rpc.id, { tools: [] });
    }
    const tools = await this.dispatcher.listTools(rpc, context);
    return this.createResult(rpc.id, { tools });
  }

  async handleToolsCall(rpc, context = {}) {
    if (!this.dispatcher || typeof this.dispatcher.callTool !== 'function') {
      return this.createError(rpc.id, -32001, 'Gateway tool dispatcher is not available.');
    }
    return this.dispatcher.callTool(rpc, context);
  }

  negotiateProtocolVersion(clientVersion) {
    if (SUPPORTED_PROTOCOL_VERSIONS.includes(clientVersion)) {
      return clientVersion;
    }
    return MCP_PROTOCOL_VERSION;
  }
}

module.exports = {
  McpFrontDoor,
  MCP_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  SUPPORTED_MCP_PROTOCOL_VERSIONS: SUPPORTED_PROTOCOL_VERSIONS,
};

'use strict';

// The central Gateway MCP server. Phase 0 provides an HTTP JSON-RPC control
// endpoint that accepts lifecycle messages from Cocos extensions over a
// persistent bidirectional control channel:
//
//   GET  /health              -> liveness, ownership, workload counts
//   POST /control             -> instance.register / instance.heartbeat /
//                                 instance.unregister (JSON-RPC 2.0)
//   POST /control?session=<id> -> subsequent control messages on a channel
//
// Phase 1 adds the MCP front door for agents:
//
//   GET  /mcp                 -> MCP Streamable HTTP session endpoint
//   POST /mcp                 -> initialize / notifications / tools/list /
//                                 tools/call (JSON-RPC 2.0 over Streamable HTTP)
//
// tools/call is routed to a registered Cocos extension as command.request over
// the control channel; the extension executes the tool inside the Cocos Editor
// context and returns command.result, which the Gateway correlates by request id
// back to the originating MCP request.
//
// The Gateway does NOT expose start/stop/ensure commands to cocos-cli. Only a
// Cocos extension launcher may start it detached.

const http = require('http');
const path = require('path');
const {
  GATEWAY_SERVER_KIND,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  createError,
} = require('./extension-protocol');
const { TargetRegistry } = require('./target-registry');
const { LifecycleManager } = require('./lifecycle-manager');
const { SessionRegistry } = require('./session-registry');
const { LockManager } = require('./lock-manager');
const { Scheduler } = require('./scheduler');
const { ConflictDetector } = require('./conflict-detector');
const { IdempotencyStore } = require('./idempotency-store');
const { JobManager } = require('./job-manager');
const { AuditLog } = require('./audit-log');
const { GatewayMetrics } = require('./metrics');
const { RateLimiter } = require('./rate-limiter');
const {
  McpFrontDoor,
  MCP_PROTOCOL_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
} = require('./mcp-front-door');
const {
  DEFAULT_OWNERSHIP_DIR,
  resolveOwnershipDir,
} = require('./process-manager');
const { attachControlWebSocketServer } = require('./control-websocket');
const {
  createControlSessionId,
  createServerInstanceId,
  isAuthorized,
  isLoopbackHost,
  isSafeLoopbackRequest,
  loadOwnership,
} = require('./http-guard');
const controlHandlers = require('./control-handlers');
const toolDispatch = require('./tool-dispatch');

const MAX_BODY_BYTES = 256 * 1024;

class GatewayServer {
  constructor(options = {}) {
    this.host = options.host || process.env.COCOS_GATEWAY_HOST || '127.0.0.1';
    const requestedPort = Number(options.port !== undefined ? options.port : process.env.COCOS_GATEWAY_PORT || 8787);
    this.port = Number.isFinite(requestedPort) ? requestedPort : 8787;
    this.authToken = String(options.authToken || process.env.COCOS_GATEWAY_AUTH_TOKEN || '');
    if (!isLoopbackHost(this.host) && !this.authToken && options.allowInsecureRemote !== true) {
      throw new Error('A Gateway auth token is required when binding outside localhost.');
    }
    this.ownershipDir = resolveOwnershipDir(options.ownershipDir || process.env.COCOS_GATEWAY_OWNERSHIP_DIR || DEFAULT_OWNERSHIP_DIR);
    this.autoStopWhenIdle = options.autoStopWhenIdle !== false;
    this.logger = options.logger || console;

    this.server = null;
    this.actualPort = null;
    this.startedAt = null;
    this.requestCount = 0;
    this.inFlightRequests = 0;
    this.serverInstanceId = options.serverInstanceId || process.env.COCOS_GATEWAY_SERVER_INSTANCE_ID || createServerInstanceId();
    this.ownership = loadOwnership(this.ownershipDir, options.ownershipOverride);
    this.controlSessions = new Map();
    this.controlWebSocket = null;
    this.sessions = options.sessionRegistry || new SessionRegistry();
    this.ownsLockManager = !options.lockManager;
    this.lockManager = options.lockManager || new LockManager(options.lockOptions);
    this.scheduler = options.scheduler || new Scheduler({
      lockManager: this.lockManager,
      logger: this.logger,
    });
    this.sessions.onStale = (session) => this.onAgentSessionStale(session);
    if (typeof this.sessions.start === 'function') this.sessions.start();
    this.conflicts = options.conflicts || new ConflictDetector();
    this.idempotency = options.idempotency || new IdempotencyStore();
    this.jobs = options.jobs || new JobManager();
    this.audit = options.audit || new AuditLog();
    this.metrics = options.metrics || new GatewayMetrics();
    this.rateLimiter = options.rateLimiter || new RateLimiter({ limit: options.rateLimitPerMinute || 0 });

    this.registry = options.registry || new TargetRegistry({
      statePath: options.targetStatePath || path.join(this.ownershipDir, 'targets.json'),
    });
    // Wire the stale scan to Gateway cleanup + idle auto-stop.
    if (typeof this.registry.onStaleCleanup !== 'function') {
      const originalRemoveStale = this.registry.removeStaleInstances.bind(this.registry);
      this.registry.removeStaleInstances = () => {
        const removed = originalRemoveStale();
        if (removed && removed.length > 0) {
          this.onStaleCleanup(removed).catch((error) => {
            this.log('error', 'Stale cleanup hook failed: ' + error.message);
          });
        }
        return removed;
      };
    }
    this.registry.start();

    this.lifecycle = options.lifecycle || new LifecycleManager({
      registry: this.registry,
      ownership: this.ownership,
      autoStopWhenIdle: this.autoStopWhenIdle,
      requestCounter: () => this.inFlightRequests,
      sessionCounter: () => this.sessions.count(),
      jobCounter: () => this.jobs.countActive(),
      logger: this.logger,
      onAutoStop: () => this.autoStop('idle-policy'),
    });

    // Phase 1 MCP front door and command dispatch.
    // Control transports are resolved per target so tests can inject mocks and
    // the real WebSocket control channel can be used in production.
    this.transportFor = options.transportFor || null;
    // Track in-flight command requests: pendingRequestId -> MCP request id so a
    // command.result can be correlated back to the originating tools/call.
    this.pendingCommands = new Map();
    this.commandSeq = 0;
    this.mcpFrontDoor = options.mcpFrontDoor || new McpFrontDoor({
      serverName: options.mcpServerName || 'funplay-cocos-mcp-gateway',
      serverVersion: options.mcpServerVersion,
      projectName: options.projectName,
      enableSessions: options.mcpEnableSessions,
      dispatcher: this.createMcpDispatcher(),
      logger: this.logger,
    });
  }

  checkLoopbackRequest(request) {
    if (isSafeLoopbackRequest(request)) return true;
    const headers = request.headers || {};
    this.log('warn', 'Rejected request: Host=' + JSON.stringify(headers.host) + ' Origin=' + JSON.stringify(headers.origin)
      + '. Set COCOS_GATEWAY_ALLOWED_ORIGINS to allow a trusted Origin.');
    return false;
  }

  isRunning() {
    return Boolean(this.server && this.server.listening);
  }

  getPort() {
    if (this.actualPort) {
      return this.actualPort;
    }
    if (this.server && typeof this.server.address === 'function') {
      const address = this.server.address();
      if (address && typeof address.port === 'number') {
        return address.port;
      }
    }
    return this.port;
  }

  log(level, message) {
    const method = this.logger && typeof this.logger.log === 'function' ? this.logger.log : console.log;
    method(level, message);
  }

  async start() {
    if (this.isRunning()) {
      this.log('info', 'Gateway start skipped: already running.');
      return this.getPort();
    }
    this.startedAt = new Date().toISOString();
    this.requestCount = 0;

    const requestHandler = async (request, response) => {
      this.requestCount += 1;
      try {
        const requestUrl = new URL(request.url || '/', 'http://localhost');
        this.metrics.increment('http_requests_total');

        // Health checks are monitoring traffic, not workload; they do not
        // count toward in-flight request pressure or block idle auto-stop.
        if (request.method === 'GET' && requestUrl.pathname === '/health') {
          return this.handleHealth(response, requestUrl.searchParams.get('targetId') || '');
        }

        if (isLoopbackHost(this.host)
          && (requestUrl.pathname === '/mcp' || requestUrl.pathname === '/control')
          && !this.checkLoopbackRequest(request)) {
          return this.json(response, 403, createError(null, -32043, 'FORBIDDEN: loopback Gateway rejects non-loopback Host or Origin.'));
        }

        if (this.authToken && !isAuthorized(request, this.authToken)) {
          return this.json(response, 401, createError(null, -32040, 'AUTH_REQUIRED: valid Gateway bearer token required.'), undefined, {
            'WWW-Authenticate': 'Bearer',
          });
        }

        const rate = this.rateLimiter.allow(request.socket && request.socket.remoteAddress || 'unknown');
        if (!rate.allowed) {
          return this.json(response, 429, createError(null, -32029, 'RATE_LIMITED: Gateway request rate exceeded.', {
            code: 'RATE_LIMITED',
            retryAfterMs: rate.retryAfterMs,
          }), undefined, { 'Retry-After': String(Math.ceil(rate.retryAfterMs / 1000)) });
        }

        this.inFlightRequests += 1;
        let completed = false;
        const finish = () => {
          if (!completed) {
            completed = true;
            this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
          }
        };
        const originalEnd = response.end;
        response.end = function patchedEnd(...args) {
          const result = originalEnd.apply(this, args);
          finish();
          return result;
        };
        response.on('close', finish);

        if (request.method === 'POST' && requestUrl.pathname === '/control') {
          const sessionId = requestUrl.searchParams.get('session') || '';
          const body = await this.readBody(request);
          if (!body) {
            return this.json(response, 400, createError(null, -32700, 'Parse error: empty body'));
          }
          let message;
          try {
            message = JSON.parse(body);
          } catch (error) {
            return this.json(response, 400, createError(null, -32700, 'Parse error: ' + error.message));
          }
          return this.handleControlMessage(response, message, sessionId);
        }

        if (requestUrl.pathname === '/mcp') {
          if (request.method === 'GET') {
            return this.handleMcpGet(response);
          }
          if (request.method === 'POST') {
            const body = await this.readBody(request);
            if (!body) {
              return this.json(response, 400, createError(null, -32700, 'Parse error: empty body'));
            }
            let message;
            try {
              message = JSON.parse(body);
            } catch (error) {
              return this.json(response, 400, createError(null, -32700, 'Parse error: ' + error.message));
            }
            return this.handleMcpPost(response, request, message);
          }
          if (request.method === 'DELETE') {
            return this.handleMcpDelete(response, request);
          }
          return this.json(response, 405, createError(null, -32600, 'Method not allowed: ' + request.method));
        }

        if (request.method === 'GET' && requestUrl.pathname === '/metrics') {
          return this.json(response, 200, this.metrics.snapshot());
        }

        if (request.method === 'GET' && requestUrl.pathname === '/') {
          return this.json(response, 200, {
            ok: true,
            server: PROTOCOL_NAME,
            kind: GATEWAY_SERVER_KIND,
            protocolVersion: PROTOCOL_VERSION,
            mcpProtocolVersion: MCP_PROTOCOL_VERSION,
            health: '/health',
            control: '/control',
            mcp: '/mcp',
          });
        }

        return this.json(response, 404, createError(null, -32601, 'Not found: ' + request.method + ' ' + requestUrl.pathname));
      } catch (error) {
        this.log('error', 'Gateway request failed: ' + error.message);
        const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
        const errorCode = statusCode === 413 ? -32030 : -32603;
        return this.json(response, statusCode, createError(null, errorCode, statusCode === 413
          ? 'REQUEST_TOO_LARGE: ' + error.message
          : 'Internal error: ' + error.message));
      }
    };

    const server = http.createServer(requestHandler);
    this.controlWebSocket = attachControlWebSocketServer(server, {
      path: '/control',
      authToken: this.authToken,
      validateRequest: isLoopbackHost(this.host) ? (request) => this.checkLoopbackRequest(request) : undefined,
      onConnection: (channel, message) => this.handleWebSocketMessage(channel, message),
      onClose: (channel) => this.handleWebSocketClose(channel),
    });
    await this.listen(server, this.port, this.host);
    this.server = server;
    this.actualPort = server.address() && typeof server.address().port === 'number'
      ? server.address().port
      : this.port;
    this.log('info', 'Gateway listening on http://' + this.host + ':' + this.actualPort + '/ (id=' + this.serverInstanceId + ').');
    return this.actualPort;
  }

  async stop() {
    this.registry.stop();
    if (this.sessions && typeof this.sessions.stop === 'function') this.sessions.stop();
    if (this.ownsLockManager && this.lockManager) this.lockManager.close();
    if (this.controlWebSocket) {
      this.controlWebSocket.close();
      this.controlWebSocket = null;
    }
    if (!this.server) {
      return;
    }
    const active = this.server;
    this.server = null;
    this.actualPort = null;
    await new Promise((resolve) => {
      active.close(() => resolve());
    });
    this.log('info', 'Gateway stopped.');
  }

  // Idle auto-stop is applied here so later phases can register hooks before
  // the process exits. When an external shutdown reason arrives, onAutoStop
  // may also be wired to process.exit.
  async autoStop(reason) {
    this.log('info', 'Gateway auto-stop triggered: ' + reason + '.');
    await this.stop();
  }

  // GET /mcp — MCP Streamable HTTP session endpoint. The Gateway does not keep
  // separate session state in Phase 1 (that is Phase 3), but the endpoint is
  // present so a session-capable client can negotiate.
  handleMcpGet(response) {
    const sessionId = this.mcpFrontDoor.createSessionId();
    this.mcpFrontDoor.sessions.add(sessionId);
    this.log('info', 'GET /mcp: opened MCP session ' + sessionId + '.');
    return this.json(response, 200, {
      ok: true,
      protocolVersion: MCP_PROTOCOL_VERSION,
      sessionId,
    });
  }

  // POST /mcp — single MCP message handling. Notifications return HTTP 202 with
  // an empty body; requests return HTTP 200 with a JSON-RPC response.
  async handleMcpPost(response, request, message) {
    const sessionId = this.mcpFrontDoor.getSession(request);
    const responseProtocolVersion = this.getMcpResponseProtocolVersion(request, message);
    const context = {
      sessionId: sessionId || '',
      agentId: request.headers && (request.headers['x-agent-id'] || request.headers['mcp-agent-id'] || ''),
      permissions: request.headers && (request.headers['x-agent-permissions'] || request.headers['mcp-agent-permissions'] || ''),
    };
    const result = await this.mcpFrontDoor.handleMessage(request, message, {
      'MCP-Protocol-Version': responseProtocolVersion,
    }, context);
    const effectiveSessionId = result.headers && (result.headers['Mcp-Session-Id'] || result.headers['mcp-session-id'])
      ? (result.headers['Mcp-Session-Id'] || result.headers['mcp-session-id'])
      : sessionId;
    if (effectiveSessionId) {
      this.sessions.ensure(effectiveSessionId, {
        agentId: context.agentId || effectiveSessionId,
        mcpSessionId: effectiveSessionId,
      });
      this.sessions.touch(effectiveSessionId);
      context.sessionId = effectiveSessionId;
    }
    if (result.body == null) {
      return this.empty(response, result.statusCode, responseProtocolVersion);
    }
    return this.json(response, result.statusCode, result.body, responseProtocolVersion, result.headers);
  }

  handleMcpDelete(response, request) {
    const sessionId = this.mcpFrontDoor.getSession(request);
    const session = this.sessions.get(sessionId);
    if (session) {
      this.scheduler.disconnect(session.agentId);
      this.sessions.remove(sessionId);
    }
    return this.empty(response, 204);
  }

  onAgentSessionStale(session) {
    if (!session) return;
    this.scheduler.disconnect(session.agentId);
    this.audit.record({ event: 'agent.session.stale', agentId: session.agentId, requestId: '', targetId: '' });
    this.log('info', 'Removed stale agent session ' + session.sessionId + '.');
  }

  getMcpResponseProtocolVersion(request, rpc) {
    if (rpc && rpc.method === 'initialize') {
      return this.mcpFrontDoor.negotiatedProtocolVersion;
    }
    const header = request.headers && request.headers['mcp-protocol-version'];
    const version = Array.isArray(header) ? header[0] : header ? String(header) : '';
    if (SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(version)) {
      return version;
    }
    return this.mcpFrontDoor.negotiatedProtocolVersion;
  }

  // Builds the tool dispatcher handed to the MCP front door. tools/list
  // aggregates schemas across registered Editor targets; tools/call routes to a
  // registered extension and correlates the command.result by request id.
  createMcpDispatcher() {
    const gateway = this;
    return {
      listTools: async (rpc, context) => gateway.listTargetTools(rpc, context),
      callTool: async (rpc, context) => gateway.dispatchMcpToolCall(rpc, context),
      listResources: async () => gateway.listTargetResources(),
      listResourceTemplates: async () => gateway.listTargetResourceTemplates(),
      readResource: async (rpc) => gateway.readResource(rpc),
    };
  }

  listen(server, port, host) {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let exceeded = false;
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          exceeded = true;
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => {
        if (exceeded) {
          const error = new Error('Request body exceeds ' + MAX_BODY_BYTES + ' bytes.');
          error.statusCode = 413;
          reject(error);
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      request.on('error', reject);
    });
  }

  json(response, statusCode, payload, _protocolVersion, extraHeaders) {
    response.writeHead(statusCode, Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8' },
      extraHeaders || {}
    ));
    response.end(JSON.stringify(payload));
  }

  empty(response, statusCode, _protocolVersion, extraHeaders) {
    response.writeHead(statusCode, extraHeaders || {});
    response.end();
  }
}

Object.assign(GatewayServer.prototype, controlHandlers);
Object.assign(GatewayServer.prototype, toolDispatch);

module.exports = {
  GatewayServer,
  createControlSessionId,
  createServerInstanceId,
  loadOwnership,
};

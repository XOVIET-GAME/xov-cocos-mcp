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
const os = require('os');
const {
  GATEWAY_SERVER_KIND,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  classify,
  createError,
  createResponse,
  createRequest,
  createMessageId,
  isValidId,
  validateLifecycleParams,
  errorFromValidation,
} = require('./extension-protocol');
const { TargetRegistry } = require('./target-registry');
const { LifecycleManager } = require('./lifecycle-manager');
const { SessionRegistry } = require('./session-registry');
const { LockManager } = require('./lock-manager');
const { Scheduler } = require('./scheduler');
const { ConflictDetector } = require('./conflict-detector');
const { IdempotencyStore, requestFingerprint } = require('./idempotency-store');
const { JobManager } = require('./job-manager');
const { getToolPolicy } = require('./tool-policies');
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
  getStatePath,
  isProcessAlive,
  readState,
  resolveOwnershipDir,
} = require('./process-manager');
const { attachControlWebSocketServer } = require('./control-websocket');
const { safeEqualToken } = require('./auth');

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
          && !isSafeLoopbackRequest(request)) {
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
      validateRequest: isLoopbackHost(this.host) ? isSafeLoopbackRequest : undefined,
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

  listTargetResources() {
    return this.registry.list().flatMap((target) => [
      {
        uri: 'cocos://targets/' + encodeURIComponent(target.targetId) + '/state',
        name: target.targetId + ' state',
        description: 'Current state for Cocos Editor target ' + target.targetId,
        mimeType: 'application/json',
      },
      {
        uri: 'cocos://targets/' + encodeURIComponent(target.targetId) + '/logs',
        name: target.targetId + ' logs',
        description: 'Recent logs for Cocos Editor target ' + target.targetId,
        mimeType: 'text/plain',
      },
    ]);
  }

  listTargetResourceTemplates() {
    return [
      { uriTemplate: 'cocos://targets/{targetId}/state', name: 'Target state', mimeType: 'application/json' },
      { uriTemplate: 'cocos://targets/{targetId}/logs', name: 'Target logs', mimeType: 'text/plain' },
      { uriTemplate: 'cocos://projects/{projectId}/locks', name: 'Project locks', mimeType: 'application/json' },
    ];
  }

  readResource(rpc) {
    const uri = rpc.params && rpc.params.uri ? String(rpc.params.uri) : '';
    if (uri.startsWith('cocos://targets/')) {
      const parts = uri.split('/');
      const targetId = decodeURIComponent(parts[3] || '');
      const target = this.registry.getByTargetId(targetId);
      if (!target) return createError(rpc.id, -32001, 'TARGET_UNAVAILABLE: ' + targetId + ' is not registered.');
      if (parts[4] === 'state') {
        return this.createMcpResult(rpc.id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(serializeTarget(target)) }] });
      }
      if (parts[4] === 'logs') {
        return this.createMcpResult(rpc.id, { contents: [{ uri, mimeType: 'text/plain', text: 'Target logs are available through the connected Editor extension.' }] });
      }
    }
    if (uri.startsWith('cocos://projects/') && uri.endsWith('/locks')) {
      return this.createMcpResult(rpc.id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(this.lockManager.status()) }] });
    }
    return createError(rpc.id, -32001, 'Resource not found: ' + uri);
  }

  // Aggregates tool schemas from registered targets. When no Editor target is
  // registered, the Gateway reports an unavailable tool surface so agents can
  // distinguish "no editor connected" from an empty tool list.
  async listTargetTools() {
    const targets = this.registry.list().filter((target) => target.status === 'online');
    if (targets.length === 0) {
      return this.adminToolSchemas(true);
    }
    const tools = [];
    for (const target of targets) {
      const schemas = await this.requestTargetTools(target);
      if (schemas && Array.isArray(schemas.tools)) {
        for (const tool of schemas.tools) {
          tools.push(tool);
        }
      }
    }
    return tools.concat(this.adminToolSchemas(false));
  }

  adminToolSchemas(unavailable) {
    const empty = { type: 'object', properties: {}, additionalProperties: false };
    return [
      { name: 'cocos_targets', description: unavailable ? 'List Cocos Editor targets. unavailable because no Editor is registered.' : 'List Cocos Editor targets attached to this Gateway.', inputSchema: empty },
      { name: 'cocos_target_health', description: 'Read the health and capabilities of one Cocos Editor target.', inputSchema: { type: 'object', properties: { targetId: { type: 'string' } }, required: ['targetId'] } },
      { name: 'cocos_lock_status', description: 'Read Gateway lock and scheduler state.', inputSchema: empty },
      { name: 'cocos_job_status', description: 'List long-running Gateway jobs.', inputSchema: empty },
      { name: 'cocos_audit', description: 'Read Gateway request audit events.', inputSchema: { type: 'object', properties: { limit: { type: 'integer' }, targetId: { type: 'string' }, agentId: { type: 'string' } } } },
      { name: 'cocos_cancel', description: 'Cancel an active Gateway request or job.', inputSchema: { type: 'object', properties: { requestId: { type: 'string' }, jobId: { type: 'string' } } } },
    ];
  }

  // Sends a tools/list command to a single target over its control transport.
  async requestTargetTools(target) {
    const transport = this.getTargetTransport(target);
    if (!transport) {
      return { tools: [] };
    }
    const id = createMessageId('tools');
    let response;
    try {
      response = await transport.request(
        this.getGatewayUrl(),
        createRequest(id, 'tools/list', {}),
        target.connectionId
      );
    } catch (error) {
      this.registry.markOffline(target.editorInstanceId, target.generation);
      return { tools: [] };
    }
    if (!response || response.error) {
      return { tools: [] };
    }
    return response.result || { tools: [] };
  }

  // Resolves the control transport for a target. The gateway URL is derived
  // from the bound address so real control transports can be used.
  getGatewayUrl() {
    return 'http://' + this.host + ':' + this.getPort();
  }

  getTargetTransport(target) {
    if (target && target.transport) {
      return target.transport;
    }
    if (typeof this.transportFor === 'function') {
      return this.transportFor(target);
    }
    return null;
  }

  // Routes an MCP tools/call to a registered Editor target as command.request.
  // Returns the MCP result built from the correlated command.result, or a
  // structured error when no target / multiple targets are available.
  async dispatchMcpToolCall(rpc, context = {}) {
    const params = rpc.params || {};
    const idempotencyKey = typeof params.idempotencyKey === 'string' ? params.idempotencyKey : '';
    if (!idempotencyKey) return this.dispatchMcpToolCallOnce(rpc, context);
    const fingerprint = requestFingerprint({
      name: params.name,
      arguments: params.arguments || {},
      targetId: params.targetId || '',
      projectId: params.projectId || '',
      expectedRevision: params.expectedRevision,
    });
    const result = await this.idempotency.execute(
      idempotencyKey,
      fingerprint,
      () => this.dispatchMcpToolCallOnce(rpc, context)
    );
    return result && result.id !== rpc.id ? { ...result, id: rpc.id } : result;
  }

  async dispatchMcpToolCallOnce(rpc, context = {}) {
    const params = rpc.params || {};
    if (typeof params.name !== 'string' || !params.name) {
      return createError(rpc.id, -32602, "Invalid params: 'name' is required");
    }
    this.metrics.increment('mcp_tool_calls_total');

    const admin = this.dispatchAdminTool(rpc, context);
    if (admin) return admin;

    const session = context.sessionId ? this.sessions.ensure(context.sessionId, {
      agentId: context.agentId || context.sessionId,
      mcpSessionId: context.sessionId,
      permissions: context.permissions || undefined,
    }) : null;
    const explicitTargetId = typeof params.targetId === 'string' ? params.targetId : '';
    const target = this.resolveToolTarget(params.name, {
      targetId: explicitTargetId || (session && session.pinnedTargetId) || '',
      projectId: typeof params.projectId === 'string' ? params.projectId : '',
    });
    if (target.error) {
      return createError(rpc.id, target.error.code, target.error.message, target.error.data);
    }

    const commandArguments = params.arguments || {};
    const policy = getToolPolicy(params.name, {
      ...commandArguments,
      targetId: target.instance.targetId,
      editorInstanceId: target.instance.editorInstanceId,
      projectId: target.instance.projectId,
    });
    if (session && isReadOnlyPermission(session.permissions) && policy.access !== 'read') {
      return createError(rpc.id, -32014, 'PERMISSION_DENIED: this agent session is read-only.', {
        code: 'PERMISSION_DENIED',
        permission: 'read-only',
      });
    }
    if (policy.requiredCapability && Array.isArray(target.instance.capabilities)
      && target.instance.capabilities.length > 0
      && !target.instance.capabilities.includes(policy.requiredCapability)) {
      return createError(rpc.id, -32016, 'CAPABILITY_UNAVAILABLE: target ' + target.instance.targetId + ' does not advertise ' + policy.requiredCapability + '.', {
        code: 'CAPABILITY_UNAVAILABLE',
        targetId: target.instance.targetId,
        capability: policy.requiredCapability,
      });
    }
    if (policy.access !== 'read' && target.instance.role !== 'primary-writer') {
      return createError(rpc.id, -32013, 'PRIMARY_WRITER_REQUIRED: target ' + target.instance.targetId + ' is read-only for project ' + target.instance.projectId + '.', {
        code: 'PRIMARY_WRITER_REQUIRED',
        targetId: target.instance.targetId,
        projectId: target.instance.projectId,
      });
    }
    const expectedRevision = params.expectedRevision !== undefined
      ? params.expectedRevision
      : commandArguments.expectedRevision;
    if (policy.access !== 'read') {
      const conflict = this.checkRequestConflicts(target.instance, policy, expectedRevision);
      if (conflict) {
        return createError(rpc.id, -32012, conflict.message, {
          code: conflict.code,
          expected: conflict.expected,
          actual: conflict.actual,
        });
      }
    }

    const commandId = this.createCommandId();
    const mcpId = rpc.id;
    this.audit.record({ event: 'request.started', requestId: commandId, mcpRequestId: mcpId, agentId: session && session.agentId, targetId: target.instance.targetId, toolName: params.name });
    const job = policy.scope === 'long-running'
      ? this.jobs.create({ ownerId: session ? session.agentId : 'mcp:' + String(mcpId), targetId: target.instance.targetId, toolName: params.name })
      : null;
    if (session) {
      this.sessions.addRequest(session.sessionId, commandId, {
        toolName: params.name,
        targetId: target.instance.targetId,
      });
      if (explicitTargetId) this.sessions.pin(session.sessionId, explicitTargetId);
    }
    this.pendingCommands.set(commandId, { mcpId, toolName: params.name, createdAt: Date.now() });

    const forwardedArguments = { ...commandArguments };
    delete forwardedArguments.targetId;
    delete forwardedArguments.idempotencyKey;
    delete forwardedArguments.expectedRevision;
    const editorArguments = {
      ...forwardedArguments,
      projectId: target.instance.projectId,
    };
    const commandRequest = createRequest(commandId, 'command.request', {
      requestId: commandId,
      tool: {
        name: params.name,
        arguments: editorArguments,
      },
      mcpRequestId: mcpId,
      targetId: target.instance.targetId,
      generation: target.instance.generation,
      deadline: new Date(Date.now() + policy.timeoutMs).toISOString(),
      jobId: job ? job.jobId : undefined,
    });

    let response;
    try {
      response = await this.scheduler.run({
        requestId: commandId,
        ownerId: session ? session.agentId : 'mcp:' + String(mcpId),
        toolName: params.name,
        arguments: editorArguments,
        targetId: target.instance.targetId,
        policy,
        execute: () => this.sendCommand(target.instance, commandRequest),
        onCancel: () => this.cancelCommand(target.instance, commandRequest),
      });
    } catch (error) {
      this.pendingCommands.delete(commandId);
      this.audit.record({ event: 'request.failed', requestId: commandId, mcpRequestId: mcpId, agentId: session && session.agentId, targetId: target.instance.targetId, toolName: params.name, errorCode: error.code || 'COMMAND_DISPATCH_FAILED' });
      if (job) this.jobs.fail(job.jobId, error);
      if (error.code === 'TARGET_UNAVAILABLE' || error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') {
        this.registry.markOffline(target.instance.editorInstanceId, target.instance.generation);
      }
      const errorCode = error.code === 'LOCK_TIMEOUT' ? -32010 : error.code === 'REQUEST_TIMEOUT' ? -32011 : error.code === 'REQUEST_CANCELLED' ? -32015 : -32003;
      return createError(mcpId, errorCode, error.code ? error.code + ': ' + error.message : 'Command dispatch failed: ' + error.message, {
        code: error.code || 'COMMAND_DISPATCH_FAILED',
      });
    } finally {
      // The pending entry is a correlation hint for out-of-band transports. The
      // authoritative correlation is the commandId on the command.result below.
      this.pendingCommands.delete(commandId);
      if (session) this.sessions.removeRequest(session.sessionId, commandId);
    }

    if (!response) {
      return createError(mcpId, -32001, 'No command.result received from target ' + target.instance.editorInstanceId + '.');
    }

    // Correlate the command.result by request id back to this MCP request. A
    // mismatched or missing id means the extension answered a different (or
    // stale) command.
    const resultCommandId = response.result && (response.result.requestId || response.result.commandId);
    if (response.id !== undefined && String(response.id) !== String(commandId)) {
      return createError(mcpId, -32003, 'Command result id mismatch: expected ' + commandId + ', got ' + response.id + '.');
    }
    if (resultCommandId !== undefined && String(resultCommandId) !== String(commandId)) {
      return createError(mcpId, -32003, 'Command result requestId mismatch: expected ' + commandId + ', got ' + resultCommandId + '.');
    }

    this.log('info', 'Correlated command.result ' + commandId + ' -> MCP ' + String(mcpId) + ' (' + params.name + ').');
    const execute = async () => {
      const result = this.buildCommandResult(mcpId, response);
      this.audit.record({
        event: result.error || (result.result && result.result.isError) ? 'request.failed' : 'request.completed',
        requestId: commandId,
        mcpRequestId: mcpId,
        agentId: session && session.agentId,
        targetId: target.instance.targetId,
        toolName: params.name,
      });
      if (job) {
        if (result.error || (result.result && result.result.isError)) this.jobs.fail(job.jobId, result.error || new Error('Job failed.'));
        else this.jobs.complete(job.jobId, result.result);
      }
      if (policy.access !== 'read') {
        const revisions = this.commitRequestRevisions(target.instance, policy, response.result || response.error || null);
        const editorRevision = revisions.find((item) => item.scope === 'editor');
        if (result.result && typeof result.result === 'object') {
          if (editorRevision) result.result.revision = editorRevision.revision;
          if (revisions.length > 1) {
            result.result.revisions = Object.fromEntries(revisions.map((item) => [item.name, {
              revision: item.revision,
              hash: item.hash,
            }]));
          }
        }
      }
      return result;
    };
    return execute();
  }

  dispatchAdminTool(rpc, context = {}) {
    const params = rpc.params || {};
    const name = params.name;
    if (name === 'cocos_targets') {
      return this.createMcpResult(rpc.id, { content: [{ type: 'text', text: JSON.stringify(this.registry.list().map(serializeTarget)) }], structuredContent: { targets: this.registry.list().map(serializeTarget) } });
    }
    if (name === 'cocos_target_health') {
      const targetId = params.arguments && params.arguments.targetId;
      const target = this.registry.getByTargetId(targetId);
      if (!target) return createError(rpc.id, -32001, 'TARGET_UNAVAILABLE: ' + String(targetId || 'target') + ' is not registered.', { code: 'TARGET_UNAVAILABLE', targetId });
      return this.createMcpResult(rpc.id, { content: [{ type: 'text', text: JSON.stringify(serializeTarget(target)) }], structuredContent: { target: serializeTarget(target) } });
    }
    if (name === 'cocos_lock_status') {
      return this.createMcpResult(rpc.id, { content: [{ type: 'text', text: JSON.stringify(this.lockManager.status()) }], structuredContent: this.lockManager.status() });
    }
    if (name === 'cocos_job_status') {
      const jobs = this.jobs.list();
      return this.createMcpResult(rpc.id, { content: [{ type: 'text', text: JSON.stringify(jobs) }], structuredContent: { jobs } });
    }
    if (name === 'cocos_audit') {
      const args = params.arguments || {};
      const events = this.audit.list(args);
      return this.createMcpResult(rpc.id, { content: [{ type: 'text', text: JSON.stringify(events) }], structuredContent: { events } });
    }
    if (name === 'cocos_cancel') {
      const args = params.arguments || {};
      const cancelled = args.requestId ? this.scheduler.cancel(args.requestId) : args.jobId ? Boolean(this.jobs.cancel(args.jobId)) : false;
      return this.createMcpResult(rpc.id, { content: [{ type: 'text', text: JSON.stringify({ cancelled }) }], structuredContent: { cancelled } });
    }
    return null;
  }

  // Sends a command.request to a target over its control transport. The
  // extension executes the tool inside the Cocos Editor context and answers
  // with a command.result whose id (or result.requestId) matches the request id.
  async sendCommand(instance, message) {
    const transport = this.getTargetTransport(instance);
    if (!transport) {
      const error = new Error('Target ' + instance.editorInstanceId + ' has no control transport.');
      error.code = 'TARGET_UNAVAILABLE';
      throw error;
    }
    return transport.request(this.getGatewayUrl(), message, instance.connectionId);
  }

  async cancelCommand(instance, message) {
    const transport = this.getTargetTransport(instance);
    if (!transport || typeof transport.send !== 'function') return false;
    const cancel = createRequest(createMessageId('cancel'), 'command.cancel', {
      requestId: message && message.params && message.params.requestId,
      targetId: instance.targetId,
      generation: instance.generation,
    });
    await transport.send(this.getGatewayUrl(), cancel, instance.connectionId);
    this.audit.record({
      event: 'request.cancel.sent',
      requestId: message && message.params && message.params.requestId,
      mcpRequestId: message && message.params && message.params.mcpRequestId,
      targetId: instance.targetId,
      toolName: message && message.params && message.params.tool && message.params.tool.name,
    });
    return true;
  }

  getConflictResources(instance, policy) {
    const resources = [{ name: 'editor:' + instance.targetId, scope: 'editor', id: instance.targetId }];
    for (const resource of policy && Array.isArray(policy.resources) ? policy.resources : []) {
      const name = String(resource && resource.name || '');
      if (!name || resources.some((item) => item.name === name)) continue;
      const separator = name.indexOf(':');
      resources.push({
        name,
        scope: separator >= 0 ? name.slice(0, separator) : name,
        id: separator >= 0 ? name.slice(separator + 1) : 'current',
      });
    }
    return resources;
  }

  expectedRevisionForResource(expected, resource) {
    if (expected === undefined || expected === null || expected === '') return undefined;
    if (resource.scope === 'editor' && (typeof expected !== 'object' || Array.isArray(expected))) {
      return expected;
    }
    if (typeof expected !== 'object' || Array.isArray(expected)) return undefined;
    if (expected.scope && expected.id
      && String(expected.scope) === resource.scope
      && String(expected.id) === resource.id) {
      return expected;
    }
    if (resource.scope === 'editor' && expected.editor !== undefined) return expected.editor;
    const maps = [expected.resources, expected.revisions];
    for (const map of maps) {
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
      if (map[resource.name] !== undefined) return map[resource.name];
      if (map[resource.scope + ':' + resource.id] !== undefined) return map[resource.scope + ':' + resource.id];
    }
    // A plain { revision, hash } object is the backwards-compatible Editor
    // revision form used before resource-level revisions were added.
    return resource.scope === 'editor' && Object.prototype.hasOwnProperty.call(expected, 'revision')
      ? expected
      : undefined;
  }

  checkRequestConflicts(instance, policy, expected) {
    for (const resource of this.getConflictResources(instance, policy)) {
      const expectedForResource = this.expectedRevisionForResource(expected, resource);
      const conflict = this.conflicts.check(resource.scope, resource.id, expectedForResource);
      if (conflict) return conflict;
    }
    return null;
  }

  commitRequestRevisions(instance, policy, value) {
    return this.getConflictResources(instance, policy).map((resource) => ({
      ...resource,
      ...this.conflicts.commit(resource.scope, resource.id, value),
    }));
  }

  // Builds the MCP tools/call result from a command.result.
  buildCommandResult(mcpId, commandResult) {
    if (commandResult.error) {
      return createError(mcpId, commandResult.error.code || -32603, commandResult.error.message || 'Command failed');
    }
    const result = commandResult.result || {};
    const content = [];
    if (result.error) {
      content.push({ type: 'text', text: String(result.error) });
      return this.createMcpResult(mcpId, { content, isError: true, structuredContent: result.value });
    }
    content.push({
      type: 'text',
      text: typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2),
    });
    return this.createMcpResult(mcpId, { content, structuredContent: result.value });
  }

  createMcpResult(id, result) {
    return {
      jsonrpc: '2.0',
      id,
      result,
    };
  }

  createCommandId() {
    this.commandSeq += 1;
    return 'cmd-' + this.commandSeq + '-' + Date.now().toString(36);
  }

  // Resolves an online target using explicit targetId first, then project
  // affinity and finally the single-target fallback. Multiple matches are
  // rejected instead of being selected randomly.
  resolveToolTarget(toolName, { targetId = '', projectId = '' } = {}) {
    const targets = this.registry.list().filter((instance) => instance.status === 'online');
    if (targets.length === 0) {
      return {
        error: {
          code: -32001,
          message: 'No Cocos Editor target is available. Open a Cocos Creator project with the Funplay extension enabled.',
        },
      };
    }
    if (targetId) {
      const explicit = targets.find((instance) => instance.targetId === targetId || instance.editorInstanceId === targetId);
      if (!explicit) {
        return {
          error: {
            code: -32001,
            message: 'TARGET_UNAVAILABLE: No online Cocos Editor target matches ' + targetId + '.',
            data: { targetId },
          },
        };
      }
      return { instance: explicit };
    }
    const scoped = projectId ? targets.filter((instance) => instance.projectId === projectId) : targets;
    if (projectId && scoped.length === 0) {
      return {
        error: {
          code: -32001,
          message: 'TARGET_UNAVAILABLE: No online Cocos Editor target belongs to project ' + projectId + '.',
          data: { code: 'TARGET_UNAVAILABLE', projectId },
        },
      };
    }
    const primary = projectId ? scoped.find((instance) => instance.role === 'primary-writer') : null;
    if (primary) {
      return { instance: primary };
    }
    if (scoped.length === 1) {
      return { instance: scoped[0] };
    }
    if (scoped.length > 1) {
      return {
        error: {
          code: -32001,
          message: 'TARGET_AMBIGUOUS: Multiple Cocos Editor targets match tool ' + toolName + '. Provide an explicit targetId.',
          data: {
            code: 'TARGET_AMBIGUOUS',
            targets: scoped.map((instance) => instance.editorInstanceId),
            projectIds: scoped.map((instance) => instance.projectId),
          },
        },
      };
    }
    return { instance: targets[0] };
  }

  handleHealth(response, targetId = '') {
    const workload = this.lifecycle.activeWorkload();
    const targets = this.registry.list().map((instance) => serializeTarget(instance));
    const payload = {
      ok: true,
      kind: GATEWAY_SERVER_KIND,
      protocolName: PROTOCOL_NAME,
      protocolVersion: PROTOCOL_VERSION,
      serverInstanceId: this.serverInstanceId,
      pid: process.pid,
      host: this.host,
      port: this.getPort(),
      startedAt: this.startedAt,
      ownership: this.ownership
        ? {
            ownerExtensionId: this.ownership.ownerExtensionId,
            ownerInstanceId: this.ownership.ownerInstanceId,
            launchNonce: this.ownership.launchNonce,
            autoStartedByExtension: this.ownership.autoStartedByExtension,
          }
        : null,
      autoStopWhenIdle: this.autoStopWhenIdle,
      canAutoStop: this.lifecycle.shouldAutoStop(),
      instances: workload.instances,
      sessions: workload.sessions,
      jobs: workload.jobs,
      activeRequests: workload.activeRequests,
      auditEvents: this.audit.size(),
      targets,
      uptimeMs: this.startedAt ? Date.now() - new Date(this.startedAt).getTime() : 0,
    };
    if (targetId) {
      payload.target = targets.find((target) => target.targetId === targetId || target.editorInstanceId === targetId) || null;
    }
    return this.json(response, 200, payload);
  }

  async handleControlMessage(response, message, sessionId) {
    const kind = classify(message);

    if (kind === 'request') {
      if (!isValidId(message.id)) {
        return this.json(response, 400, createError(null, -32600, 'Invalid Request: id is required'));
      }
      const result = await this.dispatchLifecycleRequest(message, sessionId);
      const sent = this.json(response, 200, result);
      // The response flush decrements in-flight before we evaluate idle
      // auto-stop, so the unregister request itself cannot block it. We
      // evaluate unconditionally: shouldAutoStop() re-checks the live registry
      // and in-flight counts, so a failed or non-terminal unregister is a
      // no-op, while the last simultaneous unregister wins the race.
      if (message.method === 'instance.unregister') {
        await this.lifecycle.maybeAutoStop('last-instance-unregistered');
      }
      return sent;
    }

    if (kind === 'notification') {
      return this.empty(response, 202);
    }

    if (kind === 'response') {
      if (this.isCommandResult(message)) {
        this.handleCommandResult(message);
      }
      return this.empty(response, 202);
    }

    return this.json(response, 400, createError(message && message.id, -32600, 'Invalid Request'));
  }

  // WebSocket control channels carry lifecycle requests and command results
  // on the same persistent connection. The channel object owns correlation
  // for Gateway -> extension requests; this handler only answers lifecycle
  // requests initiated by the extension.
  async handleWebSocketMessage(channel, message) {
    const kind = classify(message);
    if (kind === 'request') {
      if (!isValidId(message.id)) {
        return channel.send(createError(null, -32600, 'Invalid Request: id is required'));
      }
      const result = await this.dispatchLifecycleRequest(message, channel.sessionId || '', channel);
      if (message.method === 'instance.register' && result && result.result) {
        channel.sessionId = result.result.sessionId || result.result.connectionId || '';
        channel.connectionId = result.result.connectionId || channel.sessionId;
      }
      channel.send(result);
      if (message.method === 'instance.unregister') {
        await this.lifecycle.maybeAutoStop('last-instance-unregistered');
      }
      return result;
    }
    if (kind === 'notification') return null;
    // Responses are consumed by ControlWebSocketConnection before reaching
    // this method, so an unexpected response is harmless.
    return null;
  }

  handleWebSocketClose(channel) {
    const sessionId = channel && channel.sessionId;
    const session = sessionId ? this.controlSessions.get(sessionId) : null;
    if (!session) return;
    const current = this.registry.get(session.editorInstanceId);
    // A stale connection must never mark a newer generation offline.
    if (current && current.connectionId === session.connectionId) {
      this.registry.markOffline(session.editorInstanceId, current.generation);
    }
    this.controlSessions.delete(sessionId);
  }

  // Whether a control-channel response is a command.result (the extension's
  // answer to a Gateway command.request).
  isCommandResult(message) {
    return Boolean(
      message
      && Object.prototype.hasOwnProperty.call(message, 'result')
      && message.result
      && typeof message.result === 'object'
      && (message.result.requestId !== undefined || message.result.commandId !== undefined || message.result.tool !== undefined)
    );
  }

  // Records a command.result so dispatchMcpToolCall can correlate it. The
  // transport.request promise is resolved by the transport itself; this method
  // exists so future WebSocket transports can deliver results out-of-band.
  handleCommandResult(message) {
    const commandId = message.id || (message.result && (message.result.requestId || message.result.commandId));
    if (!commandId) {
      return;
    }
    const pending = this.pendingCommands.get(commandId);
    if (!pending) {
      this.log('warn', 'command.result for unknown request id ' + commandId + ' ignored.');
      return;
    }
    this.log('info', 'Correlated command.result ' + commandId + ' -> MCP ' + String(pending.mcpId) + ' (' + pending.toolName + ').');
    this.pendingCommands.delete(commandId);
  }

  async dispatchLifecycleRequest(message, sessionId, transport) {
    const method = message.method;
    const id = message.id;
    const params = message.params || {};

    const validation = validateLifecycleParams(method, params);
    if (validation) {
      return errorFromValidation(id, validation);
    }

    if (method === 'instance.register') {
      return this.handleRegister(id, params, transport);
    }

    if (method === 'instance.heartbeat') {
      return this.handleHeartbeat(id, params);
    }

    if (method === 'instance.unregister') {
      return this.handleUnregister(id, params, sessionId);
    }

    return createError(id, -32601, 'Method not found: ' + method);
  }

  async handleRegister(id, params, transport) {
    const connectionId = createControlSessionId();
    const sessionId = connectionId;
    this.controlSessions.set(sessionId, {
      connectionId,
      editorInstanceId: params.editorInstanceId,
      createdAt: new Date().toISOString(),
      channel: transport || null,
    });
    const instance = this.registry.register({
      editorInstanceId: params.editorInstanceId,
      projectId: params.projectId,
      connectionId,
      generation: params.generation,
      ownerExtensionId: params.ownerExtensionId,
      ownerInstanceId: params.ownerInstanceId,
      cocosVersion: params.cocosVersion,
      capabilities: params.capabilities,
      pid: params.pid,
      metadata: params.metadata,
      transport: transport || params.transport || null,
      role: params.role,
    });
    this.log('info', 'Registered editor instance ' + params.editorInstanceId + ' (connection=' + connectionId + ').');
    return createResponse(id, {
      ok: true,
      connectionId,
      sessionId,
      serverInstanceId: this.serverInstanceId,
      protocolVersion: PROTOCOL_VERSION,
      heartbeatIntervalMs: this.registry.ttlMs / 2,
      registeredAt: instance.registeredAt,
      targetId: instance.targetId,
    });
  }

  async handleHeartbeat(id, params) {
    const current = this.registry.get(params.editorInstanceId);
    if (current && params.generation && current.generation && String(params.generation) !== String(current.generation)) {
      return createError(id, -32002, 'Generation does not match the current Editor connection.');
    }
    const instance = this.registry.heartbeat(params.editorInstanceId, params.generation);
    if (!instance) {
      return createError(id, -32001, 'Unknown editor instance: ' + params.editorInstanceId);
    }
    return createResponse(id, {
      ok: true,
      lastSeenAt: instance.lastSeenAt,
      status: instance.status,
    });
  }

  async handleUnregister(id, params, sessionId) {
    const instance = this.registry.get(params.editorInstanceId);
    if (!instance) {
      return createResponse(id, { ok: false, reason: 'unknown-instance' });
    }

    if (sessionId && instance.connectionId && sessionId !== instance.connectionId) {
      this.log('warn', 'Unregister denied: session token mismatch for ' + params.editorInstanceId + '.');
      return createError(id, -32002, 'Session token does not match the current connection.');
    }
    if (params.generation && instance.generation && String(params.generation) !== String(instance.generation)) {
      return createError(id, -32002, 'Generation does not match the current Editor connection.');
    }

    const removed = this.registry.unregister(params.editorInstanceId);
    const sessionToken = this.findControlSession(params.editorInstanceId);
    if (sessionToken) {
      this.controlSessions.delete(sessionToken);
    }

    this.log('info', 'Unregistered editor instance ' + params.editorInstanceId + ' (reason=' + (params.reason || 'unknown') + ').');
    // The current unregister request is still counted in-flight while this
    // response is built, so evaluate eligibility assuming it completes.
    const canAutoStop = Boolean(
      this.ownership && this.ownership.autoStartedByExtension
      && this.autoStopWhenIdle
      && this.registry.count() === 0
      && this.lifecycle.sessionCount === 0
      && this.lifecycle.jobCount === 0
      && this.inFlightRequests <= 1
    );
    return createResponse(id, {
      ok: true,
      removed: Boolean(removed),
      canAutoStop,
    });
  }

  // Called by the idle scanner after stale instances are removed.
  async onStaleCleanup(removed) {
    if (!removed || removed.length === 0) {
      return;
    }
    for (const instance of removed) {
      const sessionToken = this.findControlSession(instance.editorInstanceId);
      if (sessionToken) {
        this.controlSessions.delete(sessionToken);
      }
    }
    await this.lifecycle.maybeAutoStop('stale-cleanup');
  }

  findControlSession(editorInstanceId) {
    for (const [sessionId, info] of this.controlSessions) {
      if (info && info.editorInstanceId === editorInstanceId) {
        return sessionId;
      }
    }
    return null;
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

function createControlSessionId() {
  const { createMessageId } = require('./extension-protocol');
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
  GatewayServer,
  createControlSessionId,
  createServerInstanceId,
  loadOwnership,
};

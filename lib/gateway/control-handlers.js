'use strict';

const {
  GATEWAY_SERVER_KIND,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  classify,
  createError,
  createResponse,
  errorFromValidation,
  isValidId,
  validateLifecycleParams,
} = require('./extension-protocol');
const {
  createControlSessionId,
  serializeTarget,
} = require('./http-guard');

const controlHandlers = {
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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

  findControlSession(editorInstanceId) {
    for (const [sessionId, info] of this.controlSessions) {
      if (info && info.editorInstanceId === editorInstanceId) {
        return sessionId;
      }
    }
    return null;
  },
};

module.exports = controlHandlers;

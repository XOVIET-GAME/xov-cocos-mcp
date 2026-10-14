'use strict';

const {
  createError,
  createMessageId,
  createRequest,
} = require('./extension-protocol');
const { requestFingerprint } = require('./idempotency-store');
const { getToolPolicy } = require('./tool-policies');
const {
  isReadOnlyPermission,
  serializeTarget,
} = require('./http-guard');

const toolDispatch = {
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
  },

  listTargetResourceTemplates() {
    return [
      { uriTemplate: 'cocos://targets/{targetId}/state', name: 'Target state', mimeType: 'application/json' },
      { uriTemplate: 'cocos://targets/{targetId}/logs', name: 'Target logs', mimeType: 'text/plain' },
      { uriTemplate: 'cocos://projects/{projectId}/locks', name: 'Project locks', mimeType: 'application/json' },
    ];
  },

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
  },

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
  },

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
  },

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
  },

  // Resolves the control transport for a target. The gateway URL is derived
  // from the bound address so real control transports can be used.
  getGatewayUrl() {
    return 'http://' + this.host + ':' + this.getPort();
  },

  getTargetTransport(target) {
    if (target && target.transport) {
      return target.transport;
    }
    if (typeof this.transportFor === 'function') {
      return this.transportFor(target);
    }
    return null;
  },

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
  },

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
  },

  dispatchAdminTool(rpc, _context = {}) {
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
  },

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
  },

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
  },

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
  },

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
  },

  checkRequestConflicts(instance, policy, expected) {
    for (const resource of this.getConflictResources(instance, policy)) {
      const expectedForResource = this.expectedRevisionForResource(expected, resource);
      const conflict = this.conflicts.check(resource.scope, resource.id, expectedForResource);
      if (conflict) return conflict;
    }
    return null;
  },

  commitRequestRevisions(instance, policy, value) {
    return this.getConflictResources(instance, policy).map((resource) => ({
      ...resource,
      ...this.conflicts.commit(resource.scope, resource.id, value),
    }));
  },

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
  },

  createMcpResult(id, result) {
    return {
      jsonrpc: '2.0',
      id,
      result,
    };
  },

  createCommandId() {
    this.commandSeq += 1;
    return 'cmd-' + this.commandSeq + '-' + Date.now().toString(36);
  },

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
  },
};

module.exports = toolDispatch;

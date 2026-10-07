'use strict';

// Extension-side Gateway client. The Cocos extension opens an outbound
// bidirectional control channel to the Gateway, registers its editor instance,
// heartbeats, unregisters on shutdown, and reconnects after channel loss.
//
// This module also contains the ONLY internal launcher that may start the
// Gateway detached (single-flight, ownership-aware). cocos-cli never calls
// this module.

const crypto = require('crypto');
const path = require('path');
const {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  createMessageId,
  createRequest,
  classify,
} = require('../gateway/extension-protocol');
const {
  acquireLaunchLock,
  checkHealth,
  DEFAULT_OWNERSHIP_DIR,
  getStatePath,
  getLockPath,
  isPortInUse,
  launchDetached,
  readState,
  releaseLaunchLock,
  resolveOwnershipDir,
  waitForHealthy,
} = require('../gateway/process-manager');

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8787';
const DEFAULT_HEARTBEAT_INTERVAL_MS = 4000;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 250;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 5000;

function defaultLogger() {
  const noop = () => {};
  return {
    log: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
}

class GatewayClient {
  constructor(options = {}) {
    this.gatewayUrl = String(options.gatewayUrl || process.env.COCOS_GATEWAY_URL || DEFAULT_GATEWAY_URL);
    this.authToken = String(options.authToken || process.env.COCOS_GATEWAY_AUTH_TOKEN || '');
    this.ownershipDir = resolveOwnershipDir(options.ownershipDir || process.env.COCOS_GATEWAY_OWNERSHIP_DIR || DEFAULT_OWNERSHIP_DIR);
    this.entryPoint = options.entryPoint || path.resolve(__dirname, '..', 'gateway', 'daemon-entry.js');
    this.nodeExecutable = options.nodeExecutable || process.env.COCOS_GATEWAY_NODE_EXECUTABLE || '';

    this.ownerExtensionId = options.ownerExtensionId || 'funplay-cocos-mcp';
    this.ownerInstanceId = options.ownerInstanceId || 'ext-' + createId();
    this.editorInstanceId = options.editorInstanceId || 'editor-' + createId();
    this.projectId = options.projectId || '';
    this.cocosVersion = options.cocosVersion || 'unknown';
    this.capabilities = options.capabilities || ['scene', 'asset', 'preview', 'screenshot'];
    this.pid = options.pid || process.pid;
    this.metadata = options.metadata || {};

    this.heartbeatIntervalMs = options.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs || DEFAULT_RECONNECT_BASE_DELAY_MS;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs || DEFAULT_RECONNECT_MAX_DELAY_MS;
    this.autoStart = options.autoStart !== false;
    this.autoStopWhenIdle = options.autoStopWhenIdle !== false;
    this.launchTimeoutMs = options.launchTimeoutMs || 15000;
    this.logger = options.logger || defaultLogger();

    this.connectionId = '';
    this.sessionId = '';
    this.generation = 0;
    this.registered = false;
    this.running = false;
    this.reconnectAttempt = 0;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.startPromise = null;
    this.transport = options.transport || null;
    this.channel = null;
    this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;
    this.onCommandRequest = typeof options.onCommandRequest === 'function' ? options.onCommandRequest : null;
    this.onCommandCancel = typeof options.onCommandCancel === 'function' ? options.onCommandCancel : null;
    this.onToolsList = typeof options.onToolsList === 'function' ? options.onToolsList : null;
  }

  get state() {
    return {
      gatewayUrl: this.gatewayUrl,
      running: this.running,
      registered: this.registered,
      connected: Boolean(this.connectionId),
      connectionId: this.connectionId,
      sessionId: this.sessionId,
      generation: this.generation,
      editorInstanceId: this.editorInstanceId,
      reconnectAttempt: this.reconnectAttempt,
    };
  }

  log(level, message) {
    if (this.logger && typeof this.logger.log === 'function') {
      this.logger.log(level, '[gateway-client] ' + message);
    }
  }

  setState(patch) {
    Object.assign(this, patch);
    if (this.onStateChange) {
      try {
        this.onStateChange(this.state);
      } catch (error) {
        this.log('error', 'onStateChange callback failed: ' + error.message);
      }
    }
  }

  // Main entry: ensure the Gateway is live, then open the control channel and
  // register. Single-flight across concurrent callers within this process and
  // machine-level lock around the detached launch.
  async ensure() {
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this._ensure();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async _ensure() {
    this.running = true;

    const health = await this.ensureGatewayAvailable();
    if (!health) {
      this.running = false;
      const error = new Error('Gateway is not reachable at ' + this.gatewayUrl);
      error.code = 'GATEWAY_UNAVAILABLE';
      throw error;
    }
    this.gatewayInfo = health;

    await this.openControlChannel();
    return this.state;
  }

  // Health-check the Gateway, launch it detached (single-flight) if missing.
  async ensureGatewayAvailable() {
    const existing = await checkHealth(this.gatewayUrl, 1500);
    if (isCompatibleGatewayHealth(existing)) {
      return existing;
    }

    if (!this.autoStart) {
      return null;
    }

    return this.launchGatewayIfNeeded();
  }

  async launchGatewayIfNeeded() {
    // Machine-level single-flight: only one extension may be mid-launch.
    const lockPath = acquireLaunchLock(this.ownershipDir);
    try {
      // Re-check under the lock; another launcher may have just started it.
      const afterLock = await checkHealth(this.gatewayUrl, 1500);
      if (isCompatibleGatewayHealth(afterLock)) {
        return afterLock;
      }

      // If the port is already occupied by a foreign process, refuse to
      // launch a second Gateway (ownership-aware startup authority).
      const parsed = new URL(this.gatewayUrl);
      const occupied = await isPortInUse(parsed.hostname, parsed.port);
      if (occupied) {
        const error = new Error('Gateway port ' + parsed.port + ' is occupied by another process; not launching.');
        error.code = 'GATEWAY_PORT_CONFLICT';
        throw error;
      }

      const launched = launchDetached({
        entryPoint: this.entryPoint,
        nodeExecutable: this.nodeExecutable,
        ownershipDir: this.ownershipDir,
        ownerExtensionId: this.ownerExtensionId,
        ownerInstanceId: this.ownerInstanceId,
        env: {
          COCOS_GATEWAY_HOST: parsed.hostname,
          COCOS_GATEWAY_PORT: String(parsed.port),
        },
      });
      this.log('info', 'Launched detached Gateway pid=' + launched.pid + ' nonce=' + launched.launchNonce + '.');

      // Wait for the daemon to become healthy.
      const health = await waitForHealthy(this.gatewayUrl, { timeoutMs: this.launchTimeoutMs });
      if (!isCompatibleGatewayHealth(health)) {
        const error = new Error('Gateway did not become healthy after launch.');
        error.code = 'GATEWAY_LAUNCH_TIMEOUT';
        throw error;
      }
      return health;
    } finally {
      releaseLaunchLock(lockPath);
    }
  }

  async openControlChannel() {
    this.generation += 1;
    if (!this.channel && this.transport && typeof this.transport.connect === 'function') {
      this.channel = this.transport.connect(this.gatewayUrl, {
        onMessage: (message) => this.handleIncoming(message),
        onClose: () => this.handleChannelLost(),
        authToken: this.authToken,
      });
    }
    // Register with the Gateway. On success the response carries the control
    // session id used for subsequent heartbeat/unregister messages.
    const registerParams = {
      editorInstanceId: this.editorInstanceId,
      projectId: this.projectId,
      generation: this.generation,
      ownerExtensionId: this.ownerExtensionId,
      ownerInstanceId: this.ownerInstanceId,
      cocosVersion: this.cocosVersion,
      capabilities: this.capabilities,
      pid: this.pid,
      metadata: this.metadata,
      protocolVersion: PROTOCOL_VERSION,
    };
    const id = createMessageId('register');
    const response = await this.postControl(createRequest(id, 'instance.register', registerParams), '');

    if (!response || response.error) {
      const message = response && response.error ? response.error.message : 'no response';
      throw new Error('Gateway registration failed: ' + message);
    }
    if (!response.result || !response.result.connectionId) {
      throw new Error('Gateway registration returned no connectionId.');
    }

    this.connectionId = response.result.connectionId;
    this.sessionId = response.result.sessionId || response.result.connectionId;
    this.registered = true;
    this.reconnectAttempt = 0;
    if (this.onStateChange) {
      this.onStateChange(this.state);
    }
    this.startHeartbeat();
    this.log('info', 'Registered editor instance ' + this.editorInstanceId + ' connection=' + this.connectionId + '.');
    return response.result;
  }

  async postControl(message, sessionId) {
    const channel = this.channel || this.transport;
    if (!channel || typeof channel.request !== 'function') {
      throw new Error('No control transport configured for GatewayClient.');
    }
    return channel.request(this.gatewayUrl, message, sessionId);
  }

  async handleIncoming(message) {
    if (!message || typeof message.method !== 'string') return null;
    if (message.method === 'tools/list') {
      const tools = this.onToolsList ? await this.onToolsList(message) : [];
      return this.sendControlResponse({ jsonrpc: '2.0', id: message.id, result: { tools: tools || [] } });
    }
    if (message.method === 'command.cancel') {
      const requestId = message.params && (message.params.requestId || message.params.commandId);
      const cancelled = this.onCommandCancel ? await this.onCommandCancel(requestId, message) : false;
      return this.sendControlResponse({
        jsonrpc: '2.0',
        id: message.id,
        result: { requestId, cancelled: Boolean(cancelled) },
      });
    }
    if (message.method !== 'command.request') return null;
    if (typeof this.onCommandRequest !== 'function') {
      return this.sendControlResponse({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32001, message: 'Editor command executor is not configured.' },
      });
    }
    try {
      const result = await this.onCommandRequest(message);
      return this.sendControlResponse(result || {
        jsonrpc: '2.0', id: message.id, result: { ok: true },
      });
    } catch (error) {
      return this.sendControlResponse({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: error.code || -32603, message: error.message },
      });
    }
  }

  async sendControlResponse(message) {
    const channel = this.channel || this.transport;
    if (!channel || typeof channel.request !== 'function') return null;
    if (typeof channel.send === 'function') {
      await channel.send(this.gatewayUrl, message, this.sessionId);
      return null;
    }
    return channel.request(this.gatewayUrl, message, this.sessionId);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch((error) => {
        this.log('warn', 'Heartbeat failed: ' + error.message);
        this.handleChannelLost();
      });
    }, this.heartbeatIntervalMs);
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async heartbeat() {
    if (!this.registered) {
      return null;
    }
    const id = createMessageId('hb');
    const response = await this.postControl(
      createRequest(id, 'instance.heartbeat', { editorInstanceId: this.editorInstanceId, generation: this.generation }),
      this.sessionId
    );
    if (!response || response.error) {
      throw new Error(response && response.error ? response.error.message : 'heartbeat error');
    }
    return response.result;
  }

  async unregister(reason) {
    this.stopHeartbeat();
    this.clearReconnectTimer();
    if (!this.registered || !this.sessionId) {
      this.registered = false;
      this.connectionId = '';
      this.running = false;
      return { ok: false, reason: 'not-registered' };
    }
    try {
      const id = createMessageId('unreg');
      const response = await this.postControl(
        createRequest(id, 'instance.unregister', {
          editorInstanceId: this.editorInstanceId,
          sessionToken: this.sessionId,
          generation: this.generation,
          reason: reason || 'extension-shutdown',
        }),
        this.sessionId
      );
      return response && response.result ? response.result : { ok: false };
    } finally {
      this.registered = false;
      this.connectionId = '';
      this.sessionId = '';
      this.running = false;
      if (this.onStateChange) {
        this.onStateChange(this.state);
      }
    }
  }

  // Reconnect with exponential backoff after the control channel is lost.
  async handleChannelLost() {
    if (!this.running || this.reconnectTimer) {
      return;
    }
    this.stopHeartbeat();
    this.registered = false;
    this.connectionId = '';
    this.sessionId = '';
    this.channel = null;

    const attempt = this.reconnectAttempt;
    const delay = Math.min(this.reconnectMaxDelayMs, this.reconnectBaseDelayMs * Math.pow(2, attempt));
    this.log('warn', 'Control channel lost; reconnecting in ' + delay + 'ms (attempt ' + (attempt + 1) + ').');
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectAttempt += 1;
      try {
        await this.ensureGatewayAvailable();
        await this.openControlChannel();
        this.log('info', 'Reconnected to Gateway.');
      } catch (error) {
        this.log('warn', 'Reconnect failed: ' + error.message);
        if (this.running) {
          this.handleChannelLost();
        }
      }
    }, delay);
    if (this.reconnectTimer.unref) {
      this.reconnectTimer.unref();
    }
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async close() {
    this.running = false;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    try {
      await this.unregister('client-close');
    } catch (error) {
      this.log('warn', 'Unregister during close failed: ' + error.message);
    }
    if (this.channel && typeof this.channel.close === 'function') {
      await this.channel.close();
      this.channel = null;
    }
  }
}

function isCompatibleGatewayHealth(health) {
  return Boolean(
    health
    && health.ok
    && health.kind === 'cocos-gateway'
    && health.protocolName === PROTOCOL_NAME
    && health.protocolVersion === PROTOCOL_VERSION
  );
}

function createId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

module.exports = {
  GatewayClient,
  DEFAULT_GATEWAY_URL,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_RECONNECT_BASE_DELAY_MS,
  DEFAULT_RECONNECT_MAX_DELAY_MS,
  isCompatibleGatewayHealth,
  createId,
};

'use strict';

// Agent/session state owned by the central Gateway. MCP transport sessions are
// deliberately separate from Editor control sessions so each agent can pin a
// target, carry independent permissions, and be disconnected without touching
// another agent's requests or locks.

const crypto = require('crypto');

class SessionRegistry {
  constructor(options = {}) {
    this.sessions = new Map();
    this.defaultPermission = options.defaultPermission || 'read-write';
    this.ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : 120000;
    this.scanIntervalMs = Number.isFinite(options.scanIntervalMs) ? options.scanIntervalMs : 10000;
    this.onStale = typeof options.onStale === 'function' ? options.onStale : null;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.removeStale(), this.scanIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  create({ sessionId, agentId, mcpSessionId, permissions, metadata } = {}) {
    const id = sessionId || createSessionId();
    const session = {
      sessionId: id,
      agentId: agentId || id,
      mcpSessionId: mcpSessionId || id,
      permissions: permissions || this.defaultPermission,
      metadata: metadata || {},
      pinnedTargetId: '',
      activeRequests: new Map(),
      heldLocks: new Set(),
      cancelledRequests: new Set(),
      connected: true,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    this.sessions.set(id, session);
    return session;
  }

  get(sessionId) {
    return sessionId ? this.sessions.get(sessionId) || null : null;
  }

  ensure(sessionId, options = {}) {
    return this.get(sessionId) || this.create({ sessionId, ...options });
  }

  touch(sessionId) {
    const session = this.get(sessionId);
    if (session) {
      session.connected = true;
      session.lastSeenAt = new Date().toISOString();
    }
    return session;
  }

  pin(sessionId, targetId) {
    const session = this.get(sessionId);
    if (!session) return null;
    session.pinnedTargetId = targetId || '';
    session.lastSeenAt = new Date().toISOString();
    return session;
  }

  addRequest(sessionId, requestId, context = {}) {
    const session = this.ensure(sessionId);
    session.activeRequests.set(String(requestId), {
      requestId,
      startedAt: new Date().toISOString(),
      ...context,
    });
    return session;
  }

  removeRequest(sessionId, requestId) {
    const session = this.get(sessionId);
    if (!session) return false;
    return session.activeRequests.delete(String(requestId));
  }

  cancel(sessionId, requestId) {
    const session = this.get(sessionId);
    if (!session) return false;
    session.cancelledRequests.add(String(requestId));
    return session.activeRequests.has(String(requestId));
  }

  isCancelled(sessionId, requestId) {
    const session = this.get(sessionId);
    return Boolean(session && session.cancelledRequests.has(String(requestId)));
  }

  disconnect(sessionId) {
    const session = this.get(sessionId);
    if (!session) return null;
    session.connected = false;
    session.lastSeenAt = new Date().toISOString();
    return session;
  }

  remove(sessionId) {
    return this.sessions.delete(sessionId);
  }

  list() {
    return Array.from(this.sessions.values());
  }

  count() {
    return this.sessions.size;
  }

  removeStale(now = Date.now()) {
    const removed = [];
    for (const [sessionId, session] of this.sessions) {
      const lastSeen = new Date(session.lastSeenAt).getTime();
      if (session.activeRequests.size === 0 && Number.isFinite(lastSeen) && now - lastSeen > this.ttlMs) {
        this.sessions.delete(sessionId);
        removed.push(session);
        if (this.onStale) this.onStale(session);
      }
    }
    return removed;
  }

  activeRequestCount() {
    let count = 0;
    for (const session of this.sessions.values()) count += session.activeRequests.size;
    return count;
  }

  releaseSessionLocks(sessionId, release) {
    const session = this.get(sessionId);
    if (!session) return 0;
    const locks = Array.from(session.heldLocks);
    for (const lock of locks) {
      if (typeof release === 'function') release(lock, session);
      session.heldLocks.delete(lock);
    }
    return locks.length;
  }
}

function createSessionId() {
  const suffix = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  return 'agent-' + suffix;
}

module.exports = { SessionRegistry, createSessionId };

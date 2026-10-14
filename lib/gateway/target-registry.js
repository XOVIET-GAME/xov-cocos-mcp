'use strict';

const fs = require('fs');
const { writeFileAtomic } = require('../atomic-file');

// In-memory registry of Editor instances attached to the Gateway over control
// channels. Phase 0 manages lifecycle: register, heartbeat (TTL), unregister,
// stale cleanup. Phase 2 builds routing on top of this registry.

const STALE_INSTANCE_TTL_MS = 15000;
const DEFAULT_STALE_SCAN_INTERVAL_MS = 5000;

class TargetRegistry {
  constructor(options = {}) {
    this.ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : STALE_INSTANCE_TTL_MS;
    this.staleScanIntervalMs = Number.isFinite(options.staleScanIntervalMs)
      ? options.staleScanIntervalMs
      : DEFAULT_STALE_SCAN_INTERVAL_MS;
    this.instances = new Map();
    this.statePath = options.statePath || '';
    this.aliases = loadAliases(this.statePath);
    this._scanTimer = null;
    this._stopped = false;
  }

  start() {
    if (this._scanTimer || this._stopped) {
      return;
    }
    this._scanTimer = setInterval(() => this.removeStaleInstances(), this.staleScanIntervalMs);
    if (this._scanTimer.unref) {
      this._scanTimer.unref();
    }
  }

  stop() {
    this._stopped = true;
    if (this._scanTimer) {
      clearInterval(this._scanTimer);
      this._scanTimer = null;
    }
  }

  // Registers a new connection. Returns the stored instance descriptor.
  register({ editorInstanceId, projectId, connectionId, generation, ownerExtensionId, ownerInstanceId, cocosVersion, capabilities, pid, metadata, transport, role }) {
    if (!editorInstanceId || typeof editorInstanceId !== 'string') {
      const error = new Error("'editorInstanceId' (string) is required.");
      error.code = 'INVALID_INSTANCE_ID';
      throw error;
    }
    if (!projectId || typeof projectId !== 'string') {
      const error = new Error("'projectId' (string) is required.");
      error.code = 'INVALID_PROJECT_ID';
      throw error;
    }

    const now = Date.now();
    const previous = this.instances.get(editorInstanceId);
    const projectTargets = Array.from(this.instances.values()).filter((candidate) => candidate.projectId === projectId && candidate.editorInstanceId !== editorInstanceId);
    const hasProjectPrimary = projectTargets.some((candidate) => candidate.role === 'primary-writer');
    const instance = {
      editorInstanceId,
      projectId,
      connectionId,
      generation: String(generation || ''),
      ownerExtensionId: ownerExtensionId || '',
      ownerInstanceId: ownerInstanceId || '',
      cocosVersion: cocosVersion || 'unknown',
      capabilities: Array.isArray(capabilities) ? capabilities.slice() : [],
      pid: pid || 0,
      metadata: metadata || {},
      status: 'online',
      role: previous && previous.role === 'primary-writer'
        ? 'primary-writer'
        : (!hasProjectPrimary && role !== 'read-only' ? 'primary-writer' : 'read-only'),
      registeredAt: previous ? previous.registeredAt : new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      targetId: this.aliases[editorInstanceId] || (previous && previous.targetId) || editorInstanceId,
      // The control transport used to route command.request to this instance.
      // Phase 0 tests inject a mock; production uses the WebSocket control
      // channel attached at registration time.
      transport: transport || null,
    };
    this.instances.set(editorInstanceId, instance);
    return instance;
  }

  // Refreshes lastSeenAt for a heartbeat. Returns the instance or null.
  heartbeat(editorInstanceId, generation) {
    const instance = this.instances.get(editorInstanceId);
    if (!instance) {
      return null;
    }
    if (generation && instance.generation && String(generation) !== String(instance.generation)) {
      return null;
    }
    instance.lastSeenAt = new Date(Date.now()).toISOString();
    instance.status = 'online';
    return instance;
  }

  markOffline(editorInstanceId, generation) {
    const instance = this.instances.get(editorInstanceId);
    if (!instance) return null;
    if (generation && instance.generation && String(generation) !== String(instance.generation)) return instance;
    const wasPrimary = instance.role === 'primary-writer';
    instance.status = 'offline';
    if (wasPrimary) this.ensurePrimary(instance.projectId);
    return instance;
  }

  // Removes an instance and returns it, or null when unknown.
  unregister(editorInstanceId) {
    const instance = this.instances.get(editorInstanceId);
    if (!instance) {
      return null;
    }
    this.instances.delete(editorInstanceId);
    if (instance.role === 'primary-writer') this.ensurePrimary(instance.projectId);
    return instance;
  }

  get(editorInstanceId) {
    return this.instances.get(editorInstanceId) || null;
  }

  setAlias(editorInstanceId, targetId) {
    const instance = this.get(editorInstanceId);
    if (!instance) return null;
    if (!targetId || typeof targetId !== 'string') throw new Error('targetId must be a non-empty string.');
    const conflict = this.getByTargetId(targetId);
    if (conflict && conflict.editorInstanceId !== editorInstanceId) {
      const error = new Error('targetId is already assigned to another Editor instance.');
      error.code = 'TARGET_ID_CONFLICT';
      throw error;
    }
    this.aliases[editorInstanceId] = targetId;
    instance.targetId = targetId;
    persistAliases(this.statePath, this.aliases);
    return instance;
  }

  getByTargetId(targetId) {
    if (!targetId) {
      return null;
    }
    return Array.from(this.instances.values()).find((instance) =>
      instance.targetId === targetId || instance.editorInstanceId === targetId
    ) || null;
  }

  listByProject(projectId) {
    return this.list().filter((instance) => instance.projectId === projectId);
  }

  claimPrimaryWriter(editorInstanceId) {
    const instance = this.get(editorInstanceId);
    if (!instance) {
      return null;
    }
    for (const candidate of this.instances.values()) {
      if (candidate.projectId === instance.projectId) {
        candidate.role = candidate.editorInstanceId === editorInstanceId ? 'primary-writer' : 'read-only';
      }
    }
    return instance;
  }

  ensurePrimary(projectId) {
    const targets = this.listByProject(projectId);
    if (targets.some((candidate) => candidate.role === 'primary-writer' && candidate.status === 'online')) {
      return targets.find((candidate) => candidate.role === 'primary-writer') || null;
    }
    const candidate = targets
      .filter((item) => item.status === 'online')
      .sort((a, b) => String(a.registeredAt).localeCompare(String(b.registeredAt)))[0];
    if (!candidate) return null;
    return this.claimPrimaryWriter(candidate.editorInstanceId);
  }

  list() {
    return Array.from(this.instances.values());
  }

  count() {
    return this.instances.size;
  }

  isStale(instance, now = Date.now()) {
    const lastSeen = new Date(instance.lastSeenAt).getTime();
    return Number.isFinite(lastSeen) && now - lastSeen > this.ttlMs;
  }

  // Removes instances whose heartbeat TTL has elapsed.
  removeStaleInstances() {
    const now = Date.now();
    const removed = [];
    for (const [id, instance] of this.instances) {
      if (this.isStale(instance, now)) {
        this.instances.delete(id);
        removed.push(instance);
      }
    }
    const projects = new Set(removed.map((instance) => instance.projectId));
    for (const projectId of projects) this.ensurePrimary(projectId);
    return removed;
  }
}

module.exports = {
  TargetRegistry,
  STALE_INSTANCE_TTL_MS,
  DEFAULT_STALE_SCAN_INTERVAL_MS,
};

function loadAliases(statePath) {
  if (!statePath) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function persistAliases(statePath, aliases) {
  if (!statePath) return;
  try {
    writeFileAtomic(statePath, JSON.stringify(aliases, null, 2) + '\n', { mode: 0o600 });
  } catch (error) {
    // A transient config write failure must not disconnect a live Editor.
  }
}

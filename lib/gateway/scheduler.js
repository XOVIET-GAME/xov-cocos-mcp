'use strict';

const { getToolPolicy } = require('./tool-policies');

class Scheduler {
  constructor({ lockManager, logger, defaultTimeoutMs } = {}) {
    this.lockManager = lockManager;
    this.logger = logger || { log() {} };
    this.defaultTimeoutMs = defaultTimeoutMs || 30000;
    this.active = new Map();
    this.queue = 0;
  }

  async run({ requestId, ownerId, toolName, arguments: args, targetId, execute, policy, onCancel } = {}) {
    const id = String(requestId || 'request-' + (++this.queue));
    const toolPolicy = policy || getToolPolicy(toolName, { ...(args || {}), targetId });
    if (!this.lockManager) return execute();
    const timeoutMs = toolPolicy.timeoutMs || this.defaultTimeoutMs;
    const startedAt = Date.now();
    const item = {
      requestId: id,
      ownerId,
      toolName,
      targetId,
      policy: toolPolicy,
      startedAt,
      onCancel: typeof onCancel === 'function' ? onCancel : null,
      started: false,
      finished: false,
      cancelSent: false,
    };
    let cancelRequest;
    item.cancelPromise = new Promise((_, reject) => { cancelRequest = reject; });
    item.cancelReject = cancelRequest;
    this.active.set(id, item);
    let lease;
    try {
      const lockWait = this.lockManager.acquire(toolPolicy.resources, {
        ownerId: ownerId || id,
        // Scheduler owns the request deadline. Keep the lock-manager timer
        // behind it so callers consistently receive REQUEST_TIMEOUT rather
        // than a lower-level LOCK_TIMEOUT race.
        timeoutMs: timeoutMs + 1000,
        leaseMs: timeoutMs + 5000,
      });
      item.lockWait = lockWait;
      lease = await withTimeout(Promise.race([lockWait, item.cancelPromise]), timeoutMs, id);
      if (this.active.has(id)) this.active.get(id).leaseId = lease.leaseId;
      const result = await withTimeout(Promise.race([
        Promise.resolve().then(async () => {
          item.started = true;
          try {
            return await execute();
          } finally {
            item.finished = true;
          }
        }),
        item.cancelPromise,
      ]), timeoutMs, id);
      return result;
    } finally {
      if (item.started && !item.finished && item.onCancel && !item.cancelSent) {
        item.cancelSent = true;
        Promise.resolve(item.onCancel()).catch(() => {});
      }
      if (!lease && item.lockWait && typeof item.lockWait.cancel === 'function') {
        const error = new Error('Request timed out while waiting for a lock: ' + id);
        error.code = 'REQUEST_TIMEOUT';
        item.lockWait.cancel(error);
      }
      if (lease) lease.release();
      this.active.delete(id);
    }
  }

  cancel(requestId) {
    const item = this.active.get(String(requestId));
    if (!item) return false;
    const error = new Error('Request cancelled: ' + requestId);
    error.code = 'REQUEST_CANCELLED';
    if (item.lockWait && !item.leaseId && typeof item.lockWait.cancel === 'function') item.lockWait.cancel(error);
    if (item.cancelReject) item.cancelReject(error);
    if (item.started && !item.finished && item.onCancel && !item.cancelSent) {
      item.cancelSent = true;
      Promise.resolve(item.onCancel()).catch(() => {});
    }
    if (item.leaseId) this.lockManager.release(item.leaseId);
    item.cancelled = true;
    return true;
  }

  disconnect(ownerId) {
    for (const item of Array.from(this.active.values())) {
      if (item.ownerId === ownerId) this.cancel(item.requestId);
    }
    return this.lockManager.releaseOwner(ownerId);
  }

  status() {
    return { active: Array.from(this.active.values()).map((item) => ({ ...item })), locks: this.lockManager.status() };
  }
}

function withTimeout(promise, timeoutMs, requestId) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Request timed out: ' + requestId);
        error.code = 'REQUEST_TIMEOUT';
        reject(error);
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

module.exports = { Scheduler, withTimeout };

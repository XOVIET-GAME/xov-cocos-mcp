'use strict';

// Fair, atomic multi-resource lock manager. A request either acquires all
// resources or none; resources are normalized and sorted in a fixed order so
// cross-resource requests cannot deadlock by acquiring locks in opposite order.

const RESOURCE_ORDER = ['project', 'editor', 'scene', 'asset', 'file', 'preview'];

class LockManager {
  constructor(options = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs || 30000;
    this.defaultLeaseMs = options.defaultLeaseMs || 60000;
    this.watchdogIntervalMs = options.watchdogIntervalMs || 1000;
    this.held = new Map();
    this.waiters = [];
    this.leases = new Map();
    this.sequence = 0;
    this.closed = false;
    this.timer = setInterval(() => this.watchdog(), this.watchdogIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  acquire(resources, options = {}) {
    if (this.closed) {
      const error = new Error('Lock manager closed.');
      error.code = 'LOCK_MANAGER_CLOSED';
      return Promise.reject(error);
    }
    const ownerId = String(options.ownerId || 'anonymous');
    const normalized = normalizeResources(resources);
    const timeoutMs = options.timeoutMs || this.defaultTimeoutMs;
    const leaseMs = options.leaseMs || this.defaultLeaseMs;
    if (normalized.length === 0) {
      return Promise.resolve(this.createLease(ownerId, [], leaseMs));
    }
    let waiter;
    const promise = new Promise((resolve, reject) => {
      waiter = {
        id: ++this.sequence,
        ownerId,
        resources: normalized,
        leaseMs,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        timer: null,
        cancelled: false,
      };
      waiter.cancel = (error) => {
        if (waiter.cancelled || waiter.resolved) return false;
        waiter.cancelled = true;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        reject(error || Object.assign(new Error('Lock acquisition cancelled.'), { code: 'REQUEST_CANCELLED' }));
        this.drain();
        return true;
      };
      waiter.timer = setTimeout(() => {
        const error = new Error('Lock acquisition timed out.');
        error.code = 'LOCK_TIMEOUT';
        error.ownerId = ownerId;
        error.resources = normalized.map((item) => item.name);
        waiter.cancel(error);
      }, timeoutMs);
      this.waiters.push(waiter);
      this.drain();
    });
    promise.cancel = (error) => waiter.cancel(error);
    return promise;
  }

  createLease(ownerId, resources, leaseMs) {
    const leaseId = 'lease-' + (++this.sequence) + '-' + Date.now().toString(36);
    const lease = {
      leaseId,
      ownerId,
      resources,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + leaseMs,
      released: false,
      release: () => this.release(leaseId),
      renew: (durationMs = leaseMs) => this.renew(leaseId, durationMs),
    };
    this.leases.set(leaseId, lease);
    for (const resource of resources) {
      const holders = this.held.get(resource.name) || [];
      holders.push({ leaseId, ownerId, mode: resource.mode });
      this.held.set(resource.name, holders);
    }
    return lease;
  }

  canAcquire(resources) {
    for (const requested of resources) {
      const holders = this.held.get(requested.name) || [];
      if (holders.some((holder) => holder.mode !== 'read' || requested.mode !== 'read')) return false;
    }
    return true;
  }

  drain() {
    if (this.closed) return;
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      if (waiter.cancelled) {
        this.waiters.shift();
        continue;
      }
      // Strict FIFO prevents a later read from repeatedly bypassing a writer
      // that is waiting on the same resource. Acquisition remains atomic.
      if (!this.canAcquire(waiter.resources)) break;
      this.waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolved = true;
      waiter.resolve(this.createLease(waiter.ownerId, waiter.resources, waiter.leaseMs));
    }
  }

  release(leaseId) {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.released) return false;
    lease.released = true;
    for (const resource of lease.resources) {
      const holders = this.held.get(resource.name) || [];
      const remaining = holders.filter((holder) => holder.leaseId !== leaseId);
      if (remaining.length) this.held.set(resource.name, remaining);
      else this.held.delete(resource.name);
    }
    this.leases.delete(leaseId);
    this.drain();
    return true;
  }

  renew(leaseId, durationMs = this.defaultLeaseMs) {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.released) return false;
    lease.expiresAt = Date.now() + durationMs;
    return true;
  }

  releaseOwner(ownerId) {
    // Cancel pending waiters BEFORE releasing held leases. Each release()
    // triggers drain(); if waiters for this owner are still in the queue when
    // drain runs, drain could resolve one of them and create a new lease for
    // the disconnecting owner — a lease that this method would never release.
    // Cancelling first guarantees no waiter for this owner can be resolved by
    // the drains triggered below.
    for (const waiter of this.waiters.filter((item) => item.ownerId === ownerId)) {
      waiter.cancelled = true;
      clearTimeout(waiter.timer);
      const index = this.waiters.indexOf(waiter);
      if (index >= 0) this.waiters.splice(index, 1);
      const error = new Error('Lock request owner disconnected.');
      error.code = 'OWNER_DISCONNECTED';
      waiter.reject(error);
    }
    const ids = Array.from(this.leases.values())
      .filter((lease) => lease.ownerId === ownerId)
      .map((lease) => lease.leaseId);
    ids.forEach((id) => this.release(id));
    return ids.length;
  }

  watchdog(now = Date.now()) {
    for (const lease of Array.from(this.leases.values())) {
      if (lease.expiresAt <= now) this.release(lease.leaseId);
    }
  }

  status() {
    return {
      held: Array.from(this.held.entries()).map(([resource, holders]) => ({ resource, holders: holders.map((holder) => ({ ...holder })) })),
      waiting: this.waiters.map((waiter) => ({ ownerId: waiter.ownerId, resources: waiter.resources.map((item) => item.name), enqueuedAt: waiter.enqueuedAt })),
      leases: Array.from(this.leases.values()).map((lease) => ({ leaseId: lease.leaseId, ownerId: lease.ownerId, resources: lease.resources.map((item) => item.name), expiresAt: lease.expiresAt })),
    };
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const lease of Array.from(this.leases.values())) this.release(lease.leaseId);
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      const error = new Error('Lock manager closed.');
      error.code = 'LOCK_MANAGER_CLOSED';
      waiter.reject(error);
    }
  }
}

function normalizeResources(resources) {
  const values = Array.isArray(resources) ? resources : resources ? [resources] : [];
  const byName = new Map();
  for (const value of values) {
    const item = typeof value === 'string' ? { name: value, mode: 'write' } : value || {};
    if (!item.name) continue;
    const mode = item.mode === 'read' ? 'read' : (item.mode === 'exclusive' ? 'exclusive' : 'write');
    const current = byName.get(String(item.name));
    if (!current || mode !== 'read') byName.set(String(item.name), { name: String(item.name), mode });
  }
  return Array.from(byName.values()).sort((a, b) => resourceRank(a.name) - resourceRank(b.name) || a.name.localeCompare(b.name));
}

function resourceRank(name) {
  const prefix = String(name).split(':', 1)[0];
  const index = RESOURCE_ORDER.indexOf(prefix);
  return index < 0 ? RESOURCE_ORDER.length : index;
}

module.exports = { LockManager, normalizeResources, RESOURCE_ORDER };

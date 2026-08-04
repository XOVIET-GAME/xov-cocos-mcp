'use strict';

const { stableStringify } = require('./conflict-detector');

class IdempotencyStore {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs || 10 * 60 * 1000;
    this.entries = new Map();
  }

  async execute(key, fingerprint, work) {
    if (!key) return work();
    this.sweep();
    const existing = this.entries.get(String(key));
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        const error = new Error('IDEMPOTENCY_KEY_REUSED with different request arguments.');
        error.code = 'IDEMPOTENCY_KEY_REUSED';
        throw error;
      }
      return existing.promise;
    }
    const keyName = String(key);
    const entry = { fingerprint, createdAt: Date.now(), promise: null };
    entry.promise = Promise.resolve().then(work).then((value) => {
      entry.result = value;
      return value;
    });
    // A rejected work() must NOT poison the key. Drop the entry so the next
    // caller with the same key can retry (only success is cacheable).
    entry.promise.catch(() => {
      if (this.entries.get(keyName) === entry) this.entries.delete(keyName);
    });
    this.entries.set(keyName, entry);
    return entry.promise;
  }

  get(key) {
    this.sweep();
    const entry = this.entries.get(String(key));
    return entry ? { key: String(key), fingerprint: entry.fingerprint, createdAt: entry.createdAt, result: entry.result } : null;
  }

  sweep(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (now - entry.createdAt > this.ttlMs) this.entries.delete(key);
    }
  }

  size() {
    this.sweep();
    return this.entries.size;
  }
}

function requestFingerprint(value) {
  return stableStringify(value);
}

module.exports = { IdempotencyStore, requestFingerprint };

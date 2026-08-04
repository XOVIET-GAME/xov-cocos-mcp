'use strict';

class RateLimiter {
  constructor({ limit = 0, windowMs = 60000 } = {}) {
    this.limit = Math.max(0, Number(limit) || 0);
    this.windowMs = Math.max(1000, Number(windowMs) || 60000);
    this.hits = new Map();
  }

  allow(key, now = Date.now()) {
    if (!this.limit) return { allowed: true, remaining: Infinity, retryAfterMs: 0 };
    const bucket = this.hits.get(String(key)) || { startedAt: now, count: 0 };
    if (now - bucket.startedAt >= this.windowMs) {
      bucket.startedAt = now;
      bucket.count = 0;
    }
    bucket.count += 1;
    this.hits.set(String(key), bucket);
    const allowed = bucket.count <= this.limit;
    return {
      allowed,
      remaining: Math.max(0, this.limit - bucket.count),
      retryAfterMs: allowed ? 0 : Math.max(1, this.windowMs - (now - bucket.startedAt)),
    };
  }

  clear() {
    this.hits.clear();
  }
}

module.exports = { RateLimiter };

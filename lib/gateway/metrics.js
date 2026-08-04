'use strict';

class GatewayMetrics {
  constructor() {
    this.counters = new Map();
    this.startedAt = Date.now();
  }

  increment(name, amount = 1) {
    this.counters.set(name, (this.counters.get(name) || 0) + amount);
  }

  snapshot() {
    return {
      uptimeMs: Date.now() - this.startedAt,
      counters: Object.fromEntries(this.counters),
    };
  }
}

module.exports = { GatewayMetrics };

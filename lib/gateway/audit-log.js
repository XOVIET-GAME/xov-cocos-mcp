'use strict';

class AuditLog {
  constructor(options = {}) {
    this.maxEntries = options.maxEntries || 1000;
    this.entries = [];
  }

  record(event) {
    const entry = { timestamp: new Date().toISOString(), ...event };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
    return entry;
  }

  list({ limit = 100, agentId, targetId, requestId } = {}) {
    return this.entries.filter((entry) =>
      (!agentId || entry.agentId === agentId) &&
      (!targetId || entry.targetId === targetId) &&
      (!requestId || entry.requestId === requestId)
    ).slice(-Math.max(0, limit));
  }

  clear() { this.entries.length = 0; }
  size() { return this.entries.length; }
}

module.exports = { AuditLog };

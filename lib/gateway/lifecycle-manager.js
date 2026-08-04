'use strict';

// Coordinates extension lifecycle events (register/heartbeat/unregister) with
// Gateway ownership and idle auto-stop policy.
//
// Phase 0 rules:
// - Auto-stop only applies to a Gateway that was launched by an extension
//   (autoStartedByExtension && ownership is set).
// - The Gateway never stops merely because an agent or CLI client disconnects.
// - When the last Editor instance unregisters (or is cleaned as stale), the
//   Gateway may auto-stop if it is owner-started and autoStopWhenIdle is true.

class LifecycleManager {
  constructor({ registry, ownership, autoStopWhenIdle, requestCounter, sessionCounter, jobCounter, logger, onAutoStop }) {
    this.registry = registry;
    this.ownership = ownership || null;
    this.autoStopWhenIdle = autoStopWhenIdle !== false;
    this.requestCounter = requestCounter || (() => 0);
    this.sessionCounter = sessionCounter || (() => 0);
    this.jobCounter = jobCounter || (() => 0);
    this.logger = logger || { log() {} };
    this.onAutoStop = onAutoStop || null;
  }

  get sessionCount() {
    return this.sessionCounter();
  }

  get jobCount() {
    return this.jobCounter();
  }

  // Total active work on the Gateway. Agents (MCP sessions) and jobs are
  // introduced in later phases; Phase 0 only counts Editor instances.
  activeWorkload() {
    return {
      instances: this.registry.count(),
      sessions: this.sessionCount,
      jobs: this.jobCount,
      activeRequests: this.requestCounter(),
    };
  }

  // Whether the Gateway may auto-stop right now.
  shouldAutoStop() {
    if (!this.ownership || !this.ownership.autoStartedByExtension) {
      return false;
    }
    if (!this.autoStopWhenIdle) {
      return false;
    }
    const workload = this.activeWorkload();
    return workload.instances === 0 && workload.sessions === 0 && workload.jobs === 0 && workload.activeRequests === 0;
  }

  // Called after an instance is removed (unregister or stale cleanup).
  // Invokes onAutoStop when the idle policy and ownership allow it.
  async maybeAutoStop(reason) {
    if (!this.shouldAutoStop()) {
      return false;
    }
    this.logger.log('info', `Gateway idle (${reason}); auto-stopping (owner-started, autoStopWhenIdle=true).`);
    if (typeof this.onAutoStop === 'function') {
      await this.onAutoStop(reason);
      return true;
    }
    return true;
  }

  summarize() {
    const workload = this.activeWorkload();
    return {
      ownership: this.ownership,
      autoStopWhenIdle: this.autoStopWhenIdle,
      canAutoStop: this.shouldAutoStop(),
      ...workload,
    };
  }
}

module.exports = {
  LifecycleManager,
};

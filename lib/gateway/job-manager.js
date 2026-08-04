'use strict';

class JobManager {
  constructor() {
    this.jobs = new Map();
    this.sequence = 0;
  }

  create({ ownerId, targetId, toolName, metadata } = {}) {
    const jobId = 'job-' + (++this.sequence) + '-' + Date.now().toString(36);
    const job = {
      jobId, ownerId: ownerId || '', targetId: targetId || '', toolName: toolName || '',
      metadata: metadata || {}, status: 'running', result: null, error: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, job);
    return job;
  }

  complete(jobId, result) { return this.update(jobId, { status: 'completed', result }); }
  fail(jobId, error) { return this.update(jobId, { status: 'failed', error: serializeError(error) }); }
  cancel(jobId) { return this.update(jobId, { status: 'cancelled' }); }

  update(jobId, changes) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    Object.assign(job, changes, { updatedAt: new Date().toISOString() });
    return job;
  }

  get(jobId) { return this.jobs.get(jobId) || null; }
  list() { return Array.from(this.jobs.values()).map((job) => ({ ...job })); }
  countActive() { return this.list().filter((job) => job.status === 'running').length; }
}

function serializeError(error) {
  return { code: error && error.code || 'JOB_FAILED', message: error && error.message || String(error) };
}

module.exports = { JobManager, serializeError };

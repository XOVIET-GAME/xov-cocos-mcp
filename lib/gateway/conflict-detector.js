'use strict';

const crypto = require('crypto');

class ConflictDetector {
  constructor() {
    this.revisions = new Map();
  }

  key(scope, id) {
    return String(scope || 'resource') + ':' + String(id || 'current');
  }

  snapshot(scope, id, value) {
    const key = this.key(scope, id);
    const current = this.revisions.get(key) || { revision: 0, hash: '' };
    return { key, revision: current.revision, hash: current.hash || hashValue(value) };
  }

  check(scope, id, expected) {
    if (expected === undefined || expected === null || expected === '') return null;
    const current = this.revisions.get(this.key(scope, id)) || { revision: 0, hash: '' };
    const expectedRevision = typeof expected === 'object' ? expected.revision : expected;
    const expectedHash = typeof expected === 'object' ? expected.hash : '';
    if (String(expectedRevision) !== String(current.revision)) {
      return conflictError('STALE_EDITOR_STATE', expected, current);
    }
    if (expectedHash && current.hash && expectedHash !== current.hash) {
      return conflictError('CONFLICT', expected, current);
    }
    return null;
  }

  commit(scope, id, value) {
    const key = this.key(scope, id);
    const previous = this.revisions.get(key) || { revision: 0, hash: '' };
    const next = { revision: previous.revision + 1, hash: hashValue(value), updatedAt: new Date().toISOString() };
    this.revisions.set(key, next);
    return { key, ...next };
  }

  get(scope, id) {
    const current = this.revisions.get(this.key(scope, id));
    return current ? { ...current } : { revision: 0, hash: '' };
  }
}

function hashValue(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

function conflictError(code, expected, actual) {
  const error = new Error(code + ': expected editor revision does not match current state.');
  error.code = code;
  error.expected = expected;
  error.actual = actual;
  return error;
}

module.exports = { ConflictDetector, hashValue, stableStringify };

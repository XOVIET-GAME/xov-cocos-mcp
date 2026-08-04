'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  acquireLaunchLock,
  createNonce,
  getLockPath,
  getStatePath,
  releaseLaunchLock,
  resolveOwnershipDir,
} = require('../../lib/gateway/process-manager');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-gw-pm-test-'));
}

test('resolveOwnershipDir defaults to the temp gateway directory', () => {
  assert.ok(resolveOwnershipDir().length > 0);
  assert.equal(resolveOwnershipDir('D:/custom'), path.resolve('D:/custom'));
});

test('createNonce produces unique values', () => {
  assert.notEqual(createNonce(), createNonce());
});

test('acquireLaunchLock is exclusive and release removes the lock file', () => {
  const dir = createTempDir();
  try {
    const lockPath = acquireLaunchLock(dir);
    assert.ok(fs.existsSync(lockPath));
    assert.equal(getLockPath(dir), lockPath);

    assert.throws(() => acquireLaunchLock(dir), /Another Cocos extension/);

    releaseLaunchLock(lockPath);
    assert.equal(fs.existsSync(lockPath), false);

    // The lock can be re-acquired after release.
    const again = acquireLaunchLock(dir);
    releaseLaunchLock(again);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('state path lives inside the ownership directory', () => {
  const dir = createTempDir();
  try {
    assert.equal(getStatePath(dir), path.join(dir, 'cocos-gateway-state.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

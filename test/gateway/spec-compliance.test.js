'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const manifest = require('../../package.json');
const { McpFrontDoor } = require('../../lib/gateway/mcp-front-door');
const toolDispatch = require('../../lib/gateway/tool-dispatch');
const { checkForUpdate } = require('../../lib/update-checker');

test('front door advertises the package version by default', () => {
  const door = new McpFrontDoor({});
  assert.equal(door.serverVersion, manifest.version);
});

test('buildCommandResult always returns object structuredContent', () => {
  const ctx = { createMcpResult: (id, result) => ({ id, result }) };
  const build = (value) => toolDispatch.buildCommandResult.call(ctx, 1, { result: { value } }).result;
  assert.deepEqual(build('{"ok":true}').structuredContent, { ok: true });
  assert.equal(build('plain text').structuredContent, undefined);
  assert.equal(build('[1,2]').structuredContent, undefined);
  assert.deepEqual(build({ a: 1 }).structuredContent, { a: 1 });
  assert.equal(build('plain text').content[0].text, 'plain text');
});

test('update check treats HTTP 404 (no releases yet) as up to date, not an error', async () => {
  const https = require('https');
  const { EventEmitter } = require('events');
  const original = https.get;
  https.get = (url, options, callback) => {
    const response = new EventEmitter();
    response.statusCode = 404;
    process.nextTick(() => {
      callback(response);
      response.emit('data', Buffer.from('{"message":"Not Found"}'));
      response.emit('end');
    });
    return new EventEmitter();
  };
  try {
    const result = await checkForUpdate({ currentVersion: '1.2.3' });
    assert.equal(result.ok, true);
    assert.equal(result.updateAvailable, false);
    assert.equal(result.noReleases, true);
    assert.equal(result.latestVersion, '1.2.3');
  } finally {
    https.get = original;
  }
});

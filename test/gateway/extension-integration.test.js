'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { GatewayServer } = require('../../lib/gateway/gateway-server');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-extension-gateway-test-'));
}

test('browser extension service registers as a Gateway client and serves tools/list', async () => {
  const ownershipDir = tempDir();
  const previousUrl = process.env.COCOS_GATEWAY_URL;
  const previousOwnership = process.env.COCOS_GATEWAY_OWNERSHIP_DIR;
  const server = new GatewayServer({
    host: '127.0.0.1',
    port: 0,
    ownershipDir,
    ownershipOverride: { ownerExtensionId: 'integration-test', ownerInstanceId: 'integration-owner', autoStartedByExtension: false },
    autoStopWhenIdle: false,
    logger: { log() {} },
  });
  try {
    await server.start();
    process.env.COCOS_GATEWAY_URL = 'http://127.0.0.1:' + server.getPort() + '/mcp';
    process.env.COCOS_GATEWAY_OWNERSHIP_DIR = ownershipDir;
    const extension = require('../../browser');
    const status = await extension.methods.startServer();
    assert.equal(status.connected, true);
    assert.equal(status.registered, true);
    assert.equal(server.registry.count(), 1);
    const tools = await server.listTargetTools();
    assert.ok(Array.isArray(tools));
    assert.ok(tools.some((tool) => tool.name === 'get_hierarchy'));
  } finally {
    try {
      const extension = require('../../browser');
      await extension.methods.stopServer();
    } catch (error) {
      // Preserve the primary assertion if cleanup runs after a failed start.
    }
    await server.stop();
    if (previousUrl === undefined) delete process.env.COCOS_GATEWAY_URL;
    else process.env.COCOS_GATEWAY_URL = previousUrl;
    if (previousOwnership === undefined) delete process.env.COCOS_GATEWAY_OWNERSHIP_DIR;
    else process.env.COCOS_GATEWAY_OWNERSHIP_DIR = previousOwnership;
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

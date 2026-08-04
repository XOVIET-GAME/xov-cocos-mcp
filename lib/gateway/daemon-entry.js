'use strict';

// Gateway daemon entry point. This file is NOT published as a cocos-cli
// subcommand and must not be called by agents. Only the internal Cocos
// extension launcher (lib/extension/gateway-client.js) spawns this file
// detached. Env vars are set by the launcher:
//
//   COCOS_GATEWAY_HOST
//   COCOS_GATEWAY_PORT
//   COCOS_GATEWAY_OWNERSHIP_DIR
//   COCOS_GATEWAY_LAUNCH_NONCE

const fs = require('fs');
const os = require('os');
const path = require('path');
const { GatewayServer } = require('./gateway-server');
const { getStatePath } = require('./process-manager');

// Writes the ownership state file when the daemon was launched by the internal
// extension launcher. The launcher passes the ownership details via env vars.
function persistOwnershipIfLaunched() {
  const ownershipDir = process.env.COCOS_GATEWAY_OWNERSHIP_DIR;
  const ownerExtensionId = process.env.COCOS_GATEWAY_OWNER_EXTENSION_ID;
  const ownerInstanceId = process.env.COCOS_GATEWAY_OWNER_INSTANCE_ID;
  const launchNonce = process.env.COCOS_GATEWAY_LAUNCH_NONCE || '';
  if (!ownershipDir || !ownerExtensionId || !ownerInstanceId) {
    return;
  }
  const serverInstanceId = os.hostname() + '-' + process.pid + '-' + Date.now().toString(36);
  process.env.COCOS_GATEWAY_SERVER_INSTANCE_ID = serverInstanceId;
  const statePath = getStatePath(ownershipDir);
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(statePath, JSON.stringify({
    serverInstanceId,
    ownerExtensionId,
    ownerInstanceId,
    launchNonce,
    autoStartedByExtension: true,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }, null, 2) + '\n', 'utf8');
}

async function main() {
  persistOwnershipIfLaunched();
  const server = new GatewayServer({});
  await server.start();

  // Graceful termination. The Gateway is a detached daemon; it can be killed
  // by the OS or by the idle auto-stop path. When idle auto-stop triggers, the
  // server's stop() closes the listener and the process exits naturally.
  const shutdown = async (signal) => {
    server.log('info', 'Gateway received ' + signal + '; shutting down.');
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[cocos-gateway-daemon] Failed to start: ' + (error && error.stack || error));
    process.exit(1);
  });
}

module.exports = { main };

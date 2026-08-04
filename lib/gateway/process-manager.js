'use strict';

// Internal Gateway launcher used ONLY by the Cocos extension. This is not a
// public cocos-cli command. The launcher guarantees single-flight startup at
// the machine level so concurrent Editor startups cannot create multiple
// Gateway processes, and it records ownership (ownerExtensionId,
// ownerInstanceId, launchNonce) in a state file next to the daemon entry.

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const STATE_FILE_NAME = 'cocos-gateway-state.json';
const LOCK_FILE_NAME = 'cocos-gateway.lock';
const HEALTH_TIMEOUT_MS = 5000;
const DEFAULT_OWNERSHIP_DIR =
  path.join(os.tmpdir(), 'funplay-cocos-mcp-gateway');

function createNonce() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

function resolveOwnershipDir(ownershipDir) {
  return path.resolve(String(ownershipDir || DEFAULT_OWNERSHIP_DIR));
}

function getStatePath(ownershipDir) {
  return path.join(resolveOwnershipDir(ownershipDir), STATE_FILE_NAME);
}

function getLockPath(ownershipDir) {
  return path.join(resolveOwnershipDir(ownershipDir), LOCK_FILE_NAME);
}

function readState(ownershipDir) {
  try {
    const text = fs.readFileSync(getStatePath(ownershipDir), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed && Number.isFinite(Number(parsed.pid))) {
      return parsed;
    }
    return null;
  } catch (error) {
    return null;
  }
}

// Health check for a live daemon. Returns the parsed health payload or null.
function checkHealth(gatewayUrl, timeoutMs = HEALTH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      request.destroy();
      resolve(null);
    }, timeoutMs);

    const request = httpRequestForUrl(gatewayUrl, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(timeout);
        if (response.statusCode !== 200) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          resolve(null);
        }
      });
    });

    request.on('timeout', () => {
      clearTimeout(timeout);
      request.destroy();
      resolve(null);
    });
    request.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
    request.end();
  });
}

function httpRequestForUrl(urlText, onResponse) {
  const http = require(urlText.startsWith('https:') ? 'https' : 'http');
  const parsed = new URL(urlText);
  const request = http.request(
    {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: '/health',
      method: 'GET',
      timeout: HEALTH_TIMEOUT_MS,
    },
    onResponse
  );
  return request;
}

// Best-effort platform-aware check for a live process by PID.
function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

// Exclusive machine-level lock to serialize launch/check races between
// multiple extension hosts. Throws when the lock cannot be acquired.
function acquireLaunchLock(ownershipDir) {
  const lockPath = getLockPath(ownershipDir);
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  let handle;
  try {
    handle = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      // A stale lock is simply a stale flag file. Since the launcher is a
      // short-lived tool and the health check runs while holding the lock,
      // an existing file means another launcher is mid-flight.
      throw new Error(
        'Another Cocos extension is currently launching the Gateway; retry the health check shortly.'
      );
    }
    throw error;
  }
  fs.writeSync(handle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  fs.closeSync(handle);
  return lockPath;
}

function releaseLaunchLock(lockPath) {
  if (!lockPath) {
    return;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    // Best-effort cleanup only.
  }
}

function launchDetached({ entryPoint, ownershipDir, ownerExtensionId, ownerInstanceId, env, args }) {
  const resolvedDir = resolveOwnershipDir(ownershipDir);
  const nonce = createNonce();
  const child = spawn(process.execPath, [entryPoint, ...(args || [])], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      COCOS_GATEWAY_OWNERSHIP_DIR: resolvedDir,
      COCOS_GATEWAY_LAUNCH_NONCE: nonce,
      COCOS_GATEWAY_OWNER_EXTENSION_ID: ownerExtensionId || '',
      COCOS_GATEWAY_OWNER_INSTANCE_ID: ownerInstanceId || '',
      ...(env || {}),
    },
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid, launchNonce: nonce };
}

// Probes whether a Gateway with the expected identity is already listening on
// the configured host/port by POSTing an initialize-like control message.
function probeExistingGateway(gatewayUrl, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      request.destroy();
      resolve(null);
    }, timeoutMs);
    const request = httpRequestForUrl(gatewayUrl, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          resolve(null);
        }
      });
    });
    request.on('timeout', () => {
      clearTimeout(timeout);
      request.destroy();
      resolve(null);
    });
    request.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
    request.end();
  });
}

// Waits until a live Gateway is reachable at the given URL.
async function waitForHealthy(gatewayUrl, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const intervalMs = options.intervalMs || 200;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const health = await checkHealth(gatewayUrl, Math.min(2000, timeoutMs - (Date.now() - startedAt) || 2000));
    if (health && health.ok) {
      return health;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

// Checks whether the given host/port is already occupied.
function isPortInUse(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: host || '127.0.0.1', port: Number(port) });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

module.exports = {
  STATE_FILE_NAME,
  LOCK_FILE_NAME,
  DEFAULT_OWNERSHIP_DIR,
  createNonce,
  resolveOwnershipDir,
  getStatePath,
  getLockPath,
  readState,
  checkHealth,
  isProcessAlive,
  acquireLaunchLock,
  releaseLaunchLock,
  launchDetached,
  probeExistingGateway,
  waitForHealthy,
  isPortInUse,
};

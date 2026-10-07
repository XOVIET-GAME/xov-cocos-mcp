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
const LOCK_STALE_AFTER_MS = 30_000;
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

// Cocos Creator runs extension JavaScript inside its own Electron process.
// In that host process `process.execPath` points to CocosCreator.exe, not to
// node.exe. Never pass the daemon entry point to the Editor executable: it
// starts another Editor instance and the Gateway will never listen.
function resolveNodeExecutable(explicit, processPath = process.execPath, pathValue = process.env.PATH || process.env.Path || '') {
  const candidates = [];
  if (explicit) candidates.push(String(explicit));
  if (process.env.COCOS_GATEWAY_NODE_EXECUTABLE) {
    candidates.push(process.env.COCOS_GATEWAY_NODE_EXECUTABLE);
  }
  if (process.env.NODE_EXECUTABLE) {
    candidates.push(process.env.NODE_EXECUTABLE);
  }
  if (process.env.npm_node_execpath) {
    candidates.push(process.env.npm_node_execpath);
  }
  if (processPath && /(^|[\\/])node(?:\.exe)?$/i.test(String(processPath))) {
    candidates.push(String(processPath));
  }

  for (const candidate of candidates) {
    const value = String(candidate).trim();
    if (!value) continue;
    if (!/(^|[\\/])node(?:\.exe)?$/i.test(value)) continue;
    if (path.isAbsolute(value)) {
      if (fs.existsSync(value)) return value;
      continue;
    }
    if (value.toLowerCase() === 'node' || value.toLowerCase() === 'node.exe') {
      continue;
    }
  }

  const pathEntries = String(pathValue || '').split(path.delimiter).filter(Boolean);
  const executableNames = process.platform === 'win32' ? ['node.exe', 'node'] : ['node'];
  for (const entry of pathEntries) {
    for (const executableName of executableNames) {
      const candidate = path.join(entry, executableName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  const error = new Error(
    'Node.js runtime was not found for the detached Gateway. ' +
    'Set COCOS_GATEWAY_NODE_EXECUTABLE to the absolute path of node.exe.'
  );
  error.code = 'GATEWAY_NODE_UNAVAILABLE';
  throw error;
}

function isLaunchLockStale(lockPath, now = Date.now()) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch (error) {
    return error && error.code === 'ENOENT';
  }

  let createdAt = stat.mtimeMs;
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const parsedTime = Date.parse(parsed && parsed.createdAt);
    if (Number.isFinite(parsedTime)) createdAt = parsedTime;
  } catch (error) {
    // A malformed lock is recoverable once it is old enough.
  }
  return now - createdAt >= LOCK_STALE_AFTER_MS;
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
      // Launch locks are short-lived. Recover a lock left behind by a killed
      // Editor/extension host, while preserving the normal cross-process race
      // protection for a fresh lock.
      if (isLaunchLockStale(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
          handle = fs.openSync(lockPath, 'wx');
        } catch (retryError) {
          if (!retryError || retryError.code !== 'EEXIST') throw retryError;
        }
      }
      if (!handle) {
        throw new Error(
          'Another Cocos extension is currently launching the Gateway; retry the health check shortly.'
        );
      }
    } else {
      throw error;
    }
  }
  try {
    fs.writeSync(handle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  } finally {
    fs.closeSync(handle);
  }
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

function launchDetached({ entryPoint, ownershipDir, ownerExtensionId, ownerInstanceId, env, args, nodeExecutable }) {
  const resolvedDir = resolveOwnershipDir(ownershipDir);
  const nonce = createNonce();
  const runtime = resolveNodeExecutable(nodeExecutable);
  const child = spawn(runtime, [entryPoint, ...(args || [])], {
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
  LOCK_STALE_AFTER_MS,
  DEFAULT_OWNERSHIP_DIR,
  createNonce,
  resolveOwnershipDir,
  getStatePath,
  getLockPath,
  readState,
  checkHealth,
  isProcessAlive,
  resolveNodeExecutable,
  acquireLaunchLock,
  releaseLaunchLock,
  launchDetached,
  probeExistingGateway,
  waitForHealthy,
  isPortInUse,
};

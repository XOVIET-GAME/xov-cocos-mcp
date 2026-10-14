'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const { GatewayServer } = require('../../lib/gateway/gateway-server');
const { createHttpControlTransport } = require('../../lib/gateway/transport');
const { createRequest } = require('../../lib/gateway/extension-protocol');
const { TargetRegistry } = require('../../lib/gateway/target-registry');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-gateway-test-'));
}

function postJson(port, pathWithQuery, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathWithQuery,
        method: 'POST',
        agent: false,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (error) {
            parsed = null;
          }
          resolve({ statusCode: response.statusCode, body: parsed, text: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    request.on('error', reject);
    request.end(body);
  });
}

function getJson(port, pathWithQuery, headers = { Accept: 'application/json' }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathWithQuery,
        method: 'GET',
        agent: false,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (error) {
            parsed = null;
          }
          resolve({ statusCode: response.statusCode, body: parsed, text: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    request.on('error', reject);
    request.end();
  });
}

test('loopback Gateway rejects hostile Host and Origin headers on HTTP endpoints', async () => {
  const { server, ownershipDir } = await createGateway();
  try {
    const badHost = await getJson(server.getPort(), '/mcp', { Host: 'attacker.example', Accept: 'application/json' });
    assert.equal(badHost.statusCode, 403);
    const badOrigin = await getJson(server.getPort(), '/mcp', {
      Host: '127.0.0.1:' + server.getPort(),
      Origin: 'https://attacker.example',
      Accept: 'application/json',
    });
    assert.equal(badOrigin.statusCode, 403);
    const good = await getJson(server.getPort(), '/mcp', {
      Host: 'localhost:' + server.getPort(),
      Origin: 'http://localhost:3000',
      Accept: 'application/json',
    });
    assert.equal(good.statusCode, 200);
    const fileOrigin = await getJson(server.getPort(), '/mcp', {
      Host: '127.0.0.1:' + server.getPort(),
      Origin: 'file://',
      Accept: 'application/json',
    });
    assert.equal(fileOrigin.statusCode, 200);
    const nullOrigin = await getJson(server.getPort(), '/mcp', {
      Host: '127.0.0.1:' + server.getPort(),
      Origin: 'null',
      Accept: 'application/json',
    });
    assert.equal(nullOrigin.statusCode, 403);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

async function createGateway(overrides = {}) {
  const ownershipDir = createTempDir();
  const registry = overrides.registry || new TargetRegistry({ ttlMs: 1000, staleScanIntervalMs: 50 });
  const autoStops = [];
  const server = new GatewayServer({
    host: '127.0.0.1',
    port: 0,
    ownershipDir,
    ownershipOverride: {
      ownerExtensionId: 'ext-test',
      ownerInstanceId: 'ext-instance-1',
      launchNonce: 'nonce-1',
      autoStartedByExtension: true,
    },
    registry,
    logger: { log() {} },
    autoStopWhenIdle: overrides.autoStopWhenIdle !== undefined ? overrides.autoStopWhenIdle : true,
  });
  server.lifecycle.onAutoStop = async (reason) => {
    autoStops.push(reason);
  };
  await server.start();
  return { server, registry, ownershipDir, autoStops };
}

test('GET /health reports kind, ownership, pid, and workload counts', async () => {
  const { server, ownershipDir } = await createGateway();
  try {
    const response = await getJson(server.getPort(), '/health');
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.kind, 'cocos-gateway');
    assert.equal(response.body.pid, process.pid);
    assert.equal(response.body.instances, 0);
    assert.equal(response.body.sessions, 0);
    assert.equal(response.body.jobs, 0);
    assert.equal(response.body.ownership.ownerExtensionId, 'ext-test');
    assert.equal(response.body.ownership.launchNonce, 'nonce-1');
    assert.equal(response.body.autoStopWhenIdle, true);
    assert.equal(response.body.canAutoStop, true);
    assert.ok(response.body.serverInstanceId);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('instance.register creates a control session and reports heartbeat interval', async () => {
  const { server, ownershipDir } = await createGateway();
  try {
    const response = await postJson(server.getPort(), '/control', createRequest('r1', 'instance.register', {
      editorInstanceId: 'editor-1',
      projectId: 'project-1',
      ownerExtensionId: 'ext-test',
      ownerInstanceId: 'ext-instance-1',
    }));
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.result.ok, true);
    assert.ok(response.body.result.connectionId);
    assert.ok(response.body.result.sessionId);
    assert.ok(response.body.result.heartbeatIntervalMs > 0);
    assert.equal(response.body.result.targetId, 'editor-1');

    const health = await getJson(server.getPort(), '/health');
    assert.equal(health.body.instances, 1);
    assert.equal(health.body.canAutoStop, false);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('instance.heartbeat keeps an instance fresh and returns lastSeenAt', async () => {
  const { server, ownershipDir } = await createGateway();
  try {
    const register = await postJson(server.getPort(), '/control', createRequest('r1', 'instance.register', {
      editorInstanceId: 'editor-1',
      projectId: 'project-1',
    }));
    const sessionId = register.body.result.sessionId;

    const heartbeat = await postJson(server.getPort(), '/control?session=' + sessionId, createRequest('h1', 'instance.heartbeat', {
      editorInstanceId: 'editor-1',
    }));
    assert.equal(heartbeat.body.result.ok, true);
    assert.ok(heartbeat.body.result.lastSeenAt);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('instance.heartbeat for an unknown instance returns an error', async () => {
  const { server, ownershipDir } = await createGateway();
  try {
    const response = await postJson(server.getPort(), '/control', createRequest('h1', 'instance.heartbeat', {
      editorInstanceId: 'nope',
    }));
    assert.equal(response.body.error.code, -32001);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('instance.unregister removes the instance and allows idle auto-stop', async () => {
  const { server, registry, ownershipDir, autoStops } = await createGateway();
  try {
    const register = await postJson(server.getPort(), '/control', createRequest('r1', 'instance.register', {
      editorInstanceId: 'editor-1',
      projectId: 'project-1',
    }));
    const sessionId = register.body.result.sessionId;
    assert.equal(registry.count(), 1);

    const unregister = await postJson(server.getPort(), '/control?session=' + sessionId, createRequest('u1', 'instance.unregister', {
      editorInstanceId: 'editor-1',
      sessionToken: sessionId,
      reason: 'editor-shutdown',
    }));
    assert.equal(unregister.body.result.ok, true);
    assert.equal(registry.count(), 0);
    assert.equal(unregister.body.result.canAutoStop, true);
    assert.deepEqual(autoStops, ['last-instance-unregistered']);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('unregister with a mismatched session token is rejected', async () => {
  const { server, registry, ownershipDir } = await createGateway();
  try {
    await postJson(server.getPort(), '/control', createRequest('r1', 'instance.register', {
      editorInstanceId: 'editor-1',
      projectId: 'project-1',
    }));
    assert.equal(registry.count(), 1);

    const response = await postJson(server.getPort(), '/control?session=wrong-session', createRequest('u1', 'instance.unregister', {
      editorInstanceId: 'editor-1',
      sessionToken: 'wrong-session',
      reason: 'bad-token',
    }));
    assert.equal(response.body.error.code, -32002);
    assert.equal(registry.count(), 1);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('unregister without a session token is accepted (stale control session path)', async () => {
  const { server, registry, ownershipDir } = await createGateway();
  try {
    await postJson(server.getPort(), '/control', createRequest('r1', 'instance.register', {
      editorInstanceId: 'editor-1',
      projectId: 'project-1',
    }));
    const response = await postJson(server.getPort(), '/control', createRequest('u1', 'instance.unregister', {
      editorInstanceId: 'editor-1',
      sessionToken: 'missing-session',
      reason: 'forced-cleanup',
    }));
    assert.equal(response.body.result.ok, true);
    assert.equal(registry.count(), 0);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('stale heartbeat TTL removes an instance and triggers idle auto-stop', async () => {
  const { server, ownershipDir, autoStops } = await createGateway({
    registry: new TargetRegistry({ ttlMs: 40, staleScanIntervalMs: 20 }),
  });
  try {
    await postJson(server.getPort(), '/control', createRequest('r1', 'instance.register', {
      editorInstanceId: 'editor-1',
      projectId: 'project-1',
    }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const health = await getJson(server.getPort(), '/health');
    assert.equal(health.body.instances, 0);
    assert.equal(health.body.canAutoStop, true);
    assert.ok(autoStops.includes('stale-cleanup'));
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('validation failures return JSON-RPC errors without mutating state', async () => {
  const { server, registry, ownershipDir } = await createGateway();
  try {
    const response = await postJson(server.getPort(), '/control', createRequest('r1', 'instance.register', {
      projectId: 'project-1',
    }));
    assert.equal(response.body.error.code, -32602);
    assert.equal(registry.count(), 0);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('unknown routes and methods are rejected', async () => {
  const { server, ownershipDir } = await createGateway();
  try {
    const get = await getJson(server.getPort(), '/nope');
    assert.equal(get.statusCode, 404);

    const post = await postJson(server.getPort(), '/nope', {});
    assert.equal(post.statusCode, 404);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('control channel works through the HTTP transport abstraction', async () => {
  const { server, ownershipDir } = await createGateway();
  try {
    const transport = createHttpControlTransport();
    const gatewayUrl = 'http://127.0.0.1:' + server.getPort();
    const health = await transport.health(gatewayUrl);
    assert.equal(health.ok, true);

    const register = await transport.request(gatewayUrl, createRequest('r1', 'instance.register', {
      editorInstanceId: 'editor-1',
      projectId: 'project-1',
    }), '');
    assert.equal(register.result.ok, true);
    const sessionId = register.result.sessionId;

    const heartbeat = await transport.request(gatewayUrl, createRequest('h1', 'instance.heartbeat', {
      editorInstanceId: 'editor-1',
    }), sessionId);
    assert.equal(heartbeat.result.ok, true);

    const unregister = await transport.request(gatewayUrl, createRequest('u1', 'instance.unregister', {
      editorInstanceId: 'editor-1',
      sessionToken: sessionId,
    }), sessionId);
    assert.equal(unregister.result.ok, true);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

test('closing a non-final editor leaves the Gateway alive for the others', async () => {
  const { server, registry, ownershipDir, autoStops } = await createGateway();
  try {
    const r1 = await postJson(server.getPort(), '/control', createRequest('r1', 'instance.register', {
      editorInstanceId: 'editor-1',
      projectId: 'project-1',
    }));
    const r2 = await postJson(server.getPort(), '/control', createRequest('r2', 'instance.register', {
      editorInstanceId: 'editor-2',
      projectId: 'project-2',
    }));
    assert.equal(registry.count(), 2);

    const u1 = await postJson(server.getPort(), '/control?session=' + r1.body.result.sessionId, createRequest('u1', 'instance.unregister', {
      editorInstanceId: 'editor-1',
      sessionToken: r1.body.result.sessionId,
      reason: 'editor-1-closing',
    }));
    assert.equal(u1.body.result.ok, true);
    assert.equal(u1.body.result.canAutoStop, false);
    assert.equal(registry.count(), 1);

    // The Gateway remains reachable and editor-2 is unaffected.
    const health = await getJson(server.getPort(), '/health');
    assert.equal(health.body.instances, 1);
    assert.equal(health.body.ok, true);
    assert.deepEqual(autoStops, []);
  } finally {
    await server.stop();
    fs.rmSync(ownershipDir, { recursive: true, force: true });
  }
});

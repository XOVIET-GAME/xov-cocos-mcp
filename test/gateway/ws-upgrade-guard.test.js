'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { GatewayServer } = require('../../lib/gateway/gateway-server');

function upgrade(port, headers) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('close', () => resolve(data.split('\r\n')[0]));
    socket.on('error', reject);
    socket.on('connect', () => {
      const lines = ['GET /control HTTP/1.1', 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13'];
      for (const [k, v] of Object.entries(headers)) lines.push(k + ': ' + v);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      setTimeout(() => socket.destroy(), 300);
    });
  });
}

test('real Gateway WebSocket upgrade enforces token, Host and Origin on loopback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-ws-'));
  const server = new GatewayServer({ host: '127.0.0.1', port: 0, ownershipDir: dir, authToken: 'secret' });
  await server.start();
  const port = server.getPort();
  const host = '127.0.0.1:' + port;
  try {
    assert.match(await upgrade(port, { Host: host, 'Sec-WebSocket-Protocol': 'bearer.secret' }), /101/);
    assert.match(await upgrade(port, { Host: host, Origin: 'file://', 'Sec-WebSocket-Protocol': 'bearer.secret' }), /101/);
    assert.match(await upgrade(port, { Host: host, Authorization: 'Bearer secret' }), /101/);
    assert.match(await upgrade(port, { Host: host, 'Sec-WebSocket-Protocol': 'bearer.wrong' }), /401/);
    assert.match(await upgrade(port, { Host: host }), /401/);
    assert.match(await upgrade(port, { Host: 'evil.example', 'Sec-WebSocket-Protocol': 'bearer.secret' }), /403/);
    assert.match(await upgrade(port, { Host: host, Origin: 'https://evil.example', 'Sec-WebSocket-Protocol': 'bearer.secret' }), /403/);
    assert.match(await upgrade(port, { Host: host, Origin: 'null', 'Sec-WebSocket-Protocol': 'bearer.secret' }), /403/);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

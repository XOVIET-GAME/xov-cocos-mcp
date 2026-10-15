'use strict';

// Small dependency-free WebSocket server for the extension control channel.
// Cocos Creator already provides a WebSocket client in its Electron runtime,
// while the Gateway must be able to accept that outbound connection without
// requiring an additional native module such as `ws`.

const crypto = require('crypto');
const { safeEqualToken } = require('./auth');
const { DEFAULT_MAX_FRAME_BYTES, decodeFrame, encodeFrame } = require('./ws-frames');

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class ControlWebSocketConnection {
  constructor(socket, options = {}) {
    this.socket = socket;
    this.maxFrameBytes = Number.isFinite(options.maxFrameBytes)
      ? options.maxFrameBytes
      : DEFAULT_MAX_FRAME_BYTES;
    this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : null;
    this.onClose = typeof options.onClose === 'function' ? options.onClose : null;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    this.sessionId = '';
    this.connectionId = '';

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.consume(chunk));
    socket.on('error', () => this.close());
    socket.on('end', () => this.close());
    socket.on('close', () => this.close());
  }

  consume(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (true) {
        const frame = this.readFrame();
        if (!frame) return;
        this.handleFrame(frame);
      }
    } catch (error) {
      this.close(1002, error.message);
    }
  }

  readFrame() {
    const frame = decodeFrame(this.buffer, { expectMasked: true, maxFrameBytes: this.maxFrameBytes });
    if (!frame) return null;
    this.buffer = this.buffer.subarray(frame.bytesConsumed);
    return frame;
  }

  handleFrame(frame) {
    if (frame.opcode === 0x8) {
      if (!this.closed) this.sendFrame(0x8, frame.payload.subarray(0, 125));
      this.close();
      return;
    }
    if (frame.opcode === 0x9) {
      this.sendFrame(0xA, frame.payload);
      return;
    }
    if (frame.opcode === 0xA) return;

    if (frame.opcode === 0x1 || frame.opcode === 0x0) {
      if (frame.opcode === 0x1) {
        if (this.fragmentOpcode) throw new Error('Nested fragmented WebSocket message.');
        this.fragmentOpcode = frame.opcode;
      } else if (!this.fragmentOpcode) {
        throw new Error('Unexpected WebSocket continuation frame.');
      }
      this.fragments.push(frame.payload);
      if (!frame.fin) return;
      const payload = Buffer.concat(this.fragments);
      this.fragments = [];
      this.fragmentOpcode = 0;
      if (payload.length > this.maxFrameBytes) {
        throw new Error('WebSocket message exceeds the maximum payload size.');
      }
      let message;
      try {
        message = JSON.parse(payload.toString('utf8'));
      } catch (error) {
        throw new Error('Invalid JSON WebSocket message: ' + error.message);
      }
      if (this.onMessage) {
        Promise.resolve(this.onMessage(message, this)).catch(() => this.close(1011, 'message handler failed'));
      }
      return;
    }
    throw new Error('Unsupported WebSocket opcode: ' + frame.opcode);
  }

  request(_gatewayUrl, message, _sessionId) {
    if (this.closed) return Promise.reject(new Error('WebSocket control channel is closed.'));
    if (!message || message.id === undefined || message.id === null) {
      return Promise.reject(new Error('WebSocket requests require a JSON-RPC id.'));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(String(message.id), { resolve, reject });
      try {
        this.send(message);
      } catch (error) {
        this.pending.delete(String(message.id));
        reject(error);
      }
    });
  }

  resolveResponse(message) {
    if (!message || message.id === undefined || message.id === null) return false;
    const waiter = this.pending.get(String(message.id));
    if (!waiter) return false;
    this.pending.delete(String(message.id));
    waiter.resolve(message);
    return true;
  }

  send(message) {
    if (this.closed) throw new Error('WebSocket control channel is closed.');
    const text = JSON.stringify(message);
    const payload = Buffer.from(text, 'utf8');
    if (payload.length > this.maxFrameBytes) {
      throw new Error('WebSocket message exceeds the maximum payload size.');
    }
    this.sendFrame(0x1, payload);
  }

  sendFrame(opcode, payload) {
    if (this.closed) return;
    this.socket.write(encodeFrame(opcode, payload));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) {
      waiter.reject(new Error('WebSocket control channel closed.'));
    }
    this.pending.clear();
    try {
      const reasonBuffer = Buffer.from(String(reason).slice(0, 123), 'utf8');
      const closePayload = Buffer.alloc(2 + reasonBuffer.length);
      closePayload.writeUInt16BE(code, 0);
      reasonBuffer.copy(closePayload, 2);
      this.sendFrame(0x8, closePayload);
    } catch (error) {
      // The peer may already have gone away.
    }
    try {
      this.socket.destroy();
    } catch (error) {
      // Best effort.
    }
    if (this.onClose) this.onClose(this);
  }
}

function attachControlWebSocketServer(server, options = {}) {
  const path = options.path || '/control';
  const authToken = String(options.authToken || '');
  const connections = new Set();
  const onConnection = typeof options.onConnection === 'function' ? options.onConnection : null;
  const onClose = typeof options.onClose === 'function' ? options.onClose : null;
  const validateRequest = typeof options.validateRequest === 'function' ? options.validateRequest : null;

  const onUpgrade = (request, socket, head) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url || '/', 'http://localhost');
    } catch (error) {
      socket.destroy();
      return;
    }
    if (requestUrl.pathname !== path || String(request.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    if (validateRequest && !validateRequest(request)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const offeredProtocols = String(request.headers['sec-websocket-protocol'] || '')
      .split(',').map((protocol) => protocol.trim()).filter(Boolean);
    const bearerProtocol = offeredProtocols.find((protocol) => protocol.startsWith('bearer.')) || '';
    const protocolToken = bearerProtocol.slice('bearer.'.length);
    const authorization = request.headers.authorization || '';
    const authorizedByHeader = typeof authorization === 'string'
      && authorization.startsWith('Bearer ')
      && safeEqualToken(authorization.slice('Bearer '.length), authToken);
    const authorizedByProtocol = Boolean(bearerProtocol) && safeEqualToken(protocolToken, authToken);
    if (authToken && !authorizedByHeader && !authorizedByProtocol) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = request.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(String(key) + WEBSOCKET_GUID).digest('base64');
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + accept,
    ];
    if (authorizedByProtocol) responseHeaders.push('Sec-WebSocket-Protocol: ' + bearerProtocol);
    socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');

    const connection = new ControlWebSocketConnection(socket, {
      maxFrameBytes: options.maxFrameBytes,
      onMessage: (message, current) => {
        if (message && message.jsonrpc === '2.0' && !message.method) {
          current.resolveResponse(message);
          return;
        }
        if (onConnection) return onConnection(current, message);
        return undefined;
      },
      onClose: (current) => {
        connections.delete(current);
        if (onClose) onClose(current);
      },
    });
    connections.add(connection);
    if (head && head.length) connection.consume(head);
  };

  server.on('upgrade', onUpgrade);
  return {
    connections,
    close() {
      server.off('upgrade', onUpgrade);
      for (const connection of Array.from(connections)) connection.close(1001, 'Gateway stopped.');
      connections.clear();
    },
  };
}

module.exports = {
  ControlWebSocketConnection,
  attachControlWebSocketServer,
  DEFAULT_MAX_FRAME_BYTES,
};

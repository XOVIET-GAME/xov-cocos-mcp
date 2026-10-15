'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { DEFAULT_MAX_FRAME_BYTES, decodeFrame, encodeFrame } = require('./ws-frames');

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

class NodeWebSocket {
  constructor(url, protocols, options = {}) {
    this.url = String(url);
    this.readyState = CONNECTING;
    this.protocol = '';
    this.extensions = '';
    this.bufferedAmount = 0;
    this._listeners = new Map();
    this._socket = null;
    this._request = null;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = 0;
    this._maxFrameBytes = Number.isFinite(options.maxFrameBytes) ? options.maxFrameBytes : DEFAULT_MAX_FRAME_BYTES;
    this._closeSent = false;
    this._closeReceived = false;
    this._peerCloseCode = 1005;
    this._peerCloseReason = '';
    this._closeEmitted = false;
    this._closeTimer = null;
    this._handshakeKey = crypto.randomBytes(16).toString('base64');
    this._offeredProtocols = normalizeProtocols(protocols);
    this._connect();
  }

  addEventListener(type, listener, options = {}) {
    if (!listener) return;
    const list = this._listeners.get(type) || [];
    list.push({ listener, once: Boolean(options && options.once) });
    this._listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    const list = this._listeners.get(type);
    if (!list) return;
    this._listeners.set(type, list.filter((entry) => entry.listener !== listener));
  }

  _dispatch(type, values = {}) {
    const event = Object.assign({ type, target: this, currentTarget: this }, values);
    const list = this._listeners.get(type) || [];
    for (const entry of list.slice()) {
      try {
        if (typeof entry.listener === 'function') entry.listener.call(this, event);
        else if (entry.listener && typeof entry.listener.handleEvent === 'function') entry.listener.handleEvent(event);
      } catch (error) {
        process.nextTick(() => { throw error; });
      }
      if (entry.once) this.removeEventListener(type, entry.listener);
    }
    return event;
  }

  _connect() {
    let target;
    try {
      target = new URL(this.url);
      if (target.protocol !== 'ws:' && target.protocol !== 'wss:') throw new Error('WebSocket URL must use ws: or wss:.');
      if (target.username || target.password) throw new Error('WebSocket URL credentials are not supported.');
    } catch (error) {
      process.nextTick(() => this._fail(error));
      return;
    }
    const client = target.protocol === 'wss:' ? https : http;
    const headers = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': this._handshakeKey,
      'Sec-WebSocket-Version': '13',
    };
    if (this._offeredProtocols.length) headers['Sec-WebSocket-Protocol'] = this._offeredProtocols.join(', ');
    const request = client.request({
      protocol: target.protocol === 'wss:' ? 'https:' : 'http:',
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname + target.search,
      method: 'GET',
      headers,
      agent: false,
    });
    this._request = request;
    request.once('upgrade', (response, socket, head) => {
      const expectedAccept = crypto.createHash('sha1').update(this._handshakeKey + WEBSOCKET_GUID).digest('base64');
      const selectedProtocol = String(response.headers['sec-websocket-protocol'] || '');
      if (response.statusCode !== 101
        || String(response.headers['sec-websocket-accept'] || '') !== expectedAccept
        || String(response.headers.upgrade || '').toLowerCase() !== 'websocket'
        || !String(response.headers.connection || '').toLowerCase().split(',').map((value) => value.trim()).includes('upgrade')
        || (selectedProtocol && !this._offeredProtocols.includes(selectedProtocol))
        || (this._offeredProtocols.length > 0 && !selectedProtocol)) {
        socket.destroy();
        this._fail(new Error('Invalid WebSocket handshake response.'));
        return;
      }
      this.protocol = selectedProtocol;
      this._socket = socket;
      this.readyState = OPEN;
      socket.setNoDelay(true);
      socket.on('data', (chunk) => this._consume(chunk));
      socket.on('error', (error) => this._fail(error));
      socket.on('end', () => this._finishClose());
      socket.on('close', () => this._finishClose());
      if (head && head.length) this._consume(head);
      if (this.readyState === OPEN) this._dispatch('open');
    });
    request.once('response', (response) => {
      response.resume();
      this._fail(new Error('WebSocket handshake failed with HTTP ' + response.statusCode + '.'));
    });
    request.once('error', (error) => this._fail(error));
    request.end();
  }

  send(data) {
    if (this.readyState !== OPEN || !this._socket) throw new Error('WebSocket is not open.');
    let opcode;
    let payload;
    if (typeof data === 'string') {
      opcode = 0x1;
      payload = Buffer.from(data, 'utf8');
    } else if (Buffer.isBuffer(data) || ArrayBuffer.isView(data)) {
      opcode = 0x2;
      payload = Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength);
    } else if (data instanceof ArrayBuffer) {
      opcode = 0x2;
      payload = Buffer.from(data);
    } else {
      throw new TypeError('WebSocket data must be a string or binary buffer.');
    }
    if (payload.length > this._maxFrameBytes) throw new Error('WebSocket message exceeds the maximum payload size.');
    this._writeFrame(opcode, payload);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    if (this.readyState === CONNECTING) {
      this.readyState = CLOSING;
      if (this._request) this._request.destroy();
      this._finishClose();
      return;
    }
    const reasonBytes = Buffer.from(String(reason), 'utf8');
    if (!validCloseCode(code) || reasonBytes.length > 123) throw new Error('Invalid WebSocket close code or reason.');
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.readyState = CLOSING;
    this._closeSent = true;
    this._writeFrame(0x8, payload);
    this._startCloseTimer();
    if (this._closeReceived && this._socket) this._socket.end();
  }

  _writeFrame(opcode, payload) {
    if (!this._socket || this._socket.destroyed) return;
    const frame = encodeFrame(opcode, payload, { mask: true });
    this.bufferedAmount += frame.length;
    this._socket.write(frame, () => { this.bufferedAmount = Math.max(0, this.bufferedAmount - frame.length); });
  }

  _consume(chunk) {
    if (this.readyState === CLOSED) return;
    this._buffer = Buffer.concat([this._buffer, chunk]);
    try {
      while (true) {
        const frame = decodeFrame(this._buffer, { expectMasked: false, maxFrameBytes: this._maxFrameBytes });
        if (!frame) return;
        this._buffer = this._buffer.subarray(frame.bytesConsumed);
        this._handleFrame(frame);
        if (this.readyState === CLOSED) return;
      }
    } catch (error) {
      this._protocolError(error.message);
    }
  }

  _handleFrame(frame) {
    if (frame.opcode >= 0x8 && (!frame.fin || frame.payload.length > 125)) throw new Error('Invalid WebSocket control frame.');
    if (frame.opcode === 0x8) {
      this._closeReceived = true;
      if (frame.payload.length === 1) throw new Error('Invalid WebSocket close payload.');
      if (frame.payload.length >= 2) {
        this._peerCloseCode = frame.payload.readUInt16BE(0);
        this._peerCloseReason = frame.payload.subarray(2).toString('utf8');
      }
      if (!this._closeSent) {
        this._closeSent = true;
        this.readyState = CLOSING;
        this._writeFrame(0x8, frame.payload);
      }
      if (this._socket) this._socket.end();
      return;
    }
    if (frame.opcode === 0x9) {
      this._writeFrame(0xA, frame.payload);
      this._dispatch('ping', { data: Buffer.from(frame.payload) });
      return;
    }
    if (frame.opcode === 0xA) {
      this._dispatch('pong', { data: Buffer.from(frame.payload) });
      return;
    }
    if (frame.opcode === 0x1 || frame.opcode === 0x2) {
      if (this._fragmentOpcode) throw new Error('Nested fragmented WebSocket message.');
      this._fragmentOpcode = frame.opcode;
    } else if (frame.opcode === 0x0) {
      if (!this._fragmentOpcode) throw new Error('Unexpected WebSocket continuation frame.');
    } else {
      throw new Error('Unsupported WebSocket opcode: ' + frame.opcode);
    }
    this._fragments.push(frame.payload);
    const messageBytes = this._fragments.reduce((sum, part) => sum + part.length, 0);
    if (messageBytes > this._maxFrameBytes) throw new Error('WebSocket message exceeds the maximum payload size.');
    if (!frame.fin) return;
    const opcode = this._fragmentOpcode;
    const payload = Buffer.concat(this._fragments, messageBytes);
    this._fragments = [];
    this._fragmentOpcode = 0;
    const data = opcode === 0x1 ? payload.toString('utf8') : payload;
    this._dispatch('message', { data });
  }

  _protocolError(reason) {
    if (this.readyState === CLOSED) return;
    if (this.readyState === OPEN) {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(1002, 0);
      this.readyState = CLOSING;
      this._closeSent = true;
      this._writeFrame(0x8, payload);
    }
    this._dispatch('error', { error: new Error(reason), message: reason });
    this._startCloseTimer();
  }

  _fail(error) {
    if (this.readyState === CLOSED) return;
    this._dispatch('error', { error, message: error.message });
    if (this._socket) this._socket.destroy();
    else if (this._request) this._request.destroy();
    this._finishClose();
  }

  _startCloseTimer() {
    if (this._closeTimer) return;
    this._closeTimer = setTimeout(() => {
      if (this._socket) this._socket.destroy();
      this._finishClose();
    }, 1000);
    if (typeof this._closeTimer.unref === 'function') this._closeTimer.unref();
  }

  _finishClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    if (this._closeTimer) clearTimeout(this._closeTimer);
    this._closeTimer = null;
    this.readyState = CLOSED;
    const wasClean = this._closeSent && this._closeReceived;
    this._dispatch('close', {
      wasClean,
      code: wasClean ? this._peerCloseCode : 1006,
      reason: wasClean ? this._peerCloseReason : '',
    });
  }
}

function normalizeProtocols(protocols) {
  if (protocols === undefined || protocols === null) return [];
  const values = Array.isArray(protocols) ? protocols : [protocols];
  const seen = new Set();
  for (const value of values) {
    const protocol = String(value);
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(protocol) || seen.has(protocol)) {
      throw new SyntaxError('Invalid or duplicate WebSocket subprotocol.');
    }
    seen.add(protocol);
  }
  return values.map(String);
}

function validCloseCode(code) {
  return Number.isInteger(code) && ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999));
}

NodeWebSocket.CONNECTING = CONNECTING;
NodeWebSocket.OPEN = OPEN;
NodeWebSocket.CLOSING = CLOSING;
NodeWebSocket.CLOSED = CLOSED;

module.exports = { NodeWebSocket };

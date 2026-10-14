'use strict';

// Transport abstraction for the bidirectional control channel between the
// Cocos extension (client) and the Gateway (server).
//
// Phase 0 ships two implementations:
//   - HTTP transport: request/response over POST /control. Used by unit tests
//     and as a fallback where no WebSocket client exists.
//   - WebSocket transport: used inside the Cocos Creator (Electron) runtime
//     when a WebSocket client is available. It provides a persistent
//     bidirectional channel that Phase 1 uses to push command requests from
//     the Gateway to the extension.
//
// No external dependencies are required.

const http = require('http');
const https = require('https');

const ACCEPT_HEADER = 'application/json';

function httpClientFor(urlText) {
  return urlText.startsWith('https:') ? https : http;
}

// Resolves a gateway URL like http://127.0.0.1:8787 into hostname/port.
function parseGatewayUrl(urlText) {
  const parsed = new URL(urlText);
  return {
    hostname: parsed.hostname,
    port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
  };
}

function postJson(urlText, pathWithQuery, bodyText, headers) {
  const client = httpClientFor(urlText);
  const parsed = new URL(urlText);
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  return new Promise((resolve, reject) => {
    const request = client.request(
      {
        hostname: parsed.hostname,
        port,
        path: pathWithQuery,
        method: 'POST',
        agent: false,
        headers: Object.assign({
          Accept: ACCEPT_HEADER,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyText),
        }, headers || {}),
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsedBody = null;
          if (text) {
            try {
              parsedBody = JSON.parse(text);
            } catch (error) {
              parsedBody = null;
            }
          }
          resolve({
            statusCode: response.statusCode || 0,
            headers: response.headers,
            body: parsedBody,
            bodyText: text,
          });
        });
      }
    );
    request.on('error', reject);
    request.end(bodyText);
  });
}

function getJson(urlText, pathWithQuery) {
  const client = httpClientFor(urlText);
  const parsed = new URL(urlText);
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  return new Promise((resolve, reject) => {
    const request = client.request(
      {
        hostname: parsed.hostname,
        port,
        path: pathWithQuery,
        method: 'GET',
        agent: false,
        headers: { Accept: ACCEPT_HEADER },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsedBody = null;
          if (text) {
            try {
              parsedBody = JSON.parse(text);
            } catch (error) {
              parsedBody = null;
            }
          }
          resolve({
            statusCode: response.statusCode || 0,
            headers: response.headers,
            body: parsedBody,
            bodyText: text,
          });
        });
      }
    );
    request.on('error', reject);
    request.end();
  });
}

// Request/response transport over HTTP POST /control. Suitable for tests and
// environments without a WebSocket client. The channel remains addressable via
// the session id in the query string.
function createHttpControlTransport({ authToken } = {}) {
  return {
    kind: 'http',
    request: async (gatewayUrl, message, sessionId) => {
      const sessionQuery = sessionId ? '?session=' + encodeURIComponent(sessionId) : '';
      const response = await postJson(gatewayUrl, '/control' + sessionQuery, JSON.stringify(message), authToken ? { Authorization: 'Bearer ' + authToken } : {});
      if (response.statusCode === 202 || !response.body) {
        return null;
      }
      return response.body;
    },
    health: async (gatewayUrl) => {
      try {
        const response = await getJson(gatewayUrl, '/health');
        if (response.statusCode !== 200) {
          return null;
        }
        return response.body;
      } catch (error) {
        return null;
      }
    },
    close: async () => {},
  };
}

// Persistent bidirectional transport over WebSocket. In the Cocos Creator
// (Electron) runtime a WebSocket client may be available globally; callers can
// also inject one for tests. Messages are JSON-RPC 2.0 frames.
function createWebSocketControlTransport({ WebSocket, authToken } = {}) {
  const WsCtor = WebSocket || (typeof globalThis !== 'undefined' ? globalThis.WebSocket : null);
  if (!WsCtor) {
    throw new Error('WebSocket transport requires a WebSocket client.');
  }

  return {
    kind: 'websocket',
    connect: (gatewayUrl, { onMessage, onClose, onOpen, authToken: connectionToken } = {}) => {
      const wsUrl = new URL(gatewayUrl.replace(/^http/i, 'ws'));
      const basePath = wsUrl.pathname.replace(/\/mcp\/?$/, '').replace(/\/$/, '');
      wsUrl.pathname = (basePath || '') + '/control';
      const token = connectionToken || authToken;
      const socket = new WsCtor(wsUrl.toString(), token ? ['bearer.' + token] : undefined);
      const waiters = new Map();
      let opened = socket.readyState === 1;
      let closed = false;
      let openResolve;
      let openReject;
      const ready = new Promise((resolve, reject) => {
        openResolve = resolve;
        openReject = reject;
      });
      if (opened) openResolve();
      // A caller may only create/close a channel without ever issuing a
      // request. Mark the rejection as observed so a pre-open close cannot
      // become an unhandled rejection in that valid lifecycle.
      ready.catch(() => {});

      socket.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch (error) {
          return;
        }
        const kind = classifyMessage(message);
        if (kind === 'response') {
          const waiter = waiters.get(String(message.id));
          if (waiter) {
            waiters.delete(String(message.id));
            waiter.resolve(message);
          }
        } else if (onMessage) {
          onMessage(message);
        }
      });

      socket.addEventListener('close', () => {
        closed = true;
        if (!opened) openReject(new Error('WebSocket closed before opening.'));
        for (const waiter of waiters.values()) waiter.reject(new Error('WebSocket control channel closed.'));
        waiters.clear();
        if (onClose) {
          onClose();
        }
      });
      socket.addEventListener('open', () => {
        opened = true;
        openResolve();
        if (onOpen) {
          onOpen();
        }
      });

      return {
        request: async (_gatewayUrl, message) => {
          await ready;
          if (closed || (socket.readyState !== WsCtor.OPEN && socket.readyState !== 1)) {
            throw new Error('WebSocket is not open.');
          }
          return new Promise((resolve, reject) => {
            waiters.set(String(message.id), { resolve, reject });
            try {
              socket.send(JSON.stringify(message));
            } catch (error) {
              waiters.delete(String(message.id));
              reject(error);
            }
          });
        },
        send: async (_gatewayUrl, message) => {
          await ready;
          if (closed || (socket.readyState !== WsCtor.OPEN && socket.readyState !== 1)) {
            throw new Error('WebSocket is not open.');
          }
          socket.send(JSON.stringify(message));
        },
        health: async (gatewayUrl) => {
          try {
            const response = await getJson(gatewayUrl, '/health');
            if (response.statusCode !== 200) {
              return null;
            }
            return response.body;
          } catch (error) {
            return null;
          }
        },
        close: async () => {
          try {
            socket.close();
          } catch (error) {
            // Best-effort close.
          }
        },
      };
    },
    health: async (gatewayUrl) => {
      try {
        const response = await getJson(gatewayUrl, '/health');
        if (response.statusCode !== 200) {
          return null;
        }
        return response.body;
      } catch (error) {
        return null;
      }
    },
    close: async () => {},
  };
}

function classifyMessage(message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    return 'invalid';
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  if (typeof message.method === 'string') {
    return hasId ? 'request' : 'notification';
  }
  if (hasId && (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'))) {
    return 'response';
  }
  return 'invalid';
}

module.exports = {
  createHttpControlTransport,
  createWebSocketControlTransport,
  postJson,
  getJson,
  parseGatewayUrl,
  classifyMessage,
};

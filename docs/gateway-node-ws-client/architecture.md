# Gateway Node WebSocket client

## Problem (verified 2026-10-15 on real Cocos Creator 3.8.8)
The extension runs in the Editor main process (Node 20.15.1, Electron 31.3.1). `globalThis.WebSocket` is `undefined` there, so `browser.js` falls back to the lifecycle-only HTTP transport: the Editor registers with the Gateway but every `tools/call` fails with `TARGET_UNAVAILABLE ... has no control transport`. Gateway tool forwarding has never worked on Creator 3.8.x.

## Design (decided by advisor)
- New `lib/gateway/ws-client.js`: minimal RFC 6455 client on `http.request` + `'upgrade'`. No `ws` dependency (extension ships without node_modules).
- Same surface `createWebSocketControlTransport` uses: `new Ctor(url, protocols)`, `readyState`, `send`, `close`, `addEventListener('open'|'message'|'close'|'error')`, static `OPEN`. `transport.js` and the server stay unchanged.
- Handshake: random `Sec-WebSocket-Key`, Version 13, verify `Sec-WebSocket-Accept` and echoed `bearer.<token>` subprotocol. Never send an `Origin` header.
- Frames: mask all outgoing frames; 7/16/64-bit lengths; continuation frames; ping->pong; close handshake; `close` event fires exactly once (also on abrupt destroy); honor the 256 KB max frame size.
- Extract frame encode/decode from `control-websocket.js` into a shared helper `lib/gateway/ws-frames.js`; server behavior stays byte-identical.
- Auth stays subprotocol-based (already tested end-to-end).
- `browser.js` order: `globalThis.WebSocket` -> `globalThis.window.WebSocket` -> Node client -> lifecycle-only HTTP (last resort).
- Hard compatibility ceiling: Node 20.15. No Node 22+ APIs.

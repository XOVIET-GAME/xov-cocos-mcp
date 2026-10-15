# Decisions
- 2026-10-15 (advisor): write an in-repo Node WebSocket client instead of adding the `ws` dependency; reuse subprotocol auth; extract shared frame codec; keep transport.js and the server unchanged. Rejected: bundling `ws` (no node_modules in shipped extension), query-string token (leaks into logs).

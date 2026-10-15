# Plan
1. ws-frames.js shared codec (extracted from control-websocket.js). 2. ws-client.js. 3. browser.js fallback wiring. 4. Tests. 5. Real-Editor closure by the coordinator (not the worker).
Acceptance: `npm test` fail 0, `npm run check:all` clean, new tests cover sizes 0/125/126/65535/65536+, ping/pong, close from each side, bad token, and a GatewayServer tools/call round trip.

# Cocos CLI Gateway — Technical Documentation

## 1. Source map

```text
bin/
├── cocos-cli.js                  # public wrapper
└── funplay-cocos-mcp.js          # client-only CLI implementation

lib/extension/
├── gateway-client.js             # extension lifecycle/control client
├── instance-registration.js      # registration identity builder
└── editor-command-executor.js    # tool registry adapter

lib/gateway/
├── gateway-server.js              # central server and routing
├── mcp-front-door.js              # MCP protocol surface
├── control-websocket.js           # dependency-free WS server
├── transport.js                   # HTTP/WS control transports
├── extension-protocol.js          # control message contract
├── daemon-entry.js                # internal detached entrypoint
├── process-manager.js             # launch lock and ownership state
├── target-registry.js             # dynamic Editor targets
├── session-registry.js            # agent sessions
├── tool-policies.js               # access/resource metadata
├── lock-manager.js                # atomic ordered locks
├── scheduler.js                   # request execution lifecycle
├── conflict-detector.js           # revision/hash state
├── idempotency-store.js           # mutation retry deduplication
├── job-manager.js                 # long-running jobs
├── audit-log.js                   # bounded event log
├── metrics.js                     # counters
└── rate-limiter.js                # optional request limiter
```

## 2. Build and verification

```bash
npm install
npm run check
npm test
node --test --test-timeout=30000 test/gateway/*.test.js
```

Expected baseline at handoff:

- `npm run check`: pass;
- `npm test`: 198 tests, 196 pass, 2 skipped when `zip` is unavailable;
- Gateway tests: 114/114 pass.

## 3. CLI contract

### Commands

```bash
cocos-cli mcp
cocos-cli targets list
cocos-cli target health <targetId>
cocos-cli call <toolName> [jsonArguments] [--target <targetId>]
```

Options:

```text
--url <url>             Gateway MCP endpoint
--timeout-seconds <n>   HTTP timeout
--token <value>         Gateway bearer token
--target <targetId>     target for one-shot call
--help
--version
```

Environment:

| Variable | Consumer | Meaning |
|---|---|---|
| `FUNPLAY_COCOS_GATEWAY_URL` | CLI | Gateway URL override |
| `FUNPLAY_COCOS_MCP_URL` | CLI | legacy URL compatibility |
| `FUNPLAY_COCOS_GATEWAY_TOKEN` | CLI | bearer token |
| `FUNPLAY_COCOS_MCP_TIMEOUT_SECONDS` | CLI | default timeout |
| `COCOS_GATEWAY_URL` | extension | Gateway URL |
| `COCOS_GATEWAY_AUTH_TOKEN` | extension/daemon | bearer token |
| `COCOS_GATEWAY_HOST` | daemon | listen host |
| `COCOS_GATEWAY_PORT` | daemon | listen port |
| `COCOS_GATEWAY_OWNERSHIP_DIR` | extension/daemon | state directory |
| `COCOS_GATEWAY_LAUNCH_NONCE` | internal launcher | ownership nonce |

`cocos-cli` behavior khi Gateway unavailable:

```text
exit code: 1
error code: GATEWAY_UNAVAILABLE / -32050
action: open a Cocos Editor with the extension active
```

Không tồn tại public `router start`, `router ensure` hoặc `router stop`.

## 4. HTTP surface

### `GET /health`

Không yêu cầu token trong liveness flow. Trả:

```json
{
  "ok": true,
  "kind": "cocos-gateway",
  "protocolName": "cocos-gateway-control",
  "protocolVersion": "0.1.0",
  "serverInstanceId": "host-pid-random",
  "pid": 1234,
  "port": 8787,
  "ownership": {
    "ownerExtensionId": "funplay-cocos-mcp",
    "ownerInstanceId": "ext-...",
    "launchNonce": "...",
    "autoStartedByExtension": true
  },
  "instances": 2,
  "sessions": 3,
  "jobs": 0,
  "activeRequests": 1,
  "targets": []
}
```

`GET /health?targetId=<id>` thêm field `target`.

### `POST /mcp`

MCP Streamable HTTP JSON-RPC endpoint. Hỗ trợ initialize, notifications, `tools/list`, `tools/call`, resources và DELETE session.

### `POST /control`

HTTP control transport cho lifecycle/test. Production command forwarding dùng WebSocket.

### `GET /metrics`

JSON counters; yêu cầu bearer token khi Gateway bật auth.

### WebSocket `/control`

Extension tạo outbound WebSocket tới:

```text
ws://127.0.0.1:8787/control
wss://host:port/control?token=<token>
```

Server hỗ trợ masked frames, fragmentation, ping/pong, correlation và JSON-RPC messages mà không cần dependency `ws`.

## 5. Control protocol

### Registration

```json
{
  "jsonrpc": "2.0",
  "id": "register-uuid",
  "method": "instance.register",
  "params": {
    "editorInstanceId": "editor-uuid",
    "projectId": "sha256-project-path",
    "generation": "1",
    "ownerExtensionId": "funplay-cocos-mcp",
    "ownerInstanceId": "ext-uuid",
    "cocosVersion": "3.8.x",
    "capabilities": ["scene", "asset", "preview", "screenshot", "tools/list"],
    "pid": 1234,
    "protocolVersion": "0.1.0"
  }
}
```

Gateway trả `connectionId`, `sessionId`, `generation` context và heartbeat interval.

### Heartbeat/unregister

```json
{"jsonrpc":"2.0","id":"hb-1","method":"instance.heartbeat","params":{"editorInstanceId":"editor-uuid","generation":"1"}}
```

```json
{"jsonrpc":"2.0","id":"unreg-1","method":"instance.unregister","params":{"editorInstanceId":"editor-uuid","sessionToken":"conn-...","generation":"1","reason":"editor-shutdown"}}
```

Generation/session mismatch không được phép thay đổi target connection mới.

### Command request/result

```json
{
  "jsonrpc": "2.0",
  "id": "cmd-1",
  "method": "command.request",
  "params": {
    "requestId": "cmd-1",
    "mcpRequestId": "agent-rpc-1",
    "targetId": "game-editor",
    "generation": "4",
    "deadline": "2026-08-04T12:00:30.000Z",
    "tool": {
      "name": "get_hierarchy",
      "arguments": {"deep": true, "projectId": "project-1"}
    }
  }
}
```

Extension trả:

```json
{
  "jsonrpc": "2.0",
  "id": "cmd-1",
  "result": {
    "requestId": "cmd-1",
    "tool": "get_hierarchy",
    "value": {},
    "executedBy": "project-name"
  }
}
```

Cancellation:

```json
{
  "jsonrpc": "2.0",
  "id": "cancel-1",
  "method": "command.cancel",
  "params": {"requestId": "cmd-1", "targetId": "game-editor", "generation": "4"}
}
```

## 6. MCP admin surface

Gateway bổ sung các tool:

| Tool | Purpose |
|---|---|
| `cocos_targets` | list target registry |
| `cocos_target_health` | inspect one target |
| `cocos_lock_status` | inspect held/waiting leases |
| `cocos_job_status` | inspect long-running jobs |
| `cocos_audit` | filter audit events |
| `cocos_cancel` | cancel request or job |

Resources:

```text
cocos://targets/<targetId>/state
cocos://targets/<targetId>/logs
cocos://projects/<projectId>/locks
```

## 7. Routing, permissions and policies

### Target resolution

```text
explicit targetId -> session pinned target -> project primary -> single candidate -> ambiguous error
```

Mutation trên read-only session trả `PERMISSION_DENIED`. Mutation tới target read-only trả `PRIMARY_WRITER_REQUIRED`. Target không advertise capability cần thiết trả `CAPABILITY_UNAVAILABLE`.

### Tool policy

Tool policy trả:

```js
{
  name,
  access: 'read' | 'write' | 'exclusive',
  scope: 'editor' | 'script' | 'interactive' | 'long-running',
  resources,
  cancellable,
  timeoutMs,
  idempotent,
  requiredCapability
}
```

Read tools share read locks. Script/interactive tools là exclusive. Unknown tools mặc định write/exclusive editor resource để không bypass serialization.

## 8. Lock and scheduler details

Lock resources được normalize/dedupe/sort trước khi acquire. Một request không giữ partial lock. Lease có expiry và watchdog.

Scheduler lifecycle:

```text
create context
  -> acquire all locks
  -> execute command
  -> timeout/cancel/disconnect handling
  -> release lease
  -> audit result
```

Scheduler owns the external deadline and deliberately sets the Lock Manager wait timeout later, preventing a `LOCK_TIMEOUT` race from masking `REQUEST_TIMEOUT`.

## 9. Conflict and retry contract

Scalar form:

```json
{"expectedRevision": 2}
```

Resource form:

```json
{
  "expectedRevision": {
    "resources": {
      "file:assets/data.json": {"revision": 3, "hash": "optional"},
      "scene:scene-uuid": {"revision": 1}
    }
  }
}
```

Mutation response includes `revision` for the Editor resource and `revisions` for all locked resources. Mismatch yields `STALE_EDITOR_STATE` or `CONFLICT` and is not silently retried.

Mutation retry should use `idempotencyKey`:

```json
{
  "name": "write_file",
  "idempotencyKey": "agent-a-write-42",
  "arguments": {"path": "assets/data.json", "content": "{}"}
}
```

Same key + same fingerprint reuses the result; same key + different fingerprint returns `IDEMPOTENCY_KEY_REUSED`.

## 10. Error code reference

| Code/name | Meaning |
|---|---|
| `GATEWAY_UNAVAILABLE` / `-32050` | CLI cannot reach central Gateway |
| `TARGET_UNAVAILABLE` / `-32001` | no selected target online |
| `TARGET_AMBIGUOUS` / `-32004` | multiple candidates without explicit target |
| `GENERATION_MISMATCH` / `-32002` | stale Editor connection |
| `COMMAND_DISPATCH_FAILED` / `-32003` | command transport/correlation failure |
| `PRIMARY_WRITER_REQUIRED` / `-32013` | mutation target is read-only |
| `PERMISSION_DENIED` / `-32014` | agent session is read-only |
| `REQUEST_CANCELLED` / `-32015` | agent canceled request |
| `CAPABILITY_UNAVAILABLE` / `-32016` | target lacks required capability |
| `LOCK_TIMEOUT` / `-32010` | lock wait exceeded deadline |
| `REQUEST_TIMEOUT` / `-32011` | Editor/request deadline exceeded |
| `STALE_EDITOR_STATE` / `-32012` | revision mismatch |
| `AUTH_REQUIRED` / `-32040` | bearer token required/invalid |
| `RATE_LIMITED` / `-32029` | rate budget exceeded |
| `REQUEST_TOO_LARGE` / `-32030` | HTTP body exceeds 256 KiB |

## 11. Lifecycle implementation details

`GatewayClient.ensure()` is single-flight per extension process. `launchGatewayIfNeeded()` obtains a machine-level lock, rechecks health, verifies port occupancy, starts `daemon-entry.js` with `detached: true` and `stdio: ignore`, then waits for compatible health metadata.

`GatewayServer` only auto-stops when:

```text
ownership.autoStartedByExtension == true
AND autoStopWhenIdle == true
AND instances == 0
AND agent sessions == 0
AND active jobs == 0
AND active requests == 0
```

Stale target heartbeat and stale idle agent sessions are cleaned periodically. Primary writer promotion happens immediately when the current primary goes offline/unregisters.

## 12. Security and operational hardening

- non-loopback binding requires auth token unless explicit insecure override;
- HTTP authorization uses `Authorization: Bearer <token>`;
- WebSocket token is passed as `?token=<token>` during upgrade;
- HTTP body limit is 256 KiB;
- optional rate limiter returns `Retry-After`;
- `/metrics` exposes bounded counters and is auth-protected when configured;
- target aliases persist under the ownership directory;
- ownership state ignores stale dead PIDs.

## 13. Troubleshooting

### `GATEWAY_UNAVAILABLE`

1. Open a Cocos Creator project with the extension enabled.
2. Check `GET http://127.0.0.1:8787/health`.
3. Check extension Gateway URL and `autostart` configuration.
4. Inspect the ownership directory and daemon logs.
5. Ensure another process is not occupying the configured port.

### `TARGET_AMBIGUOUS`

Use `--target <targetId>` or provide `projectId`; do not rely on random routing.

### `PRIMARY_WRITER_REQUIRED`

Inspect `cocos_targets`/`/health` and wait for primary failover or explicitly route to the active primary target.

### `AUTH_REQUIRED`

Set the same token for Gateway, extension and CLI:

```powershell
$env:COCOS_GATEWAY_AUTH_TOKEN = 'replace-me'
$env:FUNPLAY_COCOS_GATEWAY_TOKEN = 'replace-me'
```

### Lock timeout

Inspect `cocos_lock_status`, `cocos_audit` and active jobs. A disconnected owner should be cleaned by Scheduler/Lock Manager; a stale connection should be removed by heartbeat TTL.

## 14. Known limitations and extension points

- Gateway state is local process state; no distributed lock or HA.
- Revision provider is currently Gateway-managed; a future provider can read actual file mtime/hash, scene asset revision and asset metadata.
- Arbitrary JavaScript cannot be statically classified, so it remains editor-exclusive.
- Cancellation cannot forcibly interrupt every existing Cocos tool; it is protocol-level and best-effort for the underlying tool.
- HTTP control fallback cannot receive pushed commands; use WebSocket in Cocos Electron production.
- Resource logs are namespaced now; a richer streaming log backend can be added without changing the URI contract.

## 15. Change checklist for future work

When changing a Gateway tool or protocol:

1. update policy/capability/resource mapping;
2. update extension executor/transport if envelope changes;
3. add unit + Gateway integration test;
4. run `npm run check`, `npm test`, and Gateway suite;
5. update handoff/architecture/technical docs;
6. keep `cocos-cli` free of lifecycle authority;
7. push to `origin`, preserving `upstream` as the original repository.

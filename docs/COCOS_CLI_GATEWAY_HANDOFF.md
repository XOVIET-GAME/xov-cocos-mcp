# Cocos CLI Gateway — Handoff Report

## 1. Thông tin bàn giao

- Ngày bàn giao: 2026-08-04
- Repository: `https://github.com/XOVIET-GAME/cocos-mcp-xoviet`
- Branch: `main`
- Commit nền tảng: `f037a86 feat: add centralized Cocos Gateway and CLI`
- `origin`: repository XOVIET-GAME
- `upstream`: `https://github.com/FunplayAI/funplay-cocos-mcp.git`
- Node.js yêu cầu: `>=18`

Mục tiêu của plan đã được triển khai: đưa `cocos-cli/router` thành MCP Gateway trung tâm cho nhiều agent và nhiều Cocos Creator Editor, trong đó tool vẫn được thực thi trong tiến trình Editor.

## 2. Quyết định kiến trúc quan trọng

1. `cocos-cli` là client-only. Nó chỉ bridge MCP stdio hoặc gọi các API read-only của Gateway; không import, spawn, start, stop hay route trực tiếp.
2. Cocos extension là startup authority duy nhất. Khi Editor mở, extension health-check Gateway; nếu Gateway chưa sống, extension dùng internal launcher để start daemon detached.
3. Gateway là process dùng chung cho nhiều agent và Editor. Gateway nhận MCP từ CLI, giữ session/lock/scheduler, rồi forward command tới extension qua control channel.
4. Tool execution không chuyển sang headless Editor mới. `lib/tool-registry.js`, `lib/tools/`, `browser.js` và Cocos Editor APIs vẫn là execution plane.
5. Mỗi Editor có `editorInstanceId` và target động. Một project có tối đa một `primary-writer`; các instance khác mặc định read-only.

## 3. Phạm vi đã hoàn thành

| Phase | Kết quả | Thành phần chính |
|---|---|---|
| 0 — Lifecycle/control | Health, ownership, detached launch, register/heartbeat/unregister, reconnect, TTL cleanup, auto-stop | `process-manager.js`, `daemon-entry.js`, `gateway-client.js`, `lifecycle-manager.js` |
| 1 — MCP Gateway | MCP front door, `tools/list`, `tools/call`, stdio bridge, one-shot CLI, target health | `gateway-server.js`, `mcp-front-door.js`, `bin/cocos-cli.js`, `bin/funplay-cocos-mcp.js` |
| 2 — Multi-editor | Dynamic target registry, target routing, sticky session, capability check, ambiguous/offline handling, primary failover | `target-registry.js`, `gateway-server.js` |
| 3 — Multi-agent | Agent session isolation, pinning, permissions, active request tracking, stale session cleanup, audit metadata | `session-registry.js`, `audit-log.js` |
| 4 — Concurrency | Tool policies, atomic multi-resource locks, fixed ordering, FIFO fairness, leases, watchdog, timeout/cancellation | `tool-policies.js`, `lock-manager.js`, `scheduler.js` |
| 5 — Reliability | Revision checks, resource revisions, idempotency, jobs, offline marking, reconnect, structured error codes, command cancellation | `conflict-detector.js`, `idempotency-store.js`, `job-manager.js`, `extension-protocol.js` |
| 6 — Hardening | Auth for non-loopback, body limit, rate limit, metrics, persistent aliases, diagnostics/resources, operations docs | `gateway-server.js`, `rate-limiter.js`, `metrics.js`, `target-registry.js` |

## 4. Runtime flow

### Editor startup

```text
Cocos Editor opens
  -> extension loads config
  -> GET /health
  -> if unavailable: extension launchDetached(daemon-entry.js)
  -> wait for compatible Gateway protocol/version
  -> open WebSocket /control
  -> instance.register
  -> heartbeat loop
```

### Agent tool call

```text
Agent
  -> stdio
  -> cocos-cli
  -> POST /mcp tools/call
  -> MCP Front Door/session
  -> target resolution
  -> permission/capability/conflict checks
  -> Scheduler + Lock Manager
  -> command.request over Editor control channel
  -> browser.js executor
  -> existing toolRegistry.callTool
  -> command.result
  -> Gateway correlation
  -> MCP response
```

### Editor shutdown

```text
Editor unload
  -> instance.unregister
  -> Target Registry removes instance
  -> primary failover if necessary
  -> stale/active workload check
  -> Gateway auto-stop only when owner-started and idle
```

## 5. Deliverables

### Public CLI

- `bin/cocos-cli.js`: public compatibility entrypoint.
- `bin/funplay-cocos-mcp.js`: shared client implementation and legacy binary compatibility.
- `cocos-cli mcp`: MCP stdio-to-Gateway bridge.
- `cocos-cli targets list`: list registered targets.
- `cocos-cli target health <targetId>`: inspect one target.
- `cocos-cli call <tool> [json] [--target <id>]`: one-shot Gateway call.

### Gateway

- `lib/gateway/gateway-server.js`: central HTTP/MCP/control server.
- `lib/gateway/mcp-front-door.js`: MCP negotiation, sessions, tools/resources dispatch.
- `lib/gateway/control-websocket.js`: dependency-free WebSocket server.
- `lib/gateway/transport.js`: HTTP and WebSocket control transports.
- `lib/gateway/target-registry.js`: dynamic Editor registry and primary role.
- `lib/gateway/session-registry.js`: agent session state.
- `lib/gateway/lock-manager.js`: atomic ordered locks.
- `lib/gateway/scheduler.js`: timeout, cancellation and execution lifecycle.
- `lib/gateway/conflict-detector.js`: revision/hash bookkeeping.
- `lib/gateway/idempotency-store.js`: mutation retry deduplication.
- `lib/gateway/job-manager.js`: long-running job state.
- `lib/gateway/process-manager.js`: internal extension launcher and ownership state.
- `lib/gateway/daemon-entry.js`: detached daemon entrypoint; not a public CLI command.

### Extension

- `lib/extension/gateway-client.js`: health, launch, register, heartbeat, reconnect, unregister.
- `lib/extension/instance-registration.js`: stable registration identity payload.
- `lib/extension/editor-command-executor.js`: executes commands using the existing tool registry.
- `browser.js`: now acts as Gateway client; it no longer exposes a public Editor MCP server for agents.

### Documentation

- `docs/COCOS_CLI_GATEWAY_PLAN.md`: source implementation plan.
- `docs/COCOS_CLI_GATEWAY_ARCHITECTURE.md`: system architecture and sequence diagrams.
- `docs/COCOS_CLI_GATEWAY_TECHNICAL.md`: API, protocol, configuration and troubleshooting reference.
- `docs/COCOS_CLI_GATEWAY_OPERATIONS.md`: short operational guide.

## 6. Verification evidence

Các kiểm tra cuối đã chạy:

```text
npm test       -> 198 tests, 196 pass, 2 skipped
npm run check  -> pass
Gateway suite  -> 115/115 pass
```

Hai test bị skip vì môi trường không có command `zip`; chúng thuộc update package flow, không liên quan Gateway.

Các nhóm test chính gồm CLI client-only, lifecycle/daemon, WebSocket, extension integration, target routing, MCP front door, lock fairness/deadlock, scheduler cancellation/timeout, sessions, primary failover, idempotency, jobs, body limit, auth, rate limit và metrics.

## 7. Cấu hình và cách chạy cơ bản

```json
{
  "gatewayUrl": "http://127.0.0.1:8787/mcp",
  "autostart": true
}
```

Environment:

- `COCOS_GATEWAY_URL`: URL Gateway cho extension.
- `COCOS_GATEWAY_AUTH_TOKEN`: token cho extension/Gateway.
- `FUNPLAY_COCOS_GATEWAY_URL`: URL Gateway cho CLI.
- `FUNPLAY_COCOS_GATEWAY_TOKEN`: token cho CLI.
- `COCOS_GATEWAY_HOST`, `COCOS_GATEWAY_PORT`: daemon binding.
- `COCOS_GATEWAY_OWNERSHIP_DIR`: ownership/alias state directory.

Ví dụ:

```bash
cocos-cli mcp
cocos-cli targets list
cocos-cli target health game-editor
cocos-cli call get_hierarchy '{}' --target game-editor
```

Nếu Gateway không sống, CLI trả `GATEWAY_UNAVAILABLE` và hướng dẫn mở Cocos Editor có extension hoạt động. CLI không tự start Gateway.

## 8. Các giới hạn cần biết

1. WebSocket là transport command forwarding production. HTTP control transport dùng cho lifecycle/test và được cảnh báo là lifecycle-only nếu runtime không có WebSocket.
2. Revision store hiện là in-memory theo Gateway process; target aliases được persist nhưng revision thực tế từ mtime/content của filesystem hoặc asset database chưa được nối vào provider riêng.
3. `command.cancel` được gửi best-effort. Gateway luôn giải phóng lock/session; việc dừng giữa chừng một arbitrary Editor tool phụ thuộc tool có hỗ trợ cancellation hay không.
4. Gateway chưa phải distributed/HA service qua nhiều máy; trạng thái scheduler, session, job và revision là local process state.
5. `cocos://targets/<id>/logs` hiện là resource namespace ổn định; log backend chuyên biệt có thể được nối thêm sau.

Các giới hạn trên không thay đổi quyết định cốt lõi của plan: không thay thế Cocos Creator bằng headless Editor và không trao lifecycle authority cho CLI.

### Concurrency fixes sau review

Sau khi review lần đầu, các bug concurrency sau đã được sửa (commit này):

1. **Idempotency store** không còn cache failure — một mutation reject giờ xóa entry để retry cùng key có thể chạy lại, thay vì trả lại error đã cache trong TTL.
2. **Lease renewal** — scheduler giờ renew lease định kỳ trong khi tool đang thực thi, nên long-running tools (build/preview/diagnostics) không bị watchdog thu hồi lock giữa chừng khi chạy lâu hơn `timeoutMs`.
3. **`releaseOwner`** — hủy pending waiters của owner TRƯỚC khi release leases, tránh lease mồ côi khi owner disconnect.
4. **`createError`** — ba call site sai tham số đã sửa để JSON-RPC error code luôn là integer.
5. **Tài liệu** — mã lỗi `TARGET_AMBIGUOUS` thực tế là `-32001` (chia sẻ với `TARGET_UNAVAILABLE`, phân biệt qua `data.code`); Gateway suite đếm đúng là 115.

## 9. Việc tiếp quản đề xuất

1. Đọc `COCOS_CLI_GATEWAY_ARCHITECTURE.md`, sau đó đọc `COCOS_CLI_GATEWAY_TECHNICAL.md`.
2. Chạy `npm test` và `npm run check` trước khi thay đổi.
3. Khi thêm tool mới, cập nhật `lib/gateway/tool-policies.js` nếu tool không được phân loại đúng; unknown mutation hiện được xử lý bảo thủ như write.
4. Khi thay đổi control protocol, cập nhật `extension-protocol.js`, Gateway client, executor và test protocol/integration cùng lúc.
5. Không expose `daemon-entry.js` thành public `cocos-cli` subcommand.
6. Giữ `upstream` trỏ repo gốc và push implementation branch vào `origin` của repository XOVIET-GAME.

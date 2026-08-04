# Cocos CLI Gateway vận hành

## Mô hình chạy

`cocos-cli` chỉ là MCP client. Nó không tạo, dừng hoặc điều phối Gateway. Cocos
extension trong mỗi Cocos Creator Editor là startup authority duy nhất:

```text
Agent -> cocos-cli -> Gateway -> WebSocket control channel -> Cocos extension -> Editor tools
```

Mặc định Gateway dùng `http://127.0.0.1:8787`, MCP endpoint là `/mcp`, health
endpoint là `/health` và metrics endpoint là `/metrics`.

## Khởi động và đóng

Khi Editor mở, extension kiểm tra Gateway. Nếu Gateway chưa sống, extension
khởi động daemon detached qua internal process manager, chờ health rồi đăng ký
`editorInstanceId`. Khi Editor đóng, extension unregister. Gateway chỉ tự dừng
nếu chính extension đã start nó, không còn Editor/session/job và bật
`autoStopWhenIdle`.

```bash
cocos-cli mcp
cocos-cli targets list
cocos-cli target health <targetId>
```

Nếu Gateway chưa có extension nào hoạt động, CLI trả `GATEWAY_UNAVAILABLE`.
Không dùng CLI để start/stop Gateway.

## Cấu hình

Trong `funplay-cocos-mcp.config.json` có thể đặt:

```json
{
  "gatewayUrl": "http://127.0.0.1:8787/mcp",
  "autostart": true
}
```

Environment có độ ưu tiên cao hơn:

- `COCOS_GATEWAY_URL`
- `COCOS_GATEWAY_AUTH_TOKEN` cho extension khi Gateway yêu cầu token
- `FUNPLAY_COCOS_GATEWAY_URL` cho CLI
- `FUNPLAY_COCOS_GATEWAY_TOKEN` cho CLI

Khi bind Gateway ngoài localhost, bắt buộc cấu hình
`COCOS_GATEWAY_AUTH_TOKEN`. Health vẫn dùng được để liveness check; các route
khác yêu cầu `Authorization: Bearer <token>`.

## Chẩn đoán

- `/health`: Gateway ownership, session/job/request count và target online/offline.
- `/health?targetId=<id>`: trạng thái một Editor target.
- `/metrics`: counter vận hành; route này yêu cầu token nếu Gateway bật auth.
- `cocos_targets`, `cocos_target_health`, `cocos_lock_status`,
  `cocos_job_status`, `cocos_audit`, `cocos_cancel`: MCP admin tools.

Các lỗi chính:

- `GATEWAY_UNAVAILABLE`: chưa có Gateway hoặc extension chưa kết nối.
- `TARGET_AMBIGUOUS`: cần truyền `targetId` hoặc `projectId` rõ ràng.
- `PRIMARY_WRITER_REQUIRED`: target đang read-only cho mutation.
- `LOCK_TIMEOUT`: request không lấy được toàn bộ lock trong deadline.
- `REQUEST_TIMEOUT` / `REQUEST_CANCELLED`: request bị deadline hoặc agent hủy.
- `STALE_EDITOR_STATE` / `CONFLICT`: revision mutation đã cũ.

Mutation có thể gửi `expectedRevision` dạng scalar cho Editor hoặc dạng:

```json
{
  "resources": {
    "file:assets/data.json": { "revision": 3 }
  }
}
```

Gateway trả `revision` của Editor và `revisions` của các resource đã khóa.
Khi request bị hủy sau khi đã được chuyển tới Editor, Gateway gửi
`command.cancel` best-effort qua control channel; lock và session state vẫn
được dọn tập trung tại Gateway.

## Migration từ MCP server cũ

Agent chuyển endpoint từ server Cocos riêng sang `cocos-cli mcp` hoặc Gateway
`/mcp`. Tool execution vẫn giữ nguyên trong `lib/tool-registry.js` và tiến trình
Editor; CLI không cần Cocos headless và không thay thế Cocos Creator.

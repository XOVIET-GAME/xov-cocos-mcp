# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- Moved WebSocket authentication token from HTTP query parameters to the WebSocket subprotocol (`bearer.<token>`) to prevent credentials from leaking into proxy logs, web server access logs, and process monitors.
- Switched token verification to constant-time comparison (`crypto.timingSafeEqual`) to mitigate timing side-channel attacks against authentication.
- Enforced strict Origin and Host header validation on WebSocket upgrades and HTTP control endpoints to protect against DNS rebinding and cross-origin WebSocket hijacking.

### Added
- Added `writeFileAtomic` helper in `lib/atomic-file.js` creating temporary files with `O_EXCL` (`wx`), fsyncing, and atomically renaming with strict `0600` permissions.
- Hardened gateway ownership state (`daemon-entry.js`) and target registry alias state (`target-registry.js`) to use atomic state file writes with `0600` permissions on POSIX systems.

## [0.6.4] - 2026-09-19

### Added
- Gateway multi-editor architecture:
  - Detached background daemon (`daemon-entry.js`, `process-manager.js`) guaranteeing single-flight machine-level lifecycle coordination.
  - MCP front door (`mcp-front-door.js`) multiplexing AI agent tool invocations across registered Cocos Creator Editor instances.
  - Target registry (`target-registry.js`) and Session registry (`session-registry.js`) tracking instance heartbeats, automatic failover, and primary-writer role assignment.
  - Fair, atomic multi-resource lock manager (`lock-manager.js`) with hierarchical resource order sorting, deadlock avoidance, and TTL watchdog reclamation.
  - Priority task scheduler (`scheduler.js`) and job manager (`job-manager.js`) for background tool tasks.
  - Structured audit logger (`audit-log.js`) recording tool dispatches and state transitions.
  - Idempotency store (`idempotency-store.js`) ensuring replay safety for non-idempotent tool commands.
  - Token-bucket rate limiter (`rate-limiter.js`) protecting gateway control channels from abusive traffic.
- CLI binary alias: added `cocos-cli` executable (`bin/cocos-cli.js`) alongside `funplay-cocos-mcp` in `package.json` `bin` map.
- Project skills and prompts management panel (`panel/project-skills.js`, `lib/project-skills.js`, `lib/project-prompts.js`).
- Scene script execution and preview runtime (`lib/script-execution.js`, `lib/preview-runtime.js`).
- Global CLI installation and automated updater support (`lib/global-install.js`, `lib/updater.js`).
- JSONC configuration parsing support (`lib/jsonc.js`).

### Changed
- Rebranded repository, package metadata, and extension configuration to XoV Studio (`XOVIET-GAME/xov-cocos-mcp`).
- Absorbed and synced changes equivalent to upstream Cocos MCP v0.6.4 (including Windows Claude Code scope path handling and `Object.prototype.hasOwnProperty` compatibility fixes) while preserving XoV gateway enhancements and branding.
- Improved gateway daemon process resilience, clean shutdown signal handling, and idle auto-stop lifecycle.

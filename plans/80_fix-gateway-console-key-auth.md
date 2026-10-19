# 80 — Fix Gateway Auth for Console Key (Relay Browser Attach Failure)

**Status:** Complete — 4/4 items done. 2026-10-19. Live verified: `Target.createTarget`, `Runtime.evaluate`, and `Target.getTargets` all work on Chrome131 after the fix.

## Problem

The `/browser/<name>` gateway requires an API key (`?key=`) per plan 72. Navigator's own puppeteer client dials this gateway using `relayServer.gatewayWsUrl(name)`, which appends the per-boot `CONSOLE_API_KEY` (`nvg_console_...`).

However, the gateway auth callback (`gatewayAuth` at `mcp-server.js:5398-5404`) calls `authorizeCdpKey(req, url, manager.config)` which validates the presented key against `config.mcpApiKeys` — populated from the `api_keys` DB table via `syncMcpApiKeys`. The `CONSOLE_API_KEY` is **not** in `config.mcpApiKeys` (it's only appended ad-hoc at `/mcp` and `/console/mcp` auth paths: `mcp-server.js:4319` and `4671`).

Result: navigator's own loopback dial receives `401 Invalid API key` → `Unexpected server response: 401` → `backend connect failed` → `Target.createTarget` and `attachToExistingTarget` both fail. The relay browser shows as "connected" (extension handshake on `/relay` works) and `Target.getTargets` lists tabs (reads relay cache), but **no devtools tool can drive any tab**.

## Evidence

- `Target.getTargets` lists 7 tabs for `Chrome131` (origin:"browser") ✅
- `Target.createTarget` → `Error: browser "Chrome131" unreachable (ws://10.69.1.164:1994/browser/Chrome131?key=nvg_console_...): Unexpected server response: 401` ❌
- `Runtime.evaluate` on a known `targetId` → `Unknown targetId: ... (attach to "Chrome131" failed: backend connect failed)` ❌
- Other browsers (`cloakbrowser`, `chromium`) work because they are plain CDP (not navigator-cdp) ✅

## Root Cause

`gatewayAuth` passes `manager.config` directly to `authorizeCdpKey`, which checks `config.mcpApiKeys`. The `CONSOLE_API_KEY` is generated at boot (line 104) and passed to relay as `navigatorGatewayKey` so the gateway URL carries it, but the auth gate never adds it to the trusted key set. This is an exact analog of the `/mcp` and `/console/mcp` paths that **do** append it locally — the gateway auth path missed it.

Plan 72 item 1 explicitly said: *"Validate against manager.config.mcpApiKeys + console key"*. Implementation didn't.

## Fix Strategy

**Option A (minimal):** Pass `{...manager.config, mcpApiKeys: [...(manager.config.mcpApiKeys||[]), CONSOLE_API_KEY]}` to `gatewayAuth` just like the other two auth paths.

**Option B (architectural, preferred):** Extract a single helper `getTrustedApiKeys(config)` in `src/mcp-api-auth.js` that returns the union of DB keys + internal console key. Use it in:
- `/mcp` auth (`isAuthorizedMcpRequest`)
- `/console/mcp` auth
- `/browser/<name>` gateway auth (`gatewayAuth`)
- `/cdp` auth (consistency — `authorizeCdpKey` should also accept console key if presented)

This prevents future drift and makes the trust set explicit.

## Work Items

- [x] **1. Centralize trusted key set.**
  Create `getTrustedApiKeys(config)` in `src/mcp-api-auth.js` returning `[...(config.mcpApiKeys || []), CONSOLE_API_KEY]` (import `CONSOLE_API_KEY` from `mcp-server.js` or pass as parameter — prefer parameter to avoid circular import).
  Update `isAuthorizedMcpRequest`, `getAuthorizedMcpKey`, and add a new exported `isTrustedApiKey(presented, config)` used by all three auth surfaces. Keep `authorizeCdpKey` using this.

- [x] **2. Apply to gateway auth.**
  Change `gatewayAuth` callback to pass `{...manager.config, mcpApiKeys: getTrustedApiKeys(manager.config)}` or use the new helper directly. Ensure `CONSOLE_API_KEY` is available at that scope.

- [x] **3. Unit test.**
  Extend `tests/mcp-api-auth.test.js` with tests for `getTrustedApiKeys`, `isTrustedApiKey`, and `isAuthorizedMcpRequest` with console key. Extend `tests/relay-server.test.js` gateway auth section: dial with missing key → 401; dial with bogus key → 401; dial with `CONSOLE_API_KEY` → succeeds and `Target.getTargets` enumerates. Mirror existing `/cdp` auth test patterns where applicable.
  Update `tests/relay-raw.test.js` similarly.

- [x] **4. Live verification.**
  Unit tests pass: `mcp-api-auth.test.js` (17 tests), `relay-server.test.js` (31 tests), `relay-raw.test.js` (1 test). Full suite: 896 passed, 3 failed (pre-existing, same failures without changes).
  Container restarted (bind-mounted source picked up new code without rebuild). Chrome131 re-paired with new PIN. Live MCP verification: `Target.createTarget({browser: "Chrome131", url: "about:blank"})` → success (targetId `6c666e555c6f`); `Runtime.evaluate` on that targetId → success; `Target.getTargets` lists 8 Chrome131 tabs. Closed test tab after verification.

## Files to Change

- `src/mcp-api-auth.js` — new helper `getTrustedApiKeys(config, consoleKey)`, `isTrustedApiKey(presented, config, consoleKey)`; update `isAuthorizedMcpRequest`, `getAuthorizedMcpKey`.
- `src/mcp-server.js` — import helpers; update `/mcp` and `/console/mcp` auth paths to use them; update `gatewayAuth` callback.
- `src/relay-server.js` — no change needed (it just runs the callback passed in).
- `tests/relay-server.test.js` — add gateway auth test cases for console key.
- (Optional) `src/cdp-share.js` — `authorizeCdpKey` could also use `isTrustedApiKey` for consistency.

## Non-Goals

- Extension `/relay` handshake (PIN + token) unchanged.
- External API keys (DB-backed) unchanged — they already work.
- Plan 49's other security hardening (HMAC, rotation) remains deferred.

## Verification Checklist

- [ ] `npm test` (or `vitest run`) — zero new failures vs baseline
- [ ] `docker compose build && docker compose up -d` — container healthy
- [ ] `Target.createTarget({browser: "Chrome131", url: "about:blank"})` returns a targetId
- [ ] `Runtime.evaluate` on that targetId returns page content
- [ ] `Target.getTargets` still lists relay tabs
- [ ] `/browser/<name>` without key → 401; with invalid key → 401; with valid DB key → success (external client test)

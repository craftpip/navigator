# Plan 69 — CDP Relay Test Hardening

**Status:** Planned

**Created:** 2026-09-27

**Scope:** Close the external-CDP, relay, and Chrome-extension lifecycle gaps discovered after the real `/cdp/mac_chrome` failures. This plan protects the actual xdl use case: a key-scoped external client connects to a user browser, discovers or creates a page, navigates, evaluates, reads content, and coexists with another client without closing user tabs.

## Why This Exists

The current suite has useful mocked happy-path coverage:

- `chrome-extension/test/unit-ext.mjs`: pairing, basic forwarding, tab creation, window behavior.
- `tests/relay-server.test.js`: one fake-extension Puppeteer gateway client.
- `tests/cdp-share.test.js`: pure auth/config helpers.

It does not reliably exercise the production boundary:

```text
external Puppeteer -> authenticated /cdp/<browser> -> RelayServer
  -> extension service worker -> chrome.debugger/tabs -> user Chrome
```

The missing coverage allowed three real regressions:

1. session-scoped `Target.setAutoAttach` replies lost their `sessionId`;
2. a duplicate attach event replaced Puppeteer's active page session;
3. an empty/stale extension tab list destroyed a newly created target session.

## Test Layers

| Layer | Test style | Owns |
|---|---|---|
| Extension unit | Node VM with Chrome API mock | API adaptation, state, protocol response shapes |
| Relay unit/integration | Fake extension + real WebSocket + Puppeteer | CDP routing, lifecycle, races, multi-client isolation |
| CDP sharing integration | Local HTTP/WebSocket server + real upgrade clients | key gate, scopes, transports, audit, cleanup |
| Live browser smoke | Packed extension in real Chrome + deployed navigator | real Chrome debugger, service-worker, user-tab behavior |

Every bug fix adds the cheapest deterministic test that reproduces it, plus a live smoke check when it crosses a browser/extension boundary.

## Phase 1 — Fix and Lock Extension Protocol Defects

### 1.1 `Target.getTargets` must return CDP target infos

**Root cause:** `chrome-extension/cdp/handler/local.js` calls callback-based `TabList.getAllAsTargets()` as if it returns a result. The CDP response becomes `{}` instead of `{ targetInfos }`.

**Change:**

- Convert `TabList.getAllAsTargets()` to return a Promise, with `handleRequest()` consuming that Promise.
- Keep exactly one callback/Promise compatibility adapter for `chrome.debugger.getTargets()` and `chrome.tabs.get()`.
- `LocalHandler.targetGetTargets()` returns `{ targetInfos }` from the Promise.

**Tests (`chrome-extension/test/unit-ext.mjs`):**

1. Send a relay CDP `Target.getTargets` request through `routeCDPCommand()`.
2. Assert one response with `result.targetInfos`.
3. Assert page targets, non-page targets, `windowId`, `browserContextId`, and `openerId` survive.
4. Exercise callback-only, Promise-only, and callback-plus-Promise API shapes; assert one response only.
5. Exercise `getTargets`/`tabs.get` rejection and one unreadable tab without losing other targets.

### 1.2 Correct `Target.detachFromTarget`

**Root cause:** `chrome-extension/cdp/handler/special.js` removes the session then only calls `DebuggerManager.detach()` when the tab is already unattached, making the detach a no-op.

**Change:**

- Define session ownership explicitly: one debugger attachment per tab, reference-counted extension sessions.
- First detach removes only its session; final detach detaches Chrome debugger, clears attached state and target/session maps.
- Unknown session IDs return a deterministic CDP error without detaching another client.

**Tests:**

1. Attach -> detach calls `chrome.debugger.detach()` on final session.
2. Two sessions on one tab: first detach leaves debugger attached, final detach releases it.
3. Detach error still clears local session state and reports a usable error.
4. Unknown/missing session leaves state unchanged.

### 1.3 Service-worker detach and relay control messages

**Change:** add a background-page/service-worker VM harness that loads `background.js` in its real `importScripts` order and captures listeners.

**Tests:**

1. `chrome.debugger.onDetach` emits exactly one `tab_detached` with tab ID and reason.
2. Relay `detach_all` detaches every attached tab before sending `detach_all_result`.
3. Popup `attach-tab`, `detach-tab`, connect, disconnect, and PIN paths return `true` when their response is asynchronous.
4. Service-worker reload restores the stored session token and only auto-connects after a real prior pairing.

## Phase 2 — Make Connection Tests Deterministic

### 2.1 Injectable WebSocket factory

**Change:** have `ConnectionManager` obtain WebSockets from a small injectable factory, defaulting to browser `WebSocket`. This is not a test-only branch; it isolates connection creation from retry policy.

**Tests:**

1. Bare host `10.69.1.164` produces `wss://10.69.1.164:1994/relay`, then `ws://10.69.1.164:1994/relay`.
2. `ws://`, `wss://`, `http://`, `https://`, an existing `/relay` suffix, and an unrelated path normalize to valid relay WebSocket URLs.
3. First secure candidate pre-open error -> immediate plain-WS fallback.
4. Pre-open close, no-open timeout, constructor exception, and duplicate error+close consume one candidate exactly once.
5. All candidates fail -> `connecting:false`, pending-connect intent cleared, retry button usable.
6. Old socket events cannot change the state after a newer attempt owns the connection.
7. Post-open close schedules exactly one reconnect; intentional disconnect schedules none.

## Phase 3 — Relay Target Lifecycle and Concurrency

### 3.1 Tab-list snapshots

**Change:** correlate `list_tabs_request` and `tab_list` with a request ID. Ignore stale replies and avoid destructive replacement of active attached targets.

**Tests (`tests/relay-server.test.js`):**

1. Delayed empty list cannot destroy known or active created targets.
2. Delayed non-empty snapshot cannot replace a newer snapshot.
3. Concurrent refresh callers receive their matching response.
4. User-opened target emits `Target.targetCreated` only when discovery is enabled.
5. URL/title updates emit `Target.targetInfoChanged`.
6. User close emits ordered `Target.detachedFromTarget` then `Target.targetDestroyed` for attached clients.
7. Discovery-disabled clients still get correct `Target.getTargets` responses without lifecycle events.

### 3.2 Attach, detach, and client isolation

**Change:** make `_ensureTargetSession()` single-flight per `{ entry, targetId }`; track gateway-client references separately from the one extension debugger attachment.

**Tests:**

1. Two concurrent consumers attaching the same target produce one extension attach.
2. Both consumers can evaluate independently after attach.
3. Detaching client A does not detach or break client B.
4. A client disconnect during an in-flight command removes that command and its timer immediately.
5. Extension disconnect rejects all pending commands, resolves attach waiters, and closes clients without leaks.
6. Late extension responses after timeout cannot create a second reply or mutate a replaced session.
7. Concurrent failures report the correct target-specific attach reason; remove shared `_attachFailure` state if necessary.

### 3.3 Auth and relay ownership

**Tests:**

1. An unpaired socket claiming an existing browser name cannot replace or tear down a currently paired browser.
2. Valid persisted token reconnect is tested with a fresh `RelayServer` instance and SQLite-backed state.
3. Bad token/wrong PIN cannot disturb a live extension or its gateway clients.
4. `Browser.close` from every gateway client remains overridden and never closes user Chrome.

## Phase 4 — Authenticated `/cdp` Integration Matrix

Create a local HTTP server using `initCdpSharing()` and real `ws` clients. Do not only test helper functions.

### 4.1 Upgrade gates

| Case | Expected result |
|---|---|
| missing or invalid key | HTTP 401 |
| known key, disallowed browser | HTTP 403 |
| unknown browser | HTTP 404 |
| disconnected relay browser | HTTP 409 |
| disabled sharing | explicit refused discovery and upgrade |
| inbuilt session cap exceeded | HTTP 429 |
| add-on dial failure | HTTP 502 |
| valid relay key/browser | upgraded gateway client + audit/counter |

### 4.2 Transport behaviors

1. `navigator-cdp`: authenticated `/cdp/<name>` -> real relay gateway protocol test, including target discovery, create/navigate/evaluate/content, two clients, detach isolation, and close cleanup.
2. plain CDP add-on: fake upstream `/json/version` plus WebSocket server; assert text/binary duplex frames, upstream close, client close, and no leaked socket.
3. inbuilt Chromium: concurrent upgrade race never exceeds the shared-browser cap; client close tears down only its dedicated browser/profile.
4. Existing Navigator add-on connection remains healthy after an external `/cdp` client disconnects.
5. Revoking a DB key closes all active CDP sessions for that key and rejects future upgrades, matching plan 55's security contract.
6. Restricted key discovery has an explicit policy test: either filter browsers by grant or deliberately document global discovery.

### 4.3 Configuration lifecycle

1. `ENABLE_CDP_SHARING` and `MCP_PUBLIC_URL` tests match their actual lifecycle. If routes cannot mount/unmount dynamically, schema marks them restart-only.
2. `ENABLE_CDP_SHARING=0` has deterministic HTTP and WebSocket behavior.
3. `loadConfig()` tests environment parsing for `ENABLE_CDP_SHARING` and `MCP_PUBLIC_URL`.
4. `MCP_PUBLIC_URL` produces a usable `wss://` advertised CDP base URL behind TLS/reverse proxy.

## Phase 5 — Real Browser E2E

Extend `chrome-extension/test/e2e-pair.mjs` or add `testing/browsers/scripts/cdp-relay-e2e.mjs`.

### Preconditions

- Start navigator with the current image.
- Install the packed extension with its stable key.
- Obtain a scoped disposable test API key; do not use production/xdl credentials.
- Create only automation-owned tabs/windows and close each in `finally`.

### Required flow

1. Fresh pairing -> PIN -> connected.
2. Extension reports real existing user tabs; external `Target.getTargets` sees matching target IDs without auto-attaching all tabs.
3. External authenticated `/cdp/mac_chrome` client creates a page.
4. `Network.enable`, `page.goto`, `page.evaluate`, and `page.content` succeed.
5. Two independent external clients create/navigate/evaluate concurrently.
6. One client detaches or disconnects; the other continues working.
7. Close created tab; assert it disappears while user tabs remain.
8. Restart Navigator; extension reconnects with the same stored token and external CDP works again.
9. Terminate/revive extension service worker; tab list and token reconnect recover.
10. Revoke key; current external socket closes and a fresh connection receives 401.

### Deployment smoke matrix

1. Container `/cdp/chromium` from outside container.
2. Optional CloakBrowser route.
3. Optional Lightpanda route, including its static-IP CDP constraint.
4. `docker compose` `.env` load, port exposure, and advertised public URL.

## Test Infrastructure Rules

1. Use fake timers for relay command/hello/heartbeat timeouts; never sleep 60 seconds in unit tests.
2. Every test that creates a socket, browser, tab, window, API key, or temporary profile closes/removes it in `finally`.
3. Run test-only SQLite state in a temporary `DATA_DIR`/cwd; never pollute live `data/navigator.db`.
4. Do not use production API keys, user tabs, or xdl work during automation.
5. Assert protocol frames and state changes, not console logs.
6. Keep mocks protocol-faithful: CDP replies include session IDs, and Chrome mocks cover callback-only, Promise-only, and dual APIs.

## Implementation Order

1. Phase 1.1 and 1.2 defects with regression tests.
2. Phase 2 deterministic connection harness.
3. Phase 3 relay snapshot, attach, detach, and disconnect tests/fixes.
4. Phase 4 authenticated CDP server integration matrix.
5. Phase 5 real Chrome E2E plus deployment smoke scripts.
6. Update `AGENTS.md` with durable commands and discovered browser-specific constraints; archive this plan only after every acceptance item is green.

## Completion Gate

Do not call this complete until:

- Extension unit suite covers Promise/callback adaptation, connection fallback, target response, attach/detach, and service-worker message paths.
- Relay tests cover stale lists, concurrent consumers, all disconnect paths, persisted pairing, and tab lifecycle ordering.
- `/cdp` WebSocket integration tests cover every auth outcome and all three transports.
- Real Chrome E2E passes the required flow with an updated packed extension.
- Full suite has no new failures from the documented baseline.
- `docker compose build && docker compose up -d` is followed by the external authenticated `/cdp` smoke test.

# Plan 40 — Firefox Extension: Real Firefox over WebDriver BiDi

**Status:** Phase 1 BUILT — `firefox-extension/` stands alone with 17/17 vm-harness tests green (2026-08-28). Phase 2 (real-Firefox validation + fidelity pass) is next.
**Created:** 2026-08-28
**Depends on:** Plan 38 (Chrome extension) — the Firefox extension shares its relay core, protocol, and popup UX. Only the CDP bridge layer changes.

> **Phase 1 delivered**
> - `firefox-extension/` mirrors the chrome-extension structure; relay core (`utils/`, `core/connection-manager.js`, `core/state.js`) reuses the same protocol (PIN, `navigator-hello`, sessions-as-tabs).
> - `cdp/bidi/` is the transition layer: `bidi-client.js` (BiDi WS, `session.new`/`session.subscribe`, id-correlated promises w/ per-id timeouts), `mapper.js` (CDP⇄BiDi command + event route tables), `remote-value.js` (RemoteValue⇄RemoteObject, pure).
> - `cdp/handler/special.js` maps multi-step methods (`Target.createTarget` = `browsingContext.create` + `navigate`; `attachToTarget` = BiDi context → CDP session). `cdp/handler/local.js` answers browser-level lookalikes (`Browser.getVersion` Firefox-branded, `Target.getTargets` via `tabs.query`, no-op `Network.enable`/`SystemInfo.*`).
> - `core/session-manager.js` bridges CDP sessions ↔ BiDi contexts ↔ tabs, incl. FIFO pairing of `browsingContext.create` replies with `tabs.onCreated`.
> - `features/tab-isolation.js` uses `tabs.hide()` (tabHide perm — Firefox has no tabGroups API).
> - `test/unit-ff.mjs` (17 tests, Node vm harness + FakeWebSocket/FakeBiDi; no Firefox needed) + `test/mock-bidi-server.mjs` (interactive Fake Remote Agent). `launch-firefox.sh` (web-ext or native `--remote-debugging-port`), `pack-firefox.sh`, README.
>
> **Bugs caught by the harness during build** (all fixed): `SessionManager` vs `CDPSessionManager` name mismatch dropped ALL BiDi→CDP events; `ResponseBuilder` hardcoded `-32000` swallowing `-32601`; `remote-value.toCdp` recursed into itself for `map`/`set` (stack overflow); the mock must reply with the full BiDi payload `{type:'success', result, realm}` not the bare RemoteValue; HashMap-less `tab-list` needed `Target.getTargets` to resolve a Promise (callback-style `getAllAsTargets` returned `undefined`).
>
> **Not yet done (Phase 2+):** real-Firefox end-to-end run (launch → load temp add-on → PIN → drive CDP → verify translated BiDi in the mock log); object-handle bridging across realms; multi-`session.new` reuse on a normal profile; `-remote-allow-origins` origin pinning.

---

## Problem

Plan 38 bridges navigator to a user's real Chrome via a WebExtension that uses `chrome.debugger`. The same trick does not work in Firefox:

- Firefox **removed Chrome DevTools Protocol** in Firefox 141 (deprecated in 129). CDP is simply gone — you cannot `puppeteer.connect()` to a modern Firefox.
- Firefox extensions have **no `browser.debugger` API** (bug 1316741 still OPEN; the extension-side BiDi proposal, bug 1840132, is also OPEN and requires `--remote-debugging-port`).
- Firefox's native automation protocol is **WebDriver BiDi** (W3C standard, production-ready since FF129). It is the only standardized protocol modern Firefox speaks, and it is exposed exclusively via the Remote Agent: `firefox --remote-debugging-port <port>` → BiDi WebSocket at `ws://127.0.0.1:<port>/session`.

**Therefore:** the Firefox extension cannot reuse `chrome.debugger` (it doesn't exist). It needs a **transition layer that maps CDP → WebDriver BiDi and back** — a *bidi-mapper* — living inside the extension.

## Goal

A standalone `firefox-extension/` folder in the navigator repo (mirroring `chrome-extension/`) that bridges the user's Firefox to navigator's `/relay` over the **same protocol** as the Chrome extension, with one internal difference:

```
navigator --CDP--> extension relay --> cdp/index.js (LOCAL/SPECIAL same as Chrome)
                                        FORWARD --> bidi-mapper (CDP -> BiDi)
                                                              |
                                            BiDi WebSocket <--+--> Firefox Remote Agent
```

**Non-goals for Phase 1:**
- No navigator-side code changes (same rule as Plan 38 — builds only in `firefox-extension/`).
- No CDP fidelity beyond the subset navigator actually uses (targets, evaluate, screenshot, navigation, reload, input, events). Unmapped methods → explicit `UnsupportedOperation`-style error, not silent guesswork.

## Research findings (2026-08-28)

| Fact | Source |
|---|---|
| CDP deprecated in FF129 (2024-05), removed entirely in FF141 (2025-06) — `/json/*` return 404 on current Firefox | mozilla remote-protocol bug; verified live on FF Developer Edition 153 |
| WebDriver BiDi is Firefox's native automation protocol; production-ready in FF129, stable with Puppeteer 23+ | developer.chrome.com blog + pptr.dev/webdriver-bidi |
| `browser.debugger` WebExtension API: **NOT implemented** | bugzilla 1316741 (OPEN) |
| Extension-facing BiDi: **NOT implemented**, requires launch flag, "automation and testing only" | bugzilla 1840132 (OPEN) |
| BiDi transport: WebSocket at `ws://127.0.0.1:<port>/session` (HTTP root is a discovery server); **`session.new` is mandatory** before any `browsingContext.*`/`script.*`; replies carry `browserVersion` | exzilcalanza.info firefox-cdp writeup (launch → session → navigate → screenshot done against FF 153) |
| WebSocket clients must pass an **Origin allowlist** (`-remote-allow-origins <origin>`) or handshake dies 403 before any command | same source |
| `script.evaluate` returns **BiDi remote values** (`{type, value}`), not plain JSON — mapper must deserialize (`deserialize_bidi()`) | same |
| CDP↔BiDi mapping reference implementations exist: `chromium-bidi` (GoogleChromeLabs, BiDi→CDP in-tab) and `foxbridge` (VulpineOS, CDP→Juggler/BiDi proxy, published Juggler↔BiDi tables incl. event mapping) | github.com/GoogleChromeLabs/chromium-bidi, github.com/VulpineOS/foxbridge |

## Architecture

### 1. `firefox-extension/` — reuse everything that isn't the CDP bridge

Same layout as `chrome-extension/`, shared patterns:

```
firefox-extension/
├── manifest.json              — MV3, "Navigator Browser Relay — Firefox"
├── background.js              — service worker/event page, importScripts, message handlers
├── popup.html / popup.js      — identical UX to Chrome (name, server URL, PIN, status)
├── utils/                     — config.js, logger.js, helpers.js  (browser.* compatible)
├── core/                      — state.js, connection-manager.js  (unchanged relay)
│   └── debugger.js            — replaced by cdp/bidi/* (below)
├── cdp/
│   ├── response.js            — same CDP response builder
│   ├── index.js               — same CDP_HANDLERS registry (LOCAL/SPECIAL/FORWARD)
│   ├── handler/local.js       — same synthesized browser-level replies
│   ├── handler/special.js     — Target.createTarget/etc. but via tabs API + BiDi contexts
│   └── bidi/                  — ★ THE TRANSITION LAYER (new)
│       ├── mapper.js          — CDP method ↔ BiDi command route table + param/result transformers
│       ├── bidi-client.js     — WebSocket to Firefox Remote Agent, session.new, JSON-RPC framing
│       └── remote-value.js    — BiDi remote value <-> plain/JSON deserializer (+ CDP RemoteObject shape)
├── features/
│   ├── tab-list.js            — browser.tabs.query() → CDP targetInfos
│   ├── tab-isolation.js       — automation tabs hidden/containers (tabGroups API is Chrome-only)
│   └── badge.js               — same ON/PAIR/ERR/OFF
├── icons/                     — same generated icons
├── launch-firefox.sh          — starts the user's real Firefox profile with the Remote Agent enabled
└── test/
    ├── unit-ff.mjs            — vm harness + FakeBiDi (no real Firefox needed)
    └── mock-bidi-server.mjs   — simulates the Remote Agent BiDi WS (session.new + echo commands)
```

### 2. The bidi-mapper transition layer (`cdp/bidi/mapper.js`)

Pure functions, no `browser.*` dependency → unit-testable. Two tables:

**CDP command → BiDi command** (seeded from chromium-bidi + foxbridge tables, extended where needed):

| CDP (navigator → ext) | WebDriver BiDi (ext → Firefox) |
|---|---|
| `Target.createTarget` | `browsingContext.create { type: "tab" }` (or `"window"` for newWindow) |
| `Target.getTargets` | `browser.getClientWindows`/`browsingContext.getTree` (or local tabs API) |
| `Page.navigate` | `browsingContext.navigate { context, url, wait: "complete" }` |
| `Page.reload` | `browsingContext.reload { context }` |
| `Page.captureScreenshot` | `browsingContext.captureScreenshot { context }` |
| `Runtime.evaluate` | `script.evaluate { expression, target: { context }, awaitPromise }` → deserialize remote value |
| `Runtime.callFunctionOn` | `script.callFunction { functionDeclaration, target, arguments }` |
| `Input.dispatchMouseEvent` | `input.performActions { actions: [pointer…] }` (W3C Actions chain) |
| `Input.dispatchKeyEvent` | `input.performActions { actions: [key…] }` |
| `DOM.getDocument` (devtools snapshots) | `script.evaluate` with injected DOM-walk script returning the element tree (no BiDi DOM module — mirror devtools.js snapshot format) |
| `Browser.getVersion` | LOCAL reply from `session.new` result (`browserVersion`) |
| `SystemInfo.getInfo`/`Schema.getDomains`/etc. | LOCAL replies, same as Chrome extension |
| Anything unmapped | `error: UnsupportedOperation(-32601)` naming the method |

**BiDi event → CDP event** (Auto-subscribe on attach: `browsingContext`, `script`, `network`, `log`):

| BiDi event (Firefox → ext) | CDP event (ext → navigator) |
|---|---|
| `browsingContext.contextCreated` | `Target.attachedToTarget` |
| `browsingContext.contextDestroyed` | `Target.detachedFromTarget` |
| `browsingContext.load` | `Page.loadEventFired` + `Page.frameStoppedLoading` |
| `browsingContext.domContentLoaded` | `Page.domContentEventFired` |
| `browsingContext.navigationStarted` | `Page.frameNavigated` + lifecycle events |
| `script.realmCreated` / `realmDestroyed` | `Runtime.executionContextCreated` / `…Destroyed` |
| `log.entryAdded` / `script.message` | `Runtime.consoleAPICalled` |
| `network.responseCompleted` | `Network.loadingFinished` + `Network.responseReceived` |
| `browsingContext.userPromptOpened` | `Page.javascriptDialogOpening` |

**Context/session model:** the mapper keeps `contextMap` (sessionId ↔ BiDi browsingContext id) and `realmMap` (BiDi realm id ↔ context) so the CDP session concept from the Chrome extension maps 1:1 onto BiDi contexts. Responses reply with the same `{ id, result|error, sessionId }` shape so `cdp/index.js` routing and navigator-side code stay untouched.

### 3. Launch model — the one UX difference vs Chrome

Chrome needs no relaunch (`chrome.debugger` works in a normal profile). Firefox's BiDi Remote Agent only exists when Firefox is started with `--remote-debugging-port`. Two options (decide in Phase 1):

- **A. Launched instance (recommended for parity with `launch-firefox.sh`):** start the user's *real* Firefox profile with the flag:
  ```bash
  firefox --no-remote --profile ~/.mozilla/firefox/<real-profile> \
          --remote-debugging-port 9222 \
          -remote-allow-origins 'moz-extension://<ext-id>'
  ```
  User's logins/cookies/session are in the profile, so "use my real Firefox" still holds. The extension connects to `ws://127.0.0.1:9222/session` and requires the user to enter the PIN in the popup (same pairing UX).
- **B. Keepalive tab:** try to reuse a profile already running (Firefox 137+ remote agent multiplexing) — research in Phase 1; fallback is always A.

**Manual step everyone pays once:** run `launch-firefox.sh` instead of double-clicking the browser icon. This is the honest trade-off of BiDi vs `chrome.debugger`, and the plan documents it rather than hiding it.

### 4. Tab isolation

`chrome.tabGroups` is **Chrome-only** (not in Firefox). Firefox equivalents to research in Phase 1:
- `browser.tabs.hide()` + `tabHide` permission (collapses automation tabs out of the tab strip — closest to "don't clutter my tab bar"), or
- Firefox Containers (`contextualIdentities` API) for semantic separation.

### 5. Connection protocol

Identical to Plan 38 §6: `navigator-hello` → `pin_required` → `pin` → `connected` (sessionToken) → CDP commands/replies/events. The extension sends the same messages; navigator cannot tell it's Firefox (that's the point).

## Security

Same as Plan 38 §9, plus:
- BiDi socket binds to `127.0.0.1` only — never exposed to the LAN. The relay to navigator is the only external surface.
- Origin allowlist (`-remote-allow-origins`) restricts who may open the BiDi WS to exactly the extension.
- PIN pairing unchanged; session token stored in `browser.storage.local` and reused on reconnect.

## Implementation Steps

**Phase 1: `firefox-extension/` standalone (no navigator changes)**
1. Scaffold `firefox-extension/` — mirror chrome-extension structure, rename, MV3 manifest with `browser_specific_settings` + `tabHide`/`tabs`/`storage` perms.
2. Port relay core `utils/` + `core/` (state, connection-manager) — should be near-copy (`browser.*` namespace).
3. Build `cdp/bidi/bidi-client.js` — BiDi WS connection, `session.new`, JSON-RPC framing, event subscription. Tested against a mock BiDi server.
4. Build `cdp/bidi/mapper.js` — command/event route tables for the navigator-relevant CDP subset (table above), remote-value deserializer.
5. Build `cdp/bidi/remote-value.js` — BiDi `{type,value}` → CDP-compatible result/targetInfos shapes.
6. Port `cdp/index.js` + LOCAL handlers + special handlers (createTarget → `browsingContext.create`).
7. Features: tab-list via `browser.tabs.query()`, tab-isolation (hide/containers), badge.
8. `launch-firefox.sh` + README.
9. Tests: `mock-bidi-server.mjs` (BiDi endpoint simulator, session.new dance) + `unit-ff.mjs` (vm harness, FakeBiDi that asserts the *translated BiDi messages*, not CDP). Green before moving on.
10. Manual test on real Firefox (user's machine): `launch-firefox.sh` → load unpacked (`about:debugging` → This Firefox) → PIN flow → mock relay drives CDP → verify translated BiDi in the mock log.

**Phase 2: fidelity pass (ONLY after Phase 1 green)**
1. Walk navigator's actual CDP usage (devtools 19 tools + web_fetch path) and expand the mapper to the exact methods used.
2. Verify screenshots (`browsingContext.captureScreenshot`), input chains, and `DOM.getDocument` snapshot equivalence against the Chrome extension output on the same pages.
3. Fix event subscription gaps (what navigator listens for vs what BiDi emits).

**Phase 3: navigator integration (ONLY when told)**
1. Ship the Firefox extension; navigator's `/relay` already speaks the protocol — register as a second remote browser.
2. Add `launch-firefox.sh` docs / console "Connected Browsers" entry (same UX as Plan 38 §5).

## Open Questions

- **Extension origin in `-remote-allow-origins`:** exact `moz-extension://<id>` handling — the ID isn't known until first load (XPI signing / temporary load). Need to read the generated ID from `about:debugging` output and pass it into the launcher, or test whether a wildcard origin is accepted.
- **Session reuse:** does the Remote Agent allow the extension (in-browser process, same user) to open `session.new` on a normal user profile, or does it require an automation-specific launch (locked profile / `-remote-debugging-port` only)? Verify on real Firefox.
- **`tabGroups`:** confirm current Firefox tab-group API surface; fallback is `tabs.hide()`.
- **WebSocket from the extension page:** MV3 background CSP must permit `connect-src ws://127.0.0.1:*` for the BiDi socket (double-check extension CSP).
- **Container image for building/tests:** navigator container has Chromium only. Unit tests + mock BiDi run in Node/vm (no Firefox needed); real Firefox manual tests happen on the user's host.
- **Which Firefox version to target:** FF 129+ (BiDi prod-ready) — note ESR 128 lacks full BiDi; document minimum version in README.

## Success Criteria

- `node test/unit-ff.mjs` green: mapper translates the navigator-relevant CDP subset; events round-trip; unmapped methods error cleanly.
- Mock BiDi server log shows a faithful `session.new` → `browsingContext.navigate` → `script.evaluate` → `browsingContext.captureScreenshot` dance when driven by the extension.
- Manual test on the user's Firefox: web_fetch-style flow (list tabs → create target → navigate → evaluate → screenshot) returns the same shapes as the Chrome extension.
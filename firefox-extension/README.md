# Navigator Browser Relay — Firefox (WebDriver BiDi)

A Firefox extension that gives the navigator MCP server CDP access to Firefox,
mirroring the existing Chromium bridge. Your Firefox is controlled through
Firefox's own **Remote Agent (WebDriver BiDi)** — no Chrome-incompatible APIs,
no `chrome.debugger`, no third-party forked builds.

## Why this exists

Navigator's page tools (`web_fetch`, `web_page_screenshot`, `web_page_ascii`,
`web_page_svg`) and its 19 devtools tools speak the **Chrome DevTools Protocol**
to whatever browser is in the `BROWSERS` array. Firefox does not speak CDP to
extensions. This extension:

1. Opens a WebSocket to Firefox's **WebDriver BiDi** endpoint
   (`ws://127.0.0.1:9222/session`), discovers browsing contexts, and maps them
   to tabs.
2. Translates **CDP commands from navigator → BiDi commands** to Firefox
   (`Page.navigate` → `browsingContext.navigate`, `Runtime.evaluate` →
   `script.evaluate`, `Target.createTarget` → `browsingContext.create`,
   `Input.*` → `input.performActions`, …).
3. Translates **BiDi events → CDP events** (`browsingContext.load` →
   `Page.loadEventFired`, `realmCreated` → `Runtime.executionContextCreated`,
   `userPromptOpened` → `Page.javascriptDialogOpening`, …) tagged with the CDP
   session id so puppeteer-style clients attach them to the right session.
4. Reuses the **exact same relay protocol** the Chromium extension uses:
   PIN pairing with navigator, `navigator-hello`, per-tab session mapping,
   keepalive — so the server side needed zero changes.

Firefox quirks are either answered locally (no-op `Browser.*`, `SystemInfo.*`,
`Network.enable`…) or surfacing as clean CDP errors (`-32601`) — never hangs.

## Quick start

```bash
# 1. One-time: install the dev runner (optional; native mode also works)
npm i -g web-ext

# 2. Launch Firefox with the extension + Remote Agent (see script for details)
./launch-firefox.sh

# 3. In the opened Firefox toolbar, open the relay popup:
#      Server URL : http://10.69.1.164:1994   (relay WS auto-derived)
#      Connect (enter the PIN shown by the navigator side)
#      Connect BiDi  (ws://127.0.0.1:9222/session)
```

## Navigator side

Add Firefox to the `BROWSERS` array (fallback-first is fine; Chromium always
stays as the built-in):

```bash
# docker-compose.yml — env
BROWSERS=[{"name":"chromium","role":[]},{"name":"firefox","role":["default","search","fetch","screenshot","devtools"],"cdpUrl":"http://host.docker.internal:9222"}]
```

WebDriver BiDi is required for anything to work — launch Firefox with
`--remote-debugging-port=9222` (all `launch-firefox.sh` paths do this).

## Layout

| Path | What it is |
|------|-----------|
| `manifest.json` | MV3, `background.page` event page (`background.html` via `<script>` tags — NOT `importScripts`, which is undefined in a page/document context and crashes the background), `tabs`/`storage`/`alarms`/`tabHide` |
| `background.html` | loads every module as a classic `<script>` in dependency order on the event page's global scope |
| `background.js` | wiring: relay state → badge/popup, BiDi events → `Mapper`, keepalive alarm |
| `utils/config.js` | storage-backed config: server URL, `browserName 'Firefox'`, BiDi URL, token |
| `utils/helpers.js` | session-id/short-id gen, tab-target-id parsing |
| `core/state.js` | relay + BiDi connection state, attached tabs, CDP clients, timers |
| `core/connection-manager.js` | **relay WS** to navigator — PIN flow, hello, `cdp_command` → `routeCDPCommand`, `cdp_event` out |
| `core/session-manager.js` | maps CDP sessions ↔ BiDi contexts ↔ tabs; FIFO pairing of `browsingContext.create` replies with `tabs.onCreated` |
| `cdp/bidi/bidi-client.js` | **BiDi WS** — `session.new`/`session.subscribe` dance, id-correlated promises |
| `cdp/bidi/mapper.js` | **the CDP⇄BiDi dictionary** — command translation + result transforms + event→CDP-event translation |
| `cdp/bidi/remote-value.js` | BiDi RemoteValue ⇄ CDP RemoteObject transcoding (pure, unit-tested) |
| `cdp/index.js` | `routeCDPCommand` — LOCAL / SPECIAL / FORWARD dispatch table |
| `cdp/handler/local.js` | CDP methods answered without the browser (`Browser.getVersion` is Firefox-branded, `Target.getTargets` over `tabs.query`, …) |
| `cdp/handler/special.js` | multi-step CDP methods (`Target.createTarget` = create + navigate, `attachToTarget` = context→session) |
| `cdp/handler/forward.js` | the FORWARD path: mapping → translate → `BidiClient.send` → transform |
| `features/tab-list.js` | `Target.getTargets`-style listing straight from `tabs.query` |
| `features/tab-isolation.js` | `tabs.hide` on attach/detach — isolation, Firefox edition |
| `features/badge.js` | toolbar badge state |
| `test/unit-ff.mjs` | 17 standalone vm-harness tests, no Firefox needed |
| `test/mock-bidi-server.mjs` | a scriptable Fake Remote Agent for manual smoke tests |

## Why not the Firefox port of CDP directly?

Two reasons, both alive:

- **Gecko's CDP (remote-agent) is being removed** from recent Nightlys; the
  future is WebDriver BiDi. Mapping CDP→BiDi on the extension side keeps
  navigator's Chromium-shaped world intact while Firefox moves underneath it.
- **No `browser.debugger`** — Firefox's `tabs` API is the only tab surface. The
  `Target.getTargets`/`attachToTarget` lookalikes (test 16) all work over
  `tabs.query` + `chrome.runtime`.

## What works (Phase 1, verified in the harness)

- BiDi handshake (`session.new`, `session.subscribe`), auto-subscribe to the
  event modules navigator cares about.
- CDP ⇄ BiDi translation for the core page surface: `Page.navigate`/`reload`,
  `Target.createTarget` (create + navigate), `Runtime.evaluate`/
  `callFunctionOn`, `Page.captureScreenshot`, `Input.dispatchMouseEvent`/
  `dispatchKeyEvent`/`insertText`, `DOM.getDocument`/`querySelector`/…
- CDP event stream (load, detached, contexts) with per-session tagging.
- Errors surface as proper CDP errors (`-32601` UnsupportedOperation), not hangs.

## What's still open

- **Real-Firefox validation** — the harness proves the protocol logic; the
  end-to-end dance (extension ↔ real Remote Agent ↔ navigator relay) has not
  been run on an actual Firefox build yet (Phase 2).
- `Target.getTargets` returns tabs (via `tabs.query`) — puppeteer's
  `waitForTarget` expects CDP `targetId`s; contexts created through the relay
  are addressable, pre-existing user tabs need a real-context resolution
  (`discoverContextForTab`, Phase 2 refinement).
- Object handles (`RemoteObject.objectId`) are not portable across BiDi realms
  — `cdpArgToBidi` returns `null` for object args and the caller drops them
  (documented in `remote-value.js`).
- **Firefox Remote Agent: one active BiDi session at a time.** A session that
  is opened but not closed with `session.end` (e.g. a test/probe that exits
  abruptly, or a second client) orphans the single slot and the extension's
  BidiClient then fails with `BiDi not connected` — every CDP command that maps
  to BiDi (`Target.createTarget` etc.) errors. There is **no supported way to
  force-reap an orphaned session without restarting Firefox**; the extension
  cannot reclaim it. Recovery = quit Firefox and relaunch with
  `--remote-debugging-port=9222`. Any code that opens a BiDi session must
  guarantee `session.end` + socket close on **every** exit path.

## Tests

```bash
node firefox-extension/test/unit-ff.mjs        # 17 tests, mock-only, fast
node firefox-extension/test/mock-bidi-server.mjs  # interactive Fake Remote Agent
node firefox-extension/test/bidi-direct.mjs    # drives the REAL Mac Firefox via BiDi -> opens a tab -> YouTube (always session.end)
node scripts/ff-gateway-test.mjs               # real relay+extension+BiDi path, CDP->YouTube via nav gateway (no own session)
```

## How it starts

`background.js` `init()` wires the listeners, then connects **both** sockets
one-shot: the relay (and both `onInstalled` fallback) and the BiDi socket
(`--remote-debugging-port` must be live — `launch-firefox.sh` guarantees it).
The popup can reconnect either side on demand.
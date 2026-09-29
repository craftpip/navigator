# Browser Runtime and DevTools

## BrowserManager

`BrowserManager` in `src/browser.js` owns all browser instances and page lifetime. `getBrowserManager()` returns the process singleton.

Browser instances come from the `BROWSERS` array — the built-in Chromium plus optional add-ons:

| Entry `type` | Implementation | Typical use |
|---|---|---|
| `inbuilt` | locally launched Puppeteer Chromium | always present; full rendering for search, fetch, screenshots, devtools |
| `cdp` | connect to a user-provided CDP endpoint (`ws://…` browser WS or `http://…` multiplexer like CloakBrowser's `cloakserve`) | anti-bot / lightweight add-on browsers |
| `navigator-cdp` | the relay extensions — a real user browser (Chrome/Firefox) dials into `/relay` and navigator drives it | user's own visible browser, `ownership: "user"` |

`resolveBrowserParam()` (src/browser.js) picks the browser for a page call: an explicit `browser` param is strict (errors if that browser is down), otherwise add-ons are tried in `BROWSERS` array order (first connected one serving, each down add-on reported in `rollbackNotes`), falling back to Chromium. Search engines always run on the built-in Chromium — engines never use add-on browsers.

## Browser Lifetime

- The built-in Chromium launches with the configured profile directory and a keep-alive page so it can recover from an idle page close. It is self-healing.
- Add-on `cdp` browsers are connected lazily and reused; a `disconnected` event clears the cached connection so the next call reconnects. Navigator never launches or closes add-ons — the user owns that external CDP process.
- Relay (`navigator-cdp`) connections come from the extensions themselves over `/relay`; pairing is token-based and persists across navigator restarts.
- `prelaunchBrowser` starts the default browser on server start and warms browser engines. API engines are never warmed.
- Browser instance health includes connection state, PID, spawned-process count, and tabs.

## Relay Gateway (`navigator-cdp`)

`navigator-cdp` inverts the usual direction. A `cdp` add-on is a browser Navigator dials; a relay browser is a **real user browser that dials into Navigator** and then exposes itself as a browser again. Three WebSocket endpoints on Navigator's HTTP server implement that loop, each mounted by `server.on("upgrade")` in `src/mcp-server.js` and dispatched by `RelayServer._handleUpgrade()` (`src/relay-server.js`):

| Endpoint | Who dials | Auth | Carries |
|---|---|---|---|
| `/relay` | the extension | one-time PIN → durable session token | hello, pairing, heartbeat, tab list, the extension's CDP messages |
| `/browser/<name>` | Puppeteer, in-process (`puppeteer.connect`) | none, by design | a pure browser-level CDP endpoint the extension's browser is proxied through |
| `/cdp/<name>` | an external CDP client | API key ([external CDP](/reference/browsers/external-cdp)) | the same gateway surface, shareable outside the process |

The gateway at `/browser/<name>` deliberately has **no handshake**. Puppeteer needs a bare CDP socket, so pairing lives entirely on the `/relay` side and the URL is computed at runtime rather than configured — a `navigator-cdp` entry must not carry a `cdpUrl`. Sessioned commands are forwarded with their `sessionId`; the extension's own routers (`LOCAL` / `SPECIAL` / `FORWARD`, and the Firefox BiDi mapper) answer them, which is also where `-32601` for an unmapped method comes from.

### Pairing lifecycle

A `navigator-hello` from an extension is added to the effective browser list immediately, in one of three states:

```
auth_pending ──valid PIN──→ connected ──disconnect──→ disconnected
      │                                              (known, unpaired)
      └──no/expired/invalid token──→ fresh 6-digit PIN, 60s window
```

- `auth_pending` is **visible but never routable** — it is skipped in the fallback chain, and asking for it explicitly is an error rather than a hang.
- A close of `4000` means the PIN was wrong or expired: the extension re-pairs. `4001` means the session token was rejected: the extension discards it and re-pairs from scratch. `4000` is also used by `forget()`.
- The **PIN is per-attempt and in-memory**; the **session token is durable**, stored in the `relay_sessions` table and restored on `init()`, so restarting Navigator does not force a re-PIN. The token never rotates — the same token comes back on every valid reconnect.
- Liveness is a 15s server-side interval; a silent extension is closed rather than left half-connected.
- Forgetting and removing are different actions: `forget()` drops the pairing but keeps the browser listed (so it can re-pair), while `remove()` deletes the entry and its owner-written description entirely. Both are exposed on the console.

### Effective browser list

`_effectiveAddOns()` (`src/browser.js`) is the single merged view that routing, `list_browsers`, health, and stats all read — configured add-ons in `BROWSERS` order, then live registry entries merged by name:

- a **pre-declared** `navigator-cdp` entry keeps its configured roles and order, and takes its status from the registry;
- a **dynamic** registration (an extension whose name is not in `BROWSERS`) gets `role: ["default"]` and is appended after the configured add-ons, editable later from the console;
- an entry whose extension has not dialled in is reported `disconnected` and is skipped for routing, so calls fall through to Chromium like any other unavailable add-on.

### Observability

`/health` and `/stats` both carry `relay: { pending, connected }` with each browser's name, plugin, status, PIN and expiry while pending, `connectedAt`, extension version, and gateway URL. `GET /debug/detach_all` clears stale `chrome.debugger` sessions on every extension — the recovery step when repeated tab adoption leaves sessions wedged.

### Relay operation budgets

`BROWSER_OP_TIMEOUT_MS` is the *headless* baseline. A relay round-trip crosses puppeteer → `/relay` gateway → extension WebSocket → `chrome.debugger` and back, so `user`-owned browsers get a ×3 multiplier (`RELAY_TIMEOUT_MULTIPLIER`) through `opTimeoutMsForOwnership()` / `browserOpTimeoutMs()`, keyed off `browserOwnership()` — the same single source as the ownership labels in `list_browsers` and `Target.getTargets`. Name-keyed callers use `BrowserManager.opTimeoutMs(name)` / `ownershipOf(name)`; the devtools dispatcher deadline is ownership-aware per target.

Two bounds keep the bigger relay budget from becoming "wait longer": `web_fetch` on a relay is capped at a 15s step / 30s total (`RELAY_ABSOLUTE_STEP_MS` / `RELAY_ABSOLUTE_TOTAL_MS`, measured from operation start), so a hung round-trip fails fast instead of pinning the Live feed to "running"; `closeTarget` on a user target waits at most 8s (`RELAY_CLOSE_TIMEOUT_MS`) for the detach confirmation and otherwise returns `unknown_after_dispatch` — the Chrome extension never pushes a close notification on its own (it has no `chrome.tabs.onRemoved` listener), so an unbounded wait would hang to the MCP ceiling.

## Page Slots and Search Windows

Search, fetch, screenshot, and ASCII operations pass through `withPageSlot()`, a global semaphore controlled by `MAX_CONCURRENT_PAGE_OPS`. Persistent DevTools target operations use their own target limits and do not consume this semaphore.

Search pages use a separate reusable window pool:

- Each browser engine gets a pool keyed by its engine id.
- `acquireSearchWindow()` obtains or opens a suitable page.
- `releaseSearchWindow()` keeps configured warm windows and closes surplus nonpersistent pages.
- A failed browser search page is closed before release, preventing reuse of broken page state.

Fetches, screenshots, and ASCII renderings open short-lived pages through `resolveBrowserParam()` rather than borrowing search windows.

## Screenshots

`browserCaptureScreenshot()` opens a page, waits for content, measures the viewport/document, captures a JPEG, and returns the encoded image plus metadata. `web_page_screenshot` can also capture an existing persistent DevTools target through `captureTargetScreenshot()`.

Storage capability is controlled by `ENABLE_SCREENSHOT_PATH` and `ENABLE_SCREENSHOT_DOWNLOAD_LINK`. Callers request `output: "file"` or `output: "url"` to use it; otherwise the default response remains inline base64 JPEG.

## ASCII Screenshots

`web_page_ascii` uses two modules:

1. `pixel-sampler.js` sends `SAMPLE_PIXELS_CODE` to the page. It decodes the real PNG, downscales with `OffscreenCanvas`, and returns packed RGB values.
2. `ascii.js` renders pairs of pixel rows into terminal cells. ANSI mode uses `▀` with separate foreground/background colors or `█` when colors match. Plain mode uses a luminance ramp.

`asciiGridDims()` limits widths to 40-200 columns and full-page output to 200 rows. `placeMarkers()` adds collision-aware numbered markers which are explained in the generated DOM legend.

## Persistent DevTools Targets

`src/devtools.js` supplies browser-testing tools for a target that survives across calls.

- At most 20 targets may be open.
- Each target has a page, ID, URL/title metadata, console buffer, network buffer, and activity timestamp.
- Console and network buffers retain up to 200 entries each.
- Operations refresh the target timer.
- A cleanup timer closes targets after five minutes idle and retains a short-lived record so callers receive a useful inactivity error.

`DOM.getDocument` returns an LLM-oriented summary of landmarks and interactive elements with selectors, XPath, attributes, geometry, and visibility. Runtime evaluation serializes results safely, limiting arrays/objects and recursive depth. Input tools require a valid CSS selector or XPath and `Input.insertText` clears the existing editable value before typing.

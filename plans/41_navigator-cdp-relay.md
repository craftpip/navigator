# Plan 41 — navigator-cdp: The Relay Server Backend (Phase 3 of Plans 38/40)

## Goal

Turn navigator into the relay endpoint that the Chrome and Firefox extensions
(plans 38 + 40, both built) connect to, and expose each paired remote browser to
navigator's existing tool chain as a **`navigator-cdp`** browser entry —
our own plugin interface, distinct from the built-in `chromium` and plain
`cdpUrl` add-ons.

Three user directives shape the design:

1. **A third browser type**: `type: "navigator-cdp"` (plus `plugin: "chrome" | "firefox"`)
   in `BROWSERS`. The extension dials navigator; navigator never dials the extension.
2. **Pure CDP, no auth, direct connect** on the puppeteer-facing side: navigator
   exposes `ws://<host>:<port>/browser/<name>` as a plain CDP endpoint that
   `puppeteer.connect({ browserWSEndpoint })` dials with zero handshake. Auth
   (PIN) lives only on the `/relay` side.
3. **`auth_pending` lifecycle**: when an extension's connection request (hello)
   arrives without a valid session token, it is added to the effective browsers
   array in `auth_pending` state with a fresh PIN. It is visible but not routable
   until paired via PIN; then it becomes a live `connected` navigator-cdp entry.

## Topology

```
 Extension (Chrome/Firefox)                    Navigator                        Puppeteer
 ───────────────────────────                    ─────────                        ─────────
   │  ws://navigator:port/relay                   │                                │
   │  navigator-hello{browserName, platform,       │                                │
   │    extensionVersion, sessionToken?} ────────→│  registry: auth_pending?       │
   │                                             │  PIN generated, logged          │
   │  ← pin_required ────────────────────────────│                                │
   │  {type:'pin', pin} ────────────────────────→│  verify (60s expiry)            │
   │  ← connected{sessionToken} ────────────────→│  registry: connected            │
   │                                             │                                │
   │  cdp_command {id, method, params, sessionId}│←── browserWSEndpoint ──────────│
   │  ← cdp_response {id, result|error, sessionId}│    ws://…/browser/<name>       │
   │  cdp_event {method, params, sessionId} ────→│── cdp_event {sessionId,...} ──→│
   │  ← list_tabs_request / tab_list ────────────│── Target.getTargets / │         │
   │                                             │   Target.targetCreated events ─→│
```

- **`/relay`** — extension connections. Hello, PIN pairing, session tokens,
  heartbeat, tab listing, CDP message transport to/from the browser (Chrome) or
  the BiDi mapper (Firefox).
- **`/browser/<name>`** — pure-CDP gateway dialed by `puppeteer.connect`.
  Translates browser-level CDP (`Target.*`, sessioned commands/events) to the
  `/relay` message stream. No auth, no handshake — by design.

## BROWSERS config

```jsonc
[
  { "name": "chromium", "role": [] },                                  // built-in fallback
  { "name": "chrome-dev", "type": "navigator-cdp", "plugin": "chrome",
    "role": ["default", "search", "fetch", "screenshot", "devtools"] }, // pre-declared (optional)
  { "name": "cloakbrowser", "role": [...], "cdpUrl": "http://cloak-browser:9222" } // plain add-on
]
```

`parseBrowsersEnv()` accepts an optional `type` (`"cdp"` default | `"navigator-cdp"`)
and `plugin` (`"chrome" | "firefox" | "auto"` default). Rules:

- A `navigator-cdp` entry does **not** require `cdpUrl` (its endpoint is our own,
  computed at runtime as `ws://127.0.0.1:<mcpApiPort>/browser/<name>`).
- If a pre-declared `navigator-cdp` entry's `name` matches a connected extension's
  `browserName`, the registry fills in its live status; its roles/order are honored.
- A pre-declared entry whose extension is **not** connected keeps the configured
  roles and is simply reported `disconnected` (never a routing candidate).
- **Dynamic** registrations (extension connects with a name not pre-declared):
  injected into the effective list with `role: ["default"]` (configurable later
  via console), appended after configured add-ons, before the chromium fallback.

## Registry (src/relay-server.js)

Singleton `RelayServer` (ESM class, composition-oriented) with two mounted WS
endpoints on the existing HTTP server (`server.on('upgrade')` in mcp-server.js):

### `/relay` — extension side

Message contract (matches the built extensions exactly — chrome-extension
`connection-manager.js`, `response.js`, `tab-list.js`, `debugger.js`; firefox
mirror):

| Direction | Message | Notes |
|---|---|---|
| ext → | `{type:'navigator-hello', browserName, platform?, extensionVersion, sessionToken?}` | `platform` added this plan (chrome/firefox), additive |
| → ext | `{type:'pin_required'}` | no/expired/invalid token |
| ext → | `{type:'pin', pin}` | 6 digits, 60s expiry (`PIN_EXPIRY_MS`), fresh per attempt |
| → ext | `{type:'connected', sessionToken}` + `{type:'pin_accepted'}` | token stored client-side, reused on reconnect |
| → ext | `{type:'ping'}` / ext → `{type:'pong'}` | heartbeat (client already `startHeartbeat()`) |
| → ext | `{type:'list_tabs_request'}` | reply `{type:'tab_list', tabs:[targetInfos]}` |
| → ext | `{type:'client-connected', clientId}` / `{type:'client-disconnected', clientId}` | puppeteer client attach/detach on the gateway |
| → ext | `{type:'detach_all'}` | reply `detach_all_result` |
| → ext | `{id, method, params?, sessionId?}` | a CDP command; reply `{id, result|error, sessionId}` |
| ext → | `{type:'cdp_event', method, params, sessionId?, tabId?}` | forwarded to all gateway clients targeting that session |

Close codes preserved: `4000` (PIN wrong/expired → client re-pairs), `4001`
(bad session token → client clears token).

State per registration: `{ name, plugin, status: 'auth_pending'|'connected'|'disconnected',
pin?, pinExpiresAt?, sessionToken?, ws, platform, extensionVersion, connectedAt, clients:Set }`.

Session tokens are in-memory only (invalidated on navigator restart — plan 38
§6). Token maps `token → name`; a hello presenting a token for a *different* name
is treated as invalid (4001).

### `/browser/<name>` — pure CDP gateway

Dialed by puppeteer (`browserWSEndpoint`). No handshake/auth. Implements the
browser-level CDP surface the puppet client needs, backed by the extension:

- `Target.getTargets` → last `tab_list` targetInfos (+ re-request on demand).
- `Target.setDiscoverTargets` / `setAutoAttach` → store intent; push
  `Target.targetCreated` / `targetInfoChanged` / `targetDestroyed` /
  `Target.attachedToTarget {sessionId, targetInfo, waitingForDebugger:false}`
  as the extension's tab list / attaches change.
- `Target.attachToTarget {targetId, flatten:true}` → idempotent sessionId
  (`sessionId` = per-client, maps to the extension's targetId → its own
  sessionId↔tabId mapping). Sessioned commands forwarded with `sessionId`.
- `Target.detachFromTarget`, `Target.attachToBrowserTarget`, other `Target.*`
  and `Browser.*`/`SystemInfo.*`/`IO.*`/`Schema.*` → forwarded to the extension
  (LOCAL/SPECIAL/FORWARD handlers resolve them; the doc `Target.attachToBrowserTarget`
  returns a synthetic browser-level sessionId).
- Unknown `.` = `-32601` (method not found), matching the firefox mapper.
- Events from the extension carry `sessionId` and are broadcast in flattened
  form (`{method, params, sessionId}`) to connected gateway clients.

Client affinity: each gateway WS is one puppeteer client (`clientId` = uuid);
`client-connected`/`client-disconnected` are sent to the extension so its popup
shows navigator attachment state (already implemented client-side).

## BrowserManager changes (src/browser.js)

- **Effective list**: `_effectiveAddOns()` = configured `addOn` entries in
  config order + registry navigator-cdp entries (connected / auth_pending /
  pre-declared-but-down) merged by name. Registry wins for status; configured
  roles win when pre-declared.
- `_findAddOnByName`, `resolveBrowserParam` (explicit + candidates), `_poolEngine`-
  adjacent add-on iteration, `newPage`, `_isAddOnConnected`, `_buildAddOnHealth`,
  `getInstanceStats`, and mcp-server `browser_list_browsers` all switch from
  `config.browsers` to `_effectiveAddOns()` so pending + connected entries are
  visible and correct.
- `_connectAddOnPage(entry)`: if `entry.type === 'navigator-cdp'`, connect with
  `puppeteer.connect({ browserWSEndpoint: relayServer.resolveGatewayWsUrl(entry.name) })`
  instead of dialing `cdpUrl`. Disconnect/rollback semantics unchanged.
- auth_pending entries and pre-declared-disconnected entries are reported down
  (rollbackNotes) so routing falls through to chromium like any other add-on.

## mcp-server.js changes

- `maybeStartHttpServer`: after `const server = http.createServer(...)`, mount
  `relayServer.init({ server, manager })` (adds the `upgrade` listener) whenever
  the HTTP server exists — relay works even with `ENABLE_HTTP_MCP=0` as long as
  the server listens (needs `enableHttpHealth || enableHttpMcp` today; extend the
  gate to also start when a navigator-cdp entry or the relay is wanted — simplest:
  always mount the upgrade handler; the server only listens when the existing gate
  passes).
- `/health` + `/stats`: add `relay: { pending: [...], connected: [...] }` summary
  (name, plugin, status, pin/expiry for pending, connectedAt, extensionVersion).
- `browser_list_browsers` reflects `_effectiveAddOns()` with `type` + `status`.

## Extension change (both)

- hello adds `platform: "chrome" | "firefox"` (additive; server falls back to
  inferring from name). Small one-liners in `connection-manager.js` (chrome) and
  the firefox background/connection equivalent.

## Tests (tests/relay-server.test.js, vitest)

1. **Registry/PIN walk** (raw `ws` client): hello→pin_required→pin→connected+token;
   token reuse on reconnect skips PIN; wrong/expired PIN → close 4000; token for
   another name → 4001; status transitions auth_pending→connected.
2. **CDP gateway with a fake-extension backend**: a ws client speaks the extension
   protocol to `/relay` and implements LOCAL handlers (Browser.getVersion,
   Target.getTargets→tab_list, Target.createTarget→new tab, attach→sessionId,
   Page.navigate, Runtime.evaluate, Page.captureScreenshot). Then a real
   `puppeteer.connect({ browserWSEndpoint })` against `/browser/<name>` **from the
   installed puppeteer-core** drives: `browser.version()`, `browser.pages()`,
   `browser.newPage()`, `page.goto()`/`page.evaluate()`, `page.screenshot()`,
   plus sessioned event broadcast. This is the ground-truth handshake test — it
   validates the gateway's CDP translation against a real puppeteer client.
3. Effective-list merge unit tests (pre-declared roles honored, dynamic default,
   auth_pending not routable, disconnect drops entry).

## Verification

```bash
docker compose exec navigator npm install --include=dev
docker compose exec navigator npx vitest run               # relay + full suite
docker compose restart navigator
# manual E2E (user): load chrome-extension unpacked, connect, pair PIN from
# console log, then browser_list_browsers shows navigator-cdp connected;
# browser_web_fetch(browser:"<name>") drives the user's real browser.
```

## Out of scope (later)

- Console UI panel ("Connected Browsers" from plan 38 §5) — endpoints/payloads
  are in place; UI wiring is a follow-up.
- Role assignment UI for dynamic entries; detach_all plumbing on gateway close.
- Network event buffering parity for the FF BiDi path.
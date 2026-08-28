# Plan 39: Dynamic Browser Array

**Created:** 2026-08-26
**Status:** Draft v2

## Goal

Replace three hardcoded browser backends with a dynamic system where:
- **Built-in browsers** (Chromium) ship with Navigator and are managed internally
- **Add-on browsers** (Lightpanda, CloakBrowser, or any CDP-compatible browser) connect via a CDP WebSocket URL provided by the user

Navigator never downloads, bundles, or redistributes add-on browser binaries. Users run them externally and point Navigator at the CDP URL.

---

## 1. Architecture: Built-in vs Add-on

Navigator ships with exactly one built-in browser. Everything else is an add-on connected over CDP.

### Built-in browsers (shipped with Navigator)

| Browser | Launch method | Docker image |
|---------|--------------|-------------|
| **Chromium** | `puppeteer.launch()` — Navigator spawns the process | Binary baked into image (`/usr/bin/chromium`) |

Built-in browsers have full lifecycle management: Navigator launches, monitors, and shuts them down. Chromium is the only built-in — it cannot be removed from the `BROWSERS` array.

### Add-on browsers (user-provided CDP URL)

| Browser | Launch method | Docker image |
|---------|--------------|-------------|
| **Any CDP-compatible browser** (CloakBrowser, Playwright, custom builds) | `puppeteer.connect({ browserWSEndpoint: cdpUrl })` | **NOT in image** — user runs it externally |

Add-on browsers are pure CDP clients — Navigator connects to an already-running browser. No lifecycle management (no launch, no shutdown, no binary path). The user is responsible for starting/stopping the browser and pointing Navigator at the CDP WebSocket URL.

> **No Lightpanda.** The Lightpanda implementation is removed entirely — no built-in, no add-on defaults, no references. When CDP support for Lightpanda (or any other browser) is ready, it is simply a user-provided add-on entry in `BROWSERS`. Nothing in Navigator is lightpanda-aware.

### Why this model?

1. **Legal safety** — CloakBrowser's binary license prohibits redistribution. Navigator never touches the binary.
2. **Simplicity** — add-on browsers are just a `puppeteer.connect()` call. No per-backend launch logic.
3. **Extensibility** — any CDP-compatible browser (Playwright, Selenium, rod, etc.) works as an add-on with zero code changes.
4. **Separation of concerns** — Navigator manages only its own Chromium; add-ons are external dependencies.

---

## 2. New Config Format

### Env var: `BROWSERS`

Replaces `BROWSER_BACKEND` and `DEVTOOLS_BROWSER_BACKEND` entirely. There is **no legacy fallback** — `BROWSERS` is the single source of truth. If unset, Navigator warns and uses the chromium-only default.

```bash
# Default — built-in browser only
BROWSERS='[
  {"name":"chromium","role":[]}
]'

# With an add-on browser (external CDP)
BROWSERS='[
  {"name":"chromium","role":[]},
  {"name":"cloakbrowser","role":["default","search","fetch","screenshot","devtools"],"cdpUrl":"http://cloak-browser:9222"}
]'
```

> **Fallback-first model:** give Chromium an *empty* role array (`"role": []`) when an add-on should serve everything — Chromium stays registered but only serves as the last-resort fallback when the add-on is down. The add-on carries `["default","search","fetch","screenshot","devtools"]` for every operation.

### Entry schema

```js
{
  name: string,           // Unique identifier (e.g. "chromium", "cloakbrowser", "my-playwright")
  role: string[],         // Which tools may use this browser (see roles below)
  cdpUrl?: string,        // CDP endpoint URL — presence makes this an add-on browser
}
// index is NOT user-supplied — it is derived from array position (0, 1, 2, ...)
```

Every add-on is a pure CDP client. There is no `connect` field and no per-browser driver type — all add-ons connect identically. The `cdpUrl` scheme selects the connect path:

- **`ws://` / `wss://`** — a direct browser WebSocket endpoint (e.g. from `puppeteer.connect`): `puppeteer.connect({ browserWSEndpoint: cdpUrl })`.
- **`http://` / `https://`** — a CDP *server* (Chrome `--remote-debugging-port`, CloakBrowser `cloakserve`): `puppeteer.connect({ browserURL: cdpUrl })` — puppeteer fetches `/json/version` and connects to the reported `webSocketDebuggerUrl` itself.
- **Anything else** — treated as a WebSocket endpoint (backward compatible).

Scheme detection lives in one place: `_connectAddOnPage()` (see §5).

### Chromium is always present

Chromium is the only built-in browser and **must always be in the `BROWSERS` array**. It cannot be removed. When the user saves or updates the array, the system ensures Chromium exists:

- If `BROWSERS` is empty or missing Chromium → auto-add `{"name":"chromium","role":["default"]}` at the next free position
- User can reorder Chromium (e.g. push it after an add-on so the add-on is tried first)
- User cannot delete Chromium — the system re-adds it on next save

This guarantees the user always has a working browser, even if all add-ons go down.

### Roles

| Role | Tools |
|------|-------|
| `"default"` | Everything — all web tools + devtools |
| `"search"` | `web_search` only (engine pools on Chromium) |
| `"fetch"` | `web_fetch` only |
| `"screenshot"` | `web_page_screenshot`, `web_page_ascii`, `web_page_svg` |
| `"devtools"` | All `browser_*` devtools tools |

A browser can have multiple roles. `"role": ["fetch", "screenshot"]` declares it's configured for fetching and screenshots. Roles are informational labels (visible in `list_browsers` / health / console) — they do not gate routing. An **explicit empty role array** (`"role": []`) marks a browser as fallback/backup only — its only job is the last-resort Chromium guarantee when every add-on is down. Only a *missing* role defaults to `["default"]`.

### How a tool picks a browser

Search engines run on Chromium (the built-in, always-present browser) — there is no other choice and no `browser` param on `web_search`.

Page tools (`web_fetch`, `web_page_screenshot`, `web_page_ascii`, `web_page_svg`) and devtools all route through `resolveBrowserParam` (see Browser Selection & Rollback):

1. **Explicit `browser` param** — strict: must be an add-on in `BROWSERS`; failure errors the tool (no fallback).
2. **No `browser` param** — add-ons are tried in `BROWSERS` array order; the first one that connects serves the page.
3. **All add-ons down** — Chromium (always present, relaunched by Navigator itself).

`role` arrays are informational (what each browser is *configured for*, surfaced in `list_browsers` / health) — they do not gate routing. Routing is exclusively explicit-param → array order → Chromium.

### Derived fields

```js
// loadConfig() return adds:
browsers: [
  { name: "chromium",     role: ["default"], addOn: false },
  { name: "cloakbrowser", role: ["fetch"],   addOn: true, cdpUrl: "ws://..." },
],

// Derived convenience field (kept for call-sites that pass a single backend):
defaultBackend: "chromium",   // always the built-in — the only non-add-on
```

---

## 3. Engine Routing (No Backend Concept)

### Cut the `backend` concept entirely

Search engines no longer reference a backend at all. There is no `backend` field, no `KNOWN_BACKENDS`, no `BACKEND_DRIVERS` registry, no `connect` aliases. Every engine is one of two types, and the type decides everything:

| Type | Protocol | Browser? | Example |
|------|----------|----------|---------|
| **Browser engine** | CDP (`page.goto()`, `page.evaluate()`, …) | Runs on Chromium (the only built-in) | `duckduckgo`, `google`, `bing`, `brave`, `startpage`, `yahoo`, `mojeek` |
| **API engine** | HTTP — pure fetch | No browser | `duckduckgo_api`, `exa_api`, `linkup_api`, `tavily_api`, `firecrawl_api` |

Routing rule in `newPage()`: a browser engine routes to **Chromium** (`pool === "engine"`). An API engine never opens a page (`pool === null` → `isBrowser === false`). Add-on browsers are **not** used by search engines — they serve the page tools (`web_fetch`, screenshots, ascii, svg) and devtools via the `browser` param.

```js
// src/browser.js — _poolEngine after the cut
_poolEngine(engine) {
  const lower = (engine || "").toLowerCase();
  return getEngineMetadata(lower)?.pool === "engine" ? lower : null; // API → no pool
}
```

Search failures degrade by trying the **next engine** (existing circuit-breaker + fallback sequencing in `src/search.js`). Browser failure is not part of engine routing anymore — search engines only ever run on Chromium, and Chromium is always present and relaunched in-process on crash.

### Why browser engines are backend-agnostic

The driver is pure search logic — `submit()`, `extract()`, `assertNotBlocked()` — with zero browser references. It works on any CDP browser by construction; Navigator pins it to Chromium because that is the one browser it owns.

---

## 4. Consolidated Engine Model

### Two driver types

| Type | Protocol | Browser? | Example |
|------|----------|----------|---------|
| **Browser driver** | CDP — runs on Chromium (built-in) | Yes | `duckduckgo`, `google`, `bing` |
| **API driver** | HTTP — pure fetch, no browser | No | `duckduckgo_api`, `exa_api` |

Browser drivers are **backend-agnostic**. They use CDP commands which work identically on any CDP browser; Navigator routes them to Chromium because it is the one browser it launches itself.

### Consolidated engine registry

**Before (11 browser engine IDs):**

```
duckduckgo_cb, duckduckgo_ch, google_cb, google_ch, google_lp,
bing_cb, bing_lp, brave_cb, startpage_cb, yahoo_cb
```

**After (7 clean IDs):**

```
duckduckgo, google, bing, brave, startpage, yahoo, mojeek
```

Each file is named after its search engine. No suffixes.

| Old files | New file | Notes |
|-----------|----------|-------|
| `duckduckgo-cb.js` + `duckduckgo-ch.js` + `duckduckgo-browser.js` | **`duckduckgo.js`** | Merge into one |
| `google-cb.js` + `google-ch.js` + `google-driver.js` | **`google.js`** | Merge into one |
| `google-lp.js` | **DELETE** | Not needed |
| `bing-cb.js` + `bing-lp.js` + `bing-driver.js` | **`bing.js`** | Merge into one |
| `brave-cb.js` | **`brave.js`** | Rename |
| `startpage-cb.js` | **`startpage.js`** | Rename (keep `withNavigationRetry`) |
| `yahoo-cb.js` + `yahoo-driver.js` | **`yahoo.js`** | Merge into one |
| `mojeek-lp.js` | **`mojeek.js`** | Rename |

### What the driver looks like

```js
// src/engines/duckduckgo.js
import { BrowserSearchDriver } from "./browser-driver.js";

export class DuckDuckGoEngine extends BrowserSearchDriver {
  id = "duckduckgo";
  pool = "engine";
  homeUrl = "https://duckduckgo.com/";

  // submit(), extract(), assertNotBlocked() — all live here
  // Works on ANY CDP browser — no backend reference
}
```

No `backends` array. No `backend` property. The driver is pure search logic. The system decides which browser runs it — always Chromium for browser engines, none for API engines.

### Engine selection

Search engine routing uses the existing `select_best` sequencing in `src/search.js` — engines are tried in order with circuit breakers, API engines as fallback. Browser availability is not part of engine selection because browser engines only ever run on Chromium (always present, auto-relaunched on crash).

### Fallback chain for a single search

```
User: web_search(["python tutorial"])
  │
  ├─ "python tutorial" → try duckduckgo (Chromium)
  │   ├─ Success → return results
  │   └─ Failure → circuit breaker trips → try google (Chromium)
  │       ├─ Success → return results
  │       └─ Failure → try bing → brave → startpage → yahoo → mojeek
  │
  └─ All browser engines exhausted → try API engines (no browser)
      ├─ duckduckgo_api → HTTP fetch
      └─ exa_api → HTTP fetch
```

### What changes vs. current

| Current | New |
|---------|-----|
| 11 browser engine IDs (`_cb`, `_ch`, `_lp` suffixes) | 7 clean IDs |
| Engine hardcodes `backend: "cloakbrowser"` | Engine is backend-agnostic (no backend concept) |
| `pool: "shared"` route to Lightpanda | Every browser engine runs on Chromium — `pool` is `"engine"` |
| Lightpanda spawn/respawn lifecycle | REMOVED — no lightpanda code anywhere |
| If backend is down, engine fails | Chromium relaunches in-process; otherwise next engine / API fallback |
| `_cb`, `_ch`, `_lp` are separate files | One file per search engine |
| `google-lp.js` with different selectors | Deleted — no Lightpanda to special-case |

---

## 5. Add-on Page Creation

### The `_connectAddOnPage()` method

New method on `BrowserManager` that handles all add-on browsers. Add-ons serve the **page tools** only — `web_fetch`, `web_page_screenshot`, `web_page_ascii`, `web_page_svg`, and devtools — selected via the tool's `browser` param. They do **not** run search engines.

```js
async _connectAddOnPage(entry) {
  const stateKey = `addon_${entry.name}`;
  let state = this._addOnState.get(stateKey);

  // Reuse existing connection if alive
  if (state?.connected) return state.browser.newPage();

  // Connect to external CDP — HTTP = CDP server (browserURL), WS = direct endpoint
  const usesHttp = /^https?:\/\//i.test(String(entry.cdpUrl || ""));
  const browser = await puppeteer.connect({
    defaultViewport: { width: 1920, height: 1080 },
    ...(usesHttp ? { browserURL: entry.cdpUrl } : { browserWSEndpoint: entry.cdpUrl }),
  });

  // Track disconnection
  browser.on("disconnected", () => this._addOnState.delete(stateKey));
  this._addOnState.set(stateKey, { browser, connected: true });

  return browser.newPage();
}
```

Key properties:
- **No launch logic** — the browser is already running externally
- **No shutdown** — `shutdown()` calls `browser.disconnect()` (not `close()`)
- **Connection reuse** — if the CDP connection is alive, reuse it
- **Auto-cleanup** — `disconnected` event clears state

### What add-on browsers DON'T get

- No `prelaunch()` — user manages the browser process
- No `relaunch()` — user restarts their own browser
- No process ID tracking — Navigator doesn't own the process
- No binary path resolution — user provides the CDP URL
- No search-engine use — engines always run on Chromium (the one browser Navigator launches itself)
- No warm-up, no pooled pages, no circuit breakers for themselves — they are selected by explicit `browser` param or array-order rollback

### Lazy connection to add-ons

`getInstanceStats()` and `/health` report `addOns` as `connected: false` until the first tool call actually connects. Connections are established lazily on first use and reused thereafter. A dead add-on (`browser.disconnected` event) resets to `connected: false`; a tool that explicitly names it errors, and an implicit call rolls to the next candidate (see Browser Selection & Rollback). No automatic reconnection loops: the user's external browser is the user's responsibility.

---

## 6. File-by-File Changes

### `src/config.js`

| What | Change |
|------|--------|
| `BROWSER_BACKEND_VALUES` (line 22) | DELETE — browser types come from the `BROWSERS` array, not an enum |
| `parseBrowserBackend()` (line 171) | DELETE |
| `formatBrowserBackendShort()` (line 177) | DELETE — static "ch"/"cb"/"lp" short names die with backend concept |
| `loadConfig()` (lines 382-386) | Parse `BROWSERS` env var; validate each entry (`name`, `role[]`, optional `cdpUrl`); ensure Chromium present ($6.1) |
| `loadConfig()` return shape | Add `browsers` array: `{ name, role, addOn, cdpUrl? }`. Keep `defaultBackend: "chromium"` (only non-add-on). DELETE `devtoolsBackend`. |


#### §6.1 `BROWSERS` parsing & validation

```
parseBrowsersEnv(raw) →
  - undefined/empty        → [ { name:"chromium", role:["default"] } ]   (warn)
  - JSON.parse error       → throw (bounded: maxChars-style friendly message)
  - not an array           → throw
  - entry missing name     → throw
  - duplicate names        → throw
  - empty role             → role = []   (explicit fallback/backup-only declaration, no warning)
  - missing/undefined role → role = ["default"]
  - unknown role value     → throw
  - chromium absent        → append { name:"chromium", role:["default"] }   (warn)
  - entry has cdpUrl       → addOn: true
  - entry without cdpUrl   → must be "chromium" (only one built-in); other name → throw
```

Only Chromium may appear without `cdpUrl`. Every other entry is an add-on (requires `cdpUrl`). The array positions are the rollback order.

### `src/browser.js`

| What | Change |
|------|--------|
| Constructor | Replace per-backend fields (`_backendState`, lightpanda), keep `_chromiumPool`, add `_addOnState = new Map()` |
| `newPage()` (lines 835-851) | Routing becomes: `engine` → `_poolEngine(engine)` on Chromium; `browser` → `_connectAddOnPage(entry)` (name) or Chromium (built-in/"default"); neither → Chromium |
| `_poolEngine()` (lines 854-861) | Remove `pool: "shared"` branch — every browser engine pools on Chromium; API engines → null (no pool) |
| Add `_connectAddOnPage(entry)` | See §5 |
| Lightpanda launch/relaunch/spawn | DELETE — no lightpanda binary path, no spawn, no health |
| `getHealth()` / `getInstanceStats()` | Built-ins list now just Chromium; add `addOns` map (`connected` per add-on, lazily probed) |
| `shutdown()` | Close Chromium; `disconnect()` (never close) add-ons |
| `prelaunchIfConfigured()` / `relaunchDefaultBackend()` | Built-in only — add-ons have no launch lifecycle |

Chromium keeps its crash-relaunch loop: a crashed Chromium is relaunched in-process, so page-tool rollback to Chromium is effectively always safe.

### `src/devtools.js`

| What | Change |
|------|--------|
| `normalizeBackend()` (line 74-81) | DELETE — devtools no longer have a backend concept |
| Devtools tool handlers | Replace `backend` chaining/distribution with a single `browser` param resolved by `resolveBrowserParam(args, config, manager)` (see §7) |

Every devtools tool gains one optional `browser: string` param. No "devtools default browser" config — fallback order applies (explicit → add-ons by array order → Chromium).

### `src/search.js`

| What | Change |
|------|--------|
| `hasLightpandaRoute` (line 1019) | DELETE — no shared pool |
| Lightpanda retry (line 1079) | DELETE — engine attempts are sequential per-engine; a crashed Chromium relaunches transparently |
| Engine page creation | `manager.newPage({ engine })` — always Chromium. `_poolEngine` returns API engines' null |

### `src/mcp-server.js`

| What | Change |
|------|--------|
| `formatBrowserBackendShort` (line 971) | DELETE |
| Health endpoint | Replace `browserConnected`/`lightpandaConnected` with `{ browsers: [{ name, addOn, connected }] }` |
| **New tool: `list_browsers`** | Returns configured browsers + connection status + roles |
| Rollback helper `resolveBrowserParam(args, config, manager)` | New shared helper — explicit param → add-ons by `BROWSERS` order → Chromium (see §7) |
| `web_fetch` / `web_page_screenshot` / `web_page_ascii` / `web_page_svg` | Add optional `browser` param; open via `resolveBrowserParam` |
| `createBrowserEntry` / `devtoolsBrowserBackend` | DELETE |

### `src/engines/`

| File | Change |
|------|--------|
| `driver.js` | Remove `backend` and `pool` from contract. Browser-driver contract: `id`, `homeUrl`, `inputSelectors`, `resultSelectors`, `searchUrl()`, `search()` (API only), `submit()`, `extract()`, `assertNotBlocked()` |
| `api-driver.js` | Unchanged (no browser fields already) |
| `index.js` | Registry exports `getEngineMetadata` without `backend`/`pool`; browser engines are all Chromium-routed by construction |
| `duckduckgo-browser.js` → `duckduckgo.js` | Rename, remove backend refs |
| `google-driver.js` → `google.js` | Rename, remove backend refs |
| `bing-driver.js` → `bing.js` | Rename, remove backend refs |
| `brave-cb.js` → `brave.js` | Rename, remove backend refs |
| `startpage-cb.js` → `startpage.js` | Rename, remove backend refs (keep `withNavigationRetry`) |
| `yahoo-driver.js` → `yahoo.js` | Rename, remove backend refs |
| `mojeek-lp.js` → `mojeek.js` | Rename, remove backend refs (keep `assertNotBlocked` override) |
| `duckduckgo-cb.js`, `duckduckgo-ch.js`, `google-cb.js`, `google-ch.js`, `google-lp.js`, `bing-cb.js`, `bing-lp.js`, `yahoo-cb.js` | DELETE |
| `lightpanda/` dir + `browser-driver.js` lightpanda references | DELETE |

### Deployment files

| File | Change |
|------|--------|
| Deploy file | Change |
|------|--------|
| `docker-compose.yml` | Remove `BROWSER_BACKEND`, `DEVTOOLS_BROWSER_BACKEND`, `LIGHTPANDA_*`; add `BROWSERS` default (chromium-only; add-ons moved to per-service `docker-compose.*.yml` files) |
| `.env.example` | `BROWSERS='[{"name":"chromium","role":["default"]}]'` + add-on example comments |
| `docker/Dockerfile` | **Remove** `npx --no-install cloakbrowser install` (line 35); remove lightpanda install lines |
| `docker/navigator-mineru/` | Unaffected (extractor sidecar) |
| Remove `lightpanda/` (fork) submodule/dir if vendored | Out of scope (repo hygiene) |

### Web console

| File | Change |
|------|--------|
| `main.jsx` / `status/index.jsx` | Render browser pills from `health.browsers` dynamically |
| `lib/format.js` | Delete static backend→short map; format from browser objects |

### Config schema & validation

| File | Change |
|------|--------|
| `src/config-schema.js` | Replace `BROWSER_BACKEND` / `DEVTOOLS_BROWSER_BACKEND` entries with a `BROWSERS` entry |

### MCP tool changes

| Tool | Change |
|------|--------|
| **New: `list_browsers`** | Lists configured browsers: `{ name, role, addOn, cdpUrl?, connected }` |
| Devtools tools (all) | Add `browser` param → route per §7 |
| `web_fetch` | Add `browser` param → route per §7 |
| `web_page_screenshot` / `web_page_ascii` / `web_page_svg` | Add `browser` param → route per §7 |
| `web_search` | NO `browser` param — engines run on Chromium only |

### Test files (~120 sites)

| File | Change |
|------|--------|
| Config tests | `defaultBackend: "cloakbrowser"` → `browsers: [{name:"chromium",role:["default"]}]` |
| `tests/browser.test.js` | Replace `_backendState` access patterns |
| Engine tests | Reference consolidated engine IDs (`duckduckgo`, `google`, …) |
| `vitest.config.js` | Remove cloakbrowser mock alias |

---

## Browser Selection & Rollback

Add-ons and Chromium both serve the page tools and devtools. Selection is one shared helper — `resolveBrowserParam(args, config, manager)` in `src/mcp-server.js` (devtools imports it too):

```js
async resolveBrowserParam(args, config, manager) {
  const explicit = args.browser; // optional string, validated against BROWSERS

  if (explicit) {
    // Strict: add-on names must exist; "chromium" hits the built-in below
    if (explicit === "chromium") return manager.newPage({ browser: "chromium" });
    const entry = config.browsers.find(b => b.addOn && b.name === explicit);
    if (!entry) throw new ToolError(`unknown browser "${explicit}" — add a BROWSERS entry`);
    try {
      return await manager.newPage({ browser: entry.name });
    } catch {
      // No fallback for an explicit name — the user asked for this browser
      throw new ToolError(`browser "${explicit}" unreachable (${entry.cdpUrl})`);
    }
  }

  // No explicit browser → roll back through add-ons in BROWSERS order, then Chromium
  const pages = [];
  try {
    for (const entry of config.browsers.filter(b => b.addOn)) {
      try {
        return await manager.newPage({ browser: entry.name });
      } catch { pages.push(`${entry.name}: down`); }
    }
  } finally {
    if (pages.length) { /* partial-failure note appended to results */ }
  }
  return manager.newPage({}); // Chromium — always present
}
```

Rules:
- **`browser` param is strict** — a named add-on that fails errors the tool; no silent reroute. The one exception: `browser: "chromium"` names the built-in and always resolves to it.
- **Absent `browser` → rollback chain**: add-ons in `BROWSERS` array order, then Chromium. A down add-on is skipped with a note; the tool still succeeds on the next candidate.
- **No browser concept in searches** — `web_search` is Chromium-only (engine-level fallback instead).
- Every fallback hop is reported in the tool result so the caller sees which browser served the page.

**Devtools `browser` param example:**

```json
// No browser specified → add-on rollback order, then Chromium
{"tool": "browser_Target_createTarget", "args": {"url": "https://example.com"}}

// Explicit browser → must be an add-on entry in BROWSERS (strict, no fallback)
{"tool": "browser_Target_createTarget", "args": {"url": "https://example.com", "browser": "playwright"}}
```

**New `list_browsers` tool output:**

```json
{
  "browsers": [
    {"name": "chromium", "role": ["default"], "addOn": false, "connected": true},
    {"name": "cloakbrowser", "role": ["fetch", "devtools"], "addOn": true, "connected": true, "cdpUrl": "ws://cloakbrowser:9222"},
    {"name": "my-playwright", "role": ["fetch", "screenshot"], "addOn": true, "connected": false, "cdpUrl": "ws://127.0.0.1:9223"}
  ]
}
```

---

## 7. Implementation Order

### Phase 1: Config layer
1. Add `parseBrowsersEnv()` to `src/config.js` — parse `BROWSERS` env, validate entries (§6.1), ensure Chromium present
2. Add `browsers` array to `loadConfig()` return with `role` array + `addOn` flag (derived from `cdpUrl` presence); keep `defaultBackend: "chromium"`
3. DELETE `BROWSER_BACKEND`, `DEVTOOLS_BROWSER_BACKEND`, `parseBrowserBackend()`, `formatBrowserBackendShort()`, `BROWSER_BACKEND_VALUES`
4. `BROWSERS` unset → chromium-only default, warn
5. **Test:** existing tests pass

### Phase 2: Add-on routing in newPage()
1. Add `_addOnState = new Map()` to `BrowserManager` constructor
2. Add `_connectAddOnPage(entry)` — lazy `puppeteer.connect` (§5)
3. Reroute `newPage()`: `{ engine }` → `_poolEngine(engine)` on Chromium; `{ browser }` → add-on by name or Chromium
4. Remove lightpanda path fields (`_spawnLightpanda`, `getLightpandaBrowser`, lightpanda health) — **DELETE**
5. Add-on disconnect handling — `browser.disconnected` clears state
6. **Test:** add-on routing with a mock CDP endpoint

### Phase 3: Remove the backend abstraction
1. DELETE `_poolEngine()`'s `pool: "shared"` branch — every browser engine pools on Chromium
2. DELETE `hasLightpandaRoute` + lightpanda retry in `src/search.js`
3. DELETE `normalizeBackend()` in `src/devtools.js` — devtools have no backend
4. **Test:** full search + devtools suites pass

### Phase 4: Consolidated engine model
1. Create `src/engines/duckduckgo.js` — merge `duckduckgo-cb.js` + `duckduckgo-ch.js` + `duckduckgo-browser.js` into one clean file
2. Create `src/engines/google.js` — merge `google-cb.js` + `google-ch.js` + `google-driver.js` into one clean file
3. **DELETE** `google-lp.js` — Google doesn't run on Lightpanda
4. Create `src/engines/bing.js` — merge `bing-cb.js` + `bing-lp.js` + `bing-driver.js` into one clean file
5. Rename `brave-cb.js` → `brave.js`
6. Rename `startpage-cb.js` → `startpage.js` (keep `withNavigationRetry`)
7. Create `src/engines/yahoo.js` — merge `yahoo-cb.js` + `yahoo-driver.js` into one clean file
8. Rename `mojeek-lp.js` → `mojeek.js`
9. Update `src/engines/index.js` — register new engine classes
10. Update `src/search.js` — browser engines always open via `{ engine }` (Chromium); API engines skip page creation
11. Delete old per-backend engine files
12. **Test:** all search tests pass with consolidated engines

### Phase 5: Health, stats, lifecycle
1. Update `getHealth()` — replace `browserConnected`/`lightpandaConnected` with `browsers: [{ name, addOn, connected }]`
2. Update `getInstanceStats()` — include add-on connection status
3. Update `shutdown()` — disconnect add-ons (never close), close Chromium
4. Update `prelaunchIfConfigured()` / `relaunchDefaultBackend()` — built-in only, add-ons never launched
5. Update `_poolEngine()` — every browser engine pools on Chromium; API engines → null
6. **Lazy add-on connections** — no `AddOnHealthMonitor`, no background interval, no per-browser circuit breakers (§5)
7. **Test:** existing tests pass + mock CDP endpoint connection

### Phase 6: Tool routing + peripheral updates
1. `src/mcp-server.js` — add `resolveBrowserParam(args, config, manager)` (Browser Selection & Rollback)
2. `src/search.js` — `web_fetch` / screenshot paths take `browser` param, call `resolveBrowserParam`, report served browser in output
3. `src/devtools.js` — replace backend chaining/distribution with the shared `browser` param
4. `src/mcp-server.js` — new `list_browsers` tool + `/health` browsers shape + console Drivers panel
5. `src/engines/driver.js` — drop `backend`/`pool` from the driver contract
6. **Test:** devtools + mcp-server suites pass

### Phase 7: Deployment + cleanup
1. Update `docker-compose.yml` with `BROWSERS` env var (default: chromium + optional add-ons)
2. Update `.env`, `.env.example`, `.env.example.full`
3. **Remove** `npx --no-install cloakbrowser install` and lightpanda install lines from Dockerfile
4. Remove cloakbrowser / lightpanda mocks from `vitest.config.js`
5. Update `AGENTS.md`, `README.md`
6. Rebuild console
7. **Test:** `docker compose build && docker compose up -d` → health check → full test suite

### Phase 8: Console UI for BROWSERS config
1. `manage/index.jsx` — `BROWSERS` JSON editor (textarea with validation, shows parsed entries); drop `BROWSER_BACKEND` / `DEVTOOLS_BROWSER_BACKEND` group
2. `status/index.jsx` Drivers panel — render browser pills from `health.browsers` (name, addOn badge, connected dot, cdpUrl tooltip)
3. `status/index.jsx` LiveFeed — page-op rows show the serving browser name (from the result's `browser` field)
4. `lib/format.js` — delete static backend→short map
5. `main.jsx` — if legacy `BROWSER_BACKEND`/`DEVTOOLS_BROWSER_BACKEND` env vars are set, show migration banner
6. Rebuild console, verify panels render with new `health.browsers` data

### Phase 8a: Environment variable cleanup

**Removed (replaced by BROWSERS):**
| Variable | Was | Replaced by | Reason |
|----------|-----|-------------|--------|
| `BROWSER_BACKEND` | Primary browser for page tools | `BROWSERS` + rollback chain | Browser selection replaces single-backend default |
| `DEVTOOLS_BROWSER_BACKEND` | Browser for devtools tools | `BROWSERS` + rollback chain | Devtools gain a `browser` param instead |
| `CLOAKBROWSER_BINARY_PATH` | Path to CloakBrowser binary | `BROWSERS` `cdpUrl` | CloakBrowser is an add-on — user connects via CDP |
| `LIGHTPANDA_PATH`, `LIGHTPANDA_PORT` | Lightpanda binary + port | DELETE — no lightpanda code | Lightpanda no longer ships with Navigator |
| `PRELAUNCH_LIGHTPANDA` | Warm lightpanda on boot | DELETE | No lightpanda lifecycle |

**Still needed:**
| Variable | Purpose | Notes |
|----------|---------|-------|
| `CHROME_PATH` | Path to Chromium binary | Built-in browser |
| `CHROME_USER_DATA_DIR` | Chrome profile directory | Still needed |
| `CHROME_PROFILE_DIR` | Chrome profile folder name | Still needed |

**Search engine defaults updated (old `_cb`/`_lp` IDs removed):**
| Variable | Old default | New default |
|----------|-------------|-------------|
| `SEARCH_ROUTE_WARMUP_ENGINES` | `duckduckgo_api,google_cb,google_lp,bing_lp,duckduckgo_cb,bing_cb` | `brave,duckduckgo_api,duckduckgo` |
| `SEARCH_ENABLED_ENGINES` | `duckduckgo_cb,bing_cb,brave_cb,yahoo_cb,startpage_cb` + API keys | `duckduckgo,bing,brave,yahoo,startpage` + API keys |

**Engine name changes (old → new):**
| Old ID | New ID | Runs on |
|--------|--------|---------|
| `duckduckgo_cb`, `duckduckgo_ch` | `duckduckgo` | Chromium |
| `google_cb`, `google_ch` | `google` | Chromium |
| `bing_cb`, `bing_lp` | `bing` | Chromium |
| `brave_cb` | `brave` | Chromium |
| `startpage_cb` | `startpage` | Chromium |
| `yahoo_cb` | `yahoo` | Chromium |
| `mojeek_lp` | `mojeek` | Chromium |
| `duckduckgo_api` | `duckduckgo_api` | no browser (API) |
| `exa_api` | `exa_api` | no browser (API) |
| `linkup_api` | `linkup_api` | no browser (API) |
| `tavily_api` | `tavily_api` | no browser (API) |
| `firecrawl_api` | `firecrawl_api` | no browser (API) |

### Phase 8b: Browser params on tools

Page tools and devtools gain an optional `browser` param so the user can point a call at a specific add-on. No API-key browser restriction — API keys control tools, not browsers (cut from v2).

#### Browser params — which tools get them

| Tool | `browser` param | Notes |
|------|:---:|-------|
| `web_search` | **No** | Chromium-only — engine-level fallback |
| `web_fetch` | **Yes** | `browser` param → else hint `browserEngine` → else rollback chain |
| `web_page_screenshot` | **Yes** | explicit → rollback chain |
| `web_page_ascii` | **Yes** | explicit → rollback chain |
| `web_page_svg` | **Yes** | explicit → rollback chain |
| `Target.createTarget` (devtools) | **Yes** | explicit strict (fail) → rollback chain (Chromium last) |
| Other 18 devtools | **No** | Use the target's origin browser (indirect) |

#### Browser resolution order

All page tools resolve through `resolveBrowserParam` (Browser Selection & Rollback):
1. User-specified `browser` param — strict: must be an add-on in `BROWSERS`; a down/unknown name errors the tool (no silent reroute)
2. No `browser` param → add-ons tried in `BROWSERS` array order — first that connects serves the page
3. All add-ons down → Chromium (always present)

`web_search` — no browser param, no change. Routes through engine sequencing (Chromium).

#### Domain hints: new `browserEngine` field

Add `browserEngine` to domain hints schema. Optional string — an add-on browser name to use when extracting this hint's URLs. It supplies the *default* for `web_fetch` on matching pages when the call passes no `browser` param; rollback still applies.

```json
{
  "domain": "nse.co.in",
  "pathPattern": "/api/**",
  "browserEngine": "my-playwright",
  "default": { "format": "readability_to_markdown" }
}
```

- Validated against configured browser names (warning if name not in browsers array)
- Stored in `TOP_LEVEL_KEYS` in `src/domain-hints.js`
- `browserOpenAndExtract()` resolves via `resolveBrowserParam({ browser: hint.browserEngine, ... }, ...)`; an unreachable hint browser falls back exactly like an absent param
- Referencing Chromium here is allowed (`browser: "chromium"`) — it bypasses the add-on-only rule for explicit names only when the name is `"chromium"`

#### Files to change

**Browser params** (`web_fetch`, `web_page_screenshot`, `web_page_ascii`, `web_page_svg`, devtools):

1. `src/mcp-server.js` — add `browser` to tool schemas (string, "Browser name from `BROWSERS` — must be an add-on. Omit to roll back through add-ons in array order, then Chromium."); implement `resolveBrowserParam(args, config, manager)`; route the four page tools + devtools through it. No DB changes, no API-key interaction.
2. `src/search.js` — `openTargetsParallel()` / `browserOpenAndExtract()` / `browserCaptureScreenshot()` accept a `browser` option, resolve it, and tag each output entry with the serving browser name.
3. `src/domain-hints.js` — `browserEngine` in `TOP_LEVEL_KEYS` + validation (subsection above).
4. `src/web-console` — no key-browser UI (cut in v2); LiveFeed shows the serving browser from each result's `browser` field; page-op rows record the browser name instead of the old backend short code.

**Browser info in MCP responses** — every tool that uses a browser reports which one served, matching the existing "web_search shows engine names" pattern:

`web_fetch` entry metadata:
```
### [Page Title](42)
- Status: Success
- URL: https://example.com
- Browser: my-playwright          ← NEW
```

`web_page_screenshot` / `web_page_ascii` / `web_page_svg` — same `- Browser: <name>` line.

Implementation:
- `formatOpenPageResponse()` — check `entry.browser`, emit `- Browser: <name>`
- `browserOpenAndExtract()` / `browserCaptureScreenshot()` — set the `browser` field from the resolved browser name
- devtools `createTarget` result — include the origin browser of the tab

---

## Resilience — decided scope

The v2 resilience layer (auto-reconnect monitor, per-browser circuit breakers, health-aware routing) is **cut**. What remains is deliberately minimal:

1. **Lazy add-on connection** — `_connectAddOnPage()` connects on first use, reuses the connection, clears on `disconnected` (§5)
2. **Array-order rollback** — implicit (`browser`-less) calls try add-ons in order, then Chromium
3. **Strict explicit `browser`** — a down add-on errors with an unreachable message; no silent reroute
4. **Chromium relaunch-on-crash** — existing in-process loop; the ultimate safety net
5. **Honest reporting** — the tool result says which browser served the page

Rationale: an add-on's lifecycle is the user's domain. Navigator must not poll, reconnect, or circuit-break a browser it doesn't own. The caller gets a clear answer ("browser X down, used Y") instead of background magic.

---

## Implementation Gap Status (updated 2026-08-28)

### Declared (round 4 — consolidated into this document)

- **P1 CONFIRMED** → §2 + Browser Selection & Rollback: page tools gain `browser` param; implicit rollback = add-on array order → Chromium.
- **P2 CONFIRMED** → devtools gain `browser` param; explicit names strict; implicit calls roll back; devtools distribution across browsers retained via the rollback chain.
- **P7 CONFIRMED** → integer-array and linked-mode API keys keep working; browser routing is orthogonal to keys.
- **ROUNDED** → config accepts any number of add-ons (array, 1..N); search stays Chromium-only; bang-style navigation of an add-on run is noted as a future feature (§14).
- **PROPER-API-KEY-ROUTING** → search-only API keys route to Chromium by construction (search never uses add-ons).
- **CUT (recorded as decisions, not omissions):** API-key `allowedBrowsers` control; `AddOnHealthMonitor`; per-browser circuit breakers; health-aware engine routing; `browserEngine` interacting with API-key restrictions.

### Completed (Phases 1–7 + 8/8a core)

- Phase 1: `parseBrowsersEnv()`, `ensureChromiumPresent()`, `loadConfig()` `browsers` array
- Phase 2: `_connectAddOnPage()`, `_addOnState`, `newPage()` add-on/built-in routing; lightpanda removed
- Phase 3: backend abstraction removed (engine pool, `hasLightpandaRoute`, `normalizeBackend`)
- Phase 4: 15 engine files → 7 consolidated clean IDs
- Phase 5 (partial): `getHealth()` / `getInstanceStats()` browsers shape; `shutdown()` disconnects add-ons; lazy-connection policy
- Phase 6 (partial): `resolveBrowserParam`, devtools `browser` param, `list_browsers` tool, health shape, driver contract without backend
- Phase 7: compose / `.env` / Dockerfile updated, console rebuilt (docs pending)
- Phase 8: console `BROWSERS` editor + Drivers panel
- Phase 8a: env var cleanup (incl. lightpanda vars)

### Completed (CDP add-on validation — CloakBrowser, 2026-08-28)

- `_connectAddOnPage()` now supports **HTTP cdpUrls** (`browserURL` for CDP servers like cloakserve) alongside `ws://` (`browserWSEndpoint`)
- Fallback-first BROWSERS shape: `{"name":"chromium","role":[]}` (empty role = backup only) + add-on with all roles
- config.js honors an **explicit empty role array** (no warning / no forced `["default"]`); only missing role defaults
- The `cloak-browser` sidecar (stock `cloakhq/cloakbrowser` image, `command: ["cloakserve"]`, port 9222, `CLOAKBROWSER_LICENSE_KEY` passthrough) lives in its **own** optional `docker-compose.cloak.yml` (opt-in, like the MinerU sidecar) — NOT in the main `docker-compose.yml`
- Main compose/`.env.example` `BROWSERS` default is chromium-only (self-contained fresh install); the fallback-first cloak shape is documented but opt-in
- Unit tests: HTTP-vs-WS connect path (2 in browser.test.js), empty-role parsing (config.test.js) — all green; full suite 593/594 (1 pre-existing plan-37 SVG failure)
- **Live validation passed** (§12 matrix): connect-over-network, explicit `browser:"cloakbrowser"` fetch, param-less fetch → cloakbrowser, rollback to chromium with `Browser rollback: cloakbrowser: down` when stopped, strict unreachable error on explicit call when down, connection reuse, devtools target + screenshot on cloak

### Missing / TODO

- Phase 8b: wire `resolveBrowserParam` into the four page tools + devtools; `browser` in tool schemas; serving-browser tagging in outputs
- Domain-hints `browserEngine` field (schema + resolution in `browserOpenAndExtract`)
- Docs: `AGENTS.md`, `README.md`, `docs/` — replace backend docs with BROWSERS + browser-param docs
- Console LiveFeed / Engines panel: serving-browser per row, chromium badge
- Verify: full test suite + `docker compose build && docker compose up -d` + end-to-end `browser` param on each page tool

---

## 8. Migration: Old Env Vars

**No legacy fallback.** `BROWSERS` is the single source of truth. `BROWSER_BACKEND` / `DEVTOOLS_BROWSER_BACKEND` are not read at all — old arrays are never synthesized.

```bash
# old
BROWSER_BACKEND=cloakbrowser
DEVTOOLS_BROWSER_BACKEND=cloakbrowser

# new
BROWSERS='[{"name":"chromium","role":["default"]}]'
```

Warn-once behavior at startup: if `BROWSER_BACKEND` or `DEVTOOLS_BROWSER_BACKEND` is present in the environment, log `⚠️ BROWSER_BACKEND / DEVTOOLS_BROWSER_BACKEND are obsolete — use BROWSERS`. Acceptance: no silent legacy path, no synthesized array.

Engine IDs change: `*_cb` / `*_ch` / `*_lp` → clean names (§8a table); `SEARCH_ENABLED_ENGINES` / `SEARCH_ROUTE_WARMUP_ENGINES` defaults updated to the clean IDs.

---

## 9. Example Configurations

### Minimal (built-in only — the default)
```bash
BROWSERS='[{"name":"chromium","role":["default"]}]'
```

### Fallback-first (recommended shape — add-on serves everything, Chromium is backup)
Chromium gets an **empty role array** so it only serves as the last-resort fallback; the add-on carries every role:
```bash
BROWSERS='[
  {"name":"chromium","role":[]},
  {"name":"cloakbrowser","role":["default","search","fetch","screenshot","devtools"],"cdpUrl":"http://cloak-browser:9222"}
]'
```

### One add-on for page tools + devtools
```bash
BROWSERS='[
  {"name":"chromium","role":[]},
  {"name":"my-playwright","role":["fetch","screenshot","devtools"],"cdpUrl":"ws://127.0.0.1:9222"}
]'
```
Param-less `web_fetch`, screenshots, and devtools try `my-playwright` first, then roll to Chromium. `web_search` always runs on Chromium.

### Multiple add-ons (array order = the rollback chain)
```bash
BROWSERS='[
  {"name":"chromium","role":[]},
  {"name":"cloakbrowser","role":["default","search","fetch","screenshot","devtools"],"cdpUrl":"http://cloak-browser:9222"},
  {"name":"stealth-panda","role":["fetch","screenshot"],"cdpUrl":"ws://127.0.0.1:9223"}
]'
```
A param-less `web_fetch` tries cloakbrowser → stealth-panda → chromium.

### Pin a call to one add-on
`web_fetch(urls: ["..."], browser: "stealth-panda")` — strict: errors if stealth-panda is down.

---

## 10. Resilience — The User Never Starves

The guarantee: **results even when browsers fail.** With add-ons outside the resilience trust boundary, the chain is:

| Layer | Mechanism | Covers |
|-------|-----------|--------|
| Chromium relaunch | In-process relaunch on crash | Every Chromium-dependent call |
| Add-on rollback | Implicit `browser`-less calls try add-ons in order, then Chromium | `web_fetch`, screenshots, ascii, svg, devtools |
| Engine fallback | Circuit-breaker sequencing → API engines | `web_search` |
| Strict explicit param | A named add-on that is down errors loudly (user fixes the browser) | Informed failure |

```
User calls web_fetch(url)              User calls web_search(q)
  → add-ons in BROWSERS order            → duckduckgo → google → … → exa_api
    → first connected wins                 (engine-level fallback on Chromium)
    → all down → Chromium
```

No background monitors, no reconnection loops, no browser circuit breakers. State is lazy and honest: health reflects the last actual connection attempt.

---

## 12. CDP Add-on Validation — CloakBrowser as Test Subject

**Status:** Active (2026-08-28). CloakBrowser is the reference add-on because its binary license prohibits redistribution — it is the perfect test of the "user runs it externally" contract. It can never be a built-in; it must work as a CDP add-on or not work at all in Navigator.

### CloakBrowser's Docker image (the stock image, not ours)

| Fact | Value |
|------|-------|
| Image | `cloakhq/cloakbrowser` (Docker Hub) |
| CDP server mode | `cloakserve` — a CDP multiplexer on port **9222** (one Chrome process per fingerprint seed) |
| Entrypoint | `dockerfile`: `ENTRYPOINT ["/entrypoint.sh"]` (launches Xvfb, `DISPLAY=:99`), `EXPOSE 9222`, `CMD ["python"]` — so compose must override the command: `command: ["cloakserve"]` |
| HTTP endpoints | `GET /` , `/json/version`, `/json/list` — this is a Chrome remote-debugging-style *HTTP* endpoint, NOT a `ws://` URL |
| Per-connection query params | `?fingerprint=<seed>&timezone=...&locale=...` (each unique seed spawns an isolated profile/Chrome) |
| Notable flags | `--port=`, `--headless=false`, `--proxy-server=...`, `--data-dir=`, `--idle-timeout=` |
| Playwright client idiom | `connect_over_cdp("http://host:9222?fingerprint=12345")` |

### Why this changed the connect contract

The plan originally assumed `cdpUrl` was always a `ws://` WebSocket URL (`puppeteer.connect({ browserWSEndpoint })`). CloakBrowser's `cloakserve` is an HTTP CDP *server* — the browser's process-level URL is `http://host:9222`, and the real WebSocket path (`/devtools/browser/<uuid>`) is **dynamic**, discovered by fetching `/json/version`. So add-ons must support **both** forms:

- `ws://…` → `puppeteer.connect({ browserWSEndpoint: cdpUrl })` (direct browser endpoint)
- `http://…` → `puppeteer.connect({ browserURL: cdpUrl })` (puppeteer fetches `/json/version`, joins the `webSocketDebuggerUrl` itself)

`browserURL` handling was added to `_connectAddOnPage()` (§5) — scheme detection is the single fork point. This makes Chrome-with-`--remote-debugging-port` and every Playwright-ish CDP server work as add-ons too.

### The compose service (CloakBrowser CDP container) — SEPARATE FILE

A stock-image sidecar, no custom code — lives in its own **`docker-compose.cloak.yml`** (opt-in, same pattern as the MinerU `docker-compose.mineru.yml` sidecar). It is NOT in the main `docker-compose.yml`, so a fresh `docker compose up -d` runs built-in Chromium only. Start CloakBrowser explicitly:

```bash
docker compose -f docker-compose.cloak.yml up -d
```

```yaml
  cloak-browser:
    image: cloakhq/cloakbrowser
    container_name: cloak-browser
    restart: unless-stopped
    command: ["cloakserve"]          # image default is `python`; run the CDP multiplexer
    ports:
      - "127.0.0.1:${CLOAK_CDP_PORT:-9222}:9222"   # host bind for debugging; also on the compose network
    environment:
      CLOAKBROWSER_LICENSE_KEY: ${CLOAKBROWSER_LICENSE_KEY:-}   # set for persistent licensed use
    shm_size: 2gb
    deploy:
      resources:
        limits: { cpus: "2.0", memory: 2g }
```

Navigator reaches it over the compose network at `http://cloak-browser:9222` (no host port needed for inter-container CDP).

### The BROWSERS entry

```bash
BROWSERS='[
  {"name":"chromium","role":["default"]},
  {"name":"cloakbrowser","role":["fetch","screenshot","devtools"],"cdpUrl":"http://cloak-browser:9222"}
]'
```

### Validation matrix (what "it works" means)

| Check | Expectation | Result (2026-08-28) |
|-------|-------------|---------------------|
| `docker compose up -d cloak-browser` | Container healthy; `curl http://cloak-browser:9222/json/version` returns JSON with a `webSocketDebuggerUrl` | ✅ `curl` from negotiator returned `{"Browser":"Chrome/146...","webSocketDebuggerUrl":"ws://localhost:9222/devtools/browser/<uuid>"}` |
| `list_browsers` (/stats) | `cloakbrowser` listed as add-on, `connected:false` until first lazy use | ✅ addon type, `connected:false` before first fetch, `connected:true` after |
| `web_fetch(urls:[...], browser:"cloakbrowser")` | Serves from CloakBrowser; result tagged `browser: cloakbrowser` | ✅ `- Browser: cloakbrowser` |
| Param-less `web_fetch` | Tries cloakbrowser first (array order), falls back to Chromium if down; `rollbackNotes` show which add-on was skipped | ✅ first try returns `Browser: cloakbrowser` |
| `web_fetch(browser:"cloakbrowser")` while container stopped | Strict error `browser "cloakbrowser" unreachable (http://cloak-browser:9222)` — no silent reroute | ✅ `Error: browser "cloakbrowser" unreachable (http://cloak-browser:9222)` |
| Double navigation in one session | Second call reuses the live connection (`_addOnState` hit) | ✅ second fetch 1.1s (vs cold ~7s+) |
| Container restarted mid-session | `disconnected` clears state; next call lazily reconnects | ✅ reconnect after `docker compose stop`/`start` |
| Devtools `browser: "cloakbrowser"` | `browser_Target_createTarget` + `browser_web_fetch` on a cloak target | ✅ target created on cloak addon, screenshot served |

**One caveat:** host-side `curl http://127.0.0.1:9222` failed while LAN-side published ports worked — the compose port binding `127.0.0.1:${CLOAK_CDP_PORT:-9222}:9222` isn't reachable via host loopback on this host (same symptom as the navigator's own 1994 port); the navigator↔cloak connection goes over the compose network by service name and is unaffected.

### Why CloakBrowser as the reference

Everything else in the add-on matrix is interchangeable, but CloakBrowser is the *hard* case: HTTP-only CDP, licensed binary we can never ship, fingerprint-multiplexing that spawns real Chrome processes under Xvfb. If it works as an add-on, every Playwright/custom-CDPServer browser works too. Docker Hub quick checks: `docker run --rm cloakhq/cloakbrowser cloaktest` (smoke test the image) and `docker run -d --name cloak -p 127.0.0.1:9222:9222 cloakhq/cloakbrowser cloakserve`.

---

## 13. Risks

| Risk | Mitigation |
|------|-----------|
| Add-on not running | Implicit calls roll to the next add-on then Chromium; explicit `browser` errors with `unreachable (cdpUrl)` |
| Add-on crashes mid-op | `disconnected` clears state; next call reconnects lazily |
| Add-on hangs | `BROWSER_OP_TIMEOUT_MS` kills the op; navigator-side pages close |
| CDP URL changes | User updates `BROWSERS` + restart; stale connection errors surface in the tool result |
| `BROWSERS` JSON parse failure | Fail fast at boot with a friendly message (no silent defaults) |
| User explicitly pins a dead add-on over healthy Chromium | Their choice — the result reports which browser served (or errors) |
| Chromium dies | Existing relaunch loop — Chromium is owned and self-healing |

---

## 14. Future Extensibility

Adding any CDP-compatible browser as an add-on is a config-only change — zero code:

```bash
BROWSERS='[
  {"name":"chromium","role":["default"]},
  {"name":"playwright","role":["fetch","screenshot","devtools"],"cdpUrl":"ws://127.0.0.1:9222"}
]'
```

Future ideas (not committed):
- **`web_search` via add-on**: a "browser engines may target add-ons" mode — needs SERP-capability tagging per engine; deliberately excluded from v2 (search stays Chromium-only)
- **Bang routing** (`... search:bang`): pair an explicit add-on run of an engine's SERP with a bang, turning per-add-on search into a navigation feature (the ROUNDED follow-up)
- **Per-session browser stickiness**: devtools targets already remember their origin browser via `targetId`
- **A stable lightpanda-style backend**: when one is production-ready, it ships as a user-provided add-on entry — nothing in Navigator is browser-specific

Adding a new **built-in** browser (full lifecycle management) is deliberately harder — Navigator owns Chromium and intentionally only one built-in.
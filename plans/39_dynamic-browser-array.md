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

### Built-in browsers (shipped with Navigator)

| Browser | Launch method | Docker image |
|---------|--------------|-------------|
| **Chromium** | `puppeteer.launch()` — Navigator spawns the process | Binary baked into image (`/usr/bin/chromium`) |

Built-in browsers have full lifecycle management: Navigator launches, monitors, and shuts them down.

### Add-on browsers (user-provided CDP URL)

| Browser | Launch method | Docker image |
|---------|--------------|-------------|
| **Lightpanda** (or any CDP browser) | `puppeteer.connect({ browserWSEndpoint: cdpUrl })` | **NOT in image** — user runs it externally |
| **CloakBrowser** (or any CDP browser) | `puppeteer.connect({ browserWSEndpoint: cdpUrl })` | **NOT in image** — user runs it externally |

Add-on browsers are pure CDP clients — Navigator connects to an already-running browser. No lifecycle management (no launch, no shutdown). The user is responsible for starting/stopping the browser.

### Why this model?

1. **Legal safety** — CloakBrowser's binary license prohibits redistribution. Navigator never touches the binary.
2. **Simplicity** — add-on browsers are just a `puppeteer.connect()` call. No per-backend launch logic.
3. **Extensibility** — any CDP-compatible browser (Playwright, Selenium, rod, etc.) works as an add-on with zero code changes.
4. **Separation of concerns** — Navigator manages its own browsers; add-ons are external dependencies.

---

## 2. New Config Format

### Env var: `BROWSERS`

Replaces `BROWSER_BACKEND` and `DEVTOOLS_BROWSER_BACKEND` entirely.

```bash
# Default — built-in browser only
BROWSERS='[
  {"name":"chromium","role":["default"]}
]'

# With Lightpanda as an add-on (external)
BROWSERS='[
  {"name":"chromium","role":["default"]},
  {"name":"lightpanda","role":["search"],"cdpUrl":"ws://127.0.0.1:9222","connect":"lightpanda"}
]'

# With CloakBrowser add-on
BROWSERS='[
  {"name":"chromium","role":["default"]},
  {"name":"cloakbrowser","role":["search"],"cdpUrl":"ws://127.0.0.1:9222","connect":"cloakbrowser"}
]'
```

### Entry schema

```js
{
  name: string,           // Unique identifier (e.g., "chromium", "cloakbrowser", "my-playwright")
  role: string[],         // Which tools use this browser (see roles below)
  index: number,          // Priority order within role — lower = tried first (0, 1, 2, ...)
  cdpUrl?: string,        // WebSocket URL — presence makes this an add-on browser
  connect?: string,       // Built-in driver type to use for page creation (only for add-ons)
}
```

### Chromium is always present

Chromium is the only built-in browser and **must always be in the `BROWSERS` array**. It cannot be removed. When the user saves or updates the array, the system ensures Chromium exists:

- If `BROWSERS` is empty or missing Chromium → auto-add `{"name":"chromium","role":["default"],"index":N}` (N = next available index)
- User can reorder Chromium (e.g., push to index 1, put Lightpanda at index 0)
- User cannot delete Chromium — the system re-adds it on next save

This guarantees the user always has a working browser, even if all add-ons go down.

### Roles

| Role | Tools |
|------|-------|
| `"default"` | Everything — all web tools + devtools |
| `"search"` | `web_search` only |
| `"fetch"` | `web_fetch` only |
| `"screenshot"` | `web_page_screenshot`, `web_page_ascii`, `web_page_svg` |
| `"devtools"` | All `browser_*` devtools tools |

A browser can have multiple roles. `"role": ["search", "fetch"]` means it handles both search and fetch but not screenshots or devtools.

### Derived fields

```js
// loadConfig() return adds:
browsers: [
  { name: "chromium",     role: ["default"],        short: "ch",  addOn: false },
  { name: "lightpanda",   role: ["search"],          short: "lp",  addOn: true, cdpUrl: "ws://127.0.0.1:9222", connect: "lightpanda" },
  { name: "cloakbrowser", role: ["search"],          short: "cb",  addOn: true, cdpUrl: "ws://...", connect: "cloakbrowser" },
],

// Derived convenience fields (kept for backward compat):
defaultBackend:  "chromium",
devtoolsBackend: "chromium",
```

---

## 3. Engine Routing with Add-ons

### The problem

Engine drivers declare `backend: "cloakbrowser"` (e.g., `duckduckgo_cb`). When CloakBrowser is an add-on (not built-in), the engine registry still says `backend: "cloakbrowser"` — but there's no built-in `"cloakbrowser"` backend. The engine needs to route to the add-on instead.

### The solution: `connect` field creates backend aliases

When `newPage()` is called with an engine whose `backend` is `"cloakbrowser"`:

1. Check if a browser in the `browsers` array has `connect: "cloakbrowser"` → route to that add-on
2. If no add-on matches, check if a built-in driver named `"cloakbrowser"` exists → use it
3. If neither exists, fall through to the default backend

```js
// Pseudocode for newPage() engine routing
async newPage(options) {
  const engine = options.engine || "";
  const routeBackend = getEngineMetadata(engine)?.backend;

  if (routeBackend) {
    // Check for add-on that connects as this backend type
    const addOn = this.config.browsers.find(b => b.addOn && b.connect === routeBackend);
    if (addOn) return this._connectAddOnPage(addOn);

    // Check for built-in driver
    if (BACKEND_DRIVERS.has(routeBackend)) {
      return BACKEND_DRIVERS.get(routeBackend).newPage(this, this.config);
    }
  }

  // Fall through to default
  return this._resolveDefaultPage(options);
}
```

### Why this works without changing engine drivers

Engine drivers for DDG, Bing, Yahoo, Brave, and Startpage are **backend-agnostic** — the `-cb` and `-ch` variants differ only in the `backend` field (verified by code comparison). The only engine with different extraction logic per backend is Google (the `-lp` variant has different CSS selectors because Lightpanda renders Google's DOM differently).

Since add-on browsers connect via CDP (they render like normal Chromium), the standard extraction selectors work. No per-engine code changes needed.

---

## 4. Consolidated Engine Model

### Two driver types

Every driver is one of two types:

| Type | Protocol | Example |
|------|----------|---------|
| **Browser driver** | CDP — connects to any browser via WebSocket | `duckduckgo`, `google`, `bing` |
| **API driver** | HTTP — pure fetch, no browser | `duckduckgo_api`, `exa_api` |

Browser drivers are **backend-agnostic**. They use CDP commands (`page.goto()`, `page.evaluate()`, `page.waitForSelector()`) which work identically on Chromium, CloakBrowser, or any CDP-compatible browser. The driver doesn't know or care which browser it's running on.

### Delete google-lp.js

Lightpanda's DOM engine is too different for Google's CSS selectors to work. Rather than maintaining a separate lightpanda variant with different selectors, **Google simply doesn't run on Lightpanda**. The system routes Google to Chromium or CloakBrowser instead. Delete `google-lp.js` entirely.

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

No `backends` array. No `backend` property. The driver is pure search logic. The system decides which browser runs it.

### Engine selection: role-based routing

Each browser has a `role` array and an `index` for priority. Tools select browsers by role, trying lower index first:

```js
// In search.js — pick browser by role, sorted by index
function selectBrowserByRole(role, config, manager) {
  // Get all browsers with this role, sorted by index
  const candidates = config.browsers
    .filter(b => b.role.includes("default") || b.role.includes(role))
    .sort((a, b) => a.index - b.index);

  for (const entry of candidates) {
    if (entry.addOn) {
      // Add-on browser — check if connected
      const state = manager._backendState.get(`addon_${entry.name}`);
      if (state?.browser?.connected) return { browser: entry.name, cdpUrl: entry.cdpUrl };
      // Not connected — skip, try next (no circuit breaker)
    } else {
      // Built-in browser — always available
      return { browser: entry.name };
    }
  }
  // No browser available with this role
  return null;
}
```

**No circuit breaker for browser failover.** If a browser goes offline, skip it and try the next one. The browser may come back soon — no need to trip a breaker.

**Example with 3 search browsers:**

```bash
BROWSERS='[
  {"name":"chromium","role":["default"],"index":0},
  {"name":"lightpanda","role":["search"],"index":0},
  {"name":"cloakbrowser","role":["search"],"index":1,"cdpUrl":"ws://127.0.0.1:9222","connect":"cloakbrowser"},
  {"name":"playwright","role":["search"],"index":2,"cdpUrl":"ws://127.0.0.1:9223","connect":"chromium"}
]'
```

`web_search` tries: lightpanda (index 0) → cloakbrowser (index 1) → playwright (index 2)

### Fallback chain for a single search

```
User: web_search(["python tutorial"])
  │
  ├─ "python tutorial" → try duckduckgo
  │   ├─ Pick search-role browser: lightpanda
  │   │   ├─ Success → return results
  │   │   └─ Failure → try next search-role browser
  │   ├─ Pick search-role browser: cloakbrowser
  │   │   ├─ Success → return results
  │   │   └─ Failure → try next engine
  │   └─ Both down → try google
  │       ├─ Pick search-role browser: lightpanda → search
  │       ├─ Pick search-role browser: cloakbrowser → search
  │       └─ ... (cascade continues)
  │
  └─ All browser engines exhausted → try API engines
      ├─ duckduckgo_api → HTTP fetch, no browser needed
      └─ exa_api → HTTP fetch, no browser needed
```

### What changes vs. current

| Current | New |
|---------|-----|
| 11 browser engine IDs | 7 clean IDs |
| Engine hardcodes `backend: "cloakbrowser"` | Engine is backend-agnostic |
| System picks engine, uses its fixed backend | System picks engine AND best available browser |
| If backend is down, engine fails | If one browser is down, tries next browser |
| `_cb`, `_ch`, `_lp` are separate files | One file per search engine |
| `google-lp.js` with different selectors | Deleted — Google doesn't run on Lightpanda |

---

## 5. Add-on Page Creation

### The `_connectAddOnPage()` method

New method on `BrowserManager` that handles all add-on browsers:

```js
async _connectAddOnPage(addOnEntry) {
  const stateKey = `addon_${addOnEntry.name}`;
  let state = this._backendState.get(stateKey);

  // Reuse existing connection if alive
  if (state?.browser?.connected) {
    return state.browser.newPage();
  }

  // Connect to external CDP
  const browser = await puppeteer.connect({
    browserWSEndpoint: addOnEntry.cdpUrl,
    defaultViewport: { width: 1920, height: 1080 },
  });

  // Store state (owned: false = don't close on shutdown)
  this._backendState.set(stateKey, {
    browser,
    owned: false,
    connected: true,
  });

  // Track disconnection
  browser.on("disconnected", () => {
    this._backendState.delete(stateKey);
  });

  return browser.newPage();
}
```

Key properties:
- **No launch logic** — the browser is already running externally
- **No shutdown** — `owned: false`, so `shutdown()` calls `browser.disconnect()` (not `close()`)
- **Connection reuse** — if the CDP connection is alive, reuse it
- **Auto-cleanup** — `disconnected` event clears state

### What add-on browsers DON'T get

- No `prelaunch()` — user manages the browser process
- No `relaunch()` — user restarts their own browser
- No process ID tracking — Navigator doesn't own the process
- No binary path resolution — user provides the CDP URL

---

## 6. File-by-File Changes

### `src/config.js` (~15 change sites)

| What | Change |
|------|--------|
| `BROWSER_BACKEND_VALUES` (line 22) | Keep for built-in type validation; add-ons use arbitrary names |
| `parseBrowserBackend()` (line 171) | Keep as internal helper for fallback synthesis |
| `formatBrowserBackendShort()` (line 177) | Make dynamic: derive from `browsers[].short` |
| `loadConfig()` (lines 382-386) | Parse `BROWSERS` env var, validate `role` array + `index`, ensure Chromium present |
| `loadConfig()` return shape | Add `browsers` array with `role` array, `index`, `addOn` flag; keep derived fields |
| Path-finding functions (lines 204-303) | Keep for built-in browsers; add-ons don't need them |

### `src/browser.js` (~60 change sites)

| What | Change |
|------|--------|
| Constructor (lines 112-140) | Add `_backendState = new Map()`; keep built-in fields during migration |
| `newPage()` (lines 835-851) | Add add-on routing before built-in dispatch |
| Add `_connectAddOnPage()` | New method for CDP connect to external browsers |
| `_poolEngine()` (lines 854-861) | Replace hardcoded checks with generic logic |
| `getHealth()` (lines 1014-1049) | Add `addOns` map showing connection status of each add-on |
| `getInstanceStats()` (lines 1052-1058) | Include add-on connection status |
| `shutdown()` (lines 1246-1300) | Disconnect add-ons (not close); close built-ins |
| `prelaunchIfConfigured()` (lines 1136-1173) | Skip add-ons (no prelaunch) |
| `relaunchDefaultBackend()` (lines 1182-1243) | Skip add-ons (user-managed) |
| Built-in driver extraction | Move `ChromiumDriver` / `LightpandaDriver` into registry (Phase 2) |

### `src/devtools.js` (2 change sites)

| What | Change |
|------|--------|
| `normalizeBackend()` (line 74-81) | Allow add-on names in the valid set (from `config.browsers` with `"devtools"` or `"default"` role) |
| All devtools tool handlers | Add optional `browser` param — routes to browser with `"devtools"` or `"default"` role |

### `src/search.js` (2 change sites)

| What | Change |
|------|--------|
| `hasLightpandaRoute` (line 1019) | Replace `backend === "lightpanda"` with `pool === "shared"` |
| Lightpanda retry (line 1079) | Generalize — not specific to lightpanda |

### `src/mcp-server.js` (4 change sites)

| What | Change |
|------|--------|
| `formatBrowserBackendShort` fallback (line 971) | Use `config.browsers` to resolve |
| Health endpoint | Add `addOns` to response; keep aliases |
| **New tool: `list_browsers`** | Returns all browsers from config + connection status + role |
| All MCP tool handlers | Use role-based browser selection from `BROWSERS` config |

### `src/engines/driver.js` (1 change site)

| What | Change |
|------|--------|
| `KNOWN_BACKENDS` (line 1) | Keep as built-in type set; add-ons don't need to be in it (routed via `connect` field) |

### `src/config-schema.js` (2 change sites)

| What | Change |
|------|--------|
| `BROWSER_BACKEND` schema (line 4) | Replace with `BROWSERS` schema (includes `role` array field) |
| `DEVTOOLS_BROWSER_BACKEND` schema (line 5) | Remove — derived from `BROWSERS` |

### Web console (3 change sites)

| File | Change |
|------|--------|
| `main.jsx` line 355 | Render from `health.backends` + `health.addOns` dynamically |
| `status/index.jsx` line 342 | Same |
| `lib/format.js` line 66-73 | Dynamic backend name → short lookup |

### Engine files (consolidation — ~15 files → 7 clean files)

| Old files | New file | Change |
|-----------|----------|--------|
| `src/engines/duckduckgo-cb.js` | Delete | Merged into `duckduckgo.js` |
| `src/engines/duckduckgo-ch.js` | Delete | Merged into `duckduckgo.js` |
| `src/engines/duckduckgo-browser.js` | `src/engines/duckduckgo.js` | Rename + remove backend reference |
| `src/engines/google-cb.js` | Delete | Merged into `google.js` |
| `src/engines/google-ch.js` | Delete | Merged into `google.js` |
| `src/engines/google-driver.js` | `src/engines/google.js` | Rename + remove backend reference |
| `src/engines/google-lp.js` | **DELETE** | Not needed — Google doesn't run on Lightpanda |
| `src/engines/bing-cb.js` | Delete | Merged into `bing.js` |
| `src/engines/bing-lp.js` | Delete | Merged into `bing.js` |
| `src/engines/bing-driver.js` | `src/engines/bing.js` | Rename + remove backend reference |
| `src/engines/brave-cb.js` | `src/engines/brave.js` | Rename + remove backend reference |
| `src/engines/startpage-cb.js` | `src/engines/startpage.js` | Rename + remove backend reference (keep `withNavigationRetry`) |
| `src/engines/yahoo-cb.js` | Delete | Merged into `yahoo.js` |
| `src/engines/yahoo-driver.js` | `src/engines/yahoo.js` | Rename + remove backend reference |
| `src/engines/mojeek-lp.js` | `src/engines/mojeek.js` | Rename + remove backend reference |
| `src/engines/driver.js` | `src/engines/driver.js` | Remove `KNOWN_BACKENDS` (no longer needed) |
| `src/engines/index.js` | `src/engines/index.js` | Update registry — clean engine names only |

### Deployment files

| File | Change |
|------|--------|
| `docker-compose.yml` | Replace `BROWSER_BACKEND` / `DEVTOOLS_BROWSER_BACKEND` with `BROWSERS` |
| `.env` | Default: `[{"name":"chromium","role":["default"]}]` |
| `.env.example` | Update with new format + add-on example |
| `docker/Dockerfile` | **Remove** `npx --no-install cloakbrowser install` (line 35) |

### Test files (~120+ sites)

| File | Change |
|------|--------|
| All test files | Replace `defaultBackend: "cloakbrowser"` with `browsers: [{name:"chromium",role:["default"]}]` |
| `tests/browser.test.js` | Update backend state access patterns |
| `vitest.config.js` | Remove cloakbrowser mock alias (no longer built-in) |

### MCP tool changes

| Tool | Role | Change |
|------|------|--------|
| **New: `list_browsers`** | — | Returns all configured browsers with role array, connection status, and type |
| All devtools tools | `"devtools"` | Add optional `browser` param — defaults to first browser with `"devtools"` or `"default"` role |
| `web_search` | `"search"` | Uses first browser with `"search"` or `"default"` role |
| `web_fetch` | `"fetch"` | Uses first browser with `"fetch"` or `"default"` role |
| `web_page_screenshot` | `"screenshot"` | Uses first browser with `"screenshot"` or `"default"` role |

**New `list_browsers` tool output:**

```json
{
  "browsers": [
    {"name": "chromium", "role": ["default"], "type": "builtin", "connected": true},
    {"name": "lightpanda", "role": ["search"], "type": "addon", "connected": true, "cdpUrl": "ws://lightpanda:9222"},
    {"name": "cloakbrowser", "role": ["search"], "type": "addon", "connected": true, "cdpUrl": "ws://cloakbrowser:9222"}
  ]
}
```

**Devtools `browser` param example:**

```json
// No browser specified → uses first browser with "devtools" or "default" role
{"tool": "browser_Target_createTarget", "args": {"url": "https://example.com"}}

// Explicit browser → must be in config and have "devtools" or "default" role
{"tool": "browser_Target_createTarget", "args": {"url": "https://example.com", "browser": "playwright"}}
```

When `browser` is omitted, uses the first browser with `"devtools"` or `"default"` role. When specified, routes to that specific browser (must be in `BROWSERS` config, have `"devtools"` or `"default"` in its role array, and connected).

---

## 7. Implementation Order

### Phase 1: Config layer
1. Add `parseBrowsers()` to `src/config.js` — parse `BROWSERS` env, validate `role` array
2. Add `browsers` array to `loadConfig()` return with `role` array, `addOn` flag derived from `cdpUrl` presence
3. Derive `defaultBackend` / `devtoolsBackend` from `browsers` array (first matching role)
4. Fall back to hardcoded defaults when `BROWSERS` is unset
5. **Test:** existing tests pass

### Phase 2: Add-on routing in newPage()
1. Add `_connectAddOnPage()` method to `BrowserManager`
2. Extend `newPage()` to check add-on browsers before built-in dispatch
3. Add add-on connection tracking to `_backendState`
4. Add add-on disconnect handling
5. **Test:** add-on routing with a mock CDP endpoint

### Phase 3: Built-in driver registry
1. Extract `ChromiumDriver` from `getBrowser()` / `_newChromiumPage()` / `launchBrowser()`
2. Extract `LightpandaDriver` from `getLightpandaBrowser()` / `_newLightpandaPage()` / `_spawnLightpanda()`
3. Register in `BACKEND_DRIVERS` map
4. Replace `newPage()` built-in if/else with registry dispatch
5. **Test:** existing tests pass

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
10. Update `src/search.js` — engine selection picks best available browser from BROWSERS config
11. Delete old per-backend engine files
12. **Test:** all search tests pass with consolidated engines

### Phase 5: Health, stats, lifecycle + auto-reconnect
1. Update `getHealth()` — add `addOns: { [name]: { connected, cdpUrl } }` map
2. Update `getInstanceStats()` — include add-on status
3. Update `shutdown()` — disconnect add-ons, close built-ins
4. Update `prelaunchIfConfigured()` — skip add-ons
5. Update `relaunchDefaultBackend()` — skip add-ons
6. Update `_poolEngine()` — generic pool logic
7. Add `AddOnHealthMonitor` — background 10s interval, auto-reconnect on disconnection
8. Add browser backend circuit breakers — trip on repeated connection failures
9. **Test:** existing tests pass + auto-reconnect with mock CDP endpoint

### Phase 6: Peripheral updates
1. `src/devtools.js` — allow add-on names in `normalizeBackend()`
2. `src/search.js` — generalize lightpanda-specific checks
3. `src/mcp-server.js` — health endpoint shape
4. `src/engines/driver.js` — `KNOWN_BACKENDS` stays as built-in set
5. Web console — dynamic backend rendering (3 files)
6. **Test:** existing tests pass

### Phase 7: Deployment + cleanup
1. Update `docker-compose.yml` with `BROWSERS` env var (default: chromium + lightpanda only)
2. Update `.env`, `.env.example`, `.env.example.full`
3. **Remove** `npx --no-install cloakbrowser install` from Dockerfile
4. Remove cloakbrowser from `vitest.config.js` mock aliases
5. Update `AGENTS.md`, `README.md`
6. Rebuild console
7. **Test:** `docker compose build && docker compose up -d` → health check → full test suite

### Phase 8: Console UI for BROWSERS config
1. `manage/index.jsx` — Replace `BROWSER_BACKEND` / `DEVTOOLS_BROWSER_BACKEND` group with `BROWSERS` JSON editor (textarea with validation, shows parsed entries)
2. `manage/index.jsx` — Mark old keys as DEPRECATED in the config panel (still editable for migration, but BROWSERS takes precedence)
3. `status/index.jsx` Drivers panel — Show role badges per browser (`search`, `fetch`, `screenshot`, `devtools` pills next to the name)
4. `status/index.jsx` Drivers panel — Show add-on details: `cdpUrl`, connection status, reconnect count
5. `status/index.jsx` Engines panel — Show which browser each engine routes to (derived from pool: `shared` → lightpanda, `engine` → defaultBackend)
6. `status/index.jsx` Engines panel — Add browser badge to each engine card (e.g. "google → CH", "bing → LP")
7. `status/index.jsx` LiveFeed — For search rows: show engine name + browser used (e.g. "google · CH", "bing · LP"). For page op rows: show browser name instead of just the tool backend short code
8. `status/index.jsx` LiveFeed — Expand `buildFeed()` to resolve engine → browser mapping using `config.engines` pool data + `health.browsers` data. When `attempt.backend` is null (from DB), derive it from the engine's pool
9. `lib/format.js` `formatBackend()` — Make dynamic: derive short names from `config.browsers` instead of hardcoded map. Fallback to current map for unknown names
10. `main.jsx` — If any BROWSER_BACKEND/DEVTOOLS_BROWSER_BACKEND env vars are set, show a migration banner pointing to BROWSERS
11. Rebuild console, verify all panels render correctly with new `health.browsers` data

### Phase 8a: Environment variable cleanup

**Removed (replaced by BROWSERS):**
| Variable | Was | Replaced by | Reason |
|----------|-----|-------------|--------|
| `BROWSER_BACKEND` | Primary browser for page tools | `BROWSERS` with `role: ["default"]` | Role-based routing replaces single-backend selection |
| `DEVTOOLS_BROWSER_BACKEND` | Browser for devtools tools | `BROWSERS` with `role: ["devtools"]` or `role: ["default"]` | Role-based routing replaces explicit devtools backend |
| `CLOAKBROWSER_BINARY_PATH` | Path to CloakBrowser binary | `BROWSERS` with `cdpUrl` field | CloakBrowser is now an add-on — user connects via CDP URL, no binary needed |

**Still needed (built-in browsers have lifecycle management):**
| Variable | Purpose | Notes |
|----------|---------|-------|
| `CHROME_PATH` | Path to Chromium binary | Still needed — Chromium is built-in |
| `CHROME_USER_DATA_DIR` | Chrome profile directory | Still needed |
| `CHROME_PROFILE_DIR` | Chrome profile folder name | Still needed |

**Search engine defaults updated (old `_cb`/`_lp` IDs removed):**
| Variable | Old default | New default |
|----------|-------------|-------------|
| `SEARCH_ROUTE_WARMUP_ENGINES` | `duckduckgo_api,google_cb,google_lp,bing_lp,duckduckgo_cb,bing_cb` | `brave,duckduckgo_api,duckduckgo` |
| `SEARCH_ENABLED_ENGINES` | `duckduckgo_cb,bing_cb,brave_cb,yahoo_cb,startpage_cb` + API keys | `duckduckgo,bing,brave,yahoo,startpage` + API keys |

**Manage page changes (`manage/index.jsx`):**
1. Remove `BROWSER_BACKEND` and `DEVTOOLS_BROWSER_BACKEND` from `MANAGE_GROUPS` "Browser Defaults" group
2. Add `BROWSERS` as a new group "Browser Array" with JSON textarea editor
3. Remove `CLOAKBROWSER_BINARY_PATH` from "Backend Installations" group (CloakBrowser is no longer a built-in binary)
4. Keep `CHROME_PATH`, `CHROME_USER_DATA_DIR`, `CHROME_PROFILE_DIR`, `LIGHTPANDA_PATH`, `LIGHTPANDA_PORT` in "Backend Installations"
5. `config-schema.js` — Mark `BROWSER_BACKEND`, `DEVTOOLS_BROWSER_BACKEND`, `CLOAKBROWSER_BINARY_PATH` as `deprecated: true` (keep for migration, hide from UI)

**Engine name changes (old → new):**
| Old ID | New ID | Pool | Browser routing |
|--------|--------|------|----------------|
| `duckduckgo_cb`, `duckduckgo_ch` | `duckduckgo` | `engine` | defaultBackend (CH) |
| `google_cb`, `google_ch` | `google` | `engine` | defaultBackend (CH) |
| `bing_cb`, `bing_lp` | `bing` | `shared` | lightpanda (LP) |
| `brave_cb` | `brave` | `engine` | defaultBackend (CH) |
| `startpage_cb` | `startpage` | `engine` | defaultBackend (CH) |
| `yahoo_cb` | `yahoo` | `engine` | defaultBackend (CH) |
| `mojeek_lp` | `mojeek` | `shared` | lightpanda (LP) |
| `duckduckgo_api` | `duckduckgo_api` | `null` | no browser (API) |
| `exa_api` | `exa_api` | `null` | no browser (API) |
| `linkup_api` | `linkup_api` | `null` | no browser (API) |
| `tavily_api` | `tavily_api` | `null` | no browser (API) |
| `firecrawl_api` | `firecrawl_api` | `null` | no browser (API) |

### Phase 8b: API key browser access control + browser params on tools

API keys gain per-browser access control. Tools that use browsers get explicit browser selection and fallback chains.

#### Browser params — which tools get them

| Tool | `browser` param | Notes |
|------|:---:|-------|
| `web_search` | **No** | Routes through engine pools (metadata-driven) |
| `web_fetch` | **No** | Uses domain hint `browserEngine` → `defaultBrowser` → array fallback |
| `web_page_screenshot` | **Yes** | explicit `browser` → `defaultBrowser` → array fallback |
| `web_page_ascii` | **Yes** | explicit `browser` → `defaultBrowser` → array fallback |
| `web_page_svg` | **Yes** | explicit `browser` → `defaultBrowser` → array fallback |
| `Target.createTarget` | **Yes** | explicit `browser` → `defaultBrowser` → **fail** (no fallback) |
| Other 18 devtools | **No** | Use existing tab's browser (indirect) |

#### Browser resolution order

**Tools with `browser` param** (`web_page_screenshot`, `web_page_ascii`, `web_page_svg`):
1. User-specified `browser` param → check `allowedBrowsers` → use if allowed
2. `config.defaultBrowser` (first in browsers array) → check `allowedBrowsers` → use if allowed
3. Next browser in `browsers[]` that passes `allowedBrowsers` check
4. Error: "no allowed browser available"

**`web_fetch`** (no `browser` param, uses domain hints):
1. If matched hint has `browserEngine` → check `allowedBrowsers` → use if allowed
2. `config.defaultBrowser` → check `allowedBrowsers` → use if allowed
3. Next browser in `browsers[]` that passes `allowedBrowsers` check
4. Error: "no allowed browser available"

**`Target.createTarget`** (devtools):
1. User-specified `browser` → check `allowedBrowsers` → use if allowed, else reject
2. `config.defaultBrowser` → use
3. No fallback — fail with clear error

**`web_search`** — no browser param, no change. Routes through engine pool metadata.

#### Domain hints: new `browserEngine` field

Add `browserEngine` to domain hints schema. Optional string — the browser name to use when extracting this hint's URLs.

```json
{
  "domain": "nse.co.in",
  "pathPattern": "/api/**",
  "browserEngine": "lightpanda",
  "default": { "format": "readability_to_markdown" }
}
```

- Validated against configured browser names (warning if name not in browsers array)
- Stored in `TOP_LEVEL_KEYS` in `src/domain-hints.js`
- Used by `browserOpenAndExtract()` to select browser before `manager.newPage()`

#### API key `allowedBrowsers` semantics

- `allowedBrowsers: null` = all browsers allowed (default, backward-compatible)
- `allowedBrowsers: ["chromium"]` = only chromium
- `allowedBrowsers: ["chromium", "lightpanda"]` = both allowed
- Empty array `[]` = no browsers allowed (all browser-using tools blocked)
- Console API key = always full access (bypasses check)

#### Files to change

**Files to change:**

#### 1. `src/db.js` — schema + functions

**Migration** (add to `MIGRATIONS` array):
```sql
ALTER TABLE api_keys ADD COLUMN allowed_browsers TEXT;
```

**Updated functions:**
```js
// listMcpApiKeys — add allowed_browsers to SELECT
export function listMcpApiKeys() {
  return getDb().prepare(
    "SELECT id, name, secret, created_at, allowed_tools, allowed_browsers FROM api_keys ORDER BY created_at DESC, id DESC"
  ).all();
}

// createMcpApiKey — accept allowedBrowsers
export function createMcpApiKey({ name, secret, allowedTools = null, allowedBrowsers = null }) {
  const result = getDb().prepare(
    "INSERT INTO api_keys (name, secret, created_at, allowed_tools, allowed_browsers) VALUES (?, ?, ?, ?, ?)"
  ).run(name, secret, Date.now(),
    allowedTools === null ? null : JSON.stringify(allowedTools),
    allowedBrowsers === null ? null : JSON.stringify(allowedBrowsers)
  );
  return getDb().prepare("SELECT id, name, secret, created_at, allowed_tools, allowed_browsers FROM api_keys WHERE id = ?").get(result.lastInsertRowid);
}

// NEW — set browser access for an existing key
export function setMcpApiKeyBrowsers(id, allowedBrowsers) {
  return getDb().prepare("UPDATE api_keys SET allowed_browsers = ? WHERE id = ?")
    .run(JSON.stringify(allowedBrowsers), id).changes > 0;
}
```

#### 2. `src/mcp-server.js` — endpoint + access control

**`getConsoleApiKeysPayload()`** — add `browsers` list + per-key `allowedBrowsers`:
```js
async function getConsoleApiKeysPayload(manager) {
  const browsers = (manager.config.browsers || []).map((b) => ({
    name: b.name,
    role: b.role,
    type: b.addOn ? "addon" : "builtin",
  }));
  return {
    ok: true,
    allowUnauthenticated: manager.config.mcpAllowUnauthenticated,
    toolGroups: getToolGroups(),
    browsers,                    // NEW — all available browsers
    keys: listMcpApiKeys().map((key) => ({
      id: key.id,
      name: key.name,
      preview: maskApiKey(key.secret),
      createdAt: key.created_at,
      allowedTools: parseAllowedTools(key.allowed_tools),
      allowedBrowsers: parseAllowedTools(key.allowed_browsers),  // reuse parser (same JSON array format)
    }))
  };
}
```

**`handleConsoleApiKeys()`** — add `set_browsers` action, update `create`:
```js
// In "create" action — add allowedBrowsers:
const allowedBrowsers = Array.isArray(body?.allowedBrowsers)
  ? [...new Set(body.allowedBrowsers.filter((b) => availableBrowserNames.has(b)))]
  : null;  // null = all browsers (default)
createMcpApiKey({ name, secret: key, allowedTools, allowedBrowsers });

// NEW "set_browsers" action:
if (action === "set_browsers") {
  const id = Number(body?.id);
  const availableBrowserNames = new Set(
    (manager.config.browsers || []).map((b) => b.name)
  );
  const allowedBrowsers = Array.isArray(body?.allowedBrowsers)
    ? [...new Set(body.allowedBrowsers.filter((b) => availableBrowserNames.has(b)))]
    : [];
  if (!Number.isInteger(id) || !setMcpApiKeyBrowsers(id, allowedBrowsers)) {
    return { ok: false, error: "Unknown API key" };
  }
  return getConsoleApiKeysPayload(manager);
}
```

**`getAllowedBrowsersForRequest()`** — new function (mirrors `getAllowedToolsForRequest`):
```js
function getAllowedBrowsersForRequest(headers, config) {
  const key = getMcpApiKey(headers);
  if (!key || key === CONSOLE_API_KEY) return null;  // console key = all access
  const authorizedKey = getAuthorizedMcpKey(headers, config);
  if (!authorizedKey) return null;
  const record = listMcpApiKeys().find((entry) => entry.secret === authorizedKey);
  const allowed = record ? parseAllowedTools(record.allowed_browsers) : null;
  return allowed === null ? null : new Set(allowed);
}
```

**`handleToolCall()`** — enforce browser access:
```js
// At the top of handleToolCall, after the tools check:
if (allowedBrowsers && args.browser) {
  const requested = String(args.browser).trim().toLowerCase();
  // Built-in names always pass (chromium only)
  const builtins = ["chromium"];
  if (!builtins.includes(requested) && !allowedBrowsers.has(requested)) {
    throw new Error(`Access denied: browser "${args.browser}" is not allowed for this API key`);
  }
}
```

**Wire it through:**
- `createMcpServer(allowedTools)` → `createMcpServer(allowedTools, allowedBrowsers)`
- `handleStatelessMcpPost(body, allowedTools)` → add `allowedBrowsers` param
- HTTP handler: `const allowedBrowsers = getAllowedBrowsersForRequest(req.headers, authConfig);`
- Both session and stateless paths pass `allowedBrowsers` to `handleToolCall`

#### 3. `src/web-console/src/pages/keys/index.jsx` — UI

**Create modal** — add "Browser access" section after "Tool access":
```jsx
const [allowedBrowsers, setAllowedBrowsers] = useState([]);
const browsers = state?.browsers || [];

// In load():
setAllowedBrowsers(payload.browsers.map((b) => b.name));  // all checked by default

// Toggle helpers (same pattern as tools):
const toggleBrowser = (browser) => setAllowedBrowsers((current) =>
  current.includes(browser) ? current.filter((n) => n !== browser) : [...current, browser],
);
const toggleBrowserGroup = (role, browsers) => setAllowedBrowsers((current) => {
  const roleBrowsers = browsers.filter((b) => b.role.includes(role));
  return roleBrowsers.every((b) => current.includes(b.name))
    ? current.filter((n) => !roleBrowsers.find((b) => b.name === n))
    : [...new Set([...current, ...roleBrowsers.map((b) => b.name)])];
});
```

**Modal form** — new section between "Tool access" and actions:
```jsx
<div className="api-key-permissions-field">
  <span>Browser access</span>
  <details className="api-key-tools" open>
    <summary>
      {allowedBrowsers.length === browsers.length
        ? "All browsers allowed"
        : `${allowedBrowsers.length} of ${browsers.length} browsers allowed`}
    </summary>
    <div className="api-key-tool-groups">
      <div className="api-key-tool-actions">
        <button type="button" onClick={() => setAllowedBrowsers(browsers.map((b) => b.name))}>Allow all</button>
        <button type="button" onClick={() => setAllowedBrowsers([])}>Clear all</button>
      </div>
      {["builtin", "addon"].map((type) => {
        const group = browsers.filter((b) => b.type === type);
        if (!group.length) return null;
        return (
          <div className="api-key-tool-group" key={type}>
            <Check
              label={type === "builtin" ? "Built-in" : "Add-on"}
              checked={group.every((b) => allowedBrowsers.includes(b.name))}
              onChange={() => toggleBrowserGroup(type, group)}
            />
            <div className="api-key-tool-items">
              {group.map((b) => (
                <Check
                  key={b.name}
                  label={`${b.name} (${b.role.join(", ")})`}
                  checked={allowedBrowsers.includes(b.name)}
                  onChange={() => toggleBrowser(b.name)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  </details>
</div>
```

**List view** — show browser count:
```jsx
// Update the access column:
<small>
  {key.allowedTools === null ? "all tools" : `${key.allowedTools.length} tools`}
  {key.allowedBrowsers !== null && ` · ${key.allowedBrowsers.length} browsers`}
</small>
```

**Submit** — pass `allowedBrowsers`:
```jsx
mutate({ action: "create", name: name.trim(), allowedTools, allowedBrowsers }, "API key created.");
```

#### 4. `src/domain-hints.js` — add `browserEngine` field

Add `"browserEngine"` to `TOP_LEVEL_KEYS` array:
```js
const TOP_LEVEL_KEYS = [
  "domain", "pathPattern", "pageType", "comment", "testUrls",
  "requireSelector", "default", "flow", "flowOptions", "browserEngine"
];
```

Add validation in `validateHintRule()`:
```js
if (hint.browserEngine !== undefined) {
  if (typeof hint.browserEngine !== "string") {
    errors.push({ field: "browserEngine", message: "must be a string (browser name)" });
  } else if (!/^[a-z0-9_-]+$/.test(hint.browserEngine)) {
    errors.push({ field: "browserEngine", message: "must be lowercase alphanumeric with dashes/underscores" });
  }
  // Warning if browser name not in configured browsers (checked at runtime, not here)
}
```

#### 5. `src/search.js` — use `browserEngine` from hints in `browserOpenAndExtract()`

In `browserOpenAndExtract()`, after hint is matched, before `manager.newPage()`:
```js
// Resolve browser from hint or default
const requestedBrowser = matchedHint?.browserEngine || null;
const resolved = resolveBrowser(requestedBrowser, manager.config.browsers, allowedBrowsers, true);
const page = await manager.newPage({ backend: resolved.name });
```

This requires threading `allowedBrowsers` through `browserOpenAndExtract()` and `openTargetsParallel()`.

#### 6. `src/mcp-server.js` — add `browser` param to tool schemas

Add `browser` property to `web_page_screenshot`, `web_page_ascii`, `web_page_svg` input schemas:
```js
browser: {
  type: "string",
  description: "Browser name from the browsers array. If omitted, uses the default browser. Falls back to the next available browser if the requested one is down or not allowed."
}
```

Update `handleToolCall()` for these tools to use `resolveBrowser()`.

#### 7. Browser resolution helper

New `resolveBrowser()` function in `src/mcp-server.js` (or `src/browser.js`):

```js
/**
 * Resolve which browser to use for a tool call.
 * @param {string|null} requestedBrowser - explicit browser param from user (or null)
 * @param {Array} browsers - configured browsers array
 * @param {Set|null} allowedBrowsers - allowed browsers for this API key (null = all)
 * @param {boolean} allowFallback - true = try next in array, false = fail on first miss
 * @returns {{ name: string, browser: object }} - resolved browser
 * @throws if no allowed browser found
 */
function resolveBrowser(requestedBrowser, browsers, allowedBrowsers, allowFallback = true) {
  const isAllowed = (name) => !allowedBrowsers || allowedBrowsers.has(name);

  // Step 1: explicit request
  if (requestedBrowser) {
    const match = browsers.find((b) => b.name === requestedBrowser);
    if (match && isAllowed(match.name)) return match;
    if (!allowFallback) {
      throw new Error(`Access denied: browser "${requestedBrowser}" is not allowed or not configured`);
    }
    // fall through to array traversal
  }

  // Step 2: traverse browsers array
  for (const browser of browsers) {
    if (isAllowed(browser.name)) return browser;
  }

  throw new Error("No allowed browser available for this request");
}
```

#### 8. Access control flow

```
Client request with API key
  → getAllowedBrowsersForRequest() reads allowed_browsers from DB → Set or null
  → handleToolCall(name, args, allowedTools, allowedBrowsers)

  Tools with browser param (web_page_screenshot, web_page_ascii, web_page_svg):
    → resolveBrowser(args.browser, browsers, allowedBrowsers, allowFallback=true)
    → tries: explicit → defaultBrowser → next in array
    → first allowed+available browser wins

  web_fetch (no browser param):
    → if hint.browserEngine exists: resolveBrowser(hint.browserEngine, browsers, allowedBrowsers, allowFallback=true)
    → else: resolveBrowser(null, browsers, allowedBrowsers, allowFallback=true)
    → tries: hint → defaultBrowser → next in array

  Target.createTarget (devtools):
    → resolveBrowser(args.browser, browsers, allowedBrowsers, allowFallback=false)
    → tries: explicit → defaultBrowser → fail

  web_search:
    → no browser check (engine pool routing)
```

**Edge cases:**
- `null` allowedBrowsers = all browsers allowed (backward-compatible with existing keys)
- Empty array `[]` = no browsers allowed → all browser-using tools fail
- Console API key (`CONSOLE_API_KEY`) = always full access (bypasses check)
- `web_search` → unaffected (no browser param)
- `web_fetch` → hint `browserEngine` checked against `allowedBrowsers`; falls back to default
- `web_page_screenshot` with `browser: "lightpanda"` → checked; falls back to chromium if not allowed
- `Target.createTarget` with `browser: "lightpanda"` → checked; rejected if not allowed (no fallback)

#### 9. Browser info in MCP responses

Every tool that uses a browser tells the LLM which browser served the results. This matches the existing pattern where `web_search` shows engine names.

**`web_fetch`** — add browser line to entry metadata:
```
### [Page Title](42)
- Status: Success
- URL: https://example.com
- Browser: lightpanda          ← NEW
```

**`web_page_screenshot`** — add browser to response metadata:
```
- Screenshot captured (medium quality, 1920×1080)
- Browser: chromium            ← NEW
```

**`web_page_ascii`** / **`web_page_svg`** — same pattern, add `Browser: <name>` line.

**`web_search`** — engine is already in result data (`result.engine`), but not rendered. Add engine display:
```
- **Result Title** [example.com](1)  ← engine: duckduckgo
  - Snippet text here
```
Or as a header line: `**Results (5) via duckduckgo:**`

**Implementation:**
- `formatOpenPageResponse()` — check `entry.browser` field, add `- Browser: <name>` line
- `formatSearchMarkdown()` — render `result.engine` field
- `browserOpenAndExtract()` — set `browser` field on each result entry from `resolved.name`
- `browserCaptureScreenshot()` — set `browser` field on capture result

---

### Phase 9: Resilience implementation (Section 10)
1. Add `AddOnHealthMonitor` class to `src/browser.js` — background 10s `setInterval`, `browser.version()` health check, auto-reconnect on disconnect, `.unref()` so it doesn't block exit
2. Add browser backend circuit breakers — per-browser-name, trip on N connection failures, auto-recovery after cooldown
3. Health-aware engine routing in `src/search.js` — skip engines whose backend browser is disconnected/unhealthy
4. Browser fallback for `web_fetch` in `src/search.js` `browserOpenAndExtract()` — if default browser fails with connection error, try other built-in browsers, then add-ons
5. Expose resilience state in `/health` endpoint — add-on reconnect counts, backend circuit breaker status
6. **Test:** add-on routing with mock CDP endpoint, auto-reconnect test, fallback test

---

## Implementation Gap Status (updated 2026-08-26)

### Completed (Phases 1–7 core)
- Phase 1: `parseBrowsers()`, `ensureChromiumPresent()`, `synthesizeBrowsersFromLegacy()`, `loadConfig()` with `browsers` array ✅
- Phase 2: `_connectAddOnPage()`, `_backendState` Map, `newPage()` add-on routing + engine-to-backend routing via pool ✅
- Phase 3: Skipped — Phase 2 routing covers it ✅
- Phase 4: 15 engine files → 7 consolidated, clean IDs, registry, `search.js` routeKey/pool checks ✅
- Phase 5 (partial): `getHealth()` with `browsers`+`addOns`, `getInstanceStats()`, `shutdown()` disconnects add-ons ✅
- Phase 6: `devtools.js` normalizeBackend, `search.js` pool checks, `mcp-server.js` `list_browsers` tool, console Drivers panel dynamic ✅
- Phase 7 (partial): `docker-compose.yml` `BROWSERS`, `.env` files, Dockerfile updated, console rebuilt ✅

### Missing
- Phase 5: `AddOnHealthMonitor` (10s auto-reconnect), browser backend circuit breakers
- Phase 7: `AGENTS.md`, `README.md` updates
- Phase 8: Console UI for BROWSERS config ✅ (BrowserArrayEditor done)
- Phase 8a: Env var cleanup (deprecated keys removed) ✅
- Phase 8b: API key browser access control + browser params on tools + browser info in responses (DB + server + domain hints + UI)
- Phase 9: Resilience implementation

---

## 8. Migration: Old Env Vars → New

When `BROWSERS` is **not set**, synthesize from old vars:

```js
function synthesizeBrowsersFromLegacy() {
  const defaultBackend = parseBrowserBackend(process.env.BROWSER_BACKEND, "chromium");
  const devtoolsBackend = parseBrowserBackend(
    process.env.DEVTOOLS_BROWSER_BACKEND,
    defaultBackend
  );

  const browsers = [];
  const seen = new Set();

  // Default backend (does everything)
  if (!seen.has(defaultBackend)) {
    browsers.push({ name: defaultBackend, role: ["default"], index: 0 });
    seen.add(defaultBackend);
  }
  // Devtools backend
  if (!seen.has(devtoolsBackend)) {
    browsers.push({ name: devtoolsBackend, role: ["devtools"], index: browsers.length });
    seen.add(devtoolsBackend);
  }
  // Ensure Chromium is always present
  if (!browsers.some(b => b.name === "chromium")) {
    browsers.push({ name: "chromium", role: ["default"], index: browsers.length });
  }

  console.warn(
    "⚠️  BROWSERS env var not set. Using defaults. " +
    "Set BROWSERS to configure browsers explicitly."
  );

  return browsers;
}
```

**Key change from v1:** Default is now `chromium` (not `cloakbrowser`), since CloakBrowser is an add-on.

---

## 9. Example Configurations

### Minimal (built-in only)
```bash
BROWSERS='[
  {"name":"chromium","role":["default"],"index":0},
  {"name":"lightpanda","role":["search"],"index":0}
]'
```

### Lightpanda higher priority than Chromium for search
```bash
BROWSERS='[
  {"name":"lightpanda","role":["search"],"index":0},
  {"name":"chromium","role":["default"],"index":1}
]'
```

`web_search` tries: lightpanda (0) → chromium (1) as fallback

### With CloakBrowser add-on for search
```bash
BROWSERS='[
  {"name":"lightpanda","role":["search"],"index":0},
  {"name":"cloakbrowser","role":["search"],"index":1,"cdpUrl":"ws://127.0.0.1:9222","connect":"cloakbrowser"},
  {"name":"chromium","role":["default"],"index":2}
]'
```

`web_search` tries: lightpanda (0) → cloakbrowser (1) → chromium (2) as final fallback

### CloakBrowser as default (user runs it externally)
```bash
BROWSERS='[
  {"name":"cloakbrowser","role":["default"],"index":0,"cdpUrl":"ws://127.0.0.1:9222","connect":"cloakbrowser"},
  {"name":"lightpanda","role":["search"],"index":0}
]'
```

### 3 search browsers with priority order
```bash
BROWSERS='[
  {"name":"chromium","role":["default"],"index":0},
  {"name":"lightpanda","role":["search"],"index":0},
  {"name":"cloakbrowser","role":["search"],"index":1,"cdpUrl":"ws://127.0.0.1:9222","connect":"cloakbrowser"},
  {"name":"playwright","role":["search"],"index":2,"cdpUrl":"ws://127.0.0.1:9223","connect":"chromium"}
]'
```

`web_search` tries: lightpanda (0) → cloakbrowser (1) → playwright (2)

### Separate browsers for each role
```bash
BROWSERS='[
  {"name":"chromium","role":["fetch","screenshot"],"index":0},
  {"name":"lightpanda","role":["search"],"index":0},
  {"name":"cloakbrowser","role":["search"],"index":1,"cdpUrl":"ws://127.0.0.1:9222","connect":"cloakbrowser"},
  {"name":"playwright","role":["devtools"],"index":0,"cdpUrl":"ws://127.0.0.1:9223","connect":"chromium"}
]'
```

---

## 10. Resilience — The User Never Starves

The system must always provide results, even when browsers fail. The strategy: **degrade gracefully across three layers** — browser fallback, engine fallback, API fallback.

### Failure Scenarios and Responses

| Scenario | Impact | Response |
|----------|--------|----------|
| Add-on browser not running | Engine routes to it fail | Auto-reconnect + circuit breaker trips → other engines tried |
| Add-on browser crashes mid-operation | In-flight requests fail | `disconnected` event fires → state cleared → next request reconnects |
| Add-on browser hangs (not crashes) | Commands time out at `BROWSER_OP_TIMEOUT_MS` (60s) | Timeout error → circuit breaker trips → fallback engines |
| Built-in Chromium crashes | All Chromium routes fail | Navigator relaunches in-process (existing behavior) |
| Lightpanda crashes | Lightpanda routes fail | Navigator respawns or reconnects (existing behavior) |
| All browser engines down | No browser-based results | API engines (`duckduckgo_api`, `exa_api`, etc.) provide results |
| CDP URL changes (restart on different port) | Connection fails | Auto-reconnect tries the configured `cdpUrl` (user updates config) |
| `BROWSERS` JSON parse failure | Config invalid | Fall back to built-in defaults + log error |

### Layer 1: Auto-Reconnect (background health monitor)

A background `setInterval` runs every **10 seconds** and checks each add-on browser's connection:

```js
class AddOnHealthMonitor {
  constructor(manager, browsers) {
    this.manager = manager;
    this.browsers = browsers.filter(b => b.addOn);
    this.interval = null;
  }

  start() {
    this.interval = setInterval(() => this.check(), 10_000);
    this.interval.unref(); // don't block process exit
  }

  async check() {
    for (const entry of this.browsers) {
      const stateKey = `addon_${entry.name}`;
      const state = this.manager._backendState.get(stateKey);

      if (!state || !state.browser?.connected) {
        // Not connected — try to reconnect
        await this.reconnect(entry);
        continue;
      }

      // Connected — verify with lightweight CDP command
      try {
        await Promise.race([
          state.browser.version(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("health timeout")), 5000)
          )
        ]);
        // Healthy — update status
        state.lastHealthy = Date.now();
      } catch {
        // Unhealthy — disconnect and reconnect
        try { state.browser.disconnect(); } catch {}
        this.manager._backendState.delete(stateKey);
        await this.reconnect(entry);
      }
    }
  }

  async reconnect(entry) {
    try {
      const browser = await puppeteer.connect({
        browserWSEndpoint: entry.cdpUrl,
        defaultViewport: { width: 1920, height: 1080 },
      });

      this.manager._backendState.set(`addon_${entry.name}`, {
        browser,
        owned: false,
        connected: true,
        lastHealthy: Date.now(),
        reconnectCount: (this.manager._backendState.get(`addon_${entry.name}`)?.reconnectCount || 0) + 1,
      });

      browser.on("disconnected", () => {
        this.manager._backendState.delete(`addon_${entry.name}`);
      });

      console.log(`✅ Add-on "${entry.name}" reconnected to ${entry.cdpUrl}`);
    } catch (error) {
      // Browser still unavailable — will retry on next cycle
      console.log(`⚠️ Add-on "${entry.name}" unreachable (${entry.cdpUrl}): ${error.message}`);
    }
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
  }
}
```

**Key behaviors:**
- Runs every 10s in background, `.unref()` so it doesn't block process exit
- Lightweight health check: `browser.version()` (1 CDP command, fast)
- On failure: disconnect + reconnect to the same `cdpUrl`
- On success: update `lastHealthy` timestamp
- Logs reconnection attempts for debugging
- Tracks `reconnectCount` for monitoring

### Layer 2: Health-Aware Engine Routing

When selecting which search engine to use, **skip engines whose backend browser is unhealthy**:

```js
// In the engine selection logic (search.js)
function getAvailableEngines(config, engineHealth) {
  return config.searchEnabledEngines.filter(engine => {
    const meta = getEngineMetadata(engine);
    if (!meta || meta.backend === "api") return true; // API engines always available

    // Check if the browser backend is healthy
    const backendName = meta.backend;
    const addOn = config.browsers.find(b => b.addOn && b.connect === backendName);
    if (addOn) {
      const state = manager._backendState.get(`addon_${addOn.name}`);
      if (!state?.browser?.connected) return false; // Skip — browser down
    }
    return true;
  });
}
```

**This means:** If CloakBrowser is down, `duckduckgo_cb` is skipped. The system tries `duckduckgo_ch` (Chromium), `google_lp` (Lightpanda), or `duckduckgo_api` (no browser needed). The user still gets search results.

### Layer 3: Browser Fallback for web_fetch

If the primary browser (default role) is down, try another available browser:

```js
// In browserOpenAndExtract() (search.js)
async function browserOpenAndExtract(options) {
  const manager = await getBrowserManager();
  const defaultBackend = manager.config.defaultBackend;

  // Try default browser first
  try {
    const page = await manager.newPage({ backend: defaultBackend });
    return await extractFromPage(page, options);
  } catch (error) {
    if (!isConnectionError(error)) throw error;

    // Default browser down — try fallback
    console.log(`⚠️ Default browser "${defaultBackend}" unavailable, trying fallback...`);

    const fallbacks = manager.config.browsers
      .filter(b => b.name !== defaultBackend && !b.addOn) // try other built-ins first
      .concat(manager.config.browsers.filter(b => b.addOn)); // then add-ons

    for (const fallback of fallbacks) {
      try {
        const page = await manager.newPage({ backend: fallback.name });
        return await extractFromPage(page, options);
      } catch {
        continue; // try next fallback
      }
    }

    throw new Error(`All browsers unavailable. Default: ${defaultBackend}`);
  }
}
```

**This means:** If Chromium is down, `web_fetch` tries Lightpanda, then any add-on browser. The user gets the page content even if their preferred browser is unavailable.

### Layer 4: Circuit Breakers (existing + extended)

Navigator already has circuit breakers for search engine routes. Extend to **browser backends**:

| Circuit Breaker | Scope | Trip condition | Recovery |
|----------------|-------|---------------|----------|
| Search engine route | Per engine (existing) | N failures in time window | Auto-recovery after cooldown |
| Browser backend | Per browser name (new) | N connection failures | Auto-recovery after cooldown |
| Add-on browser | Per add-on name (new) | N health check failures | Auto-reconnect attempts |

When a browser backend's circuit breaker trips:
- Engines routed to that backend are skipped
- `web_fetch` falls back to other browsers
- Health check continues in background
- Circuit recovers when browser becomes available

### The Full Fallback Chain

```
User calls web_search("query")
  │
  ├─ Engine selection: pick best available engine
  │   ├─ Browser engines: check if backend is healthy
  │   │   ├─ duckduckgo_cb → CloakBrowser healthy? → use it
  │   │   ├─ duckduckgo_cb → CloakBrowser down? → skip
  │   │   ├─ google_lp → Lightpanda healthy? → use it
  │   │   └─ duckduckgo_ch → Chromium healthy? → use it
  │   └─ API engines: always available
  │       └─ duckduckgo_api → no browser needed → use it
  │
  ├─ Search executes on selected engine
  │   ├─ Success → return results
  │   └─ Failure → circuit breaker trips → try next engine
  │
  └─ Final fallback: API engine guaranteed to work
      └─ duckduckgo_api or exa_api → results returned

User calls web_fetch(url)
  │
  ├─ Try default browser
  │   ├─ Success → return extracted content
  │   └─ Failure (connection error) → try fallback
  │       ├─ Try other built-in browsers
  │       │   └─ Success → return extracted content
  │       ├─ Try add-on browsers
  │       │   └─ Success → return extracted content
  │       └─ All failed → return error with details
```

### Monitoring and Observability

The health endpoint exposes all resilience state:

```json
{
  "ok": true,
  "browsers": {
    "chromium": { "role": ["default"], "connected": true, "type": "builtin" },
    "lightpanda": { "role": ["search"], "connected": true, "type": "addon", "cdpUrl": "ws://lightpanda:9222" },
    "cloakbrowser": { "role": ["search"], "connected": true, "type": "addon", "cdpUrl": "ws://cloakbrowser:9222", "lastHealthy": 1693000000000 }
  },
  "circuitBreakers": {
    "duckduckgo": { "open": false, "failures": 0 },
    "google": { "open": false, "failures": 1 }
  },
  "addOnHealth": {
    "cloakbrowser": { "connected": true, "reconnectCount": 0, "lastHealthy": 1693000000000 }
  }
}
```

---

## 13. Risks

| Risk | Mitigation |
|------|-----------|
| Add-on browser not running when needed | Auto-reconnect (10s interval) + circuit breaker + engine fallback |
| Add-on browser crashes mid-operation | `disconnected` event + auto-reconnect + other engines provide results |
| Add-on browser hangs | `BROWSER_OP_TIMEOUT_MS` timeout + circuit breaker + fallback |
| CDP URL changes (user restarts on different port) | User updates `BROWSERS` config + restart, or auto-reconnect tries new URL |
| `BROWSERS` JSON parse failure | Fall back to built-in defaults + log error |
| Engine routing to down browser | Health-aware routing skips unhealthy backends |
| All browsers down | API engines (`duckduckgo_api`, `exa_api`) always work — no browser needed |
| Auto-reconnect loop (browser permanently down) | Exponential backoff on reconnect attempts, log warnings, don't spam |
| Docker image includes Lightpanda binary | Lightpanda is BSD-licensed, safe to ship. Can be made add-on too. |

---

## 14. Future Extensibility

Adding any CDP-compatible browser as an add-on requires **zero code changes**:

```bash
# Playwright's browser
BROWSERS='[
  {"name":"chromium","role":["default"]},
  {"name":"lightpanda","role":["search"]},
  {"name":"playwright","role":["devtools"],"cdpUrl":"ws://127.0.0.1:9222","connect":"chromium"}
]'
```

Adding a new **built-in** browser (with full lifecycle management) requires:
1. Create `XyzDriver` class in `src/browser.js`
2. Register in `BACKEND_DRIVERS` map
3. Add to `KNOWN_BACKENDS` in `src/engines/driver.js`
4. Add binary to Dockerfile
5. Set `BROWSERS='[...,{"name":"xyz","role":["search"]}]'`

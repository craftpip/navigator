# 57 — Per-Key MCP Browser Permissions (MCP vs CDP Browser Lists)

**Status:** Plan
**Created:** 2026-09-12
**Scope:** DB migration + server (`src/db.js`, `src/browser.js`, `src/mcp-server.js`, `src/search.js`, `src/devtools.js`, reuse `src/cdp-share.js` helpers) + console keys modal (`src/web-console/src/pages/keys/index.jsx` + `style.css`) + tests.

---

## Summary

API keys today have **two flat scopes**: `allowed_tools` (gates MCP tool *calls*) and `allowed_browsers` (gates only the raw-CDP endpoint `/cdp/<browser>?key=`). The MCP tools that accept a `browser` param (`web_fetch`, `web_page_screenshot`, `web_page_ascii`, `web_page_svg`, devtools `Target.createTarget`) are **not** restricted per-key — any key can route them to any browser (defaulting to chromium).

This plan adds a **second, independent browser list**: `allowed_mcp_browsers` — which browsers that key's **MCP tools** may drive. It is kept fully distinct from the **CDP browsers** list. The modal is restructured into two sections:

```
Access permissions
├── MCP permissions          (new grouping)
│   ├── Tools allowed        (existing `allowed_tools`)
│   └── Browsers allowed     (NEW `allowed_mcp_browsers`)
└── CDP permissions          (relabeled "Browser CDP access")
    └── Browsers allowed     (existing `allowed_browsers` — unchanged behavior)
```

User decisions (2026-09-12):
1. MCP browsers selection = a **checkbox list of browsers** (not a count), independent from the CDP list. A key may grant browsers `[A, B]` for CDP but `[B, C]` for MCP.
2. CDP has **no tools** — the CDP section stays browsers-only, exactly as today.

---

## 1. Current Behavior

*Source: `api_keys` schema `src/db.js:56-66,130`; key handlers `src/mcp-server.js:610-686` + payload `549-577`; tool-gate `src/mcp-server.js:2140-2152`; CDP gate `src/cdp-share.js:97-142`; modal `src/web-console/src/pages/keys/index.jsx`.*

- **`api_keys`**: `{ id, name, secret UNIQUE, created_at, allowed_tools, allowed_browsers }`. Both permission columns are JSON arrays or `NULL` (= all). CRUD in `src/db.js:229-260`.
- **`allowed_tools`** is enforced at the MCP dispatch gate — `handleToolCall(name, args, allowedTools)` throws `Tool "X" is not permitted for this API key` (`src/mcp-server.js:2142`). The set is built per-request by `getAllowedToolsForRequest` (`src/mcp-server.js:539-547`), shared by the session path (`3188`) and the stateless path (`3250`).
- **`allowed_browsers`** is enforced only in `src/cdp-share.js` — `checkBrowserAccess(record, browserName)` (`:120-125`) at the `/cdp/<name>$?key=` WebSocket upgrade (`:386-389`). NULL = all; exact name match otherwise.
- **Browser-resolution call sites that are NOT per-key gated today** (each resolves via `resolveBrowserParam`, `src/browser.js:1557-1605`):
  | Call site | Tool | Location |
  |---|---|---|
  | `operation.openPage` → `resolveBrowserParam` | `web_fetch` | `src/search.js:2215` |
  | `browserCaptureScreenshot` → `resolveBrowserParam` | `web_page_screenshot` | `src/search.js:2488` |
  | inline handler → `resolveBrowserParam` | `web_page_ascii` | `src/mcp-server.js:2539` |
  | batch handler → `resolveBrowserParam` | `web_page_svg` | `src/mcp-server.js:2766` |
  | `createTarget` → `resolveBrowserParam` | devtools `Target.createTarget` | `src/devtools.js:594` |
- **Modal** (`keys/index.jsx`): one flat `Access permissions` block with two `<details>` — `api-key-tools` (Check-per-tool, `:187-209`) and `api-key-browsers` (Check-per-browser from `payload.browsers` + connected dot, `:210-238`). State: `allowedTools` + `allowedBrowsers` (`:26-27`). Create seeds tools = all (`:59`), browsers = none (`:60`). Actions `create` / `set_tools` / `set_browsers` (`src/mcp-server.js:612-675`).
- The internal **"Web Tools UI" console key** (`ensureConsoleToolsApiKey`, `src/mcp-server.js:601-608`) and legacy `MCP_API_KEYS` imports are unrestricted (`allowed_*` NULL) — this is a deliberate all-access decision (plan 55 §7.1–7.2).

---

## 2. Design

### 2.1 Data model — `allowed_mcp_browsers`

One new column, symmetric to `allowed_browsers`:

```sql
ALTER TABLE api_keys ADD COLUMN allowed_mcp_browsers TEXT;   -- JSON array | NULL
```

- `NULL` = key's MCP tools may use **any** browser (current behavior; every existing key stays unrestricted — no migration rewrite needed).
- `[]` = no browser may be used by MCP tools.
- `["cloakbrowser", "chromium"]` = MCP tools restricted to exactly those.
- Reuse `parseAllowedBrowsers` (`src/cdp-share.js:34-42`) — it is already a generic JSON-array parse (`parseAllowedBrowsers(key.allowed_mcp_browsers)`). It reads the column name from the caller, so no rename needed; import it into `src/mcp-server.js` (mcp-server already imports `parseAllowedBrowsers` from `./cdp-share.js`? — verify; if not, add to the existing `./cdp-share.js` import at `src/mcp-server.js:25-26`).

### 2.2 Server payload + key handlers (`src/mcp-server.js`)

- `getConsoleApiKeysPayload` (`:549-577`) — per key add `allowedMcpBrowsers: parseAllowedBrowsers(key.allowed_mcp_browsers)`. (Reuse the existing `browsers` array for the checkbox list — same pool of shareable browsers, independent selection.)
- `handleConsoleApiKeys`:
  - `create` (`:612-629`) — accept `allowedMcpBrowsers` filtered against `listShareableBrowserNames(manager)` (unknown names dropped, mirror `allowedBrowsers` at `:622-625`).
  - new action `set_mcp_browsers` → `setMcpApiKeyMcpBrowsers(id, names)` (mirror `set_browsers` at `:665-675`).
- `ensureConsoleToolsApiKey` — stays unrestricted (`allowed_mcp_browsers` NULL), same all-access rationale as CDP (plan 55 §7.1).

### 2.3 The gate — inside `resolveBrowserParam` (one place, one representation)

Extend `resolveBrowserParam(args, config, manager, opts)` (`src/browser.js:1557`) with `opts.allowedMcpBrowsers` (a `Set` of names, or `null` = unrestricted). Two checks:

1. **Fast-path pre-check** (explicit `browser` arg, before any connect): if `allowedMcpBrowsers` is set and the explicit name is not in it → throw
   `Browser "<name>" is not permitted for this API key (allowed MCP browsers: <list>)`.
2. **Post-resolve check** (covers the default/rollback case where `browser` was omitted and the chain landed somewhere): after resolution, if the set is non-null and the resolved browser name is not in it → throw the same error.

The default-resolution chain (`:1590-1604`) is **not** modified — an omitted param still tries add-ons then falls back to chromium, and the post-check then enforces the result. Decisions:
- A restricted key omitting `browser` that would land on a disallowed browser gets a clear error telling it to pass an allowed name. (Alternative — constraining the fallback chain itself to the allowed set — is noted as a future nicety, not in scope: it complicates the chain and changes resolution semantics for an edge case.)
- Enforcement therefore lives in **one** function; the five call sites in §1.3 only need the set threaded to their `resolveBrowserParam` call.

### 2.4 Request plumbing (session + stateless)

- New `getAllowedMcpBrowsersForRequest(headers, config)` mirroring `getAllowedToolsForRequest` (`src/mcp-server.js:539-547`): `CONSOLE_API_KEY` or no authorized key → `null`; else read `record.allowed_mcp_browsers` → `null` (all) or `new Set(parseAllowedBrowsers(...))`.
- Thread `allowedMcpBrowsers` alongside `allowedTools`:
  - `handleToolCall(name, args, allowedTools, allowedMcpBrowsers)` (`:2140`) → `handleToolCallInner(name, args, allowedMcpBrowsers)` (`:2154`).
  - Session MCP: `createMcpServer(allowedTools, allowedMcpBrowsers)` (`:3053`), wired at `:3188` (server factory `createMcpServer` closure passes the set into the `CallToolRequestSchema` handler at `:3084`).
  - Stateless: `handleStatelessMcpPost(body, allowedTools, allowedMcpBrowsers)` (`:2994`) → passed into `handleToolCall` at `:3024`.
  - Devtools: `handleDevtoolsToolCall(name, args, allowedMcpBrowsers)` (signature change at `src/devtools.js:2566`) — called from `mcp-server.js:2961` — `createTarget` forwards the set into its `resolveBrowserParam` opts (`devtools.js:594`).
- Handler wiring (each site in §1.3 receives the set):
  - `web_fetch`: `handleToolCallInner` → `openTargetsParallel(..., opts)` (`mcp-server.js:2237`) → `browserOpenAndExtract({ ..., allowedMcpBrowsers })` (`src/search.js:2093`) → `resolveBrowserParam` call (`:2215`).
  - `web_page_screenshot`: `browserCaptureScreenshot({ ..., allowedMcpBrowsers })` (`src/search.js:2467`) → `resolveBrowserParam` (`:2488`).
  - `web_page_ascii` (`:2539`) and `web_page_svg` (`:2766`): pass `opts.allowedMcpBrowsers` into `resolveBrowserParam`.
  - devtools `Target.createTarget` (`devtools.js:594`).

### 2.5 Console modal (`keys/index.jsx` + `style.css`)

**Layout** — two top-level `<details>` inside `.api-key-permissions-field` (`:185`):

1. **`details.api-key-permissions` "MCP permissions"** (open by default):
   - Group A — **Tools allowed**: the existing `api-key-tools` group, moved intact (`:187-209`).
   - Group B — **Browsers allowed** (NEW): a `api-key-mcp-browsers` group listing `payload.browsers` as Check rows (name + type + connected dot), with `Allow all` / `Clear all` (mirror `:210-238`).
   - Summary: `All tools · All MCP browsers allowed` / `N tools · M of X MCP browsers` (tools count + browser count).
2. **`details.api-key-cdp-permissions` "CDP permissions"**:
   - Group — **Browsers allowed**: the existing `api-key-browsers` group moved here (`:210-238`), summary unchanged (`N of M CDP browsers allowed`), note text unchanged (drives `/cdp/<browser>?key=`; relay = user's real window).

**State/handlers** (mirror the existing patterns):
- `const [allowedMcpBrowsers, setAllowedMcpBrowsers] = useState([])` — alongside the two existing states.
- `load()` (`:32-42`) seeds `allowedMcpBrowsers` from `payload.browsers.map(b => b.name)`.
- `openCreate` (`:57-64`) seeds tools = all (current), **MCP browsers = all** (NEW default — see §5.4; keeps the key fully functional out of the box, matching the tools default), CDP browsers = none (current).
- `openEdit` (`:65-72`) seeds MCP browsers `key.allowedMcpBrowsers == null ? allBrowsers() : key.allowedMcpBrowsers`.
- New `toggleMcpBrowser`, `sameMcpBrowsers` (clone of `sameBrowsers`, `:13-17`).
- Save (`:76-115`): create posts `{ allowedTools, allowedMcpBrowsers, allowedBrowsers }`; edit posts `set_tools` / `set_mcp_browsers` / `set_browsers` each only when its selection changed.

**Key list Access cell (`:295-298`)** — three stacked `<small>` lines:
`MCP: N tools · M browsers` / `CDP: K browsers` (NULL renders `all`). Widen the column in `style.css` (~140px; the mobile media query already hides it).

**Secret reveal (`:258-276`)** — unchanged: per-CDP-browser `ws://…/cdp/<browser>?key=…` URLs. No MCP URL to show (MCP tools are called with a `browser` param, not a URL).

**CSS**: `.api-key-permissions` / `.api-key-cdp-permissions` (secondary section headers), `.api-key-mcp-browser-items` (reuse `.api-key-browser-items` grid), access-column widening.

---

## 3. Tests & Verification

- **`tests/mcp-server.test.js`** (keys coverage): payload carries `allowedMcpBrowsers` per key; `create` with `allowedMcpBrowsers` round-trips; `set_mcp_browsers` replaces; unknown browser names dropped; legacy keys keep `null` (unrestricted).
- **`tests/browser.test.js`**: `resolveBrowserParam` with `opts.allowedMcpBrowsers` — allowed name passes, disallowed explicit name throws *before* connecting (fast path), omitted param landing on a disallowed default throws post-resolve.
- **`tests/devtools.test.js`**: `Target.createTarget` with a restricted key + disallowed `browser` → permission error.
- **`tests/cdp-share.test.js`**: unchanged behavior — `allowed_browsers` still gates `/cdp/*`; `allowed_mcp_browsers` has no effect on the CDP gate (regression guard).
- **Manual e2e (in-container)**:
  1. `docker compose build && docker compose up -d` (schema change).
  2. Create a key granting only `cloakbrowser` under **MCP permissions** browsers (and CDP browsers too, for step 4).
  3. `web_fetch` via MCP with `browser: "chromium"` → error `not permitted`; with `browser: "cloakbrowser"` → success. Same for `web_page_screenshot` and devtools `Target.createTarget`.
  4. `/cdp/cloakbrowser?key=<key>` still connects; `/cdp/chromium?key=<key>` → 403 (proves the two lists stayed separate).
  5. Console modal shows the two sections; saving produces exactly the posted `set_mcp_browsers` on change and nothing otherwise.

---

## 4. Edge Cases & Invariants

1. **`NULL` = all, `[]` = none, array = exact list** — identical semantics to `allowed_browsers`. Existing keys are `NULL` → zero behavior change until edited.
2. **Console key / `CONSOLE_API_KEY` / legacy `MCP_API_KEYS`** — unrestricted MCP browsers (`NULL`), matching their all-access CDP status (plan 55 §7.1–7.2). The console itself is unaffected.
3. **`MCP_ALLOW_UNAUTHENTICATED=1`** — a request with no key resolves `getAllowedMcpBrowsersForRequest` → `null` → fully open, same as tools today.
4. **Create default = all MCP browsers** (unlike CDP's none). Rationale: tools default to all on create (`keys/index.jsx:59`), and an empty MCP browser list makes the key's web tools unusable — a footgun, not a security boundary. The admin can still clear the list to produce `[]` deliberately.
5. **Restricted key + omitted `browser` param** → default chain resolves (usually chromium); if the default isn't in the set, the call errors with a hint to pass an allowed browser name.
6. **targetId-level devtools bypass (known gap, out of scope):** devtools calls that address an existing `targetId` (`Runtime.evaluate`, `DOM.*`, `Input.*`, …) never re-resolve a browser, so a restricted key could address a targetId listed by `Target.getTargets` on a browser outside its MCP list. Enforcement covers the browser-**resolution** points (createTarget + the four web tools). Closing the gap would mean tracking target-ownership per key — deferred; documented here so the limitation is explicit.
7. **Stale browser names** in `allowed_mcp_browsers` (browser removed from config) → `resolveBrowserParam` throws the existing `unknown browser "<name>"` — a 4xx-style refusal, not a permission widening. No cleanup migration.

---

## 5. Files Touched

| File | Change |
|---|---|
| `src/db.js` | migration index 13 (`allowed_mcp_browsers`), SELECT/INSERT in `listMcpApiKeys`/`createMcpApiKey`, new `setMcpApiKeyMcpBrowsers` |
| `src/mcp-server.js` | `getAllowedMcpBrowsersForRequest`; `allowedMcpBrowsers` on payload + `create`/`set_mcp_browsers`; thread set through `handleToolCall`/`handleToolCallInner`, session + stateless, `web_page_ascii`/`web_page_svg` resolve calls |
| `src/search.js` | `allowedMcpBrowsers` param on `browserOpenAndExtract` + `browserCaptureScreenshot`, forwarded to `resolveBrowserParam` |
| `src/devtools.js` | `handleDevtoolsToolCall(name, args, allowedMcpBrowsers)`; `createTarget` forwards to `resolveBrowserParam` opts |
| `src/browser.js` | `resolveBrowserParam` — `opts.allowedMcpBrowsers` fast-path + post-resolve checks |
| `src/web-console/src/pages/keys/index.jsx` | MCP permissions section (tools + new browser list), CDP permissions section (existing list moved); new state/handlers/save paths; access-cell third line |
| `src/web-console/src/style.css` | section headers, mcp-browser grid reuses, access-column width |
| `tests/mcp-server.test.js`, `tests/browser.test.js`, `tests/devtools.test.js`, `tests/cdp-share.test.js` | per §3 |
# 57 — Per-Key MCP Browser Permissions (MCP vs CDP Browser Lists)

**Status:** Complete — validated 2026-09-30. Every functional requirement ships and was re-verified end-to-end: the `allowed_mcp_browsers` column + migration, the single enforcement point inside `resolveBrowserParam`, all five browser-resolution call sites threaded, the console modal's third permission group, and the four test files §3 asked for. Live proof on the running server (temporary key, MCP + CDP lists `["cloakbrowser"]`): `web_fetch`/`web_page_screenshot`/`web_page_svg`/`Target.createTarget` on `chromium` → `browser "chromium" is not permitted for this API key`, same calls on `cloakbrowser` → success; `/cdp/cloakbrowser?key=` upgraded `101` while `/cdp/chromium` and `/cdp/lightpanda` → `403` (the two lists stayed independent); `set_mcp_browsers([])` left the CDP list untouched. Full suite 756 pass / 1 pre-existing plan-37 SVG failure / 1 known jsdom-harness suite error — the documented baseline. Implementation was already written and uncommitted in the working tree; validation did not change code. 8 discrepancies recorded in §6.2, none blocking.
**Created:** 2026-09-12
**Scope:** DB migration + server (`src/db.js`, `src/browser.js`, `src/mcp-server.js`, `src/search.js`, `src/devtools.js`, reuse `src/cdp-share.js` helpers) + console keys modal (`src/web-console/src/pages/keys/index.jsx` + `style.css`) + tests.

**Progress:**

- [x] 1. §2.1 Data model — `allowed_mcp_browsers` column + migration, `NULL`/`[]`/array semantics
- [x] 2. §2.2 Server payload + key handlers (`allowedMcpBrowsers` on payload, `create`, `set_mcp_browsers`)
- [x] 3. §2.3 Gate inside `resolveBrowserParam` (fast-path + post-resolve)
- [x] 4. §2.4 Request plumbing (session + stateless + devtools + 5 call sites)
- [x] 5. §2.5 Console modal (new browser group, state, save paths, access cell)
- [x] 6. §3 Tests — `tests/mcp-server.test.js`, `tests/browser.test.js`, `tests/devtools.test.js`, `tests/cdp-share.test.js`
- [x] 7. §3 Manual e2e on the live server (steps 2–5; step 1 deploy already done — see §6.1)
- [x] 8. Absorbed into `docs/api/mcp-and-http.md`, `docs/architecture/browser-runtime.md`, `docs/reference/browsers/cdp-sharing.md`

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
| `src/db.js` | migration index 13 at authoring time — landed as the last entry, index 17 (`src/db.js:153`); SELECT/INSERT in `listMcpApiKeys`/`createMcpApiKey`, new `setMcpApiKeyMcpBrowsers` |
| `src/mcp-server.js` | `getAllowedMcpBrowsersForRequest`; `allowedMcpBrowsers` on payload + `create`/`set_mcp_browsers`; thread set through `handleToolCall`/`handleToolCallInner`, session + stateless, `web_page_ascii`/`web_page_svg` resolve calls |
| `src/search.js` | `allowedMcpBrowsers` param on `browserOpenAndExtract` + `browserCaptureScreenshot`, forwarded to `resolveBrowserParam` |
| `src/devtools.js` | `handleDevtoolsToolCall(name, args, allowedMcpBrowsers)`; `createTarget` forwards to `resolveBrowserParam` opts |
| `src/browser.js` | `resolveBrowserParam` — `opts.allowedMcpBrowsers` fast-path + post-resolve checks |
| `src/web-console/src/pages/keys/index.jsx` | MCP browser group added as a third `<details>` next to tools + CDP browsers; new state/handlers/save paths; access-cell third line |
| `src/web-console/src/style.css` | shared `.api-key-browser-items` grid reused for the MCP list; no new selectors |
| `tests/mcp-server.test.js`, `tests/browser.test.js`, `tests/devtools.test.js`, `tests/cdp-share.test.js` | per §3 |

---

## 6. Validation (2026-09-30)

### 6.1 What was verified

**Implementation already present** in the working tree (uncommitted) — validation read it against every section and re-ran the plan's own checks. No code was changed by this pass.

| Plan section | Verified as |
|---|---|
| §2.1 data model | `src/db.js:12` shared `API_KEY_COLUMNS`, migration `src/db.js:153` (`ALTER TABLE api_keys ADD COLUMN allowed_mcp_browsers TEXT`), `createMcpApiKey` `:328`, `setMcpApiKeyMcpBrowsers` `:357`, `parseAllowedBrowsers` reused as planned (`src/cdp-share.js:34`), already imported at `src/mcp-server.js:19` — §2.1's "verify the import" note resolves to yes |
| §2.2 payload + handlers | payload per key `src/mcp-server.js:630`; `create` filters unknown names `:684-687`; `set_mcp_browsers` `:738-744`; console key left `NULL` |
| §2.3 the gate | `src/browser.js:1762-1828` — one enforcement point: explicit-name fast path `:1776`, chain post-check `:1814-1819`, chromium fallback check `:1828` |
| §2.4 plumbing | `getAllowedMcpBrowsersForRequest` `:594` (lower-cases names); `handleToolCall` `:2460` → `handleToolCallInner` `:2474`; devtools `:3447`; stateless `:3480`/`:3510`; `createMcpServer` `:3539`/`:3570`; per-request wiring `:3675`/`:3711`/`:3739`. Five call sites: `src/search.js:2372` (web_fetch), `src/search.js:2722` (screenshot), `src/mcp-server.js:3019` (ascii), `:3244` (svg), `src/devtools.js:733` (createTarget) |
| §2.5 console modal | `src/web-console/src/pages/keys/index.jsx` — state `:29`, load seed `:47`, create defaults (MCP all / CDP none) `:75-78`, edit seed `:88`, save order `:113-127`, three `<details>` `:238` (CDP) and `:267` (MCP), access cell `:355` |
| §3 tests | `tests/mcp-server.test.js:447,500,1441`, `tests/browser.test.js:474`, `tests/devtools.test.js:297`, `tests/cdp-share.test.js:114` — **237/237 pass** across the four files |
| §4 invariants | 1,2,3,4,6,7 hold as written (verified live for 1/2/4/7; §4.6 gap confirmed still open and accurately described) |

**Live e2e on the running server** (`http://10.69.1.164:1994`, no rebuild needed — the container already ran this code). Two throwaway keys created through `/console/api-keys` and revoked afterwards; `keys` list back to `xdl, Web Tools UI, opencode-cli, mist`.

| §3 step | Result |
|---|---|
| 2 — key with MCP + CDP browsers `["cloakbrowser","no-such-browser"]` | `no-such-browser` dropped on write; payload returned `["cloakbrowser"]` |
| 3 — `web_fetch` `chromium` / `cloakbrowser` / omitted | `browser "chromium" is not permitted for this API key (allowed MCP browsers: cloakbrowser)` / success `Browser: cloakbrowser` / success (`cloakbrowser` is first in the chain — §4.5's clear error is the expected path when the default lands off-list) |
| 3 — `web_page_screenshot` `chromium` / `cloakbrowser` | same refusal / success with JPEG |
| 3 — `web_page_svg` `chromium` / `cloakbrowser` | same refusal / success |
| 3 — `Target.createTarget` `chromium` / `cloakbrowser` | MCP tool error `isError: true` / target created on `cloakbrowser` |
| 3 — `web_page_ascii` | could not be exercised: `.env:15` sets `DISABLE_TOOLS=web_page_ascii,DOM.getCompactHTML`, so the tool is not advertised and the key's tool list can never contain it. Its gate is the same `resolveBrowserParam({ allowedMcpBrowsers })` call shape as `web_page_svg` (verified live) and is covered by `tests/browser.test.js:474` |
| 4 — CDP independence | `/cdp/cloakbrowser?key=` → `101` upgrade; `/cdp/chromium` → `403`; `/cdp/lightpanda` → `403` |
| 5 — modal + save | third group renders and persists; `set_mcp_browsers([])` left `allowedBrowsers` at `["cloakbrowser"]`, both MCP names then refused (`allowed MCP browsers: none`), and `/cdp/cloakbrowser` still upgraded afterwards |

**Suite / lint.** Full `npx vitest run`: **756 pass, 1 fail, 2 failed files** — the failure is the pre-existing plan-37 SVG tspan case and the second file is the known broken jsdom harness (`tests/modal-dismiss.test.jsx`), i.e. exactly the baseline recorded by the plan 51/55/56 validations. `npm run lint` reports 68 pre-existing errors repo-wide (see §6.2 #5 for the one this plan added).

### 6.2 Discrepancies — recorded, not fixed

1. **§5 migration index is wrong (harmless).** It says "migration index 13"; the array holds 18 entries and the column landed last, at index 17 (`src/db.js:153`). Index 13 is `allowed_browsers`. Edited in place in §5.
2. **§2.5 modal layout was not built as specified.** The plan called for two *grouped* sections — `details.api-key-permissions` "MCP permissions" containing the tools group + the new browser group, and `details.api-key-cdp-permissions` "CDP permissions". What shipped is three flat, open-by-default `<details>`: tools, CDP browsers, MCP browsers — and **both browser sections carry the same `className="api-key-browsers"`** (`keys/index.jsx:238` and `:267`), so the CSS added in §5 for `.api-key-permissions`/`.api-key-cdp-permissions` was never needed and does not exist. Functionally equivalent and arguably simpler; the CDP-vs-MCP distinction survives only through the summary text and the note under the MCP list ("Independent of the CDP list above"). Anyone re-reading §2.5 will expect two nested groups that aren't there.
3. **Access-cell format differs from §2.5.** Plan: two stacked lines, `MCP: N tools · M browsers` / `CDP: K browsers`. Shipped: three stacked `<span>`s — `all tools`/`N tools`, `all CDP browsers`/`N CDP browsers`, `all MCP browsers`/`N MCP browsers` (`keys/index.jsx:355`). Same information, different shape.
4. **A mechanism the plan never mentions is load-bearing: restricted keys bypass the `web_fetch` result cache entirely** (`src/mcp-server.js:2570`, `const cacheable = !allowedMcpBrowsers` — skips both read and write). The cache key is derived from request args and carries no API-key identity, so an entry another key fetched on a browser this key may not use would be served before `resolveBrowserParam` ever runs, making the permission check unreachable. The fix is correct but has a real cost (no cache hit or reuse for any restricted key) and no §4 invariant records it. Covered by `tests/mcp-server.test.js:1441`.
5. **One new lint error from this plan's tests.** `tests/mcp-server.test.js:1446` imports `dbMod` and never uses it. The repo lint baseline is already dirty (68 errors), but this one is attributable to plan 57.
6. **Refusal message is lower-cased.** Plan: `Browser "<name>" is not permitted …`; code: `browser "<name>" is not permitted for this API key (allowed MCP browsers: <list>|none)` (`src/browser.js:1768`), matching the style of the neighbouring `unknown browser "…"` / `browser "…" is <status>` messages.
7. **The gate is stricter than §2.3 specified, in two good ways.** In the default chain the code closes the just-opened page before refusing (`src/browser.js:1814-1818`) so a denied key cannot leave a live page — or a visible tab on the user's relay window — behind, and it re-throws a permission refusal instead of recording it as a rollback note and falling through (`:1824`). Neither is in the plan; both are correct.
8. **Every §1 source reference is stale.** The plan cites pre-change coordinates (e.g. the tool gate `mcp-server.js:2140` is now `:2460`; `resolveBrowserParam` `browser.js:1557` is now `:1754`; `createTarget` `devtools.js:594` is now `:682`; `db.js:130` is `:136`). Harmless for a shipped feature, misleading for anyone using §1 to navigate. §6.1 carries the current coordinates.

**Not verified:** §3 step 1 (`docker compose build && docker compose up -d`) was unnecessary — no new dependency, and the console bundle in `src/web-console/dist` was already built with the new modal, which the live payload and §3 step 5 confirm.
# 55 — CDP URL Sharing for API Keys (BrowserStack-style Browser Access)

**Status:** Implemented — host-verified and container-verified (2026-09-12): `vitest run tests/cdp-share.test.js tests/mcp-server.test.js` = 109/109 pass; console `vite build` clean; full suite 629 pass / 2 pre-existing failures (`tests/devtools.test.js`, `tests/svg.test.js` — both fail at HEAD too, unrelated). Live-Chromium `puppeteer.connect` e2e PASSED in-container (2026-09-12): inbuilt shared chromium (Chrome 152 → newPage/goto/title/disconnect), plain-cdp cloakbrowser (Chrome 146), navigator-cdp relay (`macbook chrome`, key `xdl`, already connected from the user's host — live production use of the shared endpoint); negative gates verified — 401 bad key, 403 browser not granted, 404 unknown browser; `GET /cdp` discovery (Bearer) 200; `counters.cdpConnections` +1 per accepted upgrade; audit rows land in `mcp_calls` source `cdp`.
>
> **Pre-existing bug found (not introduced by 55, left for user decision):** revoking any API key that has `mcp_calls` rows fails with `FOREIGN KEY constraint failed` — `mcp_calls.api_key_id REFERENCES api_keys(id)` (commit 0a71786) has no `ON DELETE` and key ids are written for every MCP call. The console Revoke button is affected for all used keys.
**Created:** 2026-09-11
**Implemented:** 2026-09-11
**Scope:** DB migration + server (`src/db.js`, `src/mcp-server.js`, new `src/cdp-share.js`, `src/relay-server.js`, `src/browser.js`, `src/config.js` + `config-schema.js`) + console keys modal (`src/web-console/src/pages/keys/index.jsx` + `style.css`). No change to the MCP tool surface — this is a raw CDP endpoint served by the existing HTTP server.

---

## Summary

Share the configured browsers as **CDP WebSocket endpoints** gated by the existing API-key system, BrowserStack-style. In the API-key modal add a **Browser CDP access** checkbox section listing the browsers the server has; each key is granted access to a specific subset. External clients connect like BrowserStack Puppeteer:

```js
const browser = await puppeteer.connect({
  browserWSEndpoint: `ws://<api-host>:1994/cdp/<browserName>?key=${API_KEY}`,
});
```

Three requirements, in order:

1. **Per-key browser access** — `api_keys` gains an `allowed_browsers` column (section 3.3), `NULL` = all browsers, array = scoped subset. Mirrors the existing `allowed_tools` model exactly (NULL = unrestricted, anything else = explicit restriction).
2. **Modal UI** — the keys modal gets a "Browser CDP access" group: a checkbox list of the server's browsers with Allow all / Clear all (section 3.5).
3. **CDP URL endpoint** — `GET /cdp/<browserName>?key=<AI_KEY>` → authenticated WebSocket proxy to that browser, consumable by `puppeteer.connect`, `chrome-remote-interface`, or any raw CDP client (section 3.2).

---

## 1. Current Behavior

*Source: `src/db.js:56-66` (api_keys schema), `src/mcp-server.js:515-654` (key handlers + payload), `src/relay-server.js:314-344` (upgrade dispatch) + `701-1073` (gateway), `src/browser.js:1490-1538` (browser resolution), `src/web-console/src/pages/keys/index.jsx` (modal).*

- **API keys** (`api_keys` table): `{ id, name, secret UNIQUE, created_at, allowed_tools }`. `allowed_tools` JSON array or `NULL` (= all tools). CRUD in `src/db.js:228-247`; console actions in `handleConsoleApiKeys` (`src/mcp-server.js:594-654`).
- **Tools access UI**: the keys modal (`keys/index.jsx:130-183`) has a "Tool access" `<details>` with per-tool checkboxes built from `toolGroups` (web/dev) in the `/console/api-keys` payload (`getConsoleApiKeysPayload`, `src/mcp-server.js:548-561`). Nothing else is scoped today.
- **Browsers**: `BROWSERS` env → `config.browsers` (`src/config.js:170-323`). Live routing source is `BrowserManager._effectiveAddOns()` (`src/browser.js:571-573`) = `relayServer.getStatusEntries(config.browsers)` — configured `inbuilt`/`cdp`/`navigator-cdp` entries plus dynamic relay registrations. Browser health (names/roles/types/status/connected) is already available via `manager.getHealth()` (`src/browser.js:1033-1125`).
- **Existing CDP gateway**: `/browser/<name>` (`src/relay-server.js:326-344`) is a **pure-CDP WebSocket only for connected navigator-cdp (relay) browsers** — the in-process puppeteer dials it (`_ensureAddOnConnection`, `src/browser.js:635-680`). It has **no auth** and is trust-bound to the local process. It does NOT serve built-in Chromium or plain `cdp` add-ons.
- **BrowserStack model**: `wss://cdp.browserstack.com/puppeteer?caps=<url-encoded-json>` — credentials embedded in the WebSocket URL, `puppeteer.connect({ browserWSEndpoint })` works verbatim. We follow the same consumer contract with `?key=`.

---

## 2. Design

### 2.1 URL contract

```
ws://<api-host>:<api-port>/cdp/<browserName>?key=<API_KEY>
```

- `<browserName>` — URL-encoded browser name from the BROWSERS config or a paired relay name (e.g. `cloakbrowser`, `maclap2`).
- `key` — the API key whose `allowed_browsers` includes that name. Also accepted via `Authorization: Bearer <key>` or `x-api-key` **header** (so secrets stay out of logs/proxies when the caller can set headers; `puppeteer.connect` supports per-connection `headers`). Query param wins over headers when both present; the key must match exactly one `api_keys.secret`.
- The endpoint speaks **browser-level CDP** (responds to `Target.getTargets`, `Target.setDiscoverTargets`, `Target.attachToTarget`, `Target.createTarget`, …), so `puppeteer.connect`, `puppeteer-core.connect`, raw CDP (`chrome-remote-interface`), and DevTools protocol tooling all work.

**Security invariant — CDP is never unauthenticated:** even when `MCP_ALLOW_UNAUTHENTICATED=1` (the default, `src/config.js:465`), CDP sharing **always requires a valid API key** with access to the requested browser. There is no "open access" mode for CDP. Internal console keys (`CONSOLE_API_KEY` / "Web Tools UI") are accepted with full access — their secrets are server-generated and never exposed, so this is safe (§7.1).

### 2.2 Auth + access check (one gate, fails closed)

On WebSocket upgrade to `/cdp/<name>`:

1. Extract key (query param → Bearer header → `x-api-key`). Missing/malformed → HTTP 401.
2. Constant-time match against `manager.config.mcpApiKeys` (the live secret list, `src/mcp-server.js:563-566`). No match → 401.
3. Load the DB record by exact secret. Unknown/revoked → 401 (revoking a key kills every live + future CDP session for it).
4. Access check: `allowed_browsers == NULL` (all) **or** `allowed_browsers` includes `<name>` (exact match). Denied → HTTP 403.
5. Browser resolution: name must be a configured/effective browser (see 2.3). Unknown → 404.
6. Only then is the socket upgraded and proxied. `recordMcpCall`-style audit row with `source: 'cdp'` (section 3.6).

### 2.3 Transport matrix — what each `/cdp/<name>` proxy actually drives

| Browser type | `/cdp/<name>` behavior | Ownership of the spawned/driven browser |
|---|---|---|
| `navigator-cdp` (relay: Firefox, chrome-extension bridges, user's real window) | Attach the external client into the **existing extension gateway** — reuse `relayServer._handleGateway` machinery (`src/relay-server.js:701-1073`), registered as another client in `entry.clients`. Full tab lifecycle, `Target.createTarget`, adoption all work via the extension. | Extension-owned (never closed by us) |
| `cdp` add-on (cloakbrowser, lightpanda) | Open a **dedicated second CDP connection** to the entry's `cdpUrl` (same ws/http logic as `_ensureAddOnConnection`, `src/browser.js:635-680`) and **duplex-pipe frames** between the external socket and that underlying socket. Command/event correlation is handled by the upstream browser, which natively multiplexes multiple clients. | Add-on-owned → on close, `disconnect` only |
| `inbuilt` (built-in Chromium — navigator's own workhorse) | Do **not** expose navigator's shared internal instance (external clients could see/close Navigator's own search/fetch tabs and its `wsEndpoint` is internal). Instead `BrowserManager.createSharedBrowser()` launches a **fresh, dedicated Chromium** per external connection (same flags as `launchBrowser`, `src/browser.js:439-451`), and the proxy pipes to its `browser.wsEndpoint()`. | Navigator-owned → on close, `browser.close()` (kills the per-session instance) |

Rationale: "share the browsers we have" is honored for every type; agent-owned built-in Chromium gets per-session isolation (BrowserStack-like), while real visible browsers (relay) and dedicated sidecars (`cdp`) are shared directly. Lightpanda's single-tab limitation applies as-is.

### 2.4 The proxy (duplex pipe) — one file, no multiplexing

Per external connection, `src/cdp-share.js` opens exactly **one** underlying CDP WebSocket matching the backend (2.3) and wires `message`/`close`/`error` both ways, adds logging + a `counters.cdpConnections` counter, and defers to the relay gateway for the `relay` backend. No per-command correlation map is needed — the upstream browser/CDP endpoint already multiplexes multiple clients. Connection limit: reuse the existing page-slot limiter concept (`withPageSlot`, `src/browser.js:218-290`) for `inbuilt` launches so concurrent external sessions can't exhaust the host.

### 2.5 Browser discovery endpoint (JSON, same auth)

`GET /cdp` (no name) → authenticated JSON listing shareable browsers and their URL templates, so the console can show "copy this URL" without the caller knowing exact names:

```json
{
  "ok": true,
  "browsers": [
    { "name": "cloakbrowser", "type": "cdp", "connected": true,
      "cdpUrl": "ws://<api-host>:1994/cdp/cloakbrowser?key=<your key>" },
    { "name": "maclap2", "type": "navigator-cdp", "connected": true, "paired": true, "cdpUrl": "..." }
  ]
}
```

`<api-host>:<api-port>` comes from `config.mcpApiHost`/`mcpApiPort` (`src/config.js:464-467`), matching how the relay gateway URL is built (`src/relay-server.js:118-120`).

---

## 3. Implementation Steps

### 3.1 DB migration (`src/db.js`)

Append one migration to `MIGRATIONS` (next index, after `mcp_calls` at index 10 → new index 11):

```sql
ALTER TABLE api_keys ADD COLUMN allowed_browsers TEXT;
```

Update the accessors (section 3 of current code):
- `listMcpApiKeys()` (`src/db.js:229`) — add `allowed_browsers` to the SELECT.
- `createMcpApiKey({ name, secret, allowedTools = null, allowedBrowsers = null })` (`src/db.js:232-235`) — write `JSON.stringify(allowedBrowsers)` or `NULL`.
- New `setMcpApiKeyBrowsers(id, allowedBrowsers)` symmetric with `setMcpApiKeyTools` (`src/db.js:245-247`).

### 3.2 New module `src/cdp-share.js`

`initCdpSharing({ server, manager, config })`:
- If `config.enableCdpSharing` is false → log `cdp sharing disabled` and return (no upgrade handler).
- `server.on("upgrade", ...)` matching `^/cdp/([^/]+)$` and bare `/cdp` *only when sharing is enabled*; refuse when disabled.
- `authorizeCdpUpgrade(req)` → the 5-step gate from 2.2 (header + query key extraction, constant-time match, DB record, browser-access check, browser resolution). Returns `{ keyInfo, browserName, backend }` or an HTTP status to answer.
- `_proxyAddOn(name, ws)` → open the dedicated connection to `cdpUrl`, duplex-pipe (2.4), disconnect-on-close.
- `_proxySharedChromium(ws)` → `manager.createSharedBrowser()` → pipe to `browser.wsEndpoint()` → `browser.close()` on ws close.
- `_proxyRelay(name, ws)` → `relayServer.attachGatewayClient(name, ws)` (3.3).
- `GET /cdp` JSON discovery (2.5), same auth.
- Counters/logging (3.6).

### 3.3 Relay gateway reuse (`src/relay-server.js`)

Factor the body of `_handleGateway(name, ws)` (`src/relay-server.js:340-344` callbacks + `701+`) into a public `attachGatewayClient(name, ws)` so the existing `/browser/<name>` upgrade path and the new `/cdp/<name>` proxy call the **same** client-registration + CDP-routing code (one representation cannot drift). No change to `/browser/<name>`'s behavior or its trust model — it stays the in-process puppeteer route; `/cdp/` is the authenticated external surface.

### 3.4 Server wiring (`src/mcp-server.js`)

- Import + call `initCdpSharing({ server, manager })` beside the relay mount (`src/mcp-server.js:4099-4107`).
- `getConsoleApiKeysPayload(manager)` (`src/mcp-server.js:548-561`):
  - add `browsers: manager.getHealth().browsers.map(({ name, type, role, status, connected }) => ({ name, type, role, status, connected }))` ;
  - add `cdpHost`/`cdpPort` from `manager.config`;
  - per key add `allowedBrowsers: parseAllowedBrowsers(key.allowed_browsers)` (new helper mirroring `parseAllowedTools`, `src/mcp-server.js:520-528`).
- `handleConsoleApiKeys` (`src/mcp-server.js:594-654`):
  - `create` accepts `allowedBrowsers` filtered against the current browser-name set (unknown names dropped, like tools at 602-605);
  - new action `set_browsers` → `setMcpApiKeyBrowsers` (the edit modal posts this only when the selection changed).
- `ensureConsoleToolsApiKey` (the "Web Tools UI" key, `src/mcp-server.js:585-592`) stays unrestricted (`allowed_browsers NULL`) — it is the console's **own internal key with all access** (decision §7.1), safe because its secret is server-generated and never exposed.

### 3.5 Console keys modal (`src/web-console/src/pages/keys/index.jsx` + `style.css`)

- New state `allowedBrowsers`, mirrored `setAllowedBrowsers` (component), `toggleBrowser`, and `sameBrowsers` helper (mirror `sameTools`, lines 6-10).
- `load()` seeds `allowedBrowsers` with all browser names (mirror line 26). `openEdit` seeds from `key.allowedBrowsers === null ? allBrowsers() : key.allowedBrowsers` (mirror line 53).
- New `<details className="api-key-browsers" open>` **after** the Tool access block: summary `All browsers allowed` / `N of M browsers allowed`; `Allow all` / `Clear all` buttons; one `Check` row per browser (name + type + connected dot) — reuse the `.api-key-tool-actions` / `.api-key-tool-items` styling with a `.api-key-browser-items` grid.
- Save logic: `create` posts `allowedBrowsers`; edit posts `set_browsers` only when `!sameBrowsers(...)` (mirror lines 76-80).
- Key list Access cell: `all tools · all browsers` / `N tools · M browsers` (line 221).
- Secret reveal (`:184-204`): under the key, show the CDP URL template `ws://<cdpHost>:<cdpPort>/cdp/<browser>?key=<your key>` with a **Copy** button (built from the first/allowed browser names + the fresh secret), labeled "Puppeteer connect URL".
- CSS: small additions to `style.css:2714-2833` region (`.api-key-browsers`, `.api-key-browser-items`, `.api-key-cdp-url` code box).

### 3.6 Audit + counters

- `counters.cdpConnections` (+1 per accepted proxy connection, tracked with the existing counters plumbing, `src/search.js`/`getActivityCounters`).
- One `mcp_calls` row per accepted CDP connection (`src/db.js:109-129`) via `recordMcpCall` (`src/activity.js:255-300`): `tool: "cdp:<browserName>"`, `source: "cdp"`, `ok: 1`, key name/preview from `getMcpCallKeyInfo` (`src/mcp-server.js:56-66`). Failed attempts (401/403) logged to `logs/tool-errors.log` via the existing `logToolError` path (transport: `"cdp"`).

### 3.7 Config (`src/config.js` + `src/config-schema.js`)

- `ENABLE_CDP_SHARING` env, default `"1"` (feature is on; CDP itself still requires a valid key — section 2.1). Parsed to `config.enableCdpSharing` in `loadConfig`; add a schema-metadata entry (category `http`/`security`, `type: "bool"`) mirroring `MCP_ALLOW_UNAUTHENTICATED`.

---

## 4. Tests & Verification

- Extend `tests/mcp-server.test.js` (existing keys coverage at `:331-371`): payload now carries `browsers` + per-key `allowedBrowsers`; `create` with `allowedBrowsers` persists+round-trips; `set_browsers` replaces; unknown browser names dropped.
- New `tests/cdp-share.test.js`:
  - auth gate unit tests — valid key/name → proxy opened; wrong key → 401; right key wrong browser → 403; unknown browser → 404; `CONSOLE_API_KEY` → accepted with full access (internal key, §7.1); feature disabled → no upgrade handler.
  - with `ENABLE_CDP_SHARING=0` the `/cdp` upgrade is refused.
- Manual e2e (in-container):
  1. `docker compose build && docker compose up -d` (env/schema change).
  2. Console → API keys → create a key granting only `cloakbrowser`; copy the CDP URL.
  3. `node -e` with `puppeteer-core` (or `scripts/bidi-direct.mjs`-style probe) → `puppeteer.connect({ browserWSEndpoint: 'ws://127.0.0.1:1994/cdp/cloakbrowser?key=<key>' })` → `newPage()` → `goto('https://example.com')` → assert title. Close → connector disconnects cleanly.
  4. Negative: same URL with a revoked key → 401; a key without browser access → 403.
  5. `curl -H "Authorization: Bearer <key>" <api-host>:<host>/cdp` → JSON discovery lists browsers + templates.
  6. `GET /stats` → `counters.cdpConnections` increments.

---

## 5. BrowserStack Parity Reality-check (research findings)

*Source: BrowserStack Puppeteer docs (`cdp.browserstack.com/puppeteer?caps=`), Manage Access Keys docs, coverage matrix.*

BrowserStack does **not** scope keys to browsers. Their keys are bare `username:accessKey` credentials (Basic Auth); browser/OS selection and auth both ride inside one `?caps=<url-encoded JSON>` query on a **single** endpoint:

```js
`wss://cdp.browserstack.com/puppeteer?caps=${encodeURIComponent(JSON.stringify(caps))}`
```

Implications for our design:

- **`/cdp/<name>?key=` is the same consumer contract but stricter**: `puppeteer.connect({ browserWSEndpoint })` works identically; per-key browser scoping is strictly more granular than BrowserStack offers. The "BrowserStack-style" requirement is the WS-URL-consumable-by-puppeteer UX, which §2.1 satisfies. No `?caps=` JSON blob needed — the browser is in our path, the key rides as the auth query param. (If literal path-parity is ever wanted later, `?caps={"browser":...}` is a trivial alias; not in scope now.)
- **One copyable URL per browser** (path-based), not one template for all — so the secret-reveal and discovery endpoint must emit one URL **per granted browser**, not a single caps template. This is the divergence-from-BrowserStack the UI must make explicit.
- **BrowserStack's "browser matrix" = our modal browser list.** Their coverage page is OS→browser→version; ours is the live `manager.getHealth()` set. The modal checkbox list *is* the matrix-equivalent UI.
- **Discovery endpoint** (`GET /cdp`) plays the role of browserstack's `/browsers` API for consumers who want the list programmatically.

---

## 6. Concrete Modal Spec (locked — reuse existing patterns)

*Source: `keys/index.jsx:130-183` (modal), `.api-key-tools` CSS `style.css:2943-2982`, `Check` component `components/ui.jsx:120-127`. The `Check` chip + `.api-key-tool-items` flex-wrap grid are directly reusable for browsers — no new checkbox component.*

**Placement:** a second `<details className="api-key-browsers" open>` inside `.api-key-permissions-field`, immediately **after** the Tool access `<details>` (`:152-175`) — same nesting, same summary/actions pattern.

**Per-browser row:** `<Check label={name}>` plus a small status dot/suffix — reuse the `Check` chip, append a `<span className="api-key-browser-status">` (green `● connected` / muted `○ disconnected`) and `<span title>{type}</span>`. Wrapped in `.api-key-browser-items` (same as `.api-key-tool-items`).

**State/handlers (mirror tools, `:110-117`):**
- `const [allowedBrowsers, setAllowedBrowsers] = useState([]);`
- `load()` seeds `setAllowedBrowsers(payload.browsers.map(b => b.name))` (`:26`).
- `openCreate` / `openEdit` seed `allowedBrowsers` = all / `key.allowedBrowsers === null ? allBrowsers() : key.allowedBrowsers` (`:45-56`).
- `toggleBrowser(name)` identical to `toggleTool`; `allowAll/clearAll` reuse the `.api-key-tool-actions` buttons.
- `sameBrowsers(a,b)` = clone of `sameTools` (`:6-10`).
- Save: create posts `allowedBrowsers`; edit posts `{ action: "set_browsers" }` only when `!sameBrowsers(effective, allowedBrowsers)` (`:76-80`).

**Summary text:** `All browsers allowed` / `N of M browsers allowed`; when a stored key has names no longer configured, keep them in the count (access check is name-equality; stale names simply 404, they are not a hole).

**Secret reveal (`:184-204`) — per-browser CDP URLs under the key:** for each granted browser emit

```
ws://<cdpHost>:<cdpPort>/cdp/<browser>?key=<fresh secret>
```

as a `<code>` line with a per-line **Copy** button (clipboard copy handles the per-browser URL; a single "Copy all" button can join all URLs with newlines). `cdpHost`/`cdpPort` come from the payload (`config.mcpApiHost`/`mcpApiPort`). Label: "Puppeteer connect URL".

**Key list Access cell (`:221`):** current 78px column (`style.css:2891`) is too narrow for `all tools · all browsers`. Widen the `Access` grid column to ~110px and render two stacked `<small>` lines: tools count over browsers count ("all tools / 3 browsers"). Mobile media query (`:2983-3003`) hides that column anyway.

---

## 7. Edge Cases & Invariants (must hold)

1. **Console key = its own internal key with ALL access (decided).** The console ("Web Tools UI" row, `ensureConsoleToolsApiKey`, `src/mcp-server.js:585-592`) and the in-boot `CONSOLE_API_KEY` are not excluded from CDP — they carry full access (`allowed_browsers NULL`). Rationale: these are the console's own internal keys; their secrets are server-generated 32-byte base64url values that are never displayed or shared, so all-access is safe. The CDP gate matches them like any other key. No special-casing in the gate.
2. **Legacy `MCP_API_KEYS` = full CDP (decided: "the mcp api key is the api key").** Imported keys have `allowed_tools NULL` (all tools); mirroring gives them `allowed_browsers NULL` = **all-browsers** CDP. Consistent, not a widening: those keys already call every devtools tool on every browser (`src/mcp-server.js:2108-2112`). No exclusion, no special flag.
3. **`MCP_ALLOW_UNAUTHENTICATED` does NOT apply to CDP (confirmed).** Unauthenticated MCP stays possible; CDP always requires a valid key (§2.1). With zero keys created, CDP offers 401 to everything — safe default even though the feature defaults on.
4. **Adopted/user-tab safety on relay browsers.** External puppeteer is just another client of the extension gateway; `Browser.close` is already overridden (`src/relay-server.js` gateway) and adopted-tab close never closes the user's real tab. Null out: external clients may still create/navigate/close the user's tabs they themselves own — that's the point of sharing; note "drives the user's real browser" in the modal copy exactly like `list_browsers` does.
5. **External hostname/TLS.** `cdpHost` in URLs/`GET /cdp` is `config.mcpApiHost` — for consumers behind a reverse proxy / TLS this must be overridable. Add `MCP_PUBLIC_URL` env (e.g. `https://navigator.example.com`) used only for *advertised* CDP bases; the listener stays on `mcpApiHost:port`. Defaults to current behavior when unset.
6. **Shared add-on exposure** (lightpanda/cloakbrowser): external clients see the whole browser (navigator's own sessions included) — inherent to CDP multi-client (§5.1 decision 2). Keep.
7. **Stale browser names in `allowed_browsers`** never 403 — resolution happens before access (unknown name → 404), and access is exact-name equality, so a removed browser just stops resolving. No cleanup migration needed.
8. **Multiple external clients** may attach to the same relay/add-on browser simultaneously (native CDP multi-client); inbuilt sessions are 1:1 fresh instances under the concurrency cap (§5.3).

---

## 8. Remaining Decisions (defaults marked; the rest in §7.1–7.3 are decided)

1. **Built-in Chromium isolation** (2.3): fresh dedicated instance per external connection vs. exposing the shared internal one. Recommended: fresh instance (safety: external clients can't see/close navigator's own search/fetch tabs). If the user wants the actual shared Chromium exposed instead, drop `_proxySharedChromium` and pipe to `manager.getBrowser().wsEndpoint()`.
2. **Lightpanda/cloakbrowser exposure** of navigator's own sessions on the shared add-on endpoint (events/tabs are browser-wide). Accepted as inherent to CDP multi-client; consumers see the whole browser. Note it in the UI as "shared browser".
3. **Concurrency cap** for concurrent `/cdp` sessions on the built-in Chromium (`inbuilt`) — default cap of e.g. 3 concurrent launched instances, rejecting beyond with HTTP 429. Reuses `withPageSlot` semantics.

---

## 9. Files Touched

| File | Change |
|---|---|
| `src/db.js` | migration + `allowed_browsers` in CRUD |
| `src/cdp-share.js` | **new** — endpoint, auth gate, proxies, discovery, counters |
| `src/relay-server.js` | factor `attachGatewayClient(name, ws)` |
| `src/browser.js` | `createSharedBrowser()` (fresh per-session Chromium) |
| `src/mcp-server.js` | `initCdpSharing` mount; payload + key handlers; `parseAllowedBrowsers` |
| `src/config.js` + `src/config-schema.js` | `ENABLE_CDP_SHARING` |
| `src/web-console/src/pages/keys/index.jsx` | browser-access section + CDP URL reveal |
| `src/web-console/src/style.css` | modal + code-box styles |
| `tests/mcp-server.test.js`, `tests/cdp-share.test.js` | key scoping + endpoint tests |
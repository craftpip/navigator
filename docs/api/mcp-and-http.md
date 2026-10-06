# MCP and HTTP API

## MCP Transport

`src/mcp-server.js` supports two transports — **Streamable HTTP is the default**.

| Transport | Enablement | Use |
|---|---|---|
| **Streamable HTTP** | `ENABLE_HTTP_MCP=1` (default in Compose) | **Recommended** — clients connect to `POST /mcp` |
| stdio | `ENABLE_STDIO_MCP=1` | Legacy — a local MCP client starts `node src/mcp-server.js` |

Streamable HTTP supports both stateless JSON-RPC calls and session-based Streamable HTTP. Session POST requests must carry the exact `Mcp-Session-Id` returned by their transport. The server sends raw SSE comment frames every 30 seconds to keep idle session streams alive without generating JSON-RPC notifications. Use Streamable HTTP for all new integrations — stdio is not recommended.

## Web Tools

The complete per-tool input/output contract is in [Tool Reference](tool-reference.md).

| Tool | Input modes | Core behavior |
|---|---|---|
| `web_search` | `queries`, `limit`, `engine`, `bypassCache` | Runs explicit routes or automatic fallback search |
| `web_fetch` | `urls` or `ref_ids`, `maxChars`, `bypassCache` | Opens pages and returns readable text with tables and numeric markdown references |
| `web_page_screenshot` | URL/ref input or persistent `targetId`, `quality`, `fullPage` | Captures a JPEG screenshot; storage output depends on config |
| `web_page_links` | link `ref_ids` | Resolves inline link references from a prior fetch |
| `web_page_ascii` | URL/ref input, `width`, `fullPage`, `mode` | Produces ANSI or plain ASCII from a real screenshot plus DOM legend |

Tools can be hidden and rejected by `DISABLE_TOOLS`. API keys with an allowed-tool list see and call only their permitted tools.

## DevTools Tools

The server also exposes persistent browser tools (unless `ENABLE_DEVTOOLS_MCP=0`):

- Targets: `Target.createTarget`, `Target.getTargets`, `Target.closeTarget`
- Navigation: `Page.navigate`, `Page.reload`, `Page.goBack`, `Page.goForward`
- Runtime/network: `Runtime.evaluate`, `Runtime.getConsoleMessages`, `Network.getRequests`
- DOM: `DOM.getDocument`, `DOM.querySelector`, `DOM.querySelectorAll`, `DOM.getOuterHTML`, `DOM.getCompactHTML`, `DOM.scrollIntoViewIfNeeded`
- Input: `Input.dispatchMouseEvent`, `Input.insertText`, `Input.dispatchKeyEvent`

See [Browser Runtime](../architecture/browser-runtime.md) for target lifetime and the [Source Map](../reference/source-reference.md) to locate dispatch code.

## HTTP Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/`, `/health` | GET | Lightweight liveness, browser state, VNC state, page limiter, and circuit breakers |
| `/stats` | GET | Memory, browser instances, caches, counters, request rates, scheduler and activity summary |
| `/stats/activity` | GET | Incremental SQLite activity feed; use independent `since` and `sinceOps` cursors |
| `/stats/activity-trend` | GET | Bucketed request/engine trend for `minutes`, `hour`, `day`, or `week` (default `day`), with an optional `engine` filter that scopes only the engine-attempt series; 400 for an unknown range or engine |
| `/mcp` | POST/GET/DELETE | Stateless and session-based MCP transport |
| `/search`, `/extract`, `/screenshot` | GET | Human-friendly HTTP wrappers around core browser operations |
| `/download/:id` | GET | Temporary screenshot download when enabled |
| `/console/*` | GET/POST/PUT/DELETE | Management UI, config, logs, keys, hints, and console MCP proxy |

## Cache Behavior

`web_search` and `web_fetch` responses are cached in process memory for five minutes, up to 200 entries per tool.

- `bypassCache=true` skips lookup and refreshes the cached result.
- `web_fetch` excludes `maxChars` from its cache key; a cached entry retains the length requested by its first caller, up to 200,000 characters.
- Caches are not shared between processes and reset on restart.

## Reference IDs

References make fetch output navigable without repeating long URLs.

1. A fetched page gets a numeric reference ID.
2. Every extracted link is assigned a numeric ID through `rememberLink()`.
3. Markdown link destinations are rewritten from URLs to IDs: `[documentation](88)`.
4. `web_page_links(ref_ids: [88])` resolves an inline link reference.
5. `web_fetch(ref_ids: [88])` resolves that link and fetches it.

The in-memory maps are bounded to 2,000 entries. `ref_links` in SQLite preserves URL-to-ID mappings across restarts.

## Authentication

HTTP MCP can be open for local use or require a key.

- Set `MCP_ALLOW_UNAUTHENTICATED=0` to require authentication.
- Supply `Authorization: Bearer <key>` or `X-API-Key: <key>`.
- Comparisons use `timingSafeEqual`.
- Persisted API keys and tool allow-lists are managed through the console API and stored in SQLite.

### Per-key permissions

An API key carries up to three independent permission lists, all edited in the console **API keys** modal (`/console/keys`):

| List | Gates | Semantics |
|---|---|---|
| `allowed_tools` | which MCP tool names the key may call | `NULL` = all, `[]` = none, array = exact list |
| `allowed_mcp_browsers` | which browsers the key may drive **through MCP tools** — `web_fetch`, `web_page_screenshot`, `web_page_ascii`, `web_page_svg`, `Target.createTarget` — via their `browser` argument | `NULL` = all, `[]` = none, array = exact names (case-insensitive) |
| `allowed_browsers` | which browsers the key may reach over the **external CDP endpoint** (`/cdp/<browser>?key=`) — see [CDP Sharing](/reference/browsers/cdp-sharing) | `NULL` = all, `[]` = none, array = exact names |

The two browser lists are deliberately independent: a key may share `cloakbrowser` over CDP while its MCP tools may only use `chromium`, and either list may be cleared to deny everything on that surface. Enforcement is centralized in `resolveBrowserParam()` — see [Browser Runtime](/architecture/browser-runtime#browsermanager).

Three behaviors worth knowing:

- **A refusal is an error, not a redirect.** Naming a browser the key may not use fails the call with `browser "<name>" is not permitted for this API key (allowed MCP browsers: …)`. Omitting `browser` still runs the normal resolution chain; if that lands on a browser the key may not use, the call fails the same way instead of silently rerouting — pass an allowed name.
- **Restricted keys skip the `web_fetch` result cache** (both read and write). The cache is keyed on request arguments and carries no key identity, so a cached page fetched on a browser the key may not use would otherwise be served before the permission check could run.
- **Enforcement covers browser *resolution*, not target handles.** Tools that address an existing `targetId` (`Runtime.evaluate`, `DOM.*`, `Input.*`, …) never re-resolve a browser, so a restricted key that already knows a `targetId` can still drive that tab. Restrict the tool list too if that matters.

The web console itself is not protected by MCP API keys. Put it behind a trusted network or reverse proxy when exposed.

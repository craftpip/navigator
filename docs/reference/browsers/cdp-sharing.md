# CDP Sharing — Technical Reference

Deep-dive for the feature that shares Navigator's configured browsers as **authenticated CDP WebSocket endpoints**, BrowserStack-style (`/cdp/<browserName>?key=<API_KEY>`).

## Endpoint contract

```
ws://<api-host>:<api-port>/cdp/<browserName>?key=<API_KEY>
```

- **`<browserName>`** — URL-encoded browser name from `BROWSERS` or a paired relay name (e.g. `cloakbrowser`, `lightpanda`, `maclap2`).
- **`key`** — an API key granted access to that browser. Accepted as `?key=` (query wins), `Authorization: Bearer <key>`, or `x-api-key` header — header form keeps secrets out of URLs/proxies. The key must match exactly one `api_keys.secret`.
- **`<api-host>:<api-port>`** — `config.mcpApiHost`/`mcpApiPort`. Override the **advertised** base with `MCP_PUBLIC_URL` (e.g. `https://navigator.example.com`); the listener itself stays on `mcpApiHost:port`.

The endpoint speaks **browser-level CDP** (`Target.getTargets`, `Target.setDiscoverTargets`, `Target.attachToTarget`, `Target.createTarget`, …), so `puppeteer.connect`, `puppeteer-core.connect`, raw CDP (`chrome-remote-interface`), and DevTools tooling all work verbatim.

## Auth — CDP is never unauthenticated

The gate fails closed, in order, on WebSocket upgrade:

1. Extract key: query param → Bearer header → `x-api-key`. Missing/malformed → `401`.
2. Constant-time match against the live secret list (`config.mcpApiKeys`). No match → `401`.
3. Load the DB record by exact secret. Unknown/revoked → `401` (revoking a key kills every live + future session for it).
4. Access check: `allowed_browsers == NULL` (all) **or** includes `<name>`. Denied → `403`.
5. Browser resolution: must be a configured/effective browser. Unknown → `404`.
6. Only then is the socket upgraded and proxied.

**Security invariant — even with `MCP_ALLOW_UNAUTHENTICATED=1`, CDP always requires a valid API key.** There is no open-access mode for CDP. With zero keys created, CDP answers 401 to everything (safe default even though the feature defaults on).

### `allowed_browsers` scoping

`api_keys` gained an `allowed_browsers` column mirroring `allowed_tools`:

- `NULL` (or a missing DB row) = **all browsers**.
- Array of names = an explicit subset; exact name equality at check time.

Access is configured in the console **API keys** modal (**Browser CDP access** checkbox section: per-browser chips with connected/type status, "Allow all"/"Clear all"). Stale browser names never 403 — resolution happens before access, so a removed browser just stops resolving (404).

### Internal keys get full access

- The console's own internal key (`ensureConsoleToolsApiKey` / "Web Tools UI") has `allowed_browsers NULL` — full access. Safe: its secret is server-generated, never displayed.
- Legacy `MCP_API_KEYS` imports have `allowed_tools NULL`, mirroring that to `allowed_browsers NULL` = all-browsers CDP. Consistent, not a widening. In-boot `CONSOLE_API_KEY` likewise.

## Per-backend transport — which browser the client actually gets

| Browser type | `/cdp/<name>` behavior | Ownership of the driven browser |
|---|---|---|
| `navigator-cdp` (relay: real Chrome/Firefox) | Attach the external client into the **existing extension gateway** (`relayServer.attachGatewayClient`) — same client-registration + CDP-routing code as the in-process `/browser/<name>` route. Full tab lifecycle, `Target.createTarget`, adoption all work via the extension | Extension-owned — never closed by Navigator; closing an adopted tab never closes the user's real tab |
| `cdp` add-on (cloakbrowser, lightpanda) | Open a **dedicated second CDP connection** to the entry's `cdpUrl` (same ws/http dial logic as `_ensureAddOnConnection`) and **duplex-pipe frames** to the external socket. Correlation is the upstream browser's job — CDP natively multiplexes | Add-on-owned — on close, `disconnect` only |
| `inbuilt` (built-in Chromium) | **Not** Navigator's shared internal instance (external clients could see/close Navigator's own search/fetch tabs). `BrowserManager.createSharedBrowser()` launches a **fresh, dedicated Chromium** per connection (same flags as `launchBrowser`), piped to its `wsEndpoint` | Navigator-owned — on close, `browser.close()` (kills the per-session instance) |

Concurrency cap: **3 concurrent** fresh-Chromium `/cdp` sessions, beyond which new ones get `429`. Lightpanda's single-tab limitation applies as-is.

External clients on a shared add-on or relay browser see the **whole browser** (including Navigator's own sessions) — inherent to CDP multi-client.

## Discovery endpoint

`GET /cdp` (no name, same auth) → authenticated JSON listing shareable browsers and ready-to-connect URL templates, so callers don't need to know exact names:

```json
{
  "ok": true,
  "base": "ws://localhost:1994",
  "browsers": [
    { "name": "cloakbrowser", "type": "cdp", "role": ["default"], "status": "connected",
      "connected": true,
      "cdpUrl": "ws://localhost:1994/cdp/cloakbrowser?key=<your key>" }
  ]
}
```

Templates carry a `<your key>` placeholder — secrets are never echoed.

## Audit, counters, config

- **Audit:** one `mcp_calls` row per accepted CDP connection (`tool: "cdp:<browserName>"`, `source: "cdp"`, key name/preview). Failed attempts (401/403) go to `logs/tool-errors.log` with the standard `logToolError` path.
- **Counter:** `counters.cdpConnections` (+1 per accepted connection), visible in `GET /stats`.
- **Config:** `ENABLE_CDP_SHARING` env, default `"1"`. When `0`, no `/cdp` upgrade handler is mounted at all.
- **UI:** the API-keys secret reveal shows a per-browser **Puppeteer connect URL** under the key with per-line Copy buttons.

## Consumer example

```js
const browser = await puppeteer.connect({
  browserWSEndpoint: "ws://localhost:1994/cdp/cloakbrowser?key=YOUR_API_KEY",
});
```

## See also

- [Browsers Overview](/guides/browsers/overview) — the `navigator-cdp` and `cdp` types this feature exposes
- [`BROWSERS` Configuration Reference](/reference/browsers/browser-array)
# External CDP Browsers

A **CDP add-on** connects Navigator to a browser that is already running and exposing the Chrome DevTools Protocol. Navigator never launches or closes these processes — you own them. It connects lazily and reuses the connection (a `disconnected` event just clears the cached connection so the next call reconnects).

## Adding one in the console

In **Manage → Browsers** click **+ Add browser** and set:

- **Name** — anything unique; tools route to it via the `browser` parameter.
- **Type** — `cdp`.
- **CDP URL** — two endpoint flavors are supported:

| `cdpUrl` form | What it is |
|---|---|
| `http://host:port` | A CDP **server** — Navigator (or the browser) resolves it via `/json/version`. Works for a plain Chromium instance out of the box |
| `ws://host:port/…` | A direct **WebSocket** endpoint — the full `webSocketDebuggerUrl` path, not a bare `host:port`, unless the server serves the socket at the root |

- **Roles** — which tools it serves (`default`, `fetch`, `screenshot`, `devtools`, …). Pick only what you want and let the built-in Chromium keep the rest.

## Connecting your own browser

To point Navigator at a browser you run yourself (e.g. a Chromium on another host), launch it with `--remote-debugging-port` and use that endpoint as the `cdpUrl`. Headless or headed, key flags, `/json/version` verification, and container↔host networking are all in the [reference](/reference/browsers/external-cdp).

Connecting from a Navigator container to a browser on the host → use the host's reachable address (e.g. `host.docker.internal` or the LAN IP) and make sure the port is published/exposed.

## General rules

- **Lazy, reused connections** — the first call dials the endpoint; the connection is kept and reused. A down add-on is reported in `rollbackNotes` and the chain moves on rather than re-dialing every call.
- **You own the lifecycle** — Navigator never launches or closes add-ons. Start/stop your browser yourself.
- **Search engines never use add-ons** — `web_search` always runs on the built-in Chromium.
- **Explicit `browser` param is strict** — naming a down add-on explicitly is an error, not a silent fallback.
- **Down sidecars fall back automatically** for implicit calls — the next candidate is tried, then Chromium.

The JSON entry shape and endpoint-verification details are in the [`BROWSERS` Configuration Reference](/reference/browsers/browser-array) and [External CDP reference](/reference/browsers/external-cdp).

## Next Steps

- [CloakBrowser](/guides/browsers/cloakbrowser) — the anti-bot Chromium sidecar
- [Lightpanda](/guides/browsers/lightpanda) — the fast, low-memory headless browser
- [Browsers Overview](/guides/browsers/overview) — the three browser types and routing
- [Reference: External CDP](/reference/browsers/external-cdp) — launch flags, endpoint forms, verification
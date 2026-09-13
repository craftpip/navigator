# External CDP Browsers — Technical Reference

Deep-dive for pointing Navigator at a self-hosted browser that already exposes the Chrome DevTools Protocol (the `cdp` / external add-on type).

## Endpoint forms

A `cdp` entry's `cdpUrl` has two flavors:

| `cdpUrl` form | What it is | Resolution |
|---|---|---|
| `http://host:port` | A CDP **server** endpoint (`puppeteer.connect({ browserURL })`) | Navigator/browser resolves it via `GET /json/version` to find the `webSocketDebuggerUrl`. Works for a plain Chromium instance out of the box |
| `ws://host:port/…` | A direct browser **WebSocket** endpoint (`browserWSEndpoint`) | Used verbatim. Must be the full `webSocketDebuggerUrl` path (e.g. `ws://host:9222/devtools/browser/<uuid>`), not a bare `host:port`, unless the server serves the socket at the root (e.g. Lightpanda) |

## Launching Chromium / Chrome with CDP

Chromium (or Chrome) exposes CDP when launched with `--remote-debugging-port`:

```bash
# Headed, reachable from other hosts
chromium --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 \
  --user-data-dir=/data/cdp-chrome about:blank

# Headless (server / container)
chromium --headless=new --remote-debugging-port=9222 --no-sandbox \
  --disable-dev-shm-usage --user-data-dir=/data/cdp-chrome about:blank
```

Key flags:

- `--remote-debugging-port=<port>` — **required**; this is what opens the CDP endpoint.
- `--remote-debugging-address=0.0.0.0` — listen on all interfaces instead of just loopback. Use it when Navigator runs elsewhere (e.g. in a Docker container) and the port isn't on `localhost`.
- `--user-data-dir=<dir>` — needed whenever `--remote-debugging-port` is set: Chrome won't attach debugging to the live default profile.
- `--headless=new` — new headless mode for servers; `--no-sandbox` / `--disable-dev-shm-usage` are the usual container companions.

## Verifying the endpoint

```bash
curl -s http://localhost:9222/json/version
```

The response includes browser metadata and a `webSocketDebuggerUrl` like `ws://localhost:9222/devtools/browser/<uuid>`. That full URL is the `ws://` form; the bare `http://` form works out of the box.

## Container ↔ host networking

Connecting from a Navigator container to a browser on the host → use the host's reachable address (e.g. `host.docker.internal` or the LAN IP) and make sure the port is published/exposed.

## BROWSERS entries

```json
// browserURL style — Navigator queries /json/version
{ "name": "my-chrome", "role": ["default"], "type": "cdp", "cdpUrl": "http://localhost:9222" }

// browserWSEndpoint style — the full webSocketDebuggerUrl
{ "name": "my-chrome", "role": ["default"], "type": "cdp", "cdpUrl": "ws://localhost:9222/devtools/browser/<uuid>" }
```

- `type: "cdp"` with a `cdpUrl` is all you need; `name` routes tools via the `browser` parameter.
- **Roles decide what it serves** — give it only the roles you want (e.g. `fetch` only) and let the built-in Chromium keep the rest.

## General rules

- **Lazy, reused connections** — the first call dials the endpoint; the connection is kept and reused. A down add-on is reported in `rollbackNotes` and the chain moves on rather than re-dialing every call. A `disconnected` event just clears the cached connection so the next call reconnects.
- **You own the lifecycle** — Navigator never launches or closes add-ons.
- **Search engines never use add-ons** — `web_search` always runs on the built-in Chromium.
- **Explicit `browser` param is strict** — naming a down add-on explicitly is an error, not a silent fallback.
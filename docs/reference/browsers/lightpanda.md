# Lightpanda Sidecar — Technical Reference

[Lightpanda](https://lightpanda.io/) is a fast, low-memory headless browser aimed at bulk fetch and extraction workloads. Navigator connects to it as a `cdp` add-on over its **WebSocket** CDP endpoint.

## How the endpoint works

The official `lightpanda/browser:latest` image runs `lightpanda serve --host 0.0.0.0 --port 9222` (the image default CMD) and exposes a WebSocket CDP endpoint:

- Endpoint form: `ws://host:9222` — Navigator connects via `puppeteer.connect({ browserWSEndpoint })`.
- No graphical rendering engine — screenshots are **placeholders**, not faithful renders (a forked build with render patches may return a serviceable test image, but treat visuals as unsupported). Use it for speed/cost on fetch and extraction; keep Chromium for anything visual.
- Single-tab: the endpoint exposes a single tab; the [CDP sharing](/reference/browsers/cdp-sharing) transport applies Lightpanda's single-tab limitation as-is.

## The DNS-rebinding guard — static IP required

Lightpanda's CDP WebSocket handshake carries a **DNS-rebinding guard**: it rejects any `Host:` header that is not an IP literal (or the exact `localhost:<port>` form):

- The compose service name `lightpanda` resolves to a container IP in the `Host:` header, but the literal string `lightpanda` is not an IP → **`403 Host not allowed`**.
- `--advertise-host` does **not** fix it — it only changes the `/json/version` response body's advertised `ws://host:port/` URL, not the handshake peer check.
- The compose file therefore assigns the container a **static IP** (`172.22.0.222`) and the `cdpUrl` must reference that IP literal. If `172.22.0.222` clashes with something on your compose network, change the static IP in the compose file **and** the `cdpUrl` together — they must match.

## Compose sidecar (`docker-compose.lightpanda.yml`)

An opt-in compose file ships with the repo, independent of the main navigator stack:

```bash
docker compose -f docker-compose.lightpanda.yml up -d
```

Container details:

- image `lightpanda/browser:latest`
- host port `127.0.0.1:${LIGHTPANDA_CDP_PORT:-9223}:9222`
- `LIGHTPANDA_DISABLE_TELEMETRY: "true"`
- `shm_size: 512m`, `init: true`, 1 CPU / 1 GB limit
- static `ipv4_address: 172.22.0.222` (`--advertise-host` is not used — see above)

## BROWSERS entry

```json
{
  "name": "lightpanda",
  "role": ["fetch", "devtools"],
  "type": "cdp",
  "cdpUrl": "ws://172.22.0.222:9222"
}
```

Give it only the roles you want (e.g. `fetch`, `devtools`); keep `default`/`screenshot` on the built-in Chromium.

## Search engines

Search engines never use add-ons — but the built-in `google_lp`/`bing_lp`/`mojeek_lp` routes use Lightpanda internally through Navigator's engine pools (`lightpanda` backend, shared pool), **independent of `BROWSERS`**.

## Fallback behavior

If the sidecar is down, implicit page calls fall back to the next candidate and then Chromium automatically (each down add-on reported in `rollbackNotes`). An explicit `browser: "lightpanda"` call errors — strict, no silent reroute.

## Verify

```bash
# Sidecar up?
docker ps --filter name=lightpanda

# CDP reachable from the navigator container
docker exec navigator curl -s http://172.22.0.222:9222/json/version
```

Then drive it via the tools:

```json
list_browsers  // lightpanda shows as a cdp add-on, ownership "agent"
Target.createTarget({ "browser": "lightpanda", "url": "https://example.com" })
```
# Lightpanda

[Lightpanda](https://lightpanda.io/) is a fast, low-memory headless browser aimed at bulk fetch and extraction workloads. Navigator connects to it as a `cdp` add-on over its **WebSocket** CDP endpoint.

## What it provides

The official `lightpanda/browser:latest` image runs `lightpanda serve` and exposes a WebSocket CDP endpoint (`ws://host:9222`, a browserWSEndpoint form). Use it for speed/cost on fetch and extraction.

**Important caveat:** Lightpanda has **no graphical rendering engine** — screenshots are placeholders, not faithful renders. Keep Chromium for anything visual.

## Start it

An opt-in compose file ships with the repo, `docker-compose.lightpanda.yml` — independent of the main navigator stack:

```bash
docker compose -f docker-compose.lightpanda.yml up -d
```

Container details and the search-engine routes it powers are in the [reference](/reference/browsers/lightpanda).

### Use the static IP, not the service name

Lightpanda's CDP handshake has a **DNS-rebinding guard** — it rejects any `Host:` header that isn't an IP literal, so the compose service name `lightpanda` won't work. The compose file gives the container a **static IP** (`172.22.0.222`) and the `cdpUrl` must reference **that IP literal**:

```json
{
  "name": "lightpanda",
  "role": ["fetch", "devtools"],
  "type": "cdp",
  "cdpUrl": "ws://172.22.0.222:9222"
}
```

If `172.22.0.222` clashes with something on your compose network, change the static IP in the compose file **and** the `cdpUrl` together — they must match.

## Add it in the console

**Manage → Browsers → + Add browser** with the entry above. Give it only the roles you want (e.g. `fetch`, `devtools`); keep `default`/`screenshot` on the built-in Chromium.

### Fallback behavior

If the sidecar is down, implicit page calls fall back to the next candidate and then Chromium automatically. An explicit `browser: "lightpanda"` call errors — strict, no silent reroute.

## Verify it's connected

Check the **Status** page — `lightpanda` should show as a connected `cdp` add-on with `ownership: "agent"`. Then drive it from the devtools:

```json
list_browsers  // lightpanda shows as a cdp add-on, ownership "agent"
Target.createTarget({ "browser": "lightpanda", "url": "https://example.com" })
```

Sidecar-level checks (`docker ps`, `/json/version`) and the `google_lp`/`bing_lp`/`mojeek_lp` engine details are in the [reference](/reference/browsers/lightpanda).

## Next Steps

- [External CDP Browsers](/guides/browsers/cdp-addons) — how `cdp` add-ons work in general
- [CloakBrowser](/guides/browsers/cloakbrowser) — the anti-bot Chromium alternative
- [Reference: Lightpanda](/reference/browsers/lightpanda) — the DNS guard, compose details, engines
# CloakBrowser Sidecar — Technical Reference

[CloakBrowser](https://cloakbrowser.com/) is a Chromium build with anti-bot fingerprinting, useful when a target site blocks normal headless browsers. Navigator connects to it as a `cdp` add-on through its CDP multiplexer.

## How `cloakserve` works

The `cloakhq/cloakbrowser` image ships `cloakserve`: a CDP **multiplexer** that exposes an HTTP CDP server on `:9222`, spawning one internal Chrome process **per fingerprint seed**. From Navigator's perspective it is a normal `browserURL` endpoint (`http://host:9222`) — the `http://` form, resolved via `/json/version`.

Navigator never launches or closes it — the sidecar is your process.

## Compose sidecar (`docker-compose.cloak.yml`)

An opt-in compose file ships with the repo, independent of the main navigator stack:

```bash
docker compose -f docker-compose.cloak.yml up -d
```

Container details:

- image `cloakhq/cloakbrowser`, `command: ["cloakserve"]` (the image default CMD is `python` — must be overridden)
- host port `127.0.0.1:${CLOAK_CDP_PORT:-9222}:9222`
- `shm_size: 2gb`, `init: true`, 2 CPU / 2 GB reservations

`CLOAKBROWSER_LICENSE_KEY` — optional for testing; set in the compose environment for persistent licensed use. It is consumed by `docker-compose.cloak.yml`, not the main compose file.

## BROWSERS entry

```json
{
  "name": "cloakbrowser",
  "role": ["default", "fetch", "screenshot", "devtools"],
  "type": "cdp",
  "cdpUrl": "http://cloak-browser:9222"
}
```

- `cdpUrl` uses the compose service name `cloak-browser` — no IP-literal restriction here, `cloakserve` accepts hostname `Host:` headers.
- Give it only the roles you want; the built-in Chromium keeps the rest.
- Search engines never use add-ons — `web_search` still runs on the built-in Chromium.

## Fallback behavior

If the sidecar is down, implicit page calls fall back to the next candidate and then Chromium automatically (each down add-on reported in `rollbackNotes`). An explicit `browser: "cloakbrowser"` call errors — strict, no silent reroute.

## Verify

```bash
# Sidecar up?
docker ps --filter name=cloak-browser

# CDP reachable from the navigator container
docker exec navigator curl -s http://cloak-browser:9222/json/version
```

Then drive it via the tools:

```json
list_browsers  // cloakbrowser shows as a cdp add-on, ownership "agent"
Target.getTargets({ "browser": "cloakbrowser" })
Target.createTarget({ "browser": "cloakbrowser", "url": "https://example.com" })
```

The browser is also shareable over the authenticated [CDP sharing](/reference/browsers/cdp-sharing) endpoint (`/cdp/cloakbrowser?key=<API_KEY>`), where it is duplex-piped directly to the extension's own session.
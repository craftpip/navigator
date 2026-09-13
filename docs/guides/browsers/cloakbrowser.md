# CloakBrowser

[CloakBrowser](https://cloakbrowser.com/) is a Chromium build with anti-bot fingerprinting — useful when a target site blocks normal headless browsers. Navigator connects to it as a `cdp` add-on through its **CDP multiplexer**.

## What it provides

The `cloakhq/cloakbrowser` image ships `cloakserve`: a CDP **multiplexer** that exposes an HTTP CDP server on `:9222`, spawning one internal Chrome process per fingerprint seed. From Navigator's perspective it is a normal `http://host:9222` (browserURL) endpoint. Navigator never launches or closes it — the sidecar is your process.

## Start it

An opt-in compose file ships with the repo, `docker-compose.cloak.yml` — independent of the main navigator stack:

```bash
docker compose -f docker-compose.cloak.yml up -d
```

Container details (image, ports, resources, the `CLOAKBROWSER_LICENSE_KEY` env) are in the [reference](/reference/browsers/cloakbrowser).

## Add it in the console

**Manage → Browsers → + Add browser**:

- **Name** — e.g. `cloakbrowser`.
- **Type** — `cdp`.
- **CDP URL** — `http://cloak-browser:9222` (the compose service name works here — no IP-literal restriction, `cloakserve` accepts hostname `Host:` headers).
- **Roles** — e.g. `default`, `fetch`, `screenshot`, `devtools` — give it only what you want; the built-in Chromium keeps the rest.

Equivalent JSON entry:

```json
{
  "name": "cloakbrowser",
  "role": ["default", "fetch", "screenshot", "devtools"],
  "type": "cdp",
  "cdpUrl": "http://cloak-browser:9222"
}
```

### Fallback behavior

If the sidecar is down, implicit page calls fall back to the next candidate and then Chromium automatically (each down add-on reported in `rollbackNotes`). An explicit `browser: "cloakbrowser"` call errors — strict, no silent reroute.

## Verify it's connected

Check the **Status** page — `cloakbrowser` should show as a connected `cdp` add-on with `ownership: "agent"`. Then drive it from the devtools:

```json
list_browsers  // cloakbrowser shows as a cdp add-on, ownership "agent"
Target.getTargets({ "browser": "cloakbrowser" })
Target.createTarget({ "browser": "cloakbrowser", "url": "https://example.com" })
```

Sidecar-level checks (`docker ps`, `/json/version`) are in the [reference](/reference/browsers/cloakbrowser), and the browser can also be shared externally via [CDP Sharing](/guides/browsers/cdp-sharing).

## Next Steps

- [External CDP Browsers](/guides/browsers/cdp-addons) — how `cdp` add-ons work in general
- [Lightpanda](/guides/browsers/lightpanda) — the fast low-memory alternative
- [Reference: CloakBrowser](/reference/browsers/cloakbrowser) — compose details, license key, verification
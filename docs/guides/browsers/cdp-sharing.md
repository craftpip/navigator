# CDP Sharing

Navigator can expose its configured browsers as **authenticated CDP WebSocket endpoints** — so your own tooling (or another agent) can connect to the same browsers Navigator uses, using the standard Chrome DevTools Protocol. Nothing extra to install: the endpoint is served by Navigator's own HTTP server, and the browsers are the `BROWSERS` entries you already configured (plus any paired relay browsers).

Example — connect a Puppeteer script straight to a browser Navigator has running:

```js
import puppeteer from "puppeteer";

const browser = await puppeteer.connect({
  browserWSEndpoint: "ws://localhost:1994/cdp/cloakbrowser?key=YOUR_API_KEY",
});
const page = await browser.newPage();
await page.goto("https://example.com");
console.log(await page.title());
await browser.disconnect();
```

If you can paste a URL, you can drive a Navigator browser — `puppeteer.connect`, `puppeteer-core.connect`, `chrome-remote-interface`, and raw CDP clients all work, because the endpoint speaks **browser-level CDP** (`Target.getTargets`, `Target.createTarget`, …).

## Getting your connection URL

The URL is generated for you in the console:

1. **Console → API keys** → create or edit a key.
2. In **Browser CDP access**, tick the browsers that key may reach (each shows its type and connected/status dot). The built-in Chromium and every add-on/relay browser you've configured is listed.
3. Reveal the secret — under it you get one **Puppeteer connect URL per granted browser**, with a **Copy** button.

Each URL looks like `ws://<host>:<port>/cdp/<browser>?key=<API_KEY>`. The key can also ride as an `Authorization: Bearer` or `x-api-key` header (keep secrets out of URLs when you can control headers). `MCP_PUBLIC_URL` overrides the advertised base when Navigator sits behind a reverse proxy or TLS.

## Security: CDP is never unauthenticated

Unlike the MCP surface, the shared CDP endpoints **always require a valid API key** — `MCP_ALLOW_UNAUTHENTICATED` has no effect here. With no keys created, every CDP request is refused.

The gates are explicit and fail closed:

- `401` — missing/invalid/revoked key
- `403` — key not granted that browser
- `404` — unknown browser name
- `429` — too many concurrent connections on built-in Chromium (limited to 3)

Each key's browser access is independent — grant exactly the browsers each tool needs plus nothing else.

## Which browser you actually get

| Browser type | What `/cdp/<name>` drives |
|---|---|
| `navigator-cdp` (relay — your real Chrome/Firefox) | The extension gateway. External clients create/navigate their own tabs in your real, visible browser; Navigator never closes your tabs |
| `cdp` add-on (CloakBrowser, Lightpanda) | The actual sidecar — a dedicated CDP connection that's duplex-piped through. The browser is shared, so external clients see the same browser Navigator uses |
| `inbuilt` (built-in Chromium) | **Not** Navigator's shared internal instance. A fresh, dedicated Chromium is launched per connection and closed when the client disconnects — isolation so an external client can't touch Navigator's own search/fetch tabs |

## Discovery

Prefer the JSON to hardcoding names: `GET /cdp` (using the same key as a Bearer header) lists the shareable browsers, their status, and a ready-to-connect URL template for each.

## Keeping track

Every accepted connection is audited like an MCP call (`tool: cdp:<browser>`), shows up in `GET /stats` → `counters.cdpConnections`, and **revoking a key kills its live sessions**. Toggle the whole feature with `ENABLE_CDP_SHARING` (default on — still requires a valid key).

Details — the auth gate order, per-backend transports, `allowed_browsers` scoping, and invariants — live in the [CDP Sharing technical reference](/reference/browsers/cdp-sharing).

## Next Steps

- [Browsers Overview](/guides/browsers/overview) — the `BROWSERS` entries this feature shares
- [Reference: CDP Sharing](/reference/browsers/cdp-sharing) — the technical deep-dive
- [Chrome Extension](/guides/browsers/chrome-extension) · [Firefox Extension](/guides/browsers/firefox-extension) — sharing your real browser over the relay
# Firefox Extension (Browser Relay)

The **Navigator Browser Relay** Firefox extension gives the Navigator MCP server CDP access to a real Firefox, mirroring the Chromium bridge. Firefox is controlled through Firefox's own **Remote Agent (WebDriver BiDi)** — no `chrome.debugger` (Firefox does not have it), no third-party forked builds. A small bridge in the extension translates Navigator's CDP commands into BiDi and back.

## Configure Navigator

In **Manage → Browsers → + Add browser**:

- **Name** — e.g. `firefox` (must match the browser name you give the extension when pairing).
- **Type** — `navigator-cdp` (relay extension — no `cdpUrl`).
- **Plugin** — `firefox` (or `auto`, Navigator infers it from the live connection).
- **Roles** — `default`, `fetch`, `screenshot`, `devtools`, … — everything you want shareable with this browser.

## Launch Firefox with the Remote Agent

Firefox must run with the **Remote Agent** (WebDriver BiDi) enabled or the extension can't connect. The repo's `./launch-firefox.sh` starts it correctly:

```bash
./launch-firefox.sh
```

The flags behind it — `--remote-debugging-port` plus the exact `--remote-allow-origins=moz-extension://<uuid>` allow-list (Firefox rejects the handshake with `400 BiDi not connected` if the origin doesn't match exactly, and a temporary-loaded add-on gets a fresh uuid per load) — are in the [Relay Extensions reference](/reference/browsers/extensions).

## Install & pair (first time)

1. Install the extension (temporary add-on via `web-ext`, or loaded into the profile; `launch-firefox.sh` handles it).
2. In the extension popup: set the **Server URL** to the navigator server's URL — Firefox cannot reach `localhost` from extension pages, so use the navigator server's reachable LAN address.
3. Set the **browser name** (must match the `BROWSERS` entry) and click **Connect**.
4. Connect **BiDi** (`ws://127.0.0.1:9222/session`).
5. Enter the **PIN** shown by the navigator side (console box, ~60s expiry) and verify.

Pairing is one-time and token-based, exactly like the Chrome extension — the token persists, so navigator container restarts do not force a re-PIN.

## Behavior notes

- **`ownership: "user"`** — it's your real, visible Firefox; `list_browsers` / `Target.getTargets` label it as such.
- **Auto-BiDi dial** — the background dials the Remote Agent on every load; `--remote-debugging-port` must be live.
- **One active BiDi session per Firefox process.** If a session is opened but not cleanly ended — an aborted test/probe, or a second client — the single slot is orphaned and the extension fails with `BiDi not connected`. There is no supported way to force-reap it; recovery is: quit Firefox and relaunch with `--remote-debugging-port=9222`.
- **Open in window** — the popup's "open new windows instead of tabs" option maps to `browsingContext.create({ type: "window" })`; window-created contexts are exempt from tab isolation (which would otherwise hide the only tab of a fresh window).

## Next Steps

- [Browsers Overview](/guides/browsers/overview) — the three browser types and routing
- [Chrome Extension](/guides/browsers/chrome-extension) — the same bridge for Chrome (true CDP)
- [DevTools](/guides/devtools/overview) — the tools that drive these browsers
- [Reference: Relay Extensions](/reference/browsers/extensions) — CDP ⇄ BiDi mapping, origin pinning, tests
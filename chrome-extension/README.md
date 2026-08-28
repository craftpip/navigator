# Navigator Browser Relay — Chrome Extension

Bridge your real Chrome (logins, cookies, sessions, extensions) to the Navigator server over WebSocket.

> **Standalone Phase 1 build.** Navigator-side integration (relay endpoint, BrowserManager, MCP tools) is **not built yet** — see `../plans/38_browser-plugin.md` Phase 3.

## Protocol (extension ⇄ navigator /relay)

| Direction | Message | Purpose |
|---|---|---|
| ext → | `{ type: 'navigator-hello', browserName, extensionVersion, sessionToken? }` | handshake on connect |
| ← | `{ type: 'pin_required' }` | server asks for PIN (no/expired token) |
| ext → | `{ type: 'pin', pin }` | submit 6-digit PIN |
| ← | `{ type: 'connected', sessionToken }` | paired; token stored for reconnection |
| ← | `{ type: 'client-connected', clientId }` | navigator (puppeteer) attached |
| ← | `{ type: 'list_tabs_request' }` | navigator asks for tab list |
| ext → | `{ type: 'tab_list', tabs: [targetInfo] }` | tab list response |
| ← | `{ id, method, params, sessionId, tabId }` | CDP command (puppeteer protocol) |
| ext → | `{ id, result\|error, sessionId }` | CDP command response |
| ext → | `{ type: 'cdp_event', method, params, sessionId }` | CDP events forwarded to navigator |
| both | `{ type: 'ping' }` / `{ type: 'pong' }` | keepalive |

## Try it standalone

```bash
# 1. Unit tests (no Chrome needed)
node test/unit-ext.mjs

# 2. Mock relay server (simulates navigator's /relay endpoint)
node test/mock-relay-server.mjs 9515
```

## Packed build (installable .crx)

```bash
./pack.sh
```

Produces `dist/navigator-browser-relay.crx` (inside this folder). Install by
dragging it into `chrome://extensions` with Developer mode on. The signing key
(`chrome-extension-key.pem`, same folder, gitignored, chmod 600) defines the
extension's ID — keep it: re-running `pack.sh` reuses it so updates install over
the previous version. Never lose or share it.

## Manual test in Chrome

1. `chrome://extensions` → Developer mode → **Load unpacked** → select `chrome-extension/` (or install the packed `.crx` above)
2. Run the mock server: `node test/mock-relay-server.mjs 9515 --pin 201648`
3. Click the extension icon → enter browser name + server URL `ws://localhost:9515`
4. Click **Connect** → enter the PIN → paired. The mock server then drives test CDP commands (`Browser.getVersion`, `Target.getTargets`, `list_tabs_request`) to prove routing works end-to-end.

## Architecture notes

- **Single WebSocket** to navigator's `/relay` endpoint (cdp-tunnel used N connections through a proxy; navigator IS the relay).
- CDP commands route through `CDP_HANDLERS` in `cdp/index.js`:
  - **LOCAL** — synthesized browser-level replies (`Browser.getVersion`, `Target.getTargets`, `Browser.close`, …)
  - **SPECIAL** — Chrome-extension-specific (`Target.createTarget` → `chrome.tabs.create`, attach/detach, tab grouping)
  - **FORWARD** — everything else → `chrome.debugger.sendCommand` on the mapped tab
- Session token stored in `chrome.storage.local`; reconnects reuse it (no re-pairing until server invalidates).
- Automation-created tabs are grouped under **"Navigator: <browserName>"** (collapsed, blue) so they don't clutter the user's tab bar.
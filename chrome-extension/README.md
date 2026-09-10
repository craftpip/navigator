# Navigator Browser Relay — Chrome Extension

Bridge your real Chrome (logins, cookies, sessions, extensions) to the Navigator server over WebSocket.

## Development environment

A dedicated Chromium dev container lives in this folder (`Dockerfile` +
`docker-compose.yml`) so developing the extension never touches the Chromium
inside the navigator server container. It loads this extension unpacked
(`--load-extension=/app/extension` — this folder is bind-mounted), runs headed
under Xvfb, exposes CDP, and connects straight back to navigator's relay.

```bash
docker compose up -d --build   # build + start the dev Chromium container
docker compose logs -f         # watch startup logs / extension output
```

| Port | Purpose |
|---|---|
| `9333:9222` | CDP endpoint, exposed so navigator (or you) can drive the dev Chrome (host :9222 is taken by cloak-browser — override with `CHROME_CDP_PORT`) |
| `5900` | VNC — connect a VNC client to <host>:5900 to SEE the headed Chromium |
| network | joins `navigator_default` so the extension can dial `navigator:1994/relay` |

## Full development / test cycle (Chrome)

1. **Edit the extension** here in `chrome-extension/`. Source is bind-mounted
   into the dev container — no rebuild needed. Reload it in `chrome://extensions`
   (or `docker compose restart dev-chrome` for a full restart).
2. **Start it**: `docker compose up -d --build` (builds the Chromium+Xvfb image
   once, then `up -d` is instant).
3. **Pair it with navigator** — automated, one command (runs the whole PIN flow
   against the live navigator relay via CDP):
   ```bash
   # from this container (or navigator's container):
   #   CDP_URL=http://<dev-chrome-ip>:9222  NAVIGATOR_URL=http://127.0.0.1:1994  BROWSER_NAME=dev-chrome
   node test/e2e-pair.mjs
   #   ✔ CONNECTED name=dev-chrome  ws=ws://<navigator>/browser/dev-chrome
   ```
   The PIN is fetched from navigator `/stats` (`relay.pending[0].pin`) — no need
   to read logs or click the popup.
4. **Confirm navigator sees it** — `/health` browser list includes `dev-chrome`
   as a `navigator-cdp` entry; the CDP gateway `ws://<navigator>/browser/dev-chrome`
   forwards `Target.getTargets` into the extension.
5. **Drive it / test routing** — CDP commands sent over the relay gateway are
   executed by the extension's `chrome.debugger` in the dev Chrome.

### Manual (visual) cycle

1. `docker compose up -d`
2. Open a VNC client to `<host>:5900` to see the Chrome window.
3. Click the extension icon → Browser name + server URL (`10.69.1.164:1994`) →
   **Connect**.
4. Fetch the PIN: `curl -s $NAVIGATOR_URL/stats | jq '.relay.pending[0].pin'`
   (60s expiry) → enter it → **Verify** → status becomes **Connected**.
   (Or read it from `docker logs navigator 2>&1 | grep PIN`.)

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

## Notes for `test/e2e-pair.mjs`

- Drives the extension's **service worker** over raw CDP (not the popup —
  `page.goto(chrome-extension://…/popup.html)` is blocked by Chrome with
  `ERR_BLOCKED_BY_CLIENT`).
- Calls `ConnectionManager.connect()` / `ConnectionManager.send({type:'pin'})`
  directly (routing via `chrome.runtime.sendMessage` from the SW to itself is
  unreliable in MV3).
- The relay URL must be **bare `host:port`** (`10.69.1.164:1994`) — the extension's
  `buildCandidateUrls` turns a bare host:port into `ws://<hostport>/relay`; an
  `http://` URL is passed through as-is and the `WebSocket` constructor rejects it.
- Clears the stored session token before connecting so every run is a fresh PIN
  cycle.
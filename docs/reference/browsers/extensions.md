# Relay Extensions — Technical Reference

Deep-dive on the two browser-relay extensions (`navigator-cdp` type) and the relay protocol they speak. User-facing setup lives in the [Chrome](/guides/browsers/chrome-extension) and [Firefox](/guides/browsers/firefox-extension) guides.

## The relay protocol

Extensions dial **into** Navigator's `/relay` WebSocket; Navigator provides the gateway endpoint in return. The flow:

1. **`navigator-hello`** — extension announces its `browserName` (plus optional `platform`, `extensionVersion`, `bidiOrigin`).
2. If it presents a **session token** that matches a known pairing → immediately `connected` with the same token (silent reconnect).
3. Otherwise Navigator prints a one-time **PIN** to the navigator console (box-drawing block, ~60s expiry) and sends `pin_required`.
4. Extension sends `pin`; on success Navigator replies `connected` with a **session token**; on wrong/expired PIN it fails the socket (4000).

Session tokens are **durable** — persisted in SQLite (`relay_sessions` table, restored in `init()`), so a Navigator restart never forces a re-PIN. A token that is stale or belongs to a different browser rejects the connection outright (4001) — never silently re-pairs. PINs are in-memory and one-time.

After pairing, the socket carries:

| Message | Direction | Purpose |
|---|---|---|
| `ping` / `pong` | both | Heartbeat (~15s interval, ~45s idle timeout kills a dead socket) |
| CDP commands | ext ← navigator | `{ id, method, params }` forwarded to the browser |
| CDP responses | ext → navigator | correlated by id |
| `cdp_event` | ext → navigator | browser-level CDP events |
| `tab_list` / `tab_detached` | ext → navigator | tab bookkeeping so Navigator reflects the real browser |

Command forwarding times out at 60s with an explicit error (a healthy-but-slow command is never false-faulted). `Target.createTarget` retries the created-tab attach a few times so a socket flap between ack and attach doesn't hang puppeteer's 30s wait.

## The gateway

Navigator-side puppeteer does **not** dial the extension directly — it connects to Navigator's own unauthenticated pure-CDP gateway:

```
ws://<host>:<port>/browser/<name>
```

The gateway speaks browser-level CDP to puppeteer and translates every command into `/relay` traffic for the extension (`relayServer.attachGatewayClient`). Same code path serves the authenticated [CDP sharing](/reference/browsers/cdp-sharing) `/cdp/<name>` surface. Auth lives only on `/relay`; the gateway is intentionally unauthenticated (same trust boundary as `/extract`).

## Chrome (`chrome-extension/`)

- Uses the **`chrome.debugger` API** — true CDP, so the full devtools surface works.
- The session token lives in `chrome.storage.local`; reconnects reuse it.
- **MV3 service worker** — the SW goes dormant in seconds and no alarm reliably wakes it. If the SW target is not findable (e.g. `/json/list` shows no `service_worker`), relaunch Chromium with a fresh profile. The extension ID is path-derived and not stable across rebuilds — discover it each run, never hardcode.
- Automation-created tabs are grouped under **"Navigator: \<browserName\>"** (collapsed, blue) so they don't clutter the user's tab bar.
- **Open in window** — the popup's option maps `Target.createTarget` to `chrome.windows.create` (real OS window, `window-<id>` context), and `closeTarget` closes the window when it's the last CDP-created tab. When off, behavior is byte-for-byte tabs + mock contexts.

## Firefox (`firefox-extension/`)

- Firefox has **no `chrome.debugger`** and its built-in CDP (remote agent) is being removed from recent releases — so the extension bridges **WebDriver BiDi** at `ws://127.0.0.1:9222/session`, mapping CDP → BiDi client-side (`cdp/bidi/mapper.js`): `Page.navigate` → `browsingContext.navigate`, `Runtime.evaluate` → `script.evaluate`, `Target.createTarget` → `browsingContext.create`, `Input.*` → `input.performActions`; BiDi events → CDP events (`browsingContext.load` → `Page.loadEventFired`, …).
- Firefox quirks are answered **locally** (no-op `Browser.*`, `SystemInfo.*`, `Network.enable`…) or surface as clean CDP errors (`-32601`) — never hangs.
- **Origin pinning** — Firefox's Remote Agent strictly matches the WebSocket `Origin:` header against `--remote-allow-origins=moz-extension://<uuid>` (no wildcards). A freshly temporary-loaded add-on gets a **random uuid per load**; use a stable profile install so the pinned value keeps matching. `launch-firefox.sh` captures and uses the correct uuid.
- **One active BiDi session per Firefox process.** An un-cleanly-ended session (aborted probe, second client) orphans the single slot and the extension fails with `BiDi not connected`; recovery is relaunching Firefox with `--remote-debugging-port`. A `session.new` probe succeeding means the extension is *not* holding the session; failing with "session already started" means it is connected.
- **Open in window** — `browsingContext.create({ type: "window" })`; window-created contexts are exempt from tab isolation (which would otherwise hide the only tab of a fresh window). `createBrowserContext` returns a lazy `window-<ts>` id.
- `puppeteer-core.connect` to the raw relay gateway also covers `Browser.close` override and adopted-tab semantics — changing these sits in the extension's relay protocol, not in the browser bridge.

## Development & testing

**Chrome:**
- Dev container (`chrome-extension/Dockerfile` + `docker-compose.yml`) — headed Chromium under Xvfb, loads the extension unpacked, exposes CDP on `9333:9222` and VNC on `5900`, joins the navigator network so it can dial `navigator:1994/relay`.
- Automated pairing — `node test/e2e-pair.mjs` runs the whole PIN flow against a live navigator relay via CDP (PIN read from `GET /stats` → `relay.pending[0].pin`).
- Unit tests — `node test/unit-ext.mjs` (mock relay, no Chrome needed); `node test/mock-relay-server.mjs 9515` simulates Navigator's `/relay`.
- Pack — `./pack.sh` produces `dist/navigator-browser-relay.crx`. The signing key `chrome-extension-key.pem` defines the extension ID and is reused across runs so updates install over the previous version — never lose or share it.

**Firefox:**
- `node firefox-extension/test/unit-ff.mjs` — 17 unit tests, mock-only, fast (handshake, hello, PIN, routing, translate+transform, event mapping, `-32601` for unmapped methods).
- `node firefox-extension/test/mock-bidi-server.mjs` — interactive Fake Remote Agent for manual smoke.
- `node firefox-extension/test/bidi-direct.mjs` — drives a real Firefox via BiDi (always `session.end`).
- `./pack-firefox.sh` — packed `.zip` installable build.

## Known caveats

- **Log/keepalive contract:** never delete transports from `mcpTransports` inside the keepalive outer catch; the SDK cleans up dead sessions via its own `onclose`.
- **Adopted user tabs:** `Target.closeTarget` on an adopted `origin: "browser"`/`ownership: "user"` tab releases Navigator's handle only — the user's real tab stays open.
- **Wedged sessions:** repeated attaches can leave stale `chrome.debugger` sessions on the Chrome side; `GET /debug/detach_all` sends `detach_all` to every extension to clear them.

## STATUS — what's verified

Working: BiDi handshake + subscribe, CDP ⇄ BiDi translation for the core page surface (`Page.navigate`/`reload`, `Target.createTarget`, `Runtime.evaluate`/`callFunctionOn`, `Page.captureScreenshot`, `Input.*`, DOM inspection), CDP event stream with per-session tagging, `-32601` errors instead of hangs.

Still open (Phase 2+): real-Firefox end-to-end validation of the full extension ↔ Remote Agent ↔ navigator relay dance; object-handle (`RemoteObject.objectId`) bridging across BiDi realms; stable origin pinning for temporary loads.
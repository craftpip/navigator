# Plan 38 — Remote Browser: Use Your Real Chrome

**Status:** Phase 1 (standalone extension) **complete, 11/11 unit tests + E2E verified** — awaiting manual Chrome test & navigator integration (Phase 3)
**Created:** 2026-08-26
**Last updated:** 2026-08-28

---

## Current Progress (2026-08-28)

### Location decision (made with user)
- Extension lives in `/www1/navigator/chrome-extension/` — a **new standalone subfolder inside the navigator repo**, NOT a separate folder in `/www1`. Confirmed by user: *"make it in sub folder in this project"*.
- **No existing navigator code is touched** — Phase 1 builds only in `chrome-extension/`. Navigator integration begins ONLY when told (see Phase 3).
- Reference clone of upstream cdp-tunnel kept at `/www1/cdp-tunnel-ref` for reading (to be removed later).

### Architectural decision for the fork
Build a **streamlined, navigator-specific extension** — NOT a wholesale copy of cdp-tunnel's multi-connection server architecture. Keep:
- WebSocket relay bridge (`chrome.debugger` → WebSocket)
- CDP command routing (LOCAL / SPECIAL / FORWARD handler pattern)
- Tab group isolation for automation-created tabs

Simplified:
- **Single WebSocket connection** to navigator's `/relay` endpoint (cdp-tunnel had N connections with a server proxy; navigator IS the relay)
- **PIN pairing** + session token for reconnection (per plan §6)
- **`chrome.tabs.query()`** for tab listing instead of `chrome.debugger.getTargets()` (simpler, more reliable)
- Browser name + server URL in `chrome.storage.local`

### Files built — Phase 1 COMPLETE (2026-08-28)
All in `/www1/navigator/chrome-extension/` (24 files + README):

```
chrome-extension/
├── manifest.json            — MV3, "Navigator Browser Relay" v0.1.0, debugger/tabs/storage/alarms/tabGroups perms
├── background.js            — service worker entry + importScripts + message handlers + SW keepalive alarm
├── popup.html / popup.js    — browser name field, server URL field, PIN entry, connect button, tab list
├── utils/
│   ├── config.js           — serverUrl/browserName/sessionToken/autoConnect in chrome.storage.local
│   ├── logger.js           — prefixed console logger
│   └── helpers.js          — CDPUtils (session id gen, tab group helpers)
├── core/
│   ├── state.js           — connection state, attached tabs, CDP-created tabs, currentTabId, heartbeat
│   ├── connection-manager.js — WS lifecycle, hello/handshake, PIN flow, reconnect codes 4000/4001, dispatch
│   └── debugger.js        — chrome.debugger attach/detach/sendCommand bridge + CDP event forwarding
├── cdp/
│   ├── response.js        — CDP response builder ({ id, result|error, sessionId })
│   ├── index.js           — CDP_HANDLERS registry (LOCAL/SPECIAL/FORWARD) via routeCDPCommand()
│   └── handler/
│       ├── local.js       — Browser.* / SystemInfo.* / Target browser-level mocks
│       ├── special.js     — Target.createTarget/attachToTarget/detachFromTarget/closeTarget + tab groups
│       └── forward.js     — chrome.debugger.sendCommand forwarding (incl. ensureVisible for input)
├── features/
│   ├── tab-list.js        — chrome.debugger.getTargets() listing as CDP targetInfos
│   ├── tab-isolation.js   — automation tabs in a "Navigator: <name>" tab group (collapsed blue)
│   └── badge.js          — toolbar badge (ON/PAIR/ERR/OFF)
├── icons/                — generated 16/48/128 PNGs + gen-icons.cjs (pure-node, no deps)
├── README.md             — protocol table + standalone test instructions
└── test/
    ├── unit-ext.mjs      — Node vm test harness (mocked chrome + paired FakeWebSocket)
    └── mock-relay-server.mjs — simulates navigator's /relay endpoint (WS, PIN pairing, CDP drive)
```

### Verification
- **Unit tests: 11/11 passing** — `node test/unit-ext.mjs`: module load, config round-trip, hello handshake, pin_required state, PIN round-trip + token storage, CDP local reply (Browser.getVersion), CDP forward (Runtime.evaluate), TabList, TabIsolation, Target.createTarget, token reuse on reconnect.
- **E2E over a real WebSocket:** `node test/mock-relay-server.mjs 9515 --pin 201648` + a bare `ws` client completed: `navigator-hello` → `pin_required` → `pin` → `connected` (token issued) → `client-connected` → `list_tabs_request` → `tab_list` → CDP `Browser.getVersion`/`Target.getTargets` → `ping`. Wrong PIN rejected with close code 4000.
- Mock server usage: `node test/mock-relay-server.mjs [port] [--pin 123456]`.

### Known issues / notes
- Revert hazard: earlier file-tree nodes (state.js CDP-created/current-tab methods, cdp/handler/* content, tests 10–11) vanished at some point in the 2026-08-28 session — re-added. Verified clean via read tool + python; no ghost `universal.js` exists.
- Fixed: `Connection.send` → `ConnectionManager.send` (4 references across core/).
- Fixed: `chrome.debugger.getTargets` used as a Promise in special.js but it's callback-based (incl. Chrome 116+ Promise return) — added `promisifyGetTargets()`.
- Fixed: `ctx._state` was the raw state data object, but handlers need the `State` module API (e.g. `addCDPCreatedTab`, `isTabAttached`). `routeCDPCommand` now builds a facade (`Object.create(State)` + copied fields); sessionId→tabId/targetId maps seeded on canonical raw state so they survive facade rebuilds per command.
- Test harness: FakeWebSocket `_sent` array records each side's outbound; assert from the *client* side for hello/pin/replies. `process.exit()` needed because the connected-heartbeat `setInterval` keeps Node alive.

### Next steps
1. ✅ ~~cdp/ (response.js, index.js, handler/*)~~ — done
2. ✅ ~~features/ (tab-list, tab-isolation, badge)~~ — done
3. ✅ ~~background.js (entry + importScripts + handlers)~~ — done
4. ✅ ~~popup (html + js)~~ — done
5. ✅ ~~Test standalone with a mock WebSocket server~~ — unit 11/11 + E2E verified
6. **Manual browser test (pending user):** `chrome://extensions` → Load unpacked → connect to `ws://localhost:9515`, complete PIN flow in the popup.
7. **Phase 3 (ONLY when told):** navigator-side integration — /relay endpoint, BrowserManager route, MCP tools, console UI.

---

---

## Problem

Navigator has 3 built-in browser backends (CloakBrowser, Chromium, Lightpanda) — all internal, all headless, all fresh profiles. Users want to control **their own Chrome** — with their real logins, cookies, sessions, and extensions — from the navigator server. This makes the user's browser a 4th, pluggable backend.

## Solution

Fork [CDP Tunnel](https://github.com/dyyz1993/cdp-tunnel) as `navigator-chrome-extension`. Bundle the relay server into navigator. Each Chrome instance runs the extension, which connects to the relay. Navigator connects to all relay endpoints simultaneously and routes commands by browser name.

```
User's Chrome                          Navigator Server
┌─────────────────────┐               ┌──────────────────────────┐
│  Navigator Extension │               │                          │
│  ┌───────────────┐  │  WebSocket    │  Relay Server (:9221+)   │
│  │ chrome.debugger├──┼──────────────┤  CDP endpoint            │
│  └───────────────┘  │               │                          │
│  Name: "Chrome Dev" │               │  BrowserManager          │
│  Port: 9221         │               │  puppeteer.connect()     │
└─────────────────────┘               │                          │
                                      │  MCP Tools               │
┌─────────────────────┐               │  web_search, web_fetch,  │
│  Navigator Extension │  WebSocket   │  devtools (19), etc.     │
│  Name: "Personal"   ├──┼───────────┤                          │
│  Port: 9222         │               │  Console UI              │
└─────────────────────┘               │  Connected browsers list │
                                      └──────────────────────────┘
```

## Architecture

### 1. Navigator Chrome Extension (forked from CDP Tunnel)

**Location:** `chrome-extension/` (new directory in navigator repo)

**What we keep from CDP Tunnel:**
- Extension structure (manifest.json, service worker, popup)
- `chrome.debugger` API bridging to WebSocket
- Tab group isolation (automation tabs separate from user tabs)

**What we change:**
- Rebrand to "Navigator" (icons, naming)
- Extension popup adds: browser name field, navigator server URL field
- Extension stores config in `chrome.storage.local`
- Auto-connect to navigator on start
- Show connection status (green/red dot) in popup and toolbar badge

**Extension popup UX:**
```
┌──────────────────────────────┐
│  Navigator Browser Relay     │
│                              │
│  Browser Name:               │
│  [Chrome Dev            ]    │
│                              │
│  Navigator Server URL:       │
│  [ws://10.69.1.164:1994]     │
│  (auto-filled for localhost) │
│                              │
│  [  Connect  ] ● Connected  │
│                              │
│  Status: Ready               │
└──────────────────────────────┘
```

**How the extension works:**
1. User fills in browser name and navigator server URL
2. Clicks "Connect" — extension opens WebSocket to navigator at `/relay` endpoint
3. Navigator registers the browser (name, IP, connection)
4. Navigator can now route CDP commands through this connection
5. Extension bridges CDP commands: navigator → `chrome.debugger.attach()` → Chrome renders

**Multiple instances:** User installs the extension in multiple Chrome profiles (Dev, Personal, etc.). Each gets its own name. Each connects to the same navigator server. Navigator tracks all connections.

### 1.5 Tab Listing and Control

The extension exposes all open tabs in the user's Chrome — not just automation-created tabs.

**How it works:**
1. Extension periodically calls `chrome.debugger.getTargets()` → returns all tabs (title, URL, id)
2. Sends tab list to navigator through the relay
3. Navigator stores the list and exposes it via console + MCP tools
4. User or LLM can pick any tab to attach to
5. Extension calls `chrome.debugger.attach(tabId)` to gain CDP control of that tab
6. Navigator routes CDP commands to that specific tab
7. When done, extension calls `chrome.debugger.detach(tabId)`

**Console UX:**
```
My Chrome Dev — Open Tabs:
  ● GitHub — github.com/user/repo     [Attach]
  ● Gmail  — mail.google.com/mail     [Attach]
  ● Jira   — jira.example.com/...     [Attach]

Attached to: GitHub
  [Take screenshot] [Read page] [Navigate] [Detach]
```

**LLM usage:**
> "Show me my open tabs" → lists all tabs from all connected browsers
> "Take a screenshot of my GitHub tab" → attaches, screenshots, detaches
> "What's on my Gmail?" → attaches, reads page content, detaches

**Tab group isolation:** The extension keeps automation-created tabs in a separate Chrome Tab Group. User's existing tabs are in their normal groups. Both are visible but clearly separated.

**New devtools tools (or extensions to existing ones):**
- `browser_listTabs` — list all tabs across connected browsers
- `browser_attachTab` — attach to an existing user tab
- `browser_detachTab` — detach from a tab

**Important:** `chrome.debugger.getTargets()` only returns tabs the extension has permission to see. By default, this is all tabs in the browser. The extension respects Chrome's tab permissions.

### 2. Navigator as the Relay

**Navigator IS the relay.** No separate process. The existing HTTP/WebSocket server gains a `/relay` WebSocket endpoint.

**Flow:**
```
Extension ←→ ws://navigator:1994/relay ←→ Navigator ←→ puppeteer ←→ MCP Tools
```

**How it works:**
1. Extension connects to `ws://navigator:1994/relay` and sends `{ name: "Chrome Dev" }`
2. Navigator registers the connection in `remoteBrowsers` Map
3. When a tool needs the remote browser, navigator calls `puppeteer.connect({ browserWSEndpoint: ... })` to its own `/relay` endpoint
4. Puppeteer sends CDP commands → Navigator forwards them to the extension → Extension calls `chrome.debugger` → Chrome executes
5. Chrome's responses flow back: Chrome → Extension → Navigator → Puppeteer → Tool

**Navigator manages:**
- Multiple simultaneous extension connections (one per Chrome instance)
- CDP message routing (which puppeteer client talks to which extension)
- Tab lifecycle (create, navigate, close)
- Heartbeat / connection status

```js
// In src/mcp-server.js or new src/remote-relay.js
// WebSocket upgrade handler for /relay endpoint
wss.on('connection', (ws, req) => {
  // Extension sends { name: "Chrome Dev" }
  // Navigator registers: remoteBrowsers.set("Chrome Dev", { ws, status: 'connected' })
  // Navigator forwards CDP messages between this ws and puppeteer clients
});
```

### 3. BrowserManager Changes

**File:** `src/browser.js`

Add a fourth backend: `remote`.

```js
// New method in BrowserManager
async _newRemotePage(browserName) {
  const remoteBrowser = this.remoteBrowsers.get(browserName);
  if (!remoteBrowser) throw new Error(`Remote browser "${browserName}" not connected`);
  // Connect to our own /relay endpoint — the extension is on the other side
  const browser = await puppeteer.connect({
    browserWSEndpoint: `ws://${this.config.host}:${this.config.port}/relay?name=${encodeURIComponent(browserName)}`,
  });
  return browser.newPage();
}
```

**Changes to `newPage()`:**
```js
// Current dispatch:
if (engineRoute === 'cloakbrowser') → _newCloakbrowserPage()
if (engineRoute === 'chromium')      → _newChromiumPage()
if (engineRoute === 'lightpanda')    → _newLightpandaPage()
// NEW:
if (backend === 'remote')            → _newRemotePage(browserName)
```

**New config:**
- `REMOTE_BROWSER_NAME` — which remote browser to use for web_fetch/screenshots (default: first connected)

**`remoteBrowsers` Map:** Tracks all connected remote browsers with their names, WebSocket connections, and status.

### 4. Devtools Changes

**File:** `src/devtools.js`

`Target.createTarget` needs to support the `remote` backend:
```js
// When backend is 'remote':
// Use puppeteer.connect() to /relay endpoint
// Create a new tab via browser.newPage()
// Register in targetsById as usual
```

All 19 devtools tools work unchanged because they operate on Puppeteer `page` objects — the connection method is irrelevant.

### 5. Console UI Changes

**File:** `web-console/src/main.jsx`

Add a **Connected Browsers** panel in the console:

```
┌──────────────────────────────────────────┐
│  Connected Browsers                      │
│                                          │
│  ● Chrome Dev       connected 2s ago     │
│    [Use for web_fetch] [Use for devtools]│
│                                          │
│  ● Chrome Personal  connected 5s ago     │
│    [Use for web_fetch] [Use for devtools]│
│                                          │
│  ○ Firefox          disconnected 3m ago  │
└──────────────────────────────────────────┘
```

**Features:**
- Real-time status (green = connected, gray = disconnected)
- Heartbeat via WebSocket ping/pong (no separate endpoint)
- Assign which browser is used for web_fetch and devtools
- Show browser name, connection time

### 6. Connection Protocol

**PIN-based authentication — prevents unauthorized LAN connections:**

```
Extension                              Navigator
  │                                       │
  │─── { name: "Chrome Dev" } ──────────→│  (connection request)
  │                                       │
  │                                       │  (generates PIN: 847291)
  │                                       │  (shows PIN in console)
  │                                       │
  │←── { pin: 847291 } ─────────────────│  (extension user enters PIN)
  │                                       │
  │  (PIN verified)                       │
  │←── { ok: true, id: "browser-uuid" } ─│  (connection established)
  │                                       │
  │←──── CDP commands ──────────────────│  (navigator sends when needed)
  │──── CDP responses ──────────────────→│  (extension responds)
```

**How it works:**
1. Extension opens WebSocket to `ws://navigator:1994/relay`
2. Extension sends handshake: `{ name: "Chrome Dev" }`
3. Navigator generates a 6-digit PIN, stores it with expiry (60s), shows it in console
4. Navigator sends back: `{ pinRequired: true }`
5. User sees PIN in navigator console, enters it in extension popup
6. Extension sends: `{ pin: "847291" }`
7. Navigator verifies PIN → registers browser in `remoteBrowsers` Map
8. Connection stays open, CDP messages flow both ways

**Security details:**
- PIN is 6 digits, random, expires in 60 seconds
- PIN shown in navigator console only (not exposed via API)
- Failed PIN = connection rejected, new PIN required
- Each connection attempt gets a fresh PIN
- Already-connected browsers don't need PIN again (reconnection uses stored session ID)

**Console shows:**
```
🔐 Chrome Dev wants to connect
   PIN: 847291 (expires in 60s)
   Enter this PIN in the Chrome extension to authenticate.
```

**Reconnection:** After initial pairing, extension stores a session token. On reconnect, it sends the token instead of going through PIN again. Token invalidated if navigator restarts.

### 7. Network Topology

| Scenario | Setup |
|---|---|
| Same machine | Extension auto-fills `ws://localhost:1994/relay` — zero config |
| Same LAN | Extension enters `ws://10.69.1.164:1994/relay` |
| Remote (different network) | SSH tunnel: `ssh -R 1994:localhost:1994 user@server`, then extension uses `ws://localhost:1994/relay` on server |

### 8. Tool Support Matrix

| Tool | Supported? | Notes |
|---|---|---|
| `web_search` | Yes | Uses pooled tabs via relay |
| `web_fetch` | Yes | Navigate + extract via relay |
| `web_page_screenshot` | Yes | `page.screenshot()` via relay |
| `web_page_ascii` | Yes | `page.evaluate()` + screenshot via relay |
| `web_page_svg` | Yes | `page.evaluate()` via relay |
| `web_page_links` | N/A | In-memory, no browser needed |
| Devtools `Target.*` | Yes | `browser.newPage()` via relay |
| Devtools `DOM.*` | Yes | `page.evaluate()` via relay |
| Devtools `Runtime.*` | Yes | `page.evaluate()` via relay |
| Devtools `Input.*` | Yes | `page.mouse.click()` / `page.keyboard.press()` via relay |
| Devtools `Network.*` | Yes | `page.on('request')` via relay |
| Devtools `Page.*` | Yes | `page.goto()` / `page.reload()` via relay |

**One caveat:** `createWindowPage()` in browser.js uses raw CDP `session.send("Target.createTarget", { newWindow: true })` to create new **windows** (not tabs). With remote browsers, we fall back to `browser.newPage()` (new tab in existing window). This is fine — tabs work identically.

### 9. Security

- Extension only exposes tabs it creates (not user's existing tabs) — CDP Tunnel's tab group isolation
- WebSocket connection from extension to navigator is local or tunneled — no open ports to the internet
- API key authentication for remote relay connections
- Navigator console shows which browser is being controlled — user always knows
- No CDP commands execute without an active extension connection

### 10. Implementation Steps

**IMPORTANT: Do NOT touch navigator code until explicitly told. Build the extension first.**

#### Phase 1: Chrome Extension (standalone, no navigator changes)
1. Fork CDP Tunnel into `chrome-extension/` directory
2. Rebrand: icons, names, popup UI
3. Add browser name field and navigator server URL field to popup
4. Implement PIN-based pairing flow (extension side)
5. Implement CDP command bridging via `chrome.debugger`
6. Implement tab listing via `chrome.debugger.getTargets()`
7. Implement session token storage and reconnection
8. Test extension standalone with a mock WebSocket server

#### Phase 2: Firefox Extension (standalone, no navigator changes)
1. Port extension to Firefox MV3
2. Build Firefox-specific CDP translation layer
3. Test all devtools tools against Firefox
4. Handle Firefox-specific quirks

#### Phase 3: Navigator Integration (ONLY when told)
1. Add `/relay` WebSocket upgrade handler to existing HTTP server in mcp-server.js
2. Create `src/remote-relay.js` — manages extension connections, CDP message routing, PIN generation
3. Add `remoteBrowsers` Map to BrowserManager
4. Add `puppeteer.connect()` path in `newPage()` when backend is `remote`
5. Add `REMOTE_BROWSER_NAME` config
6. Add PIN display in console
7. Add "Connected Browsers" panel in console UI

#### Phase 4: Devtools Integration (ONLY when told)
1. Update `Target.createTarget` to support `remote` backend
2. Update `DEVTOOLS_BROWSER_BACKEND` to accept `remote`
3. Test all 19 devtools tools against remote browser

#### Phase 5: Testing and Docs (ONLY when told)
1. Test with Chrome on same machine
2. Test with Chrome on different machine (SSH tunnel)
3. Test multiple browsers simultaneously
4. Update AGENTS.md with remote browser docs
5. Add to docker-compose.yml (port mapping if needed)

### 11. Open Questions

- **Extension distribution:** Ship as .crx file? Or load-unpacked only? Chrome Web Store requires $5 developer fee and review process.
- **Browser domain gaps:** `chrome.debugger` doesn't support `Browser` domain or `Target` domain — need to verify all navigator's CDP usage works without these.
- **Concurrency:** What happens when two tools try to use the same remote browser simultaneously? Need page slot limiting like existing backends.

### 12. Firefox Support (Phase 2)

After Chrome is working, port the extension to Firefox.

**How it works:** Firefox supports `browser.debugger` (same WebExtensions API as Chrome's `chrome.debugger`). Firefox has all the same capabilities — navigation, DOM, screenshots, input — but uses different internal APIs and function names than Chrome's CDP.

**The extension becomes a translation layer:**
- CDP command arrives from navigator
- Extension checks if Firefox's `browser.debugger` supports it natively
- If yes: forward as-is
- If no: translate to Firefox's equivalent API, return same CDP response format

**Examples:**
| CDP Command | Chrome | Firefox |
|---|---|---|
| `Page.captureScreenshot` | Native CDP | Firefox screenshot API |
| `Runtime.evaluate` | Native CDP | Firefox evaluation API |
| `Input.dispatchMouseEvent` | Native CDP | Firefox input simulation |
| `Page.navigate` | Native CDP | Firefox navigation API |
| `DOM.getDocument` | Native CDP | Firefox DOM API |

**Extension structure:**
```
chrome-extension/
├── chrome/          # Chrome-specific shims
├── firefox/         # Firefox-specific shims
├── shared/          # Common relay logic, popup, handshake
└── manifest.json    # Chrome MV3 / manifest_firefox.json
```

**What needs to be built:**
1. Port extension to Firefox MV3
2. Build Firefox-specific CDP translation layer
3. Test all 19 devtools tools against Firefox
4. Test web_search, web_fetch, screenshots against Firefox
5. Handle Firefox-specific quirks (different tab handling, different debugger API behavior)

**What should work without changes:**
- Extension relay logic (WebSocket connection to navigator)
- Navigator-side code (it talks pure CDP, doesn't know which browser)
- Console UI (shows Firefox as a connected browser)

**What needs Firefox-specific work:**
- CDP command translation in the extension
- Tab group isolation (Firefox handles this differently)
- Some Input domain commands may need workarounds

**Decision:** Build Chrome first, validate the architecture, then port to Firefox. The shared relay logic stays the same — only the CDP translation layer changes.

# 56 — "Open Windows Instead of Tabs" checkbox (Chrome + Firefox extensions)

**Status:** Implemented 2026-09-12 — all checklist items done. Chrome + Firefox extensions, relay pass-through, unit suites green, packed, manual Chromium smoke passed (both checkbox states).
**Created:** 2026-09-12
**Scope:** `chrome-extension/`, `firefox-extension/`, plus small `src/relay-server.js` pass-through. No devtools or web-console changes required for the core feature.

---

## 1. Goal

Add a checkbox to both extension popups. When **checked**:

- `Target.createTarget` opens a **new browser window** (with the requested page) instead of a tab in the current window.
- `Target.createBrowserContext` stops being a mock and backs a real (window-scoped) *"browser context"*, so `browser.createBrowserContext().newPage()` from the client also lands in its own window.
- Tab/window lifecycle follows: `Target.closeTarget` closes the window when its (CDP-created) tab is the last one left; `Target.activateTarget` and `Browser.getWindowForTarget/bounds` keep working accurately since they are already per-window.
- `Target.getTargets` / tab lists report the real `windowId` and a `browserContextId` (`window-<id>`) for window-created targets, so the client can group/drive them coherently.

When **unchecked**, behavior is byte-for-byte today's (old tabs, mock contexts).

The toggle is a **per-extension preference** (no MCP tool param): any downstream `Target.createTarget` / `createBrowserContext` inherits the window behavior while the flag is on.

---

## 2. Decisions made (with alternatives)

| # | Decision | Rationale / alternative |
|---|---|---|
| 1 | Flag is a **stored config** key voted at call time by the handler (not a per-command param). | "translate the tab to window" → the extension warps the *behavior*, all commands. A `newWindow` param exists only as a second trigger (Chrome Add). Alternative rejected: relay-level flag (would need per-BROWSERS config + schema change; slower to land). |
| 2 | **Chrome**: real window per `createTarget` via `chrome.windows.create`, tracked as `window-<id>` contexts. | `chrome.windows` needs no permission. Alternative rejected: `incognito` contexts (wrong semantics — that's isolation, not window layout, and needs the `incognito` permission). |
| 3 | **Firefox**: force BiDi `browsingContext.create({type:'window'})` when the flag is on. | Firefox already supports `params.newWindow → 'window'` (special.js:26); the flag just forces it on. Window close is automatic via `browsingContext.close` of a top-level window context. |
| 4 | **Firefox skips `TabIsolation.isolate`** for window-created tabs. | Hiding the only tab in a fresh window leaves the user staring at an empty window. |
| 5 | Relay only gains a **thin pass-through** (`getBrowserContexts` forwarded; `browserContextId` preserved from extension results). | The contexts/windows live on the extension side; the relay already forwards unknown Target.* to the extension. Alternative rejected as over-engineering: relay-managed window registry + per-context tab lists. |
| 6 | `browserContextId` for a window target = `"window-" + windowId`. | Stable, reversible, debuggable. |

---

## 3. Current state (verified 2026-09-12)

### Chrome (`chrome-extension/`)

- **`Target.createTarget`** — `cdp/handler/special.js:62-97`: `chrome.tabs.create({url:'about:blank', active:false})` → marks `cdpCreatedTabIds` → `addTabToAutomationGroup` (collapsed `Navigator: <browser>` group) → `waitForTargetByTabId` (2s) → optional `chrome.tabs.update` to URL → resolves `{targetId, tabId, url, _sayGoodbye}`.
- **`Target.createBrowserContext`** — `cdp/handler/local.js:51-66`: fabricated `context-<ts>-<rand>`, `_mock:true`, "all tabs share one context". `getBrowserContexts` → `['default']`; `disposeBrowserContext` → `{}`. `browserContextId` on `createTarget` is accepted but ignored.
- **`Target.closeTarget`** — `cdp/handler/special.js:115-130`: `resolveTabId` → `chrome.tabs.remove(tabId)` → `{success:true}` (error-swallowing).
- **`Target.activateTarget`** — `special.js:99-113`: `chrome.tabs.update(tabId, {active:true})` (focuses the tab's window natively).
- **`Browser.getWindowForTarget` / getWindowBounds / setWindowBounds** — SPECIAL handlers, already compute the tab's real `windowId` and call `chrome.windows.get/update`. No change needed.
- **`Target.getTargets` / tab list** — `features/tab-list.js` `getAllAsTargets` + `mapToTargetInfo` (lines 58-71): emits `targetId, type, title, url, attached, canAccessOpener, openerId, browserContextId:'default', tabId`. **No `windowId` emitted** (available from `chrome.tabs.get(tabId)`).
- **Config** — `utils/config.js` callback-pattern over `chrome.storage.local`. No `openInWindow` key yet.
- **Popup** — `popup.html` + `popup.js` at extension root; inline CSS. No settings toggles today.
- **Manifest** — permissions `debugger, tabs, storage, alarms, tabGroups`. `chrome.windows` requires no extra permission.

### Firefox (`firefox-extension/`)

- **`Target.createTarget`** — `cdp/handler/special.js:22-48`: `BidiClient.send('browsingContext.create', { type: params.newWindow ? 'window' : 'tab' })` → `noteContextCreated` (FIFO pair with `tabs.onCreated`) → optional `browsingContext.navigate(wait:'interactive')` → `{targetId: contextId}`. **Already new-window capable.**
- **`Target.createBrowserContext`** — `cdp/handler/local.js:52-67`: same mock as Chrome.
- **`Target.closeTarget`** — `special.js:63-79`: resolveContext → `browsingContext.close({promptUnload:false})` (closing a top-level window context closes the window) → `detachForTab`.
- **`Target.activateTarget`** — `special.js:50-61`: `browsingContext.activate`.
- **Tab hiding** — `core/session-manager.js:handleTabCreated` → `TabIsolation.isolate(tabId)` hides every CDP-created tab (`features/tab-isolation.js`: `chrome.tabs.hide`). Firefox has no tab groups.
- **Config** — same pattern + `bidiUrl`. Popup has a hidden BiDi box.

### Relay (`src/relay-server.js`)

- **`Target.getBrowserContexts`** — `_onGatewayMessage` case at 798-803 **intercepts and hardcodes** `{browserContextIds:['default']}`; never reaches the extension.
- **`Target.createBrowserContext` / `Target.destroyBrowserContext`** — **not handled**, fall through `default:` (817-819) → forwarded to the extension (which mocks).
- **`_registerCreatedTarget`** (860-890) — builds the client-facing `info` and **hardcodes `browserContextId:'default'`**; `_onCdpResponse` createTarget branch (1122-1166) holds the ack until attach and passes `{targetId, tabId, url}` only.
- **`_onTabList`** (650-664) — replaces `entry.tabs` with whatever `tab_list` carries (extension-built infos).

---

## 4. Design

### 4.1 Config key (both extensions)

`openInWindow: boolean`, stored in `chrome.storage.local`, default `false`.

Chrome `utils/config.js`:
```js
getOpenInWindow: function(callback) {
  chrome.storage.local.get(['openInWindow'], function(result) {
    callback(result.openInWindow === true);
  });
},
setOpenInWindow: function(enabled, callback) {
  chrome.storage.local.set({ openInWindow: !!enabled }, callback || function() {});
}
```
Firefox `utils/config.js`: identical.

### 4.2 Popup checkbox (both)

A settings row above the Connect button:

```html
<label class="field toggle-field">
  <input type="checkbox" id="openInWindow">
  <span>Open new windows instead of tabs</span>
</label>
```

- `popup.js loadState()` reads `Config.getOpenInWindow(cb)` and sets the checkbox (without clobbering while the user is mid-edit — same dirty-guard pattern as `_urlDirty`).
- `change` listener → `Config.setOpenInWindow(checked)` (immediate, no reload needed). Also broadcast a trivial `stateUpdate` so any open popup reflects it.

### 4.3 Chrome — window mode logic

**Helper module-level (Chrome `special.js` / `state.js`):** track CDP-created windows so close/list can identify them:

```js
// state.js
state.cdpWindows = new Map(); // browserContextId "window-<id>" -> { windowId, targetCount }
```

**`targetCreateTarget(context)`** (special.js:62) — becomes config-aware:

```js
function targetCreateTarget(context) {
  var params = context.params || {};
  var url = params.url || 'about:blank';
  var needsNavigate = url !== 'about:blank' && url !== '';
  var wantWindow = !!(params.newWindow ||
    (params.browserContextId && params.browserContextId !== 'default'));
  return Config.promisifiedGetOpenInWindow().then(function(flag) {
    var createInWindow = wantWindow || flag === true;
    return createInWindow ? createWindowTab(url, needsNavigate) : createPlainTab(url, needsNavigate);
  });
}
```

- `createPlainTab`: existing `chrome.tabs.create` flow unchanged (grouped, etc.).
- `createWindowTab`:
  1. `chrome.windows.create({ url: 'about:blank', active: false, focused: false, state: 'normal' })` → `win.id`, first tab `win.tabs[0].id` (Firefox-style new window, background).
  2. `state.addCDPCreatedTab(tabId)` + register `state.cdpWindows.set('window-'+win.id, { windowId: win.id, targetCount: 0 })`.
  3. **Skip** `addTabToAutomationGroup` (a lone tab in its own window needs no collapsed group).
  4. `waitForTargetByTabId(tabId, 2000)` → real debuggable targetId (fallback `String(tabId)`).
  5. If `needsNavigate`: `chrome.tabs.update(tabId, {url})`; resolve `{ targetId, tabId, url, windowId: win.id, browserContextId: 'window-'+win.id, _sayGoodbye:true }`. Else resolve with `url`.
  6. Bump `cdpWindows` count +1.
- The returned `browserContextId` lets the relay's `_registerCreatedTarget` record the real context.

**`targetCloseTarget(context)`** (special.js:115): after `resolveTabId` → `chrome.tabs.get(tabId)` → `tab.windowId`:
- If `state.cdpWindows` has `window-<windowId>` **and** the window's tab count is 1 → `chrome.windows.remove(windowId)` (then decrement/delete registry entry).
- Else keep `chrome.tabs.remove(tabId)` (Chrome auto-closes last-tab windows anyway, but explicit remove is deterministic).

**`targetCreateBrowserContext`** (local.js:51) — config-aware:
```js
function targetCreateBrowserContext() {
  return Config.promisifiedGetOpenInWindow().then(function(flag) {
    if (flag !== true) return legacyMock();
    return createWindowTargetContext();
  });
}
```
`createWindowTargetContext`:
1. `chrome.windows.create({ url: 'about:blank', active:false, focused:false, state:'normal' })`.
2. `browserContextId = 'window-' + win.id`; `state.cdpWindows.set(browserContextId, { windowId: win.id, targetCount:0 })`.
3. Return `{ browserContextId }` — **no** `_mock`, real window backing.

**`targetGetBrowserContexts`** (local.js) — `{ browserContextIds: ['default', ...state.cdpWindows.keys()] }` when flag on, else `['default']`.

**`targetDisposeBrowserContext(context)`** — if `params.browserContextId` matches a `cdpWindows` key → `chrome.windows.remove(windowId)` + delete registry entry; return `{}` (idempotent).

**`features/tab-list.js` `mapToTargetInfo`** — add `windowId`; compute `browserContextId`:
```js
windowId: tab ? tab.windowId : null,
browserContextId: (tab && State.cdpWindows.has('window-'+tab.windowId))
  ? 'window-' + tab.windowId : 'default'
```
(`getAllAsTargets` already has the `chrome.tabs.get` enrichment loop — thread the `tab` object into `mapToTargetInfo`.)

### 4.4 Firefox — window mode logic

**`targetCreateTarget`** (special.js:22): make it config-aware; force window:
```js
var wantWindow = !!(params.newWindow || (params.browserContextId && params.browserContextId !== 'default'));
return Config.promisifiedGetOpenInWindow().then(function(flag) {
  var type = (wantWindow || flag === true) ? 'window' : 'tab';
  return BidiClient.send('browsingContext.create', { type: type }).then(... existing ...);
});
```
- Skip `TabIsolation.isolate` for window-created contexts → thread a `createdAsWindow` flag through `noteContextCreated(contextId, {window:true})` → `handleTabCreated` pairs and only calls `TabIsolation.isolate(tabId)` when `!window`.
- Return `{ targetId: contextId }` (unchanged; BiDi context id is the targetId).
- Window close needs no work — `browsingContext.close` on a top-level window context closes the window.
- `createBrowserContext`: same config-aware change as Chrome, but Firefox window creation happens lazily — return `'window-' + Date.now()` id and ensure the actual window is created on the **next** `createTarget` with that context id (BiDi has no create-window-on-demand handle stored in a context id). Simpler and uniform: when flag on, `createBrowserContext` returns a fresh `{'window-<ts>'}` id AND the immediate side effect is that any subsequent `createTarget` uses `type:'window'` (window is created then). Firefox has no persistent window handle to pre-create, so this is functionally equivalent (each `newPage()` still lands in a fresh window).
- `getBrowserContexts` / `disposeBrowserContext`: as Chrome; dispose is a no-op best-effort for Firefox (the contexts are tied to their window; closing via `targetCloseTarget` covers it).

### 4.5 Relay — thin pass-through (`src/relay-server.js`)

1. **`Target.getBrowserContexts`** case (798-803): drop the hardcoded reply; **forward to the extension** and echo its `browserContextIds` (fallback `['default']` if reply errors):
   ```js
   case "Target.getBrowserContexts": {
     const res = await this._sendExtensionCommand(entry, { id, method: "Target.getBrowserContexts", params }, client.id);
     this._reply(client, id, { browserContextIds: (res && res.result && res.result.browserContextIds) || ["default"] });
     return;
   }
   ```
   (`_sendExtensionCommand` returns the decoded reply — verify the shape in the existing default case; alternatively reuse the default forward path and just stop intercepting.)
2. **`_registerCreatedTarget`** — thread `browserContextId` through:
   - `_onCdpResponse` createTarget branch: pass `browserContextId: msg.result.browserContextId || pending.params?.browserContextId || 'default'`.
   - `_registerCreatedTarget(...)`: use it in `info.browserContextId` instead of the hardcoded `'default'`.
3. No other relay change: `createBrowserContext` and `destroyBrowserContext` already fall through `default:` → forwarded to the extension.

### 4.6 Devtools surface (optional, out of core scope)

`Target.getTargets` / `listTargets` already echo whatever windowId/context the mobile tab info carries — window-created targets will show `browserContextId: window-<id>` automatically once the extension emits it. If desired later, add a `newWindow`/checkbox to the console target-creation UI — defer (not requested).

---

## 5. Behavior matrix ("handle it for other commands too")

| Command | Checkbox OFF | Checkbox ON |
|---|---|---|
| `Target.createTarget` | tab in current window (grouped) | new window (native OS window), tab ungrouped |
| `Target.createBrowserContext` | mock `context-*` id | real `window-<id>` context backed by a new window |
| `Target.getBrowserContexts` | `['default']` | `['default', ...]` window contexts (extension answers) |
| `Target.disposeBrowserContext` | `{}` no-op | closes the window |
| `Target.closeTarget` | `tabs.remove` (auto-closes last tab's window anyway) | explicit `windows.remove` when it's the last CDP-created tab on that window |
| `Target.activateTarget` | `tabs.update({active:true})` | same — natively focuses the tab's window |
| `Browser.getWindowForTarget` / bounds / `setWindowBounds` | per-tab window (already correct) | same — no change needed |
| `Target.getTargets` / tab_list | `browserContextId:'default'`, no windowId | emits real `windowId` + `window-<id>` context for window targets |
| `Page.navigate`, `Runtime.*`, etc. | unchanged | unchanged (operate on the target's session normally) |

---

## 6. Files touched

**Chrome** (`chrome-extension/`):
- `utils/config.js` — `getOpenInWindow` / `setOpenInWindow`
- `cdp/handler/special.js` — `targetCreateTarget` window branch, `targetCloseTarget` window-aware, helper `createWindowTab`, `createPlainTab`
- `cdp/handler/local.js` — `targetCreateBrowserContext`, `targetGetBrowserContexts`, `targetDisposeBrowserContext` config-aware
- `core/state.js` — `cdpWindows` registry (+ add/remove/query helpers, `promisifiedGetOpenInWindow` helper or a small promisify util)
- `features/tab-list.js` — `mapToTargetInfo` windowId/browserContextId
- `popup.html` + `popup.js` — checkbox + persistence

**Firefox** (`firefox-extension/`):
- `utils/config.js` — same two functions
- `cdp/handler/special.js` — `targetCreateTarget` force-window, window-flag in `noteContextCreated`
- `cdp/handler/local.js` — context handlers config-aware
- `core/session-manager.js` — thread `{window:true}` through pairing, skip `TabIsolation.isolate`
- `popup.html` + `popup.js` — checkbox + persistence

**Relay** (`src/relay-server.js`):
- `Target.getBrowserContexts` pass-through
- `browserContextId` threading through `_onCdpResponse` → `_registerCreatedTarget`

---

## 7. Testing

- **Chrome unit harness** `chrome-extension/test/unit-ext.mjs` (vm-based, 13 tests): stub `chrome.windows.create/remove/get`, `chrome.tabs.*`, fake `Config`, assert:
  - flag off → old tab path (arguments passed to `chrome.tabs.create`, grouping still called).
  - flag on → `chrome.windows.create` called, result carries `browserContextId:'window-<id>'`, no group call, tab navigated.
  - `closeTarget` on last tab of a cdp window → `chrome.windows.remove`, other → `chrome.tabs.remove`.
  - context handlers real vs mock depending on flag.
- **Firefox harness** `firefox-extension/test/unit-ff.mjs` (22 tests): stub `BidiClient.send`; assert `browsingContext.create` gets `type:'window'` under flag or `newWindow`, `'tab'` otherwise; `noteContextCreated` window flag skips `TabIsolation.isolate`.
- **Relay** `tests/relay-server.test.js`: extend FakeExtension to answer `Target.getBrowserContexts`; assert relay now returns the extension's list (not hardcoded) and that a created target's `browserContextId` survives `_registerCreatedTarget` into `targetInfo`.
- **Full stack manual** (Chromium, Debian): load extension, tick checkbox, pair, then via devtools:
  - `Target.createTarget {url:'https://example.com'}` → assert a **second native OS window** opened with the page.
  - `Browser.getWindowForTarget` on it → returns the new window's id; `Browser.setWindowBounds` moves it.
  - `Target.closeTarget` → window closes.
  - Untick → a plain tab returns to the current window.
- `pack-chrome.sh` / `pack-firefox.sh` pack checks after edits.

---

## 8. Implementation order

1. ✅ Chrome: config + popup checkbox.
2. ✅ Chrome: `createWindowTab` + `targetCreateTarget` wiring + cdpWindows registry.
3. ✅ Chrome: closeTarget window-aware + `tab-list.js` windowId/context + context handlers.
4. ✅ Run/extend `chrome-extension/test/unit-ext.mjs` — **31 pass, 0 fail**.
5. ✅ Firefox: config + popup checkbox + `targetCreateTarget` force-window + session-manager window flag (skip isolate).
6. ✅ Firefox: context handlers + extend `unit-ff.mjs` — **37 pass, 0 new fail** (tests 22-30 added; 20d/20e Probe are a pre-existing impl/test mismatch — see below).
7. ✅ Relay: `getBrowserContexts` pass-through + `browserContextId` threading; extend relay tests — **9/9 pass** (includes "forwards Target.getBrowserContexts and threads browserContextId").
8. ✅ Full manual smoke on Chromium (both checkbox states) — see matrix below.
9. ✅ AGENTS.md learnings (`Project Learnings` entry added).

**Smoke results (Chromium 152, :97, relay `test-chrome`, driven via devtools tools):**
- Flag ON: `Target.createTarget {url: example.com}` → OS window count 1→2, xdotool finds an "Example Domain" window; `Browser.getWindowForTarget` → new windowId (baseline 1470032699 → 1470032701); `Browser.setWindowBounds` moved it (1000x700 @ 60,60, persisted on re-read); `Target.closeTarget` → OS count 2→1, target dead, `State.cdpWindows` back to `{}`.
- Flag OFF: `Target.createTarget` → same windowId as baseline, OS count stays 1.

**Pre-existing failures (NOT from plan 56, left untouched):** `unit-ff.mjs` tests 20d/20e expect `Probe.probe` to surface `mode:'refused'`/`'dns'`, but `utils/probe.js` collapses both-schemes-failed to `mode:'unknown'` (line 84). Both files are unmodified at HEAD.

**Incidental fix (host env):** `firefox-extension/pack-firefox.sh` host-python3 branch produced a 22-byte empty zip because it zips cwd-relative but never cd'd to `$EXT_DIR` (the docker-python fallback masked it when host python3 was absent). Added the missing `cd "$EXT_DIR"`. Chrome pack fine: CRX 82.5KB + ZIP 56.7KB; Firefox ZIP now 68.7KB / 27 files.

---

## 9. Risks / gotchas

- **Chrome `chrome.windows.create` steals no focus** only with both `active:false` and `focused:false`.
- **`chrome.tabs.get` of a window-created tab is occasionally undefined** the instant after `windows.create` — wait for the tab in the returned `win.tabs[0]`, then `waitForTargetByTabId` as today.
- **Firefox window tabs must NOT be hidden** (`TabIsolation.isolate`) or the new window renders empty.
- **Puppeteer `context.newPage()`** with a real (non-mock) `browserContextId`: the relay's ack-hold + attach flow is unaffected, but `_registerCreatedTarget` must carry the context id or puppeteer may attribute the new target to the wrong context (`split()` groups by `browserContextId`).
- **`Target.getTargets` cadence**: entry.tabs are extension-built; both Chrome and Firefox `tab_list` must emit the real `browserContextId` for window targets or the context grouping silently collapses (`browserContextId:'default'`).
- **Firefox dispose via context**: no pre-created window handle → `createBrowserContext` returns an id; the window only exists after the first `createTarget` with it. Document in code comment.
- **Existing relay test** "drives browser.version(), newPage, goto..." runs with Chrome FakeExtension — must keep passing with the `getBrowserContexts` pass-through (FakeExtension must learn to answer it, or the fallback `['default']` must fire). Default to the fallback path.
- `chrome.windows` needs **no manifest permission** (verified: `windows` is permission-less).
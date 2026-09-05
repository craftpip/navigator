# 46 — More Devtools: Window/Tab Focus + Raw CDP Passthrough

**Status:** Proposed
**Created:** 2026-08-29

## Problem

The MCP devtools surface (19 tools) ends at the *page*: create/open/close tabs,
navigate, read DOM, click/type. But the underlying engines already speak a much
wider CDP dialect that the MCP layer never exposes:

- The user asked to **focus the tab/window** playing a song (Chrome tab, origin
  `browser`). There is no tool for it — `Target.activateTarget` and
  `Browser.setWindowBounds` are implemented in the extensions
  (`Target.activateTarget` → `chrome.tabs.update({active:true})`,
  `Browser.setWindowBounds({bounds:{focused:true}})` → `chrome.windows.update`)
  but are **not reachable from MCP**.
- Window geometry (`Browser.getWindowForTarget`, `getWindowBounds`) is stubbed
  to hardcoded `1920x1080` in the extension, so even the extension can't answer
  a real window query today.
- Any future CDP need that isn't in the 19 tools requires a code change and a
  restart. There's no escape hatch.

**Trigger:** `play god is from kanye on my firefox` → no focus tool; Firefox
relay first reported "BiDi not connected". Resolution: opened in user Chrome,
but could not bring it forward — surfaced the gap (AGENTS.md "improvement ideas
are mandatory, not optional").

## Requirements

1. **Focus a tab/window** — bring an existing target (any origin, any backend)
   to the front. Surfaced as a proper devtools tool.
2. **Query and set window bounds** — real geometry for the window hosting a
   target (left/top/width/height/state), and the ability to focus/move/resize.
3. **Raw CDP passthrough** — a generic `sendCommand(targetId, method, params)`
   devtools tool that reaches the DIFFERENT backends correctly (builtin
   chromium, `cdp` add-ons, relay user browsers) so every future capability is
   a client-side call, not a server change.
4. Keep the ownership guardrails: tool descriptions must remind the agent that
   a user browser (`navigator-cdp`, ownership `user`) shows focus/bounds changes
   on the user's real screen.

## Design

### Where each command is implemented today

| Backend | Page tools | Window-level (`Target.activateTarget`, `Browser.*`) |
|---------|-----------|-----------------------------------------------------|
| `chromium` (builtin) | puppeteer `page.*` | puppeteer CDP session — need `page.createCDPSession()` |
| `cdp` add-ons (cloakbrowser/lightpanda) | puppeteer `page.*` | `cdpUrl` dialed directly; same puppeteer CDP session |
| `navigator-cdp` (Chrome/Firefox relay) | puppeteer `page.*` through `/browser/<name>` gateway | extension `CDP_HANDLERS` LOCAL/SPECIAL handlers (already written for activate + bounds); Firefox needs BiDi equivalents |

For relay targets the gateway already forwards any method to the extension's
`routeCDPCommand` (chrome-extension/cdp/index.js:57), which handles
`Target.activateTarget` (SPECIAL) and `Browser.setWindowBounds` (LOCAL) in
process and FORWARDs the rest to `chrome.debugger`. So **the extension is the
thickest layer and mostly already speaks what we need** — the missing work is
MCP-side exposure plus real geometry in the extension stubs.

### New devtools tools (`src/devtools.js`)

Names follow the CDP domain so the schema reads like the protocol the engines
mimic:

1. **`Target.activateTarget`** — focus a tab (and its window).
   - `chromium`/`cdp`: `state.page.createCDPSession().send('Target.activateTarget', { targetId })` — targetId must be the **real** CDP target id: the puppet-page's `page.target()._targetId` (plan 42 note: no public `Target.id()`), or from the adopted registry. NOT the agent-assigned custom id.
   - `navigator-cdp`: send through the gateway → extension `targetActivateTarget`
     (already wired: special.js:99). Resolve our custom/adopted id → extension `targetId`.
   - Returns `{ targetId, activated: true, ownership }`.

2. **`Browser.getWindowForTarget`** — real geometry for the window hosting the
   target.
   - Extension: replace the `1920x1080` stub (local.js:31) with
     `chrome.tabs.get(tabId) → chrome.windows.get(winId)` returning real
     `{left, top, width, height, windowState, focused}`.
   - Firefox extension: BiDi `browsingContext.getWindow`/`browsingContext.getWindows`
     (check the session-manager for a window handle; else default `{type:'window'}`).
   - Builtin chromium: available via the page CDP session.

3. **`Browser.setWindowBounds`** — move/resize/focus the window.
   - Extension: extend local.js:44 to honor `left/top/width/height/windowState`
     via `chrome.windows.update(winId, {...})` (today it only handles `focused`).
   - `bounds.focused: true` is the window-level focus (vs `Target.activateTarget`
     = tab-level focus). Both are useful; document the difference in the tool.

4. **`Browser.focusWindow`** (convenience) — `Target.activateTarget` +
   `Browser.setWindowBounds({focused:true})` in one call. Optional; include if
   the two-step is awkward for agents.

5. **`Target.sendCommand`** (raw passthrough) — `method` + `params` (JSON),
   `timeoutMs`. Routes:
   - builtin/cdp add-on: `page.createCDPSession().send(method, params)`.
   - relay: send over the extension in-process — for non-attached targets the
     gateway's `_pending` machinery already mirrors a gateway client; expose a
     small `relayServer.sendCdpCommand(entryName, { method, params, targetId })`
     that borrows the existing `_sendCommandBytes`/sessionForTarget resolution
     (relay-server.js:1000-1085) and returns the result, so the MCP tool never
     hand-builds a socket.
   - Unknown domains (e.g. `Tab.*`) return a readable error naming the supported
     surface (see §Surfacing).

### Surfacing what the engines actually support

- Export a **method inventory**: `schrome-extension/cdp/index.js`
  `CDP_HANDLERS` keys + forwarded equivalents + the Firefox BiDi mapper
  (`firefox-extension/cdp/bidi/mapper.js`) — derive once into a constant the
  `sendCommand` error message references, and optionally a `list_commands`
  tool / console panel section so agents and the web console discover the full
  surface instead of guessing.

### Firefox mapper additions

`plans/40_firefox-extension.md` phases: `Target.activateTarget` →
`browsingContext.activate` (BiDi native; FF has no exact CDP twin — mapper it),
`Browser.getWindowForTarget`/`setWindowBounds` → BiDi
`browsingContext.getWindow`/`browsingContext.setWindowBounds` if the remote
agent exposes them, else handle locally via `tabs`/`windows` API (Firefox
extension side). Keep the 17/17 vm-harness tests green + add cases.

## Files touched (estimated)

- `src/devtools.js` — 5 tool definitions + 5 dispatch branches in
  `handleDevtoolsToolCall` + shared `sendWindowCommand(state, method, params)`
  helper that dispatches by backend.
- `src/relay-server.js` — `sendCdpCommand(entryName, cmd)` helper (borrow the
  gateway's pending/session bookkeeping) if in-process routing is cleaner than
  opening a second socket.
- `chrome-extension/cdp/handler/local.js` — real `getWindowForTarget`/`setWindowBounds`
  via `chrome.windows`.
- `chrome-extension/cdp/index.js` — (no change to handlers; maybe expose the
  inventory export).
- `firefox-extension/cdp/...` + `test/unit-ff.mjs` — BiDi mapper entries.
- `tests/devtools.test.js` — new mocks for the 3 window tools + `sendCommand`
  with a fake CDP session; verify the backend dispatch table end-to-end.
- `AGENTS.md` (project) — the `web_fetch`/devtools tool tables + a learning entry.

## Verification

1. `docker compose exec navigator npm install --include=dev && npx vitest run tests/devtools.test.js tests/browser.test.js`
2. `docker compose restart navigator`; confirm new tools in `tools/list`.
3. Live smoke:
   - `Target.createTarget` on user Chrome → `Target.activateTarget` — the
     user's window focuses (they verify visually).
   - `Browser.getWindowForTarget` on the same tab → real resolution, not
     `1920x1080` stub.
   - `Browser.setWindowBounds({focused:true})` → window raises.
   - `Target.sendCommand` with e.g. `Page.getNavigationHistory` on an adopted
     tab → real result (proves passthrough reaches chrome.debugger).
4. Firefox relay reconnect + same smoke once BiDi window commands are mapped.

## Risks / notes

- **Custom vs real targetId** — `Target.createTarget` accepts agent-assigned
  ids (`ch-kanye-god-is`). `Target.activateTarget` must translate to the real
  CDP id (registry/ext-`targetId`); failing that, it throws a readable
  "resolve targetId first" error. Do not hardcode `tab-3` style ids.
- **`Tab.*` domain is navigator-specific** — keep it out of the generic path or
  document that it's extension-only.
- **User-visibility** — focusing/raising a user browser is visible by design;
  the (already-authored) ownership guardrail in tool descriptions applies.
- **Stale sessions** — adopt the plan-42 stale-session handling (clear dead
  `sessionForTarget` on "BiDi not connected" / "Tab not attached") so focus
  works after churn without a `/debug/detach_all`.

## Relationship to existing plans

- Plan 42 (ownership metadata) — the `user`/`agent` guards + `_targetId`
  matching; this plan consumes both.
- Plan 40 (Firefox/WebDriver BiDi) — mapper is where FF window commands land.
- Plan 39 (dynamic browser array) — the three backend dispatch columns.
# 59 - LLM browser-tool reliability audit

**Status:** Complete — all 10 fix groups in §9a.1 implemented, each with a non-vacuous regression (§9a.2). Full suite 772 pass / 6 fail, all 6 pre-existing. Absorbed in `docs/api/tool-reference.md` (cache transparency, fetch readiness), `docs/architecture/browser-runtime.md` (fail-fast stats, staleness, nav outcomes, attach errors), `docs/guides/screenshots/svg.md` (stage deadlines).
**Scope:** Every MCP tool that an LLM uses to discover, inspect, control, test, or extract content from a website.

## 1. Directive: What This Audit Must Find

Navigator's browser tools exist so an LLM can test websites and access their real runtime state. The audit must find every path where that goal breaks down.

For **each LLM-facing web or devtools tool**, establish all of the following from source, tests, logs, and a live browser where applicable:

1. **What can make the LLM wait?**
   - Every awaited browser/CDP/relay/network operation.
   - Serial work hidden inside list, status, or discovery tools.
   - Timeouts that are absent, too large, not enforced at the public tool boundary, or can be bypassed by reconnect/retry paths.
   - Shared in-flight promises or locks that can make one slow browser/tool call block unrelated calls.
2. **What happens when it fails, disconnects, or becomes stale?**
   - Browser exits, page/tab closes, relay heartbeat flaps, extension service worker suspension, navigation context destruction, selector absence, response body loss, and aborted requests.
   - Whether the LLM gets a bounded, specific error that says what operation failed, which browser/target was affected, and what safe next action to take.
   - Whether a tool can claim success with stale, incomplete, or misleading data.
3. **Can the LLM safely recover without guessing?**
   - Does the result include the exact target ID, URL, browser/backend, ownership, relevant selector candidates, and retry/re-discovery instruction when needed?
   - Can the LLM distinguish a user-visible relay browser from an agent-owned browser before it acts?
   - Is retry safe and idempotent, or could it duplicate clicks, text entry, navigation, downloads, windows, or tabs?
4. **Can the response itself fail the LLM?**
   - Oversized DOM/text/screenshot/SVG output, unbounded arrays, missing truncation metadata, ambiguous target/link references, and output that omits the state needed for the next call.
   - Formatting that is technically valid but hard for an LLM to parse or act on.
5. **Is the runtime behavior proven?**
   - Reproduce the bad path with a deterministic test or controlled browser/relay fixture.
   - Add a regression test at the public tool boundary, not only a helper-level test.
   - Record actual latency and result/error shape before deciding a fix.

**Non-negotiable rule:** discovery/list/status tools must return an immediate cached snapshot. They must not wait for title reads, page evaluation, browser connection, relay round trips, navigation, or extraction. Freshness belongs in explicit refresh/action tools, never in an LLM's target-discovery path.

Do not begin implementation by adding generic retries or raising timeouts. First document the exact blocking operation and decide whether the correct behavior is cache, a small operation-specific deadline, cancellation, a background refresh, or a structured error.

## 2. Problem Trigger

`Target.getTargets` was intended to let an LLM select an open browser tab, but it awaited page title reads and relay tab-list refreshes. A discovery tool therefore depended on user-browser responsiveness and could outlive the LLM's own tool deadline.

The immediate fix makes `Target.getTargets` use known target state and the relay tab cache only. This plan broadens that investigation: the same class of hidden wait, stale state, opaque error, or non-recoverable response may exist in every other browser-facing tool.

## 3. Tool Inventory

Audit each group individually. Do not assume shared helpers make their failure behavior identical.

| Group | Tools / flows to audit |
| --- | --- |
| Browser discovery | `browser_list_browsers`, `Target.getTargets`, browser status/stats used by tool responses |
| Target lifecycle | `Target.createTarget`, adopted-tab attachment, `Target.closeTarget`, inactivity cleanup, `Target.activateTarget`, browser-context/window creation |
| Navigation | `Page.navigate`, `Page.reload`, back/forward, navigation launched by `Target.createTarget`, flow-hint navigate/click/type steps |
| DOM inspection | `DOM.getDocument`, `DOM.querySelector`, `DOM.querySelectorAll`, `DOM.getOuterHTML`, `DOM.scrollIntoViewIfNeeded`, compact HTML |
| Runtime and input | `Runtime.evaluate`, console messages, network request list, raw CDP, mouse, keyboard, text insertion |
| Window control | `Browser.getWindowForTarget`, `Browser.setWindowBounds`, `Browser.focusWindow` across Chromium, CDP add-ons, Chrome relay, and Firefox relay |
| Page extraction | `web_fetch`, `web_page_links`, hint matching, stabilization, flow extraction, formatters, link-reference memory, AI post-processors |
| Page rendering | `web_page_screenshot`, `web_page_svg`, any ASCII/render tools exposed by the running schema |
| Search-to-page flow | `web_search` result references, `web_fetch(ref_ids)`, screenshot/ref resolution, cache-hit and cache-miss paths |
| Relay transport | pairing/reconnect, heartbeat, tab cache, attach/detach, pending command cleanup, Chrome and Firefox extension differences |

## 4. Audit Method

For every row in the inventory, create an evidence table with:

| Tool | User outcome | Blocking operations | Public deadline | Cache/stale behavior | Failure result | Safe retry? | Test coverage | Finding |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

1. Trace tool schema -> MCP dispatch -> public handler -> browser/relay/extractor call chain.
2. List every `await`, event wait, polling loop, `Promise.all`, retry, and timeout in that chain.
3. Check the outer MCP/tool deadline as well as inner deadlines. An inner timeout is not enough if another await can continue indefinitely.
4. Test the tool against:
   - healthy agent-owned Chromium
   - closed target
   - slow or never-resolving page operation
   - disconnected/reconnecting navigator-cdp browser
   - a user-owned tab, without changing user state unless the test explicitly requires it
   - an oversized page/output where the tool exposes content
5. Inspect the exact LLM-visible result. Judge it as an agent instruction, not as an implementation detail.
6. Add the finding to this plan before coding the fix. Include file/function references and measured timings.

## 5. Reliability Requirements

### 5.1 Deadlines

* Every public tool has a finite deadline that is shorter than the calling LLM's practical patience.
* Each long operation reports its own timeout rather than leaking a generic outer timeout.
* A timeout cleans up listeners, pending relay commands, pages, and promise registry entries.
* A slow target must not prevent independent targets or browsers from being listed or used.

### 5.2 Discovery and cache

* Discovery is immediate and cache-only.
* Cached results identify their freshness when it matters.
* Explicit action tools may refresh only the state needed for that action.
* A disconnected browser returns its last known state only when clearly marked disconnected/stale; it must not be presented as live.

### 5.3 Errors and recovery

* Errors name the tool operation, backend, target ID when known, and failure class.
* Errors explain the next safe call: rediscover targets, retry a read, recreate an agent tab, or stop because the user-visible tab is gone.
* The server must never silently substitute a different page/target/backend after a failure.
* Write-like operations distinguish "not sent", "sent but result unknown", and "completed" to prevent unsafe duplicate retries.

### 5.4 LLM-readable output

* Tool results preserve the identifiers needed for the next tool call.
* Large output is bounded with an explicit truncation signal and a concrete narrowing option.
* Lists expose counts and stable ordering; empty/error/stale states are explicit.
* Link and target references cannot be confused with ordinary page text.

### 5.5 User-browser safety

* User-owned browser actions remain visibly labeled and never fall back to an arbitrary open tab.
* Background health/status work must not attach debuggers, steal focus, create windows, or mutate a user's tab.
* Browser ownership, target identity, and lifecycle behavior are identical in the schema description, tool response, and runtime implementation.

## 6. Initial Findings To Verify

These are investigation leads, not conclusions. Verify each before changing code.

1. `Target.getTargets` previously performed title and relay refresh I/O; the cache-only fix is implemented, but its result should indicate whether cached relay tabs are stale after a disconnect.
2. `BrowserManager.getInstanceStats()` intentionally refreshes relay tabs. Confirm it cannot run on a tool-critical path or make the console/status request pile up behind a slow relay.
3. `Target.createTarget` launches navigation in the background. Confirm navigation failure appears in later target inspection and does not leave an ambiguous "created" state.
4. DOM/input/runtime tools need consistent bounded behavior when an adopted relay tab's debugger session is stale, detached, or tied to the wrong extension target.
5. Extraction and rendering may have multiple independent limits: browser navigation, stabilization, DOM serialization, extraction/model calls, output formatting, and MCP transport. Confirm the result identifies which stage timed out.
6. `Target.closeTarget` and any window/tab creation paths need an outcome model that is safe for an LLM to retry after a relay disconnect.

## 7. Implementation Order

1. Complete the evidence table for discovery, lifecycle, and relay transport first. These define the target identity all other devtools tools rely on.
2. Audit read-only devtools tools: DOM, runtime, console, network, and raw CDP.
3. Audit mutating devtools tools: navigation, input, close/create, focus, and window bounds.
4. Audit `web_fetch` and its extraction/flow/cache pipeline.
5. Audit screenshots, SVG, search references, and output-size behavior.
6. Implement fixes in small coherent groups, with public-boundary regression tests and live verification after each group.
7. Update this plan's evidence table and move it to `plans/archive/` only after every exposed tool family meets the requirements.

## 8. Acceptance

* An LLM can always list available targets promptly, even when a page, relay extension, or user browser is slow, hung, or reconnecting.
* Every exposed tool has documented, measured, and tested deadline behavior.
* Every timeout/disconnect/closed-target response lets the LLM recover safely without guessing a target or repeating an unsafe action.
* No tool reports stale browser state as current without saying so.
* Large output is bounded and actionable.
* The audit evidence table covers every tool in the running MCP schema, not only the currently known failures.

## 9a. Verification pass (2026-09-30)

Every §9 row re-checked against current source before writing code, per §4.6. Several
§9 findings had been fixed by plans 42/51/56 since the original audit, and one was
simply inaccurate. This table is the authoritative status; §9 above is the original
2026-09-18 lead list and is kept for history.

| §9 ref | Finding | Verified status (2026-09-30) |
| --- | --- | --- |
| 9.1 `Target.getTargets` cache-only | `listTargets()` no longer awaits `page.title()`/`refreshTabList()` | **FIXED** — `src/devtools.js:773-823`; titles from `state.lastTitle` (refreshed in background at `:334` and on `framenavigated` `:671`), relay rows read the synchronous pushed cache (`:794`). **Group 7 closes the staleness residual:** each relay row now carries `connected` plus a `stale` explanation when the paired browser is offline, so a cached tab is no longer sold as drivable |
| 9.1 `Target.getTargets` staleness | Cached relay rows have no freshness marker | **OPEN** — relay rows hardcode `lastActiveAt: null, closesInMs: null, autoClose: false` (`:803-815`) and the filter admits `relayServer.isPaired(b.name)` offline browsers (`:790-792`), so a disconnected browser's cached tabs render as live |
| 9.1 `browser_list_browsers` blocking | Discovery awaits relay tab refresh | **FIXED (group 7)** — the `navigator-cdp` stat path now has its own 750 ms fail-fast (`src/browser.js:_navigatorCdpStat` races `_navigatorCdpStatUnbounded`), matching `_instanceStatWithTimeout` at `:1434`/`:1447`; on timeout it reports real connectivity + `timedOut` + a `note` instead of blocking toward the 3 s `GATEWAY_WAIT_MS` |
| 9.1 `closeTarget` adopted contract | Adopted user tabs closed by `page.close()` | **FIXED** — adopted returns `{ closed: false, released: true }` (`:831-839`); close failures/timeouts return `outcome:"unknown_after_dispatch"`, `retrySafe:false` (`:856-883`), bounded by `RELAY_CLOSE_TIMEOUT_MS` for user-owned backends. **Residual:** the lightpanda single-tab eviction (`:713-726`) filters on `backend === "lightpanda"` with **no `adopted` guard**, so an adopted lightpanda tab is still closed — real contract break |
| 9.1 `createTarget` nav failure invisible | Detached `goto` failure never surfaces | **FIXED (group 8)** — the settled outcome of the detached `goto` is recorded via `recordNavigation()` and exposed as `navigation: {status, error}` in `buildTargetSummary`, so a failed navigation is visible without a separate console call; `Page.navigate`/`reload`/`goHistory` set `ok` on success so a stale error cannot linger |
| 9.1 adopted attach error collapse | Backend/failure cause discarded | **FIXED (group 9)** — `attachToExistingTarget` records the last per-candidate failure (backend + reason) and returns `{page:null, backend, failure}`; `getTargetState` appends the cause to the "Unknown targetId" message instead of the empty `catch` swallowing it |
| 9.2 relay teardown rejects pendings | Pending promises left forever pending | **FIXED** — `_teardownEntry()` rejects every removed pending (`:786-811`); in-process `sendCdpCommand()` promises carry a `reject` (`:1620-1623`). **Residual:** gateway pendings whose client already vanished are filtered out (`:794`) and left to the 60 s command timer |
| 9.2 `sendCdpCommand` timeout | — | **FIXED** — per-command deadline rejects (`:1598-1606`), 3 s gateway wait / 60 s forwarded |
| 9.2 Firefox BiDi mutable `_nextId` | Timer bound to a shared counter | **NOT ACCURATE** — `bidi-client.js:189` captures a per-call `var id`; `_nextId` is only read, never captured by a closure. No change needed |
| 9.2 Firefox context→tab mapping | Falls back to first matching URL | **OPEN, worse than reported** — `session-manager.js:218-235`: on a URL miss it falls back to **all** top-level contexts and takes `[0]` (`:225`), then **persists** the guess via `addContextMapping` (`:231`). A non-matching or same-URL tab therefore gets a durable wrong context→tab binding used by `resolveTab`/`attachToTarget` |
| 9.2 `_attachFailure` global | Concurrent attaches report each other's failure | **OPEN** — single instance slot, not per attach: written at `relay-server.js:1196, 1360`, read-and-cleared at `:1211-1212, 1260, 1590-1591`. No target/command key, so concurrent `_ensureTargetSession()` calls race |
| 9.3 devtools operation deadline | — | **FIXED** — `handleDevtoolsToolCall()` races every handler (`:2792-2856`) with `DevtoolsOperationTimeoutError` carrying `operation`/`targetId`/`backend`/`timeoutMs`/`retrySafe` (`:456-473`); unknown tools reject before any await (`:2804`). Tests `:513`, `:548`. **Group 10:** the `isDevtoolsOperationTimeout()` dead code is deleted — no references remain |
| 9.3 stale retry safety | Writes auto-retried on stale | **FIXED** — `withStaleRetry` (`:384-428`) only re-runs reads mid-dispatch; every mutation passes `retryable:false` and gets `UnknownDispatchError` (`retrySafe:false`, "outcome unknown"). Tests `:449`, `:475` |
| 9.3 output budget | Unbounded JSON payloads | **FIXED (group 10)** — `MAX_GETTARGETS_RENDERED = 50` caps the `Target.getTargets` markdown branch that used to return before the budget check, with an explicit omission notice; the JSON payload stays complete |
| 9.4 `web_page_svg` deadline | Can hang forever | **FIXED (group 4)** — `src/svg/deadline.js` `withStageDeadline` bounds the font/evaluate/dims stages; the finally page-close still runs because a hang is now a rejection. See §9a.2 row 4 |
| 9.4 `web_fetch` readiness | Selector/stabilize failures swallowed | **FIXED (group 5)** — missed hint `waitForSelector`s and a failed `stabilizePage` are recorded as `readinessWarnings`, merged into the result `warnings`, and set `partial: true`; the MCP response renders `- ⚠ PARTIAL: …` instead of reporting a half-rendered page as plain success. See §9a.2 row 5 |
| 9.4 cache transparency | Stale or failed results indistinguishable from fresh | **FIXED (group 6)** — failures are never cached: `cacheableResult()` rejects payloads with a top-level `errors` array or any `ok:false` item, judged on the **raw** `browserSearch`/`openTargetsParallel` payload before formatting. Replays carry a visible provenance stamp (`*(cached result — retrieved N ago; pass bypassCache: true to fetch fresh)*`) on every payload shape. See §9a.2 row 6 |

### 9a.1 Fix groups (2026-09-30)

Implemented in order of severity, each with a public-boundary regression test:

1. **Adopted-tab safety** — lightpanda eviction must skip `adopted` targets.
2. **Relay attach error identity** — replace the single `_attachFailure` slot with a per-request reason.
3. **Firefox context→tab identity** — stop persisting a guessed context mapping; reject ambiguity.
4. **`web_page_svg` deadline** — bound font/extract stages; always close the page.
5. **`web_fetch` honesty** — surface swallowed selector/stabilize failures as warnings + mark partial.
6. **Cache transparency** — never cache failures; expose `cached` + age.
7. **Discovery freshness** — mark relay rows stale/offline; fail-fast `_navigatorCdpStat`.
8. **Nav-failure visibility** — carry navigation status/error in the target summary.
9. **Adopted attach error** — stop discarding the cause; report backend + failure class.
10. **Output budget + dead code** — cap the `getTargets` markdown path; drop `isDevtoolsOperationTimeout`.

### 9a.2 Progress (2026-09-30)

Groups 1–4 are implemented and carry regressions. Each new test was verified
**non-vacuous** by reverting the fix and watching the test fail, then restoring:

| # | Group | Change | Regression |
|---|-------|--------|-----------|
| 1 | Adopted-tab safety | `src/devtools.js` lightpanda eviction filter now requires `!s.adopted` | `tests/devtools.test.js` "never evicts an adopted lightpanda tab" — fails on revert (`close` called once); companion test proves agent-owned eviction still happens |
| 2 | Relay attach identity | `src/relay-server.js` `_ensureTargetSession()` resolves `{sessionId, reason}`; the shared `_attachFailure` slot is gone; teardown/failure/timeout/all six consumers updated | `tests/relay-server.test.js` "two concurrent failed attaches each keep their own reason (out-of-order replies)" — 2 tests fail on revert |
| 3 | Firefox context→tab identity | `firefox-extension/core/session-manager.js` `discoverContextForTab()` no longer falls back to the whole tree and no longer binds unless the URL match is **unique and unclaimed**; empty tab URL never binds | `firefox-extension/test/unit-ff.mjs` 59a–59f + a 59z liveness guard — 59a/59b fail on revert. 62 pass / 2 pre-existing (20d/20e probe) |
| 4 | `web_page_svg` deadline | New `src/svg/deadline.js` (`withStageDeadline`, `SvgStageTimeoutError`, `code: SVG_STAGE_TIMEOUT`); `src/svg/capture.js` bounds fonts 5s / dims 10s / extract+PDF+snapshot 20s; font timeout degrades to fallback metrics, PDF timeout falls back to bounded rect synthesis; the batch error string now reports `stage`, `after <ms>` and `retrySafe` | `tests/svg.test.js` "svg stage deadlines" — 3 tests, incl. a never-settling `document.fonts` that used to hang forever |
| 5 | `web_fetch` honesty | `src/search.js` `wait_for_selectors` uses `Promise.allSettled` and records a `readinessWarnings` entry per missed hint selector (generic `section`/`html`/`body` are exempt); a `stabilize_page` failure is caught and recorded instead of swallowed; the result merges the warnings and sets `partial: true`; `src/mcp-server.js` renders the `- ⚠ PARTIAL` line | `tests/search.test.js` "readiness honesty" — the missed-selector test fails on revert; a companion proves a satisfied selector does **not** mark the result partial |
| 6 | Cache transparency | `getCachedToolResult` returns `{value, storedAt, ageMs}`; `cacheableResult()` rejects any payload carrying a top-level `errors` array or a per-item `ok:false`; `web_search` judges the **raw** `browserSearch` payload (the formatted string has already lost `errors`) and `web_fetch` the raw result set — so a transient failure is never stored; `withCacheStamp()` prepends a provenance line and handles all three payload shapes (string, MCP content array, object) | `tests/mcp-server.test.js` "cache transparency" — the no-cache-a-failure and the visible-stamp tests both fail on revert; a companion proves `bypassCache` returns an unmarked fresh response |
| 7 | Discovery freshness | `src/browser.js` `_navigatorCdpStat()` is now a 750 ms `Promise.race` fail-fast over `_navigatorCdpStatUnbounded()`, matching the other stat paths; on timeout it still reports real connectivity plus `timedOut` and an explanatory `note` instead of blocking for the 3 s `GATEWAY_WAIT_MS`. `src/devtools.js` `listTargets()` marks relay rows `connected: false` + `stale` when a paired browser is not reachable, instead of selling cached rows as drivable | `tests/browser.test.js` "navigator-cdp fail-fast" (a never-settling `refreshTabList` returns degraded-but-trueful in <2 s; fails on revert) + `tests/devtools.test.js` "group 7" stale/not-stale pair (both fail on revert) |
| 8 | Nav-failure visibility | `recordNavigation(state, status, error)` records the settled outcome of a detached `page.goto`; `buildTargetSummary()` exposes it as `navigation: {status, error}`, so a failed navigation is visible without a separate console call. `Page.navigate`/`reload`/`goHistory` set `ok` on success so a stale error cannot linger | `tests/devtools.test.js` "group 8" — an `ERR_NAME_NOT_RESOLVED` goto surfaces in the summary; fails on revert |
| 9 | Adopted attach error | `src/browser.js` `attachToExistingTarget()` records the last per-candidate failure (backend + reason from `attachExistingTabToClients`) and returns `{page:null, backend, failure}`; `src/devtools.js` `getTargetState()` appends that cause to the "Unknown targetId" message, so a browser/attach problem is distinguishable from a genuinely wrong id | `tests/devtools.test.js` "group 9" — a failed attach reports backend **and** cause (fails on revert); a companion proves a truly unknown id stays clean |
| 10 | Output budget + dead code | `formatDevtoolsToolResponse` caps the `Target.getTargets` markdown render at `MAX_GETTARGETS_RENDERED` (50) with an explicit omission notice; the underlying JSON payload stays complete. The unused `isDevtoolsOperationTimeout()` is deleted (no references remain) | `tests/devtools.test.js` "group 10" — 120 targets render ≤50 with the notice; a companion proves no notice below the cap; both fail on revert |

**Test state (2026-09-30, full suite):** 772 passed / 6 failed / 1 skipped.
All 6 failures are pre-existing and unrelated: `tests/svg.test.js:141` (the
`el-2` text-y regex baseline) and 5 in `tests/modal-dismiss.test.jsx` — an
**untracked** file belonging to concurrent web-console work, which imports only
web-console modules this plan never touches. Verified by stashing every file
listed above and re-running: the same 6 fail on a clean tree.

**Why group 3 was the worst of the audit:** a guessed context binding is
persisted in `_contextTabs`/`_tabContexts`, so a single bad correlation makes
the agent drive a *different* tab than the target names for the rest of the
session — with the user watching the wrong page. Two tabs on the same URL, or a
tab whose URL changed after a redirect, both hit the old
"first free top-level context" fallback.

**Note on stage budgets:** `page.evaluate()` is not covered by puppeteer's
`setDefaultTimeout`, and `protocolTimeout` is never set, so a page that never
settles used to hang the tool forever *and* skip the caller's `finally` page
close. The deadline converts the hang into a rejection, which lets the existing
cleanup run.

## 9. Audit Evidence (2026-09-18)

### 9.1 Discovery and target lifecycle

| Tool / flow | Evidence | Finding | Required fix |
| --- | --- | --- | --- |
| `Target.getTargets` | `src/devtools.js:listTargets()` previously awaited `page.title()` and `relayServer.refreshTabList()`. | Fixed: it now returns the known devtools state and relay tab cache only. Cached relay rows still need explicit freshness/disconnected state. | Add relay snapshot metadata and test an offline cached browser row. |
| `browser_list_browsers` | `src/mcp-server.js:listBrowsers` awaits `BrowserManager.getInstanceStats()`; `src/browser.js:_navigatorCdpStat()` refreshes relay tab lists and CDP add-ons are probed. | Discovery can still wait on a live browser/relay. | Return a timestamped cached browser-status snapshot; move live refresh to an explicit status path. |
| `Target.closeTarget` / inactivity cleanup | `src/devtools.js:closeTarget()` and cleanup call `page.close()` for adopted user-browser targets. Relay close can close the real browser tab. | Violates the documented adopted-target contract: releasing a devtools handle must never close the user's tab. Close errors are also swallowed and returned as `{ closed: true }`. | Release adopted state only. For agent tabs, return an explicit uncertain/failed close result rather than false success. |
| `Target.createTarget` / unknown-target navigate | `createTarget()` launches `page.goto()` detached; failures only enter an internal console buffer. `Page.navigate()` creates a target for unknown IDs. | The LLM can receive a successful-looking creation/navigation response while the page never left `about:blank` or later failed. | Persist navigation status/error in target summaries and make unknown-target navigation a deliberate, documented create flow. |
| adopted target attachment | `src/browser.js:attachToExistingTarget()` probes add-ons; `src/devtools.js:getTargetState()` collapses failures to `Unknown targetId`. | A known selected user tab can take multiple backend connection/relay waits, then lose its real backend/failure cause. | Resolve cached target -> exact backend first; return structured backend/target/deadline recovery errors. |

### 9.2 Relay and extension transport

| Tool / flow | Evidence | Finding | Required fix |
| --- | --- | --- | --- |
| relay in-process commands | `src/relay-server.js:_teardownEntry()` deletes pending commands but only resolves attach markers/replies gateway clients. `sendCdpCommand()` creates `sendCommand` pending work. | A disconnect can delete the pending record without rejecting the in-process promise, leaving window/focus/raw-CDP LLM tools permanently pending. | Pending commands need one settle/reject contract; teardown must reject all removed commands. |
| ~~stale retry~~ **DONE** | `src/devtools.js:withStaleRetry(targetId, action, { retryable, operation })` now splits behavior: pre-dispatch stale during `getTargetState()` always purges + re-acquires (nothing dispatched yet, safe for all ops); mid-dispatch stale re-runs only for reads, and for mutations purges then throws `UnknownDispatchError` (`unknownAfterDispatch()` factory: `retrySafe:false`, `stage:"dispatch"`, message tells the LLM the outcome is unknown and to verify before retrying). `rawCommandIsReadOnly(method)` classifies raw CDP methods; mutating flags applied to Page.navigate/reload/goHistory, Input.dispatchKeyEvent/dispatchMouseEvent/insertText, Target.activateTarget, Browser.setWindowBounds/focusWindow, Target.sendCommand (via method classification). | Previously writes were auto-retried on stale errors, risking duplicated user-visible side effects. | Auto-retry only read operations. Mutations return an explicit unknown-after-dispatch outcome. **Verified:** `node --check` clean; regression tests "Page.reload throws UnknownDispatchError on mid-dispatch stale (no retry)" + "Runtime.evaluate retries once on mid-dispatch stale for read-only operations" pass in `tests/devtools.test.js`. |
| Firefox BiDi timeout | `firefox-extension/cdp/bidi/bidi-client.js` arms timeouts against mutable `_nextId`. | A command timeout can delete the wrong pending item and never reject, hanging all LLM tools mapped through Firefox. | Bind timer and pending entry to the allocated command id; clear on all settle paths. |
| Firefox tab identity | `firefox-extension/core/session-manager.js` falls back to first matching URL for context mapping. | Same-URL user tabs can be attached/driven as the wrong tab. | Require authoritative context-to-tab mapping; reject ambiguity rather than guessing. |
| attach errors | `src/relay-server.js` uses a global `_attachFailure`. | Concurrent failed attaches can report another target's failure. | Store failure per attach request/target. |

### 9.3 Devtools operation boundaries

| Tool / flow | Evidence | Finding | Required fix |
| --- | --- | --- | --- |
| ~~public devtools handlers~~ **DONE** | Every public devtools tool now flows through `handleDevtoolsToolCall()` with an operation-level deadline: `devtoolsOperationTimeoutMs()` (from `browserOpTimeoutMs`, min 1s) races the whole handler via `Promise.race`, and on expiry throws `DevtoolsOperationTimeoutError` (`code: DEVTOOLS_OPERATION_TIMEOUT`, `operation`, `targetId`, `backend` via `getLastUsedBackend()`, `timeoutMs`, `retrySafe`). Unknown tools still reject synchronously before any manager/config await. `operationIsReadOnly()` classifies the tool (raw CDP via `rawCommandIsReadOnly()`), so a timed-out write reports `retrySafe:false` + "outcome unknown — verify before retrying" while a timed-out read reports retry-safe. This is a normal recoverable error — `runWithHangGuard` (server exit) is no longer the only public safety net. **Verified:** regression tests "a hung read-only command rejects with a structured, retry-safe timeout" + "a hung write command rejects with an unknown-outcome, non-retry-safe timeout" pass; live smoke on cloakbrowser: `Runtime.evaluate` read + `Page.reload` write + `Target.closeTarget` all succeed through the wrapper. |
| ~~CDP/window commands~~ **DONE** | The outer operation deadline centralizes timeout enforcement for ALL devtools tool calls including relay window commands, so an in-process relay hang can no longer hold the LLM forever. Timeout errors carry `backend` (via `getLastUsedBackend()`) and `targetId`. Inner per-stage `Promise.race` timeouts remain for fine-grained stage attribution, and the relay transport already rejects pending commands on teardown (see §9.2). |
| DOM/runtime/input races | Multiple local timeout `Promise.race` calls do not cancel/clean up the losing operation. | Timed-out work can continue after the LLM sees an error; retries can double-dispatch a write. | Use one cancellation-aware deadline helper, then classify operation outcome as read failure vs uncertain write. |
| ~~LLM output~~ **DONE** | `formatDevtoolsToolResponse()` now enforces a total output budget (`MAX_FORMAT_OUTPUT_CHARS = 120000`) on every JSON-path tool result: oversized payloads are truncated and annotated with a bounded note naming the original size, the budget, and narrowing guidance ("Narrow the request — lower limit, more specific selector, smaller maxChars"). Runtime.evaluate already caps object serialization (25 keys per object, depth 4, `[+more keys]`/`[Circular]`/`[MaxDepth]` markers); console/network reads are capped by `limit`. Target.getTargets stays a compact markdown listing. **Verified:** regression tests "truncates oversized JSON payloads with a bounded note" (never exceeds budget, note present) + "does not touch payloads within budget" pass (53/54 in `tests/devtools.test.js`, the 1 failure is the pre-existing `includes tool name and JSON payload`). |

### 9.4 Page, extraction, rendering, and search tools

| Tool / flow | Evidence | Finding | Required fix |
| --- | --- | --- | --- |
| ~~page-slot queue~~ **DONE** | `BrowserManager.acquirePageSlot()` now imposes a built-in queue deadline (`timeoutMs` option or `config.browserOpTimeoutMs`) on EVERY page tool without needing a caller signal. On expiry the queued waiter is dropped and the call rejects with a structured, retry-safe `PAGE_SLOT_ACQUISITION_TIMEOUT` error (`code`, `stage: "page_slot_acquisition"`, `retrySafe: true`, message states the operation NEVER STARTED and re-running is safe). Abort signals remain honored while queued (removed from `pageSlotWaiters`, no slot leak). **Verified:** regression tests for the queue-timeout and abort-while-queued paths in `tests/browser.test.js` (36/36 pass) — no slot/waiter leaks after rejection. |
| `web_page_svg` | SVG capture awaits fonts and DOM extraction with no request-scoped deadline. | A never-settling font/CDP evaluation can hang the tool. | Bound each capture stage and always close ephemeral pages. |
| `web_fetch` readiness | Required hint selector waits and stabilization failures are swallowed before formatted success. | Pre-render/loading content can look like a complete successful extraction. | Preserve stage/selector warnings and mark result partial. |
| page/search cache | Five-minute cached pages/searches have no LLM-visible age/cache indicator; transient failed fetch batches can be replayed. | Stale or transient failures look current. | Cache successful items only or mark cached failure explicitly; expose `cached`, capture time, and age. |
| ~~public batch/output limits~~ **DONE** | Request item caps enforced at the public boundary: `web_search` queries capped at 6 (each truncated to 500 chars, announced in the tool description) and `web_fetch` batch size capped at 10 URLs/ref_ids with an explicit "Too many URLs ... Fetch in smaller batches" error naming the limit. Output budgets in place via `formatDevtoolsToolResponse` (120000-char cap, §9.3) and existing `maxChars`/`limit` bounds. **Verified:** regression tests "caps query count at 6" (asserts the exact 6 queries reaching `browserSearch`) + "rejects an oversized web_fetch batch with a clear message" pass (100/100 in `tests/mcp-server.test.js`). |
| `web_search` | Queries fan out concurrently; each can serially try route fallbacks and page-slot acquisition has no end-to-end cancellation. | Failure latency and capacity use scale without a public operation budget. | Cap query count/length and pass a search budget into route/page work; return per-query outcomes. |
| render errors | Screenshot/SVG batch errors collapse to raw messages. | LLM cannot tell navigation, readiness, capture, storage, or target failure apart. | Normalize `{ operation, stage, url|targetId, browser, retrySafe }` errors. |

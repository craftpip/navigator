# 61 — Wedged relay targets hang the LLM: purge stale sessions & registered targets

**Status:** proposed
**Created:** 2026-09-20
**Scope:** `navigator-cdp` (relay) session lifecycle — relay `_sendExtensionCommand` pending
cleanup, relay session-map eviction, devtools `targetsById` purge, and `Target.getTargets`
freshness metadata. Companion to plan 51 (relay timeouts) and plan 59 (tool reliability audit);
this plan is the *debris cleanup* half — 51/reliability make timeouts bounded, this plan makes
a wedged target fail **fast** instead of being replayed with a full 25s hang every call.

---

## 1. Incident (2026-09-19) — what actually hung the user's LLM

A devtools session drove the Meridian tab on `mac_chrome` (the user's real Chrome over the
relay) via adopted target `BE82A5C1F2EEFC1C97A10C08DC747BC9`. For ~10 minutes every tool call
on that one targetId burned the full 25s operation timeout before erroring; the LLM kept
retrying the same id, so the conversation stalled for minutes.

**Observed sequence (from `logs/tool-errors.log` + `docker logs navigator`):**

| Time (UTC) | Tool on `BE82…` | Result |
|---|---|---|
| 22:17:35 | `DOM.getDocument`, `Runtime.evaluate` ×2 | `Unknown targetId` (fast — 5s) |
| 22:19:36 | `DOM.getDocument`, `web_page_screenshot`, `Runtime.evaluate` ×2 | `timed out after 25000ms` |
| 22:20:04 | `Runtime.evaluate` (`location.href`) | `timed out after 25000ms` |
| 22:20:14 | `Browser.getWindowForTarget` | relay `CDP command … timed out after 3000ms` |
| — | relay | `Runtime.callFunctionOn got no extension reply within 60000ms` ×6 |

Key relay lines:

```
cdp_response WITH NO PENDING for id=3873 result={"sessionId":"session_1789856252254_…"}
cdp_response WITH NO PENDING for id=3874 result={"code":-32000,"message":"Failed to attach to target BE82… (tab 830135073): {"message":"An error occurred. Try refreshing the page."}}
cdp_response WITH NO PENDING for id=3875  (same attach failure)
```

`detach_all` was applied (`GET /debug/detach_all`, `relay-server.js:1470`) — mac_chrome never
acked, and a post-detach `Runtime.evaluate` on the same targetId **still hung the full 25s**.
A fresh `docker restart navigator` cleared it: the target then evaluated in **186ms** and both
relays reconnected with persisted SQLite tokens (no re-PIN).

---

## 2. Root cause — three compounding failures

### 2.1 The relay replay a dead sessionId forever

`getTargetState` (`src/devtools.js:272`) trusts `targetsById` on its fast path
(`src/devtools.js:278-283`): if a registered `state.page` is not `isClosed()`, it returns the
state without checking whether the underlying relay session is still alive. The puppeteer
`Page` for an adopted relay tab holds its own CDP session object, so `page.isClosed()` is
false long after the extension's `chrome.debugger` session for that tab is gone.

Every command then goes to the relay `_onGatewayMessage` → `_sendExtensionCommand`
(`src/relay-server.js:906`) **forwarded with the stale `sessionId`**. The relay does not
validate the session still exists in `entry.sessionForTarget`; it serializes and sends it to
the extension, which never replies. The command idles until `RELAY_COMMAND_TIMEOUT_MS`
(60s, `relay-server.js:42`); the tool boundary already died at the 25s devtools op deadline.

### 2.2 Nothing evicts the stale session on command timeout

`_sendExtensionCommand`'s timer (`src/relay-server.js:918-931`) deletes the *pending* and
replies a timeout to the client — but leaves `entry.sessionForTarget` /
`entry.extSessionToTarget` / every client's `sessionForTarget` intact. The next call replays
the same dead sessionId. The three invalidation paths that DO exist never fire here:

- `tab_detached` (`src/relay-server.js:537-597`) — extension sends this **only** on
  `chrome.debugger.onDetach` (banner closed / tab closed). An attach *refusal* or a wedged
  session sends nothing → no eviction.
- stale-error recovery (`src/relay-server.js:1280-1307`) — matches `msg.error` messages
  (`"Tab not attached"`, `"Cannot find context"`, …) on pending dispatch. The 60s command
  timeout produces **no** `msg.error` at all → never fires.
- `cdp_response WITH NO PENDING` (`src/relay-server.js:1182`) — just logs, takes no action.
  In this incident the attach refusals arrived as `WITH NO PENDING` (the 3s `GATEWAY_WAIT_MS`
  attach timer at `relay-server.js:1039-1045` had already fired) → the refusal was
  **swallowed**, not used to evict.

### 2.3 detach_all clears maps but puppeteer's Connection keeps its own session

`detachAllDebuggers` (`src/relay-server.js:1470-1490`) clears relay-side and client-side
session maps, but puppeteer's `Connection` (owned by the gateway client, not the relay)
still holds its own `CDPSession` for the target. The next command therefore still carries a
`sessionId` the relay no longer maps; the relay forwards it to the extension, which still
doesn't reply → `attachExistingTabToClients` is never reached → no fast attach refusal →
another 25s/60s hang. This is why post-detach retries on `BE82…` still hung.

**Net effect:** a registered relay target whose extension session is gone is a
non-terminating 25s loop until a full container restart. That is the exact failure the user
hit twice (same class of wedge seen earlier at 13:29 on target `169239B0…`).

---

## 3. Fix design

### Fix A — relay: evict the dead session when a session-scoped command times out

In `_sendExtensionCommand`'s timer (`src/relay-server.js:918-931`), when the command was sent
**with** a `sessionId`, drop that session from `entry.sessionForTarget`,
`entry.extSessionToTarget`, and every connected client's `sessionForTarget` (the map key is
the targetId, so look up which maps to the dead session via `_targetIdForSession`,
`relay-server.js:1129`). Log a dedicated line: `evicted stale session <sid> (target <id>) after
<method> got no extension reply`. This guarantees the **next** command for that target can
never replay the dead session — it falls into `_ensureTargetSession` (`relay-server.js:1026`)
and attempts a fresh `chrome.debugger.attach`.

Consequences downstream:
- If the extension still refuses attach, the refusal arrives at `_onCdpResponse` with a live
  pending now (no more `WITH NO PENDING`), so `_handleAttachToTarget` replies a **fast**
  structured error to the client instead of a 60s orphan.
- If the tab is genuinely recoverable, the fresh attach succeeds and the target works again —
  no restart, no LLM involvement.

### Fix B — relay: on attach-refusal `WITH NO PENDING`, evict the target's session too

In `_onCdpResponse`'s `WITH NO PENDING` branch (`src/relay-server.js:1181-1184`), when the
orphaned reply is an **error naming an attach failure** (marker lost but the message contains
`Failed to attach` / `attach`) for a known target, run the same eviction as Fix A (best-effort
— resolve the targetId from the message or the known map). The reply is late, but it is real
evidence the extension session for that tab is gone; never swallow it without acting.

### Fix C — devtools: purge a registered relay target whose relay session is missing

Add `relayServer.hasTargetSession(backend, targetId)` (O(1) map lookup: connected entry +
`entry.sessionForTarget.has(targetId)`). In `getTargetState` (`src/devtools.js:272`), on the
fast-path hit, when the backend is a relay entry and `hasTargetSession` is false, treat the
state as stale: `purgeStale()`-style deletion (`targetsById.delete` + `clearTab`, as
`withStaleRetry` already does at `src/devtools.js:381-387`) and fall through to the existing
re-adoption path (`attachToExistingTarget`, `src/browser.js:938`). Outcome:
- re-adoption succeeds → target usable again, transparently;
- re-adoption fails fast → `Unknown targetId` (fast, as currently) → the LLM re-runs
  `Target.getTargets` and moves on.

This directly eliminates the "registered-but-dead → 25s hang" class even before Fixes A/B
fire. Adapt `withStaleRetry` (`src/devtools.js:378`) so a `DevtoolsOperationTimeoutError` on a
**relay** target also triggers `purgeStale()` before rethrowing — a wedge that slips past A/B
(a session the extension accepts but never services) still cleans itself up on the first
timeout, so the second call fails fast instead of hanging again.

### Fix D — `Target.getTargets`: mark relay rows lacking a live attach session

`listTargets()` (`src/devtools.js` target listing) is cache-only per plan 59; extend the relay
row shape with a `session` boolean from `hasTargetSession` (in-memory, no round-trip) and mark
rows with a live entry but no session as `⚠ unattachable — run one read to re-attach, or pick
another tab`. This is discovery metadata, never a probe — plan 59 §5.2 stays intact.

### Fix E — per-target attach failure (remove the global `_attachFailure`)

Plan 59 §9.2 flagged the global `_attachFailure` (`relay-server.js:1042`, `:1199`). With
Fixes A–C creating *more* attach traffic, the race becomes more likely to misattribute a
failure to the wrong target. Store `_attachFailureAt.set(targetId, reason)` keyed by targetId,
read + clear per-request in `_ensureTargetSession`'s resolve. Small, contained, removes a
documented wrong-report path.

---

## 4. What this deliberately does NOT do

- No timeout *inflation* — that is plan 51's relay multiplier; the goal here is to make the
  second call fail fast, not to make the first call wait longer.
- No generic retries at the tool layer — plan 59 §1 forbids them; the recovery mechanism is
  re-adoption on the *next* call plus a truthful structured error, not silent retry.
- No change to the adopted-tab "never close the user's tab" contract
  (`runInactivityTick`, `src/devtools.js:528-534`) — purge/release only, never
  `Target.closeTarget` on a user tab.

---

## 5. Files touched

| File | Change |
|------|--------|
| `src/relay-server.js` | Fix A: evict dead session in `_sendExtensionCommand` timer; Fix B: evict on `WITH NO PENDING` attach refusal; Fix E: per-target `_attachFailure`; export `hasTargetSession(backend, targetId)` |
| `src/devtools.js` | Fix C: relay-target liveness check + purge in `getTargetState` fast path; `withStaleRetry` purges relay targets on op timeout; Fix D: `session` flag in `listTargets` output |
| `src/browser.js` | (verify only) `attachToExistingTarget` re-adoption path unchanged; confirm it covers relay targets after purge |
| `tests/relay-server.test.js` | Fix A/B/E unit tests |
| `tests/devtools.test.js` | Fix C/D regression tests |

---

## 6. Verification

**Unit (deterministic, in-vm fixtures — no real browser):**
1. Relay: register a session for a fake target → send a session-scoped command → let the 60s
   timer run (inject a short test timer) → assert `sessionForTarget`/`extSessionToTarget`/
   client maps are evicted and the command got a timeout error. No session survives a
   no-reply command.
2. Relay: deliver an attach-refusal reply with no pending → assert the target's session is
   evicted (regression for the `WITH NO PENDING` swallow).
3. Relay: two concurrent attaches, one fails → assert the failure is attributed to the right
   targetId (per-target `_attachFailure`, no cross-talk).
4. Devtools: register a relay target, simulate relay entry with no session →
   `getTargetState` purges and either re-adopts (mocked success) or throws fast
   `Unknown targetId` — measured < 1s, never 25s.
5. Devtools: `listTargets` emits the `⚠ unattachable` marker only for connected-relay rows
   missing a session; cache-only (no awaited relay call), timestamped.

**Live (relay browser, e.g. mac_chrome):**
1. Adopt a user tab, then kill its debugger session at the extension layer (or run
   `detach_all`) while keeping the tab open.
2. Call `Runtime.evaluate` on the same targetId twice:
   - first call ≤ 25s (may still hit the op deadline) with a structured error that names
     target/backend and says the session was dropped;
   - second call **fast** (< 1s): re-adopted and correct, or `Unknown targetId` → run
     `Target.getTargets`.
3. `Target.getTargets` shows the tab with the unattachable marker while wedged, healthy after
   recovery.
4. No `cdp_response WITH NO PENDING` lines logged for attach refusals; eviction lines logged
   instead.
5. Regression: headless `chromium` devtools workflow unaffected; healthy relay tab unaffected.

**Full suites:** `npx vitest run tests/relay-server.test.js tests/devtools.test.js tests/browser.test.js`.

---

## 7. Checklist

- [ ] Fix A — session eviction on no-reply command timeout (relay)
- [ ] Fix B — eviction on `WITH NO PENDING` attach refusal (relay)
- [ ] Fix E — per-target attach failure, race-free (relay)
- [ ] `relayServer.hasTargetSession(backend, targetId)` exported
- [ ] Fix C — `getTargetState` liveness check + purge; `withStaleRetry` purges relay targets on op timeout (devtools)
- [ ] Fix D — `listTargets` unattachable marker, cache-only (devtools)
- [ ] Unit tests (relay + devtools) green
- [ ] Live verification: wedged target recovers / fails fast on second call after session kill + `detach_all`
- [ ] `docker restart navigator` and confirm live behavior end-to-end
- [ ] AGENTS.md learning entry absorbed when implemented
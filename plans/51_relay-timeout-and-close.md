# 51 — Relay (navigator-cdp / macbook chrome) Timeout & Close Failures

**Status:** Planned
**Created:** 2026-09-08
**Scope:** `navigator-cdp` (relay) browsers — the user's real browser window bridged over the
extension WS gateway (`/relay`). Fixes the 25s timeouts seen on `web_fetch`,
`web_page_screenshot`, and `Target.closeTarget` when running against `macbook chrome`.

---

## Summary

Driving `macbook chrome` (a `navigator-cdp` relay browser, ownership `user`) with the
full devtools + web tool suite produced **3 confirmed failures**, all timing out at the
MCP request ceiling:

| Tool | Result | Why |
|------|--------|-----|
| `web_fetch` | `MCP error -32001: Request timed out` | Relay round-trip latency exceeds `BROWSER_OP_TIMEOUT_MS` (25s in Compose) |
| `web_page_screenshot` | `Screenshot timed out after 25000ms` | Same — screenshot path uses `withExtractTimeout` (25s) |
| `Target.closeTarget` | `MCP error -32001: Request timed out` | `page.close()` waits for a `tab_list`/detach round-trip that doesn't arrive promptly |

All other 21 actions (navigate, evaluate, DOM, Input, goBack/goForward, reload, network,
console, web_search, web_page_links, web_page_svg) **passed**.

A follow-up symptom — a `web_fetch` stuck "fetching forever since 23 minutes" in Live activity —
is diagnosed and addressed in §5 (Hard Timeout → Error): the op burned its full 75s server
budget and, worse, orphaned `status='running'` rows survive a crash forever because nothing
reconciles them (confirmed 6 stale rows in `page_ops`).

---

## 1. Root Cause Analysis

### 1.1 Relay latency is fundamentally higher than headless Chromium

A `navigator-cdp` relay round-trip goes: **puppeteer (in navigator) → navigator `/relay`
gateway → extension WebSocket → `chrome.debugger`/`chrome.tabs` API on the user's real
browser → back out the same chain.** Each CDP command crosses 2 network hops plus the
extension's message bus. Headless Chromium (`chromium`) talks to the browser in-process
(no network), so the same operations complete in a fraction of the time.

Nothing about the relay path distinguishes it from headless for timeout purposes:
- `browser.js` connects relay add-ons with a **null** `defaultViewport` (natural size) but
  otherwise uses the same `this.config.browserOpTimeoutMs`.
- `resolveBrowserParam()` (`src/browser.js:1467`) returns the same config for all browsers;
  there is no `ownership === "user"` timeout multiplier.
- Compose sets `BROWSER_OP_TIMEOUT_MS=25000` (`docker-compose.yml:36`, `.env:3`), tighter
  than the app default of 60000.

### 1.2 `web_fetch` and `web_page_screenshot` hit the shared 25s ceiling

- `web_fetch` (`src/search.js:2098`) derives `operationTimeoutMs` from
  `config.browserOpTimeoutMs` → 25s in Compose. A fetch on the relay that includes a
  `goto`, stabilization, JSDOM parse, and full-page link extraction can exceed 25s purely
  from relay round-trip overhead.
- Screenshot paths are wrapped in `withExtractTimeout(...)` (`src/mcp-server.js:3843`,
  `:3683`) which uses `manager.config.browserOpTimeoutMs || 25000` (`src/mcp-server.js:4021`)
  — again 25s. `captureTargetScreenshot` (`src/devtools.js:724`) independently applies the
  same `browserOpTimeoutMs`.

### 1.3 `Target.closeTarget` blocks on a detach notification that arrives late

`closeTarget` (`src/devtools.js:691`) calls `state.page.close()`. Puppeteer resolves
`page.close()` only after the relay emits session-scoped
`Target.detachedFromTarget` for that target (`src/relay-server.js:618-635`, comment
explicitly notes this is what resolves `page.close()`).

The relay evicts a closed target and diffs clients **only** when one of these fires:
1. The `Target.closeTarget` reply handler (`src/relay-server.js:1019`) — proactive eviction.
2. A `tab_list` push (`_onTabList`, `src/relay-server.js:602`) — requires the extension to
   send a `tab_list` message.

**The extension never listens for `chrome.tabs.onRemoved`**, so after `chrome.tabs.remove()`
closes the tab, no `tab_list` is pushed to the gateway on its own. Puppeteer must wait for
either the reply-based eviction or an unrelated poll. If the reply round-trip is slow, or the
session map is already torn down, `page.close()` hangs past the MCP request timeout → the
`-32001`. The close eventually lands (the extension does close the real tab), but the client
gave up waiting.

---

## 2. Design Decision — Relay-Specific Timeout Multiplier

Keep `BROWSER_OP_TIMEOUT_MS` as the headless baseline, and apply a **relay/user-browser
multiplier** so relay operations are not squeezed into a headless-sized budget. This is a
single primitive: `browserOpTimeoutMs(ownership)`.

- Headless (`agent`) → `config.browserOpTimeoutMs` unchanged.
- Relay/user (`user`) → `config.browserOpTimeoutMs * RELAY_TIMEOUT_MULTIPLIER` (default `3`,
  raising the Compose 25s → 75s for relay).

The multiplier lives in `src/browser.js` next to `browserOwnership()` (the single ownership
source) and is threaded through the three call sites.

### 2.1 Fix `closeTarget` so it doesn't block on a late detach

`page.close()` must not hang the full timeout for a slow detach notification. Wrap it in a
short bounded wait for the detach evidence, with an immediate release:

- On relay targets (ownership `user`), await `page.close()` with a bounded grace period
  (e.g. `RELAY_CLOSE_TIMEOUT_MS`, default 8000) instead of the full op timeout.
- Regardless of whether `page.close()` resolves, `closeTarget` already does the bookkeeping
  cleanup (`targetsById.delete`, `closedTargets.set`, `clearTab`) in `src/devtools.js:703-705`
  — the handle never leaks.
- The target's `targetId` is released even if the extension is slow to confirm; the relay's
  existing proactive eviction (`src/relay-server.js:1019`) plus `_ensureTargetSession`
  re-attach on the next use handles any residual mapping.

Regression risk is minimal: `page.close()`'s only purpose for a relay tab is to drive
`chrome.tabs.remove`; the CDP session teardown the relay does is idempotent.

---

## 3. Files Touched

| File | Change |
|------|--------|
| `src/browser.js` | Add `RELAY_TIMEOUT_MULTIPLIER` + helper `browserOpTimeoutMs(entry, config)`; thread relay awareness |
| `src/devtools.js` | `closeTarget` — bounded close wait for relay targets; `captureTargetScreenshot` — use relay-aware timeout |
| `src/search.js` | `browserOpenAndExtract` — derive `operationTimeoutMs` from relay-aware timeout |
| `src/mcp-server.js` | `withExtractTimeout` — accept ownership-aware timeout at the 3 wrap sites |
| `docker-compose.yml` / `.env` | Document the multiplier; optionally note `BROWSER_OP_TIMEOUT_MS` is the headless baseline |

---

## 4. Verification

1. Reconnect `macbook chrome` (relay, paired, ownership `user`).
2. **`web_fetch`** — fetch a heavy page (e.g. the earlier `navigator mcp server` use case) on
   `browser: "macbook chrome"` → completes, returns text; confirm timing logged.
3. **`web_page_screenshot`** — `targetId` of a macbook tab → returns base64 JPEG, no timeout.
4. **`Target.closeTarget`** — create a relay tab, close it → returns `{ closed: true }`
   promptly (< ~8s), tab actually closes in the user's window, `Target.getTargets` no longer
   lists it.
5. Regression: headless `chromium` fetch/screenshot/close still behave as before (multiplier
   is a no-op for `agent` ownership).
6. `docker compose restart navigator` so the code is live; re-run steps 2–4.

---

## 5. Hard Timeout → Error (Live Activity must never show "fetching forever")

**Confirmed symptom (2026-09-08):** Live activity showed a `web_fetch` "fetching forever since 23
minutes". DB audit of `data/navigator.db` `page_ops`:

- `id 19735` — `web_fetch` `support.google.com` → `status: fail`, `duration_ms: 75002`,
  `error: "Open page operation timed out after 75000ms"`, `ts` = start of the 75s op.
- The server-side op genuinely **hung the full 75s total budget** before erroring; the client
  had already given up at 25s (`-32001`).
- **6 orphaned `status='running'` rows** (Sept 2, `web_page_screenshot` on `example.com`) — the
  process died mid-operation and their `recordPageOp` finish call never ran. `pruneActivity`
  (`src/db.js:253`) only deletes rows by age cutoff; it **never reconciles `running` rows**,
  so these stay `running` indefinitely and render as a spinner in `/feed` `buildFeed`
  (`LiveFeed.jsx:113`).

**Two distinct "stuck forever" vectors:**

1. **A live op burning its whole budget.** `web_fetch` (`search.js:2098`) and screenshot
   (`devtools.js:724`, `mcp-server.js:3843`) derive their timeout from `browserOpTimeoutMs`
   (75s total for fetch via `* 3`, `search.js:2101`). A hung `goto`/`stabilize`/`screenshot`
   on a relay round-trip churns the entire budget, keeping the row `running` the whole time.
   The Live feed only flips it to an error **after** the op finally dies.

2. **Orphaned `running` rows from a crash.** No reconciliation exists. These render as
   "fetching forever" in Live activity until aged out by `RETENTION_DAYS`.

**Fixes:**

| # | Fix | Where |
|---|-----|-------|
| A | **Reconcile orphaned `running` rows on startup** — in `initDb`, `UPDATE page_ops SET status='fail', ok=0, duration_ms=NULL, error='interrupted by server restart — timed out' WHERE status='running'` (same for `searches` and `engine_attempts`). No row can outlive the process that owned it. | `src/db.js` `initDb` (and a shared helper reused by `pruneActivity`) |
| B | **Add an absolute cap on op lifetime** so a relay hang dies fast instead of churning `totalTimeoutMs`. For relay/`user` ownership, cap the overall `web_fetch` total at `RELAY_ABSOLUTE_TOTAL_MS` (e.g. 30s) regardless of the `*3` multiplier, and set a per-step cap that any single hung CDP round-trip can't exceed (e.g. 15s step). | `src/search.js` `configureTimeouts`, `src/web-fetch-operation.js` |
| C | Screenshot paths already use `withExtractTimeout` (25s app / `browserOpTimeoutMs`); with the relay multiplier from §2 this becomes relay-aware, so a stuck relay screenshot fails at a bounded time and the row flips to `fail` — never "capturing…" forever. | `src/mcp-server.js:3843/3683`, `src/devtools.js:724` |
| D | **Live feed already renders `fail` as an error** (`LiveFeed.jsx:113-119`, `:221-279`) — once the row is flushed from `running` to `fail`, the spinner/verb resolves. Fixes A–C guarantee the row always reaches `fail`; no presentational change needed. | (verify only) |

**Verification for §5:**
1. Crash/orphan test — kill the container mid-`web_fetch`, restart, confirm the previous
   `running` row is now `fail` with the restart-interrupt error and the feed shows no spinner.
2. Relay hang test — with fix B, a hung support.google-style fetch on `macbook chrome` errors
   ≤ ~30s (not 75s), and the feed row flips to "error" promptly.
3. Live activity — after reproductions, no row ever remains `running` longer than the
   absolute cap; refresh shows resolved error rows.

---

## 6. Checklist

- [ ] Relay timeout multiplier keyed off ownership (single source in `browser.js`)
- [ ] `closeTarget` bounded close wait → no more `-32001` on relay close
- [ ] fetch + screenshot use relay-aware timeout
- [ ] Absolute op-cap (fix B) so a relay hang fails fast, not at 75s
- [ ] Orphaned `running` reconciliation on startup (fix A) — searches, engine_attempts, page_ops
- [ ] Headless regression green
- [ ] Restart + verified live against `macbook chrome`
- [ ] No `status='running'` row survives a crash/restart in `page_ops`

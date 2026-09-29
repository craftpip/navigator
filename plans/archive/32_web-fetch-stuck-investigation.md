# 32 — web_fetch stuck requests investigation

## Status: Complete — 2026-09-29

**Created:** 2026-08-21
**Status:** Complete — completed and deployed 2026-08-21; archived to
`plans/archive/` 2026-09-29
**Reported:** "web fetch requests are getting stuck" (user, 2026-08-21)

## Symptom

`web_fetch` calls occasionally hang for **2–4.5 minutes** instead of failing fast.
Most fetches are <5s; a small number balloon past 60s (see distribution below).

## Evidence (data/navigator.db `page_ops`, last 48h)

Duration distribution (last 24h): `<5s: 358 · 5–15s: 11 · >60s: 2`

Slow/failing ops:

| ts | dur | result | url | error |
|---|---|---|---|---|
| 08-20 22:50:18 | 146455ms | FAIL | hermes-agent.nousresearch.com/docs/features/mcp | `Open page step timed out (serialize_html) after 25000ms` |
| 08-20 22:50:18 | 146664ms | ok (371ch!) | docs.openclaw.ai/features/mcp | — |
| 08-19 15:46:52 | 127704ms | FAIL | editorial.rottentomatoes.com/guide/... | `Protocol error (Target.closeTarget): No target with given id found` |
| 08-19 15:46:52 | 127646ms | FAIL | www.tvguide.com/news/best-tv-shows-on-amazon-prime-video/ | serialize_html timeout |
| 08-17 18:01:54 | 157572/158844/159958ms | FAIL ×3 | example-com test site (parallel batch of 3) | serialize_html timeout |
| 08-17 18:00:20 | ~181000ms | FAIL ×2 | same site | closeTarget protocol error / serialize_html |
| 08-17 00:28–00:40 | 133883/156975/159171ms | ok (tiny) | example-com `/chaos/` test page | — |

## Key observations

1. **Per-step timeout is 25s (`BROWSER_OP_TIMEOUT_MS`), but total op = 100–180s.**
   No retry wrapper exists upstream (checked mcp-server.js + search.js), so the
   extra time is NOT retries. Something inside a single fetch burns 5–7 step-timeouts
   worth of wall clock.
2. **Suspicious timeout mechanics in `withPageTimeout`** (src/search.js:2058):
   ```js
   timeoutId = setTimeout(async () => {
     if (!page.isClosed()) await page.close();   // ← awaited BEFORE reject()
     reject(new Error(`Open page step timed out ...`));
   }, operationTimeoutMs);
   ```
   The rejection is delayed until `page.close()` resolves. If the renderer/CDP is
   jammed, `page.close()` can hang for a long time → the whole fetch appears stuck
   even though the 25s timer fired. This also explains the concurrent
   `Target.closeTarget: No target with given id found` errors (two closes racing).
3. **Parallel batches hang together and release together.** At 22:50:18 two fetches
   started ~22:47:52 finished within 200ms of each other (146455 vs 146664ms) while
   OTHER fetches launched at 22:50:12–15 succeeded in 1.2–1.7s during the same
   window → browser as a whole was healthy; only those two page targets were stuck.
4. **Tiny responses correlate:** docs.openclaw.ai/features/mcp → 371ch,
   openclawvps.io/... → 40ch, hermes usage/mcp → 60ch. Extraction returning almost
   nothing on these sites (separate concern, possibly related).
5. Server itself stays responsive throughout (/health answered in <1s mid-window);
   pageLimiter showed inUse:0 after the batch cleared.

## Suspects (to verify)

- **A. `page.close()` hang inside the timeout handler** blocks `reject()` → stuck
  fetch despite timer. Fix direction: reject FIRST, fire-and-forget the close
  (with its own timeout), never await it before rejecting.
- **B. `serialize_html` step itself hanging**: `page.content()` +
  `document.body.innerText` + full-page screenshot on a heavy/jammed page can
  exceed 25s; combined with A the error surfaces very late.
- **C. Slot queueing**: `manager.withPageSlot` (OPEN_PAGE_MAX_PARALLEL=4) — stuck
  pages hold slots so later fetches queue behind them (compounds user-visible
  "stuckness" across a batch).

## Debug steps

- [x] Check container health/stats — server responsive, counters clean
- [x] Query page_ops history — identified slow-batch pattern
- [x] Read withPageTimeout/stabilizePage code paths
- [x] Reconstruct stuck window from docker logs (found acquire_window=83.6s spikes)
- [x] Reproduce live: fired the exact failing URLs solo, in pairs, and as an
      8-URL stress batch — **could NOT reproduce** (all 0.9–26s). Hang is
      transient/state-dependent, not URL-deterministic.
- [x] Load test: 8 parallel fetches push container CPU to 404–408% (of the
      400% compose limit) and RSS to ~1.07 GiB. System saturates but recovers.

## Root-cause analysis (current best explanation)

Confirmed facts:
1. Browser process stayed healthy during the stall (devtools Runtime.evaluate on
   another target answered in ms mid-window). No relaunch events in logs.
2. Fast fetches completed mid-stall (started 22:50:10, done in 1.2–1.7s) → no
   global lock, no slot exhaustion (30 slots), no CDP congestion.
3. The two stuck fetches had identical durations (146455/146664ms) and released
   within 209ms of each other → they shared a resource that freed at one instant.
4. Two search-window acquisitions (`acquire_window=83634ms` / `83791ms`) released
   at the same instant. With `SEARCH_KEEP_MIN_WORKING_WINDOWS=0`, every search
   creates a fresh window (`newPage()` + `goto(homeUrl)`) — so page creation /
   first navigation stalled for them too, then completed instantly on release.
5. Error surfaced was `serialize_html timed out after 25000ms` — i.e. the timer
   fired on schedule; the *rejection* arrived ~120s late.

Conclusion: a **jammed renderer process** (both stuck pages most likely shared
one renderer — cloakbrowser does not force site isolation) plus a CPU-saturated
container (4-core limit; measured 408% under load). Everything that needed that
renderer OR a new renderer (close, newPage, first goto) queued behind it; when
the jammed renderer finally died, everything released simultaneously.

The reason the user sees "stuck" instead of a 25s failure is the timeout
mechanics bug in `withPageTimeout` (src/search.js:2058):

```js
timeoutId = setTimeout(async () => {
  if (!page.isClosed()) await page.close();   // ← awaited BEFORE reject()
  reject(new Error(`Open page step timed out ...`));
}, operationTimeoutMs);
```

The rejection waits for `page.close()`. On a jammed renderer close hangs
indefinitely → the caller sees a hang far beyond the 25s budget. This also
explains the paired `Protocol error (Target.closeTarget): No target with given
id found` failures (timeout-close racing the normal cleanup close).

## Final fix

**Status: IMPLEMENTED + DEPLOYED 2026-08-21.**

1. ✅ **One lifecycle owner:** `WebFetchOperation` starts before browser-manager
   acquisition and owns the overall deadline, per-step deadlines, abort signal,
   page reference, and cleanup state. The loaded `BROWSER_OP_TIMEOUT_MS` becomes
   the step budget; the hard total budget is 3× that value without resetting
   elapsed time.
2. ✅ **Immediate rejection:** a timeout aborts and rejects synchronously. Page
   cleanup is detached from the error path, so a jammed `page.close()` cannot
   delay the caller again.
3. ✅ **Exactly one bounded close:** all normal, failed, timed-out, and late-page
   paths share one deduplicated close promise. Close gets 3 seconds, logs an
   accurate failure/deadline reason, and then leaves browser cleanup to recover
   the target.
4. ✅ **Queue and page creation cancellation:** `BrowserManager` page-slot
   waiters are abort-aware and removed when their request expires. Active slots
   release on abort. If `newPage()` resolves after its caller timed out, the late
   target is closed through the same coordinator.
5. ✅ **All extraction boundaries covered:** hint loading, selector resolution,
   stabilization, flow capture/actions/stabilization, serialization, cached
   extraction, and final extraction are step-bounded or raced against the
   operation deadline.
6. ✅ **Post-processors cannot pin requests:** queue waiters honor abort signals;
   active fetches receive a linked signal; and the configured request timeout
   now covers response-body reads as well as the initial HTTP response.
7. ✅ **Removed the live trigger:** normal extraction no longer captures an
   unused JPEG. Concurrent screenshots were stalling the composite
   `serialize_html` step on the two reported URLs. Screenshot capture now runs
   only for `format: "screenshot"`, under its own named deadline. Flow snapshots
   no longer take unused screenshots either; an explicit screenshot flow block
   captures its image separately under `flow_capture_screenshot` and bypasses
   cached-HTML replay because it requires a live page.

With the Compose default, a stuck browser step now returns after about 25
seconds. Work not governed by an individual step still has a 75-second hard
operation deadline. Cleanup never extends a timed-out response.

## Verification

- `node --check`, `git diff --check`, and ESLint pass on every changed source and
  test file.
- Focused suites: 113/113 pass (`plan-32-timeout`, browser limiter,
  post-processor, post-processor deadlines, trafilatura).
- `tests/search.test.js`: 59 pass / 6 fail, exactly the recorded pre-existing
  table-extractor baseline.
- Full suite: 601 pass / 14 fail. Six are that same table baseline; the other
  eight are unrelated dirty-worktree failures in config defaults, domain-hint
  fixtures/order, and the console root route.
- Failure injection covers a manager that never resolves, a slot never granted,
  late `newPage()`, hung serialization + hung close, hung flow stabilization,
  a post-processor queue abort, a hung response body, and a post-processor that
  never returns. Every case settles and releases its accounting.
- First live run after the lifecycle fix reproduced the reported condition on
  both exact URLs: each hit `serialize_html` at 25 seconds, both close attempts
  exceeded 3 seconds, and the MCP response still completed in 26.37 seconds
  instead of 146 seconds. Limiter returned to zero.
- After removing unused screenshots, the same uncached two-URL call succeeded
  2/2 in 1.184 seconds. Both URLs currently serve 404 pages.
- Uncached eight-page concurrent batch succeeded 8/8 in 2.34 seconds.
- A live candidate hint with a valid screenshot flow block returned JPEG data
  under its stage heading; a subsequent normal stateless MCP `web_fetch`
  returned text normally without an extraction screenshot.
- Final `/health`: `pageLimiter.inUse=0`, `queued=0`; devtools reported zero
  retained targets.
- Rebuilt `navigator:latest`, recreated the Compose container, and verified the
  running MCP tool rather than only calling source functions directly.

Deployment note: plain `docker compose up -d` currently collides with an exited
standalone `navigator-mineru` container that has no Compose labels. It was left
untouched; the final Navigator service was recreated safely with `--no-deps`.

## Side finding (separate bug)

`https://github.com/torvalds/linux` failed with:
`Domain hint flow step 1 wait failed: selector "[class*=\"markdown-body\"]"`.
A GitHub flow hint gates on a markdown-body selector that isn't present/visible
on this repo page → whole fetch errors out. Per AGENTS.md the stable selector is
`article.markdown-body`; the hint needs review (which entry carries the flow —
check domain-hints.json GitHub entries).

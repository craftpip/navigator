# Request Activity Trend Graph Plan

**Status:** Complete — 2026-10-07. Server side (committed earlier: `getActivityTrend` at `src/activity.js`, `GET /stats/activity-trend` at `src/mcp-server.js`, core `RequestActivityTrend` chart) plus every remaining gap closed 2026-10-05/07: engine selector + engine footer, legend hide/show toggles, hover/focus tooltip + tap-pin readout, empty/loading/error states, and the `Browser.` devtools categorization bug. 7 trend tests (`tests/activity.test.js` ×5, `tests/mcp-server.test.js` ×2). Absorbed into `docs/code/runtime-and-tests.md` §"Request Activity Trend Card" + `docs/api/mcp-and-http.md`; archived 2026-10-07. Full suite 670 pass / 90 fail — all 6 failing files pre-existing; console bundle rebuilt and live-verified (legend toggles, range/engine URL state, pin/unpin, tooltip, no JS errors).
**Priority:** Low
**Created:** 2026-08-11

## Progress checklist

- [x] Server: `getActivityTrend` bucketing (4 ranges, zero-filled, engine filter), `GET /stats/activity-trend` with 400s for unknown range/engine
- [x] `Browser.` prefixed devtools tools categorized as devtools (was: web) in `activityCategoryForTool`
- [x] Console: `ActivityLineChart` + `RequestActivityTrend` card in `.trend-drivers` grid, range controls with `?range=` round-trip, default `day`
- [x] Console: engine selector with `?engine=` round-trip; engine footer `attempt/success/failure/skipped`; engine filter affects only engine series (web/devtools totals unchanged)
- [x] Console: legend hide/show toggles (`aria-pressed`); hidden series excluded from the y-scale
- [x] Console: hover/focus tooltip (`data-tooltip` → `ImmediateTooltip`) + click/tap-to-pin readout below the chart
- [x] Console: empty / loading / error states; dashed failure strokes (not color-only)
- [x] Tests: 7 trend tests — bucket shapes for all 4 ranges, engine-filter/request-total separation, running-search exclusion + 7-day prune, 2× HTTP 400
- [x] Docs absorbed (`docs/code/runtime-and-tests.md`, `docs/api/mcp-and-http.md`), plan archived, queue ticked

## Deviations From This Plan (already built — do not "fix" back)

- The request series come from the `activity_events` table (one row per completed MCP tool call, `src/mcp-server.js:147`) rather than from `searches` / `page_ops` rows. Engine attempts still come from `engine_attempts`. A running operation is never counted, so there is no "running search" case to exclude.
- The card sits side-by-side with **Browser drivers** in the `.trend-drivers` grid instead of full-width above `.content-grid`.
- The default range is `day`, not `hour`.
- Plan §"Console Design" engine footer and legend toggles were listed by `plans/archive/50_request-activity-ui-changes.md` §2 as still-open candidate change **B** (plan 50 closed unimplemented 2026-09-29); both were subsequently built as part of this plan (2026-10-05/07).

## Goal

Show the trend of incoming operational activity as a line graph. It must make it
easy to answer:

- How many requests arrived during a time period?
- How many Web and DevTools requests succeeded or failed?
- Which search engines were attempted, and how are their successes and failures
  trending?

The graph uses persisted SQLite activity, not the in-memory `/stats` counters, so
it remains useful after a server restart and can show up to the existing seven-day
retention period.

## Definitions

Keep request activity and engine attempts as separate measures. Mixing them would
make a single `web_search` request count once for the request and again for every
search engine it fans out to.

| Measure | Source | Meaning |
|---|---|---|
| Web request | `searches` and non-DevTools `page_ops` | A user-facing web operation such as `web_search`, `web_fetch`, or `web_page_screenshot`. |
| DevTools request | `page_ops` where `source = 'devtools'` | A DevTools tool invocation. |
| Search-engine attempt | `engine_attempts` | One engine's outcome within a `web_search` request. This is the source for engine success/failure lines. |

- A Web request is success only when its completed row is `ok`; a running search
  is excluded from success/failure counts until it completes.
- Engine `status = 'ok'` is success. `status = 'fail'` is failure. `skip` is
  shown in the detail table but is not plotted as either success or failure.
- `Total requests` means completed Web requests plus completed DevTools requests.
  It does not include engine attempts, preventing fan-out double counting.

## Console Design

Add a full-width `Request activity` card between the overview and `.content-grid`.
It should remain visually consistent with the existing compact console, use an
inline SVG chart, and introduce no charting dependency.

```
┌─ REQUEST ACTIVITY ─────────── Minutes  Hour  Day  Week ───────────────────┐
│  83 total requests  ·  76 succeeded  ·  7 failed                          │
│                                                                            │
│  18 ┤                 ╭ Web success                                      │
│  12 ┤  ── Total       ╱  Web failure  ┄┄ DevTools success/error           │
│   6 ┤        ╭───────╯                                                    │
│   0 ┼──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──                                     │
│      12:00              12:30              now                            │
│                                                                            │
│  Search engines  All engines [v]  ·  success 48  ·  failure 4             │
└────────────────────────────────────────────────────────────────────────────┘
```

### Controls

- Time-range segmented control: `Minutes` (15 minutes), `Hour` (1 hour),
  `Day` (24 hours), and `Week` (7 days). Default to `Hour` so the graph has
  useful shape on a normally active server.
- The active range is kept in the URL query string (`?range=hour`) so refreshing
  or sharing the console keeps the chosen view. It does not need server-side
  user preferences.
- An engine selector defaults to `All engines`. It plots aggregate search-engine
  success and failure lines. Selecting an engine replaces those two aggregate
  lines with that engine's success/failure trend.
- Category lines are always available through an accessible legend: total
  requests, Web success, Web failure, DevTools success, DevTools failure. Click
  a legend item to hide/show it without changing the underlying totals.
- The summary row updates with the selected time range and displays total,
  succeeded, and failed request counts. The engine footer displays attempt,
  success, failure, and skipped totals for the selected engine scope.

### Bucketing

Use fixed UTC epoch buckets. The server returns bucket timestamps; the browser
only formats labels in the user's local time.

| Range | Lookback | Bucket width | Points |
|---|---:|---:|---:|
| Minutes | 15 minutes | 1 minute | 15 |
| Hour | 1 hour | 5 minutes | 12 |
| Day | 24 hours | 1 hour | 24 |
| Week | 7 days | 6 hours | 28 |

Return zero-filled buckets so gaps are visible as zero activity rather than a
misleading line drawn across missing data. The final bucket includes the current
time, so polling every two seconds updates the rightmost point.

## Server Work

### 1. Add a read-only trend query

Add `getActivityTrend({ range, engine })` in `src/activity.js`. It should:

- Validate the range against the four fixed configurations above; never accept
  arbitrary lookbacks or bucket widths from the public endpoint.
- Calculate `sinceMs`, align bucket starts with integer epoch math, and create a
  complete in-memory bucket array before merging SQL results.
- Query `searches` for completed Web search requests, `page_ops` for completed
  Web and DevTools requests, and `engine_attempts` for engine outcomes.
- Aggregate in SQL by bucket, category, and success/failure state. Query engine
  attempts separately so request totals cannot be inflated by search fan-out.
- Filter the engine-attempt query by `engine` only when a known engine id is
  requested. Unknown ids return a 400 from the HTTP handler rather than an empty,
  confusing chart.
- Return stable JSON with range metadata, zero-filled buckets, request summary,
  and engine-attempt summary. Do not return queries, URLs, or error text because
  this endpoint is aggregate telemetry.

Proposed response:

```json
{
  "ok": true,
  "range": "hour",
  "bucketMs": 300000,
  "sinceMs": 1786460400000,
  "untilMs": 1786464000000,
  "engine": "all",
  "summary": {
    "total": 83,
    "ok": 76,
    "fail": 7,
    "web": { "ok": 60, "fail": 5 },
    "devtools": { "ok": 16, "fail": 2 }
  },
  "engineSummary": { "total": 52, "ok": 48, "fail": 4, "skip": 3 },
  "buckets": [
    {
      "ts": 1786460400000,
      "web": { "ok": 4, "fail": 0 },
      "devtools": { "ok": 1, "fail": 0 },
      "total": 5,
      "engine": { "ok": 3, "fail": 0, "skip": 0 }
    }
  ]
}
```

### 2. Expose the endpoint

Add `GET /stats/activity-trend?range=hour&engine=all` in `src/mcp-server.js`,
beside `GET /stats/activity`.

- It returns `400 { ok: false, error }` for an unsupported range or unknown
  engine.
- It is available whenever the existing status endpoints are available; it does
  not require MCP authentication because `/stats` and `/stats/activity` are
  already console telemetry endpoints.
- Do not add the trend payload to `/stats`: the dashboard's two-second primary
  poll should not repeatedly transfer seven days of chart data.

### 3. Close telemetry gaps before relying on totals

The graph must use the same persisted activity model as the live feed. Audit all
MCP-facing web and DevTools tool paths while implementing the endpoint.

- Retain `searches` as the source for `web_search` requests and retain
  `engine_attempts` as its per-engine breakdown.
- Retain `page_ops` for `web_fetch`, `web_page_screenshot`, and DevTools calls.
- Decide and document whether lightweight web tools such as `web_page_links` are
  request activity. If they are, add a minimal persisted activity row for their
  completion; do not manufacture a `page_ops` browser duration for a pure
  in-memory lookup.
- Ensure failed validation/authentication requests are either intentionally
  excluded as non-operational input errors or recorded consistently. Do not show
  one source only on failures and another only on success.
- Preserve the current seven-day prune behavior. The Week range is the longest
  supported range until retention is deliberately changed.

## Console Work

### 1. Data loading

- Add `trendRange`, `trendEngine`, `trend`, `trendLoading`, and `trendError` state
  in `App` in `web-console/src/main.jsx`.
- Fetch `/stats/activity-trend` on initial status-page load and whenever range or
  engine changes. Refresh the active range on the existing two-second poll only
  while the status page is visible and polling is not paused.
- Keep the trend request independent from the existing `Promise.all` snapshot
  payload. A transient trend failure must leave the overview, live feed, and
  engine health visible.
- Pass the trend state to `StatusView`; do not merge it into `snapshot`, avoiding
  the existing mount-once `load` stale-closure risk documented in
  `plans/console-redesign.md`.

### 2. SVG line chart

Create a small `RequestActivityTrend` component in `main.jsx` initially. Split it
into a dedicated console component only if the planned console code-health work
lands first.

- Render SVG axes, grid lines, line paths, time labels, and a focusable data-point
  overlay from the zero-filled response buckets.
- Use a shared zero-based Y scale across visible request series, with an integer
  ceiling. This allows direct comparison of successes and failures.
- Use solid strokes for success and dashed strokes for failures; color must not be
  the sole state indicator. Use existing green/red theme variables for outcomes,
  and muted/blue accents for total and DevTools lines.
- Show a hover/focus tooltip with the timestamp and every visible series value.
  On touch, tap selects a bucket and shows the same values below the chart.
- Render a clear empty state when the selected period contains no completed
  activity and an inline retry state when the trend endpoint fails.
- Respect `prefers-reduced-motion`; the two-second update should replace path data
  without animated redraws for reduced-motion users.

### 3. CSS and responsive behavior

Add focused `.request-trend-*` rules in `web-console/src/style.css`.

- The card is full width below `.overview`; the SVG scales to its container and
  retains a usable minimum plot height around 220px on desktop.
- On narrow screens, stack the summary, range tabs, engine selector, and legend;
  keep the SVG horizontally legible without requiring a full-page horizontal
  scroll.
- Use real `<button>` elements for range and legend toggles, provide pressed state
  with `aria-pressed`, label the engine `<select>`, and make tooltip information
  available as text rather than hover-only content.
- Add light and dark theme colors through existing CSS variables rather than fixed
  background colors.

## Tests And Verification

### Server tests

Add focused Vitest coverage for `getActivityTrend` using a temporary database:

- Each range creates the expected bucket width and count, including zero-filled
  periods.
- A completed search counts once as a Web request even when it has multiple
  engine attempts.
- Web page operations and DevTools page operations land in their respective
  success/failure series.
- Engine aggregate and a selected engine return correct ok/fail/skip totals.
- Running searches and skipped attempts do not inflate completed success/failure
  request totals.
- Invalid `range` and invalid `engine` produce a 400 response.
- Pruning at seven days makes Week the maximum historical range.

### Browser verification

1. Seed or make real successful and failed Web and DevTools operations across more
   than one time bucket.
2. Open `/console` in a persistent browser tab and confirm the card is directly
   below **Live operational overview**.
3. Exercise Minutes, Hour, Day, and Week; verify the labels, bucket spacing, and
   summary counts match the endpoint response.
4. Change the engine selector; verify aggregate and individual engine lines/totals
   change without changing Web/DevTools request totals.
5. Leave the graph open through at least two polls and confirm its latest bucket
   updates with new activity without duplicate counts or console errors.
6. Check desktop and a narrow mobile viewport, light and dark themes, keyboard
   legend/tooltip access, and `prefers-reduced-motion` behavior.
7. Run `npm run console:build`, `npm run lint`, and the focused server test file.
   Rebuild the Docker image before live verification because the console bundle is
   copied into the image.

## Out Of Scope

- Real-time streaming transport. The existing two-second polling is sufficient for
  this graph; SSE can be considered separately once polling is a measured issue.
- Arbitrary date ranges, export, and cross-server historical aggregation.
- A third-party chart library. Inline SVG keeps the console dependency-free and
  works in the current offline/containerized build.

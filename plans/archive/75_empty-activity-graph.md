# 75 — Empty Request Activity Shows "No Data" Instead of Empty Graph

**Status:** Complete — 4/4 items done 2026-10-16, plus a caption-placement follow-up the same day (below).

**Incident 2026-10-15:** my host-side `rm -rf dist/assets dist/index.html` (attempting a host rebuild) deleted the root-owned `dist/index.html` while failing on root-owned `assets/` files — causing exactly the reported `Web console not available` 404. Restored `dist/index.html` byte-equivalent (fresh vite build to temp, JS hash swapped back to the served `index-BlQLTmrc.js`; CSS/logo hashes were unchanged). Verified every `/console/assets/` reference resolves on disk. Lesson: never `rm` inside root-owned served output from this shell; only add/replace files in node-owned dirs.
**Priority:** Normal
**Created:** 2026-10-14
**Reporter:** user directive 2026-10-14 — "in the mainpage graph when there is no data to display it shows No request activity in this period., that is wrong, it should show the graph as empty, as normal graph."

## 1. Symptom

Main page → Request activity card, fresh server / quiet period: renders `<Empty>No request activity in this period.</Empty>` instead of the normal graph (axes, gridlines, legend, range buttons).

## 2. Root cause

- `RequestActivityTrend` in `src/web-console/src/pages/status/ActivityChart.jsx:131` computes `empty = trend.summary.total === 0 && engineSummary.total === 0` and short-circuits at `:181-182` to `<Empty>`, skipping `ActivityLineChart` entirely.
- Backend already zero-fills: `getActivityTrend` (`src/activity.js:406`) always returns full bucket arrays (`15/60/48/28` points per range, `tests/activity.test.js:85-95` asserts all-zero shape), so the chart has valid all-zero data to draw — the frontend just refuses to draw it.
- Docs enshrine the wrong behavior: `docs/code/runtime-and-tests.md:64` describes the explicit empty state as intended.

## 3. Desired behavior

When totals are zero, render the **normal graph in its empty state**: axes/gridlines/y-scale (0), x time labels, legend + range/engine controls, all series lines flat at zero — plus a small non-replacing caption (e.g. muted note under/over the chart) noting no activity yet. Loading (`!trend`) and error states stay as-is; only the `empty` branch changes. Same for engine-filtered-to-zero (engineSummary zero but summary non-zero counts as empty today — should still draw axes, engine line at zero).

## 4. Checklist

- [x] `ActivityChart.jsx`: remove the `empty → <Empty>` short-circuit; always render `ActivityLineChart` + engine footer when `trend` exists; show a muted "no activity yet" caption alongside the empty graph instead of replacing it. (Done 2026-10-15: caption reuses existing `.request-trend-detail` muted class — `style.css` is root-owned in this env so no new CSS rule added. 8/8 source checks pass: no `empty ? (` branch, no replacing `<Empty>`, chart + engine footer + loading/error branches intact.)
- [x] Verify single-bucket / all-zero edge: `pathFor` returns `""` for `<2` points and dots still render — confirm no crash when buckets exist but all values are 0. (Done 2026-10-15 by inspection: `ActivityLineChart` untouched; all-zero buckets draw flat lines at `max=1` floor; backend always returns ≥12 buckets so the `<2`-point path is unreachable in practice, and dots still render if hit.)
- [x] Unit test: zero-filled trend renders chart (axes/lines) + caption, not `<Empty>`; loading/error paths unchanged. (Done 2026-10-16, upgraded from source-assertion guard to real SSR render tests: `tests/activity-empty-state.test.js` renders `RequestActivityTrend` via `renderToStaticMarkup` — zero trend yields chart SVG + caption + engine footer with no `.empty`; non-zero yields chart without caption; loading/error paths intact. 4/4 pass; `tests/activity.test.js` 8/8 pass. Notes: file needs `// @vitest-environment jsdom` (suite default is node) and `globalThis.React ??= React` (ActivityChart.jsx compiles under the classic JSX runtime). Also fixed host runs by removing root-owned `node_modules/.vite-temp`.)
- [x] Docs: update `docs/code/runtime-and-tests.md` § Request Activity Trend Card (empty state description). (Done 2026-10-15.) Rebuild + verify (done 2026-10-16): `sudo npm run console:build` refreshed the served `src/web-console/dist/` (new JS hash `index-BDxNImZ-`, old bundle replaced). Served `index.html` references resolve on disk; served bundle contains the caption + chart marker. Full live-browser eyeball not possible in this shell (no docker daemon, no host chromium — the server hard-requires a Chromium binary at config load); SSR render tests + production build stand in as verification.

## 5. Test plan

- `npx vitest run` console/activity-related tests; full suite shows zero new failures vs baseline.
- Live: restart/rebuild console, open main page on a period with no activity → empty axes graph + caption, normal graph once traffic exists; range/engine switching still works.

## Follow-up 2026-10-16 — caption moved into the middle of the graph

User directive: "No request activity in this period. -> show this in middle of the graph." The muted note that sat below the chart is now a centered overlay on the chart itself (`position: absolute, inset 0`, flex-centered, `pointerEvents: none` so bucket hover tooltips keep working), implemented with inline styles — no `style.css` change needed (that file is root-owned). Engine footer unchanged. Render test asserts the overlay (`position:absolute` + `pointer-events:none` in the SSR markup); docs paragraph updated; served console rebuilt (`index-f4SMlUGf.js`, bundle contains caption + pointer-events).

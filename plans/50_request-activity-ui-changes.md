# 50 — Request Activity: UI Changes

**Status:** Planned
**Created:** 2026-09-01
**Scope:** Console status page — `Request activity` trend card (`src/web-console/src/pages/status/index.jsx` + `src/web-console/src/style.css`)

---

## Summary

The `Request activity` trend card on the status page could use UI changes, but the specific change was **not described** in the original request. This plan documents the current behavior, lays out candidate changes, and needs the user to confirm which one (or to describe the actual intent) before implementation.

---

## 1. Current Behavior

- `RequestActivityTrend` (`src/web-console/src/pages/status/index.jsx:86-117`) renders heading, summary (`trend.summary`), range controls (Minutes/Hour/Day/Week), legend, and `ActivityLineChart` (inline SVG, `REQUEST_SERIES`).
- State lives in `src/web-console/src/main.jsx:17-27,105-127` (`trendRange`, `trend`, `trendError`, `changeTrendRange` → URL `?range=`).
- Data from `GET /stats/activity-trend?range=` (see `plans/14_request-activity-trend-graph.md`).
- Layout: full-width card above `content-grid`, side-by-side with `Browser drivers` inside `trend-drivers` grid (`style.css:303-342`).

---

## 2. What Is Not Yet Specified

The request titles this area but does not describe the desired change. Before committing, confirm one of the following (or propose the actual intent):

| Candidate change | Rationale | Effort |
|----------------|-----------|--------|
| **A. Collapsible chart** — header click collapses the SVG, leaving summary + controls visible | Symmetry with drivers; useful on small screens where the chart dominates | Small |
| **B. Controls refinement** — range as segmented control + engine filter (from plan 14 §Console Design) that was never built | Plan 14 proposed `All engines [v]` + legend toggles; currently only range exists | Medium |
| **C. Summary → header** — move `total / succeeded / failed` into the heading row, tighten vertical padding | Request activity card is tall; user may want denser overview | Small |
| **D. No change** — title mentions it for grouping but only drivers change in this iteration | Avoid guessing | Zero |

**Recommendation:** Treat this as **request-activity-only** and schedule the work once the user clarifies. If a placeholder is needed now, implement **A (collapsible chart)** with the same `grid-template-rows` animation and a `localStorage` key `requestActivity:expanded` — it is low-risk and mirrors the drivers interaction.

---

## 3. If Option A Is Chosen — Collapsible Chart

```jsx
function RequestActivityTrend({ trend, range, error, setRange }) {
  const [expanded, setExpanded] = useState(() => {
    const raw = localStorage.getItem("requestActivity:expanded");
    return raw == null ? true : raw === "true";
  });
  // header button toggles expanded; chart + legend are inside collapsible region
}
```

Styles reuse the same `.collapsible` / `.collapsed` grid animation as the browser-drivers plan (`grid-template-rows: 0fr → 1fr`), matching the existing `LiveFeed` row-enter pattern at `style.css:1205-1228`.

---

## 4. Files Touched

| File | Change |
|------|--------|
| `src/web-console/src/pages/status/index.jsx` | `RequestActivityTrend` — collapsible behavior (only if option A is confirmed) |
| `src/web-console/src/style.css` | Collapsible animation rules, if option A is confirmed |
| `src/web-console/src/main.jsx` | Only if `localStorage` persistence is added |

No server change — pure console UI.

---

## 5. Open Questions (Needs User Confirmation)

1. **What is the actual desired change?** Options A–D in §2 — which one matches the intent behind the title?
2. **If A (collapsible):** persist collapsed state across reloads via `localStorage`, or in-memory per-session only?

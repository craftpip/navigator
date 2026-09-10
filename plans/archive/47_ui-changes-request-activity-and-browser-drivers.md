# 47 — UI Changes: Request Activity and Browser Drivers

**Status:** Planned
**Created:** 2026-09-01
**Scope:** Console status page — `Request activity` and `Browser drivers` panels (`src/web-console/src/pages/status/index.jsx` + `src/web-console/src/style.css`)

---

## Summary

Two UI changes to the status page:

1. **Browser drivers — collapsible tabs (requested, primary):** Today each browser row always renders its tab list inline when `online` and `openTabs.length > 0` (`src/web-console/src/pages/status/index.jsx:509-532`). The request is to make the **browser row itself clickable** — clicking collapses/uncollapses the tabs section for that browser.
2. **Request activity — UI changes (named but not yet specified):** The trend card (`RequestActivityTrend` + `ActivityLineChart` at `src/web-console/src/pages/status/index.jsx:18-117`) is the other area to be touched. The exact change is not detailed in the request; this plan proposes the shape and leaves the final spec as an open question to confirm.

This plan is implementation-ready for (1) and scaffolds (2) so work can proceed without guessing.

---

## 1. Browser Drivers — Collapsible Tabs

### 1.1 Current Behavior

*Source: `src/web-console/src/pages/status/index.jsx:433-538` (`Drivers`), styles `src/web-console/src/style.css:748-1111`.*

- `Drivers` receives `health.browsers[]` and `stats.instances[]` (joined via `byBackend` map at line 434).
- For each `browser` it renders a `.item.driver-item` row with: `Dot` (tone by `online`/`pending`), `.item-main` (title + `Pill`s + `.item-detail`), right-side `statusPill` + optional `Forget` button, and — when applicable — a `.driver-tabs` block (header `Tab | Lifetime` + one `.driver-tab` per tab with `Countdown` or `sticky`).
- Tabs block is **always expanded** when `tabsToShow.length > 0 && online` (line 513). `prevTabsRef` keeps last non-empty list so tabs survive a transient empty poll.
- No interactivity on the row itself; row is not a `<button>`.

### 1.2 Goal

Clicking a browser row toggles visibility of its tabs block. The browser row must afford clickability (chevron + hover), and the interaction must not interfere with the row's existing controls (`Forget` button, `RelayAuth`).

```
Before (always open):
┌─ BROWSER DRIVERS ──────────────────────────────┐
│ ● chromium  default  2 tabs · pid 12  online   │
│   Tab              Lifetime                     │
│   GitHub — craftpip        4:12                │
│   about:blank (sticky)     sticky              │
│ ● cloakbrowser  add-on  not connected   idle   │
└────────────────────────────────────────────────┘

After (collapsible):
┌─ BROWSER DRIVERS ──────────────────────────────┐
│ ▸ ● chromium  default  2 tabs  online          │  ← collapsed, chevron right
│ ▾ ● chromium  default  2 tabs  online          │  ← expanded, chevron down
│     Tab              Lifetime                   │
│     GitHub — craftpip        4:12              │
│     about:blank              sticky            │
│ ▸ ○ cloakbrowser  add-on   idle  · no tabs     │  ← non-expandable (dimmed)
└────────────────────────────────────────────────┘
```

### 1.3 Requirements

| # | Requirement | Notes |
|---|-------------|-------|
| R1 | Each browser row with tabs is independently collapsible | Per-browser state, not global |
| R2 | Clicking the browser header toggles its tabs | The tabs block itself is not the toggle |
| R3 | Row must look clickable only when it has tabs | No chevron / no pointer when `tabsToShow.length === 0` or `!online` |
| R4 | Controls inside the row must not trigger toggle | `Forget`, `Copy` (inside `RelayAuth`) keep their own click handlers |
| R5 | Keyboard accessible | Focusable toggle, `Enter`/`Space` works, `aria-expanded` |
| R6 | Animated expand/collapse | No layout jank; respects `prefers-reduced-motion` |
| R7 | State persists across polls but resets on reload unless opted into `localStorage` | 2s poll in `src/web-console/src/main.jsx:52-104` must not collapse open sections |
| R8 | Works with existing height-sync (`trendDriversRef` + `driverHeight`) | Collapsing must re-measure parent (see §1.6) |
| R9 | Relay pending state (`RelayAuth`) stays visible regardless of tabs collapse | PIN UI at `src/web-console/src/pages/status/index.jsx:482` is not inside the collapsible block |

### 1.4 Design — State

Add local UI state inside `Drivers` (no server change):

```jsx
// expanded[backend] = true | false
const [expanded, setExpanded] = useState(() => ({}));
const toggle = (backend) => setExpanded((prev) => ({ ...prev, [backend]: !prev[backend] }));

// Default: collapsed on first render. Optionally expand if:
// - browser has tabs AND is default, OR
// - previously expanded and tabs still exist.
// Do NOT auto-expand on every poll — only initialize missing keys.
```

Alternative considered: `Set<string>` of expanded backends — equivalent; object is simpler to spread.

**Persistence (optional, recommend v2):** `localStorage.setItem("drivers:expanded", JSON.stringify(expanded))` on change, hydrate on mount. Keep v1 in-memory only to minimize scope — add persistence only if user asks.

**Initialization rule (proposed default: collapsed):**

- All browsers start **collapsed** regardless of tab count. This reduces vertical noise (the user's stated intent: tabs appear *when I click*).
- If the team prefers discoverability, initialize `expanded[defaultBackend] = true` when `tabsToShow.length > 0`. Call out as a one-line flip.

### 1.5 Design — Interaction & Markup

Current row structure (`index.jsx:474-533`) becomes:

```jsx
const hasTabs = tabsToShow.length > 0 && online;
const isExpanded = Boolean(expanded[backend]);

<div className={`item driver-item ${hasTabs ? "expandable" : ""} ${isExpanded ? "expanded" : ""}`} key={backend}>
  <button
    className="driver-toggle"
    aria-expanded={hasTabs ? isExpanded : undefined}
    aria-controls={hasTabs ? `driver-tabs-${backend}` : undefined}
    disabled={!hasTabs}
    onClick={() => hasTabs && toggle(backend)}
  >
    <span className="driver-toggle-chevron" aria-hidden="true">{hasTabs ? (isExpanded ? "▾" : "▸") : ""}</span>
    <Dot tone={...} />
    <div className="item-main">
      <div className="item-title">… <span className="driver-tab-count">{hasTabs ? `${tabsToShow.length} tabs` : ""}</span></div>
      <div className="item-detail">{detail}</div>
    </div>
    <span className="driver-toggle-meta">{hasTabs ? `${tabsToShow.length}` : ""}</span>
  </button>
  <div className="driver-actions"> {/* statusPill + Forget stay OUTSIDE the toggle button */}
    {statusPill}
    {isRelay && !pending && <button className="button small" …>Forget</button>}
  </div>
  {pending && <RelayAuth … />} {/* not collapsible */}
  {hasTabs && (
    <div id={`driver-tabs-${backend}`} className={`driver-tabs ${isExpanded ? "open" : "collapsed"}`}>
      <div className="driver-tabs-header"><span>Tab</span><span>Lifetime</span></div>
      {tabsToShow.map(…)}
    </div>
  )}
</div>
```

Key decisions:

- **Toggle is a `<button>` wrapping the left side (chevron + Dot + title + detail), not the whole `.driver-item`.** This keeps `Forget`/`Pill` outside the button so their clicks do not bubble to the toggle (no `stopPropagation` hack needed). If the design instead makes the entire row one button, then `Forget` must call `e.stopPropagation()`.
- **Disabled when `!hasTabs`.** No chevron, no hover, `cursor: default`.
- **Chevron:** `▸` collapsed / `▾` expanded (matches `attention` caret at `index.jsx:304`). Alternative: SVG chevron that rotates 90deg with `transform` — cleaner animation, pick one and keep consistent.
- **Tab count badge:** optional — show `· 3 tabs` in `item-detail` already does this for non-relay; keep it and/or add a small count next to the chevron.

### 1.6 Design — Visual & Animation

Add to `src/web-console/src/style.css` near the existing `/* Driver inline tabs + countdown */` block (1056-1111):

```css
.driver-item.expandable .driver-toggle { cursor: pointer; }
.driver-item.expandable .driver-toggle:hover { background: var(--panel2); border-radius: 4px; }
.driver-toggle { /* reset button */ display:flex; align-items:center; gap:10px; flex:1; min-width:0; background:none; border:0; padding:2px 4px; text-align:left; font:inherit; color:inherit; }
.driver-toggle:disabled { cursor: default; }
.driver-toggle-chevron { width:12px; text-align:center; color:var(--muted); font:700 10px var(--sans); transition: transform 160ms ease; }
.driver-item.expanded .driver-toggle-chevron { transform: rotate(0deg); } /* or 90deg if using ▸ base */
.driver-toggle:focus-visible { outline:2px solid var(--blue); outline-offset:2px; border-radius:4px; }

.driver-tabs { display:grid; grid-template-rows: 1fr; transition: grid-template-rows 180ms ease, opacity 160ms ease; opacity:1; }
.driver-tabs.collapsed { grid-template-rows: 0fr; opacity:0; overflow:hidden; }
.driver-tabs.collapsed > * { overflow:hidden; min-height:0; }
@media (prefers-reduced-motion: reduce) { .driver-tabs { transition:none; } .driver-toggle-chevron { transition:none; } }
```

The `grid-template-rows: 0fr → 1fr` technique is already used for `LiveFeed` row enter (`style.css:1205-1228`) — reuse the same pattern so no new animation primitive is introduced.

**Hover affordance:** subtle `var(--panel2)` background on the toggle button only (not the whole `driver-item`) so the `Forget` button's adjacent area does not highlight.

**Height sync interaction:** `trendDriversRef` in `StatusView` (`index.jsx:162-229`) measures `trendPanel` height and forces `Drivers` to match via `driverHeight`. Collapsing tabs shrinks `Drivers` — `ResizeObserver` on `trendDriversRef` already observes both children (line 219) and will call `syncDriverHeight()`, so no extra wiring is needed. Verify after implementation that collapsing does not leave a stale fixed `height` — `height` is driven by the *trend* panel (the taller one), so shrinking drivers alone is fine; expanding drivers beyond trend height will be clamped by the injected `style.height` — consider clearing `driverHeight` when drivers would naturally be taller (existing logic only sets from `trendPanel` height, so drivers can overflow — keep `overflow:auto` on `.trend-drivers > .panel .list` at `style.css:322-342` to scroll internally).

### 1.7 Alternative Approaches Considered

| Approach | Why not chosen |
|----------|----------------|
| Single global expanded state (only one browser open at a time) | User asked for per-browser collapse — accordion would force extra clicks when inspecting multiple drivers |
| Using `<details>/<summary>` | Native semantics are good but styling the summary marker + keeping `Forget` outside the summary is awkward; button + `aria-expanded` gives full control |
| Persisting expanded state in URL query string | Overkill — this is local UI chrome, not shareable view state (unlike `Request activity` range) |

### 1.8 Accessibility

- Toggle is a real `<button>` — keyboard focusable, `Enter`/`Space` handled by the browser.
- `aria-expanded` set only when `hasTabs` (otherwise omit — not an expandable region).
- `aria-controls` points to `id="driver-tabs-${backend}"`.
- Chevron has `aria-hidden="true"` (decorative).
- `Forget` and `RelayAuth Copy` remain separate tab stops after the toggle.
- Focus ring via `:focus-visible` only (existing pattern in `style.css:257-259`).

### 1.9 Edge Cases

- **No tabs or offline:** row is not expandable, no chevron, no toggle handler. Prevents empty collapsible showing just a header.
- **`tabsToShow` changes between polls:** `prevTabsRef` logic stays as-is; if tabs go from 3 → 0, the row loses `hasTabs`, collapses, and `expanded[backend]` is harmlessly retained (or cleared on next toggle).
- **Relay `pending` (PIN required):** tabs block is not shown in pending state today; toggle stays disabled even if stale `openTabs` exist — PIN UI takes precedence.
- **Many tabs (e.g. >10):** `.driver-tabs` scrolls internally if `Drivers` is height-constrained by `trendDriversRef`; alternatively let it grow and page-scroll — keep existing `overflow:auto` on `.trend-drivers > .panel .list`.

---

## 2. Request Activity — UI Changes (Scaffold)

### 2.1 Current Behavior

- `RequestActivityTrend` (`index.jsx:86-117`) renders heading, summary (`trend.summary`), range controls (Minutes/Hour/Day/Week), legend, and `ActivityLineChart` (inline SVG, `REQUEST_SERIES`).
- State lives in `src/web-console/src/main.jsx:17-27,105-127` (`trendRange`, `trend`, `trendError`, `changeTrendRange` → URL `?range=`).
- Data from `GET /stats/activity-trend?range=` (see `plans/14_request-activity-trend-graph.md`).
- Layout: full-width card above `content-grid`, side-by-side with `Browser drivers` inside `trend-drivers` grid (`style.css:303-342`).

### 2.2 What Is Not Yet Specified

The request titles this area but does not describe the desired change. Before committing, confirm one of the following (or propose the actual intent):

| Candidate change | Rationale | Effort |
|----------------|-----------|--------|
| **A. Collapsible chart** — same pattern as drivers: header click collapses the SVG, leaving summary + controls visible | Symmetry with drivers; useful on small screens where the chart dominates | Small |
| **B. Controls refinement** — range as segmented control + engine filter (from plan 14 §Console Design) that was never built | Plan 14 proposed `All engines [v]` + legend toggles; currently only range exists | Medium |
| **C. Summary → header** — move `total / succeeded / failed` into the heading row, tighten vertical padding | Request activity card is tall; user may want denser overview | Small |
| **D. No change** — title mentions it for grouping but only drivers change in this iteration | Avoid guessing | Zero |

**Recommendation:** Treat this plan as **drivers-only for v1** and schedule request-activity work as a follow-up once the user clarifies. If a placeholder is needed now, implement **A (collapsible chart)** with the same `grid-template-rows` animation and a `localStorage` key `requestActivity:expanded` — it is low-risk and mirrors the drivers interaction.

If **A** is chosen, the shape is:

```jsx
function RequestActivityTrend({ trend, range, error, setRange }) {
  const [expanded, setExpanded] = useState(() => {
    const raw = localStorage.getItem("requestActivity:expanded");
    return raw == null ? true : raw === "true";
  });
  // header button toggles expanded; chart + legend are inside collapsible region
}
```

Styles reuse the same `.collapsible` / `.collapsed` grid animation from §1.6.

---

## 3. Files Touched

| File | Change |
|------|--------|
| `src/web-console/src/pages/status/index.jsx` | `Drivers` — add `expanded` state, `toggle`, restructure row to button + actions + collapsible `.driver-tabs`; optionally `RequestActivityTrend` collapsible |
| `src/web-console/src/style.css` | New rules for `.driver-toggle`, `.driver-toggle-chevron`, `.driver-tabs.collapsed/.open`, hover/focus, reduced-motion |
| `src/web-console/src/main.jsx` | No change for drivers; for request-activity persistence only if `localStorage` is added |
| `tests/` | Optional: add `tests/console.status.test.jsx` or extend `src/web-console` unit tests — assert toggle renders chevron when tabs exist, `aria-expanded` flips, `Forget` click does not toggle |

No server change — this is pure console UI. `health.browsers` / `stats.instances[].openTabs` shape is unchanged.

If the codebase has already modularized `main.jsx` per `plans/console-modularization.md` (status split into `pages/status/Drivers.jsx`, `ActivityChart.jsx`), apply the same edits in those files instead — the component boundaries are identical.

---

## 4. Implementation Steps

1. **Drivers — state:** add `const [expanded, setExpanded] = useState({})` and `toggle` inside `Drivers` (`index.jsx:433`). Derive `hasTabs` / `isExpanded` per browser before the `return`.
2. **Drivers — markup:** split each `driver-item` into `button.driver-toggle` (chevron + Dot + item-main) and `div.driver-actions` (Pill + Forget). Move `driver-tabs` into a collapsible wrapper with `id` + `aria-controls`. Keep `RelayAuth` outside the collapsible.
3. **Drivers — styles:** add toggle/chevron/collapsed rules to `style.css` (§1.6). Verify dark/light themes use `var(--panel2)` / `var(--line2)` only.
4. **(Optional) Request activity collapsible:** add `expanded` state + header toggle + collapsible wrapper around `ActivityLineChart` if option A is confirmed.
5. **Build & verify:** `docker exec navigator npm install --include=dev && docker exec navigator npm run console:build` (console is served from bind mount `src/web-console/dist`), then hard-refresh `http://10.69.1.164:1994/console` and exercise:
   - Browsers with tabs show `▸`, click → `▾` + tabs appear, click again → collapse.
   - `Forget` still works without toggling.
   - Keyboard: Tab to chevron button, `Enter`/`Space` toggles, `aria-expanded` updates.
   - Height sync: collapsing drivers does not leave a stale fixed height; expanding many tabs scrolls internally.
   - `prefers-reduced-motion: reduce` — no animation.
   - Light/dark themes.
6. **Tests/lint:** `npx vitest run` (if a console test is added) + `npm run lint` over `src/web-console/src/`.

---

## 5. Verification Checklist

- [ ] `npm run console:build` succeeds; no new lint errors in `src/web-console/src/`.
- [ ] Console loads at `/console` — no JS errors.
- [ ] Each browser with `openTabs.length > 0 && online` renders a clickable chevron; browsers with no tabs render no chevron and are not clickable.
- [ ] Clicking the browser header toggles tabs; clicking `Forget` or `Copy` does not.
- [ ] Tabs block animates open/closed; with `prefers-reduced-motion` it snaps.
- [ ] `aria-expanded` and `aria-controls` are correct; keyboard toggling works.
- [ ] Polling every 2s does not reset the user's expanded/collapsed choice.
- [ ] `trend-drivers` height sync still works — no clipped content or double scrollbars.
- [ ] (If request-activity collapsible added) chart collapses independently, summary stays visible, state persists across reloads.

---

## 6. Risks & Mitigations

- **Stale `driverHeight` after collapse:** `driverHeight` is set from `trendPanel` height only — collapsing drivers cannot make it grow, so no stale-height bug. Expanding beyond trend height will overflow the fixed height; mitigated by internal scrolling on `.trend-drivers > .panel .list`. If overflow is undesired, clear `driverHeight` when `drivers.scrollHeight > trendPanel.height`.
- **Click target too small / accidental toggle:** toggle is the left 80% of the row (title area), not a tiny chevron — large hit area, low misclick rate.
- **`prevTabsRef` stale tabs shown as expandable:** intentional — preserves tabs through a transient empty poll; if the backend truly has 0 tabs for >1 poll, `rawTabs` becomes `[]` and `hasTabs` correctly becomes false.

---

## 7. Open Questions (Needs User Confirmation)

1. **Default state:** collapsed (proposed) vs expanded for the default browser? Collapsed is cleaner; expanded is more discoverable.
2. **Request activity — what is the actual desired change?** Options A–D in §2.2 — which one matches the intent behind the title?
3. **Persistence:** should expanded/collapsed survive a page reload via `localStorage`, or is in-memory per-session sufficient?
4. **Tab count badge:** keep the existing `· N tabs` in `item-detail` only, or also show a pill/badge next to the chevron?

---

## 8. Addendum 2026-09-01 — Bug: `trend-drivers` Height Desync on Small → Large Resize

### 8.1 Report

> "Browser drivers is to be of the same height as the graph. But when I resize the page from smaller width to higher width, the browser driver takes full width and does not show a scroll bar. And because of it, the graph also has full width and shows empty space in the bottom."

Reproduced live on `http://10.69.1.164:1994/console` (target `f6d83f2ee377`):

- **Initial wide (1920px):** `.trend-drivers` = `1078px 380px` (side-by-side), `trendPanel` 414px, `driversPanel` 414px (`style.height=414px`), `list` 360/722 → scrollable ✓
- **Narrow (900px, `@media max-width:1050px` → `1fr` stacked):** `trendPanel` 343px, `driversPanel` 777px natural, `driversStyle=""`, `list` 722/722 → no cap, full-height stacked ✓
- **Back to wide (1920px):** `trendPanel` 777px (stretched), `driversPanel` 777px (`style.height=777px`), `list` 722/722 → **no scrollbar**, row `777px`, graph empty space below chart (chart 340px inside 777px panel) ✗

### 8.2 Root Cause

`src/web-console/src/style.css:306-310` (`src/web-console/src/style.css:306`):

```css
.trend-drivers {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 380px;
  align-items: stretch;   /* ← cause */
}
@media (max-width: 1050px) { .trend-drivers { grid-template-columns: 1fr; } }
```

`src/web-console/src/pages/status/index.jsx:180-193` `syncDriverHeight()`:

```js
const sideBySide = Math.abs(trendPanel.getBoundingClientRect().top - driversPanel.getBoundingClientRect().top) < 2;
if (!sideBySide) { setDriverHeight(null); return; }
const h = trendPanel.getBoundingClientRect().height; // ← polluted when stretched
setDriverHeight(h);
```

With `align-items: stretch` (grid default), the single grid row's track height is `max(trend natural height, drivers natural height)`. When stacked narrow → wide with `driverHeight=null`, the row becomes `max(414, 777)=777`. Both panels are stretched to 777. `syncDriverHeight` then measures `trendPanel` as 777 (stretched, not its natural 414) and sets `driversPanel.style.height = 777px`. Drivers list never gets capped (`722/722`), and the graph panel shows ~400px of empty space below the 340px chart. The driver "takes full width" description is the stacked-vs-side-by-side confusion: after the bug, drivers height equals graph height but both are the *wrong* height (max instead of graph height).

`syncFeedHeight` (`src/web-console/src/pages/status/index.jsx:164-179`) does **not** have the same bug — it measures the inner `.engine-grid` (`grid.getBoundingClientRect().height`), not the outer panel, so stretch does not pollute it.

### 8.3 Fix (Required for §1 to work correctly)

The collapsible-tabs change in §1 depends on a stable height cap; the bug must be fixed in the same changeset.

**CSS — `src/web-console/src/style.css:306`:**

```diff
 .trend-drivers {
   display: grid;
   grid-template-columns: minmax(0, 1fr) 380px;
   gap: 10px;
-  align-items: stretch;
+  align-items: start;      /* ← do not stretch panels to row max */
 }
```

With `start`, panels keep natural heights (trend 414, drivers 777). `syncDriverHeight` can then measure the *unpolluted* trend height (414) and cap drivers to it, after which both are 414 and the row track becomes 414. The empty-space and missing-scrollbar symptoms disappear.

Verified live with inline override (`td.style.alignItems='start'`): narrow 900px → wide 1920px now yields `trend 414 / drivers 414 / list 360/722` with `gridTemplateRows: 414px` and scrollbar present.

**JS — `src/web-console/src/pages/status/index.jsx:180-193` (hardening, optional but recommended):**

Even with `start`, keep the JS robust against future stretch re-introduction:

- Prefer measuring the trend's *content* height if available (e.g. `trendPanel.querySelector('.request-trend-chart')` + heading) or document that `trendPanel.getBoundingClientRect().height` is now reliable because of `align-items: start`.
- Alternatively, clear the drivers inline height before measuring (`driversPanel.style.height=''`) — but with `start` this is unnecessary; the CSS fix alone is sufficient.

No server change. Narrow layout (`@media 1050px → 1fr`) is unaffected — `start` vs `stretch` does not change stacked rendering; both panels remain full-width with natural heights and no cap.

### 8.4 Files Touched (Addendum)

| File | Change |
|------|--------|
| `src/web-console/src/style.css:306` | `align-items: stretch` → `start` |
| `src/web-console/src/pages/status/index.jsx:180-193` | Optional: comment that measurement now relies on `start`; no logic change required, but add a note / fallback measurement if stretch is ever re-added |

### 8.5 Verification (Addendum)

Add to §5 checks:

- [ ] At 1920px wide: `trendPanel` ≈ 414px, `driversPanel` ≈ 414px (`style.height` matches trend), `.list` shows scrollbar (client < scrollHeight).
- [ ] Resize to 900px (stacked): `trendPanel` ≈ 343px, `driversPanel` natural 777px, no inline height, no scrollbar cap, `gridTemplateColumns` is `858px`.
- [ ] Resize back to 1920px: dimensions return to 414/414/360 without reload, no empty space in graph, scrollbar reappears.
- [ ] Rapid resize 900↔1920 does not leave stale `777px` height.

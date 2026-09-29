# 53 — Loading Spinners Across the Console

**Status:** Planned
**Created:** 2026-09-11
**Scope:** Web console (`src/web-console/src/**`). All views and async actions that currently show only static text (or nothing) while a request is in flight.

---

## Summary

Add a consistent, reusable loading spinner everywhere the console currently signals progress with text-only labels (or with no signal at all). Only **Web tools** (`tools-loading`) and **API keys** (`api-key-loading`) have a real page-load spinner today; the status dashboard, hints, and manage pages show nothing, and every button-level async action (`Save`, `Validate`, `Run test`, `Delete`, `Reset`, `Forget`, VNC toggle) shows only a `"…"`/`"Saving…"` text swap.

The work is: (1) a tiny shared `<Spinner />`/`<Loading>` component + one shared loading-block CSS class (reusing the existing `.activity-spinner` primitive), (2) wire it into each listed spot, (3) rebuild the console bundle. No server-side changes.

---

## 1. Current State — Existing Spinners

`.activity-spinner` (the spinning ring) is defined once at `src/web-console/src/style.css:1492` and reused in these places today:

| Place | File:line | How |
|-------|-----------|-----|
| Web tools initial load | `pages/tools/index.jsx:27-31` (CSS `.tools-loading` at `style.css:2129`) | `activity-spinner` + "Loading tools…" |
| API keys initial load | `pages/keys/index.jsx:199-201` (CSS `.api-key-loading` at `style.css:2643`) | `activity-spinner` + "Loading keys…" |
| Activity detail modal fetch | `components/ActivityDetailModal.jsx:105-106` (CSS `.activity-detail-loading` at `style.css:1659`) | `activity-spinner` + "Loading details…" |
| Live-feed **running** row (real-time, not a load) | `pages/status/LiveFeed.jsx:272-276` | inline `activity-spinner` on `status === "running"` |

These four are the reference pattern: `<span className="activity-spinner" />` + a muted text label. Everything else below is missing it.

---

## 2. Gap Analysis — Places That Need a Spinner

### A. Page-load states (full-view "nothing has arrived yet" moments)

| # | View | Where | Current UI | Why it needs a spinner |
|---|------|-------|-----------|------------------------|
| A1 | **Status dashboard** (`StatusView`) | `pages/status/index.jsx` + `main.jsx` `load(true)` | Renders immediately with `snapshot = {}` → flashes **"Navigator has a blocking issue / server unreachable"**, all zeros, empty charts until the first heavy `/stats`+`/console/config`+`/console/logs` round-trip returns. No indicator at all. | The FIRST full snapshot takes the longest (CDP per-backend round-trips in `/stats`, per AGENTS.md §Navigator CLI). A brief dashboard-level spinner/skeleton between `destination.justNavigated`/mount and the first successful snapshot removes the bogus "critical" flash. |
| A2 | **Request activity trend** | `pages/status/ActivityChart.jsx:111` | `<Empty>Loading activity trend…` — text only. | Text-only; chart area shows a lone line while the trend endpoint loads. |
| A3 | **Domain hints list** | `pages/hints/index.jsx:138-141` | `!state ? <Empty>Loading hints…` — text only. | This is the exact counterpart of `tools-loading`/`api-key-loading`; should match them. |
| A4 | **Manage** | `pages/manage/index.jsx` (whole body) | Nothing. While `config` is `{}` the table renders the "No variables match" row and the header shows an empty path. | See note below — additionally, a direct deep-link to `/console/manage` never even fetches `/console/config` (see §6 note), so the spinner would sit there until the user visits Status. The spinner still belongs: it at least signals "waiting for server data" instead of "no variables". |

### B. Button / in-place async actions (text-only labels today)

| # | Action | Where | Current UI | Proposed |
|---|--------|-------|-----------|----------|
| B1 | **Web tools — Send request** | `pages/tools/RequestForm.jsx:38-40` + `useTools.js` `running` | Button text "Running..." + response status line "Running..." | Small spinner inline in the response **status** line (primary visual) and/or the button, while `running` is true. Requests can take 10s+ (page fetch, screenshot). |
| B2 | **Domain hints — Run test** | `pages/hints/HintTest.jsx:143-145` | Button text "Running…". Test hits the real browser via `/extract` — can take many seconds. | Spinner in the button (and the result area shows nothing until the test resolves). |
| B3 | **Domain hints — Validate** | `pages/hints/HintEditor.jsx:363-365` | Button text "Validating…". | Spinner. Server round-trip. |
| B4 | **Domain hints — Save** | `pages/hints/HintEditor.jsx:366-368` | Button text "Saving…". | Spinner. |
| B5 | **Domain hints — Delete** | `pages/hints/index.jsx:191-200` | Button text "Deleting…" (per-row). | Spinner. |
| B6 | **API keys — Create/Edit save** | `pages/keys/index.jsx:163-165` | Button text "Saving...". | Spinner. |
| B7 | **Manage — Save / Revert / Reset** | `pages/manage/index.jsx:45-47,116-141,178-183` | Message line `setMessage("Saving...")` — text in the toolbar. | Spinner in the toolbar message line (or on the clicked button). |
| B8 | **VNC toggle (header)** | `components/Layout.jsx:92-96` | Button swaps to disabled "Working...". | Spinner. Global header action. |
| B9 | **Search engine — reset / reset all** | `pages/status/Engines.jsx:69,114` | Button text "resetting...". | Spinner. |
| B10 | **Browser driver — Forget** | `pages/status/Drivers.jsx:150-152` | Button text "…". | Spinner. |

### C. Optional / minor (note, not core)

| # | Place | Reason |
|---|-------|--------|
| C1 | API keys — **Revoke** (`keys/index.jsx:214-230`) | Fire-and-forget, zero feedback while the POST runs. A spinner is optional; the revoke is fast. |
| C2 | Hints test — **screenshot fetch** (`HintTest.jsx:94-118`) | "No screenshot available." briefly renders before the image arrives. Optional spinner while the screenshot request is in flight. |

### Already correct — leave alone

- Live-feed running rows (`LiveFeed.jsx:272-276`) — the intended "real-time progress" spinner. Keep.
- Activity detail modal (`ActivityDetailModal.jsx:105-106`) — keep as-is.
- Engine/driver/row-level "…" prefixes that already have disabled states — upgraded in §B only.

---

## 3. Design

**One primitive, two shapes.** Everything reuses the existing `.activity-spinner` ring; adding a second, derived size for buttons.

1. **`<Loading text="…" />` page-block component** — in `components/ui.jsx`:
   ```jsx
   export function Loading({ children }) {
     return (
       <div className="loading-block">
         <span className="activity-spinner" aria-hidden="true" />
         {children}
       </div>
     );
   }
   ```
   One CSS class `.loading-block` absorbs the shared bits of `.tools-loading` / `.api-key-loading` / `.activity-detail-loading` (muted color, 12px sans, flex row with gap, ~14px padding). Replaces those three ad-hoc classes with a single `.loading-block` (or keeps them as aliases — decide in implementation; preference: one class, delete the near-duplicates).

2. **`<Spinner />` inline variant for buttons/status lines** — same span, sized for buttons (`width/height 9-10px`, border 1.3px — mirrors `.feed-attempt .activity-spinner` at `style.css:1513-1518`):
   ```jsx
   export function Spinner({ small }) {
     return <span className={`activity-spinner${small ? " small" : ""}`} aria-hidden="true" />;
   }
   ```
   CSS: `.activity-spinner.small { width: 9px; height: 9px; border-width: 1.3px; }`.
   Buttons keep their existing label swap AND gain the spinner prefix, e.g. `<Spinner small /> Saving…`, so the text stays descriptive while the ring runs.

3. **Keep `Empty` for results, use `Loading` for pending.** `Empty` (already exists, `ui.jsx:24`) is for "loaded, nothing here". `Loading` is for "request not finished". The hints list and trend chart currently misuse `Empty` as a loading placeholder — they switch to `Loading` and keep `Empty` only for true empty outcomes (e.g. "No hints match your search").

4. **Error states already exist everywhere they can occur** (`.tools-error`, message `err` kind, `Empty>{error}`) — nothing new needed there.

---

## 4. Implementation Steps

### 4a. `src/web-console/src/components/ui.jsx`
Add `Loading` and `Spinner` components (§3.1, §3.2).

### 4b. `src/web-console/src/style.css`
- Add `.loading-block` (and `.loading-block .activity-spinner` sizing ~14px like `.tools-loading`).
- Add `.activity-spinner.small` and a `.has-spinner` button utility (flex, gap, centered) if the existing `.button` needs alignment help.
- Remove/replace `.tools-loading`, `.api-key-loading` with the shared class (keep `.activity-detail-loading` since it's distinct modal chrome, or fold it too — maintainer choice; folding all three into `.loading-block` is the cleaner end-state).

### 4c. Page-load spots — swap `Empty`/nothing → `Loading`
- `pages/status/ActivityChart.jsx:111` — `!buckets.length` → `<Loading>Loading activity trend…</Loading>` (keep `error` branch as `Empty`).
- `pages/hints/index.jsx:141` — `!state` → `<Loading>Loading hints…</Loading>`.
- `pages/manage/index.jsx` — show `<Loading>Loading configuration…</Loading>` in place of the table when `!config.configValues && !config.env` (no schema yet). See §6 for the adjacent deep-link data gap.
- **Status dashboard** — the flash-on-mount fix (A1). Lightest correct approach: in `main.jsx` track a `snapshotReady` (set when the first full `load(true)` either resolves or fails), and have `StatusView` render a dashboard `Loading` block (or skeleton) in place of the overview+content sections until `snapshotReady`. Alternative: state `ok === undefined` until first load settles, and gate the banner/metrics on that. Implementation detail left open but required: the misleading "server unreachable" critical state must not render before the first real poll.

### 4d. Button / action spots — prefix buttons or status lines with `<Spinner small />`
- `RequestForm.jsx` submit + `ResponsePanel` status line when `running`.
- `HintTest.jsx` run-test button when `running`.
- `HintEditor.jsx` Validate and Save buttons when `validating`/`saving`.
- `hints/index.jsx` Delete button when `deleting === index`.
- `keys/index.jsx` modal Save button when `saving`.
- `manage/index.jsx` toolbar message line when a save/revert/reset is in flight (add an in-flight flag alongside the message text).
- `Layout.jsx` VNC button when `vncBusy`.
- `Engines.jsx` engine reset buttons when `resetStatus` active.
- `Drivers.jsx` Forget button when `forgetting === backend`.

### 4e. Optional (C1/C2) — only if scope allows
- Keys revoke in-flight feedback.
- Hint test screenshot-loading indicator.

### 4f. Build + deploy
```bash
docker exec navigator npm install --include=dev && docker exec navigator npm run console:build
```
Console bundle is served from the bind-mounted `src/web-console/dist` — no container restart or image rebuild. Verify `/console` references the new hashed `assets/index-*.js`.

---

## 5. Edge Cases

| Case | Behavior |
|------|----------|
| Fast loads (<100ms) | Spinner flashes briefly; acceptable (same as today's tools/keys). No minimum-display timer wanted. |
| Request fails | Existing error branches (`Empty`/message `err`) take over; spinner must be cleared in `finally`. |
| Loading → Empty | Switching from `Loading` to `Empty` must not reuse the spinner markup (Empty has no ring) — distinct components. |
| Direct deep-link `/console/manage` | Spinner shows and stays because config is never fetched (see §6). Plan keeps the spinner (correct signal) and calls out the data fix separately. |
| Button already disabled while busy | Spinner is purely visual; keep `disabled={...}` unchanged. |
| `activity-spinner` in narrow/feed context | `.small` variant reuses existing feed sizing; no layout shift in app header buttons. |
| Reduced motion | Optional: respect `prefers-reduced-motion` by stopping the ring spin (single CSS addition, low cost — leave to implementer). |

---

## 6. Related Observation (out of core scope, flag to user)

**Manage page never loads its own config on direct navigation.** `main.jsx:124` runs `load(mode === "status")` — only the Status view triggers the heavy `/console/config` fetch. Landing directly on `/console/manage` (or refreshing there) leaves `snapshot.config = {}` forever, because the 2s poll also runs `load(modeRef.current === "status")` (light `/health` only) for non-status modes. The spinner from A4 would therefore spin indefinitely there. Recommend a follow-up: `load(true)` (or at least a config-only fetch) when `mode === "manage"`. Listing here so the spinner work doesn't accidentally "fix" the visible symptom while leaving the data gap.

---

## 7. Files Touched

| File | Change |
|------|--------|
| `src/web-console/src/components/ui.jsx` | Add `Loading` + `Spinner` components |
| `src/web-console/src/style.css` | `.loading-block`, `.activity-spinner.small`; fold/remove `.tools-loading`, `.api-key-loading` duplicates |
| `src/web-console/src/pages/status/ActivityChart.jsx` | `Loading` for empty-buckets state |
| `src/web-console/src/pages/hints/index.jsx` | `Loading` for initial hints list; spinner on Delete |
| `src/web-console/src/pages/manage/index.jsx` | `Loading` while config absent; in-flight flag + spinner on save/revert/reset |
| `src/web-console/src/main.jsx` | Status-dashboard first-snapshot gate (spinner/skeleton vs fake-critical flash) |
| `src/web-console/src/pages/tools/RequestForm.jsx` (+ `ResponsePanel.jsx`) | Spinner on Send running + response status |
| `src/web-console/src/pages/hints/HintTest.jsx` | Spinner on Run test (running) |
| `src/web-console/src/pages/hints/HintEditor.jsx` | Spinners on Validate / Save |
| `src/web-console/src/pages/keys/index.jsx` | Spinner on Save (modal) |
| `src/web-console/src/components/Layout.jsx` | Spinner on VNC toggle (vncBusy) |
| `src/web-console/src/pages/status/Engines.jsx` | Spinners on engine reset buttons |
| `src/web-console/src/pages/status/Drivers.jsx` | Spinner on Forget button |
| `src/web-console/src/pages/status/LiveFeed.jsx`, `components/ActivityDetailModal.jsx` | **None** — already correct |

## 8. Verification

1. Rebuild console (`4f`), hard-refresh `http://10.69.1.164:1994/console`.
2. **Web tools / API keys** — unchanged behavior, spinner still shows on first load.
3. **Status** — reload: no "server unreachable" flash; the trend chart shows a spinner while loading.
4. **Hints** — list load shows the spinner; open editor → Validate/Save show rings; delete a hint → ring on that row's button.
5. **Manage** — shows the loading block while config is absent (and, if §6 follow-up lands, populates after it).
6. Run a slow tool (`web_search` on Web tools) → status line + button show the ring, disabled while running.
7. VNC toggle, engine reset, driver Forget → ring during the in-flight request.
8. Confirm no page shows a stuck spinner after the request finishes or errors (all `finally` paths clear state).
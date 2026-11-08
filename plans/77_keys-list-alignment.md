# 77 — Keys list row alignment + overflow fixes

## Status: Proposed — 0/4 items done (2026-10-16)

**Priority:** Normal
**Created:** 2026-10-16
**Reporter note:** `/console/keys` — "the UI is not aligned correctly."

## 1. Goal

The API keys list (`src/web-console/src/pages/keys/index.jsx` + `.api-key-row*` CSS)
renders its header and rows on a shared 5-column grid
(`Name | Created | Key | Access | actions`). System rows (plan 73, "Web Tools UI")
inject an extra full-width note **inside** that grid, which breaks auto-placement
and pushes that row's cells out of column. Separately, the Access track can force
the grid wider than the panel and the actions track is too narrow for Edit+Revoke
side by side. Fix the row structure + grid tracks so header and every row align at
all widths, with no overflow.

## 2. Current behaviour (root causes, not symptoms)

1. **System note lives inside the 5-col grid (the misalignment).**
   `index.jsx:350-352` renders per key:
   `<b>name</b>` (col 1) → conditional `<small style="gridColumn: 1/-1">Used by…</small>`
   → `<time>` → `<code>` → `<small>access</small>` → `<div actions>`.
   That is 6 grid items in a 5-track grid. With `grid-auto-flow: row` (default) the
   spanning note wraps to row 2 and every following cell shifts down/left — the
   system row's Created/Key/Access/actions no longer sit under the header columns.
   Non-system rows (5 items) align fine, so the page looks "not aligned" as soon as
   the system key exists (i.e. always).
2. **Access track has no minimum bound.** `style.css:3130`
   `grid-template-columns: … 1fr 116px` — the 4th track is plain `1fr`
   (= `minmax(auto, 1fr)`), so the nowrap one-line access text from plan 73
   (§3.4, `white-space: nowrap`) forces the track wider instead of ellipsizing,
   pushing the actions column out of alignment/overflowing the panel on narrow
   widths. The `<small>` also lacks `overflow: hidden` / `min-width: 0`.
3. **Actions track too narrow + conflicting alignment.**
   `116px` fits one button, not Edit+Revoke + 6px gap (~130px+). Buttons wrap or
   overflow, making rows uneven heights. `.api-key-row .button { justify-self: end }`
   (`:3165`) fights `.api-key-row-actions .button { justify-self: auto }` (`:3173`).
4. **Grid items can't shrink.** `.api-key-row b/code` have ellipsis rules but no
   `min-width: 0`, so long names/previews force their tracks wider (grid default
   `min-width: auto`). Same for the access `<small>` and the actions `<div>`.

## 3. Changes

### 3.1 JSX — move the system note out of the column grid
`src/web-console/src/pages/keys/index.jsx:349-371` — wrap each key in a row
container; the 5-col grid holds exactly 5 children, the note sits below it:

```jsx
<div className="api-key-row-wrap" key={key.id}>
  <div className="api-key-row">
    <b>…name + System badge…</b>
    <time>…</time>
    <code>…</code>
    <small>…access one-liner…</small>
    <div className="api-key-row-actions">…</div>
  </div>
  {key.system && <div className="api-key-system-note">Used by navigator for the Web Tools page.</div>}
</div>
```

- Drop the inline `style={{ gridColumn: "1 / -1", … }}` — styling moves to
  `.api-key-system-note` (muted, 10-11px, padding matching row `6px 8px`, no grid).
- Keep the `(System)` badge inside `<b>` (col 1) as today.
- Border/top-rule moves to the wrap (`.api-key-row-wrap + .api-key-row-wrap`
  border-top) so the note doesn't draw a second divider; `.api-key-row` keeps
  only the grid, no border.

### 3.2 CSS — bounded tracks, shrinkable items, roomy actions
`src/web-console/src/style.css:3122-3183`:

- Tracks: `grid-template-columns: minmax(160px, 1fr) 150px minmax(210px, 1.25fr) minmax(0, 1fr) auto;`
  (Access `1fr` → `minmax(0, 1fr)` so it ellipsizes instead of forcing width;
  actions `116px` → `auto` so Edit-only and Edit+Revoke rows both right-align
  without wrapping.)
- Add `min-width: 0` to `.api-key-row > *` (or at least `b, time, code, small,
  .api-key-row-actions`) so ellipsis actually engages.
- Access small: `overflow: hidden; text-overflow: ellipsis;` alongside existing
  `white-space: nowrap` (keeps plan 73's one-line intent, clips instead of
  overflowing).
- Actions: keep `.api-key-row-actions { display: flex; gap: 6px; justify-content: flex-end; white-space: nowrap; }`,
  remove the blanket `.api-key-row .button { justify-self: end; }` (only the
  container aligns; buttons keep `justify-self: auto`).
- New `.api-key-system-note { padding: 0 8px 6px; color: var(--muted); font: 10px var(--sans); }`.
- Heading (`.api-key-heading`) shares the grid — verify its 5 spans land in the
  same 5 tracks after the change (no structural change needed there).
- Responsive `@media (max-width: 640px)` rule (`:3297+`): unchanged behaviour
  (collapses to `1fr auto`, hides time/code/access) — re-verify the wrap variant
  doesn't leak the note (note stays visible, full width).

Out of scope: no server change, no new columns, no change to modal/permissions UI,
no change to the responsive collapse design. The redundant `className="grid keys-grid"`
(identical definitions, `:2878` vs `:3390`) may be collapsed to one class while
touching the file.

## 4. Testing

- **Console build:** `docker exec navigator npm install --include=dev && docker exec navigator npm run console:build`
  (or host `sudo npm run console:build` per plan 75 when docker is unavailable).
- **Live (after restart/rebuild):** open `/console/keys` wide + narrow:
  - header columns line up with every row, including the `Web Tools UI` system row;
  - system note sits below its row, full width, no divider glitch;
  - Access column stays on one line with ellipsis instead of pushing actions out;
  - Edit+Revoke fit on one line; system row (Edit only) right-aligns in the same column;
  - responsive ≤640px still collapses (name + actions only, note visible).
  - screenshot before/after at the same viewport for the report.
- **Lint/tests:** `npm run lint` clean on touched files; `npx vitest run tests/mcp-server.test.js`
  (no server change expected, guards plan 73's system-key behaviour).

## 5. Checklist

- [ ] 1. JSX: per-key wrap, note moved out of the 5-col grid, inline gridColumn style removed.
- [ ] 2. CSS: bounded tracks (`minmax(0,1fr)` access, `auto` actions), `min-width: 0`, access ellipsis, actions alignment cleanup, `.api-key-system-note` style.
- [ ] 3. Console build + live verify wide/narrow with before/after screenshots.
- [ ] 4. Lint (+ mcp-server tests green) and absorb into `docs/` if durable.

## 6. Not doing

- No server/DB change (system flag + guards from plan 73 untouched).
- No new tests file unless the SSR-render trick from plan 75 proves cheap.
- No commit unless asked.

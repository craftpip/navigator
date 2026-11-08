# 78 — Domain hints: export/import + multi-select bulk delete

## Status: Proposed — 0/5 items done (2026-10-16)

**Priority:** Normal
**Created:** 2026-10-16
**Request:** Domain hints list needs (1) export + import of hints, (2) per-row
checkboxes with a select-all header checkbox to delete many at once or export
many together.

## 1. Goal

Extend the Domain hints console page (`src/web-console/src/pages/hints/index.jsx`)
with selection + bulk operations, backed by two small server endpoints:

- **Export** selected hints (or all) as a JSON file download (client-side blob,
  no server change).
- **Import** a JSON file of hints via a new bulk-import endpoint (validate each,
  skip duplicates with a per-item report, single atomic write).
- **Bulk delete** the selected hints via a new bulk-delete endpoint (single
  atomic write, index-shift safe), with the existing confirm dialog.
- **Checkboxes**: one per row + a header select-all (checked / indeterminate /
  unchecked). Wildcard (`domain: "*"`) and managed (`_managed`) rows are not
  selectable — same as today they can't be deleted via the static path.

## 2. Current behaviour

- List renders one row per hint with Edit + Delete (single) only
  (`index.jsx:145-211`); delete is `DELETE /console/api/hints/:index`
  (`index.jsx:26-39`, server `src/mcp-server.js:4884-4894` → `deleteHint()` at
  `:1591`, which refuses the wildcard).
- Create/update go through `POST /console/api/hints` / `PUT /console/api/hints/:index`
  (`:4836-4893`) → `createHint()` / `updateHint()` (`:1530-1589`) with
  `validateHintRule` + duplicate check (`hintDuplicateKey`, `:1508`) + serialized
  writes (`queueHintMutation`, `:1501`).
- `GET /console/api/hints` returns `[...staticHints, ...managedRows]`
  (`:4806-4822`); managed rows carry `_managed: true` and are edited/deleted via
  `/console/api/hints/managed/:id` (`:4847-4870`). A managed row's list `index`
  is **not** a valid static index — single delete already only makes sense for
  static rows. Bulk ops therefore scope to static rows only (see §4).
- No export, no import, no selection state anywhere in the hints UI.

## 3. Changes

### 3.1 Server — `POST /console/api/hints/import`
Body: `{ hints: [...], onDuplicate: "skip" (default) | "error" }`.
Inside one `queueHintMutation()`: load static hints, validate each entry with
`validateHintRule(hint, { scope: "static", aiModelIds, browserNames })`
(same args as `createHint`), reject wildcard-domain entries as errors, check
`findHintDuplicate()` against the growing list (file + already-accepted batch);
duplicates are skipped (collected into `skipped[]` with reason) unless
`onDuplicate: "error"`, which fails the whole batch with no write. Valid entries
append in order; single `saveDomainHints()` write. Response:
`{ ok: true, imported: N, skipped: [{hint, reason}], errors: [{hint, error}] }`.
Non-array body / empty array → 400, no write.

### 3.2 Server — `POST /console/api/hints/bulk-delete`
Body: `{ indices: [int, …] }`. Validate: non-empty array, all integers,
in range, none pointing at the wildcard (reuse `deleteHint`'s refusal).
Dedupe + sort descending, splice all, single `saveDomainHints()` write inside
one `queueHintMutation()`. Response `{ ok: true, removed: N, count }`.
Any invalid index → 400, no write (all-or-nothing).

### 3.3 Console — selection + toolbar
`src/web-console/src/pages/hints/index.jsx`:

- `selected` state: `Set` of static indices (reset on `load()` since indices shift).
- Header row gains a checkbox cell; each selectable row gains one. Wildcard and
  `_managed` rows render no (or disabled) checkbox with a `title` explaining why.
- Header checkbox: checked when all selectable filtered rows are selected,
  indeterminate when some are (use a ref + `indeterminate` prop effect);
  clicking toggles all selectable **filtered** rows (respects the search box —
  label the toolbar count as "N selected" so scope is visible).
- Toolbar (`manage-toolbar`): `Export selected` (disabled at 0; downloads
  `{ exportedAt, count, hints: [...] }` JSON blob, filename
  `domain-hints-export-<YYYYMMDD>.json`), `Import` (hidden `<input type=file
  accept=".json,application/json">` → parse → must be an array (or
  `{hints: [...]}` from our own export) → POST import → result summary in the
  page message area + `load()`), `Delete selected` (disabled at 0; existing
  `confirm()` wording extended with the count → POST bulk-delete → `load()`).
- Keep single-row Edit/Delete exactly as-is.

### 3.4 CSS
Add minimal rules for the checkbox column (narrow fixed track — the
`.hints-row` grid gains one leading `auto` column; heading + rows share it),
toolbar selected-count text, and the import-result summary line (reuse existing
`.manage-message` / `.empty` styles where possible).

## 4. Out of scope

- Managed (`_managed`) hints: not selectable, not exported/imported — they live
  in a different store with a different edit path. Export file contains static
  hints only; note this in the export dialog/summary.
- No bulk edit, no drag-reorder, no CSV format (JSON only — it round-trips the
  exact stored shape).
- No change to hint validation rules, duplicate definition, or the wildcard
  auto-manage behaviour.

## 5. Testing

- **Unit** (extend `tests/` hints coverage): import accepts N valid hints in one
  write; invalid entries reported per-item without blocking valid ones;
  `onDuplicate: "error"` writes nothing; wildcard entry rejected; bulk-delete
  removes the exact indices (descending-splice correctness with ≥3 rows),
  refuses wildcard/out-of-range with no write, dedupes repeated indices.
- **Console build:** `docker exec navigator npm install --include=dev &&
  docker exec navigator npm run console:build`.
- **Live (after restart):** select-all header checkbox state cycle
  (unchecked → checked → indeterminate); export selected → file downloads and
  re-imports cleanly (duplicates reported as skipped on second import);
  bulk-delete 2+ hints with confirm; wildcard row has no checkbox; search
  filter + select-all affects filtered rows only.
- **Lint:** `npm run lint` clean on touched files.

## 6. Checklist

- [ ] 1. Server: `POST /console/api/hints/import` (validate + dup-skip + one write).
- [ ] 2. Server: `POST /console/api/hints/bulk-delete` (validate + descending splice + one write).
- [ ] 3. Console: checkboxes + select-all (indeterminate) + toolbar (export/import/delete-selected) + result messages.
- [ ] 4. CSS for the checkbox column + toolbar/summary.
- [ ] 5. Tests (unit + live verify) and absorb into `docs/` if durable.

## 7. Not doing

- No commit unless asked.

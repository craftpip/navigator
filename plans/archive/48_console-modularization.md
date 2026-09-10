# Plan: Modularize web-console for React (main.jsx 4658 → done; finish status/manage/tools)

**Created:** 2026-08-26  
**Last updated:** 2026-09-07 — reconciled the plan with the *actual* current state. Phases 1–2 and the **hints** page are DONE; the **status**, **manage**, and **tools** page splits were never carried out. This plan now reflects reality and scopes the remaining work.
**Scope:** Split the remaining monolith page files (`pages/status/index.jsx`, `pages/manage/index.jsx`, `pages/tools/index.jsx`) into focused module files per React component-organization conventions.
**Invariant (unchanged):** The CSS file (`style.css`) stays monolithic for now — it's already logically ordered section-by-section (see `grep -n '^/\* '` markers at 97, 1088, 1151, 1176, 1259, 1312, 1949, 2107, 2343, 2455, 2886) and splitting CSS across files is a separate concern, deferred unless the user asks.

---

## Current State (verified 2026-09-07)

The first modularization pass is **complete**. `main.jsx` shrank from 4658 → **231 lines** (routing/polling shell only), and `lib/`, `components/`, and `pages/hints/*` are already split. What remains are three oversized single-file pages + the monolithic stylesheet:

| File | Lines | Contents (co-located components/functions) |
|------|------:|--------------------------------------------|
| `pages/status/index.jsx` | **1063** | `ActivityLineChart`, `RequestActivityTrend`, `computeStatus`, `StatusView`, `Runtime`, `copyText`, `RelayAuth`, `Drivers`, `Engines`, `Work`, `buildFeed`, `LiveFeed`, `Logs` — 13 top-level definitions, one file |
| `pages/manage/index.jsx` | **959** | `MANAGE_GROUPS`, `validateEntryValue`, `MultiSelect`, `PostProcessorModelsEditor`, `BrowserArrayEditor`, `ValueControl`, `normalizeDraftValue`, `compareDraftValue`, `Manage`, `FragmentRows` — 10 definitions, one file |
| `pages/tools/index.jsx` | **502** | `Tools`, `extractToolResult` — one container + one impure helper (~200 lines of SVG-preview render logic inline) |
| `style.css` | **3611** | Monolithic (kept as-is per invariant) |
| `pages/hints/*` (7 files) | 214–381 each | Already modular — no change |
| `components/` (3 files) | 198–269 each | Already modular — no change |

The old plan's proposed status split (`Runtime.jsx`, `Drivers.jsx`, `Engines.jsx`, `Work.jsx`, `LiveFeed.jsx`, `ActivityChart.jsx`) and manage split (`constants.js`) were **planned but never created**. They are the core of the remaining work below.

---

## Target Structure

```
src/web-console/src/
  main.jsx              ← DONE (231 lines: imports + createRoot)
  app.jsx
  markdown.js
  lib/
    format.js           ← DONE
    request.js          ← DONE
    routing.js          ← DONE
    hooks.js            ← DONE (useNarrow)
  components/
    Layout.jsx          ← DONE
    ui.jsx              ← DONE
    ActivityDetailModal.jsx ← DONE
  pages/
    status/
      index.jsx         ← StatusView only (composes the split children below)
      ActivityChart.jsx ← ActivityLineChart, RequestActivityTrend, requestValue, computeStatus, REQUEST_SERIES
      Runtime.jsx       ← Runtime
      Work.jsx          ← Work
      LiveFeed.jsx      ← buildFeed, LiveFeed
      Logs.jsx          ← Logs, ERROR_FILTERS
      Drivers.jsx       ← Drivers, RelayAuth, copyText
      Engines.jsx       ← Engines
    tools/
      index.jsx         ← Tools (composer) — tabs + error + workspace wiring
      useTools.js       ← useTools hook — state, loaders, mcpRequest, run/clear
      RequestForm.jsx   ← RequestForm — schema-driven MCP request form
      ResponsePanel.jsx ← ResponsePanel — response head, view toggle, SVG/HTML preview, images
      extract.js        ← extractToolResult
    manage/
      index.jsx         ← Manage, FragmentRows
      constants.js      ← MANAGE_GROUPS, PP_*, BROWSER_*, DEFAULT_FORMATS
      validate.js       ← validateEntryValue, normalizeDraftValue, compareDraftValue
      MultiSelect.jsx   ← MultiSelect
      PostProcessorEditor.jsx ← PostProcessorModelsEditor, parseEntries, serializeEntries
      BrowserArrayEditor.jsx  ← BrowserArrayEditor, normalizeBrowserType, parseBrowsersEntries, serializeBrowsersEntries
      ValueControl.jsx  ← ValueControl
    keys/
      index.jsx         ← DONE
    hints/
      index.jsx         ← DONE
      HintEditor.jsx    ← DONE
      HintTest.jsx      ← DONE
      HintFields.jsx    ← DONE
      FlowEditor.jsx    ← DONE
      HintGuide.jsx     ← DONE
      constants.js      ← DONE
```

**DONE (2026-09-07): status (8 files), tools (5), manage (7).** `main.jsx`/`app.jsx` already compose pages and need no change.

---

## Why This Shape (React conventions)

- **One component (or one coherent concern) per file.** `status/index.jsx` violates this badly — 13 unrelated top-level definitions share a file.
- **`pages/<view>/index.jsx` re-exports the page container** and imports siblings by relative path.
- **Presentational building blocks** (`Metric`, `Panel`, `Dot`, …) live in `components/ui.jsx`; page-specific widgets stay colocated in the page folder.
- **Pure helpers with no JSX** live in plain `.js` (not `.jsx`): `constants.js`, `validate.js`, `extract.js`.
- **No barrel/index re-export tunnels within a page** — siblings import each other directly by filename. Importing from `../../components/ui.jsx` stays as-is.

---

## Module Dependency Graph (post-split)

```
pages/status/index.jsx (StatusView)
  ├── ActivityChart.jsx   (RequestActivityTrend)
  ├── Drivers.jsx         (Drivers)
  ├── Engines.jsx         (Engines)
  ├── LiveFeed.jsx        (LiveFeed)
  ├── Runtime.jsx / Work.jsx / Logs.jsx
  └── ../../components/ui.jsx, ../../lib/{format,request}.js

pages/tools/index.jsx (Tools)
  ├── useTools.js          (useTools hook)
  ├── RequestForm.jsx      (request form + SchemaField wiring)
  ├── ResponsePanel.jsx    (response head, view toggle, SVG/HTML previews)
  ├── extract.js           (extractToolResult)
  └── ../../lib/{format,request}.js, markdown.js

pages/manage/index.jsx (Manage)
  ├── constants.js / validate.js
  ├── ValueControl.jsx
  │    ├── MultiSelect.jsx
  │    ├── PostProcessorEditor.jsx
  │    └── BrowserArrayEditor.jsx
  ├── FragmentRows.jsx (inline in index)
  └── ../../components/ui.jsx, ../../lib/{request,format}.js
```

No circular imports. Every page remains a leaf.

---

## Recommended Export Surface

### `pages/status/*
- `index.jsx` → `export { StatusView, buildFeed }` (`buildFeed` re-exported from LiveFeed.jsx — `main.jsx` imports it from `pages/status/index.jsx`).
- `ActivityChart.jsx` → `{ ActivityLineChart, RequestActivityTrend, computeStatus, requestValue, REQUEST_SERIES }`
- `Runtime.jsx` → `{ Runtime }`
- `Work.jsx` → `{ Work }`
- `LiveFeed.jsx` → `{ buildFeed, LiveFeed }`
- `Logs.jsx` → `{ Logs }`
- `Drivers.jsx` → `{ Drivers, RelayAuth, copyText }`
- `Engines.jsx` → `{ Engines }`

### `pages/manage/*
- `constants.js` → `{ MANAGE_GROUPS, PP_EMPTY_ENTRY, PP_KIND_FIELDS, PP_INPUTS_OPTIONS, PP_DEFAULTS, BROWSER_ROLES, BROWSER_TYPES, BROWSER_PLUGINS, BROWSER_EMPTY_ENTRY, DEFAULT_FORMATS, BROWSER_TYPE_LABEL }`
- `validate.js` → `{ validateEntryValue, normalizeDraftValue, compareDraftValue }`
- `MultiSelect.jsx` → `{ MultiSelect }`
- `PostProcessorEditor.jsx` → `{ PostProcessorModelsEditor, parseEntries, serializeEntries }`
- `BrowserArrayEditor.jsx` → `{ BrowserArrayEditor, normalizeBrowserType, parseBrowsersEntries, serializeBrowsersEntries }`
- `ValueControl.jsx` → `{ ValueControl }`
- `index.jsx` → `{ Manage, FragmentRows }`

### `pages/tools/*
- `extract.js` → `{ extractToolResult }`
- `useTools.js` → `{ useTools }` (state + loaders + mcpRequest + run/clear)
- `index.jsx` → `{ Tools }`

`app.jsx` imports only the page `index.jsx` files (status, manage, keys, tools, hints) — unchanged.

---

## Migration Steps

> **FIFO — one file at a time, verify build after each.** These are pure relocations + import rewrites; **no JSX/rendering changes**, so behavior is preserved.

### Phase A — `pages/tools` (502 → 5 files)
1. Create `pages/tools/extract.js`; move `extractToolResult`, add `export`.
2. Create `pages/tools/useTools.js` — `useTools` hook: all state plus `loadTools`, `loadBrowserOptions`, `mcpRequest`, `selectTool`, `setValue`, `buildArguments`, `run`, `clear` (logic extracted verbatim).
3. Create `pages/tools/RequestForm.jsx` — the request form + schema fields; `pages/tools/ResponsePanel.jsx` — response head, view toggle, markdown/HTML/`dangerouslySetInnerHTML` previews, `svgPreviewSegments`/`fallbackPreviewHtml` memos, `downloadSvg`, images. `viewMode` state moves into ResponsePanel (it only affected the response section and stays mounted across tool switches — behavior identical).
4. `index.jsx` becomes a thin composer: tabs nav + error + `<RequestForm>`/`<ResponsePanel>` wiring through the hook. Dropped pre-existing unused imports (`useRef`, `formatLabel`, `Panel`, `Empty`).
5. Verify `console:build` + the Tools playground loads.

### Phase B — `pages/manage` (959 → 6 files)
4. `constants.js`: move `MANAGE_GROUPS`, `PP_EMPTY_ENTRY`, `PP_KIND_FIELDS`, `PP_INPUTS_OPTIONS`, `PP_DEFAULTS`, `BROWSER_ROLES`, `BROWSER_TYPES`, `BROWSER_PLUGINS`, `BROWSER_TYPE_LABEL`, `BROWSER_EMPTY_ENTRY`, `DEFAULT_FORMATS`.
5. `validate.js`: move `validateEntryValue`, `normalizeDraftValue`, `compareDraftValue`.
6. `MultiSelect.jsx`, `PostProcessorEditor.jsx` (with `parseEntries`/`serializeEntries`), `BrowserArrayEditor.jsx` (with `normalizeBrowserType`/`parseBrowsersEntries`/`serializeBrowsersEntries`), `ValueControl.jsx`.
7. `index.jsx` keeps `Manage` + `FragmentRows`, imports siblings.
8. Verify `console:build` + the Manage page renders/saves.

### Phase C — `pages/status` (biggest, 1063 → 8 files)
9. `ActivityChart.jsx`: `ActivityLineChart`, `RequestActivityTrend`, `computeStatus`, `requestValue`, `REQUEST_SERIES`.
10. `Runtime.jsx`, `Work.jsx`, `LiveFeed.jsx` (`buildFeed` + `LiveFeed`), `Logs.jsx` (`Logs` + `ERROR_FILTERS`).
11. `Drivers.jsx` (`Drivers`, `RelayAuth`, `copyText`), `Engines.jsx` (`Engines`).
12. `index.jsx` keeps `StatusView` composing them.
13. Verify `console:build` + the Status dashboard renders all sections, activity streams, drivers/engines, logs.

### Phase D — Final check
14. `grep` for any file still > ~400 lines; confirm only `style.css` (monolithic by design) exceeds it.
15. Full manual pass: every tab (status/tools/manage/keys/hints), then headless smoke via devtools tab against `http://10.69.1.164:1994/console`.

---

## Validation

After each phase:
```bash
cd /www1/navigator && npm run console:build    # vite build succeeds
# Manual: open http://10.69.1.164:1994/console, click every tab, verify functionality
```

No console test suite — validation is visual + build-success.

---

## Risk Mitigation

- **One file at a time.** Pure relocations only — move code, fix the import that referenced it, build. Nothing in the render path changes.
- **Siblings import each other directly.** No new barrels, no re-export indirection within a page.
- **Page `index.jsx` stays the public surface.** `app.jsx`'s imports never change, so the app shell is untouched.
- **Pure helpers go to `.js`, JSX widgets to `.jsx`.** Keeps `node`-parseable logic separate from component markup.
- **CSS untouched.** No class or style changes → zero visual impact.
- **No functional changes.** This is reorganization only; no new features, no refactoring of logic, no SVG/UI changes.

---

## Out of Scope (deferred unless asked)

- Splitting `style.css` (3611 lines) — separate concern; the file is already section-commented. Would split via CSS `@import` per page, but that touches the build/load path and risks ordering.
- Extracting `Tools`' inline `SchemaField`/`Field`/`Check` usage (those already live in `components/ui.jsx` — no duplicate).
- Any behavior or styling changes.

---

## Status Log

- 2026-08-26 — Original plan: split `main.jsx` 4658 → ~12 files.
- 2026-09-07 — Re-scoped against reality: main-level + hints split DONE; status/manage/tools page splits remain. Rewrote Current State, Target Structure, and Migration Steps to match.
- 2026-09-07 (impl) — Executed Phases A/B/C:
  - **tools** → `index.jsx` (Tools) + `extract.js` (extractToolResult).
  - **manage** → `index.jsx` (Manage, FragmentRows) + `constants.js`, `validate.js`, `MultiSelect.jsx`, `PostProcessorEditor.jsx`, `BrowserArrayEditor.jsx`, `ValueControl.jsx`.
  - **status** → `index.jsx` (StatusView, re-exports `buildFeed`) + `ActivityChart.jsx`, `Runtime.jsx`, `Work.jsx`, `LiveFeed.jsx`, `Logs.jsx`, `Drivers.jsx`, `Engines.jsx`.
  - At that point the largest files were `tools/index.jsx` 439 (Tools container), `status/LiveFeed.jsx` 298, `manage/index.jsx` 255; the subsequent tools split (2026-09-07) brought `tools/index.jsx` to 62. `console:build` passes. No JSX/render changes — pure relocation + import rewiring.
- 2026-09-07 (review) — Full verification pass after implementation:
  - **Byte-identical bodies:** every extracted function/const compared (whitespace-normalized) against `git show HEAD` originals — `extractToolResult`, all 18 manage symbols (`MANAGE_GROUPS`, `validateEntryValue`, `MultiSelect`/`PostProcessorModelsEditor`/`BrowserArrayEditor`/`ValueControl` widgets, `parseEntries`/`serializeEntries`/`parseBrowsersEntries`/`serializeBrowsersEntries`, `normalizeDraftValue`/`compareDraftValue`, all `PP_*`/`BROWSER_*`/`DEFAULT_FORMATS` consts), and all status symbols (`REQUEST_SERIES`, `ERROR_FILTERS`, `requestValue`, `ActivityLineChart`, `RequestActivityTrend`, `computeStatus`, `Runtime`, `copyText`, `RelayAuth`, `Drivers`, `Engines`, `Work`, `buildFeed`, `LiveFeed`, `Logs`) — all MATCH.
  - **`StatusView` body identical** to the original (verified end-to-end, not just dispatch).
  - **Export surface preserved:** `status/index.jsx` now `export { StatusView, buildFeed }` — `buildFeed` re-export required because `main.jsx` imports it from `pages/status/index.jsx` (it was in the original export block too). Original exported only `{ REQUEST_SERIES, requestValue, ActivityLineChart, RequestActivityTrend, computeStatus, StatusView, Runtime, Drivers, Engines, Work, buildFeed, LiveFeed, Logs }` — `copyText`/`RelayAuth` were module-local in the original, so they stay non-exported in `Drivers.jsx` (correct).
  - **No external breakage:** only `main.jsx` imports from the page `index.jsx` files (`StatusView, buildFeed`); nothing else referenced the moved internals. All extracted files carry their own imports; `WEB_TOOLS` (computeStatus), `formatLabel` (ValueControl), `classifyError` (Logs), etc. verified used. No circular imports.
  - **Rebuilt clean:** `npm run console:build` → ✓ 63 modules, same output assets (330.28 kB JS / 101.42 kB gzip).
- 2026-09-07 (tools split) — User asked to also split the Tools container (CSS split declined):
  - **tools** → `index.jsx` (Tools composer, 62) + `useTools.js` (hook, state + loaders + run/clear, 244) + `RequestForm.jsx` (42) + `ResponsePanel.jsx` (157, incl. `viewMode` state, SVG/HTML preview memos, `downloadSvg`) + `extract.js` (63).
  - **Verified:** all 10 handlers (`loadBrowserOptions`/`mcpRequest`/`loadTools`/`selectTool`/`setValue`/`buildArguments`/`run`/`clear` + 6 preview memos + `downloadSvg`) byte-identical; render tree preserved (tabs nav + `div.workspace` structure unchanged); dropped pre-existing unused imports (`useRef`, `formatLabel`, `Panel`, `Empty`). `viewMode` moved into ResponsePanel — still persists across tool switches (component stays mounted whenever the response section rendered). Only `main.jsx` imports `Tools` (export unchanged).
  - **Rebuilt clean:** `npm run console:build` → ✓ 66 modules, JS 330.78 kB / gzip 101.52 kB (+0.1 kB). **CSS `style.css` untouched** (remains the single NOT-modular file by explicit scope decision).

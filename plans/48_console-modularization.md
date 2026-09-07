# Plan: Modularize `main.jsx` (4658 lines → ~12 files)

**Created:** 2026-08-26  
**Scope:** Split `src/web-console/src/main.jsx` into focused module files.  
**Invariant:** The CSS file (`style.css`) stays monolithic for now — it's already logically ordered and splitting CSS across files is a separate concern.

---

## Current State

`main.jsx` = 4658 lines, ~81 functions, 5 top-level page views + 1 app shell.
`markdown.js` = 261 lines (already extracted, pure utility).
`style.css` = 3054 lines (stays as-is).

---

## Target Structure

```
src/web-console/src/
  main.jsx              ← ~120 lines: imports + createRoot
  app.jsx               ← App component (routing, state, polling)
  lib/
    format.js           ← formatBytes, formatMs, formatUptime, formatCountdown, formatKeyDate, formatRelativeTime, formatBackend, formatTime, formatTrendLabel, formatLabel
    request.js          ← request(), mergeErrorLogs, errorLogKey, classifyError, list, WEB_TOOLS, EXPECTED_INPUT_ERROR
    routing.js          ← modeFromPath, editorFromPath, pathForMode
    hooks.js            ← useNarrow
  components/
    Layout.jsx          ← Layout + ImmediateTooltip
    ui.jsx              ← Dot, Pill, Panel, Empty, Metric, Item, Countdown, Trend
  pages/
    status/
      index.jsx         ← StatusView
      Runtime.jsx
      Drivers.jsx
      Engines.jsx
      Work.jsx
      LiveFeed.jsx      ← buildFeed, LiveFeed, Logs
      ActivityChart.jsx ← ActivityLineChart, RequestActivityTrend, requestValue, computeStatus, REQUEST_SERIES, ERROR_FILTERS
    tools/
      index.jsx         ← Tools, extractToolResult, FragmentRows, SchemaField, Field, Check
    manage/
      index.jsx         ← Manage, ValueControl, MultiSelect, PostProcessorModelsEditor
      constants.js      ← MANAGE_GROUPS, PP_*, validateEntryValue, normalizeDraftValue, compareDraftValue, parseEntries, serializeEntries
    keys/
      index.jsx         ← Keys (self-contained)
    hints/
      index.jsx         ← Hints
      HintEditor.jsx    ← HintEditorPane
      HintTest.jsx      ← HintTestPanel
      HintFields.jsx    ← HintFieldGroup, HintField, LineListEditor, UrlListEditor, FieldRowEditor, BlockRowEditor, BlocksEditor
      FlowEditor.jsx    ← FlowEditor, FlowOptionsEditor, StepEditor, emptyFlowStep
      HintGuide.jsx     ← HintGuide
      constants.js      ← emptyHint, hintKey, modeFromHint, hintMeta, compileGlobLike, hintUrlMismatch, HINT_PRIORITIES, HINT_FORMATS, DEFAULT_FORMATS, HINT_BLOCK_FORMATS, FORMAT_LABELS, FLOW_ACTIONS, FLOW_STATES, FLOW_ACTION_LABELS
```

**Total: 12 new files, main.jsx shrinks from 4658 → ~120 lines.**

---

## Module Dependency Graph

```
main.jsx
  └── app.jsx
        ├── lib/request.js
        ├── lib/routing.js
        ├── components/Layout.jsx
        ├── pages/status/index.jsx
        ├── pages/tools/index.jsx
        ├── pages/manage/index.jsx
        ├── pages/keys/index.jsx
        └── pages/hints/index.jsx

Every page imports from:
  lib/format.js       ← shared formatters
  lib/request.js      ← HTTP helper + error utils
  components/ui.jsx   ← Dot, Pill, Panel, Empty, Metric, Item, Countdown, Trend
```

No circular dependencies. Each page is a leaf node.

---

## Exports Per Module

### `lib/format.js`
```
export { formatBytes, formatMs, formatUptime, formatCountdown,
         formatKeyDate, formatRelativeTime, formatBackend,
         formatTime, formatTrendLabel, formatLabel,
         postProcessorKindLabel, postProcessorOptionLabel, postProcessorIdLabel }
```

### `lib/request.js`
```
export { request, mergeErrorLogs, classifyError, errorLogKey, list,
         WEB_TOOLS, EXPECTED_INPUT_ERROR }
```

### `lib/routing.js`
```
export { modeFromPath, editorFromPath, pathForMode }
```

### `lib/hooks.js`
```
export { useNarrow }
```

### `components/Layout.jsx`
```
export default Layout
```
Exports `ImmediateTooltip` as a named export (used only by App).

### `components/ui.jsx`
```
export { Dot, Pill, Panel, Empty, Metric, Item, Countdown, Trend }
```

### `pages/status/ActivityChart.jsx`
```
export { ActivityLineChart, RequestActivityTrend, computeStatus, requestValue }
export { REQUEST_SERIES }
```

### `pages/status/LiveFeed.jsx`
```
export { buildFeed, LiveFeed, Logs }
```

### `pages/manage/constants.js`
```
export { MANAGE_GROUPS, PP_EMPTY_ENTRY, PP_KIND_FIELDS, PP_INPUTS_OPTIONS, PP_DEFAULTS,
         validateEntryValue, normalizeDraftValue, compareDraftValue,
         parseEntries, serializeEntries }
```

### `pages/hints/constants.js`
```
export { emptyHint, hintKey, modeFromHint, hintMeta,
         compileGlobLike, hintUrlMismatch, emptyFlowStep,
         HINT_PRIORITIES, HINT_FORMATS, DEFAULT_FORMATS, HINT_BLOCK_FORMATS,
         FORMAT_LABELS, FLOW_ACTIONS, FLOW_STATES, FLOW_ACTION_LABELS,
         KEEP_TEST_TARGET_ID }
```

---

## Migration Steps

### Phase 1 — Extract pure utilities (no JSX, zero risk)
1. Create `lib/format.js` — copy all `format*` + `postProcessor*Label` functions.
2. Create `lib/request.js` — copy `request`, `mergeErrorLogs`, `classifyError`, `errorLogKey`, `list`, `WEB_TOOLS`, `EXPECTED_INPUT_ERROR`.
3. Create `lib/routing.js` — copy `modeFromPath`, `editorFromPath`, `pathForMode`.
4. Create `lib/hooks.js` — copy `useNarrow`.
5. Update `main.jsx` to import from these instead of defining inline.
6. Verify: `npm run console:build` succeeds, console loads and functions identically.

### Phase 2 — Extract shared UI components
7. Create `components/ui.jsx` — `Dot`, `Pill`, `Panel`, `Empty`, `Metric`, `Item`, `Countdown`, `Trend`.
8. Create `components/Layout.jsx` — `Layout`, `ImmediateTooltip`.
9. Update `main.jsx` imports.
10. Verify build.

### Phase 3 — Extract page modules (one at a time, in order of isolation)
11. **Keys** first (simplest, fewest internal deps): `pages/keys/index.jsx`.
12. **Manage**: split constants + main component → `pages/manage/constants.js` + `pages/manage/index.jsx`.
13. **Tools**: `pages/tools/index.jsx` (includes `extractToolResult`, `FragmentRows`, `SchemaField`, `Field`, `Check`).
14. **Hints**: the biggest — split into 6 files in `pages/hints/`.
15. **Status**: the second biggest — split into 5 files in `pages/status/`.
16. After each page: verify build, verify the page loads and functions.

### Phase 4 — Extract App shell
17. Move `App` to `app.jsx`. This is last because it imports all pages.
18. `main.jsx` becomes: `import App from "./app.jsx"; createRoot(...)`.

---

## What Stays in `main.jsx`

After modularization, `main.jsx` is just:

```jsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import App from "./app.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

~8 lines. Clean entry point.

---

## Validation

After each phase:
```bash
npm run console:build    # vite build succeeds
# Manual: open http://10.69.1.164:1994/console, click every tab, verify functionality
```

No test suite for the console — validation is visual + build-success.

---

## Risk Mitigation

- **One phase at a time.** Each phase is independently buildable. If something breaks, it's the last thing touched.
- **Pure utilities first.** Phase 1 extracts only plain functions — zero JSX changes, zero render-path changes. Can't break the UI.
- **Page extraction is additive.** We're moving code out and adding re-exports. The JSX doesn't change — only file locations do.
- **CSS stays untouched.** No class name changes. No style changes. No visual impact.
- **No functional changes.** This is pure file reorganization. The `Tools` SVG preview work from earlier in this session is NOT part of this plan.

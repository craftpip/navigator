# Plan 68 — Run-5 fixes + run-4 `data:` URLs: windowId, elementLimit, URL caps

Sources: `test-blind/README.md` run 5 (plan 67) + run 4 `data:` finding.
Scope LOCKED to the three items below. STRICT mode.

## Fix A — thread `windowId` through setWindowBounds/focusWindow (tool, high)

- **Root cause:** `setWindowBounds` (`src/devtools.js:2302-2319`) and
  `focusWindow` (`:2321-2347`) send `{ targetId, bounds }`, but CDP
  `Browser.setWindowBounds` requires `{ windowId, bounds }` → deterministic
  `params.windowId BINDINGS: mandatory field missing`. Same root breaks
  focusWindow's focus step (`activated:true`, `windowFocused:false`).
- **Change (`src/devtools.js` only):** new helper resolving the window first
  (`Browser.getWindowForTarget` on the real target id → `windowId`, throw a
  readable error when absent), then calling `Browser.setWindowBounds` with
  `{ windowId, bounds }`. Use it in both functions.
- **Tests (`tests/devtools.test.js`):** mock-backed — setWindowBounds sends
  `windowId` (not targetId) from a stubbed getWindowForTarget; focusWindow
  reports `windowFocused:true` with no `boundsError`; missing-windowId
  surfaces a readable error.
- **Live:** `setWindowBounds` resize/move round-trips via
  `getWindowForTarget`; `focusWindow` → `windowFocused:true`; restore bounds.
- **Accept:** relay path unchanged in shape (extension receives windowId it
  may ignore); no other devtools behavior touched.

## Fix B — honor explicit `elementLimit` on full-page SVG (response)

- **Root cause:** `src/mcp-server.js:3077-3079` silently raises any
  `elementLimit < 500` to 500 when `fullPage:true` (asked 60, got 500).
- **Change (3 lines):** the 500 floor applies only when the caller did NOT
  pass an explicit `elementLimit` (default 5000 path unchanged). Explicit
  user values are honored as given (still clamped 1–5000).
- **Tests:** handler-level or helper test asserting explicit 60 stays 60
  with fullPage:true while omitted limit keeps the 500 floor. (Match existing
  web_page_svg test scaffolding; no new harness.)
- **Live:** `web_page_svg` fullPage + `elementLimit:60` → ≤60 elements.
- **Accept:** plan-37 benchmark (default/high limits) unaffected.

## Fix C — cap `data:`/ over-long URLs in Network output (response)

- **Root cause:** `getNetworkRequests` (`src/devtools.js:1090-1137`)
  returns buffered entry URLs verbatim; `data:text/javascript…` blobs run to
  multi-KB per entry and bury the list.
- **Change (`src/devtools.js` only, output shaping — buffer untouched so
  `filter` still matches full URLs):** exported helper
  `truncateLongUrl(url, max=300)` → over-long URLs render as
  `<scheme+host… or head>…<N chars>`; `data:` URLs collapse to
  `data:<mediatype>;…<N chars>`. Applied to entries after filter/slice.
- **Tests (`tests/devtools.test.js`):** helper unit (http long, data: long,
  short untouched, non-string safe) + handler test with a data: entry in the
  mock buffer asserting capped output and intact `total`.
- **Live:** `Network.getRequests` on a script-heavy page — no multi-KB URL.
- **Accept:** `total`/`shown`/`failed`/filter semantics unchanged.

## Global verification (mandatory)

1. Dev deps reinstall → targeted files → FULL suite; baseline must not grow
   (devtools format test, svg innerText test, modal-dismiss.jsx).
2. `docker compose build && down && up -d`; live A+B+C via MCP tools only
   (`tmp-blind-*` probes only; window bounds restored; tabs closed).
3. Close-out appended to run-5 (+run-4 `data:` item) in `test-blind/`.
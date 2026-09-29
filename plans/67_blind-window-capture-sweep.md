# Plan 67 — Blind window + capture-options sweep

Routine step: plan. Execution blind (browser tools only); report in
`test-blind/README.md` as run 5. Runs 1–4 covered search/fetch/links/
visuals-basic/DOM/setup-lifecycle/interactive-drive. This run covers the
window chrome and capture option matrix. (Run-4 `data:`-URL fix → plan 68+.)

## Tools covered

- `list_browsers`, `Target.getTargets` / `activateTarget`
- `Browser.getWindowForTarget`, `Browser.setWindowBounds` (move/resize/focus),
  `Browser.focusWindow`
- `web_page_screenshot` — quality low/medium/high × fullPage false/true
- `web_page_svg` — fullPage false/true, elementLimit low/high
- `DOM.scrollIntoViewIfNeeded`, `Page.reload` (ignoreCache)

## Site (fixed, not random — this run is about chrome, not discovery)

`https://homeespressolab.com/guides/pour-over-technique/` (known-good,
tall page: good for fullPage vs viewport contrast).

## Run steps + expected observables

1. **Inventory:** `list_browsers` (roles, ownership) + `getTargets`.
   Expect: agent browsers headless/invisible semantics as documented.
2. **Bounds:** `getWindowForTarget` (record initial bounds) →
   `setWindowBounds` resize + move → `getWindowForTarget` confirms new
   geometry → `focusWindow`. Expect: round-tripped geometry.
3. **Screenshots:** low/viewport, high/viewport, low/fullPage. Expect:
   success flags; note byte-size spread vs quality claim.
4. **SVG:** viewport el60 (baseline from run 3/plan 65), fullPage el60,
   viewport el200. Expect: fullPage ≫ viewport counts; higher limit ≥ counts.
5. **Scroll + reload:** `scrollIntoViewIfNeeded` on a below-fold h2, then
   `Page.reload(ignoreCache:true)`. Expect: no errors; page complete after.
6. **Restore + cleanup:** set bounds back to recorded initial, close tab,
   store untouched (no setup mutations this run).

## Safety rules

- Agent browsers only; never touch user-owned windows.
- Restore exact initial bounds before closing.
- A blocked step is a `tool:` finding with the verbatim error.

## Reporting

Append run 5 to `test-blind/README.md` from `RUN-TEMPLATE.md`. Fixes → plan 68+.

## Testing / success criteria (this run IS the test)

- Each matrix cell returns its expected observable or a logged finding.
- Window restored, tab closed, store clean at the end.
# Plan 65 — Run-3 fixes: SVG viewport selection, setup `enable`, managed validate scope

Source: `test-blind/README.md` run 3 (plan 64 blind sweep).
Scope LOCKED to the three items below. STRICT mode: minimal diffs only.

## Fix A — SVG viewport capture under-selects ("60 found, 2 in SVG")

- **Root cause:** `svgExtractor(limit)` (`src/svg/extractor.js`, Agent A)
  spends its budget page-wide in DOM order with per-category caps; then
  `capturePageAsSvg` (`src/svg/capture.js:80-83`, Agent E) clips to the
  viewport for `fullPage:false`. On tall pages the budget is consumed
  below the fold and the clip discards almost everything.
- **Change (extractor + capture only; builder untouched):**
  1. `svgExtractor(limit, opts)` — new optional `opts.viewportOnly`; when
     set, candidates outside the viewport clip
     (`window.innerWidth/innerHeight`, 50px margin, same semantics as the
     capture filter) are skipped during collection, so caps apply to
     in-viewport elements. Default (absent) = current behavior.
  2. `capture.js:76` — `page.evaluate(svgExtractor, limit,
     { viewportOnly: !fullPage })`. Full-page path byte-identical.
- **Tests (`tests/svg.test.js`, jsdom-eval pattern from `engines.test.js`):**
  stub `getBoundingClientRect` via data-attrs; DOM with in-viewport chrome +
  below-fold headings; assert default call includes below-fold elements while
  `viewportOnly:true` returns only in-viewport ones within budget.
- **Live:** `web_page_svg` viewport on the HEL article → double-digit
  elements (nav + h1 + sections), not 2.
- **Risk note:** plan-37 fidelity benchmark runs full-page → untouched path.
  `svg.test.js` must stay at its 1 pre-existing failure, zero new.

## Fix B — `web_fetch_setup` gets an `enable` op

- **Root cause:** ops are list/get/validate/upsert/disable/remove; re-enable
  is only possible via `upsert(enabled:true)`, undiscoverable from the schema.
- **Change (`src/mcp-server.js` only):** add `"enable"` to the op allow-list
  (+ schema enum if ops are enumerated there) with a handler mirroring
  `disable` (sets `enabled=true`, clears web_fetch cache, returns
  `{id, source, revision, enabled:true}`).
- **Tests (`tests/mcp-server.test.js`, existing `setupCall` harness):**
  extend the ops test — upsert → disable (get → none) → enable
  (get → managed again) → remove.
- **Live:** disable/enable round-trip on a `tmp-blind-*` probe, then removed.

## Fix C — managed validate scope (kills the id/priority warnings)

- **Root cause:** `validateManagedHint` delegates to
  `validateHintRule(hint, {scope:"static"})`, whose unknown-key loop
  (`src/domain-hints.js:910-913`) flags managed-only keys
  (`id`, `priority`, `enabled`, `createdAt`, `updatedAt`, `_managed`).
- **Change (`src/domain-hints.js` only):** `validateHintRule` accepts
  `scope:"managed"` — same required-field behavior as static, plus the
  managed keys are known (no warnings). `validateManagedHint` passes
  `scope:"managed"`. Console validate endpoint flows through automatically.
- **Tests (`tests/domain-hints.test.js`):** full managed entry (incl.
  `_managed:true`) → `errors []`, `warnings []`; bad id/priority still error;
  static-scope behavior unchanged.
- **Live:** `validate` op on a managed hint → `valid:true`, no warnings.

## Global verification (mandatory)

1. Dev deps reinstall → targeted files → FULL `npx vitest run`; baseline
   failures must not grow (devtools format test, svg innerText test,
   modal-dismiss.jsx).
2. `docker compose build && down && up -d`; live checks A+B+C through MCP
   tools only (probe hints `tmp-blind-*`, removed afterward).
3. Close-out appended to run-3 section in `test-blind/README.md`.
# Plan 64 — Blind surface sweep: full web-tool exercise on a random site

Routine step: plan. Execution follows in blind mode (browser tools only);
report lands in `friction/README.md` as run 3.

## Goal

Exercise the ENTIRE web-facing MCP tool surface end-to-end as a blind
consumer against one randomly picked website: search → fetch → links →
visuals → DOM inspection → full setup-tool hint lifecycle → cleanup.
Log every friction point; deviations from expected observables are findings.

## Tools covered (all of them, none skipped)

- `web_search` — multi-query, `limit`, default engine, `bypassCache`
- `web_fetch` — by `urls` and by `ref_ids`, `maxChars` variation,
  `bypassCache`, per-call `script`
- `web_page_links` — resolve inline refs, re-fetch one through
- `web_page_screenshot` — low + high quality, viewport + fullPage
- `web_page_svg` — structure render vs screenshot fidelity
- devtools — `Target.createTarget` / `getTargets`, `DOM.getDocument`,
  `DOM.getOuterHTML`, `DOM.querySelector(All)`, `Runtime.evaluate`,
  `Page.navigate`, `Target.closeTarget`
- `web_fetch_setup` — `list`, `get`, `validate`, `upsert` (create AND update),
  `disable`, re-enable via `upsert(enabled:true)`, `remove`

## Random site selection (blind-fair, fixed upfront)

1. One neutral query (recorded verbatim at run time).
2. Take the **3rd successful result** — fixed rule, reproducible, no cherry-picking.
3. Must be public content (article or list shape), no login/paywall/bot-wall.
   If the pick fails, take the next result and record exactly why.

## Run steps + expected observables

1. **Search** 2–3 query variations. Expect: ranked results with ref_ids,
   instant-answer section where applicable. Record ranking quirks.
2. **Fetch** a content page by ref_id AND by raw URL; repeat with small
   `maxChars`. Expect: clean text, truncation note when cut, identical
   content both ways.
3. **Links:** resolve 2–3 inline `[text](ref)` refs, fetch one through.
   Expect: correct URLs, fetchable.
4. **Visuals:** screenshot low + high, viewport + fullPage; one SVG capture.
   Expect: recognizable render; note noise/fidelity gaps.
5. **DOM inspection** in a persistent tab: `getDocument` (limit ~30) →
   `getOuterHTML` on content containers → `querySelectorAll` selector checks
   → `Runtime.evaluate` page stats (title, link count, framework markers).
   Expect: selectors that a hint could use.
6. **Hint lifecycle** on the site's main page type (test ids ONLY as
   `tmp-blind-*`, target domain only — never touch live hints):
   a. `list` (baseline snapshot) + `get` on 2 URLs (expect source none/managed).
   b. `validate` a draft hint — record warnings verbatim.
   c. `upsert` draft → `fetch(bypassCache)` → confirm the hint applied.
   d. `upsert` again with a changed field (update path) → confirm change live.
   e. `disable` → fetch → confirm fallback; re-enable via
      `upsert(enabled:true)` → confirm restored.
   f. `remove` → `get` confirms none → `list` confirms gone.
7. **Cleanup + close-out:** close all tabs; final `list` must equal the
   baseline (same ids; revision will have moved — record both).

## Safety rules

- Reads only on the target site: no logins, no forms, no submissions.
- Mutations only in the managed store, only `tmp-blind-*` ids on the target
  domain. NEVER `domain-hints.json`, never existing live hints.
- `bypassCache:true` for every post-mutation verification fetch.
- A blocked step is a `tool:` finding with the verbatim error — never skipped.

## Reporting

Append run 3 to `friction/README.md` from `RUN-TEMPLATE.md`: task,
friction tagged `request`/`response`/`tool`, simplification, this plan ref,
fix proposals (code fixes become plan 65+ — no code changes in this run).

## Testing / success criteria (this run IS the test)

- Every step above produces its expected observable; each deviation is a
  logged finding. No silent workarounds.
- Store ends exactly as it started (ids identical); tabs all closed.
- Report filed in `friction/` before the run counts as done.

## Non-goals

No server code changes; no static hint edits; no changes to live HN hints;
no second site (one site, deep, not three sites shallow).
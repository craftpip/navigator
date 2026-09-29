# Plan 63 — Chat-test tool-surface fixes (#8–#11)

Source: `test-blind/README.md` run 2 (HN article-hint session, 2026-09-24).
Scope is LOCKED to the four findings below. No refactors, no drive-bys (STRICT mode).

## Finding #8 — `\n` escaping asymmetry (per-call script vs validate/upsert)

- **Observed:** identical script body ran fine as per-call `web_fetch script`
  but failed as `web_fetch_setup validate/upsert hint.script` with
  `script syntax error: Invalid or unexpected token`. Bisect proved every
  fragment valid alone; single-backslash `\n` arrived as literal newlines
  inside `'...'` literals in the upsert path. Fix was doubling to `\\n`.
- **Root cause:** two independent wrap+compile sites with no shared contract —
  `validateScript` (`src/domain-hints.js:204-218`) and `runScriptExtraction`
  (`src/search.js:2137-2140`) — plus an error message that never suggests the
  transport-escaping cause.
- **Change (`src/domain-hints.js`, `src/search.js`):**
  1. New exported helper `compileScriptSource(script)` in `domain-hints.js`:
     wraps as `(async () => { <script> })()` and `new vm.Script`s it (the exact
     execution form). Throws on failure.
  2. `validateScript` and `runScriptExtraction` both call it — identical input
     → identical verdict, by construction, not coincidence.
  3. On syntax failure, if the source contains literal CR/LF, append guidance:
     `script contains literal newlines — when passing via JSON/MCP, escape
     them as \\n`.
- **Tests (new `tests/script-compile.test.js`):**
  - Parity fixtures (escapes, multiline body, template literals, unicode,
    em-dash): `validateScript` accepts ⟺ helper compiles.
  - Literal-newline-inside-string fixture: both reject AND message names the
    `\\n` escaping cause.
  - Empty/non-string inputs still rejected as before.
- **Live check:** `validate` op with `\\n` script → `valid:true`;
  per-call fetch on an HN item → success (unchanged behavior).
- **Accept:** unit file green; no change to sandbox globals or timeouts.

## Finding #9 — script markdown links without `links[]` stay raw

- **Observed:** script emitting `[host](url)` in `text` but returning no
  `links` array produced raw URLs in output; adding
  `links: [{text, url}]` restored `[text](ref_id)`.
- **Root cause:** rewrite gate `src/mcp-server.js:1979`
  (`page.links?.length`) — `runScriptExtraction` (`src/search.js:2187-2191`)
  only forwards `normalized.links`, never scans its own `text`.
- **Change (`src/search.js` only; `openTargetsParallel` untouched):**
  in `runScriptExtraction`, after building `links` from `normalized.links`,
  scan `finalText` for `[text](https?://…)` markdown links (same shape as the
  rewrite regex), append `{href, text}` for URLs not already present; skip
  `#…`, numeric ref destinations, non-http(s); cap at 500.
- **Tests:**
  - Unit-test the scanner in isolation (exported helper): markdown with
    mixed raw/ref links, duplicates, non-http skipped, cap respected.
  - `runScriptExtraction`-level test (existing scaffolding if present, else
    minimal mock page): script returning text-only with a markdown link →
    `result.links` contains it.
- **Live check:** per-call script WITHOUT `links[]` on an HN item →
  host link renders `[host](ref_id)`, resolvable via `web_page_links`.
- **Accept:** existing rewrite behavior for non-script paths byte-identical.

## Finding #10 — upsert `revision` disagrees with `list`

- **Observed:** `list` → `revision: 4`; later upserts → `revision: 1`, `2`.
- **Root cause:** revision lives only in `managedHintsCache` (in-memory,
  `src/domain-hints.js:956,969,986-990,1069`); restart or
  `clearManagedHintCache()` (config-manager BROWSERS change) resets it.
- **Change (`src/domain-hints.js` only; all callers use `.entries/.revision`
  unchanged):** envelope file format `{ "revision": N, "hints": [...] }`.
  `readManagedEntries` migrates legacy bare-array files (revision 0, bumped
  on next mutation); `loadManagedHints` seeds cache revision from file;
  `mutateManagedHints` persists the bumped envelope.
- **Tests (extend `tests/domain-hints-api.test.js` or new):**
  - Legacy array → load rev 0 → mutate → rev 1 + envelope on disk.
  - Simulated restart (`clearManagedHintCache`) → load preserves rev 1 →
    mutate → rev 2.
  - Audit existing tests/fixtures for bare-array shape assumptions and update.
- **Live check:** `list` → `upsert` → `list` monotonic; `docker restart
  navigator` → `list` revision preserved.
- **Accept:** console `/console/api/hints` (`managedRevision`) correct without
  UI changes.

## Finding #11 — HN item-page knowledge (no code change)

Already implemented live in managed `hn-item-v1` (anchor-text titles,
`.toptext` story body, `item?id=` self-post guard, conditional Comments
section, absolute href + `links[]`). Recorded in `test-blind/README.md`.
**Verification only:** post-restart `web_fetch(bypassCache)` on story item,
Ask HN item, front page (see global checks).

## Global verification (mandatory — testing is the deliverable)

1. `docker compose exec navigator npm install --include=dev` (entrypoint
   prunes dev deps on every start).
2. Targeted vitest files for #8/#9/#10, then FULL `npx vitest run`.
   Baseline pre-existing failures (do-not-grow): `tests/devtools.test.js`
   format-response test, `tests/svg.test.js` innerText-centering test,
   `tests/modal-dismiss.test.jsx`. Any NEW failure blocks the fix.
3. `docker compose build && docker compose down && docker compose up -d`
   (live server must run the new modules), then the three live checks above
   through the MCP tools only.
4. Close-out: mark chat-test findings fixed with revision numbers; absorb
   one-line durable notes into `AGENTS.md` project learnings only if warranted.

## Non-goals

No sandbox global additions, no timeout changes, no rewrite-regex changes,
no console UI changes, no managed-store schema changes beyond the envelope,
no docs-site edits.
# Friction log — chat-test runs

This folder records what an LLM consumer *actually* faced while driving the
navigator MCP tools blind — no source, no shell, no curl. The goal: simplify
the tool surface so a first-time consumer doesn't have to reverse-engineer it.

Routine: run → log → plan → fix → verify live. The protocol for this folder is
`AGENTS.md` (here); the project-level one is `../AGENTS.md` → Chat Testing
Protocol. New runs append below; start from `RUN-TEMPLATE.md`.

## Run index

- Run 1 — managed-hint authoring basics (script sandbox, validate-vs-run, cache): friction 1–7.
- Run 2 — HN article hint `hn-item-v1` (escaping, links, revision): friction 8–11, fixed by plan 63.

## Summary of friction (so far)

### 1. Script hints / per-call `script` run in a Node `vm` sandbox — NOT the page

**Problem:** A script hint (and the per-call `web_fetch script` param) does NOT
execute in the browser page context. It runs server-side in a `vm` sandbox.
There is no `document`, no `window`, no `location`, no `Intl.NumberFormat`.

- `document.querySelector(...)` → `document is not defined`
- `location.href` → `location is not defined`
- `Intl.NumberFormat` → `Intl is not defined` (sandbox global allowlist)

**What works inside the script:**
- `page` — the puppeteer `Page` for the loaded target
- `await page.evaluate(() => { ... })` — real DOM access runs in the page
- `page.url()` — current URL (not `location.href`)
- `JSON`, `Math`, `URL` (the WHATWG URL class), plain JS

Anything you want from the DOM must be gathered inside `page.evaluate()`
first, returned as JSON, and then shaped by the outer script. The return
value of the script function must be `{ text, title?, url?, tables?, links?,
warnings? }`.

**Fix (docs):** the `script`/script-hint contract must say "runs server-side
in a Node vm sandbox; use `page.evaluate` and `page.url`" — right now the tool
description says "arbitrary JavaScript against the live page", which reads as
browser context.

### 2. How to safely test a script edit without clobbering the live hint

**Problem:** The `validate` op only schema-checks the hint object — it does
NOT run the script against a real page. To verify a *changed script field*
you must test it before `upsert`.

**Worked approach (consumer-safe):**
1. `web_fetch_setup(get, { url })` on a real target URL → returns the current
   effective script + `source` (`managed`).
2. Take the current script, edit it, and pass it as the **per-call
   `web_fetch script` param** against the real URL (script param wins over
   stored hints, single-target only). Iterate on the field there.
3. Only when the per-call output is right, `upsert` the edited script.
4. `web_fetch(bypassCache: true, commitHint…)` to confirm the live output.

**Problem:** the `upsert` doc says it bumps revision and clears the web_fetch
cache — but verification still needs `bypassCache: true` after upsert; a
plain cached `web_fetch` may return pre-hint output and look like a failure.

### 3. `validate` op is noisy for managed hints

**Problem:** validating a managed hint (which carries `_managed`, `id`,
`priority`) reports `_managed`, `id`, `priority` as **unknown fields
(ignored)** — same objects that `upsert` happily stores. Confusing: validate
says "unknown", upsert says "saved". These managed-only fields should be
recognized by `validate` (they're the store schema), or the warning should be
suppressed for them.

### 4. Get vs web_fetch cache: `get` is the truth, `bypassCache` is required after changes

**Problem:** after an upsert, a plain `web_fetch` may keep returning cached
content for the affected domain → looks like the hint "didn't apply". The
reliable read is `web_fetch_setup(get)` (always live) + `web_fetch` with
`bypassCache: true`.

### 5. Hint priority / specificity is invisible from the tool surface

**Problem:** when two managed hints could match the same URL (front-page hint
`/**` vs item-page hint `/item`), there is no way to know which wins from the
docs. The rule (priority desc → path specificity → index) is only discoverable
by reading source. The `get` op does show the winning hint + `source` for a
given URL — that IS the consumer-facing oracle, and it worked. Docs should
state matching order explicitly: **priority (higher wins) → path specificity →
creation order**.

### 6. `list` doesn't show which hint a URL uses

**Problem:** `list` returns all managed scripts, but not their `priority` or
matching behavior. To find out what actually serves a URL, you must call
`get` per URL. Consider adding an optional `url` to `list` (or a "what applies
here" mode) that annotates each candidate as APPLIES / FALLBACK.

### 7. The doc says managed hints exist but the sub-heading is easy to miss

**Problem/observation:** "Any mutating op is dropped... preference remains
declarative" — the managed store exists as a parallel store to
`domain-hints.json` and the docs mention it only in passing. A consumer
figuring out script hints will assume `.json` edits; managed `upsert` is the
actual supported path. Docs should call out: *script hints live in the managed
store via `web_fetch_setup upsert`, not in domain-hints.json*.

---

## Run 2 — HN article hint `hn-item-v1` (2026-09-24, rev 4 → 6)

### 8. `\\n` vs `\n` — validate/upsert mangles single-backslash escapes

**Problem (tool — high friction, ~30 min lost):** the per-call `web_fetch
script` param accepts single-backslash `\n` inside JS string literals and runs
fine. But the SAME script sent as `web_fetch_setup upsert/validate`
`hint.script` fails with `script syntax error: Invalid or unexpected token`.
Bisected for 6+ rounds: every fragment validates alone, the full script fails.
Root cause: single `\n` in the upsert path arrives as a LITERAL newline inside
the single-quoted JS string (hard SyntaxError); the fix is doubling every
escape to `\\n`. Proof: identical script with `\\n` → `valid: true`; the tiny
`'a\\n\\nb'` probe passed while `'\n\n'` in the full script failed.

**Fix:** document it on the `script`/`hint.script` params — *"when passing a
script as a tool-call string, double all backslash escapes (`\\n`)"* — or
normalize the path so per-call and upsert behave identically. The `validate`
error message gives zero hint that escaping is the cause.

### 9. Script `links[]` drives ref_id rewriting — markdown links alone don't

**Problem (response):** a script that emits `[host](url)` markdown in `text`
but returns no `links` array gets its URLs left RAW in the output
(`[bastardica.mitpit.com](https://bastardica.mitpit.com)`). Returning
`links: [{ text, url }]` alongside restores the documented
`[text](ref_id)` form (`[bastardica.mitpit.com](43167)`). The contract lists
`links?` as optional, but omitting it silently degrades every link the script
emits. Docs should say: *every URL you render in markdown must also appear in
`links`, or it won't get a ref_id.*

### 10. Upsert response `revision` is ambiguous

**Problem (response):** store `list` showed `revision: 4`, but the `upsert`
reply said `revision: 1` (then `2` on the next upsert). Is that the store
revision or a per-hint version? As a consumer I can't tell whether my write
landed on the store I listed. Name it (`hintRevision` vs `storeRevision`) or
return both.

### 11. HN item-page specifics (domain knowledge earned this run)

- Title: use the **anchor's** `innerText`, not `.titleline` innerText (the
  latter includes the `(sitestr)` span noise, e.g. `Show HN: ... (mitpit.com)`).
- Story body lives in `.toptext` (Ask HN text, Show HN blurbs) — without it,
  Ask HN pages extract to title + score only.
- Self-posts link to themselves (`href="item?id=..."`): detect
  `href.indexOf('item?id=') === 0` and skip the host-link suffix, else the
  output links to itself as `[news.ycombinator.com](ref)`.
- Emit `## Comments (N)` only when N > 0; fresh Ask posts have zero
  `tr.athing.comtr` rows and the section should be absent, not `Comments (0)`.
- Absolute href (`a.href`) for the markdown link + `links[]` URL; relative
  href only for the self-post check.

## Fix close-out (plan 63, 2026-09-24 — all four fixed + tested)

- **#8 FIXED** — `compileScriptSource()` in `src/domain-hints.js`, shared by
  `validateScript` and `runScriptExtraction` (`src/search.js`); syntax
  failures with literal newlines now name the `\\n` escaping cause.
  Unit: 3 parity/guidance tests (`tests/domain-hints.test.js`) + execution
  rejection test (`tests/search.test.js`). Live: `validate` with `\\n`
  script → `valid:true`.
- **#9 FIXED** — `extractMarkdownLinks()` in `src/search.js`;
  `runScriptExtraction` merges scanned `[text](https://…)` links into
  `result.links`, so the existing rewrite pass emits `ref_id`s with or
  without a script `links[]`. Unit: 3 tests. Live: link-less per-call script
  → `[url](43167)`, resolvable via `web_page_links`.
- **#10 FIXED** — managed store is now a `{ revision, hints }` envelope
  (`src/domain-hints.js`); legacy bare arrays migrate on read; revision
  survives restarts. Unit: 2 envelope tests. Live: legacy rev 0 → upsert
  rev 1 → remove rev 2 → `restart` → `list` still rev 2.
- **#11 DONE (no code change)** — live `hn-item-v1` re-verified post-restart:
  story item, Ask HN (now with 2 comments — conditional section works both
  ways), front page on `hn-top-v1`.
- Full suite: 705 passed, 2 failed — both pre-existing baseline
  (`devtools` format-response, `svg` innerText-centering; plus the
  `modal-dismiss.jsx` file-level failure from other uncommitted work).
  Zero regressions.
- Out of scope, observed: front-page `hn-top-v1` label truncation artifact
  (`...00811-4)` on long URLs) — pre-existing, untouched.

---

## Run 3 — blind surface sweep, homeespressolab.com (2026-09-24, plan 64)

Task (blind, tools only): neutral query
`"best pour over coffee technique" / "pour over coffee grind size guide"` →
3rd result of query 1 → `homeespressolab.com/guides/pour-over-technique/`.
Exercised: search, fetch (ref + URL + maxChars + bypassCache), links
resolve + follow, screenshot (low/high, full/viewport), SVG, Target/DOM/
Runtime inspection, full setup lifecycle
(list/get/validate/upsert/update/disable/re-enable/remove), tab close.
Probe hint `tmp-blind-hel-guides` created → verified → removed; store ended
identical to baseline (hn-top-v1, hn-item-v1; rev 2 → 7).

### What worked with zero friction

- Search: 2 queries, instant answers, ranked ref_ids, snippets with dates.
- Fetch by ref_id and by raw URL → byte-identical output, same ref_id.
- `maxChars` truncation note present and correct both times.
- `web_page_links` resolve + refetch-through; ref memory is URL-keyed
  (followed page kept the link's ref_id).
- Article extraction quality high: markdown tables, `##` sections from h2s,
  new `Page type: article | confidence: 1.00` header line.
- `DOM.getDocument` selectors/xpaths/rects sufficient to draft a hint with
  no guessing (`article.post-single`, `h2#…` anchors).
- `Runtime.evaluate` JS errors come back verbatim with the evaluated snippet.
- Setup lifecycle fully worked first try: validate → upsert (rev 3) → live
  apply → update (rev 4) → disable (rev 5, instant fallback) → re-enable via
  upsert (rev 6) → remove (rev 7) → get none → list clean.

### Friction

- `response:` RETRACTED — screenshots "unusable" was harness-side, not a tool
  problem. The tool returned full bytes both times; the harness saved them to
  a tool-output file and said so, and I failed to read it. Verified afterward:
  the saved file holds a complete valid JPEG. Lesson: when output is
  truncated with a saved-file pointer, READ THE FILE before filing a finding.
- `response:` SVG viewport capture under-selects — `60 found, 2 in SVG`
  (only h1 + first h2 rendered; nav/header/hero absent). As a layout oracle
  for hint authoring it showed article skeleton only.
- `response:` in-page anchor links render `[#](#section-id)` raw — never get
  ref_ids (only http(s) links do since plan 63). Arguably correct, but a
  blind consumer can't tell whether `#…` is resolvable or dead.
- `request:` managed hints have `disable` but no `enable` op — re-enable via
  `upsert(enabled:true)` works but is undiscoverable from the schema/docs.
- `request:` `validate` still warns `id`/`priority` as "unknown field
  (ignored)" while `upsert` requires/saves them (finding #3, still open).

### Simplification

- Screenshot: need a consumable form blind (smaller default, or file output,
  or ASCII/SVG-first guidance in the tool description).
- SVG: document what "found N, M in SVG" filtering means, or loosen it.
- Either give `web_fetch_setup` an `enable` op or document the
  upsert-re-enable path on `disable`.
- Fix the `validate` managed-field warnings (#3 carried forward).

### Plan / fix proposals (code fixes → plan 65+, none made in this run)

1. Screenshot consumability (response) — plan 65 candidate.
2. `enable` op or documented re-enable (request) — plan 65 candidate.
3. `validate` id/priority warnings (#3, request) — carried forward.

## Fix close-out (plan 65, 2026-09-24 — screenshot finding retracted, other three fixed + tested)

- **Screenshot finding RETRACTED** — harness-side truncation, my reporting
  fault (verified: saved file holds the complete valid JPEG). Not a tool
  problem; no code change. Lesson logged above.
- **SVG FIXED** — `svgExtractor(limit, opts.viewportOnly)` in
  `src/svg/extractor.js`; `capture.js` passes `{viewportOnly: !fullPage}`.
  Caps now apply to in-viewport candidates; full-page path byte-identical.
  Unit: 2 jsdom-eval tests (`tests/svg.test.js`). Live: same HEL article,
  same limit → **60 found, 60 in SVG** (was 2) with nav/header/article/TOC.
- **`enable` op ADDED** — `src/mcp-server.js` (schema enum + description +
  handler mirroring `disable`, clears web_fetch cache). Unit: extended ops
  round-trip test. Live: upsert → disable → `enable` → get managed →
  probe script ran on fetch → removed; store clean.
- **Validate scope FIXED** — `validateHintRule` accepts `scope:"managed"`
  (`src/domain-hints.js` + `MANAGED_TOP_LEVEL_KEYS`); `validateManagedHint`
  uses it. Unit: 3 tests. Live: `validate` on managed hint →
  `valid:true`, `warnings: []`.
- Full suite: 710 passed, 2 failed — both pre-existing baseline
  (`devtools` format-response, `svg` innerText-centering; plus the
  `modal-dismiss.jsx` file failure from other uncommitted work).
  Zero regressions.

---

## Run 4 — blind interactive drive, TodoMVC React (2026-09-24, plan 66)

Task (blind, tools only): query `"react todomvc example"` → 1st result was
a Microsoft support page (not interactive — skipped, rule-followed) → 2nd
result `todomvc.com/examples/react/dist/`. Drove it: type + Enter (added
"Buy milk", verified in DOM), clicked toggle (li → `class: completed`),
clicked Active filter (hash `#/active`, list hid the item), navigate away →
goBack → goForward → re-navigate → reload, then console + network
inspection, getTargets, tab close. Managed store untouched (rev 11).

### What worked with zero friction

- insertText (value readback `finalValue`), Enter key, click with point +
  navigated flag, hash-route filter, back/forward/reload — all behaved and
  every state change was DOM-verifiable.
- getConsoleMessages: only page-own noise (analytics blocked, favicon 404),
  nothing from our driving.
- getTargets: clean user/agent split, exact tab listed with targetId.

### Friction

- `response:` `Network.getRequests` dumps `data:text/javascript…` URLs IN
  FULL (multi-KB encoded Polymer sources inline) — one entry can bury the
  whole list. `data:` URLs should be truncated/capped in output.
- `observation (not filed as tool bug):` the added todo did NOT survive
  reload — `localStorage` completely empty afterward. React state worked
  pre-reload, so this is app/environment storage semantics, not attributable
  to a tool without deeper digging. Left open, not fought.

### Simplification

- Cap `data:` (and very long) URLs in network/console output, e.g.
  `data:text/javascript;…<N chars>`.

### Plan / fix proposals (→ plan 67+, none made in this run)

1. Truncate `data:` URLs in `Network.getRequests` (response).

---

## Run 5 — blind window + capture sweep, HEL article (2026-09-24, plan 67)

Task (blind, tools only; fixed site, this run is about chrome): inventory
browsers → window bounds round-trip → focus → screenshot matrix →
SVG matrix → scroll + hard reload → restore + close. No setup mutations.

### What worked with zero friction

- `list_browsers`: 7 browsers, ownership + execution order + per-browser
  prompts all clear at a glance.
- `getWindowForTarget`: full geometry + windowState + realTargetId.
- `focusWindow` activates the tab (`activated:true`).
- Screenshots medium/viewport succeeded (168 KB); fullPage SVG rendered
  500 elements with selectors/xpaths/text (header/nav/article/footer/TOC).
- `scrollIntoViewIfNeeded` moved a below-fold h2 into view (y 4894 → 521).
- `Page.reload(ignoreCache:true)` → `reloaded:true`, page complete after.
- Bounds at end identical to start; tab closed.

### Friction

- `tool:` **`Browser.setWindowBounds` always fails** — `Protocol error
  (Browser.setWindowBounds): Invalid parameters … params.windowId -
  BINDINGS: mandatory field missing`. Deterministic across two calls
  (full bounds and size-only). The tool resolves the window from targetId
  (getWindowForTarget returns windowId 1964846246) but never passes
  `windowId` to CDP. Move/resize via tools is 100% broken.
- `tool:` **`Browser.focusWindow` half-broken by the same bug** — tab
  activates (`activated:true`) but `windowFocused:false` with the identical
  windowId `boundsError`. One root cause, two tools.
- `response:` `elementLimit:60` + `fullPage:true` rendered **500 elements** —
  the limit was not honored (or means something else) on the full-page path.
  A blind consumer cannot budget output size.

### Simplification

- Thread `windowId` through setWindowBounds/focusWindow (single fix).
- Document/clamp what `elementLimit` means per fullPage mode, or enforce it.

### Plan / fix proposals (→ plan 68+, none made in this run)

1. Pass `windowId` in setWindowBounds/focusWindow (tool, high value).
2. Honor `elementLimit` on the fullPage SVG path (response).

## Fix close-out (plan 68, 2026-09-24 — all three fixed + tested)

- **windowId FIXED** — new `resolveWindowId()` helper in `src/devtools.js`
  (getWindowForTarget → windowId, readable error when absent); used by both
  `setWindowBounds` and `focusWindow`. Unit: sends `{windowId, bounds}` with
  no `targetId`; missing-windowId error test; focusWindow mock updated.
  Live: resize/move round-tripped via getWindowForTarget,
  `focusWindow → windowFocused:true`, bounds restored, tab closed.
- **elementLimit FIXED** — `resolveSvgElementLimit()` in `src/mcp-server.js`:
  explicit user values honored (clamped 1–5000); the 500 floor now applies
  only to defaulted full-page captures. Unit test. Live: fullPage +
  `elementLimit:60` → desc `60 elements` (was 500).
- **`data:` URLs FIXED** (run-4 item) — `truncateLongUrl()` in
  `src/devtools.js`, applied at `getNetworkRequests` output shaping only
  (buffer intact, so `filter` still matches full URLs). `data:` capped at
  60 chars, other URLs at 120, suffix `…<N chars>`. Unit: helper + handler
  with data: entry in mock buffer (totals intact, full-URL filter works).
  Live: 16-request list clean, longest URL ~150 chars, all entries intact.
- Full suite: 716 passed, 2 failed — both pre-existing baseline
  (`devtools` format-response, `svg` innerText-centering; plus the
  `modal-dismiss.jsx` file failure from other uncommitted work).
  Zero regressions.
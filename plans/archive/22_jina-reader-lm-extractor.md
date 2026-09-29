# Jina reader-lm-0.5b as an "AI Model" Extractor in web_fetch

## Status: Complete — 2026-09-29

**Status: Complete** — closed 2026-09-29, archived to `plans/archive/`. Historical
note: DRAFT (planned only) at the time of writing; the shipped result is the
`POST_PROCESSOR_MODELS` / "AI Model" extractor pipeline (plans 25, 36, 62).

### Checklist

- [ ] 1. Decide the extractor serving model + transport (D1–D3 below).
- [ ] 2. Add `READER_LM_*` / `READER_LM_MODELS` config to `src/config.js` / `src/config-manager.js`.
- [ ] 3. New `src/reader-lm.js` module (HTTP client + fallback + concurrency gate).
- [ ] 4. Unify extractor enums in `src/domain-hints.js`: new `DEFAULT_FORMATS` set, **remove `default.tables`** validation, migration drops `tables`.
- [ ] 5. `src/search.js`: async extraction chain; whole-page dispatch for ALL extractor formats (text / html / html_to_markdown / readability_to_markdown / table / table_json / table_csv / AI); remove tablesMode strip; AI branch in default + block path.
- [ ] 6. `src/mcp-server.js`: cache bypass for AI-model fetches; verify `/extract` with `hintOverride`.
- [ ] 7. Console (`src/web-console/src/main.jsx`): rename **Format → Extractor** (both flows), friendly labels, **remove the Table extraction dropdown**, add `html`/`table`/`table_json`/`table_csv`/AI Model options to the default dropdown; guide table + JSON template.
- [ ] 8. Tests: extractor dispatch, table-format extractors (tables-only output), fallback-on-error, cache bypass.
- [ ] 9. Docs: `AGENTS.md` (extractor dropdown, tables decision supersedes the "Always On" learning, env vars), `README.md` env table.
- [ ] 10. Build console, restart server, verify schema + both flows live.

## Goal

Make Jina **reader-lm-0.5b** (a 0.5B SLM trained to convert raw HTML → clean Markdown) available as
an *extractor* in `web_fetch`, in **both** extraction flows:

1. **Default extraction** — a new option in the page's extractor dropdown.
2. **Interactive flow** — a new option in extract-step block extractors (and inherited by
   blockless extract steps via the default extractor).

And rename the "Format" dropdown to **"Extractor"** in both places, because once an ML model joins
the list the dropdown no longer picks a *render format* — it picks the **extraction method**
(which engine converts raw HTML into clean text).

**Bonus scope (user-directed):** unify the default-extraction extractor dropdown with the
interactive-flow block dropdown, and remove the separate "Table extraction" dropdown
(`default.tables`) entirely.

## The Extractor Concept (user's mental model)

The extractor is the **final output-stage choice** — "when we format the content, that time we
return it." It is the last step before content is returned and it **blocks nothing before it**:
the earlier default-extraction knobs (wait for selectors, stabilize strategy, wait for content,
skip selectors) all run first and are independent of which extractor is chosen. The extractor only
decides *how the (already prepared) content is rendered into the returned text*.

## The Rename — "Format" → "Extractor"

User decision: the dropdown is renamed **"Extractor"** (an earlier "output parser" suggestion was
rejected in favor of "extractor").

| Where | Current label | New label | File |
|---|---|---|---|
| Default extraction | `Format (content)` | `Extractor` | `src/web-console/src/main.jsx:3615` |
| Interactive flow · leaf block | `Format` | `Extractor` | `src/web-console/src/main.jsx:2578` |
| Guide table row | `Format (content)` | `Extractor` | `src/web-console/src/main.jsx:3109` |
| JSON template comment | `readability_to_markdown \| html_to_markdown \| text` | update for friendly extractor values | `src/web-console/src/main.jsx:3152` |
| Domain-hints schema error | `default.format` message | updated to enumerate extractor values | `src/domain-hints.js:605` |

Field formats (record fields, `main.jsx:2512`) are **not** renamed and do **not** gain an AI-model
option — they are per-item render modes inside a record block, and an LLM call per field is
wasteful. Kept out of scope.

## One Unified Extractor Dropdown (D11, D12)

**D11 — Default extraction's extractor dropdown now mirrors the interactive-flow block dropdown**,
minus `list` (list only has meaning per-block, where each matched element becomes a bullet). The
separate **"Table extraction" dropdown (`default.tables` — all/content/disabled) is removed** —
the extractor itself now decides how tables are rendered, so the toggle is redundant.

### Default extraction — extractor options (whole page)

| UI label | JSON value | Whole-page output |
|---|---|---|
| Text | `text` | flat text dump (tables appear as whatever the dump captures) |
| HTML | `html` | raw HTML of the best content container in a ```html code fence |
| HTML to Markdown | `html_to_markdown` | whole-page HTML → markdown (tables become markdown tables via Turndown) |
| Readability to Markdown | `readability_to_markdown` | Readability strips nav/ads/sidebar → markdown (current default) |
| Table | `table` | **tables only** — all meaningful tables rendered as pipe markdown tables |
| Table (JSON) | `table_json` | **tables only** — all meaningful tables rendered as JSON |
| Table (CSV) | `table_csv` | **tables only** — all meaningful tables rendered as CSV |
| AI Model | `reader_lm` (single) / model id (multiple) | model converts the page HTML → markdown |

**D12 — Tables are the extractor's job now.** No separate strip-then-reappend for the default
path. Content formats render tables however that extractor naturally does
(`html_to_markdown` → markdown tables; Readability → what it keeps; AI model → the model renders
them as markdown tables from the full HTML it receives; `text` → whatever the flat dump captures).
The `table`-family formats produce **tables-only output** (like a `table` block does) — for pages
that are essentially tables (e.g. NSE option chain), picking `Table`/`Table (JSON)`/`Table (CSV)`
returns just the tables.

### Interactive flow — block extractor options (unchanged set + AI)

| UI label | JSON value |
|---|---|
| Text | `text` |
| List | `list` |
| HTML | `html` |
| HTML to Markdown | `html_to_markdown` |
| Readability to Markdown | `readability_to_markdown` |
| Table | `table` |
| Table (JSON) | `table_json` |
| Table (CSV) | `table_csv` |
| AI Model | `reader_lm` (single model) / model id (multiple) |

Block semantics are unchanged (each matched element renders per its format; `table`-family blocks
extract tables from the matched container). `list` remains a block-only option.

## Which Extractor Method (the "what are we going to use" question)

**D1 — Model: `reader-lm-0.5b`** (HuggingFace `jinaai/reader-lm-0.5b`, also published as Ollama
`reader-lm:0.5b`). Facts that shape the design:

- 0.5B-param Qwen2-based SLM, **24 layers**, trained on curated HTML→Markdown pairs.
- Input = **raw HTML as the user message** — no instruction prefix required. Use the model's chat
  template (`apply_chat_template`).
- Context: 32K–256K tokens depending on source; plan for a ~32K-token safe budget.
- **License `CC-BY-NC-4.0` — NON-COMMERCIAL.** Must be flagged in docs/serving notes.
- 1.5b sibling exists (`reader-lm-1.5b`); 0.5b is the requested size. Model name is config-driven
  (the "AI Model" category is designed to host several models — D5).

**D2 — Transport: OpenAI-compatible HTTP endpoint, never embedded inference.** Navigator stays
pure Node/JS (no Python, no `transformers`). It POSTs to a configurable
`<base>/chat/completions` endpoint:

```bash
curl -X POST "$READER_LM_BASE_URL/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "'"$READER_LM_MODEL"'",
    "messages": [ { "role": "user", "content": "<prepared html>" } ],
    "max_tokens": 8192
  }'
```

Reply text = `choices[0].message.content`. Every error path (unconfigured, non-200, timeout, empty
output) **falls back** to `html_to_markdown` (or `readability_to_markdown`) and surfaces a warning —
the AI extractor never hard-fails a fetch.

**D3 — Serving layer is out of scope here but assumed.** Recommended: **vLLM** serving
`jinaai/reader-lm-0.5b` once GPU support lands (the user is adding GPU separately — this plan does
**not** block on it). Ollama (`reader-lm:0.5b`) is the CPU-only fallback for low volume. On the
current host (no GPU, 4-core container cap) per-page CPU inference is too slow to be the default —
hence **AI Model is opt-in per hint and never the built-in default**; it is inert until a model
endpoint is configured.

## Current Reality (reference points)

- Extractor choice today lives entirely in hint JSON: `default.format` for default extraction,
  `block.format` for flow leaf blocks. The MCP `web_fetch` tool schema has **no** `format` param
  (`src/mcp-server.js:1699-1726`) — extraction happens before caching, driven by the matched hint.
- `extractTextFromHtml` default path dispatches on `pageFormat` at `src/search.js:997-1119`
  (readability branch 1016, fallback `html_to_markdown`/`text` 1093-1119). `default.tables`
  (`tablesMode`) drives the strip-then-reappend at 1006-1012/1031-1042/1102-1108 + `insertTablesInline`.
- Block rendering: `renderContentBlocks` → `renderLeafContent` (sync) at `src/search.js:855-953`,
  `renderLeafContent` at 804. `renderHintFields` (sync, 741) handles record fields.
- `insertTablesInline` (search.js:693) is used by the block path (`renderContentBlocks` via
  `mergeExtractedStages` 2181-2183) and final assembly (2549, 2742) — after this change it stays
  for the **flow** path only; the default path no longer strips/reappends.
- Format enums: `DEFAULT_FORMATS` / `BLOCK_FORMATS` / `FIELD_FORMATS` in `src/domain-hints.js:212-234`;
  `default.tables` validated with `default.format` at 605-612. Console mirrors them in `main.jsx:2290-2302`.
- Call sites of `extractTextFromHtml`: `search.js:2536` (cached-html path) and `2713` (live path) —
  both already inside the async `browserOpenAndExtract`; `extractHintStage:2131` (sync today) feeds
  `replayFlowFromSnapshot` (sync `forEach`, 2211) and `runFlowExtraction` (async).
- web_fetch result cache is keyed on tool args only (`excludeMaxChars(getCacheArgs(args))`,
  `src/mcp-server.js:1902`) — hint/extractor is not part of the key.

## Changes

### 1. Config — `src/config.js` / `src/config-manager.js`

| Var | Default | Purpose |
|---|---|---|
| `READER_LM_MODELS` | `[]` | JSON array of model entries `[{ id, label, model, baseUrl }]` — the source of the "AI Model" category options (D5). |
| `READER_LM_BASE_URL` | `""` | Convenience for the single built-in entry: OpenAI-compatible base, e.g. `http://localhost:11434/v1` (Ollama) or `http://host.docker.internal:8000/v1` (vLLM on host from the container). Empty ⇒ no AI-model extractor available ⇒ fallback + warning. |
| `READER_LM_MODEL` | `reader-lm:0.5b` | Convenience model id for the built-in entry; vLLM would use `jinaai/reader-lm-0.5b`. |
| `READER_LM_TIMEOUT_MS` | `60000` | Per-call timeout; GPU fast, CPU needs more. |
| `READER_LM_MAX_INPUT_CHARS` | `60000` | Prepared HTML truncated before sending (~15K tokens, safe under 32K ctx). |
| `READER_LM_MAX_TOKENS` | `8192` | Generation cap. |

- `READER_LM_MODELS` (when non-empty) takes precedence; the three legacy `READER_LM_*` vars
  synthesize one entry `{ id: "reader_lm", label: "reader-lm-0.5b", model, baseUrl }`.
- `config-manager.js` gets the corresponding setters (same pattern as existing vars).
- `.env.example` / `.env.example.full` rows.

### 2. New module — `src/reader-lm.js`

- `getAiModels(config)` — returns the resolved model-entry list (empty when nothing configured).
- `isReaderLmConfigured(config, modelId)` — the given id exists in the resolved list.
- `extractHtmlWithAiModel({ html, model, config, maxChars })`:
  - Truncate input to `READER_LM_MAX_INPUT_CHARS` (tail-cut; note in comments).
  - POST to `${model.baseUrl}/chat/completions` (Node `fetch`), JSON body above with
    `model: model.model`.
  - Return trimmed `choices[0].message.content`.
  - Throw on: not configured, non-2xx, timeout, empty content. Caller falls back.
- **Concurrency gate** — no more than N (default 2) in-flight AI-model calls across the process
  (parallel `web_fetch` pages + flow blocks would stack on local inference). Simple promise pool.
- Timing log lines (match the `[web_fetch] [${url}]` debug style).

### 3. `src/domain-hints.js`

- `DEFAULT_FORMATS` → `["readability_to_markdown", "html_to_markdown", "html", "text", "table",
  "table_json", "table_csv"]` + AI-model ids (D11). `list` stays block-only.
- `BLOCK_FORMATS` → unchanged set + AI-model ids.
- `FIELD_FORMATS` → unchanged (fields stay render modes).
- **`default.tables` removed:** drop its validation (605-612); unknown-key check rejects/warns it;
  `migrateHintShape` strips `tables` from `default` (silently for `"all"`, with a warning for
  `"content"`/`"disabled"` since those no longer exist).
- Validation error messages for `default.format` / `block.format` updated to enumerate valid
  extractor values; AI-model ids validated against the configured model list (accept `reader_lm`
  + ids present in `READER_LM_MODELS`).

### 4. `src/search.js` — extraction chain + whole-page dispatch

**Async refactor (contained):** `renderLeafContent`, `renderContentBlocks`, `extractTextFromHtml`,
`extractHintStage` → async so blocks can await the model:
- `extractTextFromHtml` → `async`; `renderContentBlocks` → `async`; `renderLeafContent` → `async`.
- Callers already await-able: `search.js:2536`, `2713` (inside async `browserOpenAndExtract`).
- Flow chain: `extractHintStage` (2131) → `await`; `replayFlowFromSnapshot`'s sync `forEach`
  (2211) → sequential `for...of` with `await`; `runFlowExtraction` awaits the stage already.
- `renderHintFields` stays sync (no AI model for fields).

**Default path — replace the `tablesMode` strip logic (1006-1012, 1031-1042, 1102-1108) with a
full format dispatch** (`pageFormat` from `default.format || "readability_to_markdown"`):

| pageFormat | behavior |
|---|---|
| `text` | flat text dump (existing path) |
| `html` | wrap the best content container's `innerHTML` in a ```html code fence (new) |
| `html_to_markdown` | whole-page HTML → markdown, tables rendered by Turndown (existing) |
| `readability_to_markdown` | Readability → markdown (existing default) |
| `table` | `extractTablesFromDocument(doc)` (global, no node removal) → `renderTableAsMarkdown` — **tables-only output** (new) |
| `table_json` | same extraction → `renderTablesAsJson` — **tables-only output** (new) |
| `table_csv` | same extraction → `renderTablesAsCsv` — **tables-only output** (new) |
| AI-model id | prepare document (skipSelectors already stripped) → serialize `body.innerHTML` → `extractHtmlWithAiModel` → markdown (new) |

No table nodes are removed from the DOM in the default path anymore (D12) — the extractor renders
them. `insertTablesInline` remains for the flow/block path only.

**Block path:** in `renderLeafContent`, `if (format is an AI-model id)` → pass `element.outerHTML`
to the model, return markdown (fall back to `html_to_markdown` on error). Block table handling
(`table`/`table_json`/`table_csv` formats + content-format strip) is unchanged.

### 5. `src/mcp-server.js`

- **Cache bypass for AI-model extractors:** when the matched hint's effective extractor is an
  AI-model id, skip the web_fetch result-cache read *and* write (model output is expensive +
  non-deterministic, and the cache key doesn't include the hint/extractor). Implemented as a check
  in the `web_fetch` handler (`1902-1938`) — read the resolved hint before the cache lookup.
- Verify `/extract` (test-before-save, `hintOverride`) cache behavior — same bypass rule so the
  Test pane never returns a stale readability result after switching to AI Model.
- No tool-schema change: `web_fetch` still exposes no `format` param (extractor stays a
  per-hint concern).
- `/stats` or `/console` config surface: report configured AI models so the console can render
  the "AI Model — <name>" options and the "not configured" state.

### 6. Console — `src/web-console/src/main.jsx`

- **Extractor label map** — `EXTRACTOR_LABELS = { readability_to_markdown: "Readability to Markdown", html_to_markdown: "HTML to Markdown", html: "HTML", text: "Text", table: "Table", table_json: "Table (JSON)", table_csv: "Table (CSV)" }`; AI-model entries render as `AI Model` (single) / `AI Model — <label>` (multiple) — **D4/D5**.
- Rename labels: `Format (content)` → `Extractor` (3615), block `Format` → `Extractor` (2578);
  update `title` + hint copy.
- **Remove the "Table extraction" dropdown** (`main.jsx:3633-3647`) and `default.tables` from
  `emptyHint()` (2318-2325) and `patchDefault` flows.
- Default-extraction dropdown (3615) renders the new friendly option set (text, html,
  html_to_markdown, readability_to_markdown, table, table_json, table_csv — **no list**) + the
  resolved AI-model options; JSON value stays the id.
- Interactive-flow block dropdown (2578): label **"Extractor"**, friendly labels for the full set
  (incl. `list`), plus the resolved AI-model options.
- Guide table (3109): rename row, add AI Model, **delete the "Table extraction" row**; JSON
  template comment (3152) updated to friendly extractor values and the `tables` line removed.
- Test pane: when an AI model is selected and the server reports it unconfigured, show the
  `⚠ falls back to html_to_markdown` note inline.
- Optional cleanup: rename consts `DEFAULT_PAGE_FORMATS` → `DEFAULT_EXTRACTORS`,
  `HINT_BLOCK_FORMATS` → `HINT_BLOCK_EXTRACTORS` (low-risk, cosmetic).

### 7. Tests

- `tests/domain-hints.test.js`: new `DEFAULT_FORMATS` accepted (`html`, `table`, `table_json`,
  `table_csv`, AI ids); `list` rejected in `default.format`; `tables` key rejected/migrated out;
  AI ids accepted in `block.format`; unknown model id rejected.
- `tests/search.test.js`: per-format default dispatch — `html` → fenced raw HTML; `table` /
  `table_json` / `table_csv` → **tables-only** output (assert no prose); tables no longer stripped
  for content formats (HTML-to-Markdown output contains table markdown); AI extractor unconfigured
  → fallback + warning; configured mock → markdown; block-format AI path; async chain returns
  identical results for existing formats (regression guard for the async refactor).
- Cache: web_fetch handler skips cache read/write when extractor is an AI-model id (mock).

### 8. Docs

- `AGENTS.md`: Tool Contract `web_fetch` note (unified extractor dropdown incl. AI Model, friendly
  labels, tables handled by the extractor, fallback semantics, cache bypass), Configuration table
  (`READER_LM_*`), Domain Hints Workflow pitfall ("Extractor not Format", "no Table extraction
  dropdown"), **supersede the "Table Extraction — Always On, No Flag" learning** (the default path
  no longer strips tables; `table`-family extractors are the explicit way to get tables),
  **CC-BY-NC-4.0 license note**.
- `README.md`: env var table rows.

## Rollout / Verification

1. Land config + `reader-lm.js` (steps 1–2) — inert until env is set; existing behavior unchanged.
2. `domain-hints.js` enum unification + `tables` removal + validation + tests.
3. `search.js` async refactor **alone first**, run full test suite — must be a zero-behavior-change
   refactor before the format dispatch / tables changes.
4. Implement the whole-page format dispatch (incl. `html`, `table*`, tables-not-stripped) and the
   AI branches + cache bypass; verify against `docker exec navigator curl localhost:3000/extract`
   for each format; verify with a live vLLM/Ollama endpoint once GPU lands:
   ```bash
   READER_LM_BASE_URL=http://host.docker.internal:8000/v1 READER_LM_MODEL=jinaai/reader-lm-0.5b
   # console: set Extractor=AI Model on a hint, Test pane → clean markdown, no ⚠ fallback note
   ```
5. Console UI (rename + friendly labels + unified dropdowns + table-dropdown removal). Build:
   `docker exec navigator npm install --include=dev && docker exec navigator npm run console:build`.
   Restart `docker restart navigator`, hard-refresh console (`/console/assets/*` is immutable-cached).
6. Confirm: default-extraction Extractor shows Text / HTML / HTML to Markdown / Readability to
   Markdown / Table / Table (JSON) / Table (CSV) / AI Model; no Table extraction dropdown anywhere;
   flow block dropdown shows the full set incl. List + AI Model; fallback note when AI unconfigured;
   `web_fetch` bypasses cache for an AI-model hint (change output, no `bypassCache`).

## Non-Goals

- Embedding inference inside navigator (no Python/transformers/ONNX).
- Adding `format`/`extractor` param to the MCP `web_fetch` schema (extractor stays per-hint).
- AI model for record fields (per-item LLM calls).
- `list` as a whole-page default extractor (block-only).
- Keeping `default.tables` in any form (removed — the extractor renders tables).
- Switching any existing hint to AI Model, or changing the built-in default extractor.
- GPU provisioning / vLLM / Ollama install (separate effort, user-owned).
- Model *management* UI (add/remove models in the console) — model list comes from env config.

## Decisions Summary

- **D1** — model: `jinaai/reader-lm-0.5b` (`reader-lm:0.5b` on Ollama); name env-configurable.
- **D2** — transport: OpenAI-compatible HTTP (`/chat/completions`); raw HTML as the user message,
  no instruction prefix; fall back to `html_to_markdown` on every failure.
- **D3** — serving: vLLM on GPU (user adding GPU support separately); Ollama CPU fallback; feature
  inert until a model endpoint is configured.
- **D4** — dropdown shows **friendly labels** for all extractors; raw ids stay in the JSON.
- **D5** — "AI Model" is a **category**: one option per configured model, labeled
  `AI Model` (single) / `AI Model — <label>` (multiple); each has a stable id stored in the hint.
- **D6** — AI extractor receives the **full prepared HTML including tables** and renders them as
  markdown itself (no strip-then-append for the AI path; supersedes the earlier "keep current
  pipeline" draft).
- **D7** — cache bypass: AI-model fetches skip the web_fetch result cache (read + write).
- **D8** — concurrency gate (≤2 in-flight) so parallel pages don't stack on local inference.
- **D9** — license `CC-BY-NC-4.0` (non-commercial) documented; user assumes responsibility.
- **D10** — the interactive-flow block extractor keeps its full existing option set (text, list,
  html, html_to_markdown, readability_to_markdown, table, table_json, table_csv) + AI Model;
  label renamed to **"Extractor"**.
- **D11** — default extraction's extractor dropdown mirrors the block dropdown **minus `list`**:
  text, html, html_to_markdown, readability_to_markdown, table, table_json, table_csv, + AI Model.
- **D12** — `default.tables` (all/content/disabled) **removed**; tables are the extractor's job —
  content formats render tables naturally, `table`/`table_json`/`table_csv` produce **tables-only**
  output.

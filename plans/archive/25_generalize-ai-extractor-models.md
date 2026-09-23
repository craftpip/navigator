# Plan 25: Generalize AI Models (rename `READER_LM_*` + post-processor pipeline)

## Goal

`READER_LM_*` env vars are no longer reader-lm-specific — they already carry two kinds
(`chat` / `mineru`), and OvisOCR2 (a vision model, GGUF-pulled into Ollama) is next.

Redesign the AI-model feature into a **two-stage pipeline**:

1. **Extractor** (`DEFAULT_EXTRACT_FORMAT` / hint `default.format` / block `format`) —
   produces the intermediate, unchanged set: `readability_to_markdown` · `html_to_markdown`
   · `text` · `html` · `table*`, plus a **new `screenshot` extractor** (full-page image)
   for vision post-processors.
2. **Post-processor** (`DEFAULT_EXTRACT_POST_PROCESSOR` / hint `postProcessor`) — an AI
   model from `POST_PROCESSOR_MODELS`. When set, the extractor's output is forwarded to the
   model and the model's markdown is returned. On model failure, the extractor output is
   returned unchanged.

Models are no longer extractor formats — they are **post-processors**. Each
`POST_PROCESSOR_MODELS` entry declares its transport (`kind`) and its **input requirements**
(`inputs`: what extractor output types it can consume). The `html` extractor output feeds
MinerU; the `text` extractor output feeds reader-lm; the `screenshot` extractor output
feeds OvisOCR2.

```
extractor (format) ──► intermediate ──► post-processor (AI model) ──► markdown
  readability/md      text|html|image      chat | api                  |
  html_to_markdown  ────────────────────────────────────────────────┘ (or input, on failure)
  text · html · table*
  screenshot (image)
```

Two deliverables, shipped as two phases:

1. **Phase 1 — Rename** (DONE, 2026-08-16): env vars + config keys + module name from
   `READER_LM_*` to a general name.
2. **Phase 2 — Post-processor pipeline** (NEXT, not started): new `screenshot` extractor,
   `DEFAULT_EXTRACT_POST_PROCESSOR` (+ hint/block `postProcessor`), `POST_PROCESSOR_MODELS`
   entry redesign with `inputs`, end-result caching, console UI.

OvisOCR2 landing in the existing Ollama (`hf.co/Abiray/OvisOCR2-GGUF:Q4_K_M`, already
pulled 2026-08-16) is the motivating case: it wants a page screenshot via the
OpenAI-compatible `image_url` content part, not HTML.

## Phases

- **Phase 1 — Rename `READER_LM_*` → `AI_EXTRACTOR_*`** (implemented 2026-08-16). Old
  names kept as deprecated fallbacks (new name wins; legacy appliers keep hot-apply for
  the timeout/input-chars/tokens trio). **Superseded** — Phase 2 folds in a second rename
  to `POST_PROCESSOR_*` (the models are post-processors, not extractors), and the three
  per-call limit vars move into the JSON entries, so `POST_PROCESSOR_MODELS` becomes the
  only env var. See the [Phase 1 checklist](#phase-1--rename-done).
- **Phase 2 — Post-processor pipeline** (not started). New `screenshot` extractor (label:
  "full-page screenshot (for post-processors)"), `DEFAULT_EXTRACT_POST_PROCESSOR` +
  hint/flow `postProcessor`, redesigned `POST_PROCESSOR_MODELS` entries (`inputs`), rename
  `AI_EXTRACTOR_*` → `POST_PROCESSOR_*` (env, config key, module, functions, console
  label), end-result caching replacing the HTML-first cache + `usesAiExtractor` skip, no
  backwards compat (model-as-extractor coerced to `readability_to_markdown` on load),
  console: post-processor dropdown + special JSON editor. See the
  [Phase 2 checklist](#phase-2--post-processor-pipeline-not-started).

## Current State (verified 2026-08-16)

> Snapshot taken before Phase 1; names below are the pre-rename `READER_LM_*` state.

### Env vars

| Env var | Config key | Applies | Meaning |
|---|---|---|---|
| `READER_LM_MODELS` | `readerLmModels` | recreate | JSON array of model entries |
| `READER_LM_BASE_URL` | (via `resolveReaderLmModels`) | recreate | Legacy single-model base URL |
| `READER_LM_MODEL` | (via `resolveReaderLmModels`) | recreate | Legacy single-model id |
| `READER_LM_TIMEOUT_MS` | `readerLmTimeoutMs` | hot | Per-call timeout |
| `READER_LM_MAX_INPUT_CHARS` | `readerLmMaxInputChars` | hot | HTML truncation (tail-cut) |
| `READER_LM_MAX_TOKENS` | `readerLmMaxTokens` | hot | Generation token cap |

Entry shape today (`src/config.js` `parseReaderLmModels`):
`{ id, label, model, baseUrl, kind }` where `kind` ∈ `chat` (default) | `mineru`.

Legacy single-model path (`resolveReaderLmModels`, src/config.js:451) builds
`[{ id: "reader_lm", label: model, model, baseUrl, kind: "chat" }]` from
`READER_LM_BASE_URL` + `READER_LM_MODEL`.

### Call paths

- `extractHtmlWithAiModel({ html, model, config, maxChars, debug })` (src/ai-extractor.js:128)
  → picks entry, dispatches to `extractWithChat` (POST `${baseUrl}/chat/completions`,
  `content` = prepared HTML string) or `extractWithMineru` (POST `${baseUrl}/extract`,
  `{ html }`). Concurrency capped at 2 (`acquireSlot`).
- Called from `src/search.js`:
  - Block-level: `renderLeafContent` → `extractHtmlWithAiModel({ html: element.outerHTML })` (line 812)
  - Default path: `extractTextFromHtml` → `extractHtmlWithAiModel({ html: doc.body.innerHTML })` (line 1038)
- `src/mcp-server.js`: `getConsoleConfigPayload` special-cases the `READER_LM_MODELS`
  key (line 411) and exposes `aiModels: getAiModels(manager.config)` for the console
  dropdowns (line 421, also 2772, 2922, 3091).
- Console (`src/web-console/src/main.jsx`): "Web Fetch AI Extractors" group lists the 6
  keys (line 16); `aiModelKindLabel` (2361) + `aiModelOptionLabel` (2364) render the
  extractor-type suffix on dropdown options; used by block editors + hint editor panes.
- Tests: `tests/ai-extractor.test.js`, `tests/search.test.js` (configOverrides at 843/872/905),
  `tests/mcp-server.test.js:1688`.
- Deploy files: `.env` lines 42-45, `docker-compose.yml` lines 85-93.

### Key architectural constraints

1. **Screenshots need a live page.** `extractTextFromHtml` only ever sees **serialized
   HTML** (`doc.body.innerHTML`), not a live page. The `screenshot` extractor can only
   capture where a live `page` object exists: `browserOpenAndExtract` (src/search.js:2615)
   and flow extraction (`runFlowExtraction` / `executeFlow`, `capturePageState` at 2155).
   So `screenshot` must be captured upstream and threaded down, and the cached-HTML replay
   path can never produce one.
2. **The post-processor needs the extractor output, not the raw page.** Hooking it inside
   `extractTextFromHtml` / `renderLeafContent` means the model sees exactly what the
   extractor produced (markdown tables are already inline; `html` format passes raw HTML;
   `screenshot` passes the image). Link ref-id rewriting happens downstream on the model's
   output, so inline links still work.

## Design

### 1. New names (the rename) — Phase 1 done, Phase 2 supersedes the suffix

Phase 1 renamed `READER_LM_*` → `AI_EXTRACTOR_*`. The design since evolved: models are
**post-processors**, not extractors, so Phase 2 renames again to **`POST_PROCESSOR_*`**
(env var, config key, module, functions, console label). The table below shows the final
names; the `AI_EXTRACTOR_*` intermediates are transient.

| Old | Final |
|---|---|
| `READER_LM_MODELS` | `POST_PROCESSOR_MODELS` (the **only** model env var left) |
| ~~`READER_LM_BASE_URL`~~ | **removed (Phase 2)** — `baseUrl` lives in the JSON entry |
| ~~`READER_LM_MODEL`~~ | **removed (Phase 2)** — `model` lives in the JSON entry |
| ~~`READER_LM_TIMEOUT_MS`~~ | **removed (Phase 2)** — per-entry `timeoutMs` in the JSON |
| ~~`READER_LM_MAX_INPUT_CHARS`~~ | **removed (Phase 2)** — per-entry `maxInputChars` in the JSON |
| ~~`READER_LM_MAX_TOKENS`~~ | **removed (Phase 2)** — per-entry `maxTokens` in the JSON |
| ~~**new (Phase 2)**~~ | ~~**`AI_EXTRACTOR_INPUT`**~~ — **dropped** (see open question 3) |

Config key: `postProcessorModels` (from `aiExtractorModels`). Module
`src/ai-extractor.js` → **`src/post-processor.js`** (imports in search.js + mcp-server.js);
functions `getAiExtractorModels` → `getPostProcessorModels`, `extractHtmlWithAiModel` →
`runPostProcessor`, `getAiExtractorKind` → `getPostProcessorKind`, `isAiExtractorConfigured`
→ `isPostProcessorConfigured`. Console payload `aiModels` → `postProcessorModels`; group
label "Web Fetch AI Extractors" → "Web Fetch Post-Processors". Test file
`tests/ai-extractor.test.js` → `tests/post-processor.test.js`.

Backward compat: Phase 1 keeps reading the old `READER_LM_*` names as **deprecated
fallbacks** (new name wins; log a one-time console warning when an old name is used). This
keeps `.env` and external configs working during migration and satisfies the project's
"safe change boundaries" rule. The console Manage panel writes the new names. Phase 2's
second rename drops all three per-call limit vars (they move into the JSON), so only
`POST_PROCESSOR_MODELS` + `DEFAULT_EXTRACT_POST_PROCESSOR` remain as env vars.

### 2. `POST_PROCESSOR_MODELS` entry redesign — Phase 2

Entries keep `id` / `label` / `model` / `baseUrl` / `kind` and gain **`inputs`** — the
set of extractor output types the model can consume. No more `input` pipeline field; the
extractor decides what the model receives.

```json
[
  { "id": "reader_lm",  "label": "reader-lm-0.5b",      "model": "jinaai/reader-lm-0.5b",
    "baseUrl": "http://host.docker.internal:8000/v1",   "kind": "chat",  "inputs": ["html", "text"] },
  { "id": "ovis_ocr2",  "label": "OvisOCR2 (vision)",   "model": "hf.co/Abiray/OvisOCR2-GGUF:Q4_K_M",
    "baseUrl": "http://10.69.1.164:11434/v1",           "kind": "chat",  "inputs": ["image", "text"] },
  { "id": "mineru",     "label": "MinerU-HTML",         "model": "mineru",
    "baseUrl": "http://navigator-mineru:8000",          "kind": "mineru", "inputs": ["html"] },
  { "id": "my_api",     "label": "My custom API",       "model": "",
    "baseUrl": "http://10.0.0.5:9000",                  "kind": "api",    "inputs": ["html", "text"],
    "path": "/convert", "method": "POST",
    "body": { "data": { "content": "{{input}}", "lang": "en" } }, "outputField": "data.markdown" }
]
```

Each entry carries its own per-call limits too (no global env vars):
`{"id":"ovis_ocr2","label":"OvisOCR2 (vision)","model":"hf.co/Abiray/OvisOCR2-GGUF:Q4_K_M",
"baseUrl":"http://10.69.1.164:11434/v1","kind":"chat","inputs":["image","text"],
"maxTokens":2048,"maxInputChars":40000,"timeoutMs":90000}` — defaults
`maxTokens: 8192` / `maxInputChars: 60000` / `timeoutMs: 60000` when omitted.

Three transports, all usable as post-processors:

- **`kind: "chat"`** (default) — OpenAI-compatible: POST `${baseUrl}/chat/completions`.
- **`kind: "mineru"`** — the MinerU-HTML sidecar, unchanged from today: POST `{ html }`
  to `${baseUrl}/extract`, read `text` from the JSON response. `inputs: ["html"]`.
- **`kind: "api"`** — a **user-defined custom API** post-processor: any HTTP endpoint
  (`path`, `method`, `body` template with `{{input}}`, `outputField` / `outputType`).
  Same "call an API, return its output" idea as mineru, but configurable per entry.

| Field | Req | Meaning |
|---|---|---|
| `id` | yes | Unique slug; referenced by `DEFAULT_EXTRACT_POST_PROCESSOR` / hint & block `postProcessor` |
| `label` | no | Dropdown label (default = `model`) |
| `model` | yes* | Model name sent to the endpoint (`chat` only; optional, unused by `mineru`/`api`) |
| `baseUrl` | yes | Endpoint root; `chat` → `${baseUrl}/chat/completions`, `mineru` → `${baseUrl}/extract`, `api` → `${baseUrl}${path}` |
| `kind` | no | Transport: `chat` (default) \| `mineru` \| `api` |
| `inputs` | yes | Extractor output types the model can consume — subset of `html` \| `text` \| `image` |
| `path` | no* | `api` only. Endpoint path appended to `baseUrl` (default `/extract`) |
| `method` | no* | `api` only. HTTP method (default `POST`) |
| `body` | no* | `api` only. JSON body template; `"{{input}}"` is replaced with the JSON-encoded extractor output (default `{ "html": "{{input}}" }`). `{{input}}` is interpolated by replacing the quoted placeholder in the serialized template with `JSON.stringify(input)` so quotes/newlines in the input stay valid |
| `headers` | no* | `api` only. Extra request headers (Content-Type defaults to `application/json`) |
| `outputField` | no* | `api` only. Dotted path into the JSON response where the markdown lives (default `text`, MinerU's shape) |
| `outputType` | no* | `api` only. `json` (default) \| `text` — read the response body as plain text (no `outputField`) |
| `prompt` | no | Per-model prompt override (`chat` only; default = per-kind constant) |
| `maxTokens` | no | Generation token cap (`chat` only; default `8192`) |
| `maxInputChars` | no | Input truncation cap, tail-cut before sending (all kinds; default `60000`). Each entry overrides its own input budget |
| `timeoutMs` | no | Per-call timeout (all kinds; default `60000`) |

* — `api`-kind fields (`path`, `method`, `body`, `headers`, `outputField`, `outputType`)
only apply to `kind: "api"`; `model` is only meaningful for `kind: "chat"`. Unknown-kind/
unknown-field combos are dropped at parse with a warning. The `{{input}}` placeholder
appears as a **string value** in `body`; nested objects/arrays are preserved.

**Output type of each extractor** — the compatibility side of `inputs`:

| Extractor `format` | Output type |
|---|---|
| `text` · `list` · `html_to_markdown` · `readability_to_markdown` · `table` · `table_json` · `table_csv` | `text` |
| `html` | `html` |
| `screenshot` (new) | `image` |

Parse in `src/config.js`: `parsePostProcessorModels` validates `inputs` against
`POST_PROCESSOR_INPUTS = new Set(["html", "text", "image"])`; entries with no `inputs`
default to `["text"]` (today's behavior); `maxTokens`/`maxInputChars`/`timeoutMs` are
per-entry (no env vars). **No `AI_EXTRACTOR_INPUT` env var** — that concept is gone, and
so is the legacy single-model path: `AI_EXTRACTOR_BASE_URL` + `AI_EXTRACTOR_MODEL` are
**removed** in Phase 2. `POST_PROCESSOR_MODELS` is the only source; a single chat model is
just `[{"id":"reader_lm","label":"reader-lm-0.5b","model":"jinaai/reader-lm-0.5b","baseUrl":"http://host.docker.internal:8000/v1"}]`.
Existing setups migrate by moving the values into a chat entry.

### 3. Architecture — extractor → post-processor, end-result caching

```
   extractor (format)        intermediate          post-processor (AI model)         output
┌───────────────────────┐  ┌──────────────┐  ┌──────────────────────────┐  ┌──────────────────┐
│ readability/md        │  │   text  ◄──────┼──▶ chat (text content)    │  │                  │
│ html_to_markdown text │─►│   html  ◄──────┼──▶ chat (text content)    │─►│ markdown         │
│ html · table*         │  │   html  ───────┼──▶ mineru (POST {html})   │  │  (or the extractor│
│ screenshot (new)      │  │  image  ◄──────┼──▶ chat (image_url part)  │  │   output on error│
└───────────────────────┘  └──────────────┘  └──────────────────────────┘  └──────────────────┘
  (api kind: html|text ──► custom endpoint, same diagram slot as mineru)
```

**`DEFAULT_EXTRACT_POST_PROCESSOR`** (new env var): a model `id` from
`POST_PROCESSOR_MODELS`. Empty = no post-processing. Hot-applied. Also settable per-hint
(`default.postProcessor`) and per-block (`content.blocks[].postProcessor`, incl. flow
extract steps). A post-processor on a non-screenshot format receives the extractor's text
or html output; on `screenshot` it receives the page image.

**`src/search.js` — where the post-processor hooks in:**

- The post-processor runs **after** the default/block extractor produces its output, inside
  `extractTextFromHtml` (default path) and `renderLeafContent` (block path). It receives
  the extractor's output as input:
  - `text`-output extractors → `runPostProcessor({ text: extractedText, ... })`.
  - `html` extractor → current behavior (`runPostProcessor({ html: doc.body.innerHTML })`).
  - `screenshot` extractor → the captured image (`runPostProcessor({ screenshot: dataUrl, ... })`).
  - Compatibility: if the extractor's output type ∉ entry.`inputs` → console warn + return
    the input unchanged (the point-7 fallback). If the model call errors → same fallback.
- **New `screenshot` extractor format:** captures the full page in `browserOpenAndExtract`
  after `stabilizePage` — `page.screenshot({ encoding: "base64", type: "jpeg",
  quality: 75, fullPage: true })` → `data:image/jpeg;base64,...`. Without a post-processor
  it returns the raw image (by design; the console label "full-page screenshot (for
  post-processors)" makes the intent clear). Only capturable where a live page exists:
  `browserOpenAndExtract` + flow `capturePageState` (flow screenshot blocks capture the
  whole page at that step; per-element cropping out of scope for v1). In
  `extractTextFromHtml` the screenshot arrives via a threaded param.
- **No backwards compat:** model ids are removed from the extractor lists. On config/hint
  load, any `format` that names an AI model id is coerced to `readability_to_markdown`
  with a one-time console warning — including `DEFAULT_EXTRACT_FORMAT`
  (mcp-server.js:1937 check disappears), hint `default.format`, block `format`, and flow
  block `format`. `isAiModelFormat` is deleted.

**`src/mcp-server.js` — end-result caching (point 5):**

- **Replace** the `usesAiExtractor` cache skip (mcp-server.js:1931-1954, 1970-1973) and the
  HTML-first `cachedHtmlByUrl` replay: the web_fetch cache stores the **final result**
  (post-post-processor), so a cache hit returns the model's markdown without re-running it.
- Cache key must distinguish configurations: extend `getCacheArgs` for web_fetch with the
  effective extractor + post-processor so `format: readability` + `postProcessor: reader_lm`
  and `format: readability` alone don't collide. (The per-URL hint is deterministic for a
  URL; a hint edit is refreshed via `bypassCache`, same as today.) `bypassCache` stays the
  manual refresh.
- The `screenshot` extractor can then cache too — the cached value is the OCR'd markdown,
  not the image, so the live-page constraint only applies on a cold miss.

**`src/post-processor.js` — payload dispatch:**

- `runPostProcessor({ text?, html?, screenshot?, model, config, debug })` — accepts
  exactly one of `text` / `html` / `screenshot`, resolved by the calling extractor. Limits
  (`maxInputChars` / `maxTokens` / `timeoutMs`) come from the entry, not the caller.
  Dispatch by `kind`: `screenshot` → `extractWithChatImage` (chat, `image_url` content
  part); `text` → chat text content; `html` → chat text content, **`extractWithMineru`**
  (`mineru` — POST `{ html }` to `${baseUrl}/extract`, read `text`, existing code
  unchanged), or **`extractWithApi`** (`api` — custom endpoint).
- `extractWithChatImage` POSTs to `${baseUrl}/chat/completions`:
  ```json
  {
    "model": "...",
    "messages": [{ "role": "user", "content": [
      { "type": "text", "text": "Extract all readable content from this page as Markdown, preserving tables and formulas." },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
    ]}],
    "max_tokens": ...,
    "temperature": 0
  }
  ```
  (Prompt constant lives here, overridable per-entry via `prompt`; OvisOCR2's model card
  prompt is the reference.) Concurrency stays capped at 2 (`acquireSlot`).
- **`extractWithApi`** — the **custom API** transport (only for `kind: "api"` entries).
  POST (or `method`) the body template to `${baseUrl}${path}`; the `{{input}}` placeholder
  in `body` is replaced with the JSON-encoded extractor output (quoted-placeholder
  substitution keeps quotes / newlines in the input valid); extra `headers` merged in.
  Response: `outputType: "text"` → raw body, `"json"` → `outputField` dotted-path lookup
  into the parsed JSON (default `text`). HTTP error / missing field / empty → throws →
  falls back to the input-unchanged rule like every transport. The `mineru` kind keeps its
  existing `extractWithMineru` unchanged — it is NOT expressed via `extractWithApi`.

**Console (`src/web-console/src/main.jsx`):**

- AI model ids **leave** the extractor format dropdowns (`getValidExtractors` no longer
  appends them; `screenshot` joins the extractor lists with the label "full-page screenshot
  (for post-processors)").
- New **post-processor dropdown**: `DEFAULT_EXTRACT_POST_PROCESSOR` (default block) and
  per-block `postProcessor` list the `POST_PROCESSOR_MODELS` entries directly
  (`id` + `label` + `inputs` suffix, e.g. `OvisOCR2 (vision) [image,text]`).
- **Special post-processor JSON editor** for `POST_PROCESSOR_MODELS` (point 9): a dedicated
  pane (JSON textarea + validate + save, like the Domain hints editor) where all per-model
  details (transport, `inputs`, limits) are stored; the post-processor dropdowns are built
  from it. Rebuild console bundle.

**`src/mcp-server.js` / `getConsoleConfigPayload`:** expose `postProcessorModels` with the
new `inputs`/`prompt`/`maxTokens`/`maxInputChars`/`timeoutMs` fields for the editor +
dropdowns (line 411 special-case updated).

## File-by-file change list

| File | Change |
|---|---|
| `src/config.js` | Rename `aiExtractorModels` → `postProcessorModels`; `parsePostProcessorModels` validates `inputs` (`POST_PROCESSOR_INPUTS = {html,text,image}`, default `["text"]`) + per-kind fields (`api`: `path`/`method`/`body`/`headers`/`outputField`/`outputType`; `mineru` stays as-is; unknown kind/field dropped w/ warn) + per-entry `maxTokens`/`maxInputChars`/`timeoutMs`; add `DEFAULT_EXTRACT_POST_PROCESSOR` parse (model id, empty = off); **delete `resolveAiExtractorModels` fallback + the `AI_EXTRACTOR_TIMEOUT_MS`/`AI_EXTRACTOR_MAX_INPUT_CHARS`/`AI_EXTRACTOR_MAX_TOKENS` parses** (`AI_EXTRACTOR_BASE_URL`/`AI_EXTRACTOR_MODEL` removed too); **no** `AI_EXTRACTOR_INPUT` |
| `src/config-schema.js` | Keep only `POST_PROCESSOR_MODELS` (renamed from `AI_EXTRACTOR_MODELS`) + new `DEFAULT_EXTRACT_POST_PROCESSOR` (type string, hot); **remove `AI_EXTRACTOR_BASE_URL`/`AI_EXTRACTOR_MODEL`/`AI_EXTRACTOR_TIMEOUT_MS`/`AI_EXTRACTOR_MAX_INPUT_CHARS`/`AI_EXTRACTOR_MAX_TOKENS` rows**; update `POST_PROCESSOR_MODELS` description (kinds `chat`\|`mineru`\|`api`, per-entry limits, `{{input}}` body template, outputField); **no** `AI_EXTRACTOR_INPUT` |
| `src/config-manager.js` | Rename `aiExtractorModels` applier; **delete the TIMEOUT/MAX_INPUT_CHARS/MAX_TOKENS hot appliers**; add `DEFAULT_EXTRACT_POST_PROCESSOR` hot applier |
| `src/ai-extractor.js` → `src/post-processor.js` (Phase 1 done, rename again in Phase 2) | `runPostProcessor({ text?, html?, screenshot? })` — exactly one payload; limits read from the entry (`maxInputChars`/`maxTokens`/`timeoutMs`); `extractWithChatImage`; **`extractWithApi`** (method/path/body-template/outputField/outputType); `extractWithMineru` unchanged; entry `prompt` override; error message (line 132) drops the `AI_EXTRACTOR_BASE_URL` hint |
| `src/search.js` | Post-processor hook after extractor in `renderLeafContent` (block) + `extractTextFromHtml` (default): feed extracted text/html to the model, fallback = return input on mismatch/error; new `screenshot` format (capture in `browserOpenAndExtract` + flow `capturePageState`, thread down); coerce legacy model-id formats → `readability_to_markdown` on hint/config load |
| `src/mcp-server.js` | Delete `usesAiExtractor` skip + HTML-first `cachedHtmlByUrl` replay; cache end result; extend web_fetch cache key with effective extractor + post-processor; remove `isAiModelFormat` default-format check (1937) |
| `src/web-console/src/main.jsx` | Remove model ids from extractor dropdowns; add `screenshot` → "full-page screenshot (for post-processors)"; post-processor dropdowns (`DEFAULT_EXTRACT_POST_PROCESSOR`, block `postProcessor`) from `POST_PROCESSOR_MODELS` with `inputs` suffix; drop `AI_EXTRACTOR_BASE_URL`/`AI_EXTRACTOR_MODEL`/`AI_EXTRACTOR_TIMEOUT_MS`/`AI_EXTRACTOR_MAX_INPUT_CHARS`/`AI_EXTRACTOR_MAX_TOKENS` from the console group (line 16) — rename to "Web Fetch Post-Processors"; special post-processor JSON editor pane; rebuild bundle |
| `.env` | Rename `AI_EXTRACTOR_MODELS` → `POST_PROCESSOR_MODELS`; **delete `AI_EXTRACTOR_BASE_URL`/`AI_EXTRACTOR_MODEL`/`AI_EXTRACTOR_TIMEOUT_MS`/`AI_EXTRACTOR_MAX_INPUT_CHARS`/`AI_EXTRACTOR_MAX_TOKENS`**; add `DEFAULT_EXTRACT_POST_PROCESSOR` (empty by default) |
| `docker-compose.yml` | Rename `AI_EXTRACTOR_MODELS` → `POST_PROCESSOR_MODELS`; **remove the `AI_EXTRACTOR_BASE_URL`/`AI_EXTRACTOR_MODEL`/`AI_EXTRACTOR_TIMEOUT_MS`/`AI_EXTRACTOR_MAX_INPUT_CHARS`/`AI_EXTRACTOR_MAX_TOKENS` passthrough lines (89-93)**; add `DEFAULT_EXTRACT_POST_PROCESSOR`; add `POST_PROCESSOR_MODELS` comment for the new entry shape |
| `tests/ai-extractor.test.js` → `tests/post-processor.test.js` (Phase 1 done, rename again in Phase 2) | Phase 2: `inputs` parse, per-kind field validation, `text`/`html`/`screenshot` payload dispatch, `extractWithApi` (`{{input}}` interpolation incl. quotes/newlines, method/path, outputField, outputType text), `mineru` kind unchanged (POST `{html}` → `/extract`, read `text`), per-entry `maxTokens`/`maxInputChars`/`timeoutMs` defaults + overrides, mismatch fallback returns input |
| `tests/search.test.js` | Update `configOverrides` keys (843/872/905); model-format → readability coercion; post-processor fallback |
| `tests/mcp-server.test.js` | Update key at 1688; end-result cache: key includes post-processor; screenshot output cached |
| `docs/` + `AGENTS.md` + `README.md` | Env tables (new/renamed vars), extractor formats list (+ `screenshot`), post-processor section, plan 22/23/24 cross-refs |

## Migration

1. Deploy Phase 1 rename (new names + deprecated fallbacks) behind a release.
2. Update `.env` to the new names (or rely on fallbacks); add `DEFAULT_EXTRACT_POST_PROCESSOR`.
3. Update `docker-compose.yml` passthrough.
4. `docker compose build && docker compose down && docker compose up -d`
   (`applies: "recreate"` on the model list).
5. Verify `/console` Manage panel shows new keys + post-processor dropdown; any
   model-id `format` was coerced to `readability_to_markdown` (one-time warn);
   `web_search`/`web_fetch` unaffected.

## Testing

- Parse: `inputs` validation (valid set, unknown value dropped, default `["text"]`),
  per-entry `maxTokens`/`maxInputChars`/`timeoutMs` defaults + overrides,
  `DEFAULT_EXTRACT_POST_PROCESSOR` empty/unknown-id.
- Payload dispatch: `runPostProcessor` with `text` / `html` / `screenshot` →
  mock fetch asserts chat text content / chat text content / `image_url` content part.
- `extractWithApi` (custom API post-processor): mock fetch asserts correct method/path,
  body has the input at the `{{input}}` slot (incl. input containing quotes + newlines),
  `outputField` dotted lookup and `outputType: "text"` raw-body modes. Separate
  `extractWithMineru` test: POST `{ html }` → `/extract`, read `text` (unchanged today).
- Compatibility + failure fallback: extractor output type ∉ `inputs` → returns the input
  unchanged; model HTTP error → returns the input unchanged.
- Coercion: config/hint `format` naming a model id → `readability_to_markdown` + warn.
- End-result cache: web_fetch cache stores post-processed markdown; cache key differs for
  `postProcessor` set/unset; screenshot extractor result cached (no replay from HTML).
- Console: build bundle, verify extractor dropdown (no model ids, has `screenshot`),
  post-processor dropdowns, JSON editor.
- Live smoke: add OvisOCR2 entry to `.env` (`inputs: ["image","text"]`),
  `DEFAULT_EXTRACT_POST_PROCESSOR=ovis_ocr2` + `DEFAULT_EXTRACT_FORMAT=screenshot`,
  `web_fetch` the NSE option-chain page, compare tables output vs
  `readability_to_markdown` + wall time.

## Open Questions

1. ~~Module/function renames: full rename vs. minimal (file rename only, keep function
   names).~~ **RESOLVED — full rename, chosen in Phase 1; Phase 2 renames again to
   `POST_PROCESSOR_*` (`src/post-processor.js`, `runPostProcessor`,
   `getPostProcessorModels`).**
2. ~~What happens when a post-processor's `inputs` don't match the extractor output?~~
   **RESOLVED — runtime rule (point 7): console warn + return the extractor output
   unchanged. No parse-time coercion; the user fixes the config.**
3. ~~`AI_EXTRACTOR_INPUT` legacy single-model input selection?~~ **RESOLVED — the env var
   is dropped. The legacy single-model path (`AI_EXTRACTOR_BASE_URL` +
   `AI_EXTRACTOR_MODEL`) is **also dropped**, and the per-call limit vars
   (`AI_EXTRACTOR_TIMEOUT_MS`/`AI_EXTRACTOR_MAX_INPUT_CHARS`/`AI_EXTRACTOR_MAX_TOKENS`)
   move into the JSON entries — `POST_PROCESSOR_MODELS` is the only source. Existing
   configs migrate by moving the values into a chat entry.**
4. Screenshot capture settings: `fullPage: true` + JPEG quality 75 default, or PNG?
   OvisOCR2 was trained on document images; JPEG is fine and much smaller. Confirm during
   the NSE smoke test.
5. Block-level screenshot extraction (per-element cropping) — explicitly **out of scope
   for v1** (whole-page screenshot even for a block). Confirm that's acceptable.
6. Should the `text` post-processor input apply the per-entry `maxInputChars` tail-cut
   before sending? Recommend yes (mirrors the HTML path).

## Checklist

### Phase 1 — Rename `READER_LM_*` → `AI_EXTRACTOR_*` (done; superseded)

- [x] `src/config.js`: rename + `parseAiExtractorModels`, `readConfigEnv` legacy fallback
- [x] `src/config-schema.js`: rename keys (legacy names noted in descriptions)
- [x] `src/config-manager.js`: rename appliers (+ legacy aliases for hot apply)
- [x] `src/ai-extractor.js` (renamed from `src/reader-lm.js`): `getAiExtractorModels` / `getAiExtractorKind` / `isAiExtractorConfigured`
- [x] `src/search.js` + `src/mcp-server.js`: imports + config keys
- [x] `src/web-console/src/main.jsx`: group keys; console rebuilt
- [x] `.env` + `docker-compose.yml`
- [x] tests (config rename + fallback + module rename)
- [x] docs: AGENTS.md, README.md, plan 23 cross-refs

**Phase 2 renames this again to `POST_PROCESSOR_*`** (module → `src/post-processor.js`,
`runPostProcessor`, `getPostProcessorModels`, config key `postProcessorModels`, env
`POST_PROCESSOR_MODELS`) and removes the five per-call/legacy env vars.

### Phase 2 — Post-processor pipeline (done)

- [x] `src/config.js`: rename to `postProcessorModels`; `inputs` validation + per-kind fields (`api`: path/method/body/headers/outputField/outputType; `mineru` and `chat` unchanged) + per-entry `maxTokens`/`maxInputChars`/`timeoutMs`; `DEFAULT_EXTRACT_POST_PROCESSOR`; delete the legacy fallback + the 3 limit-var parses
- [x] `src/ai-extractor.js` → `src/post-processor.js`: `extractWithChatImage` (image) + `extractWithApi` (custom API, `{{input}}` body template, outputField/outputType); `extractWithMineru` + `extractWithChat` unchanged; exactly-one-payload `runPostProcessor`
- [x] `src/search.js`: post-processor hook after extractor in `renderLeafContent` + `extractTextFromHtml`; new `screenshot` format (capture in `browserOpenAndExtract` + flow `capturePageState`, thread down); model-format → `readability_to_markdown` coercion on load
- [x] `src/mcp-server.js`: end-result caching (delete `usesAiExtractor` skip + `cachedHtmlByUrl` replay); cache key includes effective extractor + post-processor; payload `aiModels` → `postProcessorModels`
- [x] `src/web-console/src/main.jsx`: extractor dropdown (no model ids, has `screenshot` label); post-processor dropdowns; group label → "Web Fetch Post-Processors"
- [x] `src/config-manager.js` + `src/config.js`: removed `config.aiExtractorModels` backward-compat alias
- [x] `src/domain-hints.js`: model-format coercion in `migrateHintShape` (default.format + block format)
- [x] `src/config.js`: `parseDefaultExtractFormat` coerces legacy model ids to `readability_to_markdown`
- [x] tests: `tests/post-processor.test.js` (29 tests: chat/mineru/api dispatch, interpolation, screenshot, concurrency, input validation); coercion tests in `config.test.js` + `domain-hints.test.js`; old `tests/ai-extractor.test.js` deleted
- [x] docs: AGENTS.md, README.md, `.env.example`, `.env.example.full`, `docs/navigator-mineru-sidecar.md`

### Phase 3 — Console structured editor for POST_PROCESSOR_MODELS (done)

Replace the generic JSON text input for `POST_PROCESSOR_MODELS` with a dedicated structured
editor. Also make `DEFAULT_EXTRACT_POST_PROCESSOR` a dropdown populated from the entered models.

#### POST_PROCESSOR_MODELS structured editor

A card-based UI where each card represents one post-processor model entry. Each card has
inline form fields — no raw JSON editing (the JSON pane is still available via a toggle).

**Per-card fields:**

| Field | UI control | Notes |
|---|---|---|
| `id` | text input | Required. Unique identifier, used as the value for `DEFAULT_EXTRACT_POST_PROCESSOR` and block `postProcessor`. |
| `label` | text input | Display name shown in dropdowns. |
| `model` | text input | Model name sent to the endpoint (chat) or informational (mineru/api). |
| `baseUrl` | text input | Base URL of the endpoint. |
| `kind` | select: `chat` · `mineru` · `api` | Controls which fields are visible below. |
| `inputs` | multi-checkbox: `html` · `text` · `image` | Default `["text"]`. Determines which payloads the model accepts (for dropdown labeling). |
| `prompt` | text input (optional) | Custom prompt for screenshot/image mode. |

**Kind-dependent fields** (shown/hidden based on `kind`):

| Kind | Extra fields |
|---|---|
| `chat` | `maxTokens` (number, default 8192), `maxInputChars` (number, default 60000), `timeoutMs` (number, default 60000) |
| `mineru` | `timeoutMs` (number, default 60000) |
| `api` | `path` (text, e.g. `/extract`), `method` (select: `POST` · `GET`), `body` (textarea — JSON template with `{{input}}`), `headers` (textarea — JSON object), `outputField` (text, dot-path like `result.text`), `outputType` (select: `json` · `text`), `timeoutMs` (number, default 60000) |

**Card actions:**
- **Add entry** button at the bottom of the list
- **Remove** button (×) on each card
- **Duplicate** button (⧉) on each card (copies all fields)
- Cards are reorderable via drag handle (future, not v1)

**Validation:**
- `id` is required and must be unique across entries
- `baseUrl` is required
- `kind` defaults to `chat`
- `body` in api kind must be valid JSON (or at least contain `{{input}}`)
- Validation errors show inline under the relevant field

**JSON toggle:** A "Show JSON" / "Show Form" toggle at the top of the section. In JSON
mode, the current generic textarea is shown (for power users / paste-from-clipboard). Switching
to form mode parses the JSON into cards. Switching back to JSON mode serializes cards → JSON.

**Implementation:**
- New component `PostProcessorModelsEditor` in `main.jsx`
- Receives `value` (JSON string), `onChange` (new JSON string), `ok`, `message`
- Parses JSON on mount and on external value changes; serializes on every card edit
- The `ValueControl` function in `main.jsx` gets a new special-case branch:
  `if (entry.key === "POST_PROCESSOR_MODELS") return <PostProcessorModelsEditor ... />`

#### DEFAULT_EXTRACT_POST_PROCESSOR dropdown

Currently a text input. Change to a **select dropdown** populated from the `postProcessorModels`
config array (which the Manage panel has access to as `config.postProcessorModels`).

**Options:**
- Empty string `""` — "None (no post-processor)"
- One option per entry in `config.postProcessorModels`: `{ value: entry.id, label: entry.label || entry.id }`

The dropdown is rebuilt on every render from the live config, so adding/removing entries in the
POST_PROCESSOR_MODELS editor above immediately updates the available options.

**Implementation:**
- New special-case branch in `ValueControl`:
  `if (entry.key === "DEFAULT_EXTRACT_POST_PROCESSOR") { ... }`
- Reads `config.postProcessorModels` (passed as a new prop to `ValueControl`, or accessed
  via the parent `Manage` component's `config` prop)
- Renders a `<select>` with the empty option + one per model

#### Files to change

| File | What |
|---|---|
| `src/web-console/src/main.jsx` | New `PostProcessorModelsEditor` component; `ValueControl` special cases for both keys; `Manage` passes `config.postProcessorModels` down |
| `src/web-console/src/main.jsx` | `DEFAULT_EXTRACT_POST_PROCESSOR` row in the config schema (already exists as a `type: "string"` entry) gets its `ValueControl` overridden |
| Console rebuild | `docker exec navigator npm run console:build` |

#### Open questions

1. Should the JSON toggle be per-entry or global? Recommend **global** (one toggle for the
   whole POST_PROCESSOR_MODELS section) — simpler, and power users paste entire arrays.
2. Should `body` in api kind get syntax highlighting or just a plain textarea? Recommend
   **plain textarea** for v1 — syntax highlighting requires a code editor dependency.
3. Should we validate `body` contains `{{input}}`? Yes — warn (not error) if `{{input}}` is
   missing, since the body will be sent as-is without any interpolation.

- [ ] live NSE smoke test with OvisOCR2 (`inputs: ["image","text"]`, `DEFAULT_EXTRACT_FORMAT=screenshot` + `DEFAULT_EXTRACT_POST_PROCESSOR=ovis_ocr2`)

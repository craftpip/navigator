# Plan 36: Docling as Independent Post-Processor (Sidecar) — like MinerU

**Date:** 2026-08-22
**Status:** Draft (revised — post-processor, not extractor)
**Author:** navigator planning
**Related:** Plan 28 (Extractor Refactor), Plan 31 (Trafilatura as extractor), Plan 22/23/25 (AI / MinerU HTML sidecar), `src/post-processor.js`, `src/extractors/index.js`, `docker/navigator-mineru/`
**Supersedes:** `plans/36_docling-extractor.md` (previous draft registered Docling as extractor formats)

---

## 1. Goal

Add **Docling** (IBM `docling` / `docling-serve`) as an **independent post-processor** — same lifecycle as `navigator-mineru`:

* Lives **outside** `navigator` code — own container `navigator-docling`, own image, own `sidecar.py`.
* Navigator never imports Docling. It talks HTTP only: `POST /extract {html} -> {text}`.
* If the sidecar is down / not configured, Navigator keeps working — post-processor call fails, `src/extractors/index.js:55-82` `applyPostProcessor()` keeps original extractor output and logs `console.warn` (existing MinerU parity).
* Configured via `POST_PROCESSOR_MODELS` with `kind: "docling"` — no hardcoded extractor format IDs, no `EXTRACTOR_FORMATS` pollution.

> MinerU pattern: `src/post-processor.js:289 TRANPORTS{mineru: extractWithMineru}` + `docker/navigator-mineru/` + `docker-compose.yml:navigator-mineru` + `POST_PROCESSOR_MODELS=[{id:"mineru",kind:"mineru",baseUrl:"http://navigator-mineru:1998"}]`. Docling copies this verbatim with `kind: "docling"`.

**Not an extractor method.** Do not register `docling_to_markdown` in `src/extractors/index.js` or `DEFAULT_FORMATS`. Extractor stays `readability_to_markdown` / `html_to_markdown` / `trafilatura_to_markdown` / `text` / `html` / `table*` / `screenshot`. Docling refines whatever the extractor produced — typically `html_to_markdown` or raw `html` — via `hint.default.postProcessor = "docling"`.

---

## 2. Why Post-Processor (Not Extractor)

| Question | Extractor (`format: docling_to_markdown`) | **Post-processor (`kind: docling`) — chosen** |
|---|---|---|
| Where does Docling live? | In-process thought — needs `src/extractors/docling.js` + registry + `FORMAT_EXTRACTORS` + console dropdowns + validation | **Outside** — `docker/navigator-docling/` only. Zero `src/extractors/` changes. |
| Coupling | Hardcodes 3-5 format IDs (`docling_to_*`) into `EXTRACTOR_FORMATS`, `domain-hints.js:322`, `main.jsx:2521` | **Zero coupling** — `POST_PROCESSOR_MODELS` is already dynamic (`src/config.js:464`, `src/post-processor.js:13` `getPostProcessorModels`). Adding a model is a `.env` JSON entry, no code deploy. |
| Reuse | One-shot: HTML -> markdown | **Composable:** any extractor output (`readability`, `html_to_markdown`, `text`, `html`) can pipe through Docling. MinerU already proves this: `src/extractors/index.js:74` passes `_rawHtml` when present so MinerU gets HTML, not fenced markdown. Docling reuses same `html` path. |
| Failure mode | Extractor `null` -> fallback to readability (`index.js:192`) — hides Docling failure | **Explicit:** `applyPostProcessor()` `try/catch` keeps original text and `console.warn("[web_fetch] [url] post-processor \"docling\" failed — keeping original")` (`index.js:79`). User sees extractor succeeded, post-processor degraded — clearer than silent fallback. |
| Parity | Diverges from MinerU (extractor vs post-processor) — two patterns to maintain | **Parity** — `mineru` and `docling` are both `kind` transports sharing `requestWithTimeout`, `postProcessorGate`, `truncateTail`/`MINERU_MAX_INPUT_CHARS` logic. One mental model. |

Docling's value (layout, `TableFormer v2`, OCR, reading order) applies regardless of which extractor ran first. Post-processor lets a hint say “extract with `html_to_markdown`, then let Docling restructure tables/OCR” without duplicating format IDs.

---

## 3. What We Ship — Post-Processor Methods

Not “formats” — **one `kind` with multiple `to_formats` selected per-request**:

| `kind` | `id` example | `baseUrl` | What it does |
|---|---|---|---|
| `docling` | `docling` | `http://navigator-docling:1999` | `POST /extract {html, to_format}` -> markdown/text/json/html/doctags. Default `to_format: md`. |

User config (`.env`):

```bash
POST_PROCESSOR_MODELS='[{"id":"docling","label":"Docling","model":"ds4sd/docling-models","baseUrl":"http://navigator-docling:1999","kind":"docling","timeoutMs":60000,"maxInputChars":400000}]'
```

Canonical per-hint usage — **HTML extractor + Docling post-processor** so Docling receives **HTML only** (not markdown/text):

```json
{
  "domain": "example.com",
  "pathPattern": "/reports/**",
  "comment": "HTML -> Docling: extractor emits _rawHtml, post-processor gets HTML only",
  "default": {
    "format": "html",
    "postProcessor": "docling"
  }
}
```

Why `format: "html"` — `src/extractors/html.js:32` returns `{ text: "```html\\n...```", _rawHtml: bestContainerHtml }`. `src/extractors/index.js:74` then does `ppInput = _rawHtml ? {html: _rawHtml} : {text}` so `src/post-processor.js:307` `runPostProcessor({html})` is called with **exactly one** `html` payload. `extractWithDocling` therefore always receives `html` (never fenced markdown). Any other extractor (`readability_to_markdown`, `html_to_markdown`, `text`) would hit the `text` branch and lose layout/TableFormer fidelity.

Flow block usage (same rule):

```json
{ "selector": "main article", "format": "html", "postProcessor": "docling" }
```

`block.postProcessor` is already validated at `src/domain-hints.js:438` — no schema change.

All Docling output variants (`md`/`text`/`json`/`html`/`doctags`) share one transport; `to_format` is an entry-level option (`entry.outputFormat || "plain_md"`), not a separate format ID.

---

## 4. Architecture — Mirrors `navigator-mineru`

```
                ┌─────────────────────────────────────────────┐
browser HTML ──▶│ extractors/index.js → extractor (e.g.       │──┐
                │  html_to_markdown → {text, _rawHtml})       │  │
                │  applyPostProcessor({html: _rawHtml,        │  │
                │   model:"docling"}) ──▶ post-processor.js   │  │
                │    TRANPORTS["docling"] → extractWithDocling│  │
                └─────────────────────────────────────────────┘  │
                             │ fetch POST /extract {html}       │
                             ▼                                  │
                ┌─────────────────────────┐                      │
                │ navigator-docling       │  keep original on    │
                │ FastAPI sidecar         │◀─┘ 5xx / timeout     │
                │ DocumentConverter       │   (warn, no throw)   │
                │ export_to_markdown/json │                      │
                └─────────────────────────┘                      │
```

* Navigator sidecar `navigator-docling` exposes:
  ```
  POST /extract  { "html": "<html>...", "to_format": "md"|"text"|"json"|"html"|"doctags" } -> { "text": "<markdown|json string>" }
  GET  /health   -> { "ok": true, "backend": "docling", "version": "...", "to_formats": [...] }
  ```
* Thin FastAPI wrapper around `docling.document_converter.DocumentConverter` (like `docker/navigator-mineru/sidecar.py:56` `make_config()` / `make_vllm()` / `make_transformers()`). CPU-only, no `runtime: nvidia`.
* Tail-cut at `DOCLING_MAX_INPUT_CHARS` (400k, same as `MINERU_MAX_INPUT_CHARS:3` in `src/post-processor.js`) — both navigator and sidecar enforce it.
* Concurrency gate: `DOCLING_GATE_CONCURRENCY` (default `2`, like MinerU `MINERU_GATE_CONCURRENCY:0` auto `2` for vllm). `DocumentConverter.convert()` is thread-safe for `SimplePipeline`; gate prevents RAM spikes.
* Fallback: transport throws -> `runPostProcessor()` -> `applyPostProcessor()` catch keeps original text (existing MinerU behavior `index.js:76`), never 500s the `web_fetch`.

---

## 5. Design

### 5.1 Service contract

```
POST /extract
  Request:  { "html": "<html>...", "to_format": "md"|"text"|"json"|"html"|"doctags", "do_ocr"?: bool, "do_table_structure"?: bool, "table_mode"?: "fast"|"accurate" }
  Response: { "text": "<string>" }      # markdown, text, html, JSON-stringified DoclingDocument, or doctags
  Errors:   4xx invalid body -> {error}, 5xx -> {error, text:""} — caller treats as null/throw and keeps original

GET /health
  Response: { "ok": bool, "backend": "docling", "version": "2.55.0", "to_formats": ["md","text","json","html","doctags"], "do_ocr": true }
```

Reuses `docker/navigator-mineru/sidecar.py:224 POST /extract` shape exactly so Navigator can share retry logic. Navigator sends `html` (raw `doc.documentElement.outerHTML` via `_rawHtml` when available at `index.js:74`, else truncated `text`). Sidecar does `asyncio.to_thread(_run_convert, html)` and `result.document.export_to_markdown()` / `export_to_text()` / `export_to_json()` / `export_to_html()` / `export_to_doctags()`.

### 5.2 Navigator integration — minimal, like MinerU

**1. `src/post-processor.js` — add `docling` kind (~35 lines, copy `extractWithMineru:172`):**

```js
const DOCLING_MAX_INPUT_CHARS = 400000;

async function extractWithDocling(entry, preparedHtml, config, debug, signal) {
  // preparedHtml is guaranteed HTML — caller is format:"html" + postProcessor:"docling"
  const url = `${entry.baseUrl}/extract`;
  const payload = { html: preparedHtml, to_format: entry.outputFormat || entry.toFormat || "md" };
  return requestWithTimeout(url, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload) },
    entry.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal, async (res) => {
      if (!res.ok) { const t = await res.text().catch(()=> ""); console.error(`[post-processor] docling request failed: ${res.status} ${t.slice(0,500)}`); throw new Error(`docling request failed: ${res.status} ${t.slice(0,500)}`); }
      const data = await res.json();
      const content = data?.text || data?.result || "";
      if (!content) throw new Error("empty docling response: no text in response");
      return content;
    });
}

const TRANSPORTS = { chat: extractWithChat, mineru: extractWithMineru, docling: extractWithDocling, api: extractWithApi };
```

and in `runPostProcessor:330` — **HTML-only gate** (enforce the `format:html` contract, fallback to HTML branch, use tail-cut like MinerU for tables at end):

```js
if (entry.kind === "docling") {
  // Canonical path is html — html extractor sets _rawHtml at html.js:32 and index.js:74 passes {html}
  // If html is missing (misconfigured hint), fall back to text but warn — Docling loses layout
  const raw = html != null ? String(html) : String(text ?? "");
  if (html == null && debug) console.warn(`[post-processor] docling got text input, expected html (use format:"html")`);
  const preparedHtml = raw.slice(0, entry.maxInputChars ?? DOCLING_MAX_INPUT_CHARS);
  return await transport(entry, preparedHtml, config, debug, signal);
}
```

`POST_PROCESSOR_KINDS:100` in `src/config.js` gains `"docling"`:

```js
const POST_PROCESSOR_KINDS = new Set(["chat", "mineru", "docling", "api"]);
```

No `src/extractors/index.js` change — `applyPostProcessor:53` already handles the single pipeline step (`_screenshotInput` vs `html`/`text`) and `src/extractors/index.js:74` already passes `_rawHtml` so Docling receives HTML, not fenced markdown.

**2. No extractor registry change.** `EXTRACTOR_FORMATS` (`index.js:48`), `domain-hints.js:316 BLOCK_FORMATS/DEFAULT_FORMATS`, `validateHintRule:733` all unchanged. `domain-hints.json` `default.format` stays `readability_to_markdown` etc.; only `default.postProcessor` points at Docling.

**3. Console.** No `DEFAULT_FORMATS` / `HINT_BLOCK_FORMATS` / `FORMAT_LABELS` edits in `src/web-console/src/main.jsx:2521` — Docling appears in the **Post-processor** dropdown, not Extractor. `POST_PROCESSOR_MODELS` entries with `kind: "docling"` already render there (like MinerU). Optional: add `FORMAT_LABELS` note for `docling` kind badge, not required.

### 5.3 Domain hints & validation

Already covered: `default.postProcessor` and `block.postProcessor` are optional strings validated at `domain-hints.js:438` and `validateDefault:732`. Wildcard hint (`domain: "*"`) can set `"postProcessor": "docling"` to make Docling the default refinement for all pages — auto-created by `ensureWildcardHint:135`.

### 5.4 Config — reuse existing `POST_PROCESSOR_MODELS`

No new `DOCLING_*` env parsing in `src/config.js:133 parsePostProcessorModels` — it already parses `POST_PROCESSOR_MODELS` JSON and `POST_PROCESSOR_KINDS`. Per-entry `timeoutMs`/`maxInputChars`/`outputFormat` are already parsed (`config.js:160`). Just add `outputFormat` passthrough if missing:

```js
outputFormat: typeof entry.outputFormat === "string" ? entry.outputFormat : typeof entry.toFormat === "string" ? entry.toFormat : undefined,
```

Sidecar tunables live in `docker-compose.yml` `environment:` under `DOCLING_*` prefix (like `MINERU_*` at `docker-compose.yml:132`).

---

## 6. Implementation Steps

### Step 1: Sidecar service — `docker/navigator-docling/` (independent, like `docker/navigator-mineru/`)

**New:** `docker/navigator-docling/Dockerfile` (~30 lines, mirrors `docker/navigator-mineru/Dockerfile:1`):

```dockerfile
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates libgl1 libglib2.0-0 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN pip install --no-cache-dir "docling==2.55.0" fastapi uvicorn python-multipart
# Optional bake for fast cold start (like mineru model bake at Dockerfile:24):
# RUN pip install huggingface_hub[cli] && huggingface-cli download ds4sd/docling-models --local-dir /app/model
COPY sidecar.py /app/sidecar.py
EXPOSE 1999
CMD ["uvicorn", "sidecar:app", "--host", "0.0.0.0", "--port", "1999"]
```

**New:** `docker/navigator-docling/sidecar.py` (~130 lines, structure copied from `docker/navigator-mineru/sidecar.py:1`):

* Env: `DOCLING_PORT=1999`, `DOCLING_MAX_INPUT_CHARS=400000`, `DOCLING_GATE_CONCURRENCY=2` (auto `2`), `DOCLING_TABLE_MODE=fast`, `DOCLING_DO_OCR=1`, `DOCLING_DO_TABLE_STRUCTURE=1`, `DOCLING_OUTPUT_FORMAT=plain_md`.
* `DocumentConverter` singleton at import (like `init():161` in mineru sidecar) — `StandardPdfPipeline` defaults, `do_ocr`, `do_table_structure`, `table_mode`. Lazy init with `asyncio.Semaphore`.
* `def _run_convert(html: str, to_format: str) -> str:` — `io.BytesIO(html.encode())` -> `converter.convert(source)` -> `result.document.export_to_markdown()` / `export_to_text()` / `export_to_dict()` (then `json.dumps`) / `export_to_html()` / `export_to_doctags()` via `asyncio.to_thread`.
* `GET /health` and `POST /extract` handlers identical shape to `sidecar.py:211` / `sidecar.py:224`.

Alternative with zero custom code: `FROM quay.io/docling-project/docling-serve:latest` and add a tiny `POST /extract` shim that translates `{html}` -> multipart `POST /v1/convert/file` (`files={"files": ("input.html", html, "text/html")}`, `data={"parameters": json.dumps({"to_formats":[to_format]})}`). Custom `sidecar.py` is simpler (direct `DocumentConverter` call, no multipart).

**Modify:** `docker-compose.yml` — add service (mirrors `navigator-mineru:118`):

```yaml
navigator-docling:
  container_name: navigator-docling
  image: navigator-docling:latest
  restart: unless-stopped
  build: { context: ./docker/navigator-docling, dockerfile: Dockerfile }
  shm_size: "1gb"
  environment:
    DOCLING_PORT: ${DOCLING_PORT:-1999}
    DOCLING_MAX_INPUT_CHARS: ${DOCLING_MAX_INPUT_CHARS:-400000}
    DOCLING_GATE_CONCURRENCY: ${DOCLING_GATE_CONCURRENCY:-2}
    DOCLING_TABLE_MODE: ${DOCLING_TABLE_MODE:-fast}
    DOCLING_DO_OCR: ${DOCLING_DO_OCR:-1}
    DOCLING_DO_TABLE_STRUCTURE: ${DOCLING_DO_TABLE_STRUCTURE:-1}
    DOCLING_OUTPUT_FORMAT: ${DOCLING_OUTPUT_FORMAT:-plain_md}
  deploy: { resources: { limits: { memory: ${DOCLING_MEM_LIMIT:-2g} } } }
  ports: ["${DOCLING_PORT:-1999}:1999"]
  # volumes: ["docling_cache:/app/.cache"]  # optional cache volume (like chrome_profile_data:180)
```

Add `docling_cache:` volume at bottom if baking is skipped (first `convert()` downloads ~1GB to `/app/.cache`). No `runtime: nvidia` (CPU only, unlike mineru `runtime: nvidia:124`).

### Step 2: Navigator — 2-file change (like MinerU)

**Modify:** `src/config.js:100` — add `"docling"` to `POST_PROCESSOR_KINDS`:

```js
const POST_PROCESSOR_KINDS = new Set(["chat", "mineru", "docling", "api"]);
```

and in `parsePostProcessorModels:154` expose `outputFormat`/`toFormat`:

```js
outputFormat: typeof entry.outputFormat === "string" ? entry.outputFormat : typeof entry.toFormat === "string" ? entry.toFormat : undefined,
```

**Modify:** `src/post-processor.js` — add `extractWithDocling` (~35 lines) and register in `TRANSPORTS:289` + branch in `runPostProcessor:330` (see §5.2). Reuse `requestWithTimeout:101`, `DEFAULT_TIMEOUT_MS:6`, `postProcessorGate:32` (gate already serializes Docling + MinerU + chat together — correct, since all hit external endpoints).

No `src/extractors/index.js`, `src/domain-hints.js`, `src/web-console/src/main.jsx` extractor-list changes.

**Modify:** `.env.example` / `.env.example.full` — document post-processor entry + sidecar env (like `POST_PROCESSOR_MODELS` docs at `README.md:419` and `docker-compose.yml:94`):

```bash
# Docling post-processor (independent sidecar, like MinerU) — leave POST_PROCESSOR_MODELS empty to disable
POST_PROCESSOR_MODELS='[{"id":"docling","label":"Docling","model":"ds4sd/docling-models","baseUrl":"http://navigator-docling:1999","kind":"docling","timeoutMs":60000,"maxInputChars":400000}]'
DOCLING_PORT=1999
DOCLING_MAX_INPUT_CHARS=400000
DOCLING_GATE_CONCURRENCY=2
DOCLING_TABLE_MODE=fast
DOCLING_DO_OCR=1
DOCLING_DO_TABLE_STRUCTURE=1
DOCLING_MEM_LIMIT=2g
```

### Step 3: Docs — mark as post-processor method

**Modify:** `docs/guides/extraction/ai-extractors.md` / `docs/guides/extraction/mineru.md` — add Docling section (post-processor table, not extractor table). Or new `docs/guides/extraction/docling.md` mirroring `docs/extraction/navigator-mineru-sidecar.md`.

**Modify:** `docs/guides/extraction/formats.md:189` “AI Model Extractors” — note that `kind: "docling"` and `kind: "mineru"` are post-processors configured via `POST_PROCESSOR_MODELS`, not `format` values. Keep extractor table unchanged (9 formats).

**Modify:** `README.md:419` `POST_PROCESSOR_MODELS` doc — add `kind: "docling"` to the `kind` enum (`"chat" | "mineru" | "docling" | "api"`).

### Step 4: Tests

**New:** `tests/docling-post-processor.test.js` (~60 lines, mirrors MinerU post-processor tests):

1. `extractWithDocling` sends correct `to_format` and parses `{text}`.
2. Empty / 5xx response throws -> `runPostProcessor` rejects -> `applyPostProcessor` keeps original (warn).
3. `POST_PROCESSOR_KINDS` includes `docling`, `parsePostProcessorModels` accepts `kind:"docling"`.

Live test (requires sidecar): `DOCLING_BASE_URL=http://localhost:1999 vitest run tests/docling-post-processor-live.test.js` (optional, like `domain-hints-live.test.js`).

### Step 5: Deploy & verify — HTML + Docling path

```bash
docker compose build navigator-docling && docker compose up -d
curl http://localhost:1999/health
# configure .env with POST_PROCESSOR_MODELS docling entry, then:
docker compose up -d navigator
# canonical: format html -> docling gets HTML only (not markdown)
curl -s "http://localhost:3000/extract?url=https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population&hint=%7B%22default%22%3A%7B%22format%22%3A%22html%22%2C%22postProcessor%22%3A%22docling%22%7D%7D" | head -60
# same URL without postProcessor — shows html extractor output (```html fence) for comparison
curl -s "http://localhost:3000/extract?url=https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population&hint=%7B%22default%22%3A%7B%22format%22%3A%22html%22%7D%7D" | head -40
# stop sidecar — request still succeeds with original html extractor output + warn in logs
docker compose stop navigator-docling
curl -s "http://localhost:3000/extract?url=https://example.com&hint=%7B%22default%22%3A%7B%22format%22%3A%22html%22%2C%22postProcessor%22%3A%22docling%22%7D%7D" | head -20
# verify runPostProcessor input kind in logs: should log "input=html" at post-processor.js:320
```

---

## 7. File Changes Summary

| File | Action | Lines | What |
|------|--------|-------|------|
| `docker/navigator-docling/Dockerfile` | **Create** | ~30 | `python:3.11-slim` + `docling` + `fastapi`/`uvicorn` |
| `docker/navigator-docling/sidecar.py` | **Create** | ~130 | FastAPI `POST /extract` + `GET /health`, `DocumentConverter`, gate, tail-cut |
| `docker-compose.yml` | Modify | +22 | Add `navigator-docling` service (no `runtime: nvidia`) + optional `docling_cache` volume |
| `src/config.js` | Modify | +3 | `POST_PROCESSOR_KINDS` add `"docling"`, expose `outputFormat` in `parsePostProcessorModels` |
| `src/post-processor.js` | Modify | +40 | `extractWithDocling`, `DOCLING_MAX_INPUT_CHARS`, `TRANSPORTS.docling`, branch in `runPostProcessor` |
| `.env.example` | Modify | +8 | `POST_PROCESSOR_MODELS` docling example + `DOCLING_*` sidecar vars |
| `docs/guides/extraction/docling.md` | **Create** | ~70 | Post-processor guide (like `mineru.md`) |
| `docs/guides/extraction/formats.md` | Modify | +5 | Note `kind: docling` in AI Model Extractors section (no extractor table change) |
| `README.md` | Modify | +1 | `kind` enum add `"docling"` at `419` |
| `tests/docling-post-processor.test.js` | **Create** | ~60 | Unit tests (no sidecar required) |

**Total:** 3 new files, 5 modified files. **Zero** `src/extractors/` changes — extractor methods unchanged (9 formats remain).

---

## 8. Config Reference

| Env | Default | Where | Description |
|-----|---------|-------|-------------|
| `POST_PROCESSOR_MODELS` | `[]` | `navigator` | JSON array — add `{"id":"docling","kind":"docling","baseUrl":"http://navigator-docling:1999"}`. Per-entry `timeoutMs`, `maxInputChars`, `outputFormat` override defaults (like MinerU `entry.timeoutMs:154`) |
| `DOCLING_PORT` | `1999` | `navigator-docling` | Sidecar listen port |
| `DOCLING_MAX_INPUT_CHARS` | `400000` | `navigator-docling` | Tail-cut HTML (both sides) |
| `DOCLING_GATE_CONCURRENCY` | `2` | `navigator-docling` | Max concurrent `/extract` |
| `DOCLING_TABLE_MODE` | `fast` | `navigator-docling` | `fast` vs `accurate` TableFormer |
| `DOCLING_DO_OCR` | `1` | `navigator-docling` | OCR for scanned content |
| `DOCLING_DO_TABLE_STRUCTURE` | `1` | `navigator-docling` | Table structure |
| `DOCLING_MEM_LIMIT` | `2g` | compose | Memory limit |

Navigator `docling` post-processor reuses `DEFAULT_TIMEOUT_MS:60000` and `DEFAULT_MAX_INPUT_CHARS:60000` truncations in `src/post-processor.js:4-6` unless entry overrides — same as `mineru`/`chat`.

---

## 9. Alternatives & Why Not Extractor

* **Extractor `docling_to_markdown`** (previous draft) — would hardcode format IDs into `EXTRACTOR_FORMATS:48` / `domain-hints.js:316` / `main.jsx:2521`, require console + validation deploys for every new `to_format`, and diverge from MinerU pattern. Post-processor keeps Docling independent: add a model entry, no Navigator code deploy for new output types.
* **Reuse `quay.io/docling-project/docling-serve` directly** — viable, but its API is multipart `POST /v1/convert/file` (`files` + `parameters` JSON, `file_sources` base64). Custom `sidecar.py` with `DocumentConverter` direct call is simpler and matches `navigator-mineru/sidecar.py:224` JSON contract.
* **In-process `child_process.spawn`** — rejected (model load per request, no gate, RAM spikes).

---

## 10. Verification — HTML-only Docling path

1. `node -c src/post-processor.js && node -c src/config.js`
2. `docker exec navigator npx vitest run` — existing tests pass (no extractor registry change)
3. `curl http://localhost:1999/health` -> `{"ok":true,"backend":"docling"}`
4. `hint={"default":{"format":"html","postProcessor":"docling"}}` -> `runPostProcessor` logs `input=html` at `post-processor.js:320`, sidecar receives `{html, to_format:"md"}`, response is Docling-refined markdown (tables as markdown, reading order preserved) — intermediately `html.js:32` `_rawHtml` is `bestContainerHtml` innerHTML, `index.js:74` passes `{html: _rawHtml}`
5. `hint={"default":{"format":"html"}}` (no postProcessor) -> baseline is ` ```html` fence from `html.js:30` — Docling not invoked
6. Misconfigured `hint={"default":{"format":"readability_to_markdown","postProcessor":"docling"}}` -> `text` branch, `debug` warns `docling got text input, expected html` — still works but loses TableFormer fidelity (table in verification)
7. Stop `navigator-docling` -> same `html`+`docling` request still returns ` ```html` fallback + `console.warn` in `docker logs navigator`, no 500 to user
8. Console -> Manage shows `POST_PROCESSOR_MODELS` with `docling` kind; Domain hints -> Post-processor dropdown shows `docling`; Extractor dropdown stays 9 formats

---

## 11. Risks & Mitigations

* **First-request model download** (~1GB) adds latency. Mitigate: optional bake `huggingface-cli download ds4sd/docling-models` in `Dockerfile:24` (like MinerU model bake), or warm `DocumentConverter` at container start (`init():161`).
* **RAM** — layout + TableFormer spikes on huge HTML. Mitigated by `DOCLING_MAX_INPUT_CHARS` tail-cut + gate `2` + `2g` limit.
* **HTML vs PDF semantics** — Docling shines on PDFs; on simple HTML the delta over `readability`/`trafilatura` is smaller. Mitigate: benchmark table-heavy HTML before making `docling` the wildcard `postProcessor`.

---

## 12. What NOT To Do (v1)

* Do not register `docling_to_*` in `src/extractors/index.js` — extractor methods stay 9.
* Do not make wildcard hint default `postProcessor: "docling"` — start per-domain.
* Do not add auth/billing to sidecar — in-compose only (`http://navigator-docling:1999`).
* Do not implement `HybridChunker` / `POST /chunk` v1 — `POST /extract` covers the post-processor contract; chunking is a later endpoint.

---

## 13. Future

1. `outputFormat: "json"` / `"doctags"` per-entry support (already passthrough — just document it).
2. `HybridChunker` endpoint `POST /chunk` for RAG (token-windowed chunks, table preservation).
3. Confidence/layout metadata in `web_fetch` response (like trafilatura `confidence` line).
4. Benchmark: `readability` / `trafilatura` / `html_to_markdown + docling` on 20 URLs (article, table, scanned).

---

## 14. History & Numbering

* `plans/36_docling-extractor.md` — superseded extractor-method draft (kept for reference, do not delete).
* `plans/36_docling-post-processor.md` — **current** (post-processor, independent sidecar like MinerU).
* Next plan: **37**.

When implemented, archive both to `plans/archive/` and absorb notes into `AGENTS.md` + `docs/guides/extraction/docling.md`.

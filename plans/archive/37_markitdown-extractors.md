# 37 — MarkItDown as Extractor Methods

**Status:** Draft (planning)
**Date:** 2026-08-22
**Author:** navigator agent
**Related:** `src/extractors/*`, `src/domain-hints.js`, `src/search.js:extractTextFromHtml`, `src/post-processor.js`, `src/config.js`, `docker-compose.yml`, `plans/22_jina-reader-lm-extractor.md`, `plans/25_generalize-ai-extractor-models.md`, `plans/31_trafilatura-extractor.md`

---

## 1. Problem & Motivation

Navigator has 7 extractor families today (`readability_to_markdown`, `html_to_markdown`, `text`, `html`, `table`/`table_json`/`table_csv`, `trafilatura_to_markdown`, `screenshot`) plus generic post-processors (`chat`/`mineru`/`api`). All of them assume **HTML → JSDOM → text**. Binary documents are uncovered:

* A `web_fetch` for `https://example.com/report.pdf` goes through `page.goto()` → browser renders Chrome's PDF viewer HTML → extractors see viewer chrome, not document content → empty or garbage output. Same for `.docx`, `.pptx`, `.xlsx`, `.epub`.
* Users working with filings, papers, slide decks, spreadsheets, and scanned PDFs currently need an external pipeline (download → local `markitdown` → feed text). Navigator should be the pipeline.
* MarkItDown ([microsoft/markitdown](https://github.com/microsoft/markitdown), MIT, 175k★, Python 3.10+, `markitdown[all]`) is the de-facto LLM-friendly converter for these formats: PDF, DOCX, PPTX, XLSX/XLS, HTML, CSV/JSON/XML, ZIP, EPUB, images (EXIF+OCR), audio transcription, YouTube transcripts. It preserves headings/lists/tables/links as Markdown.

**Goal phrase:** "mark it down as extractors Methods" = expose MarkItDown's converters as first-class extractor methods selectable in `domain-hints.json` (`default.format` and per-block `format`) and via `?hint=` overrides, just like `readability_to_markdown` or `trafilatura_to_markdown`.

---

## 2. What "Methods" (plural) Means

MarkItDown auto-detects file type, but navigator's extractor UX is **one format ID per menu entry**. The design should expose:

| Format ID | Meaning | Underlying MarkItDown call |
|-----------|---------|----------------------------|
| `markitdown` | Auto — delegates to `MarkItDown.convert()` / `convert_stream()` with mime sniffing | `md.convert_stream(stream, file_extension=...)` |
| _(optional)_ `markitdown_pdf`, `markitdown_docx`, `markitdown_pptx`, `markitdown_xlsx` | Explicit — forces converter, useful for docs/confluence where URL lacks extension or content-type is wrong | Same, but `file_extension` pinned |

**Recommendation:** Ship `markitdown` only in v1 (auto). Keep the registry able to add explicit variants later without breaking hints — they would just be aliases to the same module with a `context.format` switch, mirroring `src/extractors/table.js` (`FORMATS = ["table", ...]`).

Open question for review: whether to ship the explicit variants in v1 or defer. This plan describes the auto variant and notes the alias path.

---

## 3. Current Extractor Architecture (where to plug in)

```
src/extractors/index.js
  FORMAT_EXTRACTORS: Map<formatId, extract(doc, context) → result|null>
  extractTextFromHtml({ html, url, maxChars, hint, browserText, screenshot, ... })
    0. parseHtmlToDom → resolveRelativeUrls → applySkipSelectors
    1. hint.content.blocks? → renderContentBlocks (early return)
    2. resolve pageFormat = hint.default.format || "readability_to_markdown"
    3. dispatch FORMAT_EXTRACTORS.get(pageFormat)
    4. fallback chain: readability → catch-all body text
    5. applyPostProcessor (text/html/screenshot)
```

Flow extraction (`src/search.js:renderContentBlocks`, `executeFlow`) also dispatches per-block `block.format` through the same registry (via `renderLeafContent` → `FORMAT_EXTRACTORS`). Block-level post-processor runs as step 5b.

Key invariants to preserve:

* Cache key for `web_fetch` is `excludeMaxChars(getCacheArgs(args))` — `format` is read-time, cache is format-agnostic. New format must not add cache args.
* `browserOpenAndExtract()` (`src/search.js:2046`) is the only caller of `extractTextFromHtml`. Binary handling will need to branch **before** `page.content()` or add a parallel `fetchBytes → convert` path.
* Validation lives in `src/domain-hints.js:validateDefault`, `validateBlock` via `DEFAULT_FORMATS` / `BLOCK_FORMATS` derived from `EXTRACTOR_FORMATS`. Adding a format automatically makes it valid in hints and the console dropdowns (no separate console change needed beyond the label).
* Post-processor runs after extractor; `html` extractor sets `_rawHtml` so post-processor can receive clean HTML. MarkItDown produces markdown; no `_rawHtml` needed.

---

## 4. Design — Two Integration Layers

### 4.1 Layer A: HTML pages via MarkItDown (extractor drop-in)

For `default.format = "markitdown"` on HTML pages, the extractor receives the same `doc` (JSDOM) that readability/html_to_markdown receive today. Simplest impl reuses the doc's HTML:

```js
// src/extractors/markitdown.js
export const FORMAT = "markitdown";
export const FORMATS = ["markitdown"]; // + explicit aliases later
export async function extract(doc, context) {
  const html = doc.documentElement.outerHTML;
  return callMarkitdown({ bytes: html, mime: "text/html", url, maxChars });
}
```

This covers the 80% case (news/article HTML that readability struggles with) and requires no fetch-path changes.

### 4.2 Layer B: Binary documents via MarkItDown (fetch-path branch)

For URLs that return non-HTML (`content-type: application/pdf`, `application/vnd.openxmlformats-officedocument.*`, etc.) or file extensions `.pdf/.docx/.pptx/.xlsx/.epub/.csv`, `browserOpenAndExtract` should **not** do `page.goto` → DOM extraction. Instead:

```
detectBinary(url, responseHeaders)  // HEAD or peek, or extension heuristic
  → fetch raw bytes (outside browser, via fetch() or page.request)
  → callMarkitdown({ bytes, mime, url, maxChars })
  → return { title, url, text, links?, warnings? }
```

Two sub-options for fetching bytes:

* **(B1) Use browser response buffer:** `page.goto()` already fetches; for PDFs the browser's `page.content()` is viewer HTML, but `page.evaluate(() => fetch(url).then(r=>r.arrayBuffer()))` or CDP `Network.getResponseBody` can get raw bytes. Keeps auth/cookies of the browser session (important for authenticated docs behind login).
* **(B2) Direct Node `fetch(url)`:** Simpler, but loses browser session. Could be fallback when B1 fails.

**Recommendation:** B1 primary (in-browser fetch to preserve session), B2 fallback. Gate with `acceptBinary: true` hint flag or content-type sniff.

Content-type / extension detection should be lenient: many servers send `application/octet-stream` for PDFs. Check both `content-type` header and URL extension (`.pdf`, `.docx`, `.pptx`, `.xlsx`, `.xls`, `.epub`, `.csv`).

Links/tables extraction: MarkItDown's markdown output already linearizes tables as markdown tables; link extraction (`extractLinksFromHtml`) doesn't apply to binary bytes. For PDFs with hyperlinks, MarkItDown preserves `[text](url)` in markdown — no extra link index needed. `seo` snapshot similarly not applicable — return `seo: null` for binary path.

---

## 5. Execution Model — Python in a Node Service

MarkItDown is Python. Navigator is Node/ESM in Docker. Three viable transports (in order of recommendation):

| Option | How it works | Pros | Cons |
|--------|--------------|------|------|
| **P1 — Sidecar HTTP service** (recommended) | `docker/navigator-markitdown/` runs `python -m markitdown --port 8001` or a tiny FastAPI wrapper exposing `POST /convert` `{ bytes_b64, mime, url } → { markdown }`. Node calls via `fetch()` with timeout, retries, concurrency gate. Mirrors `docker/navigator-mineru` pattern (`kind: "mineru"` → `POST <baseUrl>/extract`). | Isolated deps, no Node→Python subprocess churn, warm process, healthcheck, scales like mineru, composable in `docker-compose.yml`. | Extra container, image size (~400MB with `markitdown[all]`). |
| **P2 — Subprocess per request** | `child_process.spawn("markitdown", [tmpfile])` or `python -c "from markitdown import MarkItDown; ..."` with stdin/stdout. | No extra container, simpler deploy. | Cold start per request (1–2s), `tmpfile` I/O churn, needs `python` + `markitdown[all]` baked into `navigator` image (bloats it), harder concurrency control, security (sanitize inputs per MarkItDown security notes). |
| **P3 — Node wrapper / re-implementation** | Rewrite converters in JS or call `pandoc`/`mammoth`/`pdfjs` equivalents. | No Python. | Reimplements MarkItDown poorly; loses its table/structure logic and plugin system. Rejected. |

**Recommendation:** P1 — sidecar HTTP. Reuse the post-processor transport pattern (`src/post-processor.js:requestWithTimeout`, `PostProcessorGate`) rather than inventing new plumbing. Two integration styles:

* **As extractor transport** (preferred): `src/extractors/markitdown.js` owns its own HTTP client (like `trafilatura.js` owns `extractFn`). Config is `MARKITDOWN_BASE_URL` / `MARKITDOWN_TIMEOUT_MS`, not `POST_PROCESSOR_MODELS`. This keeps it an extractor, not a post-processor.
* **As post-processor kind** (alternative): Add `kind: "markitdown"` to `POST_PROCESSOR_MODELS`. Cleaner if users already configure post-processors, but conflates extraction vs post-processing. MarkItDown is an extractor, not a refiner of extractor output.

This plan recommends **extractor transport** with its own config. If the team prefers reuse, the `kind: "markitdown"` path is a one-line variant (add entry to `TRANSPORTS` in `post-processor.js`).

Security (per MarkItDown docs): it performs I/O with process privileges. The sidecar must sanitize inputs: restrict to `convert_stream`/`convert_bytes` (no `convert(url)` that fetches arbitrary SSRF targets), limit `maxChars`, set request size caps (`MAX_HTTP_BODY_BYTES`-style), and run with no network egress except the Node caller.

---

## 6. Proposed Changes (file-by-file)

### 6.1 New file `src/extractors/markitdown.js`

```js
export const FORMAT = "markitdown";
export const FORMATS = ["markitdown"]; // add aliases later: "markitdown_pdf", ...
let _client = null; // lazy init via loadConfig()->markitdownBaseUrl

export async function extract(doc, context) {
  // Layer A: HTML → MarkItDown
  const html = doc.documentElement.outerHTML;
  const markdown = await callMarkitdown({ bytes: html, mime: "text/html", url: context.url, maxChars: context.maxChars, signal: context.signal });
  // Layer B is handled in search.js before calling this; this file only needs Layer A.
  // But also support context._rawBytes / context._mime when called from binary path.
}

async function callMarkitdown({ bytes, mime, url, maxChars, signal }) { ... }
```

Contract follows `src/extractors/index.js:14` — `(doc, context) → { title, url, text, textOriginalLength } | null`. On failure or empty output, return `null` so orchestrator falls back to `readability`. On 429/5xx from sidecar, throw with `readableErrorMessage` so `browserOpenAndExtract` can record `engineAttempt`-style telemetry if desired.

Include `PostProcessorGate`-like concurrency (2) and `requestWithTimeout` (default 30s for HTML, 60s for PDF). Truncate `markdown` via `safeTruncateText`.

### 6.2 `src/extractors/index.js`

* Import `* as markitdown from "./markitdown.js"`.
* Register: `FORMAT_EXTRACTORS.set(markitdown.FORMAT, markitdown.extract)` and loop over `markitdown.FORMATS`.
* Exports `EXTRACTOR_FORMATS` automatically includes new IDs → `domain-hints.js` validation picks them up.

### 6.3 `src/domain-hints.js`

No code change required if `EXTRACTOR_FORMATS` includes `markitdown` — `DEFAULT_FORMATS` and `BLOCK_FORMATS` derive from it (`src/domain-hints.js:317-322`). Verify:

```js
export const BLOCK_FORMATS = ["text","list", ...EXTRACTOR_FORMATS.filter(f=>f!=="text")]; // will include markitdown
```

Optional: add `markitdown` to `FIELD_FORMATS` if record-level fields should support it (currently `FIELD_FORMATS` is `["text","list","markdown","html","html_to_markdown","readability_to_markdown"]`). Likely **not** needed — fields are leaf HTML fragments; `markitdown` on a fragment is overkill.

Consider `validateHintRule` hint: warn when `markitdown` is used with `screenshot` blocks in same flow (no-op).

### 6.4 `src/search.js`

Add binary branch in `browserOpenAndExtract()` before the `page.goto` → DOM path:

```js
// New helper: isBinaryUrl / isBinaryContentType
const BINARY_MIME_RE = /^(application\/pdf|application\/vnd\.openxmlformats|application\/msword|application\/vnd\.ms-excel|application\/epub\+zip|text\/csv)/i;
const BINARY_EXT_RE = /\.(pdf|docx|pptx|xlsx|xls|epub|csv)(\?|#|$)/i;

async function fetchAsBytes(page, url, signal) {
  // Try in-browser fetch (preserves cookies) → fallback to Node fetch
}
```

Flow:

```
if (BINARY_EXT_RE.test(url) || hint?.default?.format === "markitdown") {
  // Probe without committing to browser navigation: try HEAD via fetch
  // If binary confirmed → fetchAsBytes → callMarkitdownBinary → return result
  // Else fall through to normal page.goto HTML path
}
```

For binary path, fabricate `doc` is unnecessary — call `markitdown.extract` with a synthetic doc or call sidecar directly. Simpler: new helper `extractBinaryViaMarkitdown({ bytes, mime, url, maxChars, signal })` that bypasses `extractTextFromHtml`.

Include SEO/link handling: binary result has no `seoSnapshot`; set `seo: null`, `links: []` or parse markdown links if `enableLinkRefs`.

### 6.5 `src/config.js` + `src/config-schema.js` + `src/post-processor.js` — post-processor kind

Per owner decision, MarkItDown is a **sidecar post-processor** (`kind: "markitdown"`) reused via `POST_PROCESSOR_MODELS`, not a standalone `MARKITDOWN_*` extractor. HTML is the primary input (core deps only — `beautifulsoup4`/`markdownify`, no `[pdf]`/`[docx]` needed). Binary is opt-in later.

Add to `src/post-processor.js:289`:
```js
const TRANSPORTS = { chat: extractWithChat, mineru: extractWithMineru, api: extractWithApi, markitdown: extractWithMarkitdown };
async function extractWithMarkitdown(entry, preparedHtml, config, debug, signal) {
  const url = `${entry.baseUrl}/convert`; // sidecar POST { html, url }
  return requestWithTimeout(url, { method:"POST", headers:{...}, body: JSON.stringify({ html: preparedHtml, url }) }, entry.timeoutMs ?? 60000, signal, ...);
}
```

Update `src/config.js:100`:
```js
const POST_PROCESSOR_KINDS = new Set(["chat", "mineru", "api", "markitdown"]);
```
`loadConfig()`/`parsePostProcessorModels` already handles `kind` passthrough — no new env. Example:
```json
POST_PROCESSOR_MODELS=[{"id":"markitdown","label":"MarkItDown","model":"markitdown","baseUrl":"http://markitdown:8001","kind":"markitdown","timeoutMs":60000,"maxInputChars":400000}]
```

Usage in hints: `default: { format: "html", postProcessor: "markitdown" }` or block `postProcessor: "markitdown"` — extractor keeps `_rawHtml` (`src/extractors/html.js:32`), post-processor receives `{ html, model: "markitdown" }`. For HTML-only, set `format: "html"` so raw HTML is preserved; `readability_to_markdown` would strip before markitdown sees it.

`src/config-schema.js` description for `POST_PROCESSOR_MODELS` amended to list `markitdown` kind (POST `{html}` to `baseUrl/convert`, HTML→markdown, no LLM).

### 6.6 `docker-compose.yml` + `docker/navigator-markitdown/`

Mirror `docker/navigator-mineru` structure:

```
docker/navigator-markitdown/
  Dockerfile      # FROM python:3.12-slim, pip install 'markitdown[all]', copy app.py
  app.py          # FastAPI: POST /convert, POST /extract (compat), GET /health
  requirements.txt
```

`compose` service:

```yaml
markitdown:
  build: ./docker/navigator-markitdown
  container_name: navigator-markitdown
  restart: unless-stopped
  ports: ["8001:8001"] # internal only, not host-published by default
  environment:
    MARKITDOWN_PORT: 8001
  deploy:
    resources: { limits: { cpus: "1.0", memory: 1g } }
```

`navigator` service gets `MARKITDOWN_BASE_URL: http://markitdown:8001` and `depends_on: markitdown` (condition: service_healthy).

Size note: `markitdown[all]` pulls `pdfminer`, `mammoth`, `python-pptx`, `openpyxl`, `beautifulsoup4`, etc. Expect ~500MB image. Consider `markitdown[pdf,docx,pptx,xlsx]` slim variant if `epub`/`audio` not needed. Tradeoff: fewer deps = smaller image, but loses format coverage. Start with `all`, trim after measuring.

### 6.7 Console (`src/web-console/...`)

No code change if using derived `EXTRACTOR_FORMATS` — dropdowns in `main.jsx` read `DEFAULT_FORMATS` / `BLOCK_FORMATS` from `GET /console/api/hints/validate` which reflects the registry. Verify label rendering: `markitdown` should display as `MarkItDown (auto)` with tooltip listing supported inputs (PDF, Office, HTML, etc.). If explicit aliases added, they appear as separate options.

Optional polish: add a docs callout in the hints panel: "MarkItDown handles binary docs — use for PDF/Office URLs. For HTML, it's an alternative to Readability/Trafilatura."

### 6.8 `src/mcp-server.js` — `/extract` endpoint

`/extract?url=...&hint=...` already calls `browserOpenAndExtract`. Binary routing must work there too so the Test pane can exercise `markitdown`. No extra endpoint needed.

---

## 7. Validation & Error Handling

* **Sidecar down / not configured:** `markitdown.extract` returns `null` (soft fallback) + `console.warn` — never throws hard. `extractTextFromHtml` fallback chain then tries readability → body text. This matches `trafilatura.js` native-module-missing behavior (`return null`).
* **Binary fetch fails:** throw `WebFetchTimeoutError` or readable error; `browserOpenAndExtract` records it via `recordPageOp(..., ok:false)` and surfaces as `error` in MCP response (like bot challenge).
* **MarkItDown empty output:** e.g. scanned PDF with no extractable text and no OCR plugin — return `null` so caller can try OCR post-processor or warn. Consider chaining: `markitdown` → `postProcessor: "OvisOCR2"` is valid (markitdown text → OCR). Document this.
* **Input sanitization:** Sidecar's `POST /convert` must reject `url` schemes other than `http/https`, enforce `maxBodyBytes` (e.g. 20MB), and never call `MarkItDown.convert(url)` that fetches arbitrary URLs — only `convert_stream` with caller-supplied bytes.
* **Timeouts:** Reuse `WebFetchOperation.signal` via `AbortSignal` so a timed-out `web_fetch` cancels the sidecar request too (pass `signal` into `requestWithTimeout`).

---

## 8. Testing Plan

### 8.1 Unit (`vitest`)

* `tests/extractors-markitdown.test.js`:
  * Mock fetch for sidecar → test `markitdown.extract` returns markdown, truncates via `maxChars`, returns `null` on 5xx/empty, forwards `_rawBytes` path.
  * Test `EXTRACTOR_FORMATS` includes `markitdown`, `validateHintRule` accepts `default.format: "markitdown"` and `block.format: "markitdown"` when mocked `aiModelIds` empty, rejects unknown `markitdown_foo`.
  * Test `isBinaryUrl` / `isBinaryContentType` helpers (extension + mime regex).
* `tests/domain-hints.test.js` — extend "accepts every DEFAULT_FORMATS" loop to include `markitdown`.
* `tests/search.test.js` — mock `callMarkitdown` branch: binary URL → fetchAsBytes → markitdown markdown → correct `text`, `title`, `warnings`.

### 8.2 Live (`LIVE_DOMAIN_HINTS=1` or `LIVE_MARKITDOWN=1`)

Add `tests/markitdown-live.test.js` (skipped without `MARKITDOWN_BASE_URL`):

* Spin a tiny `example.com` HTML page → `markitdown` vs `readability` output comparison (structure preserved).
* Local fixtures: `tests/fixtures/sample.pdf`, `sample.docx`, `sample.xlsx` served via `file://` or `http://localhost:32768/fixtures/sample.pdf` → verify tables/links in markdown.
* Real PDF: `https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf` (small, stable).
* Real office: check-in a minimal `.docx` in `tests/fixtures/` (MIT-licensed).
* Negative: scanned image-only PDF without OCR → expect empty + `warnings` includes `markitdown produced no content`.

### 8.3 Manual / console

* Add hint `domain: "example.com", pathPattern: "/**", default: { format: "markitdown" }` in the Domain hints panel → Test pane fetches `https://example.com` → markdown contains headings preserved.
* Binary: `curl "http://localhost:3000/extract?url=http://localhost:32768/fixtures/sample.pdf&hint=$(jq -cn '{domain:"*", pathPattern:"/**", default:{format:"markitdown"}}' | jq -sRr @uri)"` → markdown table present.

### 8.4 Benchmarks

* Measure `markitdown` vs `readability` vs `trafilatura` on the existing benchmark pages (`benchmark/web-search-benchmark.mjs` style) for token count and structure retention.

---

## 9. Rollout Steps (ordered)

1. **Scaffold extractor module** — `src/extractors/markitdown.js` with `FORMAT`/`FORMATS`, `extract()`, `callMarkitdown()` (HTTP client, gate, timeout, healthcheck). No fetch-path change yet. Register in `src/extractors/index.js`. Behind feature flag: `if (!config.markitdownBaseUrl) return null` so unconfigured instances fall back silently.
2. **Config & schema** — add `MARKITDOWN_*` keys to `src/config.js:loadConfig()` + `src/config-schema.js`. Wire `docker-compose.yml` env passthrough. Add `.env.example` entry with commented defaults.
3. **Domain-hint validation** — confirm `markitdown` appears in `DEFAULT_FORMATS`/`BLOCK_FORMATS` automatically; add `FIELD_FORMATS` decision. Add migration warning if legacy `reader_lm`/`mineru` hints should be re-evaluated (no auto-migration).
4. **Binary fetch branch** — in `src/search.js:browserOpenAndExtract`, add `isBinaryRequest` check + `fetchAsBytes` + `extractBinaryViaMarkitdown`. Keep behind `MARKITDOWN_ENABLE_BINARY` flag (default on, but can be toggled to 0 for HTML-only mode).
5. **Sidecar Docker** — `docker/navigator-markitdown/Dockerfile` + `app.py` + `requirements.txt`. Add `markitdown` service to `docker-compose.yml` and `docker-compose.mineru.yml` variant. Ensure `.dockerignore` excludes `node_modules`. Test `docker compose build markitdown && docker compose up -d` and `curl http://localhost:8001/health`.
6. **Console docs/labels** — update extractor dropdown labels/tooltips in `src/web-console/main.jsx` if needed (likely just a label map entry).
7. **Tests** — unit + live as §8. Run `docker compose exec navigator npm install --include=dev && docker compose exec navigator npx vitest run tests/domain-hints.test.js tests/extractors-markitdown.test.js`.
8. **Docs** — update `README.md` extractor list, `AGENTS.md` extractor table, `domain-hints.json` comment for wildcard hint, and `docs/` if present. Note MarkItDown is MIT, sidecar is optional, fallback is readability.
9. **Observability** — add `counters.markitdownFetches` / `engineAttempts` style entry to `/stats`, log `⏱️ markitdown: ...ms` like `trafilatura`, and surface in the console StatusView if desired.
10. **Archive plan** — move this file to `plans/archive/37_markitdown-extractors.md` after ship, absorb durable notes into `AGENTS.md`.

---

## 10. Configuration Surface (env)

```bash
# MarkItDown sidecar (extractor, not post-processor)
MARKITDOWN_BASE_URL=http://markitdown:8001        # empty = disabled (fallback to readability)
MARKITDOWN_TIMEOUT_MS=60000                       # per-request timeout (ms)
MARKITDOWN_MAX_INPUT_CHARS=400000                 # truncate HTML before sending
MARKITDOWN_ENABLE_BINARY=1                        # auto-route PDF/Office URLs to MarkItDown
```

All keys are `category: extractor`, `applies: recreate` except `TIMEOUT_MS`/`MAX_INPUT_CHARS`/`ENABLE_BINARY` which are `hot`. They map 1:1 to the pattern used for `TRAFILATURA` (implicit) and `POST_PROCESSOR_*`.

Optional: also support `MARKITDOWN_MODELS` JSON if the sidecar later hosts multiple profiles (like `POST_PROCESSOR_MODELS`), but YAGNI for v1.

---

## 11. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Python image bloat | 4GB memory limit, compose build time | Start with slim deps (`pdf,docx,pptx,xlsx`), measure, trim to `all` only if needed; sidecar has its own 1GB limit (separate from navigator's 4GB). |
| Binary fetch steals browser session (auth) | Private PDFs behind login would 401 if fetched via Node | Use in-browser `fetch(url).then(r=>r.arrayBuffer())` primary path; Node `fetch` is fallback with forwarded `Cookie` header. Document limitation. |
| MarkItDown empty on scanned PDFs | User sees blank vs expected OCR | Chain with OCR post-processor (`postProcessor: "OvisOCR2"` after `markitdown`), warn in output `⚠ markitdown produced no content — try screenshot + postProcessor`. |
| Content-type lies (`application/octet-stream` for PDF) | Binary detection misses → HTML extractor sees viewer garbage | Also match URL extension `.pdf` etc.; add `MARKITDOWN_FORCE_EXTS=pdf,docx` override. |
| Sidecar SSRF if `convert(url)` used | Host can fetch metadata service | Only use `convert_stream` with caller-supplied bytes; sidecar has no egress except healthcheck; validate `url` param is for metadata only. |
| Doubles with Trafilatura/Readability on HTML | Users confused which HTML extractor to pick | Docs: Readability = fast/semantic, Trafilatura = ML/best F1, MarkItDown = Office/PDF + HTML fallback that preserves tables aggressively. Guidance in console tooltip. |
| Cache poisoning (binary vs HTML same URL) | HTML cached as markitdown, then HTML path reuses it | Cache key is URL-only today; binary detection is deterministic on URL/ext, so same URL always takes same path. No change needed. If mime varies by request, add `content-type` to cache key in future. |

---

## 12. Alternatives Considered

* **Post-processor kind (`kind: "markitdown"`):** Reuses `POST_PROCESSOR_MODELS` + `TRANSPORTS` registry. Tempting because chat/mineru already live there. Rejected as primary because MarkItDown is an extraction-time concern (replaces readability), not a refinement of already-extracted text. Could still add as secondary alias for users who model it as post-processing.
* **Pack Python into navigator image (subprocess):** Simpler compose, but bloats navigator image, adds cold-start, complicates health. Sidecar is more operable (mirrors mineru) and keeps Node image lean.
* **New MCP tool `convert_document`:** Instead of extractor, expose `web_fetch` variant `web_convert_document(urls: string[])` that only does MarkItDown. More explicit for binary docs but fragments the tool surface (now 2 tools for "fetch and extract"). Prefer generic `web_fetch` with format-aware routing; extractor choice stays in hints.
* **Reuse `trafilatura` npm shape (native binding):** No napi-rs binding exists for MarkItDown; building one is a separate Rust port. Not pursued.

---

## 13. Open Questions (need owner decision before coding)

1. **Sidecar vs post-processor kind:** Dedicate `MARKITDOWN_BASE_URL` (extractor) or generalize to `POST_PROCESSOR_MODELS kind: "markitdown"`? Recommendation is dedicated extractor; requires team sign-off.
2. **Slim vs `all` deps:** Ship `markitdown[all]` (PDF+DOCX+PPTX+XLSX+epub+audio+YouTube) or minimal `pdf,docx,pptx,xlsx` to keep image <300MB? YouTube/audio need network + `ffmpeg` — likely exclude from v1 sidecar.
3. **Explicit aliases:** Ship `markitdown_pdf`/`_docx`/etc. in v1 or defer? Defer is simpler, but aliases are cheap (same module, `format` switch).
4. **LinkRefs for binary docs:** Should `extractLinksFromHtml` be skipped for binary, or should we parse markdown `[text](url)` links into the `links[]` index for `web_page_links`? Propose parse markdown links for link refs (nice DX).
5. **Auth for private docs:** Should `web_fetch` accept `headers`/`cookies` passthrough for binary fetch? Today it uses browser session only. If needed, add `headers` param to `web_fetch` (separate RFC).

---

## 14. References

* MarkItDown GitHub: <https://github.com/microsoft/markitdown> (README, security considerations, `convert_*` narrow APIs)
* Real Python tutorial: <https://realpython.com/python-markitdown/> (multi-format, structure preservation, plugin/LLM integration)
* Navigator extractors: `src/extractors/{readability,html-to-markdown,text,html,table,trafilatura,screenshot}.js`, `src/extractors/index.js:33-47`, `src/extractors/helpers.js`
* Trafilatura pattern (prior extractor addition): `plans/31_trafilatura-extractor.md`, `src/extractors/trafilatura.js` (lazy native import, fallback `null`)
* Mineru sidecar pattern: `docker/navigator-mineru/`, `src/post-processor.js:172-198`, `src/config.js:parsePostProcessorModels`
* Domain-hint validation: `src/domain-hints.js:317-345`, `src/domain-hints.js:753-837`
* Web fetch flow: `src/search.js:2046-2394` (`browserOpenAndExtract`), `src/extractors/index.js:104-236`


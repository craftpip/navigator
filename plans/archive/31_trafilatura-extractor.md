# Plan: Add rs-trafilatura as a Primary Extractor

**Date:** 2026-08-18
**Status:** Draft
**Benchmark:** #1 on WCXB (F1 0.859 dev / 0.903 test) — 18.5 points above our current Readability (#12, F1 0.674)

---

## Why

Our extraction pipeline uses Mozilla Readability (#12 on WCXB, F1 0.674). rs-trafilatura is #1 (F1 0.859) — a Rule+ML hybrid with XGBoost page-type classification (7 types), confidence scoring (0.0-1.0), and direct Markdown output. The gap is massive on non-article pages: documentation +25.7, service +16.9, forum +11.8 points.

npm package: `trafilatura` v0.2.0. Pre-built native binary (6.1 MB), zero JS dependencies, ~44ms/page on CPU, no GPU.

---

## Implementation Steps

### Step 1: Install the npm package

```bash
npm install trafilatura
```

Verify: `node -e "import('trafilatura').then(m => console.log(typeof m.extract))"` prints `function`.

### Step 2: Create the extractor module

**New file:** `src/extractors/trafilatura.js` (~55 lines)

```js
/**
 * TrafilaturaExtractor — rs-trafilatura Rule+ML extraction → markdown.
 *
 * Uses the trafilatura npm package (napi-rs bindings to rs-trafilatura Rust crate).
 * Classifies page type (7 types) and applies per-type extraction profiles.
 * Returns markdown directly — no Turndown step needed.
 */
import { safeTruncateText } from "./helpers.js";

export const FORMAT = "trafilatura_to_markdown";

// Lazy-load the native module to avoid crash if binary is missing.
let _extract = null;
async function getExtract() {
  if (!_extract) {
    const mod = await import("trafilatura");
    _extract = mod.extract;
  }
  return _extract;
}

export async function extract(doc, context) {
  const { url, maxChars, fallbackTitle } = context;

  let extractFn;
  try {
    extractFn = await getExtract();
  } catch (err) {
    console.warn(`[trafilatura] native module not available: ${err.message}`);
    return null;
  }

  const html = doc.documentElement.outerHTML;
  if (!html?.trim()) return null;

  let result;
  try {
    result = extractFn(html, {
      outputMarkdown: true,
      url,
      favorPrecision: false,
      includeImages: false,
      includeComments: false,
    });
  } catch (err) {
    console.warn(`[trafilatura] extraction failed for ${url}: ${err.message}`);
    return null;
  }

  if (!result?.contentMarkdown?.trim()) return null;

  const text = result.contentMarkdown;
  return {
    title: cleanWhitespace(result.metadata?.title || fallbackTitle || ""),
    url,
    text: safeTruncateText(text, maxChars),
    textOriginalLength: text.length,
    // Extra fields — flow through via ...extracted spread in search.js:2225
    confidence: result.extractionQuality,
    pageType: result.metadata?.pageType || null,
    metadata: result.metadata || null,
  };
}

function cleanWhitespace(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}
```

**Key design decisions:**
- **Lazy `import()`** — avoids crash if the native `.node` binary is missing (e.g. wrong platform). Falls back to `null` → orchestrator retries Readability.
- **Takes `doc.documentElement.outerHTML`** — trafilatura re-parses HTML internally. Slight overhead vs Readability's in-place JSDOM operation, but the 18.5 F1 point gain far outweighs it.
- **Extra fields (`confidence`, `pageType`, `metadata`)** — flow through automatically via `...extracted` spread at `search.js:2225-2226`. No orchestrator changes needed.

### Step 3: Register in the format registry

**File:** `src/extractors/index.js`

At line 15 (imports section), add:
```js
import * as trafilatura from "./trafilatura.js";
```

At line 33-39 (FORMAT_EXTRACTORS map), add one entry:
```js
const FORMAT_EXTRACTORS = new Map([
  [readability.FORMAT, readability.extract],
  [htmlToMarkdown.FORMAT, htmlToMarkdown.extract],
  [text.FORMAT, text.extract],
  [html.FORMAT, html.extract],
  [screenshot.FORMAT, screenshot.extract],
  [trafilatura.FORMAT, trafilatura.extract],   // <-- ADD THIS
]);
```

**That is all.** The following auto-propagate:
- `EXTRACTOR_FORMATS` (line 47) — auto-includes the new key
- `DEFAULT_FORMATS` / `BLOCK_FORMATS` in `domain-hints.js` (line 316-322) — derived from `EXTRACTOR_FORMATS`
- Domain hint validation (`domain-hints.js:328`) — accepts the new format
- Orchestrator dispatch (`index.js:148`) — `FORMAT_EXTRACTORS.get(pageFormat)` finds it

### Step 4: Update the web console dropdowns

**File:** `src/web-console/src/main.jsx`

The console has **hardcoded** format lists (they do not read from the API at runtime). Three changes:

**a) `DEFAULT_FORMATS` array** (line 2521-2530) — add entry:
```js
const DEFAULT_FORMATS = [
  "readability_to_markdown",
  "html_to_markdown",
  "html",
  "text",
  "table",
  "table_json",
  "table_csv",
  "screenshot",
  "trafilatura_to_markdown",   // <-- ADD
];
```

**b) `HINT_BLOCK_FORMATS` array** (line 2531-2541) — add entry:
```js
const HINT_BLOCK_FORMATS = [
  "text",
  "list",
  "html",
  "html_to_markdown",
  "readability_to_markdown",
  "table",
  "table_json",
  "table_csv",
  "screenshot",
  "trafilatura_to_markdown",   // <-- ADD
];
```

**c) `FORMAT_LABELS` object** (line 2542-2553) — add entry:
```js
trafilatura_to_markdown: "Trafilatura → markdown (Rule+ML, #1 on WCXB benchmark)",
```

### Step 5: Show confidence/pageType in web_fetch response

**File:** `src/mcp-server.js` — in `formatOpenPageResponse()` (line 1379-1406)

After the URL line (line 1385), add:
```js
if (entry?.pageType) {
  const conf = entry.confidence != null ? ` | confidence: ${entry.confidence.toFixed(2)}` : "";
  lines.push(`- Page type: ${entry.pageType}${conf}`);
}
```

This gives the LLM visibility into extraction quality. Example output:
```
- Page type: documentation | confidence: 0.94
```

### Step 6: Tests

**New file:** `tests/trafilatura-extractor.test.js` (~80 lines)

Test cases:
1. **Basic extraction** — feed article HTML, verify markdown output contains headings and paragraphs
2. **Page-type classification** — verify `pageType` is returned (e.g. "article" for article HTML)
3. **Confidence score** — verify `confidence` is a number between 0 and 1
4. **Null on empty input** — empty HTML returns `null`
5. **Metadata extraction** — HTML with `<title>` and author meta returns metadata
6. **Fallback chain** — when trafilatura returns null, `extractTextFromHtml()` falls back to Readability
7. **Format dispatch** — `extractTextFromHtml()` with `hint.default.format === "trafilatura_to_markdown"` calls trafilatura

### Step 7: Deploy and verify

```bash
docker compose build && docker compose down && docker compose up -d
docker exec navigator npm install --include=dev
docker exec navigator npx vitest run tests/trafilatura-extractor.test.js
```

Live test:
```bash
# Documentation page with trafilatura
curl -s "http://localhost:3000/extract?url=https://docs.python.org/3/tutorial/classes.html&hint=%7B%22default%22%3A%7B%22format%22%3A%22trafilatura_to_markdown%22%7D%7D" | head -30

# Same page with Readability (default) for comparison
curl -s "http://localhost:3000/extract?url=https://docs.python.org/3/tutorial/classes.html" | head -30
```

---

## File Changes Summary

| File | Action | Lines | What |
|------|--------|-------|------|
| `package.json` | Modify | +1 | Add `trafilatura` dependency |
| `src/extractors/trafilatura.js` | **Create** | ~55 | New extractor module |
| `src/extractors/index.js` | Modify | +2 | Import + register in map |
| `src/web-console/src/main.jsx` | Modify | +3 | Format list + label entries |
| `src/mcp-server.js` | Modify | +3 | Show confidence/pageType in response |
| `tests/trafilatura-extractor.test.js` | **Create** | ~80 | Test suite |

**Total:** 2 new files, 4 modified files. ~144 lines of new code.

**No changes needed to:** `src/search.js` (spread operator at line 2225 handles extra fields), `src/domain-hints.js` (auto-derives from `EXTRACTOR_FORMATS`), `src/config.js` (no new env vars).

---

## What NOT to Do

- **Do not make trafilatura the default** — Readability stays the default for backward compatibility. Users opt in via `format: "trafilatura_to_markdown"` in domain hints.
- **Do not add confidence-based auto-fallback yet** — that is a future enhancement. The WCXB hybrid pipeline shows +0.003 F1 from routing ~8% of pages to MinerU-HTML, but that requires the post-processor infrastructure.
- **Do not touch `src/search.js`** — the `...extracted` spread at line 2225 already propagates extra fields from the extractor to the result object automatically.

---

## Future Enhancements

1. **Confidence-based auto-fallback** — route low-confidence extractions (< 0.5) to Readability or LLM post-processor
2. **Page-type-aware domain hints** — use trafilatura's classification to suggest hint creation in the console
3. **Make trafilatura the default** — once validated in production, change the wildcard hint format
4. **Benchmark our pages** — compare both extractors on real pages we fetch

# Plan 28: Extractor & Post-Processor Refactor

## Problem

`extractTextFromHtml()` in `src/search.js:915-1133` is a 220-line if/else chain with:
- Format dispatch buried in nested conditionals
- Post-processor applied inconsistently: some paths call `applyPostProcessor()`, screenshot path inlines it, tables skip it entirely
- No shared interface for extractors — each is a bespoke branch
- Screenshot format was missing from the non-flow path (fixed in commit 620921c)
- `post-processor.js` has 4 transport functions (`extractWithChat`, `extractWithMineru`, `extractWithChatImage`, `extractWithApi`) with no shared interface

## Goal

1. Extractors: each format is a standalone function with the same signature
2. Post-processors: dispatch by `kind` from a registry, not an if/else chain
3. Pipeline: orchestrator is a ~40-line function — DOM setup, skipSelectors, blocks check, format dispatch, post-processor, return
4. Post-processor always runs as a final pipeline step, never embedded inside extractors

## Architecture

### Extractor Contract

```
extractor(doc, context) → { title, url, text, textOriginalLength } | null
```

Where `context` is:
```js
{
  url,
  maxChars,
  fallbackTitle,
  browserText,   // innerText from live page (null if unavailable)
  screenshot,    // base64 JPEG (null if unavailable)
  hint,          // full hint object
  config,        // manager.config
  debug
}
```

Returns `null` when the extractor produces no output (signals fallback to next path).

### Post-Processor Dispatch

Replace the `if/else` chain with a `Map<kind, transport>`:

```
transports = {
  chat:    extractWithChat,     // text/html → /chat/completions
  mineru:  extractWithMineru,   // html → /extract
  api:     extractWithApi,      // custom endpoint
  // screenshot is not a kind — it's an input type.
  // screenshot + chat kind → extractWithChatImage (detected at call time)
}
```

The dispatcher (`runPostProcessor`) stays the same but the internal routing becomes:
1. Find entry by model id
2. Determine transport from `entry.kind`
3. If `entry.kind === "chat" && screenshot` → use `extractWithChatImage` instead of `extractWithChat`
4. Call the transport function

This is already ~what happens, but the code makes it look like 4 separate concerns when it's really 1 dispatcher + 3 transports + 1 image variant.

### Pipeline (refactored `extractTextFromHtml`)

```
1. Parse HTML → JSDOM
2. Apply skipSelectors (global + hint-level)
3. If hint.content.blocks → renderContentBlocks() → return if output
4. If strict + blocks produced nothing → return empty
5. Resolve format + postProcessor from hint.default
6. Dispatch to registered extractor by format
7. Post-processor: if configured, run on extractor output (always, for all formats)
8. Return
```

Step 7 is the key change: post-processor becomes a single point of application after extraction, not scattered across individual format branches.

## Files

### New: `src/extractors/index.js` — Registry + Orchestrator

Exports:
- `extractTextFromHtml(args)` — the orchestrator (same signature as today)
- `EXTRACTOR_FORMATS` — array of known format IDs (replaces hardcoded arrays in domain-hints.js, config-schema.js, main.jsx)

### New: `src/extractors/readability.js` — ReadabilityExtractor

Wraps the existing Readability logic (lines 1021-1082):
- Parse article with Readability
- Compare with browserText (the 1.5x heuristic)
- Convert to markdown via htmlToMarkdown
- Fallback to buildCleanText if needed

### New: `src/extractors/html-to-markdown.js` — HtmlToMarkdownExtractor

Wraps the existing fallback logic (lines 1084-1113):
- collectCandidateBlocks → pick best → htmlToMarkdown
- If no markdown → buildCleanText from bestText

### New: `src/extractors/text.js` — TextExtractor

Flat text dump:
- collectCandidateBlocks → bestText → buildCleanText

### New: `src/extractors/html.js` — HtmlExtractor

Raw HTML in a code fence:
- collectCandidateBlocks → bestContainerHtml → fenced block

### New: `src/extractors/table.js` — TableExtractor

Handles `table`, `table_json`, `table_csv`:
- extractTablesFromDocument → render by sub-format
- Returns `null` if no tables found (signals fallback)

### New: `src/extractors/screenshot.js` — ScreenshotExtractor

- Requires `screenshot` in context (throws if missing)
- Returns `{ text: screenshot }` — raw screenshot as text
- Post-processor handles the actual OCR conversion

### Modified: `src/search.js`

- Remove `extractTextFromHtml()` and all format-specific branches
- Remove `applyPostProcessor()` closure
- Import `extractTextFromHtml` from `src/extractors/index.js`
- Keep ALL helper functions in `search.js`: `elementTextWithBreaks`, `toLines`, `collectCandidateBlocks`, `buildCleanText`, `safeTruncateText`, `extractTablesFromDocument`, `renderTableAsMarkdown`, `renderTablesAsJson`, `renderTablesAsCsv`, `renderContentBlocks`, `renderLeafContent`, `renderHintFields`, `normalizeParagraphText`, etc.
- Export the helpers that extractors need via a shared context or direct import

### Modified: `src/post-processor.js`

- Add `TRANSPORTS` map: `{ chat: extractWithChat, mineru: extractWithMineru, api: extractWithApi }`
- Refactor `runPostProcessor` to use the map
- Add `CHAT_IMAGE_VARIANT = extractWithChatImage` for screenshot+chat

### Modified: `src/domain-hints.js`

- Import `EXTRACTOR_FORMATS` from `src/extractors/index.js` instead of hardcoded array at line 100

## What Does NOT Change

- `renderContentBlocks()` stays in `search.js` — it's a hint-specific renderer, not an extractor
- `renderLeafContent()`, `renderHintFields()` stay in `search.js`
- All DOM helper functions stay in `search.js`
- The `extractTextFromHtml` function signature stays identical — all 3 call sites (`extractHintStage`, `browserOpenAndExtract` cached path, `browserOpenAndExtract` live path) continue working unchanged
- `runPostProcessor` signature stays identical
- Post-processor model config (`POST_PROCESSOR_MODELS`) stays the same

## Migration Safety

- `extractTextFromHtml` is a module-private function (not exported). Changing its internals has zero external API impact.
- The function signature is preserved. All 3 call sites pass the same args.
- The output shape `{ title, url, text, textOriginalLength }` is preserved.
- Post-processor behavior is unchanged — just moved from scattered `applyPostProcessor()` calls to a single pipeline step.
- Tables-only format: currently tables skip post-processor. After refactor, post-processor runs on table output too. This is a behavior change but is correct (if someone sets a post-processor on a table format, they want it applied).

## Implementation Order

1. Create `src/extractors/` directory
2. Create `src/extractors/readability.js` — extract the Readability branch
3. Create `src/extractors/html-to-markdown.js` — extract the html_to_markdown/fallback branch
4. Create `src/extractors/text.js` — extract the text branch
5. Create `src/extractors/html.js` — extract the html branch
6. Create `src/extractors/table.js` — extract the table branch
7. Create `src/extractors/screenshot.js` — extract the screenshot branch
8. Create `src/extractors/index.js` — registry + orchestrator (with post-processor pipeline step)
9. Refactor `src/post-processor.js` — transport map
10. Update `src/search.js` — replace old `extractTextFromHtml` with import
11. Update `src/domain-hints.js` — import `EXTRACTOR_FORMATS`
12. Syntax check + tests + manual /extract test

## Verification

1. `node -c src/search.js && node -c src/extractors/index.js && node -c src/post-processor.js`
2. `docker exec navigator npx vitest run` — existing tests
3. `curl http://localhost:3000/extract?url=http://10.69.1.164:32768/table/&maxChars=3000` — hint #6 (screenshot format)
4. `curl http://localhost:3000/extract?url=https://example.com&maxChars=5000` — default readability format
5. `curl http://localhost:3000/extract?url=https://news.ycombinator.com&maxChars=5000` — html_to_markdown fallback

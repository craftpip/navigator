# Tool Reference

Navigator exposes web research tools and, when enabled, persistent-browser DevTools tools. Published tool schemas describe closed input contracts. MCP responses are text content; DevTools responses contain JSON encoded in that text.

Tools may be absent from `tools/list` and reject calls when named in `DISABLE_TOOLS` or excluded by the calling API key's allow-list. DevTools tools also require `ENABLE_DEVTOOLS_MCP=1`.

## References, Caching, And Limits

- Search and fetch results receive positive numeric reference IDs. Use a returned `ref_id` to open a result instead of repeating its URL where the tool accepts it.
- A fetched page's links render as normal Markdown destinations, for example `[documentation](88)`. Call `web_page_links` with that inline link ID to resolve its URL, then fetch the same link reference.
- `web_search` and `web_fetch` cache results in process memory for five minutes (up to 200 entries per tool). `bypassCache: true` refreshes a result. Fetch excludes `maxChars` from its cache key, so a cache entry retains the length requested by the first caller, up to 200,000 characters.
- **Cache transparency:** only complete, successful results are cached. A payload is considered cacheable when it has no top-level `errors` and no per-item failure (`ok: false`) — a transient engine outage or a fetch that returned partial pages is never replayed as a good answer. A replayed result is stamped with its age in the response text (`*(cached result — retrieved N ago; pass bypassCache: true to fetch fresh)*`), so a cache hit is indistinguishable-proof from a live fetch. `bypassCache` returns an unmarked, fresh response.
- Reference mappings are bounded in memory and persisted in SQLite for lookup across restarts. Search/fetch caches and counters are not persistent.
- Page and DevTools operations use `BROWSER_OP_TIMEOUT_MS`. Persistent DevTools targets close after five minutes without interaction.

## Typical Research Flow

```json
{"queries":["Node.js test runner documentation"],"limit":3}
```

Use a returned result reference to fetch the chosen page:

```json
{"ref_ids":[42],"maxChars":12000}
```

Use `web_page_screenshot` for visual confirmation, or create a persistent target and inspect/drive the page with DevTools tools.

## Web Tools

### `web_search`

Input: `queries` is a non-empty string array. Optional `limit` defaults to `5`; `engine` defaults to `select_best`; `bypassCache` defaults to `false`.

`select_best` uses the configured automatic routes, scheduler, fallback, and circuit breakers. Use an explicit registered engine only when a caller specifically needs that route; it may be called even if it is not in `SEARCH_ENABLED_ENGINES`. Results are grouped by query and contain title, URL, snippet, readable text, and numeric reference ID. An independent DuckDuckGo Instant Answer may appear before results when enabled. Per-route failures are reported with the search response where possible.

```json
{"queries":["MCP Streamable HTTP specification","MCP HTTP transport docs"],"engine":"select_best","limit":5}
```

### `web_fetch`

Input: provide exactly one target mode, `urls: string[]` or `ref_ids: number[]`. Optional `maxChars` controls returned text length; `bypassCache` refreshes the cached page result.

The response contains an entry for each page with readable text, extracted tables, page metadata, and a page reference. Tables are extracted and rendered as structured Markdown by default; the page's extractor (Readability, HTML-to-Markdown, or text) decides how tables are rendered, and `table`/`table_json`/`table_csv` extractors return tables-only output. `maxChars` is applied when reading the structured result, after cache lookup; large tables may still make the complete response exceed the requested text length and a truncation notice is added.

A page is honestly marked when extraction had to proceed before the page was fully ready: if a domain hint's `waitForSelector` never appears or stabilization fails, the response is flagged `partial: true` and carries a `- ⚠ PARTIAL: …` line naming the missed selector instead of looking like a complete extraction. Read the `warnings` list to see exactly which readiness gate was not satisfied.

```json
{"urls":["https://example.com/article"],"maxChars":8000}
```

Use `web_page_links` rather than trying to infer numeric link destinations from text:

```json
{"ref_ids":[42]}
```

### `web_page_screenshot`

Input: provide one of `urls: string[]`, `ref_ids: number[]`, or a persistent `targetId`. Optional `quality` is `low` (JPEG 30), `medium` (55, default), or `high` (75). `fullPage` defaults to `true`.

The default `output` is inline base64 JPEG. `file` is available only when a screenshot path prefix is configured; `url` is available only when screenshot downloads are enabled. The response returns inline image data, a file path, or a download URL according to the selected output. A target screenshot uses the existing tab instead of creating a transient page.

```json
{"ref_ids":[42],"quality":"low","fullPage":false}
```

### `web_page_links`

Input: `ref_ids: number[]`. It resolves remembered references to full URLs without loading them. A missing mapping is returned as an unresolved reference, not fetched automatically.

### `web_page_ascii`

Input: provide `url` or `ref_id`. Optional `width` defaults to `100` and is clamped to 40-200 columns; `fullPage` defaults to `false`; `elementLimit` defaults to `25` and is clamped to 1-100. `mode` is `color_ansi` (default), `grayscale_ansi`, or `ascii`. `includeSelector` and `includeXpath` default to `true`.

This produces a screenshot-derived Chafa-style terminal render plus an annotated DOM legend. It is for layout, color, and element location, not OCR. Pair it with `web_fetch` or DOM inspection for readable content.

## Persistent Browser Tools

Create a target when a page requires interaction or runtime inspection:

```json
{"url":"https://example.com"}
```

`Target.createTarget` accepts optional `targetId`, `url`, or `ref_id`; a direct URL wins and omitted URL opens `about:blank`. It fails if the requested ID exists or the target limit (20) is reached. `Target.getTargets` lists live targets. `Target.closeTarget` requires `targetId` and explicitly closes it.

`Page.navigate` requires `targetId` and `url`. If that ID does not exist, it creates a target with `created: true`. `Page.reload` accepts `ignoreCache: boolean`; backends that cannot disable cache report that the requested hard refresh was not applied. `Page.goBack` and `Page.goForward` require `targetId` and return `navigated: false` when history has no applicable entry.

## Inspecting A Page

Start with `DOM.getDocument` (`targetId`, optional `limit`, default 15) to discover real selectors, XPath values, attributes, field values, visibility, and bounding rectangles.

`DOM.querySelector` and `DOM.querySelectorAll` require `targetId` plus one CSS selector or XPath; the multiple query accepts `limit` (default 10). Locator failures include useful page context and candidates. Do not use nonstandard text-selector syntax such as `:has-text()`.

`DOM.getOuterHTML` and `DOM.getCompactHTML` require `targetId` and optionally accept one locator plus `maxChars`. Without a locator they choose likely main content (`main`, `article`, `[role=main]`, `#content`, or `.content`). Raw HTML defaults to 20,000 characters and is capped at 120,000. Compact HTML removes scripts, styles, media, comments, empty nodes, noisy attributes, and excess whitespace. `DOM.scrollIntoViewIfNeeded` requires a locator and returns the resolved element geometry.

## Browser Input And Diagnostics

`Input.dispatchMouseEvent` requires `targetId` and a locator. It scrolls the resolved element into view then clicks its center. `button` is `left`, `right`, or `middle`; `clickCount` is limited to 1-3.

`Input.insertText` requires `targetId`, `text`, and a locator. It focuses an editable element, clears its current value, types through the page keyboard, then returns the final value read back from the page. It is destructive to the field's previous value by design.

`Input.dispatchKeyEvent` requires `targetId` and `key`, with optional ordered `modifiers` and `text`. Synthetic key input cannot invoke browser-level shortcuts such as Ctrl+R or F12; use `Page.reload` for refresh.

`Runtime.evaluate` requires `targetId` and JavaScript `expression`. Promises are awaited. Arrays and object keys are capped at 25 entries, nesting at four levels, circular values become `[Circular]`, and deeper values become `[MaxDepth]`. DOM values are serialized to useful element metadata rather than returned as live objects.

`Runtime.getConsoleMessages` returns captured console messages, page errors, and request failures for a target. Its optional `limit` defaults to 30 and is capped at 100. `Network.getRequests` returns the target's rolling 200-request buffer; use optional `limit` (1-200), URL `filter`, `failedOnly`, or exact `status` to narrow it.

## Failure Handling

- **Tool unavailable:** enable DevTools with `ENABLE_DEVTOOLS_MCP=1`, remove the name from `DISABLE_TOOLS`, or update the API-key tool allow-list.
- **Unknown or expired target:** create it again. Any successful DevTools interaction refreshes its five-minute inactivity timer.
- **Locator did not match:** inspect `DOM.getDocument`, then use one exact CSS selector or XPath. Failure responses include candidate controls when available.
- **Page timeout or navigation failure:** inspect `Runtime.getConsoleMessages` and `Network.getRequests`, then check `/health` for browser or capacity trouble. Raise `BROWSER_OP_TIMEOUT_MS` only for a demonstrated slow page.
- **Reference cannot resolve:** references are process/data dependent. Search or fetch the URL again to obtain a current reference.
- **Schema error:** remove unsupported fields and use one allowed target mode. Tool schemas intentionally reject unknown input instead of silently ignoring it.

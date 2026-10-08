# Core Server And Search

`src/mcp-server.js` is the process boundary: it exposes MCP, HTTP, console, caching, authentication, telemetry, and result formatting. `src/search.js` performs search, rendered-page extraction, and standalone screenshots. Keep transport concerns in the server and browser/content concerns in search; neither module should become a second implementation of the other.

## Request Lifecycle

An MCP tool call first passes disabled-tool and API-key scope checks, then is recorded as a web or devtools activity event whether it succeeds or fails. The same dispatcher serves streamable MCP sessions, stateless JSON-RPC calls, and the console's MCP proxy. Stateless calls intentionally do not reuse a streamable transport; session calls use an exact `Mcp-Session-Id` lookup so a request cannot be sent to another client's session.

The server exposes `web_search`, `web_fetch`, screenshots, link resolution, ASCII capture, and, when enabled, persistent devtools tools. It rejects unknown or disabled tools with a useful error. Tool errors are also written as redacted JSONL records in `logs/tool-errors.log` when logging is enabled. Sensitive argument names are masked and typed text is retained only as a character count.

HTTP request bodies are limited to 1 MiB. The health endpoint reports browser, page-limiter, circuit-breaker, and VNC state; `/stats` adds process, cache, request, engine-attempt, activity, and browser-instance data. The web console is optional and its assets are resolved beneath `src/web-console/dist` to prevent path traversal.

Source: MCP dispatch and HTTP routing in `src/mcp-server.js`; browser operations in `src/search.js`.

## Result References And Batches

Search and fetch results receive numeric reference IDs through `ref-memory.js`. A later fetch, screenshot, or devtools target can use those IDs instead of carrying a URL. The bounded process cache resets on restart, but SQLite preserves mappings and repopulates the cache on lookup.

Fetch and screenshot requests accept direct URLs or remembered IDs. Batch operations retain input order, run with configured bounded concurrency, and return a per-URL success or error entry rather than failing the full batch because one target fails. A single successful target is returned in the compact single-page shape. Extracted links are registered as references and inline Markdown links are rewritten from URLs to `[text](ref_id)`; table links are deliberately excluded.

## Caching, Storage, And Display Limits

`web_search` and `web_fetch` have independent in-memory caches with a five-minute TTL and at most 200 entries per tool. Expired entries are pruned and oldest entries are evicted. `bypassCache` skips a read but the newly produced result is still stored.

Fetch caching stores the structured extraction result. `maxChars` is intentionally excluded from its cache key, so the first caller determines the stored extraction length, up to 200,000 characters. A later larger request cannot recover text beyond that cached length.

The HTTP `/extract` test route also has a separate, bounded in-memory HTML cache (32 entries). It exists for iterative domain-hint testing: `cacheHtml=1` can replay extraction without a browser only for ordinary pages or interaction-free flows; `refresh` captures a new snapshot; `0` clears cached HTML. Interactive flows must use a live page.

Screenshot output is always JPEG. It can be returned inline, saved under the configured screenshot prefix, or exposed through a temporary download URL when those modes are configured. Download registrations expire after one hour and are capped at 200; stored files are pruned with their registrations. Do not expose a file or URL output option unless its storage configuration is present.

## Search Routing And Failure Policy

`browserSearch()` normalizes and deduplicates one or more query variants. It records one durable search activity record, runs variants concurrently, then merges duplicate URLs across variants while preserving the contributing query variants. Each query may also receive a DuckDuckGo Instant Answer; search waits at most 1.5 seconds for it, while its underlying request may continue up to its own timeout.

An explicit engine selection runs the requested routes and returns their individual failures. Automatic selection asks `EngineScheduler` for enabled routes, skips scheduler-disabled and circuit-open routes, and tries routes in order until one produces results. It records skipped and failed routes in the response instead of hiding degraded service. A route that returns no results is a failure for fallback selection, but a caller's explicit route is not replaced by another engine.

Search results are normalized by URL, capped per engine, deduplicated, and merged so a better non-empty snippet can replace an empty duplicate. Lightpanda routes run serially because they share one browser pool; other explicit routes may run concurrently.

Route circuit breakers are keyed by engine and backend and persist in `.cache/search-route-circuits.json`. A normal route failure opens the route for the configured cooldown; success clears it. Local browser-launch/display failures are recorded as skipped, not as remote-route failures, and are discarded from persisted circuit state on startup. Bot/captcha failures also increment the bot-block counter. Engine attempt telemetry is bounded to 20,000 records, persisted in `.cache/search-engine-attempts.json`, and written to the activity database within the active search context.

Safe boundary: engine transport, blocking detection, and SERP parsing belong in `src/engines/`; scheduling, fallback, merging, and telemetry belong in `src/search.js`.

## Rendered Page Extraction

`browserOpenAndExtract()` is the shared path for `web_fetch` and the HTTP extraction test endpoint. It increments fetch counters, obtains the configured direct-page backend, and runs under the global page-operation limiter. Each browser step has the configured operation timeout; a timed-out page is closed before the operation rejects. The page is always closed in a `finally` block.

The normal path is:

1. Resolve a supplied hint override or candidate domain hints by URL.
2. Navigate until DOM content is loaded.
3. Select the first candidate whose optional `requireSelector` exists after navigation. Wait for all configured hint selectors, up to 20 seconds each, then stabilize the page.
4. Recheck the selector gate after stabilization. An override whose gate is absent falls back to normal extraction and adds a warning instead of silently pretending it applied.
5. Detect bot challenges before extraction. A challenge returns page identity with empty text and an error, rather than treating challenge HTML as content.
6. Capture rendered HTML, title, URL, and visible browser text. Extract text, tables, links, page-state warnings, and optional SEO analysis.

Stabilization is selected by the hint, then server configuration, then `network_idle`. Network idle waits for 500 ms of quiet and gives up after 10 seconds; content-idle and mutation-idle waits are bounded to five seconds. Failed stabilization waits are intentionally non-fatal because many pages never become fully idle.

Extraction works from the captured HTML in JSDOM. Domain-hint blocks or sections are preferred when they yield content. Otherwise it removes configured non-content nodes, tries Readability and HTML-to-Markdown, then falls back to scored semantic content containers. The fallback favors `article`, `main`, and substantive low-link-density text while rejecting common navigation, cookie, login, footer, and boilerplate patterns. It preserves paragraph boundaries, removes duplicate and junk lines, and safely truncates text.

Tables are extracted as structured data by default, including meaningful headers, captions, headings, and expanded row/column spans. The extractor (Readability, HTML-to-Markdown, or text) decides how tables are rendered; `table`/`table_json`/`table_csv` extractors return tables-only output. Empty or layout-only tables are removed. Rendered tables are inserted near their matching heading when possible, otherwise appended. Links are always collected from non-table anchors, made absolute, deduplicated, and given nearest-heading context; they are retained in structured output but not appended as a noisy link section.

SEO analysis is optional because its live-page snapshot is additional work. It returns title, canonical URL, description, headings, and ranked visible main-content candidates. If standard extraction is empty, its leading candidate can provide the returned text.

The response has an explicit truncation note when the selected text or table-enriched output exceeds `maxChars`. Tables are intentionally not cut back after insertion, so callers know the text limit is an awareness limit rather than a hard total-response limit.

## Domain Hints And Flows

Hints are data, not heuristic code. Rules are ordered: the first matching domain/path rule whose `requireSelector` is present wins, so specific selector-gated rules must precede a generic fallback. The console validates and serializes hint mutations, rejects duplicate `domain + pathPattern + requireSelector` rules, writes atomically through the hint persistence layer, and clears the runtime hint cache.

A hint can run a flow of extract, click, wait, type, and navigate stages. Each extract captures the current HTML and produces a labelled stage; stages merge text, tables, links, and warnings before the final character limit is applied. The total flow timeout is capped by `FLOW_TOTAL_TIMEOUT_MAX`; a selector wait defaults to 10 seconds when a step has no timeout. Clicks must match exactly one visible target. Gated interactions wait for their result selector, stabilize, and check for bot challenges. Empty extract stages fail by default, or become warnings only with `continueOnEmptyExtract`.

Interaction-free flows, consisting only of extracts and selectorless waits, may replay from cached HTML. Do not expand this optimization to flows that click, type, navigate, or wait for a page-state selector: those need a real browser state.

## Screenshots And Operational Safety

Direct screenshots use the default direct-page backend, wait briefly for content, capture JPEG base64, and include page/viewport dimensions. The screenshot operation has the same global page slot and timeout protections as extraction. Persistent-target screenshots are handled by devtools and do not create a temporary page.

The process wraps browser-heavy tool operations in a hang guard. A configured unrecoverable hang triggers orderly browser shutdown and process exit so the supervisor can restart it. Preserve this boundary when adding new long-running browser work.

## Safe Changes

- Keep structured search and extraction payloads separate from Markdown formatting; cache structured fetch data and format at read time.
- Preserve exact session matching for MCP POST requests. Falling back to another session causes SDK session validation failures and reconnect loops.
- Keep SSE keepalive as comment frames written to active stream controllers. Do not use JSON-RPC notifications or server-to-client `ping()` as idle traffic.
- Keep domain-specific formatting in hints and selectors. Do not add broad website auto-detection to extraction code.
- Preserve page-slot acquisition, timeout-driven page closure, and `finally` cleanup around every temporary page.
- Do not remove search/server console logs without explicit instruction; they are production diagnostics.

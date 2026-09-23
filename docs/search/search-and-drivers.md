# Search, Scheduling, and Drivers

## Search Business Logic

`browserSearch()` in `src/search.js` is the search orchestrator. It normalizes quoted/duplicate query variants, records one SQLite search, requests configured engines, merges duplicate URLs, and returns concise result records.

An explicit engine request runs the requested engine in the caller's order. Automatic selection rotates the primary attempt across healthy engines, using score as the tie-breaker, then falls back sequentially through the remaining score-ranked engines only if it fails. Browser engines acquire a reusable search window; API engines run without a browser.

## Scheduler and Circuit Breaker

The scheduler and engine circuit breaker solve different problems.

| Mechanism | State | Decision |
|---|---|---|
| `EngineScheduler` | `.cache/search-engine-profiles.json` | Prefers healthy, fast engines and backs off repeated engine failures |
| Engine circuit breaker | `.cache/search-circuit-breakers.json` | Refuses an engine for `SEARCH_ROUTE_CIRCUIT_OPEN_MS` after an execution failure |

Scheduler profiles persist attempts, returned results, recent outcomes, response-time samples, failure gaps, and error categories. Scores combine success rate, result yield, median latency, recent stability, recent-failure penalty, and recovery; they break ties for fair primary rotation and rank sequential fallback. A failure raises the engine's minimum interval using exponential escalation plus a percentile of observed failure gaps; CAPTCHA/block failures are more conservative. Successes gradually decay the interval back to its configured floor. The hard engine circuit breaker remains separate. `POST /engines/reset` with `{ "engine": "<id>|all" }` (or `POST /engines/reset/all`) clears profile history and that engine's circuit state; `./navigator.js engines [reset <id|all>]` exposes the same control.

`runSearchRoute()` applies a global page-operation slot, engine-circuit checks, activity metrics, and pool-specific recovery. Shared-pool engines (`bing`, `mojeek`) retry detached-frame/target-loaded failures once. Empty results count as an automatic-scheduler failure but do not open the hard circuit for an explicitly requested engine. Local display/browser-launch faults never open a circuit.

## Driver Contract

Every engine is registered in `src/engines/index.js` and validated at module load.

`SearchEngineDriver` defines metadata and extension points:

```js
id                 // unique engine ID
backend            // api | chromium (browser engines run on the built-in Chromium)
pool               // null | engine | shared
homeUrl            // null for API; HTTPS URL for browser engines
inputSelectors
resultSelectors
searchUrl(query)   // browser engines
search({ query, limit })  // API engines
submit(page, query)
extract(page)
assertNotBlocked(page)
```

`ApiSearchDriver` fixes API metadata. `BrowserSearchDriver` implements common navigation, result-selector polling, before/after block checks, and result tagging. DOM extractor functions execute inside the loaded SERP and return `{ results, directAnswers }`.

## Engine Matrix

### Browser engines

| Engine | Pool | Notes |
|---|---|---|
| `duckduckgo` | engine | Submits the homepage search form rather than the query URL; detects anomaly and `/sorry/` blocks |
| `google` | engine | Standard Google SERP parsing and CAPTCHA detection |
| `bing` | shared | Standard Bing SERP parsing and verification detection |
| `brave` | engine | Extracts web results and standalone AI answer |
| `mojeek` | shared | Parses standard results and infoboxes; title/body block checks |
| `startpage` | engine | Retries transient execution-context destruction |
| `yahoo` | engine | Filters result rows from related-search rows |

### API engines

| Engine | Key | Notes |
|---|---|---|
| `duckduckgo_api` | none | Posts to the DDG HTML endpoint; optionally reads the answer API in parallel |
| `exa_api` | `EXA_API_KEY` | Exa semantic search with highlights |
| `linkup_api` | `LINKUP_API_KEY` | Linkup grounded search |
| `tavily_api` | `TAVILY_API_KEY` | Tavily search with answer mode |
| `firecrawl_api` | `FIRECRAWL_API_KEY` | Firecrawl web search |

All registered engine IDs may be selected explicitly. `SEARCH_ENABLED_ENGINES` limits only automatic scheduling, and keyed API engines are only scheduled when their key is present.

## Provider Details

### DuckDuckGo

The browser engine loads `https://duckduckgo.com/`, fills an available search field, submits the surrounding form, then parses result articles or legacy `.result` cards. It detects anomaly and `/sorry/` blocks. The API engine posts to `https://html.duckduckgo.com/html/`, parses JSDOM result rows, and treats anomaly/captcha HTML with no usable results as an error.

### Google

Uses `https://www.google.com/search?q=...&hl=en&udm=14`. Results come from `#search` cards containing an `h3`; direct answers use knowledge/description selectors. Rejects unusual-traffic, robot, and `/sorry/` pages.

### Bing

Uses `https://www.bing.com/search?q=...`, parses `#b_results li.b_algo`, and optionally returns answer-card content. CAPTCHA, unusual-traffic, human-verification, and `/sorry/` text are treated as blocks.

### Brave, Mojeek, Startpage, and Yahoo

- Brave parses `#results` web snippets and its standalone AI response.
- Mojeek parses `.results-standard li` and infobox text, with title/body block checks.
- Startpage parses normal result links and wiki quick information. Its `withNavigationRetry()` wrapper retries only navigation-context errors up to two times because Startpage can navigate just after load.
- Yahoo parses qualifying `#web ol li` rows, excluding related-search cards, and returns its direct-answer cards.

## Result Cleanup

`src/engines/util.js` centralizes behavior used by drivers:

- `normalizeQueryText()` removes irrelevant punctuation while retaining useful syntax such as `+`, `#`, and `.`.
- `normalizeUrl()` unwraps Google, DuckDuckGo, Bing, and Yahoo redirects.
- `cleanWhitespace()` and `cleanAndTruncateText()` normalize output while preserving newlines in the latter.
- `dedupeDirectAnswers()` merges answers by source/text and records query variants.
- `fetchTextWithTimeout()` applies abortable HTTP timeouts to API requests.

## Search Settings

| Setting | Effect |
|---|---|
| `SEARCH_ENABLED_ENGINES` | Engines available to automatic selection |
| `SEARCH_ROUTE_WARMUP_ENGINES` | Browser engines kept warm at startup |
| `SEARCH_ROUTE_CIRCUIT_OPEN_MS` | Engine-circuit open duration |
| `SEARCH_KEEP_MIN_WORKING_WINDOWS` | Warm windows retained per pool |
| `SEARCH_MAX_WORKING_WINDOWS` | Maximum windows in an engine pool |
| `SEARCH_QUEUE_*` | Scheduler profile path, score weights, learned backoff, and recovery decay |
| `EXA_API_KEY`, `LINKUP_API_KEY`, `TAVILY_API_KEY`, `FIRECRAWL_API_KEY` | Enable their keyed API engines |
| `ENABLE_INSTANT_ANSWERS` | Enables independent DDG Instant Answer fetch per query |
# 35 — Firecrawl search engine (firecrawl_api) integration — search-only

**Created:** 2026-08-21
**Status:** Plan — not yet implemented
**Request:** “now lets plan to implement firecrawl fc-***REDACTED*** is my key”

## Goal

Add a fourth API-backed search route `firecrawl_api` mirroring `exa_api` (`plans/33_exa-search-engine.md`), `linkup_api` and `tavily_api` (`plans/34_tavily-search-engine.md`):

- New driver `src/engines/firecrawl-api.js` extends `ApiSearchDriver`
- Registered in `src/engines/index.js` as `firecrawl_api` (`backend:"api"`, no pool/homeUrl)
- Uses `FIRECRAWL_API_KEY` from environment (`process.env.FIRECRAWL_API_KEY`, loaded via `src/config.js`)
- **Only for `web_search`** — no `web_fetch` extraction
- When key missing the engine is **disabled** — excluded from `select_best` and returns `schedulerSkip` when explicitly requested (same semantics as other `*_api` routes)

## Why Firecrawl fits as `*_api`

- Pure HTTP JSON, no browser — same contract: `driver.search({query, limit}) → {results, directAnswers}`
- Same orchestrator hooks: circuit breaker, `recordEngineAttempt`, `EngineScheduler`, `manager.withPageSlot` short-circuit for `backend==="api"` in `src/search.js:978`
- Search + highlights in one call; optional `scrapeOptions` can return full markdown per result but not needed for search-only
- Free tier handles higher rate limits with key; without key a small unauthenticated quota exists but we treat missing key as disabled for consistency

## Design

### 1. Driver — `src/engines/firecrawl-api.js`

```
export class FirecrawlApiDriver extends ApiSearchDriver {
  id = "firecrawl_api";
  async search({ query, limit })
}
```

**Auth:**

- Read key from `this.config.firecrawlApiKey` (populated by `loadConfig`) falling back to `process.env.FIRECRAWL_API_KEY`
- If missing: `throw new Error("FIRECRAWL_API_KEY not configured — set FIRECRAWL_API_KEY to enable firecrawl_api search")` with `error.schedulerSkip = true`
- Header: `Authorization: Bearer <key>`, `Content-Type: application/json`, `Accept: application/json`

**Request:**

- Endpoint: `POST https://api.firecrawl.dev/v2/search`
- Body (search-only, no `scrapeOptions` — keep 2 credits/10 results):
  ```json
  {
    "query": "<normalized query>",
    "limit": 10,
    "sources": [{"type": "web"}]
  }
  ```
- `limit` respects optional `limit` (cap 1–20 default 10, API max 100 but we cap 20) — forward-compatible if `src/search.js:978` passes `limit`
- `sources: [{"type":"web"}]` default; could later expose `news`/`images` but keep web-only for `web_search`
- `tbs`/`location`/`country`/`categories`/`includeDomains` not needed for v1 — keep minimal; `highlights` defaults true on v2, so `description` already contains query-relevant passage (no extra param needed)
- `timeout: 15000` via `fetchTextWithTimeout` budget — aligns with other API drivers `Math.min(browserOpTimeoutMs,15000)`
- Do **not** set `scrapeOptions` for search-only — avoids per-page scrape credits and keeps response small (`title`/`url`/`description` only)

**Response mapping (Firecrawl → navigator):**

- Firecrawl v2 `search` returns:
  ```json
  {
    "success": true,
    "data": {
      "web": [
        {
          "title": "Firecrawl Docs",
          "url": "https://docs.firecrawl.dev/...",
          "description": "query-relevant highlight (or plain description if unavailable)",
          "markdown?": "...only if scrapeOptions",
          "links?": "..."
        }
      ],
      "news"?: [...],
      "images"?: [...]
    },
    "id": "...",
    "creditsUsed": 2
  }
  ```
  SDK note: results grouped by source type (`data.web`), not flat `data`. cURL without `scrapeOptions` returns `description` highlights by default.

- Navigator `results[]`:
  - Iterate `data?.data?.web` or `data?.web` or `data?.results` (defensive for version drift) — prefer `data.data.web`
  - `title`: `cleanWhitespace(item.title || item.name)`
  - `url`: `normalizeUrl(item.url)`
  - `snippet`: `cleanWhitespace(item.description || item.snippet || item.markdown?.slice(0,500) || "")` — highlights already in `description` (v2 docs: web → `description`, news → `snippet`), fallback plain description
  - Filter: `title && url`, tag `engine: this.id`

- Navigator `directAnswers[]`:
  - Firecrawl search has no `answer` field (unlike Tavily/Linkup). Build from top snippet if ≥40 chars: `{ source:"firecrawl_highlight", text: cleanWhitespace(description).slice(0,400), url: results[0].url }` — same pattern as `src/engines/exa-api.js:32`, `src/engines/linkup-api.js:35`, `src/engines/tavily-api.js:20`
  - Empty otherwise — global DuckDuckGo Instant Answer fetch in `src/search.js:1272` still races

**Error handling:**

- Use `fetchTextWithTimeout` with `Math.min(browserOpTimeoutMs,15000)` ms
- Non-2xx → `fetchTextWithTimeout` throws `HTTP <status> from https://api.firecrawl.dev/v2/search: <body>`; map:
  - `401` → `Firecrawl API authentication failed (401) — check FIRECRAWL_API_KEY`
  - `402` → payment/credits
  - `429` → `rate limited (429)`
  - `400` → bad request (invalid query length >500 etc.)
- `JSON.parse` failure → `Firecrawl API returned non-JSON: <preview>`
- `success:false` with `error` field → throw readable `Firecrawl API error: <error>`

### 2. Registry — `src/engines/index.js`

- Import `FirecrawlApiDriver`, add to `DRIVER_CLASSES`
- `SUPPORTED_ENGINES` becomes 16; `getEngineMetadata("firecrawl_api")` → `{backend:"api", pool:null, homeUrl:null, isBrowser:false}`
- `getBrowserWarmupEngines` automatically excludes it

### 3. Config — `src/config.js`

- New field `firecrawlApiKey: String(process.env.FIRECRAWL_API_KEY||"").trim()`
- `DEFAULT_SEARCH_ENABLED_ENGINES` stays 12; `loadConfig` computes:
  ```js
  const raw = parseEngines(process.env.SEARCH_ENABLED_ENGINES, DEFAULT_SEARCH_ENABLED_ENGINES);
  const firecrawlKey = String(process.env.FIRECRAWL_API_KEY||"").trim();
  let next = [...raw];
  if (!hasExplicit && firecrawlKey && !next.includes("firecrawl_api")) next.push("firecrawl_api");
  if (!firecrawlKey) next = next.filter(e => e !== "firecrawl_api");
  // same for exa/linkup/tavily
  ```

### 4. Schema & hot-apply — `src/config-schema.js` / `src/config-manager.js`

- Schema: `{ key:"FIRECRAWL_API_KEY", category:"search", type:"string", fallback:"", applies:"hot", description:"API key for firecrawl_api search (https://www.firecrawl.dev/app/api-keys). When empty, firecrawl_api is disabled." }`
- Manager: `FIRECRAWL_API_KEY: (config, value) => { config.firecrawlApiKey = key; process.env.FIRECRAWL_API_KEY = key; if (Array.isArray(enabled)) add/remove firecrawl_api similarly }`
- `SEARCH_ENABLED_ENGINES` applier also filters `firecrawl_api` when key missing

### 5. Search orchestration — `src/search.js`

- `isEngineDisabled(engine, config)` add branch for `firecrawl_api`
- `disabledReason` add `FIRECRAWL_API_KEY not configured — set FIRECRAWL_API_KEY to enable firecrawl_api search`
- Guard in `runSearchRoute` and `runFallbackEngineGroups` same as others
- `runSearchEngine` already forwards `limit`

### 6. Compose & env templates

- `docker-compose.yml`: `FIRECRAWL_API_KEY: ${FIRECRAWL_API_KEY:-}`
- `.env.example`: `FIRECRAWL_API_KEY=  # Firecrawl search API key (https://www.firecrawl.dev/app/api-keys) — when set, enables firecrawl_api`
- `.env.example.full`: add `# FIRECRAWL_API_KEY=` and update `SEARCH_ENABLED_ENGINES` comment to mention `firecrawl_api`
- Local `.env` (gitignored): set `FIRECRAWL_API_KEY=fc-***REDACTED***` and append `firecrawl_api` to `SEARCH_ENABLED_ENGINES`

### 7. Verification plan (search-only)

- Unit: `tests/engines.test.js` — bump `SUPPORTED_ENGINES` to 16, add `validates firecrawl_api` (backend api), add API driver test mocking fetch for `{success:true,data:{web:[{title,url,description}]}}` → asserts `results[0].snippet` and `directAnswers[0].source==="firecrawl_highlight"`
- Config: `tests/config.test.js` — default without key excludes `firecrawl_api`; with `FIRECRAWL_API_KEY` stubbed, `loadConfig` includes it
- Manual:
  ```bash
  FIRECRAWL_API_KEY=fc-***REDACTED*** node -e 'import {FirecrawlApiDriver} from "./src/engines/firecrawl-api.js"; const d=new FirecrawlApiDriver({browserOpTimeoutMs:15000, userAgent:"test", firecrawlApiKey:process.env.FIRECRAWL_API_KEY}); console.log(await d.search({query:"firecrawl search", limit:2}))'
  ```
  ```bash
  docker exec navigator curl -s -X POST http://localhost:1994/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"web_search","arguments":{"queries":["firecrawl test"],"engine":"firecrawl_api","limit":2}}}'
  ```
  Should render `**Instant Answer:**` + `**Results (2):**`
- Disabled check: unset key → `web_search engine:firecrawl_api` returns `FIRECRAWL_API_KEY not configured` with `schedulerSkip:true`

## Non-goals

- No `scrapeOptions` in search — keep 2 credits/10 results; full-page markdown can be added later as `outputType: scrape` variant without breaking contract
- No `sources:["news","images"]` or `categories:["github","research","pdf"]` exposure yet — keep `web` only
- No `tbs`/`location`/`country` filters yet — can add as optional `web_search` params later
- No ZDR/enterprise handling

## Rollout

- Code-only, no migration; docs list becomes `exa_api` + `linkup_api` + `tavily_api` + `firecrawl_api` as API routes
- After merge, set `FIRECRAWL_API_KEY` in `.env` and leave `SEARCH_ENABLED_ENGINES` unset (auto-includes) or add `firecrawl_api` explicitly

## Key handling note

- Provided key `fc-***REDACTED***` is for planning/verification only — do not commit to git (`.env` is gitignored). Templates carry placeholder `FIRECRAWL_API_KEY=` only.

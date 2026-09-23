# 34 — Tavily search engine (tavily_api) integration — search-only

**Created:** 2026-08-21
**Status:** Plan — not yet implemented
**Request:** “now lets add plan to implement Tavily, the key is `tvly-dev-***REDACTED***` only use for search”

## Goal

Add a third API-backed search route `tavily_api` mirroring `exa_api` (`plans/33_exa-search-engine.md`) and `linkup_api`:

- New driver `src/engines/tavily-api.js` extends `ApiSearchDriver`
- Registered in `src/engines/index.js` as `tavily_api` (`backend:"api"`, no pool/homeUrl)
- Uses `TAVILY_API_KEY` from environment (`process.env.TAVILY_API_KEY`, loaded via `src/config.js`)
- **Only for `web_search`** — no `web_fetch` extraction, no domain hints, no screenshot flow
- When key missing the engine is **disabled** — excluded from `select_best` and returns `schedulerSkip` when explicitly requested (same semantics as `exa_api`/`linkup_api`)

## Why Tavily fits as `*_api`

- Pure HTTP JSON, no browser navigation — same contract as other `*_api` routes: `driver.search({query, limit}) → {results, directAnswers}`
- Same orchestrator hooks: circuit breaker, `recordEngineAttempt`, `EngineScheduler`, `manager.withPageSlot` short-circuit for `backend==="api"` in `src/search.js:978`
- Cost-aware: `search_depth` controls credits (1 vs 2), `max_results` 0–20

## Design

### 1. Driver — `src/engines/tavily-api.js`

```
export class TavilyApiDriver extends ApiSearchDriver {
  id = "tavily_api";
  async search({ query, limit })
}
```

**Auth:**

- Read key from `this.config.tavilyApiKey` (populated by `loadConfig`) falling back to `process.env.TAVILY_API_KEY`
- If missing: `throw new Error("TAVILY_API_KEY not configured — set TAVILY_API_KEY to enable tavily_api search")` with `error.schedulerSkip = true`
- Header: `Authorization: Bearer <key>`, `Content-Type: application/json`, `Accept: application/json`

**Request:**

- Endpoint: `POST https://api.tavily.com/search`
- Body (search-only, fits links + instant answer):
  ```json
  {
    "query": "<normalized query>",
    "search_depth": "basic",
    "max_results": 10,
    "include_answer": "advanced",
    "include_raw_content": false,
    "topic": "general"
  }
  ```
- `max_results` respects optional `limit` (cap 1–20, default 10) — forward-compatible if `src/search.js:978` passes `limit`
- `search_depth:"basic"` balanced relevance/latency (1 credit); `advanced` highest relevance (2 credits) reserved for future `depth` param
- `include_answer:"advanced"` populates `answer` field for `directAnswers` without extra round-trip; fallback to `results[].content` if `answer` empty
- `topic:"general"` default; `news`/`finance` could be exposed later via caller param
- No `include_images`/`include_favicon` — keep payload minimal

**Response mapping (Tavily → navigator):**

- Tavily `search` returns:
  ```json
  {
    "query": "...",
    "results": [{ "title": "...", "url": "https://...", "content": "chunk1 [...] chunk2", "score": 0.9 }],
    "answer": "LLM-generated answer ...", // only if include_answer
    "response_time": 1.2,
    "request_id": "..."
  }
  ```
- Navigator `results[]`:
  - `title`: `cleanWhitespace(item.title)`
  - `url`: `normalizeUrl(item.url)`
  - `snippet`: `cleanWhitespace(item.content).slice(0,500)` — chunks already relevant snippets, no need for `raw_content`
  - Filter: `title && url`, tag `engine: this.id`
- Navigator `directAnswers[]`:
  - If `answer` present and ≥40 chars: `{ source:"tavily_answer", text: cleanWhitespace(answer).slice(0,600), url: results[0]?.url || "" }`
  - Else fallback to top result `snippet` as `tavily_highlight` if ≥40 chars (same pattern as `exa_api`/`linkup_api` `src/engines/exa-api.js:32` and `src/engines/linkup-api.js:35`)
  - Empty otherwise — global DuckDuckGo Instant Answer fetch in `src/search.js:1272` still races and populates `**Instant Answer:**` section

**Error handling:**

- Use `fetchTextWithTimeout` with `Math.min(browserOpTimeoutMs, 15000)` ms (same as `exa_api`)
- Non-2xx → `fetchTextWithTimeout` throws `HTTP <status> from https://api.tavily.com/search: <body>`; map:
  - `401` → `Tavily API authentication failed (401) — check TAVILY_API_KEY`
  - `429` → `rate limited (429)`
  - `402` → payment/credits
- `JSON.parse` failure → `Tavily API returned non-JSON: <preview>`

### 2. Registry — `src/engines/index.js`

- Import `TavilyApiDriver`, add to `DRIVER_CLASSES`
- Validation enforces API-only (no pool/homeUrl)
- `SUPPORTED_ENGINES` becomes 15; `getEngineMetadata("tavily_api")` → `{backend:"api", pool:null, homeUrl:null, isBrowser:false}`
- `getBrowserWarmupEngines` automatically excludes it

### 3. Config — `src/config.js`

- New field `tavilyApiKey: String(process.env.TAVILY_API_KEY||"").trim()`
- `DEFAULT_SEARCH_ENABLED_ENGINES` stays 12 (backward compat); `loadConfig` computes `searchEnabledEngines`:
  ```js
  const raw = parseEngines(process.env.SEARCH_ENABLED_ENGINES, DEFAULT_SEARCH_ENABLED_ENGINES);
  const tavilyKey = String(process.env.TAVILY_API_KEY||"").trim();
  let next = [...raw];
  if (!hasExplicit && tavilyKey && !next.includes("tavily_api")) next.push("tavily_api");
  if (!tavilyKey) next = next.filter(e => e !== "tavily_api");
  // same for exa/linkup
  ```
  - Explicit `SEARCH_ENABLED_ENGINES` respected verbatim
  - Without explicit list and with key, `select_best` auto-benefits

### 4. Schema & hot-apply — `src/config-schema.js` / `src/config-manager.js`

- Schema: `{ key:"TAVILY_API_KEY", category:"search", type:"string", fallback:"", applies:"hot", description:"API key for tavily_api search (https://app.tavily.com/). When empty, tavily_api is disabled." }`
- Manager: `TAVILY_API_KEY: (config, value) => { config.tavilyApiKey = key; process.env.TAVILY_API_KEY = key; if (Array.isArray(enabled)) add/remove tavily_api similarly to EXA/LINKUP }`
- `SEARCH_ENABLED_ENGINES` applier also filters `tavily_api` when key missing

### 5. Search orchestration — `src/search.js`

- `isEngineDisabled(engine, config)` add branch for `tavily_api`
- `disabledReason` add `TAVILY_API_KEY not configured — set TAVILY_API_KEY to enable tavily_api search`
- Guard in `runSearchRoute` and `runFallbackEngineGroups` same as exa/linkup
- `runSearchEngine` already forwards `limit` to driver — tavily respects it via `max_results`

### 6. Compose & env templates

- `docker-compose.yml`: `TAVILY_API_KEY: ${TAVILY_API_KEY:-}`
- `.env.example`: `TAVILY_API_KEY=  # Tavily search API key (https://app.tavily.com/) — when set, enables tavily_api`
- `.env.example.full`: add `# TAVILY_API_KEY=` and update `SEARCH_ENABLED_ENGINES` comment to mention `tavily_api`
- Local `.env` (gitignored): set `TAVILY_API_KEY=tvly-dev-***REDACTED***` and append `tavily_api` to `SEARCH_ENABLED_ENGINES` (like exa/linkup)

### 7. Verification plan (search-only)

- Unit: `tests/engines.test.js` — bump expected `SUPPORTED_ENGINES` to 15, add `validates tavily_api` (backend api), add API driver test mocking fetch for `{results:[{title,url,content}], answer:"..."}` → asserts `results[0].snippet` and `directAnswers[0].source==="tavily_answer"`
- Config: `tests/config.test.js` — default without key excludes `tavily_api`; with `TAVILY_API_KEY` stubbed, `loadConfig` includes it
- Manual:
  ```bash
  TAVILY_API_KEY=tvly-dev-... node -e 'import {TavilyApiDriver} from "./src/engines/tavily-api.js"; const d=new TavilyApiDriver({browserOpTimeoutMs:15000, userAgent:"test", tavilyApiKey:process.env.TAVILY_API_KEY}); console.log(await d.search({query:"Who is Leo Messi?", limit:2}))'
  ```
  Expected: `results[].title/url/snippet`, `directAnswers[0].text` = advanced answer
  ```bash
  docker exec navigator curl -s -X POST http://localhost:1994/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"web_search","arguments":{"queries":["tavily test"],"engine":"tavily_api","limit":2}}}'
  ```
  Should render `**Instant Answer:**` + `**Results (2):**`
- Disabled check: unset key → `web_search engine:tavily_api` returns `TAVILY_API_KEY not configured` with `schedulerSkip:true`, no circuit open, `select_best` skips

## Non-goals

- No `web_fetch` / extraction integration — search-only per request
- No `search_depth`/`topic`/`time_range` exposure yet — keep simple `basic`/`general` defaults; can add later as optional `web_search` params without breaking driver contract
- No structured `include_images`/`include_favicon` — not needed for `title/url/snippet` grounding

## Rollout

- Code-only, no migration; docs list becomes `exa_api` + `linkup_api` + `tavily_api` as API routes
- After merge, set `TAVILY_API_KEY` in `.env` and leave `SEARCH_ENABLED_ENGINES` unset (auto-includes) or add `tavily_api` explicitly

## Key handling note

- Provided dev key `tvly-dev-***REDACTED***` is for planning/verification only — do not commit to git (`.env` is gitignored). Templates carry placeholder `TAVILY_API_KEY=` only.

# 33 — Exa search engine (exa_api) integration

**Created:** 2026-08-21
**Status:** Draft → In progress
**Request:** "Implement the new engine search engine it will be called EXA ... integrate it just like how we have done for duck.Go API ... it will need an API key that API key will be set up in the environment variables" + follow-ups: "Implement it in such a way that all of its features are properly aligned with what we are doing Like when we search we give links and instant answers What you can fit in that do" + "Yes, if the API key is not defined then this engine will be disabled"

## Goal

Add a new API-backed search route `exa_api` that mirrors `duckduckgo_api`'s integration pattern:

- New driver `src/engines/exa-api.js` extends `ApiSearchDriver`
- Registered in `src/engines/index.js` as `exa_api` (backend `api`, no pool/homeUrl)
- Uses `EXA_API_KEY` from environment (`process.env.EXA_API_KEY`, loaded via `src/config.js`)
- When the key is missing the engine is **disabled** — it is excluded from `select_best` fallback and returns a clear error when explicitly requested

Search surface stays identical to existing engines:

- `web_search` with `engine: "exa_api"` or `engines: ["exa_api"]`
- `select_best` fallback via `searchEnabledEngines` (auto-includes `exa_api` only when the key is present, otherwise excluded)
- Results rendered as `links` (`title`, `url`, `snippet`, `llmText`, `ref_id`) + `directAnswers` (Instant Answer section) just like other engines

## Why Exa fits as an `*_api` route

- No browser navigation, no `submit`/`extract` — pure HTTP JSON
- Same contract as `duckduckgo_api`: `driver.search({ query }) → { results, directAnswers }`
- Same orchestrator hooks: circuit breaker, `recordEngineAttempt`, `EngineScheduler`, page-slot not used for API routes (`runSearchEngine` short-circuits via `backend === "api"`)
- Opt-in via env key keeps backward compat — CI and installs without a key see zero behavior change except the registry now lists `exa_api` as supported

## Design

### 1. Driver — `src/engines/exa-api.js`

```
export class ExaApiDriver extends ApiSearchDriver {
  id = "exa_api";
  async search({ query, limit })
}
```

**Auth:**

- Read key from `this.config.exaApiKey` (populated by `loadConfig`) falling back to `process.env.EXA_API_KEY` for tests/direct use
- If missing: `throw new Error("EXA_API_KEY not configured — set EXA_API_KEY to enable exa_api search")`
- Header: `x-api-key: <key>` (primary, per Exa docs) + `authorization: Bearer <key>` for compatibility, `accept: application/json`, `content-type: application/json`

**Request:**

- Endpoint: `POST https://api.exa.ai/search`
- Body:
  ```json
  {
    "query": "<normalized query>",
    "type": "auto",
    "numResults": 10,
    "contents": { "highlights": true, "text": { "maxCharacters": 800 } }
  }
  ```
- `numResults` respects an optional `limit` param when the orchestrator passes it (cap 1–20, default 10). Current `runSearchEngine` passes only `query`; driver falls back to 10 and `dedupeAndMergeResults(..., limit)` still slices correctly. Passing `limit` is forward-compatible if `runSearchEngine` is later updated to forward it.
- `highlights: true` gives LLM-oriented excerpts (ideal for `snippet` + `directAnswers`); `text.maxCharacters` is a fallback so empty highlights still yield a snippet without a second request

**Response mapping (Exa → navigator):**

- `data.results[]` → `results[]`
  - `title`: `cleanWhitespace(item.title)`
  - `url`: `normalizeUrl(item.url)`
  - `snippet`: `cleanWhitespace(item.highlights?.join(" ") || item.summary || item.text?.slice(0,500) || "")`
  - Filter: `title && url`
  - Tag: `engine: this.id`
- `directAnswers[]`:
  - Primary: leave empty and let the global DuckDuckGo Instant Answer fetch (already raced in `browserSearch`) populate the Instant Answer section — keeps the contract identical and avoids double-charging for an LLM summary
  - Optional enrichment: if `highlights` exists on the top result, also emit one `directAnswers` entry `{ source: "exa_highlight", text: highlights[0], url: topUrl }` — fits "links + instant answers" without adding cost (disabled by leaving `directAnswers: []`; easy to enable later)

**Error handling:**

- Uses `fetchTextWithTimeout` (same helper as `duckduckgo_api`) with `Math.min(browserOpTimeoutMs, 15000)` ms
- `fetchTextWithTimeout` throws on non-2xx with body preview; driver surfaces `HTTP 401 ...` as `EXA_API_KEY invalid` and `HTTP 402/429` with readable prefix so the circuit logs and console show the real cause
- `cleanWhitespace` + `normalizeUrl` ensure no empty URLs leak into dedupe

### 2. Registry — `src/engines/index.js`

- Import `ExaApiDriver`, add to `DRIVER_CLASSES`
- Validation already enforces API uniqueness, no pool/homeUrl — no extra code
- `SUPPORTED_ENGINES` will then contain 13 ids; `getEngineMetadata("exa_api")` → `{ backend:"api", pool:null, homeUrl:null, isBrowser:false }`
- `getBrowserWarmupEngines` automatically excludes it (API backend)

### 3. Config — `src/config.js`

- New const: `exaApiKey = (process.env.EXA_API_KEY || "").trim()`
- Add to `loadConfig()` return: `exaApiKey`
- `DEFAULT_SEARCH_ENABLED_ENGINES` stays 12 entries (backward compat). `loadConfig` computes `searchEnabledEngines`:
  ```js
  const rawEnabled = parseEngines(process.env.SEARCH_ENABLED_ENGINES, DEFAULT_SEARCH_ENABLED_ENGINES);
  // auto-include exa_api only when key is present and caller didn't set an explicit list
  const searchEnabledEngines = !process.env.SEARCH_ENABLED_ENGINES && exaApiKey
    ? [...rawEnabled, "exa_api"]
    : rawEnabled;
  ```
  - When `SEARCH_ENABLED_ENGINES` is explicitly set, we respect it verbatim (user controls opt-in)
  - When unset and no key, behavior unchanged — existing tests pass without env changes
  - When unset and key present, `select_best` automatically benefits from Exa

- Also export `exaApiKey` for driver tests that instantiate `new ExaApiDriver({ exaApiKey, ... })`

### 4. Schema & hot-apply

- `src/config-schema.js`: `{ key:"EXA_API_KEY", category:"search", type:"string", fallback:"", applies:"hot", description:"API key for exa_api search (https://dashboard.exa.ai/api-keys). When empty, exa_api is disabled." }`
- `src/config-manager.js`: `EXA_API_KEY: (config, value) => { config.exaApiKey = String(value||"").trim(); }` — plus logic to add/remove `exa_api` from `searchEnabledEngines` when the default set is in use (mirrors `loadConfig` conditional)

### 5. Compose & env templates

- `docker-compose.yml`: `EXA_API_KEY: ${EXA_API_KEY:-}` under `environment:`
- `.env.example` (minimal) + `.env.example.full` (full reference): commented line `# EXA_API_KEY=` with docs link

### 6. Search orchestration — `src/search.js`

- `runSearchRoute` for `exa_api` with missing key should not trip the scheduler as a flaky-engine failure
- Options:
  - Filter disabled API engines before `engineScheduler.select`: `engines.filter(id => id !== "exa_api" || Boolean(config.exaApiKey))`
  - And in `runExplicitEngineGroup`/`runFallbackEngineGroups` skip with `recordEngineAttempt(..., "skip", "EXA_API_KEY not configured")` instead of `fail`
  - Explicit `engine: "exa_api"` with no key → throw in driver (or early check) with `schedulerIgnore = true` so the circuit breaker isn't polluted

### 7. Verification

- Unit: `tests/engines.test.js` — add exa_api to expected SUPPORTED_ENGINES list, add API driver test mocking fetch for exa response (results + empty directAnswers), add block-detection not needed for API route
- Config: `tests/config.test.js` — default engines unchanged when no key; when `EXA_API_KEY` stubbed, `loadConfig` includes exa_api; hot-apply updates `exaApiKey`
- Manual: `curl` exa search via mocked fetch; `web_search` with `engine: "exa_api"` and with `select_best` both when key missing (skip) and when key present (results render as `- **Title** [domain](ref)` + Instant Answer section)

## Non-goals

- No browser fallback for Exa (pure API)
- No `SEARCH_QUEUE_*` tuning specific to Exa — uses existing `EngineScheduler` weights
- No streaming (`stream: true`) — JSON body is sufficient

## Rollout

- Code only — no migration
- Docs: README multi-engine list adds `exa_api` (noted as requiring `EXA_API_KEY`)
- After merge, set `EXA_API_KEY` in `.env` and either leave `SEARCH_ENABLED_ENGINES` unset (auto-includes) or add `exa_api` explicitly

## Alternatives considered

- Always include `exa_api` in DEFAULT and fail with circuit open when no key — more noise, more test churn, less "disabled" semantics the user asked for
- Separate `EXA_API_KEYS` csv — unnecessary; single key matches dashboard issuance

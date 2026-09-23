# Search Engines

Navigator has 12 engines in two flavors: **browser engines** that drive the built-in Chromium, and **API engines** that call hosted search APIs (some gated behind API keys). The automatic router picks the best one for each query.

## Engine Types

| Type | How it works | Engines |
|------|--------------|---------|
| **Browser engines** | Drive a real browser tab (Chromium), submit the query, parse the rendered SERP | `duckduckgo`, `google`, `bing`, `brave`, `mojeek`, `startpage`, `yahoo` |
| **API engines** | Direct HTTP call to a hosted search API — no browser needed | `duckduckgo_api`, `exa_api`, `linkup_api`, `tavily_api`, `firecrawl_api` |

## Browser Engines

| Engine | Notes |
|--------|-------|
| `duckduckgo` | Fast, privacy-focused |
| `google` | Best coverage, may block automation |
| `bing` | Good general coverage |
| `brave` | Privacy-focused, growing index |
| `startpage` | Google results via privacy proxy |
| `yahoo` | General web search |
| `mojeek` | Independent, UK-based |

All browser engines run on the built-in Chromium and pool tabs for reuse. Engine ids are the short names above — the old `{engine}_{backend}` route naming (`google_cb`, `bing_lp`, …) has been removed. Backend routing is internal and no longer part of the engine identity.

## API Engines

| Engine | Requires | Notes |
|--------|----------|-------|
| `duckduckgo_api` | — | Free HTML endpoint, no key. Fast and reliable |
| `exa_api` | `EXA_API_KEY` | [Exa](https://dashboard.exa.ai/api-keys) semantic search with highlights |
| `linkup_api` | `LINKUP_API_KEY` | [Linkup](https://app.linkup.so/api-keys) grounded search |
| `tavily_api` | `TAVILY_API_KEY` | [Tavily](https://app.tavily.com/) with answer mode |
| `firecrawl_api` | `FIRECRAWL_API_KEY` | [Firecrawl](https://www.firecrawl.dev/app/api-keys) web search |

An API engine is **enabled only when its key is set** — without the key it is never scheduled in `select_best` and returns a `not configured` error if requested explicitly. `duckduckgo_api` needs no key and is always available.

> Set keys via `.env` or the **Configs → Search Engines** panel at `/console/manage`. Key changes hot-reload in the running server.

## Circuit Breakers

When a search engine signals bot detection — captcha, blocked page, or timeout — Navigator detects it and puts that engine on cooldown. During cooldown:

- The engine is skipped for automatic selection
- It can still be used if explicitly requested
- After cooldown, it's tried again with a probe request
- If the probe succeeds, the engine rejoins the pool

View circuit breaker status at `/console` or via the `/health` endpoint.

## Search Windows

Navigator maintains "search windows" — pre-opened Chromium tabs ready for search. This makes subsequent searches faster because the browser doesn't need to open a new tab each time.

- Windows are pooled per browser engine (whatever its configured pool policy)
- Idle windows are cleaned up after a timeout

The pool size is bounded by two settings:

Minimum sticky windows kept warm:

> `SEARCH_KEEP_MIN_WORKING_WINDOWS=2` — default 2, always kept open per pool

Maximum pool size:

> `SEARCH_MAX_WORKING_WINDOWS=10` — default 10, hard cap per pool

## Manual Engine Selection

Force a specific engine:

```json
{
  "queries": ["specific query"],
  "engine": "duckduckgo_api"
}
```

This runs the requested engine even if it's not in the automatic pool. A keyed API engine without its key configured returns a `not configured` error.

All engine names: `duckduckgo`, `duckduckgo_api`, `google`, `bing`, `brave`, `mojeek`, `startpage`, `yahoo`, `exa_api`, `linkup_api`, `tavily_api`, `firecrawl_api`.

## Automatic Routing

With `select_best` (default), Navigator:

1. Checks which engines are healthy and enabled
2. Ranks them by recent performance (success rate, speed, result count)
3. Tries the best engine first
4. Falls back to the next engine on failure
5. Puts failed engines on cooldown (circuit breaker)

By default the `select_best` pool is `duckduckgo_api`, `brave`, `google`, `duckduckgo`, `bing`, `mojeek`, `yahoo`, `startpage` — keyed API engines are added automatically when their keys are present. Control it with `SEARCH_ENABLED_ENGINES`.

You almost never need to specify an engine manually.

## Tips

- **Let the router work** — `select_best` is almost always the right choice
- **Use `duckduckgo_api`** for fast, reliable results without browser overhead
- **Add a keyed API engine** (`exa_api`, `linkup_api`, `tavily_api`, `firecrawl_api`) when the free engines aren't enough
- **Try Google manually** if other engines don't have what you need
- **Check `/console`** if searches are failing — it shows which engines are healthy

## Next Steps

- [Results](/guides/search/results) — Understanding search output
- [Tips](/guides/search/tips) — Advanced search techniques
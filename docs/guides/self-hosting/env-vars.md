# Environment Variables

Configure Navigator through `.env` or the console at [http://localhost:1994/console/manage](http://localhost:1994/console/manage). Grouped exactly as in the console's **Configs** panel.

## Browser Array

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSERS` | `[{"name":"chromium","role":[]}]` | JSON array of browser entries — the routing table for page tools. See below |
| `CLOAKBROWSER_LICENSE_KEY` | — | License key for the CloakBrowser CDP sidecar (`docker-compose.cloak.yml`, opt-in) |
| `HEADLESS` | `auto` | Run browsers without UI — `true` when no `DISPLAY` is set, toggled by VNC |
| `CHROME_PATH` | `/usr/bin/chromium` | Path to Chromium executable |
| `CHROME_USER_DATA_DIR` | `/data/chrome` | Persistent Chromium profile directory |
| `CHROME_PROFILE_DIR` | `Default` | Chromium profile folder name |
| `PRELAUNCH_BROWSER` | `true` | Pre-launch browsers on server start |
| `STARTUP_URL` | `about:blank` | URL opened in the browser on launch |
| `BROWSER_USER_AGENT` | `Mozilla/5.0 ... Chrome/151.0.0.0` | User agent string used by the browsers |

`BROWSERS` is a JSON array. Each entry is `{ "name", "role": [], "type", "cdpUrl"?, "plugin"?, "prompt"? }`:

| Field | Values | Description |
|-------|--------|-------------|
| `name` | string | Unique browser name — used to route tools via the `browser` param |
| `role` | `default` · `search` · `fetch` · `screenshot` · `devtools` | Which tools the browser serves. `default` = everything; `search` = `web_search`; `fetch` = `web_fetch`; `screenshot` = `web_page_screenshot`/`ascii`/`svg`; `devtools` = the `browser_*` tools. An empty array makes it a fallback/backup only |
| `type` | `inbuilt` · `cdp` · `navigator-cdp` | `inbuilt` = the built-in Chromium (always present, no `cdpUrl`). `cdp` = connect to a user-provided endpoint — `ws://…` direct browser WS or `http://…` CDP server like CloakBrowser's `cloakserve`. `navigator-cdp` = a relay extension — the Chrome/Firefox plugins dial in over `/relay` |
| `cdpUrl` | URL | Required for `cdp`-type entries only |
| `plugin` | `auto` · `chrome` · `firefox` | Relay extension kind — `navigator-cdp` only |
| `prompt` | string | Optional agent-facing instruction shown in `list_browsers` (add-ons only) |

Array order is the rollback chain: the first connected browser that carries the needed role serves the call; each down add-on is reported and the chain moves on. The built-in Chromium is always present (self-healing) even when not listed.

## Search

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARCH_ROUTE_WARMUP_ENGINES` | `3 engines` | Prewarmed on start |
| `SEARCH_ENABLED_ENGINES` | `12 engines` | Eligible for `select_best` |
| `SEARCH_ROUTE_CIRCUIT_OPEN_MS` | `300000` | Route cooldown after failure (ms) |
| `EXA_API_KEY` | — | API key for `exa_api` — when empty, disabled |
| `LINKUP_API_KEY` | — | API key for `linkup_api` |
| `TAVILY_API_KEY` | — | API key for `tavily_api` |
| `FIRECRAWL_API_KEY` | — | API key for `firecrawl_api` |
| `SEARCH_KEEP_MIN_WORKING_WINDOWS` | `2` | Min warm windows kept open per pool |
| `SEARCH_MAX_WORKING_WINDOWS` | `10` | Max concurrent windows per engine |
| `SEARCH_QUEUE_MIN_INTERVAL_MS` | `30000` | Baseline min gap between calls to one engine (ms) |
| `SEARCH_QUEUE_MAX_INTERVAL_MS` | `1800000` | Cap for learned backoff (ms) |
| `SEARCH_QUEUE_ESCALATION_FACTOR` | `2` | Backoff multiplier after failure |
| `SEARCH_QUEUE_ERROR_GAP_PERCENTILE` | `0.75` | Failure-gap percentile |
| `SEARCH_QUEUE_ERROR_GAP_SAFETY` | `1.25` | Safety multiplier on failure gaps |
| `SEARCH_QUEUE_DECAY_PER_SUCCESS` | `0.75` | Backoff decay per success |
| `SEARCH_QUEUE_PROFILE_PATH` | `.cache/search-engine-profiles.json` | Persisted scheduler profile |
| `SEARCH_QUEUE_W_SUCCESS` | `0.45` | Weight: success rate |
| `SEARCH_QUEUE_W_RESULTS` | `0.15` | Weight: results per attempt |
| `SEARCH_QUEUE_W_STABILITY` | `0.25` | Weight: recent stability |
| `SEARCH_QUEUE_W_RECENCY` | `0.1` | Weight: recent-failure penalty |
| `SEARCH_QUEUE_W_RECOVERY` | `0.05` | Weight: recovery successes |
| `SEARCH_QUEUE_W_LATENCY` | `0.2` | Weight: response latency |
| `OPEN_PAGE_MAX_PARALLEL` | `6` | Max parallel `open_page` ops |
| `MAX_CONCURRENT_PAGE_OPS` | `30` | Global max concurrent page ops |
| `HUMAN_TYPING_DELAY` | `15` | Delay per typed character (ms) — `0` in Compose |

## Ops

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER_OP_TIMEOUT_MS` | `60000` | Timeout for browser ops (ms) — `25000` in Compose |
| `NAV_WAIT_UNTIL` | `domcontentloaded` | Navigation wait — `load`, `domcontentloaded`, `networkidle0`, `networkidle2` |
| `WEB_FETCH_MAX_CHARS` | `90000` | Default `maxChars` per fetch |
| `LINK_REFS` | `true` | Rewrite links to `[text](ref_id)` for `web_page_links` |
| `DEBUG` | `false` | Per-step benchmark timing logs |
| `LOG_TOOL_ERRORS` | `true` | Log errors to `logs/tool-errors.log` |
| `DISABLE_TOOLS` | — | MCP tools to hide/reject (comma-separated) |
| `DOMAIN_HINTS_PATH` | `domain-hints.json` | Path to extraction hints file |
| `ENABLE_HANG_RESTART` | `false` | Exit on hung ops so Docker restarts |
| `HANG_RESTART_TIMEOUT_MS` | `120000` | Hang threshold (ms) |

## Console

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_WEB_CONSOLE` | `true` | Serve web console at `/console` |
| `ENABLE_HTTP_HEALTH` | `false` | Serve `/health` and `/stats` |
| `ENABLE_HTTP_MCP` | `false` | Serve MCP at `/mcp` — `1` in Compose |
| `MCP_ALLOW_UNAUTHENTICATED` | `true` | Allow `/mcp` without API key |
| `ENABLE_STDIO_MCP` | `true` | Run MCP over stdio |
| `ENABLE_DEVTOOLS_MCP` | `false` | Expose devtools browser tools — `1` in Compose |
| `MCP_API_PORT` | `1994` | HTTP port |
| `MCP_API_HOST` | `http://localhost` | Host base shown in logs |
| `ENABLE_SCREENSHOT_DOWNLOAD_LINK` | `false` | Serve screenshots at `/download/` — set `1` for `output: "url"` |
| `ENABLE_SCREENSHOT_PATH` | — | Where files are stored — set absolute path like `/tmp/screenshots` for `output: "file"` |

## VNC

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_VNC` | `false` | VNC mode — `1` in Compose (toggled by console) |
| `VNC_PORT` | `1995` | x11vnc port |
| `NOVNC_PORT` | `1996` | noVNC web port (published to host) |

## Extractor

| Variable | Default | Description |
|----------|---------|-------------|
| `POST_PROCESSOR_MODELS` | `[]` | JSON array of post-processor models — see [Post-processors](/guides/extraction/ai-extractors) for `kind: "chat"` / `"mineru"` / `"api"` and per-entry `timeoutMs`/`maxInputChars`/`maxTokens`. Legacy names: `AI_EXTRACTOR_MODELS`, `READER_LM_MODELS` |

## Tips

- **Config edits hot-reload** — changes are read live via `readEnvFile`, no restart needed
- **Check `/console`** to see current values and edit live
- **Use `.env` file** — don't set variables in `docker-compose.yml` unless necessary
- **Test changes** with `curl http://localhost:1994/health` after updating

## Next Steps

- [Security](/guides/self-hosting/security) — API keys and authentication
- [Monitoring](/guides/self-hosting/monitoring) — Health checks and activity logs

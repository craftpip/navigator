# Operations, Configuration, and State

## Docker Runtime

`docker-compose.yml` runs one `navigator` service. The repository is bind-mounted at `/app`, screenshots use `/tmp/screenshots:/app/screenshots`, and the Chrome profile is persisted in the `navigator_chrome_profile_data` volume.

```bash
docker compose build
docker compose down
docker compose up -d
docker compose exec navigator curl -s localhost:1994/health
```

The container entrypoint installs production dependencies at startup. Install development dependencies in the running container before linting or Vitest:

```bash
docker compose exec navigator npm install --include=dev
docker compose exec navigator npx vitest run
```

## Configuration Model

`loadConfig()` in `src/config.js` is the single environment-to-runtime mapping. `CONFIG_SCHEMA` provides the web-console editable subset. `config-manager.js` validates values and hot-applies supported settings; `env-file.js` changes only requested assignments so comments and unrelated `.env` contents are preserved.

| Area | Important settings |
|---|---|
| Browser | `BROWSERS`, `CHROME_PATH`, `CHROME_USER_DATA_DIR`, `HEADLESS`, `BROWSER_OP_TIMEOUT_MS`, `NAV_WAIT_UNTIL` |
| Transport | `ENABLE_HTTP_MCP`, `ENABLE_STDIO_MCP`, `MCP_API_PORT`, `MCP_ALLOW_UNAUTHENTICATED`, `MCP_API_KEYS`, `DISABLE_TOOLS` |
| Search | `SEARCH_ENABLED_ENGINES`, `SEARCH_ROUTE_WARMUP_ENGINES`, `SEARCH_ROUTE_CIRCUIT_OPEN_MS`, `SEARCH_QUEUE_*`, `ENABLE_INSTANT_ANSWERS`, search-window limits |
| Extraction | `DOMAIN_HINTS_PATH`, `WEB_FETCH_MAX_CHARS`, `POST_PROCESSOR_MODELS`, stabilization and non-content selector settings |
| Capacity | `MAX_CONCURRENT_PAGE_OPS`, `OPEN_PAGE_MAX_PARALLEL`, `HUMAN_TYPING_DELAY` |
| Screenshots | `ENABLE_SCREENSHOT_PATH`, `ENABLE_SCREENSHOT_DOWNLOAD_LINK` |
| Operations | `ENABLE_WEB_CONSOLE`, `ENABLE_VNC`, `ENABLE_DEVTOOLS_MCP`, `ENABLE_HTTP_HEALTH`, ports (`MCP_API_PORT`, `VNC_PORT`, `NOVNC_PORT`), `DEBUG`, `LOG_TOOL_ERRORS`, `ENABLE_HANG_RESTART`, `HANG_RESTART_TIMEOUT_MS` |

`HEADLESS=false` is forced back to headless unless `ENABLE_VNC=1`, because a graphical display is required for headful operation. Page tools (`web_fetch`, screenshots, devtools) route to browsers from the `BROWSERS` array via `resolveBrowserParam()`. Search engines always run on the built-in Chromium, independent of the configured page browsers.

## SQLite State

`initDb()` creates `data/navigator.db` by default. SQLite uses WAL mode, normal synchronization, and a five-second busy timeout. Activity older than seven days is pruned at startup and at most once per hour.

| Table | Contents |
|---|---|
| `searches` | Search query, variants, selected routes, status, duration, result count |
| `engine_attempts` | Per-route attempt, backend, result count, outcome, and timing |
| `page_ops` | Fetch, screenshot, and page operation telemetry |
| `activity_events` | Web and DevTools tool outcome timeline |
| `usage_totals` | Durable aggregate counter totals |
| `api_keys` | Named MCP secrets and JSON tool allow-lists |
| `ref_links` | Durable URL-to-numeric-reference mappings |
| `app_state`, `schema_version` | Migration and one-time initialization state |

Search IDs and page-operation IDs have independent sequences. Consumers of `/stats/activity` must therefore keep separate search and page-operation cursors.

## Activity and Health

`activity.js` records searches, engine attempts, page operations, and tool events. `searchContext` is an `AsyncLocalStorage` context that attaches route attempts to the search that created them. The status API supplies both recent incremental activity and zero-filled trends for several durations.

### API key attribution in the activity feed

Each Live activity row is attributed to the API key that made it, and the feed renders that key's name as a pill beside the browser/backend pill. A row that has no key — a stdio call, or an unauthenticated stateless POST — renders **no** pill at all: there is deliberately no "unauthenticated" label in the feed, because that label belongs only in the row's detail modal.

Attribution is a heuristic, not a foreign key. `mcp_calls` rows carry `api_key_id` / `api_key_name` / `api_key_preview`, but the MCP tool-call handlers do not pass a `search_id` or `page_op_id` when they record, so those columns are effectively always `NULL`. `getRecentActivity()` therefore joins on time and tool instead: `findMcpCallForEntry({ ts, tool })` selects the `mcp_calls` row with the same `tool` whose `ts` is nearest within a ±10s window. `keyInfoFromCall()` normalizes a call row to `{ api_key_id, api_key_name, api_key_preview }`, or to three `null`s when nothing matches, and the same helper backs both the feed and the detail modal's API-key line.

Page operations short-circuit the join: `page_ops` has its own `api_key_*` columns, so when a page op already carries them they are used directly and no window query runs.

Two consequences worth knowing before you read the feed as an audit log. The join is per row, so attribution costs up to ~200 small indexed queries per poll, and because it is time-and-name based a burst of same-tool calls inside the window can attribute a row to a neighbouring call. In practice a small minority of rows legitimately show no key — those are the calls that were never authenticated, not dropped joins. The feed shows the key name only; the full masked preview (`nvg_…YIttW`) and the key ID are in the detail modal.

`/health` is the fast operational probe. `/stats` adds browser tabs, caches, usage totals, request rates, errors, engine route attempts, scheduler profiles, and activity. The host `navigator.js` CLI uses these endpoints:

```bash
./navigator.js statistics
./navigator.js monitoring --interval 2
./navigator.js engines
./navigator.js engines reset google
```

The base URL is resolved from `--url`, then `NAVIGATOR_URL`, then `.env` `MCP_API_HOST` and `MCP_API_PORT`, then `http://localhost:1994`.

## Web Console

The React/Vite console lives in `src/web-console/` and is served at `/console` (`/ui` and `/dashboard` are aliases). Build it on the host:

```bash
npm run console:build
```

It provides:

- Status dashboard: browser instances, target timers, route health, request trends, activity, and errors.
- Configuration management: current/effective values, hot versus recreate-required changes, backups, reset, and revert.
- MCP tool runner: dynamically generated forms from tool schemas.
- API key management: creation, revocation, and tool allow-lists.
- Domain hint editor: list, validate, test a candidate page extraction, create, update, and delete rules.
- Remote Desktop controls: enable the VNC/noVNC stack, then open or close it from one grouped control.

## Error Logging

`logToolError()` appends redacted JSON lines to `logs/tool-errors.log` when `LOG_TOOL_ERRORS=1`. The log rotates near 5 MB to `.1`. Keys resembling passwords, tokens, secrets, authorization, API keys, or cookies are masked; typed input is retained only as a character count.

`DEBUG=1` enables per-step fetch timing logs. These are operational diagnostics and intentionally remain in server source.

## VNC/noVNC

`VncManager` runs or adopts the optional graphical stack: Xvfb, fluxbox, x11vnc, and websockify/noVNC. Enabling VNC sets `DISPLAY=:99`, starts the stack, relaunches the default browser headfully, and persists `ENABLE_VNC=1` plus `HEADLESS=false`. Disabling reverses that sequence and returns to headless mode.

The manager records lifecycle steps, checks readiness, reuses existing scoped processes, and terminates owned/adopted processes on stop. Default desktop resolution is 1920x1080x24; noVNC is normally available on port 1996.

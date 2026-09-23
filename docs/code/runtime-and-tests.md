# Runtime And Tests

Navigator is a Node 20+ MCP server. It normally runs in Docker, where the same HTTP port serves MCP, health and statistics endpoints, and the optional management console. This page covers how to operate and validate that runtime; see the API and architecture pages for protocol and implementation details.

## Starting The Service

For a local stdio MCP client:

```bash
npm start
```

For the normal container deployment:

```bash
docker compose up --build -d
docker exec navigator curl -s localhost:1994/health
```

`docker-compose.yml` builds one `navigator` service, mounts the repository at `/app`, persists the Chrome profile in the named `chrome_profile_data` volume, and exposes the configured MCP port plus noVNC. The deployment defaults enable HTTP MCP, health, web console, DevTools MCP, and VNC. Put deployment settings in `.env`; `.env.example` contains the usual starting set.

The service has a 2 GB shared-memory allocation and 4 CPU / 4 GB resource limits and reservations. Keep these settings when changing browser concurrency: page work and browser tabs can consume substantial memory.

### Runtime Decisions

- The `BROWSERS` array controls which browsers are available for page operations. Page tools route through it via `resolveBrowserParam()` (explicit `browser` param, then array order, then Chromium); search engines always run on the built-in Chromium.
- `OPEN_PAGE_MAX_PARALLEL` limits concurrent URL fetches/screenshots; `MAX_CONCURRENT_PAGE_OPS` is the global browser-operation ceiling. Increase either only after checking `/stats` memory and browser-tab growth.
- `BROWSER_OP_TIMEOUT_MS` bounds browser operations. Compose uses 25 seconds; raise it for a known slow site rather than globally masking a broken route.
- `SEARCH_ENABLED_ENGINES`, warmup settings, and circuit-breaker settings control automatic search. Explicit MCP engine selection may call a registered route that is not in the automatic list.
- `DISABLE_TOOLS` hides named tools from `tools/list` and rejects calls. API-key tool allow-lists apply an additional restriction.

## Container Startup And VNC

The entrypoint starts a virtual X display, Fluxbox, x11vnc, and noVNC only when `ENABLE_VNC=1`. It reuses a live X display and removes a stale display lock only when the recorded process is no longer alive. noVNC is available on `NOVNC_PORT` (Compose default `1996`).

At every container start, the entrypoint runs `npm install --omit=dev` against the bind-mounted application. This keeps production dependencies aligned after branch changes, but it prunes development dependencies from the mounted `node_modules`. Do not rely on host-installed test tools after a restart.

Build console assets on the host, where dev dependencies are available:

```bash
npm run console:build
docker compose up -d
```

The server serves generated files from `src/web-console/dist` at `/console/`. Do not edit hashed files in that directory; edit `src/web-console/src/` and rebuild. The console polls live health, stats, activity, configuration, logs, API keys, and domain hints. Its activity feed has separate cursors for searches and page operations (`since` and `sinceOps`); consumers must retain both so rows are not skipped.

## Host CLI

`navigator.js` is an observer for an already-running HTTP service. It does not launch the MCP server.

```bash
./navigator.js statistics
./navigator.js monitoring --interval 5
./navigator.js stats --json --url http://localhost:1994
```

`statistics` (`stats`, `stat`) prints one `/health` and `/stats` snapshot. `monitoring` (`mon`) redraws it until Ctrl+C; the default refresh interval is two seconds. The endpoint URL resolves in this order: `--url`, `NAVIGATOR_URL`, `MCP_API_HOST` and `MCP_API_PORT` from `.env`, then `http://localhost:1994`.

The CLI exits non-zero for an invalid command, an unreachable service, or a failed endpoint request. The server exposes its health and statistics endpoints when either HTTP health or HTTP MCP is enabled.

## Operational Checks

Use the light endpoint first, then inspect state only when needed:

```bash
docker compose ps
docker exec navigator curl -s localhost:1994/health
./navigator.js statistics
```

`/health` reports browser connectivity, page limits, search-window state, circuit breakers, and VNC state. `/stats` adds memory, browser instance/tab counts, cache state, request and engine outcomes, and recent activity. Activity data is stored in SQLite under `data/navigator.db`; it is retained for the console and resets only if that data is removed, while in-memory caches and counters reset on service restart.

When changing server source under the bind mount, restart or recreate the container before testing. The running Node process does not reload changed modules:

```bash
docker compose restart navigator
docker exec navigator curl -s localhost:1994/health
```

For a full image/dependency refresh, use `docker compose build` followed by `docker compose down` and `docker compose up -d`.

## Package Commands

| Command | Use |
| --- | --- |
| `npm start` | Run the MCP server with configured transports. |
| `npm run console:dev` | Run the Vite console development server. |
| `npm run console:build` | Build console assets for `/console/`. |
| `npm run lint` | Lint server, scripts, tests, and console source. |
| `npm run test:hints` | Run static domain-hint tests. |
| `npm run test:hints:live` | Run opt-in real-site hint tests. |
| `npm run bench` | Run the browser-search benchmark. |
| `npm run docs` | Generate TypeDoc output. |

## Tests

Run tests inside the active container. Reinstall dev dependencies after every restart or image build because the entrypoint removes them:

```bash
docker compose exec navigator npm install --include=dev
docker compose exec navigator npx vitest run
```

Run focused tests while iterating:

```bash
docker compose exec navigator npx vitest run tests/mcp-server.test.js
docker compose exec navigator npx vitest run tests/domain-hints.test.js
```

The suite is organized by behavior, not by a strict unit/integration split:

- `mcp-server.test.js`, `search.test.js`, and `devtools.test.js` cover tool dispatch, HTTP/MCP behavior, browser workflows, and end-to-end error paths.
- `engines.test.js` and `engine-scheduler.test.js` cover route drivers, block detection, warmup, retries, scheduling, cooldown, and recovery.
- `browser.test.js` and `config.test.js` cover backend dispatch, lifecycle, and configuration parsing.
- `domain-hints*.test.js` cover hint matching, validation, persistence/API behavior, and optional live-site checks. Live tests require `LIVE_DOMAIN_HINTS=1` and should not be treated as deterministic CI tests.
- `activity.test.js`, `env-file.test.js`, `ref-memory.test.js`, `markdown.test.js`, and `mcp-api-auth.test.js` cover persistence, console data, formatting, references, and authentication boundaries.

After a user-facing change, test the relevant MCP flow and inspect the browser console/request failures when applicable. For console changes, build the assets, open `/console/`, and verify the actual generated asset referenced by `src/web-console/dist/index.html` is served.

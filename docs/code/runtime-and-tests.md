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

### Console Loading States

Two shared components in `src/web-console/src/components/ui.jsx` cover every async state in the console, and both build on the single `.activity-spinner` ring primitive in `style.css`:

- `<Loading>` renders a centered ring plus a label, replacing `Empty` while a view's first request is in flight. It is a *page-region* state: status dashboard, activity trend, hints list, Manage config. A view must not show an `Empty` state before its first request settles, or "no data" briefly reads as the truth.
- `<Spinner small />` is a *button* or *status-line* state. Prefix it in front of the control's existing busy text rather than replacing it, so the busy state is still announced without motion (and for reduced-motion users).

Both are purely visual. Keep each control's existing `disabled` expression and its `finally` cleanup untouched: a ring that outlives its request is a stuck spinner, and a control that is not disabled during a request can be double-submitted. Sub-100ms requests legitimately flash the ring — that is the expected behavior, not a failure, so do not add a minimum-display delay to smooth it out.

The Manage view's `Loading` is defensive rather than a standing hole: `main.jsx` refetches a full snapshot on every view change, so a direct deep-link to `/console/manage` already has its configuration.

### Request Activity Trend Card

The status page's `Request activity` card is self-contained in `src/web-console/src/pages/status/ActivityChart.jsx` (imported by `pages/status/index.jsx`, not defined there): `ActivityLineChart` draws the inline SVG, and `RequestActivityTrend` owns the heading, summary, range controls, legend, and engine selector. Range state (`trendRange`, `trend`, `trendError`, `changeTrendRange`) and engine state (`trendEngine`, `changeTrendEngine`) live in `main.jsx` and round-trip through the URL as `?range=` and `?engine=` (engine is omitted when `all`), so a refreshed or shared console keeps the chosen view. Data comes from `GET /stats/activity-trend`; the card shares the `.trend-drivers` grid with `Browser drivers`, so its width is coupled to that sibling's scroll container.

Two measure families keep fan-out honest. The category series (total, Web ok/fail, DevTools ok/fail) come from `activity_events` — one row per completed MCP tool call — categorized by tool prefix: `Target.`/`Page.`/`Runtime.`/`DOM.`/`Input.`/`Network.`/`Browser.` are DevTools, everything else is Web. A running operation is never counted, so restarts and in-flight work cannot inflate success totals. The engine series (Engine ok/fail) come from `engine_attempts`, one row per engine outcome. The `?engine=` filter scopes **only** the engine series and the engine footer — Web/DevTools request totals are engine-independent and deliberately stay unchanged when the selector moves, so one `web_search` never double-counts as request plus fan-out. Failure lines are dashed as well as red, so state is never color-only, and hidden/visible series recompute the shared zero-based y-scale.

Interactions: legend entries are real buttons with `aria-pressed` — clicking hides or shows a series without touching the underlying totals, and a hidden series drops out of the tooltip and the y-scale. The engine `<select>` (labeled "Search engine") switches the aggregate engine lines to one engine's trend and drives the footer's `attempt / success / failure / skipped` totals. Hovering or keyboard-focusing a bucket's hit rectangle shows a tooltip with the bucket time and every visible series value (`data-tooltip`, handled by `ImmediateTooltip`, which listens for `focusin` too); clicking or tapping pins the same text as a persistent readout in `.request-trend-detail` below the chart — a second click clears it — so touch users are not hover-dependent. The card renders explicit empty ("No request activity in this period."), loading, and error ("Could not load activity trend: …") states instead of a bare SVG.

Series colors are CSS variables (`--series-total`, `--series-web-*`, `--series-devtools-*`, `--series-engine-*`) with light and dark values, and the hit rectangles carry a `:focus-visible` stroke ring so keyboard navigation is visible. Of the `.request-trend-*` rules in `style.css`, only `.request-trend-plots`, `.request-trend-plot-heading`, and `.request-trend-switch` remain orphaned (no JSX); `.request-trend-legend` and `.request-trend-detail` are live. Treat the orphaned three as legacy, not a latent feature — delete them if the multi-plot layout is never revived.

Server-side coverage lives in `tests/activity.test.js` (range bucket shapes, engine-filter/request-total separation, running-search exclusion, 7-day prune) and `tests/mcp-server.test.js` (HTTP 400 for an unknown range or engine).

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

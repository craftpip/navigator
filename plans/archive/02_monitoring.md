# Performance Monitoring Plan

## Status: Complete — 2026-09-29

**Status: Complete** — closed 2026-09-29, archived to `plans/archive/`. Historical
note (verified 2026-08-10): NOT STARTED at the time of writing. No `/metrics` endpoint, no `prom-client`, no `src/metrics.js`, no `src/logger.js`, no structured event logging, no Grafana/Prometheus compose services. Note: the navigator-cli work (completed and absorbed into `AGENTS.md` → [Navigator CLI and Stats](../../AGENTS.md#navigator-cli-and-stats); plan archived at `plans/archive/navigator-cli.md`) already added `GET /stats` with uptime/memory/sessions/cache/instances/counters plus request + per-engine failure telemetry, which overlaps with the Phase-1 data surface but is not Prometheus-formatted or scrapeable.

### Checklist

- [ ] 1. Phase 1 — `/metrics` endpoint: add `prom-client`, create `src/metrics.js`, instrument `BrowserManager.getMetrics()`, MCP handlers, HTTP handlers, periodic 10s collection.
- [ ] 2. Phase 2 — structured event logging: `src/logger.js`, JSON event taxonomy (browser connect/disconnect, window open/close, tool call, http request, circuit open, process memory/hang/startup).
- [ ] 3. Phase 3 — Grafana dashboard: `prometheus` + `grafana` services, `docker/prometheus.yml`, dashboard rows (overview, browser health, operations, circuits, anomalies). (Lightweight alternative: cron snapshots of `/metrics`.)
- [ ] 4. Phase 4 — anomaly detection (optional): threshold warnings (slots >25, event-loop lag >500ms, RSS >3GB, circuit failures) + hang-restart liveness.

## Goal

Passively track what happens inside the container so that when load spikes or hangs occur, we can answer:

- How many tabs/pages were open when things slowed down?
- Which browser backend(s) were active?
- What operations (search, fetch, screenshot) were running?
- What was memory/CPU usage at the time?
- Were circuit breakers open? Page slots exhausted?

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                   Container                      │
│  ┌───────────────────────────────────────────┐   │
│  │         Node.js (mcp-server.js)           │   │
│  │  ┌─────────┐ ┌──────────┐ ┌───────────┐  │   │
│  │  │Browser  │ │Search    │ │MCP Server │  │   │
│  │  │Manager  │ │Engine    │ │+ HTTP     │  │   │
│  │  │         │ │Circuit   │ │Transport  │  │   │
│  │  │ chromium│ │Breakers  │ │           │  │   │
│  │  │lightpanda│ │          │ │           │  │   │
│  │  │cloakbr. │ │          │ │           │  │   │
│  │  └─────────┘ └──────────┘ └───────────┘  │   │
│  └───────────────────────────────────────────┘   │
│  ┌──────────────┐  ┌───────────┐  ┌──────────┐  │
│  │  Chromium    │  │Lightpanda │  │Cloak-   │  │
│  │  (puppeteer) │  │(stealth-  │  │Browser  │  │
│  │              │  │ panda)    │  │(stealth) │  │
│  └──────────────┘  └───────────┘  └──────────┘  │
│  ┌── Xvfb + fluxbox + x11vnc + novnc ──────────┐ │
└─────────────────────────────────────────────────┘
```

**Key processes:**
- Node.js (`mcp-server.js`) — single main process
- Chromium (puppeteer subprocess) — spawned by puppeteer
- Lightpanda/StealthPanda (`/usr/local/bin/stealthpanda`) — spawned child process
- CloakBrowser — in-process via `cloakbrowser/puppeteer` package (also puppeteer subprocess)
- Xvfb + fluxbox — X server and window manager (for VNC)
- x11vnc + websockify — VNC/noVNC servers

**Resource limits (docker-compose):**
- CPU: 4 cores reserved + limit
- Memory: 4GB reserved + limit
- SHM: 2GB

## Metrics to Capture

### 1. Process-Level Metrics (Node.js + OS)

| Metric | Source | What It Tells |
|--------|--------|---------------|
| `process_memory_rss_bytes` | `process.memoryUsage().rss` | Total memory consumed (includes C++ heap, DOM nodes) |
| `process_memory_heap_used_bytes` | `process.memoryUsage().heapUsed` | V8 JS heap in use |
| `process_memory_heap_total_bytes` | `process.memoryUsage().heapTotal` | V8 JS heap size |
| `process_memory_external_bytes` | `process.memoryUsage().external` | C++ bindings memory |
| `process_cpu_user_seconds` | `process.cpuUsage().user` | User CPU time |
| `process_cpu_system_seconds` | `process.cpuUsage().system` | System CPU time |
| `process_uptime_seconds` | `process.uptime()` | Server uptime |
| `event_loop_lag_ms` | `Date.now() - expected` | How delayed the event loop is |
| `active_handles` | `process._getActiveHandles()` | Open handles (sockets, timers) |
| `active_requests` | `process._getActiveRequests()` | In-flight async ops |

### 2. Browser Manager Metrics

Already available in `BrowserManager.buildWindowStats()` and `getHealth()`:

| Metric | Source | What It Tells |
|--------|--------|---------------|
| `browser_connected` | `browser?.connected` | Chromium alive? |
| `lightpanda_connected` | `lightpandaBrowser?.connected` | Lightpanda alive? |
| `cloakbrowser_connected` | `cloakbrowserBrowser?.connected` | CloakBrowser alive? |
| `search_windows_total` | `buildWindowStats().totalOpen` | Total search window tabs |
| `search_windows_in_use` | `buildWindowStats().totalInUse` | Busy search tabs |
| `search_windows_pending` | `buildWindowStats().totalPending` | Windows being set up |
| `search_windows_waiters` | `buildWindowStats().totalWaiters` | Processes waiting for a window |
| `search_windows_by_engine` | `buildWindowStats().byEngine` | Per-engine breakdown |
| `page_slots_in_use` | `pageSlotsInUse` | Concurrent page ops |
| `page_slots_queued` | `pageSlotWaiters.length` | Ops waiting for a slot |
| `page_slots_max` | `config.maxConcurrentPageOps` | Max allowed |
| `circuit_breakers` | `getSearchBackendHealth()` | Per-engine circuit state |

### 3. Tab/Page Metrics

| Metric | Source | What It Tells |
|--------|--------|---------------|
| `search_window_created_total` | Counter on each `search.window.opened` event | How fast new windows are created |
| `search_window_closed_total` | Counter on each `search.window.closed` event | How fast windows are released |
| `search_window_current_count` | `buildWindowStats().totalOpen` | Tab count at any moment |
| `devtools_browser_pages` | Count of active pages in devtools browser | Devtools browser load |
| `total_browser_pages_estimate` | `searchWindowCount + devtoolPages` | Rough estimate of all tabs |

### 4. MCP Tool Call Metrics

| Metric | Source | What It Tells |
|--------|--------|---------------|
| `mcp_tool_calls_total` | Counter per tool name | Which tools are used most |
| `mcp_tool_call_duration_ms` | Histogram per tool name | Slow operations |
| `mcp_tool_error_total` | Counter per tool name | Failure rates |
| `mcp_tool_result_size_bytes` | Histogram per tool name | Response sizes (bandwidth) |

### 5. HTTP Request Metrics

| Metric | Source | What It Tells |
|--------|--------|---------------|
| `http_requests_total` | Counter per path + method | Request rate |
| `http_request_duration_ms` | Histogram per path | Slow endpoints |
| `http_response_size_bytes` | Gauged per response | Output sizes |
| `http_error_total` | Counter per status code | Error rates |

### 6. Browser Sub-Process Metrics

These tell us what the *browsers* themselves are doing (not just Node's view):

| Metric | Source | What It Tells |
|--------|--------|---------------|
| `child_process_count` | Count of spawned chromium/panda processes | How many browser processes exist |
| `child_process_cpu_percent` | `ps` or `process.cpuUsage` on PID | Browser CPU usage |
| `child_process_memory_rss` | `ps` or `/proc/<pid>/status` RSS | Browser memory usage |

## Implementation Phases

### Phase 1: `/metrics` Endpoint + Prometheus Client

**Goal:** Expose all existing and process-level metrics in Prometheus text format so Prometheus can scrape them.

**Changes needed:**

1. **Add `prom-client` npm dependency** — minimal, zero-dependency Prometheus client library.
   ```json
   "prom-client": "^15.0.0"
   ```

2. **Create `src/metrics.js`** — central metrics registry:
   - Gauges for process memory, CPU, uptime
   - Gauges for browser connections, search windows, page slots
   - Gauges for circuit breaker states
   - Counters for tool calls, HTTP requests, errors
   - Histograms for tool call durations, HTTP durations

3. **Instrument `BrowserManager`** — update `getHealth()` or add `getMetrics()`:
   ```js
   getMetrics() {
     return {
       browserConnected: Boolean(this.browser?.connected),
       lightpandaConnected: Boolean(this.lightpandaBrowser?.connected),
       cloakbrowserConnected: Boolean(this.cloakbrowserBrowser?.connected),
       searchWindows: this.buildWindowStats(),
       pageSlots: { inUse: this.pageSlotsInUse, queued: this.pageSlotWaiters.length, max: this.config.maxConcurrentPageOps }
     };
   }
   ```

4. **Instrument MCP handlers** — wrap `handleToolCall`:
   - Before call: track start time
   - After call: record duration + success/error
   - Label by tool name

5. **Instrument HTTP handlers** — wrap request handler:
   - Track duration per path (search, extract, screenshot, health, mcp)
   - Track response sizes

6. **Add `/metrics` route** before `/health`:
   ```js
   if (url.pathname === "/metrics") {
     const metrics = await promClient.register.metrics();
     res.setHeader("Content-Type", promClient.register.contentType);
     res.end(metrics);
     return;
   }
   ```

7. **Set up periodic metric collection:**
   - Every 10s: collect process memory, event loop lag, browser stats
   - Update prometheus gauges with current values

### Phase 2: Structured Event Logging

**Goal:** Every significant event is logged as a structured JSON line, storable and queryable.

**Changes needed:**

1. **Add `src/logger.js`** — structured JSON logger:
   ```js
   function logStructured(level, event, data) {
     const entry = {
       t: new Date().toISOString(),
       level,
       event,
       pid: process.pid,
       ...data
     };
     process.stderr.write(JSON.stringify(entry) + "\n");
   }
   ```

2. **Migrate `logEvent`** to also emit structured JSON alongside current emoji format.

3. **Event taxonomy to log:**
   - `browser.chromium.connected` / `browser.chromium.disconnected`
   - `browser.lightpanda.connected` / `browser.lightpanda.disconnected`
   - `browser.cloakbrowser.connected` / `browser.cloakbrowser.disconnected`
   - `browser.window.opened` / `browser.window.closed` (with engine, reason)
   - `tool.call.start` / `tool.call.end` (tool name, duration, error)
   - `http.request.start` / `http.request.end` (method, path, duration, status)
   - `circuit.open` / `circuit.half_open` / `circuit.closed` (engine, failures, error)
   - `process.memory` (periodic snapshot of all memory stats)
   - `process.hang` (if hang guard triggers)
   - `process.startup` / `process.shutdown`

4. **Container log ingestion:**
   - Docker already captures `stderr`/`stdout` to `docker logs`
   - These can be forwarded to Loki, ELK, or Datadog
   - Each JSON line is parseable; grep for specific events

### Phase 3: Grafana Dashboard

**Goal:** Visual dashboard answering "what was the state when load was high."

**If using Prometheus + Grafana (self-hosted or Grafana Cloud):**

1. Add a `prometheus` service + `grafana` service to `docker-compose.yml` (or use existing infra):
   ```yaml
   services:
     prometheus:
       image: prom/prometheus:latest
       volumes:
         - ./docker/prometheus.yml:/etc/prometheus/prometheus.yml
       ports:
         - "9090:9090"

     grafana:
       image: grafana/grafana:latest
       ports:
         - "3001:3000"
       depends_on:
         - prometheus
   ```

2. Create `docker/prometheus.yml`:
   ```yaml
   scrape_configs:
     - job_name: 'navigator'
       scrape_interval: 10s
       static_configs:
         - targets: ['navigator:3000']
   ```

3. **Dashboard panels:**
   - **Row 1: Overview**
     - Uptime (gauge)
     - Memory usage (RSS, heapUsed, heapTotal) — time series
     - CPU usage (user + system) — time series
     - Event loop lag — single stat + time series
   - **Row 2: Browser Health**
     - Backend connection status (3 gauges: chromium/lightpanda/cloakbrowser)
     - Search windows over time (stacked: per-engine)
     - Page slots in use vs max (area chart)
     - Waiters queued (single stat)
   - **Row 3: Operations**
     - Tool call rate (requests/sec per tool) — time series
     - Tool call duration p50/p95/p99 — time series
     - Tool error rate — time series
     - HTTP request rate per path — time series
   - **Row 4: Circuit Breakers**
     - Circuit state per engine (heatmap or table)
   - **Row 5: Anomalies**
     - Spikes in event loop lag (>100ms)
     - Spikes in page slot waiters
     - Spikes in memory (>3GB RSS)
     - Zero browser connections when expected

**Without Prometheus/Grafana (lightweight alternative):**

Use `src/metrics.js` to expose JSON at `/metrics` and set up a cron + script to snapshot periodically:

```bash
curl -s http://localhost:3000/metrics > /data/metrics/metrics-$(date +%Y%m%d-%H%M%S).json
```

Then investigate by looking at snapshots around the time of the hang.

### Phase 4: Anomaly Detection (Optional)

**Goal:** Proactive alerts when load is abnormal.

1. Add threshold checks in the metrics collector:
   - If `pageSlots.inUse > 25` (nearly full) → log warning
   - If `eventLoopLag > 500ms` → log warning
   - If `process.memory.rss > 3GB` → log critical warning
   - If `circuitBreakers` any route has >2 failures → log warning

2. Use Docker health check to restart when hung:
   - Already exists: `ENABLE_HANG_RESTART=1` with `HANG_RESTART_TIMEOUT_MS`
   - Complement with a liveness check based on event loop lag

## Implementation Priority

1. **Phase 1 (metrics endpoint)** — immediate value, low effort. Can be done in an afternoon.
2. **Phase 2 (structured logging)** — easy to start, big debugging value. Can piggyback on existing `logEvent`.
3. **Phase 3 (Grafana dashboard)** — visual payoff, but requires Prometheus + Grafana infra.
4. **Phase 4 (anomaly detection)** — quality-of-life improvement.

## How to Investigate Past Incidents

When a hang/crash occurred:

1. **Check container logs:** `docker logs navigator --since 1h | grep -E "error|hang|timeout|circuit|memory"`
2. **Check circuit breakers:** grep for `circuit.open` with timestamps
3. **Check window count:** grep for `search.window.opened` and `search.window.closed` to compute active window timeline
4. **Check tool call timeline:** grep for `📡` (request start) and `📨` (response) — if a call has start but no end, that operation hung
5. **Check page slots:** if `pageSlotsInUse` stayed at max for long periods, the system was saturated
6. **Check memory:** if structured JSON logging is active, grep for `"event":"process.memory"` around the hang time to see the memory trend
7. **Compare with health snapshots:** if periodic metrics were saved, look at the files around the incident time

## No-Effort First Step

Before any code changes, run this to see what's already available:

```bash
# Check current health
curl -s http://localhost:3000/health | jq .

# Watch container stats in real-time
docker stats navigator --no-stream

# Check recent logs
docker logs navigator --tail 50

# Count search windows in real-time (watch for 30s)
watch -n 2 "curl -s http://localhost:3000/health | jq '.searchWindows.total, .pageLimiter'"
```

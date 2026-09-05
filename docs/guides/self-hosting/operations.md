# Operations

Health, monitoring, and security for your self-hosted Navigator.

## Health Endpoint

```bash
curl -s http://localhost:1994/health
```

Returns:

```json
{
  "ok": true,
  "backend": "cloakbrowser",
  "browserConnected": true,
  "pageLimiter": { "maxConcurrentPageOps": 30, "inUse": 0, "queued": 0 },
  "searchRouteCircuitBreakers": [...]
}
```

## Stats Endpoint

```bash
curl -s http://localhost:1994/stats
```

Returns:

```json
{
  "ok": true,
  "uptimeSeconds": 86400,
  "memory": { "rss": 125000000, "heapUsed": 45000000 },
  "sessions": 2,
  "cache": { "total": 150, "byTool": { "web_search": 80, "web_fetch": 70 } },
  "counters": { "searches": 1234, "fetches": 567, "screenshots": 89 },
  "requests": { "total": 1890, "ok": 1850, "err": 40 }
}
```

## Navigator CLI

Host-side monitor for the live server:

```bash
# One-shot snapshot
./navigator.js statistics

# Live auto-refresh (like docker stats)
./navigator.js monitoring --interval 2

# Show engine routes
./navigator.js engines

# Reset a specific route
./navigator.js engines reset google_cb
```

### Output Examples

**statistics** — one-shot snapshot:

```
NAVIGATOR STATISTICS  ─  http://localhost:1994
uptime 00:50:20  ·  rss 113.5 MB  ·  heap 50 MB

REQUESTS / FAILURE RATES ─ 8 served · 7 ok · 1 errors
┌────────┬────────┬────┬────────┬───────────┐
│ window │ served │ ok │ errors │ success % │
│ 5m     │      5 │  4 │      1 │     80.0% │
└────────┴────────┴────┴────────┴───────────┘

BROWSER INSTANCES
┌──────────────┬───────────┬──────┬──────┐
│ backend      │ connected │ tabs │ type │
│ cloakbrowser │ yes       │    1 │ cdp  │
└──────────────┴───────────┴──────┴──────┘
```

With `--json`: `{"health": {...}, "stats": {...}}`.

**monitoring** — live frame, redraws every `--interval` seconds:

```
NAVIGATOR MONITORING ─ http://localhost:1994 ─ every 2s ─ Ctrl+C to quit
uptime 00:50:20  rss 113.5 MB  heap 50 MB  sessions 3  calls 2.1/s

BROWSER INSTANCES
┌──────────────┬──────┬────────────┬──────┐
│ backend      │ tabs │ status     │ type │
│ cloakbrowser │    1 │ ● running  │ cdp  │
└──────────────┴──────┴────────────┴──────┘
```

**engines** — scheduler ranking:

```
ENGINE SCHEDULER
┌──────┬──────────────┬───────┬────────────────┬──────────────┐
│ rank │ engine       │ score │ ok/fail/results│ min interval │
│    1 │ bing_lp      │ 0.956 │ 6/0/60         │ 5m00s        │
└──────┴──────────────┴───────┴────────────────┴──────────────┘
```

**engines reset** — `Reset scheduler history for google_cb.` (or `for all.`)

### CLI Options

| Option | Description |
|--------|-------------|
| `--url <base>` | Server URL (default: http://localhost:1994) |
| `--interval <sec>` | Refresh interval for monitoring (default: 2) |
| `--json` | Output as JSON |
| `--help` | Show help |

## Web Console

Open **http://localhost:1994/console** for a visual dashboard:

- **Engine health** — 24h success bars, most-working badge
- **Browser tabs** — Live tab count, inactivity countdowns
- **Activity feed** — Searches, engine attempts, page operations
- **Configuration** — Edit settings, manage API keys
- **Domain hints** — Create, test, and manage extraction rules

## Activity Logs

SQLite (`data/navigator.db`):

| Table | Retention | Description |
|-------|-----------|-------------|
| `searches` | 7 days | Search queries, routes, timing |
| `engine_attempts` | 7 days | Per-route success/failure |
| `page_ops` | 7 days | Fetch, screenshot, page operations |
| `activity_events` | 7 days | Tool outcome timeline |

Logs are pruned hourly. The console shows real-time activity.

## Circuit Breakers

| State | Meaning |
|-------|---------|
| `closed` | Route is healthy, accepting requests |
| `open` | Route failed, in cooldown period |
| `half_open` | Cooldown expired, testing with a probe |

View status: `curl -s http://localhost:1994/health | jq '.searchRouteCircuitBreakers'`

## Authentication

By default, anyone on your network can use Navigator. Enable API key authentication:

```bash
# In .env
MCP_ALLOW_UNAUTHENTICATED=0
MCP_API_KEYS=your-secret-key-here
```

Client config:

```json
{
  "mcpServers": {
    "navigator": {
      "transport": "http",
      "url": "http://localhost:1994/mcp",
      "headers": { "Authorization": "Bearer your-secret-key-here" }
    }
  }
}
```

Separate keys with commas: `MCP_API_KEYS=key1,key2,key3`. Manage keys at `/console` — create, revoke, set tool permissions.

## Network Security

Don't expose port 1994 to untrusted networks without authentication.

## Browser Security

**Headless** (default `HEADLESS=true`) — no visible window, recommended for production.

**VNC** (port 1996) — only for debugging: `ENABLE_VNC=1`.

Browser profile persists at `/data/chrome`. For fresh sessions: `docker compose down -v && docker compose up -d`.

## Data Security

**SQLite** (`data/navigator.db`) contains activity logs (7-day), API keys (hashed), and reference IDs.

**Screenshots** may contain sensitive content:

```bash
# File output — absolute path, needs /tmp/screenshots:/app/screenshots bind
ENABLE_SCREENSHOT_PATH=/tmp/screenshots
# URL output (temporary, expires after 1 hour)
ENABLE_SCREENSHOT_DOWNLOAD_LINK=1
```

**Logs** (`logs/tool-errors.log`) — passwords and API keys are automatically redacted. Configure with `LOG_TOOL_ERRORS=1` (default) or `0`.

## Best Practices

1. **Enable authentication** in production (`MCP_ALLOW_UNAUTHENTICATED=0`)
2. **Run in an isolated network** if possible
3. **Monitor activity** via `/console` or `./navigator.js statistics`
4. **Rotate API keys** periodically
5. **Keep updated** — pull latest code and rebuild regularly
6. **Don't commit secrets** — keep `.env` out of version control

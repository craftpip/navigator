# Self-Hosting Overview

Deploy Navigator on your own infrastructure. One Docker container gives your team a private, self-hosted browser for AI agents.

## Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 2 cores | 4 cores |
| Memory | 2 GB | 4 GB |
| Disk | 10 GB | 50 GB |
| Network | Outbound internet | Low-latency to target sites |

## Docker Configuration

The compose file is the source of truth. Key sections:

### Basic Setup

```yaml
services:
  navigator:
    build:
      context: .
      dockerfile: docker/Dockerfile
    init: true
    shm_size: "2g"     # Required for Chromium
    ports:
      - "${MCP_API_PORT:-1994}:${MCP_API_PORT:-1994}"  # MCP + console
      - "${NOVNC_PORT:-1996}:${NOVNC_PORT:-1996}"      # noVNC (optional)
    volumes:
      - ./:/app
      - /tmp/screenshots:/app/screenshots
      - chrome_data:/data/chrome  # Persistent browser profile
    deploy:
      resources:
        limits:
          cpus: "4.0"
          memory: 4g
        reservations:
          cpus: "4.0"
          memory: 4g
```

### Ports

| Port | Service | Required |
|------|---------|----------|
| 1994 | MCP Server + Web Console | Yes |
| 1996 | noVNC Remote Desktop | Optional |

### Volumes

| Volume | Purpose |
|--------|---------|
| `./:/app` | Source code (bind mount for development) |
| `/tmp/screenshots:/app/screenshots` | Screenshot storage (host `/tmp/screenshots` → container `/app/screenshots`) |
| `chrome_data:/data/chrome` | Persistent browser profile |

### Shared Memory

Chromium needs shared memory. The `shm_size: "2g"` setting is required for stable browser operation.

### Resource Limits

```yaml
deploy:
  resources:
    limits:
      cpus: "4.0"     # Max CPU
      memory: 4g      # Max memory
    reservations:
      cpus: "4.0"     # Guaranteed CPU
      memory: 4g      # Guaranteed memory
```

### Environment File

Copy `.env.example` to `.env` and edit as needed:

```bash
cp .env.example .env
```

See [Environment Variables](/guides/self-hosting/env-vars) for all options.

::: info
The container runs `npm install --omit=dev` on every start, which prunes dev dependencies from the bind-mounted `node_modules`. After a restart, reinstall dev deps if you need them:

```bash
docker compose exec navigator npm install --include=dev
```
:::

## Quick Health Check

```bash
curl -s http://localhost:1994/health
```

Returns:

```json
{
  "ok": true,
  "backend": "chromium",
  "browserConnected": true,
  "pageLimiter": { "maxConcurrentPageOps": 30, "inUse": 0 }
}
```

## Next Steps

- [Environment Variables](/guides/self-hosting/env-vars) — All configuration options
- [Operations](/guides/self-hosting/operations) — Health, monitoring, and security

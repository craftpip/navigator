# navigator Documentation

This folder is the project documentation. It describes how navigator is built and how its MCP server, browser runtime, search routes, extraction pipeline, storage, and console work. The repository `README.md` is only the introduction and quick-start guide.

## Read This First

| Document | Covers |
|---|---|
| [Architecture](architecture/overview.md) | Process layout, module boundaries, request lifecycles, and data flow |
| [MCP and HTTP](api/mcp-and-http.md) | MCP tools, transports, HTTP endpoints, caching, authentication, and reference IDs |
| [Tool Reference](api/tool-reference.md) | Every web and DevTools tool, its input schema, output, limits, and failure behavior |
| [Search and Drivers](search/search-and-drivers.md) | Search orchestration, scheduler, circuit breakers, and every search driver |
| [Browser Runtime](architecture/browser-runtime.md) | Chromium, CloakBrowser, Lightpanda, page slots, browser pools, and screenshots |
| [Extraction and Hints](extraction/extraction-and-hints.md) | Page extraction, tables, links, Markdown, SEO data, and domain-hint flows |
| [MinerU-HTML GPU Sidecar](extraction/navigator-mineru-sidecar.md) | The optional AI-model post-processor sidecar: pipeline, KV-cache limits, fallback behavior, performance |
| [Operations and Configuration](operations/operations-and-configuration.md) | Environment settings, Docker, SQLite, console, monitoring, VNC, and error logging |
| [Source Map](reference/source-reference.md) | Locate the code that owns a documented behavior and follow safe change paths |
| [Implementation Guides](code/README.md) | Behavior, decisions, limits, fallbacks, and safe change boundaries for the codebase |

## System At A Glance

```text
MCP client / HTTP caller
        |
        v
src/mcp-server.js
        |-- web_search ----------> src/search.js --> engine scheduler --> src/engines/*
        |-- web_fetch -----------> src/search.js --> browser + extraction + domain hints
        |-- screenshots / ASCII --> browser runtime + pixel renderer
        |-- DevTools ------------> src/devtools.js --> persistent browser targets
        |
        +--> SQLite activity, API keys, and durable references (src/db.js)
```

## Source of Truth

The code is the source of truth. These documents describe the current source tree under `src/`; update the relevant page when a public tool, module contract, route, or configuration behavior changes.

## Development Checks

Run project checks in the container:

```bash
docker compose exec navigator npm install --include=dev
docker compose exec navigator npx vitest run
docker compose exec navigator npm run lint
```

Build the web console on the host when it changes:

```bash
npm run console:build
```

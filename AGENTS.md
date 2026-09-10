# Agents

> A Model Context Protocol (MCP) server that provides web search, page extraction, and screenshot capabilities using a real Chromium browser.

## Table of Contents

- [Tool Contract](#tool-contract)
- [Code References](#code-references)
- [Search Engine Drivers](#search-engine-drivers)
- [Agent Flow](#agent-flow)
- [Configuration](#configuration)
- [Development](#development)
- [Navigator CLI and Stats](#navigator-cli-and-stats)
- [Known Issues](#known-issues)
- [Code Philosophy](#code-philosophy)
- [Fix Patterns](#fix-patterns)
- [Project Learnings](#project-learnings)

---

## Code Philosophy

This project is in active development. Every change should improve architecture, not just patch a symptom. Small, isolated fixes accumulate into a fragile codebase over time — each one making the next change harder and riskier. The goal is the opposite: every change should make the system *easier* to change next time.

**Rules:**
- **Think deeply first.** Before writing any code, understand the full picture: module boundaries, data flow, responsibility layers, and how the change ripples across the system. Do not rush to edit — understanding the problem fully is more important than solving it quickly.
- **No small fixes.** Do not make isolated line-level patches unless the bug is genuinely trivial. If a function is poorly structured, restructure it. If a module is disorganized, reorganize it.
- **Object-oriented design.** Use classes and interfaces. Encapsulate state. Prefer composition over loose function bundles.
- **Architecture first.** Before editing code, understand the module boundaries, data flow, and responsibility layers. Changes should leave the system more organized than before.
- **Organize as you go.** If you touch a file and see a better way to structure it, do it. Technical debt compounds — pay it down while you're already there.
- **Think in systems.** A change in one module often affects others. Consider the ripple. Design interfaces that stay stable even when internals change.

---

## Tool Contract

### `web_search`

Performs broad web research using multiple search engines with automatic fallback and circuit-breaker logic.

**Input:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `queries` | `string[]` | — | One or more search queries |
| `limit` | `number` | `5` | Results per query |
| `bypassCache` | `boolean` | `false` | Skip cached data and refresh the response |
| `engine` | `string` | `select_best` | Automatic route selection, or an explicit registered route |

**Output:** `results[]` containing `{ title, snippet, llmText, ref_id, link, url }`. Every search also makes an independent DuckDuckGo Instant Answer API call (`https://api.duckduckgo.com/` with `t=navigator`) regardless of which engine runs (unless disabled via `ENABLE_INSTANT_ANSWERS=0`) — when the reply contains content it is returned as a single `directAnswers[]` entry and rendered as a `**Instant Answer:**` section between the query and the results (one answer per query). The section is omitted when the DDG reply has no content. Response order is always: query → instant answer → results → errors.

---

### `web_fetch`

Opens pages and returns cleaned, readable text content.

**Input** (choose one mode):

- `urls: string[]` — Multiple URLs
- `ref_ids: number[]` — Multiple references
- `maxChars: number` (default `90000`) — Maximum characters per page
- `bypassCache: boolean` (default `false`) — Skip cached data and refresh the response

**Output:** Per-item success/error with readable text, tables, warnings, and a page reference. The page's extractor (set by the domain hint, see the Domain Hints workflow) decides how content is rendered — tables are that extractor's job, not a separate flag. Links are shown inline as `[text](ref_id)`; resolve them with `web_page_links(ref_ids: [link_ref_id])`, then fetch with `web_fetch(ref_ids: [link_ref_id])`.

**Extractor formats** (`default.format`, or per-block `format` in flows) — the drop-downs are labeled **Extractor**: `text` (flat dump) · `html` (raw HTML in a ```html fence) · `html_to_markdown` (whole page → markdown) · `readability_to_markdown` (Readability strips nav/ads → markdown, default) · `table` / `table_json` / `table_csv` (tables-only output) · `list` (blocks only) · any configured **AI Model** id (page/element HTML sent to an AI model → markdown; falls back to `html_to_markdown` on failure or if the model isn't configured). Requests using an AI-model extractor bypass the web_fetch result cache (each call re-runs the model). Serving the model is a separate concern — navigator POSTs to either `<baseUrl>/chat/completions` (OpenAI-compatible, `kind: "chat"` — e.g. reader-lm) or `<baseUrl>/extract` (`kind: "mineru"` — the MinerU-HTML v1.1 GPU sidecar, see `docker/navigator-mineru/`). Note `jinaai/reader-lm-0.5b` is **CC-BY-NC-4.0** (non-commercial); the MinerU-HTML model carries the Tencent Hunyuan Community License.

---

### `web_page_links`

Resolves one or more link ref_ids to their full URLs. Each inline link in a `web_fetch` result renders as `[text](ref_id)` — the parenthesized number is the link ref_id. Feed that ref_id here to get the actual URL.

**Input:** `ref_ids: number[]` — One or more inline link reference IDs to resolve.

**Output:** `- (ref_id): url` lines for each resolved ref_id.

---

### `web_page_screenshot`

Captures rendered page appearance as images.

**Input** (choose one mode):

- `targetId: string` — Target id from `Target.createTarget` to screenshot an existing persistent tab
- `urls: string[]` or `ref_ids: number[]`
- `quality: "low" | "medium" | "high"` (default `medium`) — JPEG quality presets (30, 55, 75)
- `fullPage: boolean` (default `true`) — Capture entire page
- `output: "base64" | "file" | "url"` (default `base64`) — `file` and `url` depend on screenshot storage configuration

**Output:** Inline base64 JPEG, a file path, or a download URL depending on `output`. The format is always JPEG.

---

### `web_page_ascii`

Captures a webpage as a chafa-style half-block render — the real screenshot downscaled to a grid, drawn with `▀`/`█` block characters and per-cell truecolor ANSI escape codes — plus an element legend mapping markers to selectors. Use it to understand layout, colors, and where interactive elements sit. Pair with `web_fetch` for full text (the render shows shapes/blobs, not readable small text).

**Input:**

- `url: string` — Single URL
- `ref_id: number` — Numeric reference from a prior `web_search`
- `width: number` (default `100`) — Render width in characters (40–200)
- `fullPage: boolean` (default `false`) — Capture full scrollable page (default: viewport only)
- `mode: string` (default `color_ansi`) — `color_ansi` (truecolor half-blocks), `grayscale_ansi` (gray half-blocks, barely smaller), `ascii` (plain char ramp, no escape codes, ~6× smaller)
- `elementLimit: number` (default `25`) — Maximum number of elements to annotate
- `includeSelector: boolean` (default `true`) — Include CSS selectors in the legend
- `includeXpath: boolean` (default `true`) — Include XPaths in the legend

**Output:** ANSI render in a ` ```ansi ` code block + element legend markdown table.

**How it works:**
1. `page.evaluate()` scans the DOM for interactive elements (selectors from `devtools.js`, expanded).
2. `page.screenshot()` captures the viewport (or full page with `fullPage: true`) as base64 PNG.
3. `page.evaluate()` decodes via Canvas API (`createImageBitmap` → `OffscreenCanvas(cols, rows*2)` → `getImageData`), downscaling with browser averaging.
4. `src/ascii.js` maps each pair of vertical pixel rows to a half-block cell: `▀` = two different colors (fg=top, bg=bottom), `█` = same color. Escape codes are run-length encoded (emit only on color change).
5. `[N]` markers (black on yellow) are drawn last at element positions, shifted down on collision.

**Modes:** `color_ansi` (default) renders truecolor half-blocks. `grayscale_ansi` converts each pixel pair to luminance first — barely smaller than color since escape codes dominate. `ascii` drops escape codes entirely and renders one ramp char per cell (auto-selects light/dark ramp from mean luminance) — ~6× smaller, plain-text safe.

**Grid math:** `cols = width`, `rows = round(cols * (viewportHeight / viewportWidth) / 2)`. The `/2` is half-block density (each cell holds 2 vertical pixel rows), not a font guess. With `fullPage: true`, dimensions come from `pageWidth`/`pageHeight` and `asciiGridDims` caps `rows` at 200 to keep tall pages bounded.

---

### `web_page_svg`

Captures a webpage as a structured SVG render — every element is a filled `<rect>` (real bg/border/radius colors) plus `<text>` laid out with the page's own font metrics, and `<image href>` for img/canvas content. Coordinates are document-relative CSS pixels (`data-x/y/width/height` on every `<g>`, `viewBox` = page size), so the file doubles as a layout database for geometry math. Independent of `web_page_ascii` (no pixels, no legend — pure vector).

**Input:**

- `urls: string[]` | `ref_ids: number[]`
- `targetId: string` — Screenshot an existing persistent devtools tab
- `viewport: { width, height }`
- `fullPage: boolean` (default `false`) — Capture full scrollable page (tall pages clip without it)
- `elementLimit: number` (default `100`, 1–500) — Max elements captured
- `includeSelector` / `includeXpath` (default `true`) — Emit `data-selector` / `data-xpath`
- `output: "inline" | "file" | "url"` — Inline ```svg fence, or stored download (`svg-*.svg`, served like screenshots)

**Text layout engine** (`src/svg/text.js` + `src/svg/utils.js`): wrap/ellipsis are computed at build time via per-glyph em-bucket measurement (`measureTextWidth`; monospace is exact 0.6em/char). Rules that mirror browser behavior:

- **Height budget:** auto-height blocks grow with their lines, so `rect.height/lineHeight` IS the rendered line count; overflow-hidden/line-clamp boxes use the same budget as a clip.
- **Flex min-width:** boxes sized below one wrapped line keep a single line with visible overflow (browsers can't reflow below min-content); ≤10% estimate overshoot counts as fitting.
- **Hard breaks:** `innerTextVisible()` walks the live tree (sr-only/script/style subtrees rejected, `<br>` → newline) so parents don't inherit invisible text like bootstrap's "(current)".
- **Fidelity attrs:** real `line-height`, `font-weight` (≠400), `font-style: italic`, `letter-spacing`, and `text-align` center/right anchoring; lone lines vertically center in tall boxes.
- **Ellipsis:** nowrap + `text-overflow: ellipsis` truncates by measured width; clipped paragraphs append `…` on the last budget line.
- **Dedup:** container aggregate text is dropped when any contained leaf's text matches it (leaf ≥3 chars), so card titles render once.

**Media:** every `img` gets a placeholder rect + `<image href>` + alt label; `canvas` embeds `toDataURL` PNG (capped ~180KB); `iframe` gets a dashed placeholder box. `overflow:hidden`/rounded media clip via per-element `<clipPath>`.

---

## Code References

### MCP Tool Definitions

All tool schemas are defined in `getToolsListResponse()`:

| Tool | File | Lines |
|------|------|-------|
| Web tools | `src/mcp-server.js` | `getToolsListResponse()` |
| Devtools tools (19) | `src/devtools.js` | tool definitions and handlers |

### Tool Call Dispatch

| Handler | File | Lines |
|---------|------|-------|
| `handleToolCall()` — primary dispatcher | `src/mcp-server.js` | `handleToolCall()` |
| `handleDevtoolsToolCall()` — devtools dispatcher | `src/devtools.js` | `handleDevtoolsToolCall()` |
| MCP session/stateless handlers | `src/mcp-server.js` | `createMcpServer()`, `maybeStartHttpServer()` |

### MCP Server Setup

| Component | File | Lines |
|-----------|------|-------|
| `createMcpServer()` | `src/mcp-server.js` | MCP server construction |
| HTTP transport (`maybeStartHttpServer`) | `src/mcp-server.js` | HTTP server and MCP transport |
| Stdio transport | `src/mcp-server.js` | startup path |

### Key Implementation Files

| File | Purpose |
|------|---------|
| `src/mcp-server.js` | Main MCP server — tool definitions, dispatch, HTTP/stdio transport, SSE keepalive, caching, screenshot storage |
| `src/ascii.js` | ANSI/plain screenshot transformer — `buildCellGrid()`, `placeMarkers()`, `renderGrid()`, `renderPlain()`, `formatLegend()`, `transform()` |
| `src/svg/` | Modular SVG pipeline (multi-agent): `extractor.js` (Agent A — DOM capture), `text.js` (Agent B — measure/wrap), `style.js` (Agent C — gradients/shadows), `builder.js` (Agent D — assembly), `capture.js` (Agent E — Page orchestration), `utils.js` (shared geometry/XML), `index.js` barrel; `src/svg.js` is thin backward-compat re-export |
| `src/svg-diff.js` + `scripts/svg-diff.mjs` | Pixel-diff harness (`SAMPLE_PIXELS_CODE` grid vs rasterized SVG) — the long-horizon oracle |
| `src/devtools.js` | Devtools tool definitions and handlers (CDP-based browser interaction) |
| `src/search.js` | `browserSearch()`, `browserOpenAndExtract()`, `browserCaptureScreenshot()` |
| `src/browser.js` | `BrowserManager`, page lifecycle, `newPage()` |
| `src/config.js` | `loadConfig()`, env var parsing |
| `src/engines/` | Search engine driver registry — `index.js` (registry), `driver.js` (contract), `api-driver.js`, `browser-driver.js`, `util.js`, one file per engine. See [Search Engine Drivers](#search-engine-drivers) |
| `src/ref-memory.js` | Shared link ref memory (`rememberLink()`, `getRememberedLinkRecord()`, `resolveRefIdToUrl()`) — used by mcp-server and devtools |
| `navigator.js` | Host-side CLI — `statistics` / `monitoring` against the live server. See [Navigator CLI and Stats](#navigator-cli-and-stats) |

---

## Search Engine Drivers

All search-engine transport, navigation, block detection, and SERP parsing lives in `src/engines/`. `src/search.js` is the orchestrator only — it owns query normalization, circuit breakers, fallback sequencing, cross-engine dedup, result formatting, page-slot accounting, and timing logs. Driver code owns route-specific work.

**Import direction (one-way — the registry must stay dependency-free):**

```
config ------> engines
browser -----> engines
search ------> engines
mcp-server --> engines
```

`src/engines/index.js` imports no `search.js` / `browser.js` / `config.js`. `config.js` imports `SUPPORTED_ENGINES` from it.

**Driver contract** (`src/engines/driver.js`): instance properties `id`, `backend` (`api` | `cloakbrowser` | `chromium` | `lightpanda`), `pool` (`engine` | `shared`, browser drivers only), `homeUrl` (null for API drivers), `inputSelectors`, `resultSelectors`; methods `searchUrl(query)`, `search({ query })` (API only), `submit(page, query)`, `extract(page)`, `assertNotBlocked(page)` (browser drivers). Every driver returns `{ results, directAnswers }` with each item tagged `engine: this.id`.

- `BrowserSearchDriver.submit()` = goto → body wait → 500ms settle → `waitForAnySelector` with before/after `assertNotBlocked`.
- DuckDuckGo overrides `submit()` (set the form value, wait for form-submission navigation). Google and Mojeek override `assertNotBlocked()` for their block checks.
- Startpage overrides `submit()` and `extract()` to wrap them in `withNavigationRetry()` (retries on `Execution context was destroyed` / `Target closed` / `Cannot find context with specified id` up to 3×, 400ms apart). Startpage fires a transient client-side navigation ~1.4s after load that destroys the execution context exactly when the unguarded `assertNotBlocked` evaluate runs — without the retry the first search on a cold window trips the circuit breaker.
- `ApiSearchDriver` is a convenience base for API routes — no fake `homeUrl`, never browser-warmed or pooled.
- Driver `extract()` functions are plain functions referencing global `document`; tests run them via jsdom `eval` with `runScripts: "outside-only"`.

**Registry** (`src/engines/index.js`) — load-time validation (unique ids, known backends, API routes have no pool/homeUrl, browser routes have homeUrl + valid pool). Exports:
- `SUPPORTED_ENGINES` — ordered, frozen array of all registered ids (12).
- `getEngineDriver(engine, config)` — instantiates a driver or throws for an unknown id.
- `getEngineMetadata(engine)` — `{ backend, pool, homeUrl, isBrowser }`; **must NOT throw for unknown engines** (`browser.newPage()` receives arbitrary engine names).
- `getBrowserWarmupEngines(engines)` — filters configured engine ids to browser drivers only.

**Route metadata:**

| backend | pool | routes |
|---|---|---|
| `api` | — | `duckduckgo_api` (the only API route — `brave_api` was removed 2026-08-01) |
| `cloakbrowser` | engine | `duckduckgo_cb`, `google_cb`, `bing_cb`, `brave_cb`, `startpage_cb`, `yahoo_cb` |
| `chromium` | engine | `duckduckgo_ch`, `google_ch` (valid internal routes, not advertised via MCP) |
| `lightpanda` | shared | `google_lp`, `bing_lp`, `mojeek_lp` |

**Adding a route** = implement a driver in `src/engines/` and register it in `index.js`. Do not re-add engine maps to `src/search.js` — use the registry functions so one representation cannot drift. Timing logs stay in `src/search.js` (the orchestrator owns them); API drivers do not log timings.

---

## Agent Flow

1. Call `web_search` with the user's intent.
2. Select the best results using `results[].ref_id`.
3. Call `web_fetch` with the chosen `ref_ids`.
4. Synthesize the answer from extracted text.

For visual verification, call `web_page_screenshot` with the same `ref_ids`.

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHROME_PATH` | `/usr/bin/chromium` | Path to Chromium executable |
| `HEADLESS` | `true` | Run browser in headless mode |
| `BROWSERS` | `[{"name":"chromium","role":["default"]}]` | JSON array of browser entries: `{name, role[], type, cdpUrl?, plugin?}`. Each entry has a **type**: `"inbuilt"` (the built-in Chromium — always present, no options), `"cdp"` (user-provided `cdpUrl`: `ws://` direct browser WS endpoint → `puppeteer.connect({browserWSEndpoint})` or `http://` CDP server like CloakBrowser's `cloakserve` → `puppeteer.connect({browserURL})`), or `"navigator-cdp"` (our plugin interface — the extension dials us over `/relay`, navigator provides the gateway endpoint; optional `plugin`: `auto`/`chrome`/`firefox`). Un-typed entries default: `chromium` → `inbuilt`, anything else → `cdp`. Roles: `default`, `search`, `fetch`, `screenshot`, `devtools`. An **empty role array** (`"role":[]`) marks a browser fallback/backup-only. Array order = rollback chain. |
| `CLOAKBROWSER_LICENSE_KEY` | `` | License key for the `cloak-browser` CDP sidecar (optional for testing) — consumed by `docker-compose.cloak.yml`, not the main compose |
| `BROWSER_OP_TIMEOUT_MS` | `60000` application / `25000` Compose | Per-operation timeout |
| `SEARCH_ROUTE_WARMUP_ENGINES` | Application fallback routes / empty in Compose | Engines to warm up on startup; an explicit empty value disables warmup |
| `SEARCH_ROUTE_CIRCUIT_OPEN_MS` | `300000` | Per-route cooldown after failure |
| `PRELAUNCH_BROWSER` | `1` | Prelaunch browser on server start |
| `ENABLE_HTTP_MCP` | `0` application / `1` Compose | Enable Streamable HTTP transport |
| `DEBUG` | `0` | Enable per-step benchmark timing logs in `web_fetch` — logs each step (`goto_page`, `stabilize_page`, `extract_text_from_html`, etc.) with ms timing and a TOTAL summary |
| `LOG_TOOL_ERRORS` | `1` | Log every erroring tool call to `logs/tool-errors.log` (one JSON line per error, redacted args, 5MB rotation). Default on — set to `0` to disable |
| `ENABLE_INSTANT_ANSWERS` | `1` | Make the independent DuckDuckGo Instant Answer API call on every `web_search` (rendered as the `**Instant Answer:**` section). Set to `0` to disable |
| `DISABLE_TOOLS` | `` | Comma-separated MCP tool names to hide from `tools/list` and reject on call. Matched case-insensitively. Example: `web_page_ascii,web_page_links`. Empty enables all tools, including in Compose. |
| `POST_PROCESSOR_MODELS` | `` | JSON array of post-processor model entries: `[{"id":"reader_lm","label":"reader-lm-0.5b","model":"jinaai/reader-lm-0.5b","baseUrl":"http://host.docker.internal:8000/v1"}]`. Each `id` becomes an "AI Model" option in the extractor/post-processor dropdowns. Each entry may carry `"kind"`: `"chat"` (default — OpenAI-compatible `<baseUrl>/chat/completions`), `"mineru"` (POST `{html}` to `<baseUrl>/extract`), or `"api"` (custom endpoint with `body`/`outputField`/`outputType`). Per-entry `timeoutMs`/`maxInputChars`/`maxTokens` override defaults. `applies: "recreate"` — change requires a container restart. (Legacy names: `AI_EXTRACTOR_MODELS`, `READER_LM_MODELS`) |

### Key Notes

- Link-reference caches are process-local, but `ref_links` in SQLite preserves URL-to-ID mappings across restarts.
- Prefer `ref_id` / `ref_ids` immediately after a search within the same session.
- Sticky search windows are reused for performance.
- `BROWSERS` is parsed in `src/config.js` into `config.browsers`. Page tools (`web_fetch`, `web_page_screenshot`, `web_page_ascii`, `web_page_svg`) and devtools route through `resolveBrowserParam()` (`src/browser.js`): explicit `browser` param (strict, errors if down) → add-ons tried in `BROWSERS` array order (first to connect serves, each down add-on reported in `rollbackNotes`) → Chromium (always present, self-healing).
- Add-on connections are lazy and reused (`_addOnState`); a `disconnected` event clears state and the next call reconnects. Navigator never launches/closes add-ons — the user owns the external CDP process.
- An optional **`cloak-browser`** CDP sidecar (stock `cloakhq/cloakbrowser` image, `command: ["cloakserve"]`, CDP multiplexer on :9222) ships in a **separate** compose file, `docker-compose.cloak.yml` (opt-in, like the MinerU sidecar). It's the reference CDP add-on (see `plans/39_dynamic-browser-array.md` §12): the fallback-first BROWSERS shape is `[{"name":"chromium","role":[]},{"name":"cloakbrowser","role":["default","search","fetch","screenshot","devtools"],"cdpUrl":"http://cloak-browser:9222"}]`. `web_search` always runs on Chromium (engines never use add-ons). Start it with `docker compose -f docker-compose.cloak.yml up -d`; the main compose is chromium-only by default.
- An optional **`lightpanda`** CDP sidecar (official `lightpanda/browser` image, `lightpanda serve` WebSocket CDP on :9222) ships in `docker-compose.lightpanda.yml` (opt-in, same pattern). **Caveat:** Lightpanda's CDP handshake rejects hostname `Host:` headers (DNS-rebinding guard) — only IP literals pass, so the BROWSERS `cdpUrl` must reference a **static IP** (`ws://172.22.0.222:9222`), NOT the service name. No graphical render engine → screenshots are placeholders; use for speed/cost on fetch/extraction, Chromium for visuals.
- Before adding or changing config, trace the existing variable through `loadConfig()`, `BrowserManager`, and the actual call site first; do not invent a new env var or behavior until the current flow is verified end-to-end.

---

## Development

```bash
npm start                          # Run MCP server over stdio
docker compose build               # Build Docker image
docker compose up --build -d       # Build and start containers
```

### Docs site dev server (hot reload, port 5431)

The docs site (`docs/`, VitePress) has its own package.json. The dev command is `npm run docs:dev` in `docs/` — hot-reloads on every file change, served at `http://10.69.1.164:5431/`.

**Starting it from an agent shell — MUST use `setsid -f`:**

```bash
cd /www1/navigator/docs
setsid -f npm run docs:dev </dev/null >/tmp/vitepress-dev.log 2>&1 &
```

- Plain `nohup ... &` is NOT enough here: the child stays in the agent tool-call's process group/session, and when the command window closes the whole group is killed — the server dies silently within minutes (no error in logs).
- `setsid -f` forks into a brand-new session (PPID becomes 1), so nothing can group-kill it afterward. Verified surviving across many tool calls.
- Redirect all three streams (`</dev/null >log 2>&1`) and keep the launch call minimal (no curls/sleeps in the same call — they caused hangs/timeouts before).
- Verify separately after ~10s: `curl -m 4 -o /dev/null -w "%{http_code}" http://10.69.1.164:5431/` → 200.
- Stop with `kill <pid>` of the `sh -c vitepress dev` process (or `pkill -f vitepress` from a call whose own cmdline doesn't contain that string).
- Deps live in `docs/node_modules` (vitepress ^1.6.4); if missing, `npm install` inside `docs/`.
- Foreground runs always die at the tool timeout — never launch a dev server bare.

### Docs site served on port 1994 (`/docs/`)

The VitePress docs can also be built and served **inside the navigator MCP server** at `http://10.69.1.164:1994/docs/` (same port as the web console) — no separate dev-server port needed. This is the **build-and-test workflow**: `docs:dev` on 5431 is for hot-reload authoring; producing a viewable copy on 1994 means building once and serving the static output.

**How it's wired:**
- `docs/.vitepress/config.mjs` overrides `base: "/docs/"` and `outDir: "../docs-dist"` — so the build output lands in `/www1/navigator/docs-dist/` (a repo subfolder, bind-mounted into the container at `/app/docs-dist`). Default VitePress `outDir` (`.vitepress/dist`) is NOT used.
- `src/mcp-server.js` serves it: a `docsDistDir` path constant (`process.cwd()/docs-dist`), a `serveDocsAsset(res, pathname)` handler (mirrors the console handler, serves from the dist folder with traversal guard; path under `/docs/` → file, else `index.html`), and a route `url.pathname === "/docs" || startsWith("/docs/")`. `.woff`/`.woff2` content-types were added to `WEB_CONSOLE_CONTENT_TYPES` so font assets load.
- The server reads straight from the bind-mounted `docs-dist/` on every request, so **a rebuild needs NO server restart** — just swap the files and refresh.

**Rebuild command (run in-container):**
```bash
docker exec navigator sh -c "cd /app/docs && npm install --include=dev && npm run docs:build"
```
- `npm install --include=dev` is REQUIRED each time — the container entrypoint prunes dev deps (vitepress) on every restart/build, and without vitepress the build fails with `sh: vitepress: not found`.
- Verify after building: `curl -m 20 -s -o /dev/null -w "%{http_code}\n" http://10.69.1.164:1994/docs/` → 200.

**The `outDir` pitfall:** `outDir` is resolved relative to the project root (`/app/docs`), so it is `../docs-dist` (→ `/app/docs-dist`), NOT `../../docs-dist` (→ `/docs-dist` at the container filesystem root — a stray path outside the bind mount that the server never reads). If docs build output "vanishes" from `/docs/`, check where the latest build wrote to.

### Running tests

All tests run inside the container only. The entrypoint runs `npm install --omit=dev` on every container start, which prunes dev deps from the bind-mounted host `node_modules` — so reinstall dev deps after **every** restart/build, not just the first time:

```bash
docker compose exec navigator npm install --include=dev   # After every container restart
docker compose exec navigator npx vitest run              # Run all tests
docker compose exec navigator npx vitest run tests/mcp-server.test.js  # Single file
```

---

## Navigator CLI and Stats

### `navigator.js` (host command, run from the repo root)

`./navigator.js <command>` talks to the live server over HTTP. Host-only — never run inside the container. Built as a tiny subcommand dispatcher so commands can be added later (`status`, `sessions`, `cache`, `engines`, `logs`, `restart`, …).

- `statistics` (aliases `stats`, `stat`) — one-shot snapshot: engines + circuit-breaker state, browser instances (tabs/type), search windows, page limiter, MCP sessions, cache, activity counters, request + per-engine failure rates.
- `monitoring` (alias `mon`) — live auto-refreshing view (like `docker stats`), redraws every `--interval` seconds (default 2) until Ctrl+C.

Options: `--url <base>` (resolution: flag → `NAVIGATOR_URL` env → `.env` `MCP_API_HOST`/`MCP_API_PORT` → `http://localhost:3000`), `--interval <sec>`, `--json`, `--help`. Exit 0 on success, 1 if the server is unreachable (with a "is the container running?" hint).

### `GET /stats` (src/mcp-server.js)

Exposes state that `/health` deliberately hides. `/health` stays the fast liveness check; `/stats` may await `pages()` per backend.

```js
{
  ok, uptimeSeconds,
  memory: { rss, heapUsed, heapTotal },                 // process.memoryUsage()
  sessions,                                             // mcpTransports.size
  cache: { total, byTool: { web_search, web_fetch } },  // toolResultCache
  instances: [{ backend, connected, pid, tabs, type }], // BrowserManager.getInstanceStats()
  counters: { searches, fetches, screenshots, botBlocks,
              targetsCreated, targetsClosed, targetsInactivityClosed,
              cacheHits, cacheMisses },
  requests: { total, ok, err,
              byPeriod: { "5m","15m","1h","24h","all" },
              byTool, recentErrors },                   // requestLog ring buffer, REQUEST_LOG_MAX = 20000
  engineAttempts: { total, ok, fail, skip,
                    byEngine: { ... byPeriod }, recentFailures }
}
```

- Cumulative counters are in-memory and reset on restart (by design).
- `instances` come from `BrowserManager.getInstanceStats()` (`src/browser.js`) — `{connected, pid, tabCount, type}` per backend, null-safe.
- `counters` come from `getActivityCounters()` (`src/search.js`) + `getDevtoolsCounters()` (`src/devtools.js`); `requests` from `getRequestStats()`; `engineAttempts` from `getEngineAttemptStats()`.
- Request and engine-attempt telemetry feed `recordRequest()` (`src/mcp-server.js`) and `recordEngineAttempt()` (`src/search.js`) — also used to detect degrading engines before a circuit trips.

### Tool error logging (`LOG_TOOL_ERRORS`)

Default on; independent of `DEBUG` (error logs exist in production). Implementation notes:

- `logToolError()` (src/mcp-server.js, exported) appends one JSON line per error to `logs/tool-errors.log` — auto-mkdir, ~5MB rotation to `.1`, `*.log` gitignored. Entry: `{ ts, level: "tool_error", tool, transport: "mcp" | "stateless", sessionId?, ms?, args, error, stack? }`.
- Wired into BOTH error paths: the SDK `CallToolRequestSchema` handler (stdio + session HTTP) and the stateless POST `tools/call` branch (`handleStatelessMcpPost`) — the stateless path previously had no try/catch, so tool name + args were lost.
- `redactArgs` masks keys matching `/password|passwd|token|secret|api[_-]?key|authorization|bearer|cookie/i`; `Input.insertText` `text` is logged only as `"<N chars>"` (typing a password is exactly what insertText does).
- Console `❌` lines are untouched; devtools errors flow through the same two paths, so no `src/devtools.js` changes are needed.
- Tail it from the web console at `/console/logs`.

---

## Known Issues

- **"Heads up: N recent web browsing error(s)" banner is cryptic for `http:/extract` errors (TODO — handle in future).** The status banner counts `stats.requests.recentErrors` filtered to `WEB_TOOLS` non-expected errors. `http:/extract` is NOT an MCP tool — it's the internal label for the HTTP test endpoint `GET /extract?url=…&hint=<json>` used by the Domain hints editor's Test pane (`HintTestPanel`, main.jsx:4065 auto re-runs 800ms after every keystroke). A half-typed hint draft yields `invalid hint param` (server logs it via `recordActivityRequest("http:/extract", …)` at src/mcp-server.js:3102/3123/3129 — generic message, no detail on which field failed). Those errors live ONLY in the in-memory `requestLog` (never written to `logs/tool-errors.log`, so they vanish on restart or when 8 newer errors push them out of `recentErrors`). Partially fixed 2026-08-12: the console banner item is now expandable (click to see tool/time/message) and the "Recent errors" panel merges `recentErrors` into `logs` via `mergeErrorLogs()` (dedup key = tool + first line, e.g. devtools errors exist in both sources). **Still TODO:** (1) make the server error message human-readable — `hint param must be URL-encoded JSON` / name the failing field from `validateHintRule()` instead of the generic "invalid hint param"; (2) the Test pane should debounce/skip invalid JSON drafts before firing; (3) consider labeling the tool in the banner as `hint test` instead of `http:/extract`. A container restart clears stale in-memory errors and the banner.

- SSE streams die after ~5 min if there is no keepalive traffic. The MCP SDK writes to SSE only when there is actual JSON-RPC data. Any idle connection gets killed by TCP keepalive, Docker networking, or upstream proxies. Fixed with 30s SSE comment keepalive (`: keepalive\n\n`) written directly to each active stream controller via `_streamMapping`, HTTP server timeouts (`keepAliveTimeout: 300s`, `headersTimeout: 300s`, `timeout: 0`), and `retryInterval: 30000` on the transport. The SDK's `StreamableHTTPServerTransport` wraps `WebStandardStreamableHTTPServerTransport` — the internal `_streamMapping` holds all active SSE controllers (standalone GET and POST response streams). SSE comments are ignored by spec-compliant clients but keep TCP/proxy idle timers alive.

## Domain Hints Workflow

Creating extraction hints for a website is an iterative process. One site at a time, one page type at a time.

### Panel-first workflow (recommended)

The web console **Domain hints** view (`/console/hints`, `enableWebConsole`) is the
recommended authoring path — it replaces the hand-edit → `docker cp` → restart loop:

1. **List** — every hint is shown (including broken entries the cache filters out),
   with domain, page type, path, comment, and test URLs.
2. **Edit / create** in the two-pane editor (Form + JSON tabs), validated against the
   schema live (`POST /console/api/hints/validate`); Save is blocked while errors exist.
3. **Test-before-save** — the right pane runs the *candidate* hint against the real
   browser on a real URL (`/extract?hint=<urlencoded-json>`), with auto re-run while
   you type, a status bar (chars/tables/override source), Text output, an optional
   screenshot, and prominent `⚠ section selector "…" matched 0 elements` warnings.
4. **Save** — atomic write + `.bak`, `clearDomainHintCache()`, live immediately, no
   restart. Server endpoints: `GET /console/api/hints`, `POST /console/api/hints`,
    `PUT /console/api/hints/:index` (duplicate `domain|pathPattern|requireSelector`
    rejected with a 400 naming the collision — same domain+path with a different
    `requireSelector` is allowed). No delete/reorder in v1.

The manual CLI/DOM exploration routine below is still the way to *discover* the
right selectors for a tricky page; the panel is where you iterate and commit them.

### Routine (per page type)

1. **Open the page in a persistent browser tab:**
   `browser_Target_createTarget(url: "https://example.com/page")`

2. **Take a low-quality screenshot:**
   `browser_web_page_screenshot(targetId: "<id>", quality: "low")`
   See what the page looks like visually — what content matters, what's noise.

3. **Inspect the DOM document structure:**
   `browser_DOM_getDocument(targetId: "<id>", limit: 30-40)`
   Identifies structural elements, their selectors, xpaths, text, and visibility.

4. **Get outerHTML of key content containers:**
   `browser_DOM_getOuterHTML(targetId: "<id>", selector: "main"/".content"/"div.h-card", maxChars: 5000-10000)`
   Gets raw HTML of specific sections you identified in step 3.

5. **Query specific elements to verify selectors:**
   `browser_DOM_querySelectorAll(targetId: "<id>", selector: "ol.js-pinned-items-reorder-list li")`
   Confirms selector matches and captures actual text content.

6. **Test without hints first:**
   `curl "http://localhost:3000/extract?url=https://example.com/page&maxChars=2000"`
   See what the current fallback (Readability/candidate blocks) produces.

7. **Write the hint in `domain-hints.json`:**
   ```json
   {
     "domain": "example.com",
     "pathPattern": "/page-type",
     "pageType": "type-name",
     "comment": "What this page type is.",
      "requireSelector": "optional-css-selector",
      "default": {
        "waitForSelector": "selector-for-dynamic-content",
        "stabilizeStrategy": "content_idle",
        "skipSelectors": ["aside.sidebar"],
        "format": "readability_to_markdown"
      }
   }
   ```

   **`requireSelector` (optional):** When set, the rule only applies if an element
   matching this CSS selector exists on the loaded page — domain + path + this element
   must ALL match. Lets you split one domain+path into several page types (e.g. a
   profile vs a list that share a path). Candidate hints are tried in file order; the
    first one whose selector is present immediately after navigation wins, so a hint without
    `requireSelector` acts as a fallback for the same domain+path. If no candidate matches
    initially, matching is retried after stabilization. When an override selector does not
    match, extraction falls through to normal extraction and the test pane
   shows a `⚠ requireSelector "…" not found — hint did not apply` note.

  **Content type hint in selector comment:** Mention what the selector targets — single text (one line), list (multiple items), mixed (text block, multi-line).

  **Labels are optional everywhere** (flow step labels, block labels, section labels, field labels). An empty/blank label prints no markdown heading: no `## step`, `### block`, or `**field:**` prefix — the content itself is emitted bare. Validation only rejects non-string labels (and flow step labels over 80 chars).

   **Rule of thumb for flow extract blocks:**
   - Selectors must NOT overlap — one element should not be a child of another selected element.
    - `high` priority blocks are always included. `medium` blocks are included only if they have 50+ chars of text.
    - `low` priority blocks are reserved for future use.
    - Use `default.format: "html_to_markdown"` when normal extraction should skip Readability. The extractor (`default.format`) decides everything about output rendering — including tables (`table` / `table_json` / `table_csv` = tables-only output). There is no separate `tables` toggle.
   - Select ONLY the container that has the useful content. Exclude UI elements: buttons, block/report forms, follow buttons, empty tables, achievement badges, "Learn more" links, form labels, sticky bars.
   - For profile sidebars: prefer `div.js-profile-editable-area` (bio + stats + details) over `div.h-card` (includes block/report noise). Add separate sections for name (`h1.vcard-names`) and status (`div.user-status-message-wrapper`) if needed.
   - For lists of items: select the `<ol>` or `<ul>` container directly (e.g., `ol.js-pinned-items-reorder-list`). The extraction code auto-detects `<ol>/<ul>` and renders each `<li>` as a separate block with a blank line between items.
   - For single text items: use the most specific container (e.g., `h1.vcard-names`, `div.p-note`). These are rendered as flat list lines.

8. **Deploy and test:**
   ```bash
    docker compose restart navigator
   curl "http://localhost:3000/extract?url=https://example.com/page&maxChars=2000"
   ```

9. **Compare output with screenshot:**
   - Is all important content present?
   - Is there noise that should be excluded?
   - Is the formatting clean (markdown lists for sections)?
   - Are tables extracted properly?

 10. **Tune and repeat** until output is clean. Then move to the next page type for the same domain, then the next domain.

### Routine for interactive / multi-page hints (flow)

Same idea, but the page changes as you script it — verify each state in the browser
before writing the flow steps:

1. **Open the page** in a persistent tab and screenshot it (see steps 1–2 above).
2. **Capture the initial DOM** — `browser_DOM_getDocument(targetId, limit: 30-40)` and
   `browser_DOM_getOuterHTML` on the content container. These become the first
   `extract` step's blocks.
3. **Inspect the control** — find the click/type target and its result container in
   the DOM snapshot. Confirm the exact selector and that it matches one element.
4. **Drive it in the live tab**: `browser_Input_dispatchMouseEvent` (click) or
   `browser_Input_insertText` (type). Then re-inspect the DOM to capture the
   post-interaction content — these become the next `extract` step's blocks.
5. **Confirm the result gate**: the selector the flow should wait on after the
   interaction (`waitForSelector`). Verify it appears only after the click/submit.
6. **Write the hint with `flow`** — extract/click/type/navigate steps in order, each
   `extract` carrying its own `content.blocks` — then test with `/extract` exactly as
   in steps 8–10 above. The response should read top-to-bottom as the page changed.

For multi-page flows (navigate steps), use the linked page URL and verify its content
container the same way.

**Per-step `stabilizeStrategy`:** stabilization tuning lives on the step, not on
`flowOptions`. Every gated step (`wait`, `click`, `type` with submit, `navigate`) carries
a `stabilizeStrategy` (`network_idle` | `content_idle` | `mutation`, default `network_idle`
falls back to `default.stabilizeStrategy` / wildcard hint's `default.stabilizeStrategy`). The engine
stabilizes immediately after that step's selector gate succeeds. `none` opts out — the
step gates on its selector and moves on without stabilizing. A `wait` step acts as
"wait for selector, then stabilize" — its `selector` is optional: blank = skip the
selector gate entirely and just re-stabilize the page (handy for late-rendering SPAs like
NSE; add a selectorless `wait` with `stabilizeStrategy: "network_idle"`). Unless
`stabilizeStrategy: "none"`. A `click` step's
`waitForSelector` is optional — without it the step clicks and moves on, stabilizing only
when `stabilizeStrategy` is explicitly set (a gated click keeps the default stabilization
when unset). With step-level
`content_idle`, the content wait is scoped to the step's own gate element (the step's
`selector` / `waitForSelector` target) — `default.waitForContent` is only consulted by the
default (non-flow) stabilization method. There is no `flowOptions.stabilizeStrategy` — that
field is rejected as unknown.

### Known pitfalls


- `cleanAndTruncateText` used to call `cleanWhitespace` which collapsed newlines with `\s+`. Now uses `[^\S\n]+` to preserve newlines. If section output appears as a single run-on line, check that the fix is deployed.
- `waitForSelector` is fast when the selector exists (~1ms–374ms). When it does not exist (e.g., `div[data-testid="markdown-body"]` on GitHub), it silently times out at 20s. Use a correct selector and `default.stabilizeStrategy` rather than a fixed post-navigation delay.
- **GitHub selectors:** GitHub uses `.markdown-body` (class-based), NOT `div[data-testid="markdown-body"]`. The `data-testid` attribute does not exist on GitHub pages. For issue/PR detail pages, use `.comment-body` for content sections (picks up the issue description + comments).
- The `/extract?url=` endpoint is for quick testing. The actual MCP `web_fetch` tool goes through the same `browserOpenAndExtract()` path.
- **Selectors must not overlap** — one selected element should not be a child of another. Otherwise content appears in multiple sections.
- **Noisy content** comes from UI elements inside a selected container (buttons, modals, block/report forms). Use the most specific selector possible that excludes these. If `div.h-card` includes block/report UI, use `div.js-profile-editable-area` instead. If a Follow button is inside the profile area, check if a more specific container excludes it.
- **Empty tables** (all body cells empty or whitespace-only) are now filtered out via `hasDataContent` check in `extractTablesFromDocument`. Tables must have at least one body cell with >2 chars of text content.
- **"Extractor", not "Format"** — the dropdowns (`default.format` and per-block `format`) are labeled **Extractor** in the console because they pick the extraction method (which engine converts HTML → text), not a render format. The block dropdown also carries `list` and any configured AI Model ids; the default-extraction dropdown omits `list` (meaningless whole-page) but includes the `table*` formats and AI ids.
- **No "Table extraction" dropdown anymore** — `default.tables` (all/content/disabled) was removed from the schema and the console. Tables are now the extractor's job: `readability_to_markdown` keeps what Readability keeps, `html_to_markdown` renders markdown tables, `text` shows whatever the flat dump captures, and `table` / `table_json` / `table_csv` return **tables-only** output. To get tables on a table-heavy page, pick a `table*` extractor — there is no separate toggle. Old hints carrying a `tables` key are migrated (stripped) on load; the console warns once.
- **AI extractors fall back** — an AI Model extractor that errors (model down, not configured, empty reply) silently falls back to `html_to_markdown` with a console warning, so a dead reader-lm or mineru endpoint degrades to full-HTML markdown instead of failing the fetch.
- **Short values** like "7" (following count) can be lost because `uniqueLines` filters lines with `length < 3`. To preserve them, the parent element should be selected so the full text (e.g., "116 followers · 7 following") stays together.
- **Duplicated content across page states** (e.g., desktop + mobile versions of the same section) causes duplicate lines. `uniqueLines` filters exact duplicates, but different text content passes through. Use a selector that targets only one state when possible (e.g., prefer `div.user-status-container:not(.d-md-none)` over the classless version).
- **Smart hints, not smart code.** Do NOT add auto-detection logic (list detection, content type detection) in search.js. Formatting decisions belong in the hint — choose precise selectors that naturally produce clean output. The section extraction code stays simple: textContent → lines → dedup → render as flat list items.
- **Link reference IDs** appear inline as `[text](ref_id)`. Resolve them with `web_page_links(ref_ids: [link_ref_id])`, then visit them with `web_fetch(ref_ids: [link_ref_id])`.
- **test without the hints first** as step 6 before writing the hint to see what's missing.
- **Path pattern matching:** `/*` means one segment (`/foo`), `/*/*` means two segments (`/foo/bar`), `/**` means everything. Uses `compileGlob` which converts `*` to `[^/]*`. The special case for `/*` was removed — it now uses `compileGlob` like everything else. Trailing slashes are stripped from both the pathPattern and the URL pathname before matching, except when the pattern ends with `/**`.
- **Hint matching is first-match:** The first hint that matches wins. List hints from most specific to least specific (profile before repo, then issues, etc.). GitHub entries are ordered: profile (`/*`), repo (`/*/*`), issues (`/*/*/issues`), prs (`/*/*/pulls`).
- **`requireSelector` splits one domain+path:** With `requireSelector` set, the first hint in file order whose selector exists immediately after navigation wins — a hint without `requireSelector` is the fallback for the same domain+path. If none match initially, matching is retried after stabilization; the test pane reports `⚠ requireSelector "…" not found — hint did not apply` when an override hint's selector is missing.
- **GitHub selector stability:** GitHub uses React + Turbo and CSS-module classes change per build. Use stable selectors like `h1.vcard-names`, `div.js-profile-editable-area`, `ol.js-pinned-items-reorder-list`, `article.markdown-body`, `li[role="listitem"]` (issues/PRs list). Avoid CSS-module class names. For repo pages, `article.markdown-body` is inside Turbo + React, so wait for it specifically.

---

## Fix Patterns

- When debugging extraction issues, use the browser devtools (`browser_Target_createTarget`, `browser_Runtime_evaluate`, `browser_DOM_getDocument`, `browser_web_fetch`) to inspect the live page and test Readability's output directly in the browser. Do NOT guess by reading code — the browser tools are faster and show the actual runtime state.
- Before modifying skip selectors in the wildcard hint (`domain: "*"`, `default.skipSelectors`), check whether removing semantic elements like `header`/`footer` could strip page content. These elements commonly hold real content on portfolio and personal sites. Let Readability handle them naturally instead of pre-removing them.

- When adding SSE keepalive to MCP transports, write SSE comment frames (`: keepalive\n\n`) directly to each stream controller via `transport._webStandardTransport._streamMapping` — do NOT use `notifications/message` through `transport.send()` as that creates real JSON-RPC traffic the client must process. Dead controllers throw on `enqueue()` and get cleaned up from the mapping.
- Always copy Map entries to an array before iterating if you plan to delete during the loop (`[...map.entries()]`).
- The `retryInterval` option on `StreamableHTTPServerTransport` sends an SSE `retry:` field telling clients when to reconnect. Without it, the client guesses or gives up.
- The MCP SDK's `server.ping()` sends a request _to_ the client and waits for a response — that is not a keepalive. SSE comments (lines starting with `:`) are the correct idle-traffic mechanism.
- **POST handler must use exact session ID match** (`mcpTransports.get(sessionId)`) — never `resolveTransport()` which falls back to any available transport. The SDK's `validateSession()` rejects requests where the session ID in the header doesn't match the transport's own session ID (returns 404), causing "Session terminated" errors and unnecessary reconnect loops.
- **Keepalive outer catch must NOT delete transports** — if `transport._webStandardTransport` throws during a close sequence, skip it instead of calling `mcpTransports.delete(sid)`. The SDK's own `onclose` handler will clean up when the session is truly dead.
- Container deploy flow: `docker compose build && docker compose down && docker compose up -d`. Never `npm install` on the host. For console-only changes, always run `docker exec navigator npm install --include=dev && docker exec navigator npm run console:build`; the container runs as root and owns `src/web-console/dist`.
- Project documentation explains intent, end-to-end behavior, conditions, fallbacks, decisions, operational impact, and safe change boundaries. Do not turn it into a line-by-line code paraphrase or a mechanical symbol inventory; use source references only to help maintainers trace the behavior.

## Project Learnings

### Report Browser-Tool Failures and Improvement Ideas Instantly

**Created:** 2026-08-21

**The rule — make it a reflex:**
1. **Every failure gets an analysis.** Whenever a navigator browser tool (web tools or devtools) fails, errors, or returns an unexpected result, the very next message to the user must include a failure-output analysis: what was called, what came back, why it likely failed, and what that means.
2. **Improvement ideas are mandatory, not optional.** Whenever using the browser tools and something is hard to get done, or the tool could be improved (better errors, more parameters, different defaults, clearer messages, missing capability), tell the user instantly — in the moment, not as an afterthought. Do not silently work around tool limitations.
3. **No silent workarounds.** If you hit a wall with a tool and find a workaround, still surface the underlying issue. The user treats every stumble as potential signal for the next tool improvement.

**Why:** This project's whole value is the navigator MCP server itself. Every friction point the agent hits is a bug report or a feature request waiting to be filed — the user is actively improving the tools and wants the pain surfaced immediately instead of being absorbed silently.

### Never Miss a Message — Capture Every Instruction in the Todo List

**Created:** 2026-08-13

**Trigger:** User repeatedly found that when they gave multiple instructions (either in one message or as follow-ups while I was mid-task), I dropped or under-delivered on some of them — e.g. the multi-query fix, the bypass-cache fix, removing the plural `engines` param, and restarting the server so the new tool schema was actually live.

**The rule — make it a reflex, not a habit:**
1. **Enumerate first, act second.** The moment a message arrives, scan it for EVERY distinct instruction and write each one into the todo list (`todowrite`) BEFORE touching any code. One message = one todo per instruction, no matter how small ("restart the server", "update the docs", "also remove from UI").
2. **Mid-task interruptions get appended, never merged or forgotten.** When new instructions arrive while working, append them to the todo list immediately, then finish the current step and move on in FIFO order. Re-read the user's message after finishing to confirm nothing was left behind.
3. **Multiple instructions in one sentence = multiple todos.** "Fix the cache AND remove engines AND restart" is three todos, not one.
4. **Closing the loop = the final todo.** For user-facing fixes, always include a verification step that makes the change actually visible (e.g. `docker restart navigator` so a schema/code change takes effect, then `curl /mcp` or the web UI to confirm). "Code is correct on disk" is NOT done — the running server must show it.
5. **If unsure whether anything was missed, ask.** A quick "did I miss anything?" beats shipping half the work.

**Why this bites here specifically:** source files are bind-mounted into the container, so the live server keeps running the old module code until `docker restart navigator`. A fix "on disk" is invisible to the user — treating restart + verification as part of the todo list is what made the `engines` removal actually show up in the tool UI.

### Do Not Remove Debug Console Logs

Do not remove `console.log` / `console.error` calls from `src/search.js` or other server source files. These are the primary debugging tool for tracing server behavior in production. Only remove them if the user explicitly asks.

### Console Redesign — SQLite Activity DB, Two-Cursor Feed, Tab Timers

**Created:** 2026-08-11

**What:** Console status page now leads with search-engine health (24h success bars, most-working badge, health sort), drivers show inline tabs with per-tab inactivity countdowns, and a Live activity panel streams searches + engine attempts + page ops from a SQLite DB (`data/navigator.db`, gitignored, 7-day prune, WAL). Modules: `src/db.js`, `src/activity.js`, `src/tab-timers.js`.

**Durable facts:**
- `initDb()` defaults to `process.cwd()/data` (container cwd `/app` = bind mount → host `data/`). `DATA_DIR` env is NOT read by db.js. Host smoke tests writing activity rows will pollute the live DB unless run from a temp cwd.
- `recordDbEngineAttempt` takes an **options object** and gets its `search_id` FK from `searchContext` (AsyncLocalStorage) — it MUST be called inside `searchContext.run({ searchId }, …)`. `browserSearch` already does this (src/search.js:1238).
- `searches` and `page_ops` have **independent id sequences** — a single `since` cursor across both drops rows. `GET /stats/activity` takes `since` (searches) and `sinceOps` (page_ops) separately; the console tracks two refs.
- Activity rows store `ts` as epoch ms (`Date.now()`), not ISO. `formatTime` in main.jsx must handle epoch-ms (and epoch-s < 1e12).
- Feed merge lives in `App.load()` and `feed` is passed as a direct prop to `StatusView` — stuffing it into `snapshot` state creates a stale-closure bug because `load` is captured by the mount-once effect.
- Console deploy: always build inside the running container: `docker exec navigator npm install --include=dev && docker exec navigator npm run console:build`. The bundle is written to the bind-mounted `src/web-console/dist`, which the server serves immediately; no image rebuild or container restart is needed. Verify the new hashed `assets/index-*.js` is what `index.html` references.
- New CSS vars needed by the console: `--gold` (countdowns, most-working badge) — defined in both `:root` themes.

**Unfinished:** commit is pending; plan checklist in `plans/console-redesign.md` §6 has the full log.

### Browser Backend Dispatch Verification + Lightpanda Screenshot Caveat

**Created:** 2026-08-11
**Superseded:** 2026-08-28 — plan 39 eliminated `BROWSER_BACKEND`/backends entirely; browsers are a `BROWSERS` array (`chromium` built-in + CDP add-ons). See the Configuration table and Key Notes above.

**What:** Verified the two variables that select page backend — `BROWSER_BACKEND` (env) and the engine override in `BrowserManager.newPage()` — across all four backends (`chromium`, `cloakbrowser`, `lightpanda`, `lightpanda-fork`). 6/6 test cases passed: both variables dispatch every backend correctly, and the two lightpanda variants are never silently reused for other backends.

**Lightpanda screenshot caveat:** `web_page_screenshot` returns an image when the page is on lightpanda (page opened on the fork's CDP, `page.screenshot()` → `Page.captureScreenshot`; chromium is never involved). **However**, upstream Lightpanda has no graphical rendering engine (official docs + issue #507) — its CDP screenshot is a placeholder. The installed StealthPanda fork returns a 1920×1080 image; pixel analysis showed white bg + black text + Wikipedia-blue accents (real-looking), and the stakeholder confirmed the image is an acceptable test image. **Accepted as-is.** For a faithful visual render, use `BROWSER_BACKEND=chromium|cloakbrowser` or the devtools tab (chromium). Lightpanda should not be the default for screenshot-heavy use.

**Verdict:** The end user wanted lightpanda as the default backend and got it; the screenshot tool returns an image on that backend. No code change needed.

### SSE Keepalive and Stream Lifecycle

**Created:** 2026-07-15

Hermes agent reported browser tools disappearing after ~5 min. Container logs showed constant `🤝 MCP initialized` — the SSE stream was dying and the client kept re-initializing. The SDK's `StreamableHTTPServerTransport` has zero built-in keepalive. It only writes to SSE streams when there is actual JSON-RPC data to send. Between tool calls the connection is completely silent. Added a 30s `setInterval` that sends SSE comment frames (`: keepalive\n\n`) directly to each active stream controller via `transport._webStandardTransport._streamMapping`. This matches the approach in the upstream SDK PR (#1726) which adds a native `keepAliveInterval` option. SSE comments are spec-compliant idle traffic that keeps TCP/proxy timers alive without creating JSON-RPC messages the client must process. Also configured HTTP server timeouts (`keepAliveTimeout: 300s`, `headersTimeout: 300s`, `timeout: 0`) and `retryInterval: 30000` on the transport.

**SDK status check (2026-07-15):** Verified the `keepAliveInterval` feature is NOT in installed SDK 1.27.1 or latest available 1.29.0 — the `webStandardStreamableHttp.js` files are identical. The PR exists but hasn't shipped. Our manual implementation is the correct approach until the SDK ships it natively.

**Root cause discovered (2026-07-15):** Keepalive alone wasn't enough — sessions still died every ~6 minutes. The actual root cause was in `resolveTransport()` at line 1280: POST handler used the fallback chain (exact → `defaultMcpSessionId` → ANY transport), routing requests to the wrong transport. SDK's `validateSession()` returned 404 ("Session not found"), causing "Session terminated" → reconnect loop. The GET handler worked because it patched the header (line 1385-1386), but POST handler didn't. Additionally, the keepalive outer catch block was deleting transports from `mcpTransports` on `_webStandardTransport` access errors, permanently removing sessions. Fixed by: (1) POST handler uses exact-match `mcpTransports.get(sessionId)` instead of `resolveTransport()`, (2) outer catch skips instead of deleting. Verified 30+ minute session stability after both fixes.

### MCP HTTP Compatibility With Stateless Clients

**Created:** 2026-06-25
**Last updated:** 2026-06-25

**Trigger:** OpenCode reported the MCP server as down even though the container and `/health` endpoint were healthy.

**Mistake:** Verified only container health and search behavior. The real failure was in `/mcp` POST routing for stateless JSON-RPC clients.

**Root cause:** `src/mcp-server.js` reused an existing `StreamableHTTPServerTransport` for plain `POST /mcp` requests without an `Mcp-Session-Id`. That forced stateless clients onto a session transport and caused errors like `Mcp-Session-Id header is required` or `Not Acceptable`.

**Correct approach:**

1. Check `docker exec <container> curl -s localhost:3000/health` first.
2. Test stateless MCP directly with `curl` against `POST /mcp` using `tools/list` and `tools/call`.
3. Test real MCP session flow with an MCP SDK client or `mcporter`, not just direct module calls.
4. In `src/mcp-server.js`, only route POST requests through an existing streamable transport when the client explicitly sends `Mcp-Session-Id`.
5. After the fix, verify `web_search`, `web_fetch`, and `web_page_screenshot` through MCP using `url`, `urls`, and `ref_id` inputs.

**Verification:**

- `curl -s http://localhost:3000/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` returns tool metadata.
- `npx --yes mcporter list local-navigator --config <config>` succeeds.
- `npx --yes mcporter call local-navigator.web_search ...` succeeds.
- `/health` ends with `pageLimiter.inUse: 0` after page and screenshot tests.

### Git Push Safety

- Before pushing, inspect every commit in `origin/main..HEAD`; require both author and committer to be `Boniface Pereira <bonifacepereira@gmail.com>`. Do not push mismatched commits. Ask for explicit approval before rewriting them, then verify identities again.

### Creating a GitHub Release with Proper Notes

**Created:** 2026-06-25
**Last updated:** 2026-06-25

**Trigger:** The first release tag was pushed with `generate_release_notes: true`, which produced only a changelog link instead of meaningful notes.

**Correct approach:**

1. Merge `dev` into `main` (fast-forward).
2. Tag the release: `git tag v<version> -m "<message>"`
3. Push the tag: `git push origin v<version>`
4. The workflow auto-creates a bare release — write proper notes immediately:
   ```bash
   gh release edit v<version> --notes-file - << 'NOTES'
   ## Title

   Write proper release notes with features, fixes, and a changelog link.
   NOTES
   ```
5. Alternatively, create the release from the CLI with full notes before the workflow runs.

**Release notes format:**

```
## Project Name vX.Y.Z

### Features
- Major capabilities

### What's Included
- What ships with the release

**Full Changelog**: <link>
```

**Verification:** `gh release view v<version>` returns full notes, not just a changelog link.

---

### Branch Switch & Docker Deploy Workflow

**Created:** 2026-06-13
**Last updated:** 2026-06-13

**Trigger:** User asked to check out a branch, build, and restart the container.

**Mistake:** Ran `npm install` on the host instead of using `docker compose build`. The project is fully containerized.

**Correct approach:**

1. `git checkout <branch-name>`
2. `docker compose build`
3. `docker compose down && docker compose up -d`
4. Verify: `docker exec <container> curl -s localhost:3000/health`

**Verification:** Health endpoint returns `{"ok":true}` with the expected backend and no open circuit breakers.

---

### Diagnosing Container Health

**Created:** 2026-06-11
**Last updated:** 2026-06-11

**Trigger:** User asked whether the containerized MCP server was working.

**Mistake:** Ran host-level diagnostics (`ps aux`, `journalctl`, `strace`) instead of Docker commands. The container was healthy; the real issue was open circuit breakers on all search routes.

**Correct approach:**

1. `docker ps -a` — Check container status.
2. `docker logs <container>` — Check runtime errors.
3. Read `docker-compose.yml` — Understand configuration.
4. `docker exec <container> curl -s localhost:3000/health` — Check health endpoint (includes circuit breaker status).
5. `docker exec <container> ps aux` — Check processes inside the container.

**Verification:** Health endpoint returns `{"browserConnected":true,"lightpandaConnected":true}`.

---

### Container Outbound Internet (DOCKER-USER iptables)

**Created:** 2026-06-11
**Last updated:** 2026-06-11

**Trigger:** All search engines timed out despite the host having internet. `curl` from inside the container returned `000`.

**Mistake:** Investigated code, circuit breakers, and iptables chains before checking basic container connectivity.

**Root cause:** The `DOCKER-USER` iptables chain had `RETURN` for RELATED/ESTABLISHED, a VPN subnet, and loopback, followed by a catch-all `DROP`. Outbound NEW connections from Docker bridge networks fell through to the DROP rule.

**Correct approach:**

1. `docker exec <container> curl -s --max-time 5 https://duckduckgo.com`
2. If that fails: `docker exec <container> curl -s --max-time 5 http://1.1.1.1`
3. On the host: `iptables -L DOCKER-USER -n -v`
4. Fix: `sudo iptables -I DOCKER-USER 4 -s 172.16.0.0/12 -j ACCEPT`

> **Note:** This fix is not persistent across reboots. Add it to a startup script.

**Verification:** `docker exec <container> curl -s --max-time 5 https://duckduckgo.com` returns HTTP 200.

---

### Docker Compose Comment Style

**Created:** 2026-06-26
**Last updated:** 2026-06-26

**Trigger:** User wanted the docker-compose.yml to be friendlier for first-time devs.

**Style rules:**

1. Group env vars by topic with section headers.
2. Put the 5-8 most commonly changed vars at the top with a "Most commonly changed" header.
3. Comments should be short and human — `name (port) — what it's for` pattern. No over-explaining or robotic phrasing.
4. Ports that are optional (VNC/noVNC) should be commented out with a single note explaining why you'd uncomment them.
5. Self-explanatory ports (MCP) need only a brief label comment like `# MCP port (3000) — where the server listens for tool calls`.
6. Consistent comment formatting across the file.

**Verification:** A dev can open the file and know which env vars to touch within 30 seconds.

---

### Link Extraction — Always On, Compact Format

**Created:** 2026-07-25

**What:** Links are always extracted and rendered inline as `[text](ref_id)` in `web_fetch` output. Resolve a link ID with `web_page_links(ref_ids: [ref_id])`. There is no `extractLinks` flag.

**Why:** Inline Markdown destinations make link IDs unambiguous without adding a separate noisy links section.

**Key changes:**
- `src/search.js` — `browserOpenAndExtract()` always calls `extractLinksFromHtml()`. Removed `extractLinks` parameter.
- `src/mcp-server.js` — `openTargetsParallel()` registers links with `rememberLink()` and rewrites their Markdown destinations to reference IDs.
- `src/mcp-server.js` — Removed `extractLinks` from `web_fetch` schema.
- `ref-memory.js` stores the URL mapping, so `web_fetch(ref_ids: [link_ref_id])` resolves correctly.

**Flow:**
1. `web_fetch(urls: ["..."])` → clean text + tables with inline link IDs
2. `web_page_links(ref_ids: [4])` → resolves link 4 to its URL
3. `web_fetch(ref_ids: [4])` → fetches the linked page

**Verified on:** NSE India option chain (255 links, no prices in link output, web_fetch link resolution works end-to-end)

---

### Table Extraction — Always On, No Flag

**Created:** 2026-07-25
**Superseded:** 2026-08-16 — see plan `plans/22_jina-reader-lm-extractor.md`. The default path
no longer appends `### Table N` sections unconditionally, and there is no `default.tables`
toggle anymore. **The extractor is now the single source of truth for tables:**
- `table` / `table_json` / `table_csv` extractors return **tables-only** output (the old
  always-on behavior, on demand).
- Content extractors render tables however that engine naturally does: `html_to_markdown`
  → markdown tables via Turndown; `readability_to_markdown` → whatever Readability keeps;
  AI models → markdown tables from the full HTML they receive; `text` → whatever the flat
  dump captures.
- This supersedes the "always on, no flag" design — the old `### Table N` append still exists
  but only inside the tables-only extractors' flow (and legacy Readability output is clean
  because Readability strips raw tabular noise).

**What (was):** There is no `includeTables` flag. `web_fetch` always extracted tables from the HTML via JSDOM and appended them as clean pipe-separated structured tables (`### Table N`). The Readability text was used as the base (it naturally strips inline tabular content), so raw tab-separated table noise is eliminated.

**Why (was):** The raw SEO text (browser `innerText`) always contains table data as tab-separated noise (106+ rows for NSE). There was no point letting that noise through raw when it could always be parsed into a clean format. Removing the flag simplified the API — the LLM never needed to decide whether to include tables.

**Key changes (was):**
- Removed `includeTables` parameter from `web_fetch` schema, `handleToolCall`, `openTargetsParallel`, and `browserOpenAndExtract`.
- `selectedText` always used `extracted.text` (Readability text) as the base — avoided raw tabular data while keeping article content.
- `extractTablesFromDocument()` always ran and `insertTablesInline()` always appended structured tables.

**Verified on (was):** NSE India option chain (0 tab rows in output, clean structured table)

---

---

### `[text][ref_id]` Format Ambiguity With Numeric Link Text — RESOLVED

**Created:** 2026-07-28
**Resolved:** 2026-08-14 — inline refs now render as `[text](ref_id)` (see plan `plans/18_markdown-link-ref-format.md`).

**What (was):** The `[text][ref_id]` inline format was ambiguous when link text is numeric.
`Python [5][88] [1][89]` — the LLM can't tell whether `[1]`, `[5]`, `[20]` etc. are
link text or ref_id markers. Both are just `[number]`. The ref_id registry also has
nav-chrome links (ref_id 1 = page URL, ref_id 20 = `https://github.com/features`)
which match the numeric text values, so guessing wrong resolves to the wrong URL.

**Trigger (was):** Debugging web_fetch output for `https://github.com/craftpip` — spent
too long analyzing code paths instead of reading the output the user showed.

**Resolution:** The ref_id is now the destination of a proper Markdown link —
`[text](ref_id)` — so `[5][88]`-style collisions become `[documentation](88)`. Numeric
link text is enriched with the anchor text (`isNumeric && enriched` in `openTargetsParallel`).
Search result labels and page headers follow the same form: `- **Title** [domain](ref)`,
`### [Title](ref)`, `web_page_links` → `- (ref): url`.

---

### ASCII Screenshot — Chafa Half-Block Approach

**Created:** 2026-07-25
**Last updated:** 2026-08-01

**What:** The ASCII screenshot tool (`web_page_ascii` / `src/ascii.js`) renders a **chafa-style truecolor half-block render** — the real screenshot downscaled to a grid, drawn with `▀`/`█` block characters and per-cell RGB ANSI escape codes. The structural wireframe (`─│┌┐└┘` boxes) was **replaced entirely** by this approach on 2026-08-01.

**Approach evolution (rejected in order):**
1. Photographic luminance-ramp ASCII (`$$$`, `@@@` character ramps) — **rejected**, no color, looks like noise.
2. Structural wireframe (`─│┌┐└┘` boxes + `<tag> text` labels) — **rejected**, no actual pixels, can't see the page.
3. **Chafa half-blocks + truecolor — chosen.** Real colors, 2× vertical density, compact RLE output.

**Architecture:**
- `src/pixel-sampler.js` — Browser-side sampling. `SAMPLE_PIXELS_CODE` runs in `page.evaluate()`: base64 PNG → `createImageBitmap` → `OffscreenCanvas(cols, rows*2)` → `getImageData`. Returns a packed RGB grid. `asciiGridDims(vw, vh, width)` computes `rows = round(cols * (vh/vw) / 2)`.
- `src/ascii.js` — Pure transformer: takes RGB grid + elements + dims, returns `{ ansi, legend, placed, stats }`. Zero browser dependency. Exports `buildCellGrid()`, `placeMarkers()`, `renderGrid()`, `formatLegend()`, `transform()`.
- `scripts/ascii-screenshot.js` — CLI harness (screenshot + sample + render).

**Key decisions:**
- Each terminal cell holds **2 vertical pixel rows** — top row → fg color, bottom row → bg color. `▀` = different colors, `█` = same color. The `/2` in the grid math is half-block density, not a font guess.
- **Run-length encoding**: emit `\x1b[38;2;R;G;Bm` / `\x1b[48;2;R;G;Bm` only when the color pair changes. Solid backgrounds collapse to one escape + a char run.
- **Three render modes** (`mode` option): `color_ansi` (truecolor), `grayscale_ansi` (luminance → gray), `ascii` (plain char ramp, no escapes). Grayscale is barely smaller than color because escape codes dominate size; `ascii` is ~6× smaller and plain-text safe. `ascii` auto-picks the ramp direction from mean luminance (`@%#*+=-:. ` for light pages, ` .:-=+*#%@` for dark).
- Markers `[N]` are **black on yellow** (`\x1b[0m`-aware), drawn last at element top-left grid coords, shifted down on collision. Out-of-grid elements appear in legend only.
- `eval()` required for code strings in `page.evaluate()` — `new Function()` doesn't serialize through puppeteer.
- Use `window.scrollX`/`scrollY` offset in element extraction so positions are document-relative, not viewport-relative.
- Filter elements to viewport (or page, with `--full-page`) only (with 50px margin) — off-screen elements clutter the render.
- **Full page:** `page.screenshot({ fullPage: true })` + `asciiGridDims(pageWidth, pageHeight, width, maxRows=200)` — dims come from page size, rows capped at 200 so long pages stay bounded.

**Size reality (boniface.pe, 1920×947):** PNG 45.9KB, ASCII @100cols 10.6KB (0.23×), @180cols 30.8KB (0.67×). Text-heavy pages churn more colors, so the RLE savings shrink; still always smaller than the PNG.

**Readability reality:** The render shows layout, colors, shapes, and images — NOT readable small text (resolution limit, same as chafa in a real terminal). The LLM reads text from the element legend; the render supplies spatial context.

**Files:**
- `src/ascii.js` — exports `buildCellGrid()`, `placeMarkers()`, `renderGrid()`, `formatLegend()`, `transform()`
- `src/pixel-sampler.js` — exports `SAMPLE_PIXELS_CODE`, `asciiGridDims()`
- `scripts/ascii-screenshot.js` — CLI harness with `ELEMENT_EXTRACT_CODE` (content-priority extraction)
- `ASCII screenshot.md` — Full plan with research findings

**Verified on:** example.com, Hacker News, boniface.pe

---

### Truncation Indicator for web_fetch

**Created:** 2026-07-26

**What:** When `web_fetch` output exceeds `maxChars`, a truncation note is appended at the end of the text.

**Why:** Previously, the LLM had no way to know when content was truncated. The article text was truncated to `maxChars`, but tables (extracted separately) could push the total output far beyond `maxChars` with no indicator.

**Implementation (Option B — awareness only):**
- `src/search.js:2019` in `browserOpenAndExtract()` — after `insertTablesInline()`:
  ```js
  if (maxChars && finalText.length > maxChars) {
    finalText += `\n\n*(Response truncated — increase maxChars to see more)*`;
  }
  ```
- No re-truncation of the output — just appends the note when the total exceeds `maxChars`.
- The note uses `*(italic)*` markdown so LLMs notice it naturally.

**Trade-off:** Tables can still exceed `maxChars` (no re-truncation), which is intentional — this is the less-breaking approach. If re-truncation is needed later, the check is already in place.

---

### Website Exploration for Extraction Design

**Created:** 2026-07-25

**Status:** In progress — ~50 websites across 13 categories in `websites/` directory. See `websites/` for individual entries. 22 news sites explored (14 Indian + 8 global) with DOM inspection written to `websites/news.md`. GitHub (Profile, Repo, Issues, PRs), HN, Wikipedia, Stack Overflow, Dev.to, npm, freeCodeCamp also explored in `websites/developer.md` and `websites/reference.md`.

**Key lesson (2026-07-25):** Write findings to the file immediately after each site exploration, not in batches. Earlier explorations (India Times, HT, Aaj Tak, etc.) were batch-processed and lost from context during compaction before being saved. Only later edits (BBC, CNN, Guardian, Al Jazeera) were saved immediately after each site. File edits persist through compaction; in-memory context does not.

**What we're doing:** Inspecting real websites' DOM structure to understand how content is laid out, so we can design a general-purpose extraction tool. We are NOT using `web_fetch` (the tool we're building) to do this — that would be circular.

**Site exploration routine (exact steps):**

For each site:

1. **Open page in a persistent browser tab:**
   ```
   browser_Target_createTarget(url: "https://example.com/page")
   ```
   This uses a real Chromium browser (cloakbrowser backend) and renders JS.

2. **Take a low-quality screenshot:**
   ```
   browser_web_page_screenshot(targetId: "<id>", quality: "low")
   ```
   To see what the page actually looks like visually.

3. **Inspect the DOM document structure:**
   ```
   browser_DOM_getDocument(targetId: "<id>", limit: 30-40)
   ```
   Gets all important elements, their selectors, xpaths, text, and visibility. This shows the structural outline of the page.

4. **Get outerHTML of key content containers:**
   ```
   browser_DOM_getOuterHTML(targetId: "<id>", selector: "main" (or specific class/id), maxChars: 5000-10000)
   ```
   Gets the raw HTML of main content areas. Pick selectors based on step 3 (e.g., `main#content`, `article.markdown-body`, `turbo-frame#user-profile-frame`).

5. **Run JS to get page-level stats:**
   ```
   browser_Runtime_evaluate(targetId: "<id>", expression: "JSON.stringify({...})")
   ```
   Things to measure:
   - `document.title` — page title
   - `document.querySelectorAll('a').length` — total link count
   - `document.querySelectorAll('script').length` — script count (JS heaviness)
   - Presence of key frameworks: `!!document.querySelector('turbo-frame')` (Turbo), `!!document.querySelector('react-app')` (React)
   - Content availability: `document.querySelector('article')?.innerText?.substring(0, 200) || 'none'`

6. **Close the tab:**
   ```
   browser_Target_closeTarget(targetId: "<id>")
   ```

7. **Write findings to the corresponding file in `websites/` directory:**
   - Update the extraction table (SEO, Readability, Tables, Links, Screenshot columns)
   - Document the DOM structure (use indented code blocks with `├──` tree)
   - Note page-level stats (link count, script count, framework usage)
   - Note quirks (SPA, bot protection, timing issues, etc.)
   - Describe how extraction SHOULD work for this site (which strategy fits)

**Things to look for:**
- Is the site server-rendered or SPA? Check script count + presence of React/Turbo/Vue
- Is there a timing issue? Does content appear immediately or after JS?
- Is there bot protection? (Cloudflare, etc.)
- Are there semantic HTML elements? (`<article>`, `<main>`, `<nav>`, `<table>`)
- Are there microdata/structured data attributes? (schema.org `itemprop`, RDFa)
- What are the useful CSS selectors for content areas?
- What content should be excluded? (nav, footer, sidebar, ads)
- How many links are there and what fraction are useful vs. navigation?
- What kind of tables and are they useful content or layout/nav?

**Categories to explore (13 files in `websites/`):**
1. `developer.md` — GitHub (profile, repo, issues, PRs), Stack Overflow, HN, Dev.to, daily.dev, npm, freeCodeCamp
2. `finance.md` — NSE India (done), Moneycontrol
3. `news.md` — NDTV, India Times, Hindustan Times, Aaj Tak, The Hindu, Indian Express, The Quint, News18, ABP Live, Firstpost, The Print, Scroll, Deccan Herald, The Tribune
4. `business-news.md` — Livemint, Business Standard, Financial Express, Economic Times
5. `weather.md` — Weather.com, AccuWeather, BBC Weather, Windy, IMD, OpenWeatherMap, timeanddate, Skymet
6. `ecommerce.md` — Amazon India, Flipkart
7. `social.md` — Reddit, LinkedIn
8. `sports.md` — Cricbuzz
9. `food-travel.md` — IRCTC, Zomato, Swiggy
10. `ai-chat.md` — ChatGPT, Claude AI
11. `video.md` — YouTube
12. `reference.md` — Wikipedia
13. `README.md` — Category index / legend

### web_fetch Output Formats Are Read-Time Formatters

**Created:** 2026-08-02

**What:** Adding a new output format to `web_fetch` (e.g., `format: "json"`) means adding a new response formatter — never touching extraction. The extraction pipeline already returns structured data internally; markdown is the lossy flattening, not the source.

**Why:** `browserOpenAndExtract()` / `openTargetsParallel()` entries are already structured: `{ ref_id, ok, title, url, text, tables: [{context, headers, rows}], links: [{ref_id, url, text}], seo }`. The cache stores this structured payload (`setCachedToolResult(name, cacheKeyArgs, fullResult)`), and formatting happens on read — both cache-hit (src/mcp-server.js:1369) and cache-miss (line 1952/1965) paths run `formatOpenPageResponse(truncated)`. The `/extract` HTTP endpoint (src/mcp-server.js:3086) does the same.

**Key facts:**
- Cache key for web_fetch is `excludeMaxChars(getCacheArgs(args))` — `maxChars` is excluded; `format` must also be excluded (read-time concern, cache stays format-agnostic).
- Truncation applies via `truncateResultsText(payload, maxChars)` BEFORE formatting, so any new formatter gets it for free.
- MCP tools return text content; a JSON formatter returns the JSON string as the text content (`JSON.stringify(payload, null, 2)`), not `structuredContent`, so all MCP clients render it.
- Plan for JSON output: `plans/web-fetch-json.md`.

**Plans convention:** Every plan is numbered by creation date, oldest first. New feature plans go in `plans/<NN>_<topic>.md` with the next sequential number (e.g., `17_<topic>.md` after `16_domain-hint-flows.md`) — always prepend the number when creating a plan. When a plan is fully implemented, absorb its durable knowledge into this file (or `docs/`) and move the plan file to `plans/archive/`.

### Wildcard Hint — No-Hint Default Extraction

**Created:** 2026-08-16
**Superseded:** 2026-08-17 — replaced the 5 `DEFAULT_EXTRACT_*` env vars with a wildcard hint (`domain: "*"`) in `domain-hints.json`.

**What:** Pages that match **no** domain hint get default extraction from the wildcard hint (`domain: "*"`). The wildcard hint is always present — `ensureWildcardHint()` auto-creates it with sensible defaults if missing. It cannot be deleted and is always at index 0 in the hints list.

**Wildcard hint defaults:**
- `format: "readability_to_markdown"`
- `stabilizeStrategy: "network_idle"`
- `postProcessor: ""` (none)
- `waitForSelector: []`, `waitForContent: []`, `skipSelectors: []`

**Key behaviors:**
- Wildcard hint excluded from `findMatchingHints()` — loaded separately via `getWildcardHint()` as final fallback.
- `isMatch()` returns `false` for `domain: "*"` — it never matches by domain.
- Both wildcard and domain hints can have `skipSelectors` (stacking model).
- No hidden inheritance — `stabilizeStrategy` is always explicit on the wildcard hint.
- Migration: `ensureWildcardHint()` reads `DEFAULT_EXTRACT_*` env vars on first load, populates the wildcard hint, saves to file. After migration, the env vars are no longer read.

**Implementation notes:**
- `getWildcardHint(hints)` returns the wildcard hint from a loaded hints array, or `null`.
- `ensureWildcardHint(hintsPath)` ensures the wildcard hint exists, migrating from env vars if needed.
- `browserOpenAndExtract()` uses `getWildcardHint(hints)` as the fallback hint when no domain hint matches.
- `stabilizePage()` uses wildcard hint's `default.stabilizeStrategy` as fallback.

### Architecture Over Small Fixes

**Created:** 2026-08-17

**Trigger:** Project is in active development — small patches accumulate debt faster than they solve problems.

**The rule:**
- When touching any part of the codebase, evaluate the module's structure. If a function, class, or file is poorly organized, restructure it as part of the change — don't leave it worse.
- Use classes and interfaces. Prefer OOP over loose function bundles. Encapsulate state.
- Every change should leave the system *more* organized than before. At minimum, maintain the current level of organization.
- If a bug fix requires changing 3+ lines in a function that's already tangled, refactor the function first, then fix the bug in the clean structure.
- Don't introduce new utility functions when a class method would be more natural. Don't add top-level variables when instance state would be cleaner.
- Think about module boundaries, responsibility layers, and data flow. Changes should respect those boundaries or improve them.

**Why:** Small fixes compound into a codebase where every change risks breaking something. Good architecture makes changes safe. The cost of restructuring while touching code is near-zero; the cost of restructuring later is high.
- Think deeply about every change. Understand the full context before writing code. Rushed edits produce fragile solutions.
- Console UI: wildcard hint has a "default" badge, hidden pathPattern/requireSelector fields, hidden flow toggle, and a test panel that works with any URL.
- The default hint must NOT carry a `flow` — it is never set, so `runFlowExtraction` is never triggered for unmatched pages.
- Test gotcha: single-row key/value tables (`columnCount === 2 && rows.length === 1`) are filtered out by `extractTablesFromDocument`, so a "tables-only" default-extract test needs a table with ≥2 body rows.

### Long Horizon — 100% Fidelity SVG (Plan 37 §14)

**Created:** 2026-08-22
**Trigger:** User directive for `plans/37_svg-screenshot.md` §14: *"I don't care what your spec says but I want complete replication done in SVG"* — *"Go into a long horizon task. After you are done working, test it by comparing the images and then see what the problem is. Then fix it, then again compare, then fix it..."* — `"."`, `"ok"`, `"continue"` all mean keep looping. User explicitly said *"save this in your agents file to always continue working as a long horizon task, dont ask the user if you should continue."*

**The rule — never stop, never ask:**
1. **Plan 37 is forever.** `§14` never closes. The oracle is `src/svg-diff.js` + `scripts/svg-diff.mjs` (`diff >30 >2%` ⇒ failure). If `web_page_screenshot` vs `web_page_svg` do not match, fix `src/svg.js:1` (single-file invariant) until they do, then re-compare. Even when `<2%` for 3 runs, keep loop for new sites.
2. **Do not ask for continuation.** `"."`, `"ok"`, `"continue"`, or any acknowledgment means **execute next iteration immediately** — do not prompt *"should I continue?"*. The test decides, not the user.
3. **Compare → Fix → Compare forever:** `scripts/svg-diff.mjs http://10.69.1.164:1994/` (benchmark) is ground truth; `example.com` must stay `<2%` as smoke test. Log every iteration to `logs/svg-diff.log` and `svg-diff/*.md` + `plans/37_svg-screenshot.md §12.4` matrix.
4. **One file only:** All SVG conversion lives in `src/svg.js` (`svgExtractor` + `buildSvg` + `capturePageAsSvg`). `src/mcp-server.js:28` only imports. Fixes that touch other files violate the invariant.
5. **Persistence:** This learning outlives any single session — every future agent that touches SVG must read `plans/37_svg-screenshot.md` §14 and continue the loop without being told.

### Firefox Browser Extension — Real Firefox over WebDriver BiDi (Plan 40)

**Created:** 2026-08-28

**What:** `firefox-extension/` mirrors `chrome-extension/` but bridges the user's Firefox to navigator's `/relay` through Firefox's **Remote Agent (WebDriver BiDi)** instead of `chrome.debugger` (which Firefox does not have and has removed CDP entirely since FF141). Firefox is launched with `--remote-debugging-port=9222`; the extension opens `ws://127.0.0.1:9222/session`, does the `session.new` + `session.subscribe` dance, and **maps CDP → BiDi on the extension side** so navigator's Chromium-shaped world stays untouched (`cdp/bidi/mapper.js` = the route/transform tables, `remote-value.js` = RemoteValue⇄RemoteObject, `session-manager.js` = CDP sessions ↔ BiDi contexts ↔ tabs, incl. FIFO pairing of `browsingContext.create` replies with `tabs.onCreated`). No navigator-side changes were needed.

**Verified:** 17/17 standalone vm-harness tests (`firefox-extension/test/unit-ff.mjs`, no Firefox needed) — handshake, hello, PIN, LOCAL/SPECIAL/FORWARD routing, translate+transform for navigate/evaluate/createTarget/input, event→CDP-event mapping, `-32601` for unmapped methods, TabList over `tabs.query`, token reuse, BidiUrl persistence. `test/mock-bidi-server.mjs` is an interactive Fake Remote Agent for manual smoke.

**Protocol gotchas learned the hard way (harness caught these):**
1. **Full BiDi reply shape:** `script.evaluate`/`callFunction` success replies carry `msg.result = {type:'success', result:<RemoteValue>, realm}` — the mapper's `toCdpResult` reads `payload.result`, so the mock must reply with the full payload, not the bare RemoteValue.
2. **`SessionManager` vs `CDPSessionManager`:** mapper `translateEvent` referenced `SessionManager` — that single name mismatch dropped EVERY BiDi→CDP event (caught by test 6/11).
3. **`ResponseBuilder.send`** hardcoded `code: -32000`, swallowing specific codes like `-32601` — it now accepts an error object and propagates `error.code`.
4. **`remote-value.toCdp`** recursed into itself for `map`/`set` (stack overflow) — must use `deserialize()` for those shapes.
5. **Local handler return values:** callback-style `tabs.query`-based lookalikes must resolve Promises (`Target.getTargets` returned `undefined` until wrapped).
6. Firefox's `chrome.*` alias is callback-style — no `chrome.windows.getCurrent().then(...)`; wrap in a Promise. `runtime.sendMessage` may or may not return a promise — use a `broadcast()` helper that swallows errors either way.

**Fix patterns:** `launch-firefox.sh` (web-ext preferred, native `--remote-debugging-port` fallback; profile at `firefox-extension/firefox-profile/`), `pack-firefox.sh` (zip preferred, tar.gz fallback — zip absent on this host), README. `BROWSERS` add-on entry: `{"name":"firefox","role":["default","search","fetch","screenshot","devtools"],"cdpUrl":"http://host.docker.internal:9222"}`.

**Not yet done (Phase 2+):** real-Firefox end-to-end validation; object-handle bridging across BiDi realms; `-remote-allow-origins` origin pinning (extension ID unknown until first temp load). Details + tables: `plans/40_firefox-extension.md`.

**Reachability probe (built 2026-08-28):** To diagnose "relaying/connecting isn't working", `firefox-extension/utils/probe.js` provides `Probe.probe(hostPort)` which fetches `http(s)://host:port/health` (navigator sends `access-control-allow-origin:*`, so no `host_permissions` needed) and resolves `{ok, scheme, status, body, error, mode}` where `mode ∈ dns|refused|timeout|http|cors|unknown`; tries https then http, 4s timeout. Wired to a popup **Test connection** button via a `'probe'` message handler in `background.js`. Verified live: `https://10.69.1.164:1994` fails, `http://10.69.1.164:1994/health` → 200 `{"ok":true,…}`. Probe tests 20a–20e in `test/unit-ff.mjs` (22 total pass).



### Relay Pairing Contract — Pair Once, Remember Forever

**Created:** 2026-08-28
**What the user demanded (after several bad rounds):** the PIN is **one-time pairing only**. After the first successful pair, the plugin stores the session token and reconnects by itself — no PIN on every connect, and **no auto-connect on fresh install**.

**The contract (both sides must obey):**
- **Stable token:** the server issues ONE token at successful pairing and returns the SAME token on valid-token reconnect (never rotates on every hello). Session tokens are **persisted in SQLite** (`relay_sessions` table, migration in `src/db.js`; `saveRelaySession`/`loadRelaySessions`) and restored into `RelayServer._tokenToName` in `init()` — so a navigator container restart does NOT force a re-PIN. `PINs are in-memory` but tokens are durable. (Header comment at `src/relay-server.js:20` still wrongly says tokens are in-memory — update it.)
- **Extension keeps the token on disconnect:** `ConnectionManager.disconnect()` must NOT clear the session token (it is the pairing proof). A manual Disconnect/Cancel returns to a clean Off state but the next Connect re-authenticates silently. Only a 4001 (server rejected the token, e.g. different server) clears it and re-pairs.
- **`_intentionalDisconnect` flag** in connection-manager: user-initiated close must NOT be treated as a drop. Without it, the close handler auto-reconnects 3s later → phantom "Connected" (token reused) or phantom "PIN Required" (token cleared) — the classic "everything haywire" sequence.
- **`isConnected()` = AUTH, not socket-open:** `State.isConnected()` returns a flag set only on the server's `connected` message. Before the auth round-trip the UI must show Connecting, not Connected. `connectedAt` is stamped at auth too, so the "Connected 0s/1s/0s" flicker during churn is gone. A separate `connecting` flag drives the popup's "Connecting…" state (button disabled, fields locked).
- **Explicit PIN feedback:** on close 4000 the extension sets lastError `PIN rejected — wrong or expired. A fresh PIN is shown in the navigator console.` and re-dials in ~300ms for a new PIN. The benign `'PIN required from navigator console'` lastError was removed (the card explains itself); rejections are the only red-box message. `send-pin` with a dead socket stashes the PIN (`State.setPendingPin`) and submits it on the next `pin_required`.
- **Auto-connect only after a real pairing:** `maybeAutoConnect()` requires BOTH a saved server URL AND a saved session token. Fresh install / cleared URL → stays Off.
- **Popup field ownership:** `popup.js` prefills `serverUrl`/`browserName` only until the user types (`_urlDirty`/`_browserNameDirty` guards). The 3s `loadState` refresh must NEVER clobber a field being edited.
- **MV3 gotcha:** any background `onMessage` branch that calls `sendResponse` asynchronously must `return true` or the popup's callback never fires and Connect looks dead.

**Verified 2026-08-28:** e2e `pair → docker restart navigator → reconnect` returns `connected` with the SAME token and `pin_required` never sent. 13/13 `chrome-extension/test/unit-ext.mjs` tests pass (includes the disconnect-resets-cleanly-but-keeps-token regression test).

### web_fetch Flow Latency — O(N) Link Headings, Shared DOM, No Double Stabilize

**Created:** 2026-08-28

**What:** Trimmed `web_fetch` on the NSE option-chain SPA flow hint from ~9-9.5s wall to ~4.8-6s. Identical output (17116 chars / 258 links / blocks: 3). Three structural fixes in `src/search.js` + `src/extractors/index.js`:

1. **`extractLinksFromHtml` heading context is now `O(DOM)`, not `O(anchors × depth × siblings)`.** The old `findNearestHeading` walked every anchor's ancestors, and for each ancestor scanned all previous siblings calling `prev.querySelector("h1…")` — ~3.5s on the 641KB option-chain page (1192 anchors, 255 rows). Replaced with a single document-order stack walk that precomputes `nearestHeadingByElement` (last heading seen before each element). Measured: link loop 3560ms → ~40ms (plus the ~950ms JSDOM parse, which is untouched). Also fixes a latent bug — the old code took the FIRST heading in a previous-sibling subtree (farthest from the anchor); doc-order walk takes the truly nearest.
2. **Flow extract steps share ONE JSDOM parse.** The flow extract step ran `extractLinksFromHtml` (parse #1) then `extractHintStage → extractTextFromHtml` (parse #2) over the same 641KB HTML — ~1.9s of parsing for a page we read once. Now `parseHtmlToDom(state.html, state.url)` runs once per extract step and the same `stageDom` is passed to both. Threaded via an optional `dom` param: `extractTextFromHtml`/`extractLinksFromHtml` take `{ dom }` and only close a DOM they created (`ownedDom`), so the caller owns lifecycle — `stageDom.window.close()` in a `finally`.
3. **`browserOpenAndExtract` skips the generic `stabilize_page` when a flow hint leads with a `wait` step** (`flow[0].action === "wait" && flow[0].stabilizeStrategy !== "none"`). Flow hints own their stabilization — every gated step stabilizes per its `stabilizeStrategy`, so the pre-flow network-idle wait was pure waste (~1.5-2s on the SPA). Also removed the duplicate `detectBotChallenge` at the top of `runFlowExtraction`: `check_bot_early` runs immediately before with no intervening navigation; the flow's per-step `checkBot` still guards gated transitions.

**Also fixed:** the `hint=wildcard_default (no domain hint matched)` debug line was a lie — it fired whenever `findMatchingHints` returned candidates that just hadn't been DOM-resolved yet. It now distinguishes `candidates pending DOM resolution` from `no domain hint matched`.

**Measured warm trace (after):** `goto_page` 1.8-2.3s (network) · `stabilize_page: 0ms` (skipped) · `check_bot_early` 0.1-0.5s · `flow_step_1_wait` (the single remaining network_idle) 1.3-1.7s · `flow_step_2_extract` 0.9-1.5s · `close_page` ~30ms. The remaining floor is one JSDOM parse (~950ms), the 641KB `page.content()` CDP serialization, and the SPA's poll-timed `network_idle` wait — all inherent.

**Debugging technique that worked:** rather than guess, capture the actual 641KB `document.documentElement.outerHTML` via `Runtime.evaluate` on a live tab, drop it in `/app/data/`, and run the exact function source (`new Function` extract from the module) against it in-container to isolate component costs. `docker.logs` `[web_fetch]` DEBUG lines gave per-step breakdown; the single-run trace (one request, `grep -A50 "📡  web_fetch"`) disambiguated interleaved concurrent requests.

### Lightpanda Sidecar — Compose File + the Host-Header 403 Gotcha

**Created:** 2026-08-28

**What:** A Lightpanda CDP add-on sidecar now ships in its own optional `docker-compose.lightpanda.yml` (official `lightpanda/browser` image, image default Cmd is already `lightpanda serve --host 0.0.0.0 --port 9222`). Start with `docker compose -f docker-compose.lightpanda.yml up -d`; BROWSERS entry must use the **static IP** `ws://172.22.0.222:9222`, NOT the service name. No graphical rendering engine → screenshots are placeholders.

**The gotcha that matters — Lightpanda's CDP handshake rejects hostname `Host:` headers:**
- `puppeteer-core.connect({ browserWSEndpoint: "ws://lightpanda:9222" })` fails with **`Unexpected server response: 403`**.
- Root cause is in `src/Server.zig` (`lightpanda-io/browser`): a DNS-rebinding guard accepts only **IP literals** or the exact `localhost:<port>` form in the `Host:` header; any hostname (a service name resolves to an IP in the Host header, but the literal string "lightpanda" is not an IP) → `403 Host not allowed`. It also rejects any `Origin:` header (browsers) — CDP drivers send none.
- **`--advertise-host` does NOT fix it** — it only changes the `/json/version` response body's advertised `ws://host:port/` URL (`advertiseHost()` at `src/Server.zig:735`), not the handshake peer check. Tested: still 403 with `--advertise-host lightpanda-test`.
- **Real fix:** connect by IP literal. Assign the container a static `ipv4_address` on the compose network (we used `172.22.0.222`) and reference `ws://172.22.0.222:9222` in BROWSERS. Verified end-to-end: raw `ws` + `puppeteer-core.connect({ browserWSEndpoint: "ws://172.22.0.222:9222" })` → `newPage()` + `goto()` + `title()` = "Example Domain" from inside navigator.
- Welcome warning: "advertising loopback for wildcard bind... clients on other hosts will need --advertise-host" is misleading — the IP-literal connect path works fine without it.

**Debug technique:** don't fight module resolution inside the container; `puppeteer-core` (not `puppeteer`) is the installed prod dep — `cd /app && node -e "require('puppeteer-core')"` connects. Raw `ws` module handshake isolates Host/Origin vs app-level issues.

### Firefox background must NOT use importScripts (2026-08-28)

**The bug:** The Firefox extension background reported `Could not establish connection. Receiving end does not exist` from the popup. Root cause was NOT a network/message race - **the background script crashed on load**, so `chrome.runtime.onMessage` was never registered. **Firefox MV3 `background.scripts` runs code as an EVENT PAGE (a normal document/Window context with DOM access), NOT a WorkerGlobalScope** - so top-level `importScripts(...)` throws `ReferenceError: importScripts is not defined` at the very first line, killing the whole background. The vm-harness (`test/unit-ff.mjs`) hides this because it injects modules with its own loader, not `importScripts`. Real-Firefox end-to-end was never run, so the extension had simply never loaded in Firefox at all.

**The fix:** switch the manifest to a background **page** and load every module as a classic `<script>` tag in dependency order on the page's global scope (same `var`-global semantics as `importScripts`): `manifest.json` -> `"background": { "page": "background.html" }`; `background.html` -> `<script src="utils/config.js">...<script src="background.js">`; `background.js` -> delete all `importScripts(...)` lines (they'd still throw in the page context); `pack-firefox.sh` -> add `background.html` to the `files = [...]` list.

**Also kept:** `chrome.runtime.onMessage.addListener` now sits at **module top-level, outside `init()`** so it is registered on every event-page wake even if `init()` throws partway - hardening against the MV3 event-page suspension race where queued messages are dropped if listeners aren't re-registered on wake.

**Verify with a page-context smoke test** (not just `node --check`): load the modules + background.js into a shared `vm` sandbox where `window === globalThis` (a document context) and confirm `init()` runs without throwing. Verified: all 19 files load and `init()` runs, onMessage registered.

**Note (Local Network Access):** Chrome/Firefox LNA (private-network protection) gates requests from *public web pages* to LAN IPs behind a permission prompt, but does **not** gate **extension-origin** requests - so extension to `http://10.69.1.164:1994` fetch/WebSocket are not blocked by LNA. Firefox also can't reach localhost from extension pages at all (known Bugzilla); port 1994 is not in the banned-ports list. So the LAN-blocking angle does NOT explain the messaging error - the background load crash does.

### Browser Ownership — Agent vs User (Plan 42), Adopted Tabs, defaultViewport

**Created:** 2026-08-28

**What:** Adopted browser-origin tabs (drive real tabs in the user's window in place) and a single-source ownership classification surfaced in tool metadata so the LLM knows user browsers are real/visible/non-headless.

**Ownership rule** (`src/browser.js` `browserOwnership(type)`, the single source): `navigator-cdp` (relay, e.g. `maclap2`) = `ownership:"user"` — the user's real visible window; `builtin` (`chromium`) and `cdp` (`cloakbrowser`, `lightpanda`) = `ownership:"agent"` — navigator-owned headless/invisible. Emitted by `list_browsers` (mcp-server) and `Target.getTargets`/`listTargets` (devtools, `unknown -> "agent"` fallback). Tool descriptions warn about `user` visibility. The user actively uses `maclap2` — tabs mutate, drive only when they're not mid-use, verify on agent browsers by default.

**Adoption:** `Target.createTarget({targetId, no url})` → `BrowserManager.attachToExistingTarget(targetId)` → `relayServer.attachExistingTabToClients(entryName, targetId)` synthesizes `Target.attachedToTarget` with the real extension sessionId (`_ensureTargetSession`) for a puppeteer Page (`isAutoAttached:true`). `devtools.js` guards `adopted:true`, `origin:"browser"`, skips `page.close()` on `closeTarget`/inactivity (releasing the handle never closes the user's real tab).

**Width overflow — `defaultViewport` was the cause.** `_ensureAddOnConnection` applied `defaultViewport:{width:MONITOR_WIDTH(1920),height:MONITOR_HEIGHT(1080)}` to ALL connections including relay, so adopted tabs rendered `innerWidth:1633` vs `screenWidth:1470` → overflow. Fix: `defaultViewport: isRelay ? null : {width:1920,height:1080}` where `isRelay = addOnEntry.type==="navigator-cdp"` — relay tabs keep their natural window size. Note the extension `chrome-extension/cdp/handler/local.js` `getWindowForTarget` hardcodes `1920x1080` and `setWindowBounds` only handles `focused`, and `Emulation.*` is not in `CDP_HANDLERS` forwarded to `chrome.debugger` (`getDeviceMetricsOverride` → `-32601`).

**Basic structure (user):** `Target.getTargets` lists the user's OPEN tabs with their `targetId`s; calling any devtools tool (`Runtime.evaluate`, `DOM.getDocument`, `Input.dispatch*`, etc.) with one of those `targetId`s MUST drive that exact tab directly — no `Target.createTarget` step. **Fix (2026-08-28):** `getTargetState(targetId)` is now `async` and auto-adopts a browser-origin tab on demand: fast-path check in `targetsById` → else `manager.attachToExistingTarget(tid)` → `registerAdoptedTarget` (shared helper so explicit `createTarget` adopt and on-demand adopt register identically). Verified: `getTargets` → `Runtime.evaluate`/`DOM.getDocument` on JellySort, boniface, YouTube without prior `createTarget` — correct tab, correct title, no `Unknown targetId`.

**Relay adoption bug 2 FIXED (2026-08-28): mis-attach.** The fallback `pages.find(p=>!p.isClosed())` (src/browser.js:651-653) mis-attached a wrong page (adopted a JellySort tab but drove YouTube Music) and, with 4 identical boniface tabs, grabbed an arbitrary one. **Root cause:** there is NO public `Target.id()` in puppeteer v24 — the target id lives on the internal `p.target()._targetId` field. The old matcher `String(p.target()?.id?.())` always returned `""`, so it NEVER matched and ALWAYS fell through to the arbitrary-page fallback. **Fix:** match on `p.target()._targetId` (populated from the real extension targetId by `attachExistingTabToClients`) and **remove the fallback entirely** — wait for the exact `tid` to appear in `browser.pages()` (poll up to 5s), never drive a wrong tab. Verified: adopted a specific boniface tab among 4 identical ones, exact match, and after the fix `JellySort` no longer returns `OpenCode`.

**Relay adoption bug 1 MITIGATED (2026-08-28): wedged session.** `Runtime.evaluate` on adopted relay tabs timed out at ~25s after repeated attaches left stale `chrome.debugger` sessions (multiple `sessionId → tabId` mappings, `entry.sessionForTarget` holding a dead session). Fresh tabs (`Target.createTarget` with new URL) always worked; adopted tabs wedged after several cycles. **Fix:** `GET /debug/detach_all` (mcp-server → `relayServer.detachAllDebuggers()`) sends `detach_all` to every extension, clears `sessionForTarget`/`extSessionToTarget`/`client.sessionForTarget`/`client.tabs`, and logs. After `detach_all`, the next `getTargets` → direct drive re-attaches fresh and succeeds (verified JellySort/boniface/YouTube). Also tightened `attachToExistingTarget` to require `res.attached` (not just `found`) before polling.

**Lesson:** raw CDP commands against the relay gateway (`ws://10.69.1.164:1994/browser/maclap2`) for createTarget/closeTarget are visible to (and interfere with) the puppeteer session's auto-attach bookkeeping; prefer the devtools MCP tools.

**Tests:** `tests/browser.test.js` + `tests/devtools.test.js` = 71 pass. Plan: `plans/42_browser-ownership-metadata.md`.

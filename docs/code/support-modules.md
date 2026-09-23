# Support Modules

These modules hold configuration, durable state, extraction-rule management, and small runtime services used by the MCP server. They deliberately do not choose search routes or orchestrate page work. Keep that policy in `src/search.js` and `src/browser.js`; these modules provide the validated state and primitives those layers need.

## Configuration and Live Changes

### `config.js`

`loadConfig()` is the process-start boundary between environment text and the normalized configuration consumed by the server. Invalid, missing, or out-of-range values fall back to safe defaults rather than leaking unchecked strings into browser and scheduler code. Lists are normalized, de-duplicated, and, for engine lists, limited to IDs registered in `src/engines/index.js`.

Browser discovery works through the `BROWSERS` JSON array. Chromium is always present and built-in; if it's missing from the config, the parser adds it at the end of the array. All other browsers are add-ons: `cdp`-type entries connect to a user-provided CDP endpoint; `navigator-cdp` entries come from relay extensions that dial in over `/relay`.

Important routing rules:

- The `BROWSERS` array is the single source of truth for available browsers, their roles, and the rollback order. An empty `role` array makes a browser a fallback/backup only.
- Page tools (`web_fetch`, screenshots, devtools) use `resolveBrowserParam()`: an explicit `browser` param is strict; otherwise add-ons are tried in array order; Chromium is the always-present fallback.
- Search engines always run on the built-in Chromium — engines never use add-ons.
- `HEADLESS=false` without `ENABLE_VNC=1` is forced back to headless mode so the server does not start a browser without a display.
- `SEARCH_ROUTE_WARMUP_ENGINES` defaults to a small set only when unset. An explicitly empty value disables warmup. `SEARCH_ENABLED_ENGINES` controls automatic route selection.

The wildcard hint's `skipSelectors` list is the baseline for page cleanup. Changes here can silently remove real page content, especially semantic `header` and `footer` elements; prefer a domain hint or a targeted selector before broadening this list.

### `config-schema.js` and `config-manager.js`

`CONFIG_SCHEMA` is the console's single description of editable environment variables: category, parsing type, fallback, and whether a change is `hot` or requires a process/browser `recreate`. The schema is not itself enforcement; `config-manager.js` parses submitted values and mutates only keys with an explicit hot applier.

Hot changes update the shared in-memory config, so they affect later work without rewriting browser processes. This includes enabled/warmup routes, scheduler intervals, browser-operation limits, extraction options, diagnostics, VNC state, and MCP authentication settings. Backend binaries, listener settings, browser profiles, and console enablement are recreate-only. When adding a setting, trace it from `loadConfig()` through its actual consumer, add the schema entry, and add a hot applier only if changing the live value is genuinely safe. A schema row marked hot without an applier is intentionally not hot-applied.

The manager also preserves invariants while changing related limits: the maximum working windows never falls below the configured minimum, scheduler maximum cooldown never falls below its minimum, and operation limits stay bounded.

### `env-file.js`

The console uses this module to edit `.env` without discarding comments, blank lines, or unrelated variables. It understands ordinary and `export` assignments, strips outer quotes for reads, and writes quotes only when a value needs them. The first assignment for a duplicate key is the editable one.

Before a persisted change, callers can create a timestamped adjacent backup; revert restores the newest backup. The 50-entry history is process-local UI history, not an audit log and not durable across restart. Parsing is deliberately simple rather than shell-compatible, so do not use it for values that rely on complex shell expansion or multiline shell syntax.

## Durable State and Activity

### `db.js`

This is a singleton SQLite store at `<dataDir>/navigator.db`, defaulting to `process.cwd()/data`. It enables WAL mode, normal synchronization, and a five-second busy timeout, then applies ordered migrations once. The database owns activity history, durable link reference IDs, MCP API keys and their allowed-tool restrictions, application markers, and lifetime usage totals.

Activity is retained for seven days. Pruning runs at startup and at most hourly afterwards; a prune failure is logged but does not make requests fail. Usage totals are intentionally not pruned, and their migration initializes them from existing activity so upgrades do not reset visible counts.

Callers must initialize the database before direct access. The activity wrapper handles lazy initialization for telemetry, but reference and key functions expect the server startup path to have initialized it. Do not change the default data directory casually: in the container it is a bind-mounted operational data location.

API keys supplied through legacy configuration are imported exactly once, guarded by an application-state marker. Later changes to the environment do not overwrite, duplicate, or revoke stored keys. Treat the returned records as secret-bearing data and do not add them to logging or status responses.

### `activity.js`

Activity recording is best-effort observability. Database failures are logged and converted to `null`, never allowed to fail a search, fetch, screenshot, or DevTools request. Search start/end rows record the request lifecycle; nested engine attempts use `AsyncLocalStorage` to attach to their parent search. Search orchestration must keep route attempts inside `searchContext.run({ searchId }, ...)` or they become unassociated rows.

The live console feed uses independent cursors for `searches` and `page_ops`. Their SQLite IDs are separate sequences, so never merge them into one `since` cursor. Trend queries create fixed buckets for 15 minutes, one hour, one day, or one week and include empty buckets for stable chart shapes.

### `ref-memory.js`

Link references are durable numeric IDs backed by `ref_links`, with a bounded 2,000-entry process-local bidirectional cache in front. A restart may empty the cache but does not invalidate an existing reference: lookups fall back to SQLite and repopulate it. `resolveRefIdToUrl()` is the strict path for a caller that requires a URL; the other lookup APIs return `null` for optional or missing references.

Only trimmed URLs are stored. This module does not perform canonical URL normalization, so changing URL normalization must be coordinated with result extraction and existing durable data to avoid creating duplicate references.

## Domain Extraction Hints

### `domain-hints.js`

Domain hints select extraction behavior after a page has loaded. A rule matches its domain or subdomain and a lowercase normalized pathname. `*` stays inside one path segment, `**` can cross segments, and `/` is normalized consistently. Candidate rules retain file order; `search.js` tries candidates in that order and checks `requireSelector` against the live DOM before accepting one. This allows a selector-gated rule to precede a same-path fallback rule.

Hints may use at most one extraction method:

- `default` configures normal page extraction: optional selector gates, stabilization, content waits, skips, output format, and table behavior.
- `flow` scripts a small, bounded sequence of `wait`, `click`, `type`, `navigate`, and `extract` steps for interactive pages. It must finish with extraction, limits steps/clicks/timeouts, and requires a wait or extract between interactions.

The module accepts older hint shapes on load and migrates them in memory with warnings. The editor validation path rejects those legacy fields so new saved rules use the current shape. Validation checks selector syntax with JSDOM, but it cannot prove a selector exists on a real page; use the hint test pane or browser tools for that.

Loading caches hints by resolved path. Saving writes a `.bak`, writes a temporary JSON file, atomically renames it, and clears that cache. It refuses `/dev/null`, which is the explicit disabled-hints path. Keep the first-match ordering and atomic-save boundary when modifying this module; otherwise a partial edit can alter extraction for live traffic.

## Rendering and Visual Inspection

### `markdown.js`

`htmlToMarkdown()` is the shared HTML-fragment formatter for extraction hints. It resolves relative links and images before conversion, removes interactive and embedded noise, applies Turndown with GFM, and preserves useful structures such as tables, disclosure blocks, definition lists, and inline semantic elements. If conversion itself throws, it returns the original HTML rather than dropping extracted content.

The cleanup list is intentionally more aggressive than general page extraction because this module receives selected fragments. Do not use it as a reason to expand global non-content removal.

### `pixel-sampler.js` and `ascii.js`

The ASCII screenshot feature has a browser-side and Node-side boundary. `pixel-sampler.js` is serialized into `page.evaluate()`: it decodes the PNG screenshot, downsamples it to two image rows per terminal cell, and returns packed RGB bytes. `ascii.js` is pure transformation code: it converts those bytes into truecolor half-block output, grayscale output, or a compact plain-text luminance ramp.

Element markers are placed after image sampling, in priority order, and move downward to avoid collisions. The legend may include selectors and XPath independently of the render. Grid width is clamped to 40–200 columns and full-page output caps rows, preventing an unusually long page from producing an unbounded tool response. Preserve this browser/pure-module split: browser APIs cannot be used from the renderer, and the sampler code must remain serializable.

### `tab-timers.js`

This small process-local map supplies the five-minute inactivity countdown shown for persistent DevTools tabs. It does not close tabs itself; browser lifecycle code touches and clears entries when it uses or removes targets. Missing state returns `null`, which is normal after restart or for tabs created before the timer was recorded.

## Infrastructure Boundaries

### `mcp-api-auth.js`

HTTP MCP accepts either `Authorization: Bearer <key>` or `x-api-key`. Requests are open unless `mcpAllowUnauthenticated` is explicitly `false`; in protected mode every configured key is compared with a length check and `timingSafeEqual`. Keep the length check before `timingSafeEqual`, which requires equal-size buffers. This helper authenticates configured keys; database-backed key authorization and tool restrictions belong to the HTTP server layer.

### `engine-scheduler.js`

The scheduler persists per-route health in its configured JSON state file. A profile records success/error counts, failure streak, exponential cooldown, recent latency samples, selection time, and last error. Corrupt or absent state is treated as a clean start; persistence errors are logged without blocking searches.

Selection has deliberate fallbacks. Eligible healthy routes are ordered by median latency, with unmeasured routes sampled early. Every configured exploration interval rotates a non-leading ready route to the front. Failed routes that have completed cooldown are tried as probes; recently used healthy routes are paced and used last. Routes still cooling down are returned as skipped so the orchestrator can report why they were not attempted. A success only decreases the failure streak by one, making recovery gradual; a failure grows cooldown exponentially within configured bounds.

The scheduler ranks routes but does not decide whether a provider result is usable or manipulate browser windows. Keep empty-result policy, route circuit breakers, and actual dispatch in search orchestration.

### `vnc-manager.js`

`VncManager` controls the optional local display stack: Xvfb, Fluxbox, x11vnc, and noVNC/websockify. Startup first reuses a live display when possible, otherwise clears stale lock/socket files and launches Xvfb. Each stage is probed before the next begins; failure leaves a status and bounded step history for the console rather than pretending the stack is usable.

The container entrypoint may own processes before Node starts. The manager adopts only processes scoped to its configured display or ports, then stop sends TERM and escalates to KILL after three seconds. Do not widen those `pgrep` patterns or add broad process cleanup: this code must never take down unrelated display services.

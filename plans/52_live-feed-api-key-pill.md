# 52 — Live Activity: Show API Key Name Pill

**Status:** Planned
**Created:** 2026-09-11
**Scope:** Console status page — Live activity feed (`src/web-console/src/pages/status/LiveFeed.jsx`, `src/web-console/src/style.css`) + activity endpoint enrichment (`src/activity.js`, served via `src/mcp-server.js` `/stats/activity`)

---

## Summary

Each Live activity row should render a small pill with the **API key name** that made the request, placed **next to the existing `feed-backend` pill**. If the request was made with **no API key** (`api_key_name` absent/empty), **nothing extra is rendered** — no placeholder, no "unauthenticated" label in the feed (that label stays in the detail modal only).

Example render (`feed-tool` row):

```
web_fetch  [chromium]  [project-key]
```

```
web_search  [project-key]        ← key pill also shows when the backend pill is hidden (web_search)
web_search  [cloudflare-mcp] ─┐
        engine1 [chrome] ─────┴─ attempts still show only backend pills (unchanged)
```

## 1. Current Behavior

- `LiveFeed.jsx` `buildFeed()` builds rows from `getRecentActivity` payload (`entries` = searches w/ attempts, `pageOps`). Each row has `key` = `s-<id>` or `p-<id>`, plus `backend` (`formatBrowser` of attempt/page-op backend).
- The backend pill is rendered at `LiveFeed.jsx:248-250` — a `<span className="feed-backend">{entry.backend}</span>` inside `.feed-tool`, hidden for `web_search` and `Target.getTargets` rows.
- `mcp_calls` table (`src/db.js:115-124`) already stores `api_key_id`, `api_key_name`, `api_key_preview` per tool call, recorded in `recordMcpCall()` (`src/activity.js:251`).
- The **detail modal already shows the API key** via `getMcpCallForActivity(key)` (`src/activity.js:281`) → `ActivityDetailModal.jsx:132` renders `api_key_name (api_key_preview)` or `unauthenticated`.
- **Crucial linkage fact:** the MCP tool-call handlers that call `recordMcpCall()` (`src/mcp-server.js:2991/3003/3169`) do **not** pass `searchId`/`pageOpId`, so `mcp_calls.search_id` and `page_op_id` are effectively always NULL. Linkage relies entirely on the **ts±10s + tool-name window fallback** in `getMcpCallForActivity()` (`src/activity.js:290,300`): nearest `mcp_calls` row whose `ts` is within 10s of the entry's `ts` and whose `tool` matches (`web_search` / the page op's tool).

## 2. Data Flow (proposed)

Server owns the join. `getRecentActivity()` (`src/activity.js:218`) attaches key info to each returned search entry and page op before returning:

```
entries[]  → { id, ts, tool: "web_search", ..., api_key_name?, api_key_id?, api_key_preview? }
pageOps[]  → { id, ts, tool, ..., api_key_name?, api_key_id?, api_key_preview? }
```

Client `buildFeed()` (`LiveFeed.jsx:29-124`) copies `entry.api_key_name` onto each row as `keyName`; the row renderer emits the pill only when `keyName` is truthy.

## 3. Implementation Steps

### 3a. `src/activity.js` — reusable key lookup

Extract the linkage logic out of `getMcpCallForActivity()` into a small helper, e.g. `findKeyInfoForEntry(ts, tool)` returning `{ api_key_id, api_key_name, api_key_preview } | null`:

1. Try `mcp_calls.search_id` / `page_op_id` fast path if ever populated (keep the existing direct lookups).
2. Fall back to the existing ts-window query (`WHERE tool = ? AND ts BETWEEN ? AND ? ORDER BY ABS(ts - ?) LIMIT 1`).
3. `getMcpCallForActivity()` keeps working by wrapping this helper (it also needs the full call row for `args_json`/`response_preview` — helper can return the row, callers pick fields).

### 3b. `src/activity.js` — enrich `getRecentActivity()`

In `getRecentActivity()` (`src/activity.js:218-237`), after building each search `entry` and each page op, attach the key info:

- Search entry: `entry.api_key_name = call?.api_key_name || null` (+ id/preview).
- Page op: same via its `ts` + `tool`.

Per-entry query cost is bounded (limit ≤ 100 searches + 100 page ops per poll ≈ ≤200 tiny indexed queries). If profiling shows this is hot, a batch optimization is: single `SELECT * FROM mcp_calls WHERE ts BETWEEN ? AND ?` over the min/max entry timestamps and join by `(tool, nearest ts)` in JS — note as an optional follow-up, not part of this change.

Null-safe: never attach when there is no matching call or `api_key_name` is empty.

### 3c. `src/web-console/src/pages/status/LiveFeed.jsx` — row data

In `buildFeed()`:

- Search rows: add `keyName: entry.api_key_name || ""`.
- Page-op rows: add `keyName: op.api_key_name || ""`.
- (Attempts keep backend-only pills — unchanged.)

### 3d. `LiveFeed.jsx` — render pill

Inside the `.feed-tool` span (`LiveFeed.jsx:246-251`), after the existing backend pill:

```jsx
{entry.keyName ? <span className="feed-key" title={`api key: ${entry.keyName}`}>{entry.keyName}</span> : null}
```

- Shown whenever `keyName` is truthy **regardless of whether the backend pill rendered** (so `web_search` / `Target.getTargets` rows still show the key pill).
- Rendered after the backend pill as a sibling — "next to the feed-backend pill."
- When no key → nothing renders (the requirement: *"if no key then don't show anything"*).
- Keep it inline so `block` styling of `.feed-tool` (`.feed-request`/`.feed-tool` display rules at `style.css:1446-1449`) does not push it to its own line — the pill is an inline child of `.feed-tool`, same as `.feed-backend`.

### 3e. `src/web-console/src/style.css` — pill style

Add `.feed-key` alongside `.feed-backend` (`style.css:1425-1435`): same inline-block shape (margin-left 4px, 1px border, radius 3px, 9px mono, letter-spacing), but a distinct accent so it reads as "identity" not "backend" — e.g. `border-color`/`color` from the accent/blue var instead of `--line`/`--muted`. Exact hue is a UI call; default proposal: `color: var(--blue)`, `border-color: color-mix(in srgb, var(--blue) 45%, var(--line))` (or a static hue if the palette lacks mixing support).

### 3f. Build + deploy (console)

Console changes need an in-container rebuild (bind-mounted `src/web-console/dist`):

```bash
docker exec navigator npm install --include=dev && docker exec navigator npm run console:build
```

No container restart needed for the console bundle; the `src/activity.js` change DOES need a restart (`docker compose restart navigator`) since server modules are loaded from the bind mount at boot.

## 4. Edge Cases

| Case | Behavior |
|------|----------|
| No API key (stdio/local, unauthenticated stateless POST) | `api_key_name` null → no pill. Nothing renders. |
| Key exists but empty-string name | `|| ""`/`|| null` cleanup → no pill. |
| Multiple same-tool calls within 10s | Nearest `ts` wins (existing deterministic order — unchanged semantics). |
| Backend pill hidden (web_search / Target.getTargets) | Key pill still renders standalone next to the (absent) backend slot. |
| Stale rows merged on next poll (`main.jsx:82-90`) | `buildFeed` reruns each poll over server-enriched entries → keys backfill rows already in the feed. |
| Feed is rebuild after restart / DB pruned | Same as any feed row — vanishes; no special handling. |

## 5. Files Touched

| File | Change |
|------|--------|
| `src/activity.js` | Extract key-lookup helper from `getMcpCallForActivity()`; enrich `getRecentActivity()` entries + pageOps with `api_key_name`/`api_key_id`/`api_key_preview` |
| `src/mcp-server.js` | **None** (payload shape already passes through untouched) — unless batch-join optimization is chosen |
| `src/web-console/src/pages/status/LiveFeed.jsx` | `buildFeed()` sets `keyName`; render `feed-key` pill after `feed-backend` |
| `src/web-console/src/style.css` | `.feed-key` pill style |
| `src/web-console/src/components/ActivityDetailModal.jsx` | **None** (already shows API key) |

## 6. Verification

1. `docker compose restart navigator`, then rebuild console (`3f`).
2. Open `http://10.69.1.164:1994/console` → status → Live activity.
3. Make requests: (a) via an MCP client authenticated with a named API key, (b) an unauthenticated/stdio request.
4. Expect: (a) row shows two pills — backend + key name, adjacent; `web_search` shows only the key pill; (b) unauthenticated row shows **no** key pill.
5. Click any row → detail modal still shows `API key` + `Key ID` (unchanged).
6. Confirm `Target.getTargets`, `web_fetch`, `DOM.*` rows all show the key pill when the request carried an API key.
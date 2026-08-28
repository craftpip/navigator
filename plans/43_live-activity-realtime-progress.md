# 43 — Live activity real-time progress + per-engine searching + browser pill

**Status:** Phase 1 implemented — 2026-08-28 (Phase 2 pop-up pending)
**Owner:** navigator console
**Related:** `src/web-console/src/pages/status/index.jsx:660` `buildFeed`/`LiveFeed`, `src/activity.js`, `src/db.js`, `src/search.js:260`, `src/web-console/src/lib/format.js:66`
**Implemented:** `src/activity.js:63` `recordEngineAttemptStart/End`, `src/search.js:1050` running fan-out, `src/web-console/src/lib/format.js:71` `formatBrowser`, `src/web-console/src/pages/status/index.jsx:683` `searching…`/browser pill hidden for `web_search` + spinner single, `src/web-console/src/style.css:1290` `feed-attempt.running` blue + `.feed-time:3px` `.feed-response:6px`

## 1. Context

Live activity today has two rows of staleness:

* **Search-level:** `searches.status='running'` exists and `page_ops.status='running'` already shows `in progress…` (gold) — but **engine attempts have no running row**. `recordDbEngineAttempt` is only called on completion (`src/activity.js:63`, `src/search.js:260`). While a search fans out, the UI cannot render `startpage: searching…`. It either shows nothing for that engine (filtered) or, on failure, immediately shows `failed` or — for the overall search — `0 results` in green (`ok` with `0`) which user reports as yellow confusion.
* **Polling:** `main.jsx:59` `GET /stats/activity?since=&sinceOps=&limit=100&pageOps=1` every `2s` re-sends any `ts >= now-60s` window so `running → ok/fail` replacement does work, but only if a running row exists in DB.
* **Browser pill:** Right of tool name shows `formatBackend()` (`CH`/`CB`/`API`/`-`) (`src/web-console/src/lib/format.js:66`, `src/web-console/src/pages/status/index.jsx:823`). User asks to show the **browser that ran the tool** (e.g. `chromium`, `cloakbrowser`) instead of the short backend code. For API engines the pill today is `-` — should become `api` or the engine id is enough; pill is meant for browser-driven work.

User asks (§43): real-time progress for **all tools** — `searching…`/`fetching…`/`capturing…`/`inspecting…` while working, then `ok` or `failed <reason>` when done; and for `web_search` per-engine progress under the same search row.

## 2. Goals

* When any tool starts, a Live activity row appears **immediately** (within one poll) with a running tone (gold) and human verb: `searching…` / `fetching…` / `capturing…` / `running…`.
* For `web_search`, each **candidate engine** appears as a sub-row immediately as `engine: searching…` (gold, spinner or animated ellipsis), then transitions to `engine: 11 results · 1.6s` (green) or `engine: failed · <reason>` (red) when that route settles. No `0 results` yellow/green ghost.
* Filter toggles (`Web`/`DevTools`) remain instant — new work animates from `0fr` only; toggle never animates.
* Pill on the right of the tool name shows the **browser** that executed the tool (`chromium`/`cloakbrowser`/`lightpanda`/`api` fallback), not `CH`/`CB` codes.
* Architecture: introduce a single, explicit `Activity` domain; eliminate the current split where `searches` vs `engine_attempts` vs `page_ops` each invent their own running semantics.

## 3. Non-Goals

* Changing poll interval (`2s`) or moving to SSE — keep current `since`/`sinceOps` + `60s` window; variant can later lower interval if needed.
* New transports, new search engines, or console redesign beyond Live activity.
* Persisting every poll frame to SQLite at high frequency — running rows should be cheap and pruned quickly.

## 4. Current state — why it looks like `0 results` yellow

* `src/search.js:260` `recordEngineAttempt` → `recordDbEngineAttempt` only on terminal `ok`/`fail`/`skip`. No `running` insert.
* `src/activity.js:63` always `INSERT` with final `status`; `getRecentActivity` joins `engine_attempts` onto `searches`. A not-yet-finished engine simply has **no row**, so `buildFeed` cannot render `searching…`.
* Overall search with `result_count=0` is still `status='ok'` (`src/search.js:1351` `ok:true` even for 0). `buildFeed` renders `response = '0 results'` with `tone='ok'` (green) — user perceives as yellow/gold confusion vs the `running` gold. The intermediate `running` search row (gold) flashes briefly then flips to green `0 results`, which looks like a completed empty result, not a pending search.
* Page ops already have `recordPageOpStart`/`recordPageOp` (`src/activity.js:82,91`) — they correctly show `in progress…` gold. Devtools `recordPageOp` with `status='running'` also works.
* Pill: `formatBackend()` maps `chromium→CH` etc, called in `buildFeed` for every row and attempt. No browser name is stored for API engines; `backend` is `null`.

## 5. Proposal

### 5.1 Backend — make running first-class for everything (single Activity seam)

**DB:** No schema change required for v1, but add explicit running semantics:

* `engine_attempts.status` already freeform — allow `'running'` (currently only `ok`/`fail`/`skip` written). Add index-friendly write path. Keep `result_count=0`, `duration_ms=NULL` while running. Optional migration to document enum: no DDL needed, just code contract.

**New helpers in `src/activity.js`:**

```
recordEngineAttemptStart({ engine, backend }) -> id
  INSERT engine_attempts (search_id from context, ts=now, engine, backend, status='running', duration_ms=NULL)

recordEngineAttemptEnd(id, { status, resultCount, error, durationMs })
  UPDATE engine_attempts SET status, result_count, duration_ms, error WHERE id=?

// Convenience wrapper used by search.js
startEngineAttempt(engine, backend) / finishEngineAttempt(id, ...)
```

* `recordDbEngineAttempt` stays for one-shot `skip`/`fail` paths but `running` now goes through the start/end pair.

**Search flow (`src/search.js:browserSearch` / `runSearchRoute`):**

* After `recordSearchStart` and `searchContext.run`, **before** fanning out, insert a `running` attempt for every engine that will be tried (enabled set). Capture its `id` per engine.
* Each `runSearchRoute` updates that same row via `recordEngineAttemptEnd` instead of inserting a new row. Keep existing `engineScheduler.recordFailure` etc.
* For `skip` (circuit open, disabled) — still `INSERT status='skip'` one-shot, no running row needed; keep filtering `skip` out of Live view (user never wants to see skipped).
* `recordSearchEnd` already flips `searches.status`; ensure `searches.status='running'` row is visible with per-engine children while any child is running.

**Page ops / devtools:** already running — no change except pill mapping. Ensure `backend` stored is the **browser name** (`chromium`/`cloakbrowser`/…) not the short code. Today `browserOpenAndExtract` passes `result.browser || manager.config.defaultBackend` which is already the browser name; ensure `recordPageOpStart`/`recordPageOp` keep it verbatim.

**Activity feed query:** `getRecentActivity` already re-sends `ts >= now-60s` so a `running→ok` update for same `id` will be delivered as an updated row (merge-by-id or re-insert?). Current `page_ops` uses `id > ? OR ts >= ?` so an updated row with same `id` but newer `ts`? For `engine_attempts` the `ts` is original insertion time, not updated on `UPDATE`, so an `UPDATE` would **not** bump `ts` and would not be re-sent via the `60s` window if the original `search` already passed the `id > ?` cursor. Two options:
  * On `recordEngineAttemptEnd`, also `UPDATE engine_attempts SET ts = now` (touch), or store `updated_ts`.
  * Or, rely on `searches` row being `UPDATE`d at `recordSearchEnd` (which touches `searches`) and re-sent via its `60s` window, carrying fresh `attempts` join. For mid-search running states, the `searches` row itself is still `running` and within `60s`, so its `attempts` will be re-queried on each poll anyway? Currently `getRecentActivity` re-queries `searches` where `id > sinceId OR ts >= cutoff`, then for each search reloads `attempts`. If a new `running` attempt was inserted with `ts=now`, it belongs to a search already within the window, so it will be returned even though `search.id` is not `> sinceId`, because `search.ts >= cutoff`. So per-engine running rows will appear without needing to bump `search.ts`. After an engine finishes via `UPDATE`, its row's `ts` is unchanged, but it will still be returned as part of the same search's attempts join (since search is still within window). So no extra `ts` bump needed — but we should still `UPDATE ts` on finish for ordering consistency, or explicitly `UPDATE searches SET ts = ts` to keep window.

Choose to `UPDATE engine_attempts SET ..., ts = ?` on finish (touch) to keep attempt recency explicit — cheap.

**API contract:** `GET /stats/activity` shape unchanged (`entries[].attempts[]` now includes `status='running'` rows). Frontend already filters `status !== 'skip'` only, so running will naturally appear.

### 5.2 Frontend — real-time copy + tones + browser pill

**File:** `src/web-console/src/pages/status/index.jsx:660` `buildFeed` + `src/web-console/src/lib/format.js:66` + `src/web-console/src/style.css`

* **Search row copy:**
  * `search.status === 'running'` → `response = 'searching…'` (gold tone), `duration = '…'` or elapsed. Keep `search.error` handling.
  * Else keep existing `error ? 'error' : '${n} results'`.

* **Per-engine attempt copy (`buildFeed` attempt mapping):**
  ```
  running  →  'searching…' (gold, muted ellipsis), duration: '…' or elapsed
  ok       →  '${n} results' (green)  ·  duration
  fail     →  'failed · ${error}' (red)
  skip     →  filtered (no row)
  ```
  Remove the current `ok` with `0 results` green special-case confusion: an engine that finishes with `0` is already `fail` today (`Search engine returned no results`), so it will be red `failed…`, not green. If any engine ever returns `ok` with `0`, render `no results` in muted, not green.

* **Page ops / devtools rows:**
  * Map `tool` to verb: `web_fetch → fetching…`, `web_page_screenshot → capturing…`, `Target.createTarget → opening…`, `DOM.* → inspecting…`, `Runtime.* → running…`, `Input.* → interacting…`, `Page.navigate → navigating…`, `web_search → searching…` (fallback `running…`).
  * While `status='running'` → `response = verb` (gold), `duration = '…'`. On `ok` → `${chars} chars` or `${n} results` (green); on `fail` → `failed · ${error}` (red).

* **Tones:** Already `activity-row.running .feed-response {color:var(--gold)}` — extend to `.feed-attempt.running {color:var(--gold)}` (currently missing, so running attempts appear muted). Keep `ok` green, `fail` red.

* **Browser pill:** Replace `formatBackend` with `formatBrowser`:
  ```
  export function formatBrowser(browser) {
    const v = String(browser||'').toLowerCase();
    if (['chromium','cloakbrowser','lightpanda','api','-'].includes(v)) return v === '-' ? '-' : v;
    return { cb:'cloakbrowser', ch:'chromium', api:'api' }[v] || v || '-';
  }
  ```
  Keep old `formatBackend` exported but deprecated. Call sites: `src/web-console/src/pages/status/index.jsx:694,732` and attempt mapping. For `search` aggregate pill (unique backends of ok attempts) → unique **browsers** instead; for API-only search, show `api`. For `search` while running (no ok yet), show browser of first running attempt or `-`.

* **Empty / loading:** While a search has `running` attempts but no `ok` yet, the row should not show `0 results` — it shows `searching…` and its children show per-engine `searching…`.

* **Animation invariant:** Keep current `0fr` expand — filters still instant. Running rows are created with `is-new` on first poll (already handled by `KnownAllKeys` + `immediateAddedRef`), so they slide in.

### 5.3 Polling / timing

* Keep `POLL_MS=2000`. Running rows appear on next poll (≤2s). If we want sub-second feel, optionally lower to `1500ms` for `/stats/activity` only (separate timer), but not required for v1 — the spec is about copy, not latency. Document as follow-up.
* `60s` re-send window already ensures `running→done` updates propagate.

## 6. UI mock (text)

**Before (current):**
```
web_search - query: animation test beta          [CH]
  startpage -: failed · Execution context was destroyed… · 26.46s   (red)
  bing -: 11 results · 1.65s                                    (green)
```

**After — within 2s of starting:**
```
web_search - query: animation test beta  searching…  …          [chromium]  (gold, whole row)
  bing -: searching…  …                                          [api]       (gold)
  startpage -: searching…  …                                     [cloakbrowser] (gold)
```

**After engines settle (poll):**
```
web_search - query: animation test beta  11 results  2.4s        [chromium]  (green)
  bing -: 11 results · 1.65s                                     [api]       (green)
  startpage -: failed · Execution context was destroyed… · 26.4s [cloakbrowser] (red)
```

**Other tools:**
```
web_fetch - page: example.com  fetching…  …                      [cloakbrowser] (gold)
→  9,281 chars  420ms                                            [cloakbrowser] (green)
web_page_screenshot - page: example.com  capturing…  …           [chromium]   (gold)
Target.createTarget - tab: open example.com  opening…  …        [chromium]   (gold)
```

## 7. Implementation steps

1. **`src/activity.js`** — add `recordEngineAttemptStart` / `recordEngineAttemptEnd` (UPDATE + ts touch). Keep `recordDbEngineAttempt` for skip. Export.
2. **`src/search.js`** — in `browserSearch`, after `recordSearchStart`, insert running attempts for each planned engine (`getBrowserWarmupEngines` or `fetchEnginesForQuery`). Thread `attemptId` per engine into `runSearchRoute`; on finish call `recordEngineAttemptEnd` (touch ts). On skip, use one-shot `status='skip'`.
3. **`src/db.js`** — no DDL, but add comment that `engine_attempts.status` includes `running`; optional index already covers.
4. **`src/web-console/src/lib/format.js`** — add `formatBrowser`, deprecate `formatBackend` (keep shim).
5. **`src/web-console/src/pages/status/index.jsx`** — `buildFeed`:
   * attempt `response` switch with `running → searching…` (per verb map)
   * search `response` `running → searching…`
   * pageOp `response` verb map + gold
   * pill: `formatBrowser(entry.backend)` / `formatBrowser(attempt.backend)`
   * ensure `running` duration shows `…` and tone `running`.
6. **`src/web-console/src/style.css`** — add `.feed-attempt.running{color:var(--gold)}`, ensure ellipsis animation if desired (`searching…` CSS `content`).
7. **Build & verify:** `docker exec navigator npm install --include=dev && docker exec navigator npm run console:build`; exercise `web_search` (single and multi-query), `web_fetch`, `web_page_screenshot`, devtools `Target.createTarget`/`DOM.*` and watch Live activity real-time + final states + filter toggles.

## 8. Verification

* **Manual:** Trigger `web_search` with `engine=select_best` (fans out to 2-3 engines), `web_fetch` to slow URL, `web_page_screenshot`, `Target.createTarget` from console. Assert:
  * Within one poll (≤2s) a gold `searching…`/`fetching…` row appears, height `0fr` expands.
  * Per-engine sub-rows appear as `searching…` gold, then settle to green/red with duration.
  * Overall `0 results` never shows gold/yellow; `0` maps to red `failed`.
  * Pill shows `chromium`/`cloakbrowser`/`api`, not `CH`/`CB`.
  * Toggling `Web`/`DevTools` is instant, no animation; new work still slides.
* **Automated:** `vitest` unit for `buildFeed` mapping (`running` vs `ok` vs `fail`), `formatBrowser` cases.
* **DB:** Inspect `SELECT * FROM engine_attempts WHERE status='running'` during a slow search — row exists.

## 9. Rollout / migration

* No migration — `running` rows are ephemeral, pruned by 7-day `pruneActivity` and `60s` window. Old `ok`/`fail`/`skip` rows unaffected.
* `formatBackend` shim keeps old CSS classes working.

## 10. Risks & mitigations

* **Write amplification:** one extra INSERT per engine per search (2-3 rows). Mitigate: `running` rows are small, touching `ts` is one UPDATE. Negligible vs search latency.
* **Stale running rows** if process crashes before `recordEngineAttemptEnd` — they stay `running` and reappear via `60s` window, then age out (prune 7d but also `60s` window stops re-sending after 60s, so they vanish from feed after 60s). Acceptable; could also prune `running` older than 5 min in `pruneActivity`.
* **Poll race:** Two polls in flight — `since` cursors (`feedSince`/`feedOpsSince`) are monotonic, `ts >= cutoff` ensures updates for same `id` are still delivered. No loss.
* **API engines with `backend=null`** — pill shows `api`, not `-`.

## 11. Alternatives considered

* **In-memory only running state** (no DB) — faster but feed would need a separate SSE/live push; rejected to keep single `getRecentActivity` path.
* **Keep short backend codes** — rejected per user ask; short codes are cryptic.
* **Change poll to 500ms for sub-second feel** — considered as follow-up `POLL_MS_ACTIVITY=1000`, not required for copy fix.

## 12. Open questions

* Should `searching…` show elapsed (`1.2s`) live, or static `…` until done? Proposal: static `…` while running, final duration on settle — simplest and matches current `page_ops` (`…`).
* Exact `browser` value for API engines: `api` vs engine id (e.g. `tavily_api`). Pill could show `api` for all API engines, engine name already in sub-row.

---

## 13. Phase 2 — Click-to-detail pop-up for Live activity (new)

### 13.1 Goal

Clicking any Live activity row opens a focused pop-up (modal) with **full request details** — no navigation, no new page. Must work for all three kinds (`search` / `page_op:web` / `devtools`) and respect real-time updates (running row can be opened while still `searching…` and will live-update until it settles).

### 13.2 Current gap

`LiveFeed` renders `div.activity-row` as a plain `div` with no interaction (`src/web-console/src/pages/status/index.jsx:838`). No click handler, no modal component, no detail endpoint. `buildFeed` already has most fields (`query`, `variants`, `requested_engine`, `engines`, `result_count`, `duration_ms`, `error`, `attempts[]` with `engine/backend/status/result_count/duration_ms/error`, `pageOps` with `tool/url/backend/duration_ms/response_chars/ok/error/source/ts`). But the row only shows a 80-char preview and per-engine one-liner — full context (full query variants, full URL, full error text, timestamps) is truncated/ellipsized.

### 13.3 Proposed UX

* **Affordance:** `activity-row` gets `cursor:pointer` + `hover: background var(--panel2)` (same as `manage-table` hover). `title="Click for details"` and `role="button"` `tabIndex=0` (keyboard: `Enter`/`Space` opens). Keep `is-new` expand animation — click does not re-trigger it.
* **Modal:** New component `ActivityDetailModal` (`src/web-console/src/components/ActivityDetailModal.jsx` or inline in `status/index.jsx` for v1). Rendered via portal at `body`:
  * Backdrop `fixed inset:0 bg: rgba(8,12,20,.58)` (same as `api-key-modal-backdrop` `src/web-console/src/style.css:2075`), `backdrop click` + `Esc` closes, focus trap, `aria-modal`.
  * Card `width:min(640px, calc(100vw - 32px))` `max-height:80vh` `overflow:auto` (mirrors `api-key-modal` `src/web-console/src/style.css:2084`).
  * Header: `kind` icon (`Web`/`Dev`), `tool` (`web_search`/`web_fetch`/devtools verb), pill `browser` (same `formatBrowser` from Phase 1), `time` (`formatTime` + `formatRelativeTime`), `duration` or `…` if running, close `×` button.
  * Body — varies by kind:
    * **Search (`kind==='search'`):** `query` (full, copy button), `variants` (list if >1), `requested_engine` / `engines`, `status` pill (`running` gold / `ok` green / `fail` red), `result_count` + `duration_ms` (`…` if running), `error` (if fail, `pre-wrap` red). Sub-section **Engines** table: `engine | browser | status | results | duration | error` — uses same gold/green/red tones as Live row; `running` rows show `searching…` + `…`. If `directAnswers` exist, show count.
    * **Page op (`page_op`/`devtools`):** `tool`, `url` (full, link + copy), `browser`, `source` (`mcp`/`devtools`), `status`, `duration_ms`, `response_chars`, `error` (full text). For `web_fetch`/`web_page_screenshot` show `backend` browser pill.
  * Footer: `Copy ID` / `Copy error` buttons, `Close` (primary).
* **Live update:** Modal is fed from the same `feed` array (prop). If the underlying entry updates (`running→ok`), the modal content re-renders in place without closing. No new fetch required for v1. If user opened a row that later scrolls out of the 200-row window, keep last snapshot.

### 13.4 Data — frontend-only v1, no new endpoint required

* `buildFeed` already retains `search.variants`, `requested_engine`, `engines`, `attempts[]` full objects, and `pageOps` full row. No backend change for v1; just pass the **selected entry object** from `feed` into the modal.
* Optional follow-up: `GET /stats/activity/:id` (search or pageOp) for truncated `variants`/`error` beyond `300` chars or for `results` preview. Not needed for Phase 1 — `error` already `slice(0,300)` and `query` `slice(0,500)` are sufficient for detail view.

### 13.5 Implementation steps (Phase 2)

1. **`src/web-console/src/pages/status/index.jsx` (`LiveFeed`):**
   * Add `const [selectedKey, setSelectedKey] = useState(null)`; `selectedEntry = feed.find(e=>e.key===selectedKey)`.
   * Make `div.activity-row-wrapper > div.activity-row` clickable: `onClick={()=>setSelectedKey(entry.key)}` + `onKeyDown` for `Enter/Space`. Stop propagation on inner `feed-attempts` not needed.
   * Render `<ActivityDetailModal entry={selectedEntry} onClose={()=>setSelectedKey(null)} />` when `selectedEntry`.
   * Keep filter-safe logic: clicking never mutates `feed` or `knownAllKeys`.

2. **New component `ActivityDetailModal.jsx` (or inline):**
   * Props `{entry, onClose}`. Derive `kind` (`search` vs `page_op`/`devtools`). Reuse `formatTime`, `formatRelativeTime`, `formatMs`, `formatBrowser` (Phase 1) and `Pill`/`Dot`.
   * Implement backdrop, `useEffect` for `Esc` and `focus` trap, `createPortal` to `document.body`.
   * Copy helpers (`navigator.clipboard.writeText` fallback like `RelayAuth` `src/web-console/src/pages/status/index.jsx:337`).
   * No new state for polling — derive directly from `entry`.

3. **`src/web-console/src/style.css`:**
   * Add `.activity-row:hover{background:var(--panel2)}` `cursor:pointer`.
   * Add `.activity-detail-backdrop`, `.activity-detail-modal`, `.activity-detail-head`, `.activity-detail-grid`, `.activity-detail-table`, etc., copying `api-key-modal` variables (`--panel`, `--line`, `box-shadow:0 18px 48px rgba(0,0,0,.35)`).
   * Keep existing `is-new` animation — modal open does not add class.

4. **Verification (Phase 2):**
   * Trigger `web_search` (with per-engine `searching…` from Phase 1), `web_fetch`, `Target.createTarget` — click each row type, assert pop-up shows full query/url/browser/status/duration/error, copy buttons work, `Esc`/backdrop closes, keyboard `Enter` opens, filter toggles don't break selection, live-update: open a `running` search then wait for poll — modal flips to `11 results` without closing.
   * Vitest: `ActivityDetailModal` renders `search` vs `pageOp` fixtures.

### 13.6 Risks

* `feed` entry may be pruned from the 200-row window while modal is open — keep snapshot in `selectedEntry` state (copy on open) so modal doesn't blank.
* Click target vs inner links — ensure `onClick` on row doesn't interfere with text selection; use `role="button"`.

### 13.7 Rollout

* Phase 2 is strictly additive — no DB/migration, no `/stats/activity` change. Can ship before or after Phase 1 backend change; but it benefits from Phase 1's `running` engine rows (otherwise detail will show no per-engine progress).


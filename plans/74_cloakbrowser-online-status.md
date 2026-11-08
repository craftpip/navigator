# 74 — CloakBrowser (CDP Add-On) Not Shown Online in Console — Bug

**Status:** Proposed — bug report, 0/2 items done
**Priority:** Normal
**Created:** 2026-10-10

## 1. Symptom

The user started `cloak-browser` (`docker compose -f docker-compose.cloak.yml up -d`,
verified up on `127.0.0.1:9222`, reachable from the navigator container) with an existing
`BROWSERS` entry `{"name":"cloakbrowser","type":"cdp","cdpUrl":"http://cloak-browser:9222"}`
in `.env` — but the console **does not show it as online**.

## 2. Evidence (measured on the live system)

- `docker exec navigator curl http://cloak-browser:9222/json/list` → **200**, `[{"type":"page","title":"New Tab",…}]`.
- `docker exec navigator curl localhost:1994/stats` → instances cloakbrowser = **`connected:true`, `status:"connected"`, `tabs:1`**
  (this is `_cdpStatViaHttp`, `src/browser.js:957-997`, which probes `/json/list`).
- `docker exec navigator curl localhost:1994/health` → browsers cloakbrowser = **`status:"available", connected:…`**

So the two endpoints **disagree**: `/stats` says connected, `/health` says `available`.

## 3. Root cause — two cooperating layers

**Layer 1 — status is hardcoded for plain CDP add-ons.**
`relay-server.js getStatusEntries()` (`src/relay-server.js:456-468`) always emits
`status: "available"` for every non-`navigator-cdp` add-on — it never reflects reachability.
`_effectiveAddOns()` (`src/browser.js:743-745`) is just a pass-through of that, so
`getHealth()`'s `browsers[].status` is a constant for cloakbrowser/lightpanda.

**Layer 2 — `/health` never warms the probe cache.**
`getHealth()` sets `connected` for plain CDP add-ons via `_isAddOnConnected(name)`
(`src/browser.js:1441-1445`), which for non-relay add-ons reads `this._cdpProbeCache` with a
**10s TTL** (`src/browser.js:921-931`). That cache is only written by `_cdpStatViaHttp`, which
runs inside `getInstanceStats()` (`src/browser.js:1533-1542`, the `/stats` path) or by an
actual page-tool connect. `getHealth()` itself never probes. Consequences:
- A sidecar started after navigator is up shows offline until the console's next `/stats`
  poll (or any page-tool call) warms the cache.
- The cache expires after 10s of no `/stats` — `/health` flips back to `connected:false`
  while `/stats` keeps saying online, so the status page (uses `/stats`) and the API-keys
  browser dots / MCP `list_browsers` (both use `/health` `browsers[]`) can disagree and
  flicker.

**Why the user saw offline:** the /health-driven surfaces (`/console/api-keys` browser rows,
`list_browsers`) render the hardcoded `available` + a cold/expired probe cache as not-online.

## 4. Suggested fix (one consistent source of truth)

- Merge live reachability into the add-on status that `getHealth()` serves. Cleanest: make
  `_effectiveAddOns()` (or the `getHealth()` `browsers[]` builder, `src/browser.js:1399-1454`)
  run the cheap `/json/list` probe (reusing `_cdpStatViaHttp` / `_cdpProbeCache`) for plain
  CDP add-ons that hold no live puppeteer connection, so `status` becomes
  `"connected"` (probe ok) / `"available"` (probe failed) instead of the constant, and
  `connected` is derived from that — never from a stale cache alone.
- Make the probe-cache TTL match the poll cadence (or keep a probe within `getHealth` itself)
  so `/health` cannot decay to "offline" while `/stats` says online — the two must never
  disagree on the same browser.
- Decide the healed value at the source: `relay-server.js:461` keeps `"available"` only as
  the *unreachable* state, not the default.

## 5. Testing

**Unit (`tests/browser.test.js`):**
- A plain CDP add-on whose `/json/list` probe succeeds reports `status:"connected"` and
  `connected:true` from both `getHealth()` and `getInstanceStats()`; a failing probe reports
  `"available"` + `false` everywhere.
- `/health` does not need a preceding `/stats` to be truthful (probe runs on demand).

**Live (after `docker restart navigator`):**
- Start from a cold navigator (regular docker restart does not stop cloak-browser), open the
  console → cloakbrowser shows online in the browser-drivers panel AND the API-keys browser
  rows; `list_browsers` reports `connected:true`.
- Kill cloak-browser → both surfaces flip to offline within one poll; restart → online again.

## 6. Checklist

- [ ] 1. Root cause fix: one live-probe source for plain CDP add-on status in `getHealth()`/`_effectiveAddOns()`.
- [ ] 2. Verify `/health` and `/stats` agree; console drivers panel + API-keys dots + `list_browsers` all online.

## 7. Not Doing

- No change to how cloaks are reached or their roles/config; no auto-start of the sidecar.
- No commit unless asked.
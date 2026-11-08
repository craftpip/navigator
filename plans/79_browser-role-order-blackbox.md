# Plan 79 — Black-box test: BROWSERS roles + ordering → which CDP connection fires

## Status: Draft — 0 cases done. Plan written 2026-10-16, expanded same day to cover ALL four browser types (inbuilt chromium, cloakbrowser, lightpanda, relay browser from the user's Chrome extension). Awaiting user connecting the browsers. No code changes intended — pure black-box verification of documented behavior.

**Goal:** Verify, from the outside (MCP tool surface as the primary lens, no source reading during the run), that the `BROWSERS` array's `role` lists and array **order** actually control which CDP connection serves a page-tool call — especially `web_fetch` — **across all four browser types**. Edit the config (drop a role, empty the role array, reorder entries, take one down), restart, call the tool, observe which browser actually served it.

**What we are testing (documented contract from AGENTS.md):**
- Each `BROWSERS` entry carries `role: [...]` — `default`, `search`, `fetch`, `screenshot`, `devtools`. An **empty** `role: []` marks a browser as fallback/backup-only.
- **Array order = rollback chain.** Page tools (`web_fetch`, `web_page_screenshot`, `web_page_ascii`, `web_page_svg`, devtools) go through `resolveBrowserParam()`: explicit `browser` param (strict — errors if that browser is down) → add-ons tried in `BROWSERS` array order (first to connect serves; down add-ons reported in `rollbackNotes`) → Chromium (always present, self-healing).
- Entry `type`s: `"inbuilt"` (chromium, always present), `"cdp"` (cloakbrowser, lightpanda — user-owned external CDP processes), `"navigator-cdp"` (relay — the user's Chrome extension dialing `/relay`).
- `web_search` always runs on Chromium — engines never use add-ons.

---

## The four browser types under test

| # | Type | Entry shape (baseline to record) | How it comes up | Serving fingerprint (how we tell it served) |
|---|------|----------------------------------|-----------------|---------------------------------------------|
| A | **inbuilt chromium** | `{"name":"chromium","role":[...]}` | always present | Control: NO visible window anywhere, real rendered screenshot. Serving verdict mostly by elimination. |
| B | **cloakbrowser** (`cdp`) | `{"name":"cloakbrowser","role":[...],"cdpUrl":"http://cloak-browser:9222"}` | `docker compose -f docker-compose.cloak.yml up -d` | Headless sidecar — no user-visible window. Fingerprint = corroboration via its own target list (see signal 7) + real rendered screenshot (chromium-based). |
| C | **lightpanda** (`cdp`) | `{"name":"lightpanda","role":[...],"cdpUrl":"ws://172.22.0.222:9222"}` (static IP — hostname `cdpUrl` gets 403) | `docker compose -f docker-compose.lightpanda.yml up -d` | **Strong fingerprint:** placeholder screenshot (no graphical render engine — flat white/text render), plus its own target list. |
| D | **relay browser** (`navigator-cdp`, user's Chrome plugin) | `{"name":"<your-browser>","role":[...],"cdpUrl":...}` — actually the relay entry is dynamic/paired; record how it appears in config/list | user pairs the extension from their Chrome with a PIN | **Strongest fingerprint:** a real visible tab opens in the user's Chrome window. |

> Per-type observability is uneven by nature — chromium/cloak are headless. So every case records BOTH the MCP-side output AND at least one corroboration signal from the table above. **If no available signal can name the serving browser for a type, that inability is recorded as a finding** (see Pass/fail), not hand-waved.

## Black-box observation signals (no source reading during a run)

1. **Visible tab** (relay type D) — the visited URL appearing in the user's Chrome = D served.
2. **Lightpanda screenshot artifact** (type C) — placeholder-style render = C served a screenshot call.
3. **Strict `browser` param errors** — asking for a named browser that is down must fail, not silently fall back. The error text is a result.
4. **`rollbackNotes`** — a configured add-on that is down mid-chain should be reported while the result still comes back from a later entry / chromium.
5. **`list_browsers`** — configured names, roles, status as the tool surface sees them.
6. **Devtools probe** — `Target.createTarget` + screenshot of the target tells us where the devtools path landed (visible window for D; placeholder for C; normal render for A/B).
7. **Corroborating target list (secondary channel)** — when the MCP output alone cannot name the server, query each add-on's own CDP endpoint for open targets (cloak/lightpanda: `GET <cdpUrl>/json/list` style probe; relay: the tab is simply visible). This is still black-box w.r.t. navigator — we are observing the browsers themselves, not navigator's source. Use it only when signals 1–6 are inconclusive, and note in the row that corroboration was needed.

Verdict per case: **which browser served** = chromium | cloakbrowser | lightpanda | relay\<name\> | error — plus the signal(s) that produced the verdict.

---

## Prerequisites

- [ ] **All four types reachable before Phase A starts:**
  - [ ] inbuilt chromium — always on (control).
  - [ ] cloakbrowser sidecar up (`docker compose -f docker-compose.cloak.yml up -d`) and its entry in `BROWSERS`.
  - [ ] lightpanda sidecar up (`docker compose -f docker-compose.lightpanda.yml up -d`, static IP `ws://172.22.0.222:9222` in the entry).
  - [ ] relay browser: user's Chrome extension paired and connected (PIN flow done once).
- [ ] Baseline `BROWSERS` recorded **verbatim** (the exact config text for all entries).
- [ ] Baseline `list_browsers` output captured through MCP.
- [ ] Server reachable through MCP (tools/list shows the web tools).

> If only a subset of types can come up, the plan still runs for that subset — unavailable types get their rows marked `blocked: type not connected`, never silently skipped.

## Config edit loop (per case)

Config changes need a restart to take effect (`BROWSERS` is parsed at load):

1. Edit the `BROWSERS` env (docker-compose.yml / `.env`) for the case.
2. `docker compose restart navigator` (or `docker restart navigator`).
3. Re-establish the MCP session; capture fresh `list_browsers`.
4. Run the case's tool calls; record verdict + raw output + corroboration signal.
5. Restore/advance to the next case's config.

> Record the exact config text used for each case in the results table — config drift between cases invalidates the run.

---

## Test cases

### Phase A — Per-type role gating (run the trio A1–A3 once per add-on type: B, C, D)

The trio is the core question: **does removing a role from a specific entry actually move that tool's traffic off that browser?** Run it three times — once with only cloakbrowser carrying the roles, once with only lightpanda, once with only relay.

#### A1 — Baseline (per type)
- Config: all four entries present, chosen type carries `fetch` + `screenshot` + `devtools` roles; others carry no `fetch`.
- Calls: `web_fetch(marker-url)`, `web_page_screenshot(marker-url, quality: "low")`, devtools `Target.createTarget` + screenshot.
- Expect: all three served by the chosen type (fingerprint per table). If baseline already deviates, **stop that type and record — the rest of its cases are suspect.**

#### A2 — Remove `fetch` from the chosen type's roles
- Config: that entry loses `"fetch"` (keep `screenshot`, `devtools`); no other entry gains `fetch` → chain falls through to chromium.
- Calls: `web_fetch` → expect **chromium** (A); `web_page_screenshot` → still the chosen type.
- Verifies role gating is per-tool, not all-or-nothing.

#### A3 — Empty role array (`"role": []`, backup-only)
- Config: chosen type gets `role: []`.
- Calls: `web_fetch`, `web_page_screenshot`, one devtools call.
- Expect: **all on chromium**; the entry still shows in `list_browsers` but never serves.

**Phase A rows × 3 types (B, C, D).** Type D extra check: the visible tab must appear/disappear exactly when D is expected to serve/not serve — it is the clearest yes/no signal in the whole plan.

### Phase B — Ordering across mixed types (all four entries in one chain)

#### B1 — Reorder: two add-ons both carrying `fetch`
- Config: two add-ons with `fetch` (cover the interesting pairs: D+C, D+B, C+B — at least two pairs if time allows; the pair actually available decides).
- Calls: `web_fetch` ≥3×.
- Expect: the **first** array entry serves every time; after swapping order, the other one serves every time. Order, not connection race.

#### B2 — Full rollback chain with the primary DOWN
- Config: all four entries, `fetch` on B+C+D in some order; stop the primary (e.g. kill cloak container or disconnect the relay browser).
- Calls: `web_fetch`.
- Expect: served by the next entry in order (fingerprint tells us which), with the down entry surfaced in `rollbackNotes`. Repeat once with TWO entries down → the third serves.

#### B3 — Chain of all three add-ons down
- Config: all add-ons present in config but all actually stopped/disconnected.
- Calls: `web_fetch`, `web_page_screenshot`.
- Expect: chromium serves (self-healing last resort); ideally `rollbackNotes` names each dead add-on. A silent chromium serve with zero indication of three dead add-ons = **finding** (`response:`).

### Phase C — Strictness, devtools, search (one run, baseline-ish config)

#### C1 — Explicit `browser` param, strict mode (per type)
- Config: all four up, normal roles.
- Calls: `web_fetch(..., browser: "<name>")` for each type's name → must be served by exactly that type. Then stop one type → same call must **error** (strict), not fall back. `browser: "chromium"` must always work.
- Lightpanda caveat: a lightpanda serve may succeed while producing its placeholder output — that still counts as "served by lightpanda".

#### C2 — Devtools role isolation
- Config: one add-on keeps only `devtools` (no fetch/screenshot).
- Calls: devtools `Target.createTarget` → lands on that add-on; `web_fetch` → chromium; `web_page_screenshot` → chromium.
- Repeat for the relay type (D): the created target must be a real tab in the user's Chrome.

#### C3 — `web_search` ignores add-on roles entirely
- Config: add-ons carry ALL roles including `search`.
- Calls: `web_search(queries: ["test query"])`.
- Expect: search runs on chromium regardless. If a visible tab opens in the relay browser (D) or a target appears on B/C during search, that is a **deviation**.

---

## Results table (fill during the run)

| Phase/Case | Type | Config change | Call | Served by (observed) | Signal used | Expected | Pass? | Notes / raw error text |
|------------|------|--------------|------|----------------------|-------------|----------|-------|------------------------|
| A1 | B cloak | baseline | fetch/screenshot/devtools | | | cloak | | |
| A2 | B cloak | −fetch role | web_fetch | | | chromium | | |
| A2 | B cloak | −fetch role | screenshot | | | cloak | | |
| A3 | B cloak | role [] | all tools | | | chromium | | |
| A1–A3 | C lightpanda | (same trio) | … | | | … | | |
| A1–A3 | D relay | (same trio) | … | | | … | | |
| B1 | mixed | reorder ×pair | web_fetch ×3 | | | first entry each time | | |
| B2 | mixed | primary down | web_fetch | | | next entry + rollbackNotes | | |
| B3 | all down | all add-ons dead | fetch/screenshot | | | chromium (+ notes) | | |
| C1 | each | browser param up/down | web_fetch | | | exact type / strict error | | |
| C2 | one | devtools-only role | devtools vs tools | | | split per role | | |
| C3 | all | search role granted | web_search | | | chromium | | |

## Pass / fail criteria

- **Pass:** every case's observed serving browser matches the expectation column, for every type that was reachable.
- **Fail:** any mismatch — especially role edits having no effect, ordering not honored (second entry serving while first is up), strict mode silently falling back, or `web_search` leaking onto an add-on.
- **Observability failure is a finding in its own right:** if for some type no signal (1–7) can determine the serving browser from the outside, log it tagged `tool:` — e.g. a feature request for a `browser: "<name>"` line in tool responses. Do not mark the case pass on assumption.
- Failures are recorded as findings (friction-log style, `request:`/`response:`/`tool:` tags). Source investigation happens only AFTER a fail, to explain it.

## Out of scope

- No source reading during the run (black box). Source investigation happens only AFTER a fail, to explain it.
- No code changes unless a case fails and a fix is filed as a follow-up item.
- `BROWSERS` config edits are reverted to baseline at the end of the run.
- Firefox extension and windows-mode behavior — separate concerns, not in this run.

## Checklist

- [ ] Baseline recorded (config text + `list_browsers`)
- [ ] All four types up: chromium / cloak / lightpanda / relay (or unavailable ones marked blocked)
- [ ] Phase A trio (A1–A3) — type B cloakbrowser
- [ ] Phase A trio (A1–A3) — type C lightpanda
- [ ] Phase A trio (A1–A3) — type D relay (Chrome plugin)
- [ ] B1 — reorder across mixed types (≥2 pairs)
- [ ] B2 — rollback chain with 1 then 2 entries down
- [ ] B3 — all add-ons down → chromium last resort
- [ ] C1 — explicit `browser` param strictness, per type
- [ ] C2 — devtools role isolation (incl. relay real tab)
- [ ] C3 — `web_search` stays on chromium
- [ ] Results table filled; findings logged; config restored to baseline

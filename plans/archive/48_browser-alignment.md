# 48 — Browser Alignment

**Status:** **Archived 2026-09-29 by user directive — the design below was never
adopted. 0 of 5 §5 proposal sections, 0 of 14 §8 checklist items.** Re-validated
2026-09-29 before archiving; the previous header read "Implemented 2026-09-05"
and that was **false** — this file was only ever committed once (`1d2253e`,
2026-09-24, a relay-lifecycle commit) as a new 191-line file with the
"Implemented" claim already baked in, and no commit in history implements it.
Ground truth at archive time: `src/config.js:21` still validates all **five**
roles including `screenshot`; `SEARCH/FETCH/DEVTOOLS_PREFERRED_BROWSER` exist
nowhere in the repo; the only `resolveBrowserParam` call site passing `roles` is
`src/devtools.js:729`; `web_search` has no `browser` param; the console still
offers the five-role checkbox form with no ★ and no unified view.
**Do not read this as shipped** — the browser→job routing this plan describes was
replaced by already-shipped mechanisms: an explicit per-call `browser` param on
the page tools, and per-key browser scoping on the **API keys** page
(`allowedBrowsers` / `allowedMcpBrowsers`, plan 57), which gate *which key may
use which browser* rather than *which job a browser may serve*. §11 holds the
full ground-truth check, §12 the plans that landed since, §13 the decisions that
were never taken.
**Created:** 2026-09-05
**Scope:** `BROWSERS` array semantics — roles, types, and how search / page tools / devtools actually route (`src/config.js`, `src/browser.js`, `src/search.js`, `src/devtools.js`, `src/mcp-server.js`, `src/engines/`, console `manage` + `status` + `tools` pages, docs/env examples)

---

## 1. Problem

Three things disagree with each other, and the console UI presents all three as if they agree:

1. **Roles lie.** The `BROWSERS` editor offers five roles — `default`, `search`, `fetch`, `screenshot`, `devtools` (`src/config.js:21`, `src/web-console/src/pages/manage/index.jsx:331`) — but routing honors almost none of them:
   - `web_search` never touches `BROWSERS` at all. Browser engines pool per-engine Chromium windows (`src/browser.js:849-851`, `src/search.js:1001`); API engines do plain HTTP (`src/search.js:992-998`). No `resolveBrowserParam`, no role filter. A `search` role on any add-on is a dead label today (plan 39 §147 made this explicit: "Add-on browsers are not used by search engines").
   - `web_fetch` / `web_page_screenshot` / `ascii` / `svg` call `resolveBrowserParam({ browser })` with **no** `roles` filter (`src/search.js:2202`, `src/search.js:2475`, `src/mcp-server.js:2448,2675`). Every effective add-on is tried in array order regardless of its roles. `fetch` / `screenshot` roles change nothing.
   - Only devtools window creation passes a role gate: `{ roles: ["devtools", "default"] }` (`src/devtools.js:577-581`). So `devtools` and `default` are the only two roles with any runtime effect, and `[]` (empty) means "skipped by the gated chain; the hardcoded Chromium line (`src/browser.js:1514`) still guarantees a page".
2. **Screenshot taxonomy is confusing.** `web_page_screenshot` (plus `ascii`/`svg`) is a **page tool** — same plumbing as `web_fetch` (`resolveBrowserParam`, no role gate, serving-browser tagging). It is not a devtools window tool, even though screenshots also exist inside devtools flows and the status/instances UI groups tabs/timers near devtools concepts. The user read screenshot as "counted under DevTools" — the UI/docs never state the three-group model (search engines vs page tools vs devtools) in one place.
3. **`navigator-cdp` in the `BROWSERS` type dropdown has no clear purpose.** Relay browsers connect by pairing from the Chrome/Firefox extension (`navigator-hello` → `_ensureEntry`, token in `relay_sessions`, live entry in `RelayServer._entries` — all in-memory except the token). Unconfigured names appear automatically as dynamic entries with `role: ["default"]`, `configured: false` (`src/relay-server.js:234-249` via `_effectiveAddOns()` at `src/browser.js:548-550`). A `BROWSERS` row with `type: "navigator-cdp"` therefore only **pre-declares** a name — to pin roles/order/plugin before first pair. The editor presents it as a peer of `inbuilt`/`cdp` with no "optional / usually unnecessary" signal, so users reasonably ask why it exists.

Net effect: engine selection vs browser selection look like one system but are two unrelated systems, and the config surface advertises knobs that do nothing.

---

## 2. Goals

- Any browser for any task: every configured browser — `inbuilt`, `cdp`, `navigator-cdp` — can serve search, fetch, and devtools (screenshots count as devtools), governed by one role model.
- One true role model: every role offered in the UI gates a real routing decision. `default` = all tasks; `search` / `fetch` / `devtools` = that task only (screenshots ride the `devtools` chain); `[]` ("Standby") = never preferred, Chromium covers. One migration: existing `screenshot` roles fold into `devtools` with a one-release warning.
- One true type model: `inbuilt` / `cdp` / `navigator-cdp` each have a one-sentence job, and the console says which one needs config and which one is automatic.
- One taxonomy stated everywhere it matters: **search engines** (browser engines run on a resolved search browser + new `browser` param; API engines use no browser) vs **fetch** (`web_fetch`, `browser` param + fallback chain) vs **devtools** (CDP windows AND `web_page_screenshot`/`ascii`/`svg`, `browser` param + gate).
- Behavior changes are explicit and release-noted (search backend moves for search-role setups — that is the point — plus the edge cases in §9).

## 3. Non-goals

- Reintroducing per-backend engine drivers (plan 39 stays dead): drivers remain backend-agnostic pure search logic (`submit`/`extract`/`assertNotBlocked`); only *which browser* hosts the engine window becomes routable. No `backend` field, no registry revival.
- Changing the relay pairing/token store (plan 41/42 territory).
- Restyling the console beyond labels/help text needed for the alignment.

---

## 4. Current behavior (ground truth)

| Tool group | Entry point | Browser selection | Roles honored? |
|---|---|---|---|
| `web_search` | `runSearchEngine` (`src/search.js:988-1026`) → `acquireSearchWindow` → `newPage({ engine })` | Chromium always (`src/browser.js:849-851`); API drivers no page | None. `BROWSERS` ignored |
| `web_fetch` | `src/search.js:2201-2203` | `resolveBrowserParam({ browser })`, no roles → effective add-ons in order → Chromium (`src/browser.js:1500-1514`) | None (all tried) |
| `web_page_screenshot` / `svg` / `ascii` | `src/search.js:2475`, `src/mcp-server.js:2448,2675` | Same as fetch, no roles | None (all tried) |
| Devtools window (`Target.createTarget` etc.) | `src/devtools.js:577-582` | `resolveBrowserParam(..., { roles: ["devtools", "default"] })` | `devtools` + `default` only; `[]` skipped (final Chromium line still guarantees a page) |
| Explicit `browser` param | `resolveBrowserParam` explicit branch (`src/browser.js:1475-1498`) | `_effectiveAddOns().find(name)` — includes dynamic relay entries; `navigator-cdp` requires `status === "connected"` | With `roles` opt (devtools only); otherwise name must simply exist + be connected |

Effective list: `_effectiveAddOns()` = configured add-ons (config order, roles honored as above) + dynamic relay registrations appended with `role: ["default"]` + paired-but-disconnected tokens (`src/relay-server.js:195-239`).

Config surface: `parseBrowsersEnv` (`src/config.js:170-299`) accepts the five roles, three types, `plugin` for relay; auto-appends `chromium` if missing. Console `BrowserArrayEditor` (`manage/index.jsx:331-525`) mirrors the same five roles + three types with no per-option help. `list_browsers` tool description (`src/mcp-server.js:2039`) explains ownership but not the role/routing split.

---

## 5. Proposal

### 5.1 Roles: wire every role (adopted — "any browser, any task")

Direction (2026-09-05, user directive): any browser must be usable at any task. So instead of shrinking the role set, make the roles real — and screenshots count as devtools, so there are three jobs, not four. The console offers `search` / `fetch` / `devtools` / `default` — after this plan each one gates routing, and the UI stops lying without losing knobs.

Role → task mapping (each chain tries its preferred browser first, then candidates in array order, then Chromium):

| Role | Task it gates | Chain | Preferred setting |
|---|---|---|---|
| `default` | everything below (generalist) | member of all three chains | — |
| `search` | browser-engine searches | `web_search` candidates `{ roles: ["search", "default"] }` | `SEARCH_PREFERRED_BROWSER` |
| `fetch` | `web_fetch` | `{ roles: ["fetch", "default"] }` (`src/search.js:2202`) | `FETCH_PREFERRED_BROWSER` |
| `devtools` | devtools windows AND screenshots (`web_page_screenshot` + `ascii` + `svg`) | `{ roles: ["devtools", "default"] }` (`src/devtools.js:577-582`, `src/search.js:2475`, `src/mcp-server.js:2448,2675`) | `DEVTOOLS_PREFERRED_BROWSER` |
| `[]` ("Standby") | nothing implicit | skipped by all three chains; Chromium last resort; explicit per-call `browser` still reaches any connected browser (override), documented in help | — |

**Per-task priority (why a preferred setting exists).** Array order alone cannot express "A first for fetch, B first for search" — one ordering picks the same winner for every chain. So each task gets an optional preferred browser (name or empty = array order). Resolution per task, in order: (1) ★ preferred — if set, connected, and holding the needed role; (2) every other role-holding browser, top-to-bottom as listed; (3) built-in Chromium, always last. Preferred down or role-less → skipped with a rollback note, never a hard error on implicit calls. No ★ at all → step 2 decides everything, i.e. plain list order. Explicit per-call `browser` still beats everything. Preferred is set inline in the unified UI (§5.5, ★ per column) — no separate block, no drag-to-reorder in v1.

- `web_search` gains a `browser` param (explicit per-call override, like page tools). API engines ignore it (no page) — say so in the description. Explicit-but-down errors instead of silently rolling to Chromium (same contract as page tools). Implicit (no param): first connectable candidate with `search`/`default`, else the Chromium pooled window.
- Search pooling: Chromium keeps the per-engine warm pools (fast path, unchanged, incl. `SEARCH_ROUTE_WARMUP_ENGINES`). Non-Chromium search browsers serve via transient pages (open → submit → extract → close), reusing the candidate/rollback pattern from `resolveBrowserParam`. No per-(engine, browser) pools in v1. Relay searches open real tabs in the user's window (visible flash) — only when the user gave that browser `search`/`default` or named it explicitly; help copy must warn. Fan-out (`select_best` → 2–3 engines) resolves per engine, so concurrent relay tabs are possible — accept in v1, cap later if noisy.
- Migration (only one, warn-once): the old `screenshot` role folds into `devtools` — `["fetch","screenshot"]` → `["fetch","devtools"]` with a console warning naming the entry. Every other existing role array parses unchanged. The shipped all-roles samples drop `screenshot` (they already carry `devtools`, so zero behavior change); the lightpanda sample becomes `["fetch","devtools"]` (it keeps its screenshots, now via the devtools chain).
- Startup honesty log: one line per browser with its effective task set (e.g. `cloakbrowser: search, fetch, screenshot, devtools`), so "which browser does what" is visible without reading code.
- Chromium's own role stays cosmetic (inbuilt never enters `_effectiveAddOns()`; always the hardcoded fallback) — note it in the editor, don't gate on it.

**Rejected alternative — shrink to two roles (documented for the record).**
- Was the previous recommendation (delete `search`/`fetch`/`screenshot`, gate page tools on `default`). Rejected by user directive: any browser must be usable at any task, which needs per-task roles, not fewer. (The `screenshot` role alone IS removed — folded into `devtools` per the screenshots-are-devtools directive.)

### 5.2 Types: make `navigator-cdp` explicitly "pre-declared (optional)"

- Keep the type (removing it breaks pre-declared role/order pinning and `plugin` selection), but stop presenting it as a normal browser row:
  - Console `BrowserArrayEditor`: label the option `Navigator CDP (pre-declared, optional)` with inline help: "Usually unnecessary — paired extensions appear automatically under Browser drivers with role `default`. Add a row only to pin a name's roles/order before first pair, or to set Plugin." Dynamic (paired but unconfigured) entries are **read-only** in the Drivers panel, never editable in the array editor.
  - Validation: `navigator-cdp` rows must not carry `cdpUrl` (already enforced, `src/config.js:283-287`); warn when a pre-declared relay name has never paired ("reserved, awaiting first pair" pill in Drivers, using existing `paired`/`status` fields — no new status).
  - Relay + search warning: the `search` toggle on `navigator-cdp` rows (and dynamic entries) carries help copy — "Searches open visible tabs in your window." The role IS the consent; no extra gate.
  - Docs/`BROWSERS` help text: "Relay browsers dial in from the extension; the array never creates them, it only reserves their name."

### 5.3 Taxonomy: say the three-group model in the three places users look

1. `list_browsers` tool description: append one line — "Task chains read this list: search (`search`/`default`), fetch (`fetch`/`default`), devtools incl. screenshots (`devtools`/`default`). `browser` param (including the new one on `web_search`) overrides the chain; API search engines use no browser."
2. Console `Browser drivers` panel: devtools section owns screenshots (counts + entries); subtitle notes search runs on `search`/`default` browsers, Chromium fallback.
3. `BROWSERS` editor header/detail (`manage/index.jsx:7`): "JSON array of browser entries — tick which tasks each browser may serve (Default = all). API search engines use no browser."

### 5.4 Screenshot placement (screenshots ARE devtools — user directive)

- Routing: `web_page_screenshot`/`ascii`/`svg` join the devtools chain — `{ roles: ["devtools", "default"] }` at `src/search.js:2475`, `src/mcp-server.js:2448,2675`, preferred via `DEVTOOLS_PREFERRED_BROWSER`, same fallback/rollback as devtools windows. (Mechanism stays transient pages; only the gate changes.)
- Labeling: the three screenshot tools gain "(devtool — needs a `devtools`/`default` browser)"; fetch gains "(needs `fetch`/`default`)"; `web_search` gains "(browser engines need a `search`/`default` browser; API engines use no browser)".
- Counting: screenshot activity/counters render under the devtools group in Status (no counter renames in v1 — display grouping only).

### 5.5 Unified Browsers UI (one screen — replaces three scattered ones)

Today browser config (Manage → array editor + JSON), browser status (Status → Drivers list), and the per-call picker (Tools page) live in three places with three vocabularies. Replace with one Browsers view: rows = browsers, columns = jobs. Each row merges live status and settings, so there is exactly one place to look.

```
Browsers
"Tick what each browser may serve. ★ = first choice for that job.
 Untick a whole row = Standby. API searches use no browser."

Status  Browser             Search    Fetch     Devtools
●       chromium            —         —         —
        built-in · always the fallback for every job
●       A                   [x]       ★[x]      [x]
        cdp · connected · serves search, fetch, devtools (incl. screenshots)
●       B                   ★[x]      [x]       [ ]
        cdp · connected · serves search, fetch
●       My Chrome           [x] ⚠     [x]       [x]
        your window · paired · ⚠ search opens visible tabs

                                             [Advanced] [Save]
```

- One ★ per column (click to move first-choice; click again to clear back to Auto/array order). Starred cell must hold that column's tick — starring auto-ticks it.
- "Serves …" line under each row is derived from ticks (same string the server logs at startup) — no new state.
- Chromium row: no checkboxes, one fallback note (its role is cosmetic).
- Relay rows: pairing status inline ("paired" / "awaiting first pair" / "disconnected"); pre-declared-but-never-paired rows read "reserved, awaiting first pair".
- [Advanced] expands the selected row to today's fields (name, cdpUrl, plugin, type) plus the raw JSON view — power users lose nothing; normal use never needs it.
- Tools-page picker and Drivers list defer to this view (picker reads the same data; Drivers keeps tab counts/timers only, with screenshots counted under devtools, linking here for settings).

---

## 6. Files to touch

| File | Change |
|---|---|
| `src/config.js:21,211-237` | `screenshot` role removed (folded into `devtools`, warn-once); help/error copy updated; three optional `*_PREFERRED_BROWSER` vars (browser name or empty = array order) |
| `src/search.js` | Search resolution (`runSearchEngine` → preferred → candidate `search`/`default` chain → Chromium pool fast-path, else transient page); `web_fetch` (`:2202`) gates `{ roles: ["fetch", "default"] }`; screenshot (`:2475`) joins devtools chain `{ roles: ["devtools", "default"] }` |
| `src/browser.js` | Chain resolution honors preferred-first, then array order; transient-page path for non-Chromium search browsers (candidate/rollback pattern); startup task-set log per browser; role-semantics comments |
| `src/mcp-server.js` | ascii (`:2448`) + svg (`:2675`) join devtools chain `{ roles: ["devtools", "default"] }`, preferred via `DEVTOOLS_PREFERRED_BROWSER`; `web_search` gains `browser` param (explicit override; API engines ignore); `list_browsers` (`:2039`) + per-tool descriptions per §5.3/5.4 |
| `src/devtools.js:577-582` | Gate unchanged (already correct); description copy only |
| `src/web-console/src/pages/manage/index.jsx` + `status/index.jsx:442` | Single unified Browsers view per §5.5 (status + ticks + ★ + serves line + Advanced); Drivers keeps tab counts/timers only and links here |
| `src/config-schema.js:4` | Description + fallback rewritten to three roles (`screenshot` → `devtools`) |
| `docker-compose.cloakbrowser.yml:18`, `firefox-extension/README.md`, `firefox-extension/launch-firefox.sh`, `src/config-schema.js:4` fallback | Drop `screenshot` from samples (they already carry `devtools` — zero behavior change); lightpanda sample `["fetch","screenshot"]` → `["fetch","devtools"]` |
| `src/web-console/src/pages/tools/index.jsx` | Search `browser` picker arrives via schema; picker help updated (all four chains) |
| `.env.example`, `.env.example.full:10-14`, `README.md`, `docs/guides/self-hosting/env-vars.md`, `docs/search/*`, `docs/code/browser-and-devtools.md`, `AGENTS.md` config table | Role lists rewritten to three roles (role descriptions + lightpanda sample); fix stale `browser-and-devtools.md:7` pre-39 text regardless |
| `tests/config.test.js`, `tests/browser.test.js:432-447` | Fixtures rewritten to three roles; `screenshot`-role fold test (`["fetch","screenshot"]` → `["fetch","devtools"]` + warning); gate tests for the three real chains; search-resolution tests (add-on serves search, all-down → Chromium pool, relay explicit opens/closes tab) |
| `plans/39_dynamic-browser-array.md` | Annotate role section as superseded by this plan (no rewrite) |

---

## 7. Implementation steps

1. **Search routing:** `browser` param on `web_search` (schema + threading into `runSearchEngine`); candidate resolution (`search`/`default` → Chromium pool fast-path, else transient page with rollback notes; API engines ignore). Unit tests first.
2. **Fetch + screenshot gates:** fetch `{ roles: ["fetch", "default"] }`; screenshot/ascii/svg join the devtools chain `{ roles: ["devtools", "default"] }`. Unit-cover the specialist/standby/explicit matrix.
3. **Unified UI:** single Browsers view (§5.5: status + ticks + ★ + serves line + Advanced); Drivers trimmed to tabs/timers; editor copy (relay labels, visible-tab warning, chromium note). `console:build`, hard-refresh check.
4. **Docs/env comments:** wired semantics; samples keep their roles (they become true); stale backend doc fixed.
5. **Verify:** `npx vitest run tests/config.test.js tests/browser.test.js tests/devtools.test.js tests/relay-server.test.js`; `docker restart navigator`; search with `"browser": "<addon>"` serves from the add-on; all-down rolls to Chromium; relay search opens/closes real tabs; Chromium-only setup behaves exactly as before.

## 8. Verification checklist

- [ ] Each role gates its chain: `[search]`-only serves searches (skipped by fetch/devtools); `[fetch]`-only serves fetch; `[devtools]`-only serves windows AND screenshots; `[default]` serves all three; `[]` serves none implicitly.
- [ ] Old `screenshot` role loads with a warning and folds into `devtools` (`["fetch","screenshot"]` → `["fetch","devtools"]`).
- [ ] `web_search` `browser` param: explicit add-on serves browser-engine searches; explicit-but-down errors (no silent Chromium roll); API engines ignore the param.
- [ ] Implicit search: preferred browser first (if set, connected, role-holding), then array order; all down (or none configured) → Chromium pooled window; warmup stays Chromium-only.
- [ ] Priority split: A ticked search+fetch with fetch-preferred=A serves implicit fetch; B ticked search+fetch with search-preferred=B serves implicit search.
- [ ] Relay search opens real tabs and closes them; help copy warns about visible tabs.
- [ ] Chromium-only setup behaves exactly as before (pooled search, direct pages).
- [ ] Editor is one Browsers view (status + five task ticks + ★ + Standby + relay/search-tab/chromium notes + Advanced); no JSON needed for normal use.
- [ ] Startup log shows the effective task set per browser; docs/env comments agree with the code.
- [ ] Dynamic paired extension with no array row still fetchable via explicit `browser` name and appears in fallback chain.
- [ ] Pre-declared relay row with custom roles is honored once paired.
- [ ] `web_search` without a `browser` param on a Chromium-only setup behaves exactly as before (pooled window, same output).
- [ ] Docs, env examples, and `AGENTS.md` agree with the code (roles gate, preferred-first, Chromium fallback).

## 9. Risks

- Search-backend move: setups with `search`/`default` add-ons (including every shipped all-roles sample) now search outside Chromium when the add-on is up. Intended per directive — release-note it with the escape hatch ("remove the `search` role to pin search to Chromium").
- Visible-tab searches on relay: opt-in by role, but warn loudly (role help + tool description); concurrent fan-out can open several tabs at once.
- Single-tab browsers (lightpanda): concurrent engine searches serialize/evict via the existing TargetAlreadyLoaded handling — prefer Chromium/`default` workhorses for search, specialists for fetch.
- `[devtools]`-only / `[]` add-ons stop receiving implicit fetch (previously tried). `[fetch]`-only add-ons stop receiving implicit screenshots (now devtools-chain). Standard shapes unaffected.
- Preferred pointing at a down/role-less/unknown browser: ignored with a rollback note, never a hard error on implicit calls (explicit per-call `browser` still errors — that contrast goes in the help copy).

## 10. Open questions

1. ~~Deprecation tempo~~ — resolved: no migration, no roles removed. Warn-first question is gone.
2. ~~Should `[]` get a first-class label?~~ Decided: yes — "Standby" in the editor.
3. Per-(engine, browser) warm pools: deferred — transient pages in v1; revisit if add-on search latency hurts.
4. Cap concurrent relay search tabs during `select_best` fan-out? Observe first.
5. Final grep: no remaining "roles do nothing" copy (config-schema, env comments, AGENTS.md, dashboards).

---

## 11. Validation 2026-09-29

### 11.1 The `Implemented 2026-09-05` header was false

`git log -- plans/48_browser-alignment.md` returns exactly one commit — `1d2253e`
(2026-09-24, "relay lifecycle reconciliation, timeout hardening, open-windows
mode") — which **adds the file** (191 insertions, 0 deletions). There is no
implementation commit: `git log --all --grep="role" -i` surfaces only plan 39's
original work (`4deba67`, `1530a5f`) and two console commits that touched the
drivers *rows*, not role gating. The plan was written on 2026-09-05, not
implemented then, and the false status rode into the repo 19 days later.

### 11.2 §4's diagnosis is still accurate; every line reference has drifted

All five rows of the §4 table still hold — verified individually:

| §4 claim | Verified today | Cited | Actual |
|---|---|---|---|
| `web_search` always Chromium, no role filter | true — `newPage({ engine })` returns `_newChromiumPage()` unconditionally, comment still says "Search engines always run on Chromium" | `src/browser.js:849-851`, `src/search.js:1001` | `src/browser.js:1117-1120`, `src/search.js:1015` |
| `web_fetch` calls `resolveBrowserParam` with no `roles` | true | `src/search.js:2202` | `src/search.js:2372` |
| screenshot chain, no `roles` | true | `src/search.js:2475` | `src/search.js:2722` |
| ascii / svg, no `roles` | true | `src/mcp-server.js:2448,2675` | `src/mcp-server.js:3016,3241` |
| devtools is the **only** `roles` gate | true — `src/devtools.js:729` is the single call site passing `{ roles: ["devtools","default"] }` | `src/devtools.js:577-581` | `src/devtools.js:729` |
| `resolveBrowserParam` explicit branch | true, incl. the role check on explicit names | `src/browser.js:1475-1498` | `src/browser.js:1775-1800` |
| implicit chain ends at Chromium | true | `src/browser.js:1500-1514` | `src/browser.js:1806-1830` |

**The problem statement in §1 is still true three weeks later.** Only the line
numbers and the file inventory are stale — see §11.4.

### 11.3 Implementation state: 0 of 5 sections

| § | Section | State | Evidence |
|---|---|---|---|
| 5.1 | Wire every role, ★ preferred browsers, `web_search` browser param, startup task log | **nothing** | `src/config.js:21` still `new Set(["default","search","fetch","screenshot","devtools"])`; no `PREFERRED_BROWSER` string anywhere in `src/`, `.env*`, or any compose file; `web_search` schema (`src/mcp-server.js:2161-2187`) has no `browser` property; no per-browser task-set log |
| 5.2 | `navigator-cdp` = "pre-declared, optional" | **nothing** | `manage/constants.js:BROWSER_TYPES` labels it plain `"Browser plugin"`; no help copy, no "reserved, awaiting first pair" state |
| 5.3 | Three-group taxonomy in `list_browsers` + console + editor header | **nothing** | `list_browsers` description (`src/mcp-server.js:2443-2446`) has no task-chain line; no tool description mentions a role |
| 5.4 | Screenshots join the devtools chain | **nothing** | `src/search.js:2722` / `src/mcp-server.js:3016,3241` pass no `roles`; no role label on the three screenshot tools |
| 5.5 | One unified Browsers view (ticks + ★ + serves line + Advanced) | **nothing** | `manage/BrowserEntryForm.jsx:57-60` renders five `BROWSER_ROLES` checkboxes per entry; no ★, no Standby label, no per-row status column |

§8's checklist is 0/14 unticked, which is at least consistent with reality — only
the header disagrees.

Also un-updated, per §6's own file list:

- `src/config-schema.js:4` — still documents all five roles and still uses
  `["default","search","fetch","screenshot","devtools"]` as the `BROWSERS` fallback.
- `.env.example:12` — still `"default"|"search"|"fetch"|"screenshot"|"devtools"`.
- `.env.example:72` — lightpanda sample still `["fetch","screenshot"]`.
- `docker-compose.cloak.yml:18` — cloakbrowser sample still carries `"screenshot"`.
- `firefox-extension/README.md:60`, `firefox-extension/launch-firefox.sh:114` — same.
- `AGENTS.md:361,381,1265`, `docs/guides/self-hosting/env-vars.md:24`,
  `docs/guides/self-hosting/operations.md:22`, `docs/guides/browsers/*`,
  `docs/reference/browsers/*` — all still list the five roles.
- `docs/code/browser-and-devtools.md` still says "search engines always run on the
  built-in Chromium" — the exact pre-39 staleness §6 asks to fix regardless.
- `tests/config.test.js:29,34,57,60` still assert `screenshot` roles as valid;
  no fold test, no preferred-browser test exists.

### 11.4 The `Implemented` claim has already propagated — actively misleading

- **`plans/archive/39_dynamic-browser-array.md:68`** carries a supersession note
  asserting plan 48 shipped: *"roles are now three task gates … with ★ preferred
  browsers (`SEARCH/FETCH/DEVTOOLS_PREFERRED_BROWSER`) … The legacy `screenshot`
  role folds into `devtools`."* **None of that is true.** A future session that
  reads plan 39 will believe this work is done and skip it. This is the single
  most damaging consequence of the false header.
- `plans/39_dynamic-browser-array.md` (the 941-line duplicate still in `plans/`)
  has **no** supersession note at all — already tracked as `infinite.md:42`
  item (1).
- Plan 48 appears in neither `infinite.md`'s queue nor `plans/README.md` — it is
  an orphan file with no sequencing.

### 11.5 Two internal contradictions in the plan itself

1. **Migration: yes or no.** §2 promises *"existing `screenshot` roles fold into
   `devtools` with a one-release warning"*, §5.1 specifies the warn-once fold,
   and §8 line 164 has a test for it. §10 Q1 says the opposite: *"resolved: no
   migration, no roles removed."* Both cannot ship. Needs the user's call.
2. **Tick count.** §8's editor item says *"five task ticks"*, but §5.1's table
   and §5.5's mock both define four roles (plus `[]` = Standby). The "five"
   is a leftover from before the `screenshot` fold.

### 11.6 Three landed plans reshaped exactly the files §6 names

- **Plan 54 (Implemented 2026-09-11)** decomposed the console editor. §6 says
  "one unified Browsers view" in `manage/index.jsx` / `status/index.jsx:442` —
  but the editor now lives in `BrowserArrayEditor.jsx` + `BrowserEntryForm.jsx` +
  `BrowserEditModal.jsx` + `browser-utils.js` + `constants.js`, the roles are
  `manage/constants.js:BROWSER_ROLES`, and `status/index.jsx` is 201 lines with
  no line 442. §5.5 no longer describes an absent UI: it would now **replace a
  reusable per-entry modal that plan 54 deliberately shipped** and is wired into
  both the Drivers ⋮ menu and the Manage array.
- **Plan 57 (MCP browser permissions)** added `allowedMcpBrowsers`, and
  `src/browser.js:1800-1805` documents that the implicit chain is *"deliberately
  not narrowed to the allow-list"* — post-checks enforce the key wherever it
  lands. A ★ preferred browser **is** a narrowing of that chain, so §5.1 must say
  explicitly whether a ★ can steer a call onto a browser the key's allow-list
  does not contain. It is silent.
- **Config saves now hot-apply.** `src/config-manager.js:180` calls
  `parseBrowsersEnv` on every console save — a second call site not in §6. A role
  change applied to `src/config.js` alone would let the console accept a role the
  server rejects at restart, with no error at save time.

### 11.7 One §6 row points at a gitignored file

`docker-compose.cloakbrowser.yml` (named in §6 for the sample edit) is
**gitignored** (`.gitignore:62`) and untracked; the tracked sibling is
`docker-compose.cloak.yml`, which is the one AGENTS.md points at and the one that
still carries `"screenshot"` in its sample. The row also would not have changed
behaviour anyway: that gitignored file already reads
`["default","search","fetch","devtools"]` — a coincidence, not plan work.

### 11.8 Shipping §5.1 moves *this* instance's live search routing

`.env:31` gives `cloakbrowser` the `search` role. Today `web_search` is hardcoded
to Chromium (`src/browser.js:1117-1120`), so that role is inert. The moment §5.1
lands, this box's browser-engine searches move off Chromium onto cloakbrowser,
and onto rollback behaviour if cloakbrowser is down. §9 names the risk class; it
does not note that the repo's own committed `.env` is one of the setups it hits.

---

## 12. Decisions taken since 2026-09-05 that reshape this plan

Not blockers — context the plan should be read against:

- **Plan 39** made roles real for devtools only, and is the source of the
  `[]` = "fallback/backup only" language still in `AGENTS.md` and the docs.
- **Plan 54** shipped the reusable browser entry editor (modal, per-entry form)
  from both the Drivers panel and Manage.
- **Plan 57** added per-API-key browser permissions (`allowedMcpBrowsers`) with a
  deliberate no-narrowing rule on implicit resolution.
- **Plan 56 / 51** added open-windows mode and relay lifecycle reconciliation;
  relay searches (§5.1) would open real user-visible windows, not tabs.

---

## 13. Needs the user's call

1. **Is plan 48 still wanted?** §11.3 shows nothing shipped, and §11.6 shows the
   three-role + ★ + unified-view design now overlaps shipped plan-54/57 work. The
   honest options are: re-scope and queue it, defer it, or drop it as
   superseded. **Priority is the user's call, never the agent's.**
2. **Migration: fold `screenshot` into `devtools` with a warning (§2/§5.1/§8),
   or remove it silently (§10 Q1)?** These conflict; §11.5.1.
3. **§5.5 vs plan 54** — does the unified Browsers view replace the reusable
   entry modal, or extend it? §11.6.
4. **May a ★ preferred browser steer onto a browser outside the calling key's
   `allowedMcpBrowsers`?** §11.6.


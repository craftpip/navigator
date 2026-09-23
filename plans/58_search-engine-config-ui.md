# 58 — Search engine config UI (list + key-gated enable)

**Status:** implemented and live (2026-09-13) — `SearchEngineTableEditor.jsx` replaces the 2× `MultiSelect` + 4 key rows in `/console/manage`; deployed to the running server (served bundle `assets/index-DXstPNt0.js` contains the editor, `/console/config` exposes `isBrowser`/`keyVar` per engine). Remaining from §7: no `tests/manage-search-engines.test.js`, no docs update to `docs/guides/search/engines.md`, no server-side 400 for enable-without-key (relies on `config-manager.js:85` hot-apply strip), `autoAddOnKey` prop unused (explicit-csv guard from §5.3 not implemented), UI is a table not the §5.2 card list. Plan §2 goals 1–4 met.
**Related:** `src/config.js:510-532` `src/config-manager.js:73-140` `src/engines/index.js` `src/config-schema.js:13-19` `src/web-console/src/pages/manage/*`

## 1. Problem

* `SEARCH_ENABLED_ENGINES` and `SEARCH_ROUTE_WARMUP_ENGINES` are free-form `MultiSelect` comma strings (`ValueControl.jsx:82` / `MultiSelect.jsx`) that show every engine id (`config.availableEngines`) regardless of whether its API key is configured.
* `loadConfig()` in `src/config.js:510-532` silently filters/expands `exa_api|linkup_api|tavily_api|firecrawl_api` depending on `EXA_API_KEY` etc, and `config-manager.js:73-84` `HOT_APPLYERS.SEARCH_ENABLED_ENGINES` strips missing-key engines on hot-apply. So the UI can show `exa_api` as enabled, user saves, server strips it — confusing, no inline feedback.
* The 4 API keys (`CONFIG_SCHEMA` `EXA_API_KEY` etc, `src/config-schema.js:16-19`) live as 4 separate text rows in Manage, far from the engine selectors after the recent grouping (`constants.js:6`). User wants them co-located, key-gated, and listed like browsers (`BrowserArrayEditor.jsx`).
* Quote: “in search exa api is available if key is present, so that means we have to not enable the search engines if keys are not present, lets list the browsers in a list, lets create a custom UI where the user will configure what search engines to add/enable, in a form, we will handle for mcp api keys and the inbuilt search engines too” → wants a first-class engine list form (not raw `MultiSelect`), handling both API-gated engines and inbuilt browser engines, with a mental model similar to the Browser Array card list.

## 2. Goals

1. Single **Search** config surface that ties together:
   - which engines are enabled for `select_best` (`SEARCH_ENABLED_ENGINES`)
   - which are pre-warmed (`SEARCH_ROUTE_WARMUP_ENGINES`)
   - the 4 hosted-engine keys that gate `exa_api`, `linkup_api`, `tavily_api`, `firecrawl_api`
   - keep inbuilt browser engines (`brave`, `google`, `duckduckgo`, `bing`, `mojeek`, `yahoo`, `startpage`, `duckduckgo_api`) always selectable, key-gated ones disabled when key missing.
2. Prevent enabling a key-gated engine when its key is empty (UI disabled + server still strips as defense-in-depth).
3. Keep existing `.env` contract: still writes `SEARCH_ENABLED_ENGINES=csv` and `*_API_KEY` strings; no schema migration required. MCP auth keys (`MCP_API_KEYS`, `/console/keys`) stay separate — but reuse the same visual language (list + status pill) so users recognise it.
4. Preserve hot-apply (`config-manager.js`) and `select_best` scheduler behavior; add a friendly “add key → auto-enable” affordance (mirrors current auto-add in `config.js:521-525` when `SEARCH_ENABLED_ENGINES` is not explicit).

## 3. Non-goals

* No new env vars, no change to `SUPPORTED_ENGINES` registry (`src/engines/index.js:77`).
* No change to circuit-breaker / scheduler weights UI.
* No merging MCP auth keys into the search form — just consistent listing.

## 4. Current truth (read before changing)

* `loadConfig()` adds API engines to `searchEnabledEngines` only when `SEARCH_ENABLED_ENGINES` is **not** explicitly set and the corresponding key is present; then strips any API engine whose key is empty. `HOT_APPLYERS.EXA_API_KEY` etc auto-push/pop `exa_api` when the key is added/removed **and** `process.env.SEARCH_ENABLED_ENGINES` is unset. This implicit behavior is useful but invisible in the UI.
* `src/web-console/src/pages/manage/ValueControl.jsx` delegates `type==="engines"` to `MultiSelect`, which merges `items` (availableEngines ids) + already-selected values, no metadata about key requirement or browser vs API.
* `src/web-console/src/pages/manage/constants.js:6-7` just groups keys; the table still renders 2 `MultiSelect` rows + 4 text rows. No cross-field validation.
* `src/config-manager.js:85-140` is the source of truth for hot-apply interdependency — any UI must respect it rather than duplicate the rules client-side only.

## 5. Proposed UI — `SearchEngineListEditor` (replaces 2× MultiSelect + 4 key rows)

### 5.1 Placement

Keep `MANAGE_GROUPS` but collapse the 6 keys into one editor row, like `BROWSERS` does:

```js
// constants.js — proposal (not yet applied)
{ label: "Search", detail: "Choose which engines select_best may use and manage hosted-engine keys — API engines are disabled until their key is set.",
  keys: ["SEARCH_ENABLED_ENGINES", "SEARCH_ROUTE_WARMUP_ENGINES", "EXA_API_KEY", "LINKUP_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY"] }
```

`ValueControl.jsx` gets a new branch: if `entry.key==="SEARCH_ENABLED_ENGINES"` render `SearchEngineListEditor` that reads/writes **all 6** draft keys atomically (needs `draft` passed in, or a new `GroupControl`). Alternative: a `GroupControl` for the Search group that replaces the 6 individual `FragmentRows` with one panel — similar to how `BrowserArrayEditor` owns the whole `BROWSERS` JSON.

Simplest incremental step: keep 2 group headers (“Search Route Availability” + “Search Scheduler”) but replace the `SEARCH_ENABLED_ENGINES` `MultiSelect` with the new list editor; API key rows remain but become inline side-inputs inside each API engine’s card. Prefer the single-panel approach for coherence — pick one after review.

### 5.2 Visual — list of engine cards (like `BrowserArrayEditor.jsx:69-108` cards)

```
┌─ Search engines — select_best pool ──────────────────────────┐
│  [x] brave             Browser  ✓ enabled  (warmup [x])      │
│  [x] google            Browser  ✓ enabled                     │
│  [x] duckduckgo        Browser  ✓ enabled                     │
│  [x] duckduckgo_api    API (no key)  ✓ enabled                │
│  [ ] yahoo             Browser                                │
│  [ ] startpage         Browser                                │
│  ...                                                          │
│  ── Hosted engines (require API key) ─────────────────────── │
│  [x] exa_api           API      ✓ enabled  key: ••••••abc  [Edit key]   │
│  [ ] linkup_api        API      disabled — set LINKUP_API_KEY to enable   [Add key] │
│  [ ] tavily_api        API      disabled — set TAVILY_API_KEY to enable   [Add key] │
│  [x] firecrawl_api     API      ✓ enabled  key: ••••••xyz  [Edit key]   │
│                                                               │
│  Warmup: [x] brave [x] duckduckgo_api [ ] duckduckgo  (only browser engines shown) │
│  ───────────────────────────────────────────────────────────── │
│  Save applies SEARCH_ENABLED_ENGINES + 4 *_API_KEY together.  │
└───────────────────────────────────────────────────────────────┘
```

Per-engine card shows:
* `id` + `type` pill (`Browser` / `API`), `pool` if needed.
* enable checkbox (checked = included in `SEARCH_ENABLED_ENGINES` csv). Disabled + tooltip when `isApiGated && !draft[KEY]` (e.g. “Set EXA_API_KEY to enable exa_api”).
* inline key field for the 4 API engines: masked display + Edit/Add button that expands a `type="password"` input bound to `draft[EXA_API_KEY]` etc. Saving the key and toggling the engine happen in one “Save changes”.
* warmup toggle (small checkbox) bound to `SEARCH_ROUTE_WARMUP_ENGINES` — only rendered for `ENGINE_METADATA.isBrowser===true` (`src/engines/index.js:99-103`).

### 5.3 Interaction rules

* **Key missing → engine disabled:** `USE_EXA = !!draft.EXA_API_KEY.trim()`. If `false`, the `exa_api` checkbox is `disabled`, unchecked state is forced on save (server also strips via `config-manager.js:77`). If user tries to check it, show inline message: “Add an API key first.”
* **Adding a key auto-checks the engine** (opt-in, matching `config.js:521` implicit add when `SEARCH_ENABLED_ENGINES` is not explicit). UI: when key input goes from empty→non-empty and engine is currently off, auto-check it and show a subtle “will be enabled on save” hint. Removing a key auto-unchecks it.
* **Explicit vs implicit `SEARCH_ENABLED_ENGINES`:** If the user has ever saved an explicit csv (i.e. `config.env.SEARCH_ENABLED_ENGINES` exists), auto-add on key creation should **not** happen — respect their explicit list. The server’s `process.env.SEARCH_ENABLED_ENGINES` check already does this; mirror in UI: only auto-check when `draft.SEARCH_ENABLED_ENGINES` equals the fallback/default or when the user hasn’t manually edited the list.
* **Validation:** `validateEntryValue` for `engines` stays, but the component filters out disabled engines from the outgoing csv. Show count pill: “3 enabled · 2 disabled (missing key)”.
* **Save:** One `PUT /console/config { updates: { SEARCH_ENABLED_ENGINES: csv, SEARCH_ROUTE_WARMUP_ENGINES: csv, EXA_API_KEY, ... } }` — existing `Manage/index.jsx:save()` already batch-saves `changed` entries, so wiring the 6 draft keys to one editor that calls `onChange` per-key works; or introduce a group-level `onChangeMany`.

### 5.4 Reuse of browser-list patterns

* Copy `BrowserArrayEditor.jsx` structure: `pp-cards` / `pp-card` styles, `pp-toolbar` with “Reset to defaults”, `pp-empty` state.
* Copy `MultiSelect.jsx` checkbox handling but not the dropdown — cards are always visible (12 engines = small list).
* Consume `config.availableEngines` or `SUPPORTED_ENGINES` + `getEngineMetadata` (expose via `/console/config` if not already). Provide a `engineMeta` map: `{ id, isBrowser, requiresKey: "EXA_API_KEY"|null, keyUrl }`.

### 5.5 MCP API keys note

MCP auth keys live at `/console/keys` (tool-scoped). This editor **does not** move them. For visual consistency, use the same `Pill` status + masked key display that the Keys page uses, so users learn one pattern. If later desired, add a link: “Manage MCP client keys → /console/keys” in the group detail, same as `Manage/index.jsx:221` does for `MCP Transports`.

## 6. Data & API

* **No new endpoints.** Extend `GET /console/config` to include `engineMeta` (optional; fallback to client-side hard-coded map derived from `src/engines/index.js:77` and `config-schema.js:16-19`).
* **Persisted as env:** `SEARCH_ENABLED_ENGINES` csv, `SEARCH_ROUTE_WARMUP_ENGINES` csv, `*_API_KEY` strings → `.env` via existing `env-file.js` flow.
* **Server validation:** keep `config-manager.js:72-98` as guard; UI is advisory. Add explicit error if client sends `SEARCH_ENABLED_ENGINES` containing an API engine whose key is empty — return 400 with “exa_api requires EXA_API_KEY”.

## 7. Implementation steps (when approved)

1. **Backend:** expose `engineMeta` in `GET /console/config` (or reuse `availableEngines` + add `requiresKey` field in `mcp-server.js` config serialization).
2. **Schema:** no change needed; optionally add `requiresKey` hint to `CONFIG_SCHEMA` entries for `*_API_KEY` (docs only).
3. **Console — constants:** collapse the 6 search keys into one `Search` group (or keep subgroups — decide in review).
4. **Console — new component:** `src/web-console/src/pages/manage/SearchEngineListEditor.jsx` (≈120 lines) — props: `draft`, `onChangeMany`, `engineMeta`, `availableEngines`. Handles enable/warmup/key inline edits.
5. **Console — ValueControl / Manage:** add branch for `SEARCH_ENABLED_ENGINES` → `SearchEngineListEditor`; thread `draft` for the 6 keys through `FragmentRows` or render group-level control.
6. **Console — validate:** extend `validate.js` to flag `SEARCH_ENABLED_ENGINES` containing key-less API engines.
7. **Tests:** `tests/manage-search-engines.test.js` (vitest) — key-empty → engine disabled, key-add → auto-check, save csv correctness, warmup browser-only.
8. **Docs:** update `docs/guides/search/engines.md` to mention the Manage UI and key gating.

## 8. Alternatives considered

* **Keep MultiSelect but disable options:** minimal change, but still leaves 4 separate key rows disconnected; user has to context-switch.
* **Separate “API Keys” sub-panel:** keeps keys separate but adjacent — less cohesive than inline key-per-engine.
* **JSON-only BROWSERS-style editor for SEARCH_ENABLED_ENGINES:** consistent but not a form; still requires manual csv editing.

## 9. Open questions for review

1. Single `Search` group vs keep `Search Route Availability` + `Search Scheduler` split (this plan proposes single group for the 6 keys, scheduler stays separate).
2. Should warmup be a per-engine toggle inside the same cards, or remain a separate `MultiSelect` row?
3. Auto-enable on key-add: explicit opt-in checkbox vs silent auto-check (plan proposes silent auto-check only when the engine was previously implicit/default).

## 10. Acceptance

* Visiting `/console/manage` shows a **list of engine cards**, not two dropdowns + 4 text rows.
* `exa_api` etc are visibly disabled with “Set EXA_API_KEY to enable” until the inline key is filled.
* Saving enables the engine and persists the key atomically; removing a key disables its engine both in UI and in `searchEnabledEngines` after hot-apply.
* No regression for inbuilt engines (brave, google, duckduckgo, bing, mojeek, yahoo, startpage, duckduckgo_api).

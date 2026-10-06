# 60 - Configuration lifecycle integrity audit

**Status:** In progress — browser/relay lifecycle slice (§10 step 1). Fixed: B1, B2, B3, B4, B5, B8, B9 (B3/B4/B8/B9 2026-09-18, B1/B2 2026-10-01, B5 2026-10-07). Open: B6,B7,B9-deep; K1–K7; S1–S12; H1–H7.
**Scope:** Every console-managed resource whose configuration, runtime registry, durable storage, derived routing/status state, or UI representation can disagree.

## Progress checklist

- [x] B1 — startup restores only config-authorized `navigator-cdp` relay pairings
- [x] B2 — server-initiated Forget clears the extension pairing (distinct close code 4004)
- [x] B3 — same-name `cdp` → `navigator-cdp` type change invalidates the stale connection (2026-09-18)
- [x] B4 — inactivity cleanup releases adopted user tabs, never closes them (2026-09-18)
- [x] B8 — removal/type-change releases devtools target state (2026-09-18)
- [x] B9 (partial) — navigator-owned shared CDP browsers closed on removal/retype (2026-09-18)
- [x] B5 — rename delete-plus-create migration (declared semantic: delete+create, 2026-10-07 — see §9b.1)
- [ ] B6 — persisted forget tombstone / unmanaged-discovery policy
- [ ] B7 — dynamic relay name collision with configured plain-CDP
- [ ] B9-deep — raw `cdp-share.js` upstream proxy pipe registry cleanup (with K4)
- [ ] K1–K7 — API key / permission lifecycle
- [ ] S1–S12 — search engine / model lifecycle
- [ ] H1–H7 — hints / cache / process lifecycle
- [ ] Absorb into `docs/` and archive

## 1. Problem

Removing `Firefox` and `test-chrome` from `BROWSERS` removed their `.env` declarations but left their relay tokens in SQLite and their runtime entries in `RelayServer`. The dashboard then correctly rendered the surviving relay state as dynamic browsers, but that was not the user's requested outcome: removal from the Manage panel should remove the browser.

This is not a browser-only problem. Navigator has several sources of state:

| Layer | Examples |
| --- | --- |
| User configuration | `.env`, `domain-hints.json`, console forms |
| Live runtime state | `manager.config`, browser connections, search schedulers, caches, VNC state |
| Durable operational state | SQLite API keys, relay sessions, activity records, engine profiles |
| Derived state | effective add-on list, tool schemas, allowed-browser lists, health/stats payloads |
| Client state | console drafts, polling snapshots, expanded rows, local storage |

Any mutation that updates only one layer can make the product lie: a deleted item can still route traffic, a renamed item can retain permissions, a reset can leave an old cache active, or a reverted file can differ from live process state.

## 2. Audit Goal

For every mutable resource, prove that every lifecycle transition reaches a single, intentional result across all relevant layers.

1. The requested state is persisted exactly once in its canonical store.
2. Runtime state is updated, safely stopped, or explicitly marked restart-required.
3. Durable dependent state is retained, migrated, or deleted according to a documented policy.
4. Derived registries, routing, permissions, health, MCP output, and console rows reflect that policy immediately.
5. Restart, external file edits, and failed writes converge to the same result instead of resurrecting stale state.
6. The user receives an accurate result that names any stopped connection, removed pairing, invalidated key, or deferred restart.

## 3. Lifecycle Contract

Every managed resource must declare these fields before its mutation code is changed:

| Field | Required answer |
| --- | --- |
| Canonical config | Which file/database record defines the user-requested state? |
| Runtime owner | Which class owns live connections, caches, timers, and maps? |
| Durable dependents | Which SQLite/filesystem records survive process restart? |
| Derived consumers | Which routing, tool, permission, health, status, and UI paths read it? |
| Remove semantics | Delete, disconnect, orphan intentionally, or retain for reuse? |
| Rename semantics | Atomic migration, reject, or treat as delete plus create? |
| Type-change semantics | Which state becomes invalid and must be cleared? |
| Failure semantics | What remains true if persistence or live apply fails midway? |
| Reconciliation | How do startup and external-file reload converge stale state? |
| Result shape | What does the caller receive after the transition? |

No hidden "dynamic" fallback may override an explicit user removal. Dynamic discovery is valid only when the user has not previously removed or forgotten that resource, or when the UI explicitly asks to retain it.

## 4. Resource Inventory

Audit each resource independently. Shared `.env` save code does not prove shared lifecycle correctness.

| Resource | Canonical state | High-risk dependents / transitions |
| --- | --- | --- |
| `BROWSERS` | `.env` | `BrowserManager`, relay sessions/entries, CDP share, API-key browser allowlists, domain-hint `browserEngine`, target registry, dashboard and `list_browsers` |
| Relay pairing | SQLite `relay_sessions` + extension token | reconnect, dynamic browser projection, gateway clients, pending commands, extension popup state |
| Browser contexts and targets | devtools in-memory state + extension/remote browser | close, inactivity cleanup, browser removal, reconnect, type change, adopted user tabs |
| Search enabled/warmup engines | `.env` + runtime scheduler | circuit breakers, profiles, warmed pages, search cache, engine UI, API-key gating |
| Search engine credentials | `.env` | enabled routes, active clients, cache/circuit state, UI masking, reset/revert |
| Post-processor models | `.env` | extractor registry, in-flight model calls, hints referring to model ids, console controls |
| Domain hints | `domain-hints.json` | cache, wildcard invariant, flow references to browsers/models, test-pane draft versus saved state |
| MCP/API keys | SQLite | session authorization, CDP sharing, allowed tools/browsers, internal console key, revoked active connections |
| Tool enablement | `.env` | MCP `tools/list`, dispatch gate, console tool list, cached tool schemas/sessions |
| VNC and browser process settings | `.env` + process state | VNC manager process, current Chromium instance, restart-required messaging |
| Cache and operational controls | `.env` + in-memory caches/SQLite profiles | cache invalidation, circuit resets, activity retention, stale console snapshots |

## 5. Required Transition Matrix

For every inventory row, test each applicable transition. Record the before/after state at every layer from section 1.

| Transition | Required checks |
| --- | --- |
| Create | Validates input, persists canonical state, creates only intended live/durable dependents, appears once in all listings. |
| Edit in place | Applies changed fields without duplicate connections, stale map keys, or cached old routing. |
| Rename | Either migrates every keyed dependent atomically or is rejected with an explicit error. Never leave old-name access working silently. |
| Type change | Clears incompatible state, connections, permissions, and protocol-specific records before exposing the new type. |
| Remove | Stops live work, deletes/invalidates durable dependents, removes derived visibility/routing, and reports what was removed. |
| Reset to default | Runs the same cleanup as explicit removal where the default no longer includes an item. |
| Revert backup | Reconciles both directions: restores newly reintroduced dependencies and removes dependencies absent from the restored config. |
| External file change | `checkEnvFileChanged()` and hint reload produce the same lifecycle result as a console save. |
| Process restart | Restored durable state is validated against current config; stale rows are reconciled or deliberately presented as recoverable unmanaged state. |
| Failed mutation | No partial persistence/runtime mismatch; errors identify the layer that failed and the safe recovery action. |
| Concurrent mutation | Two console saves, extension reconnects, or config reloads cannot resurrect deleted state or overwrite a newer value. |

## 6. Audit Method

For every resource/transition pair:

1. Trace the user action through request validation, canonical persistence, `hotApplyConfig()` or resource-specific apply code, and every runtime owner.
2. Locate all keyed maps, caches, timers, database tables, sockets, extension storage, and derived response builders that retain the resource identity.
3. Inspect read paths separately: dashboard, `/health`, `/stats`, `/console/config`, API-key payloads, `tools/list`, `list_browsers`, target listings, routing, and MCP dispatch.
4. Create a real before/after fixture. Verify the canonical file/database, live endpoint payloads, and UI, not only a mocked helper.
5. Restart the container and repeat the reads. Test an external `.env` edit where the system supports it.
6. Add a public-boundary regression test for every confirmed defect. Tests must assert both absence from the old surface and absence from the operational path that could still use it.
7. Add results to the evidence table before implementing the next group.

## 7. First Investigation Pass

### 7.1 Browser and relay lifecycle

1. Confirm `BROWSERS` removal, rename, and `navigator-cdp` -> `cdp` type change all clear relay sessions, live entries, gateway clients, pending commands, API-key allowlist references, and target state as intended.
2. Decide and document the distinction between an unconfigured dynamic relay browser and a browser explicitly forgotten through Manage. The server must retain a tombstone only if it is necessary to prevent unwanted auto-reappearance.
3. Verify `checkEnvFileChanged()`, reset, revert, and startup reconciliation use the same browser cleanup policy as `PUT /console/config`.
4. Check whether removing a connected relay closes only the relay connection and releases Navigator-owned handles, never arbitrary user tabs.
5. Verify the browser extension handles server-initiated forget cleanly: token cleared, disconnected state visible, no reconnect loop, fresh pairing requires a PIN.

### 7.2 API key and permission lifecycle

1. Revoke a key while MCP sessions and CDP sockets are active. Decide whether existing sessions are immediately disconnected or expire at their next request; make the outcome explicit and tested.
2. Remove or rename a browser referenced in `allowed_browsers` and future MCP browser permissions. Decide whether invalid names are pruned, retained as denied history, or block the save.
3. Disable a tool while a session is active and verify `tools/list`, dispatch, the console, and cached schemas converge.
4. Check that console-internal keys cannot retain deleted/renamed resource access through cached authorization objects.

### 7.3 Search and model lifecycle

1. Disable an engine, remove its credential, reset it, and revert it. Verify no warm page, route circuit breaker, scheduler profile, cache entry, or UI row continues to select it.
2. Remove or rename a post-processor model referenced by a saved domain hint. Choose one policy: reject the save, disable the affected hint with a visible error, or migrate the reference deliberately.
3. Verify API-key changes invalidate only the affected client/configuration state and cannot leak a previous credential into a later request.

### 7.4 Hint, cache, and process lifecycle

1. Delete/edit/revert domain hints while extraction requests are in flight. Confirm cache invalidation and result semantics are deterministic.
2. Validate wildcard hint recreation against reset, revert, malformed external file edits, and concurrent console saves.
3. Audit cache-clear/reset controls to ensure all matching in-memory and persisted indexes are invalidated, with cache age/status exposed to the console and MCP callers.
4. Verify VNC/browser process configuration does not claim hot application when a live process still uses old startup-only state.

## 8. Design Requirements for Confirmed Fixes

1. **One lifecycle owner per resource.** Put cleanup/reconciliation with the class that owns the resource state; do not scatter map/database cleanup across UI handlers.
2. **Explicit operation modes.** Use `create`, `update`, `remove`, `reconcile`, and `restore` semantics rather than inferring deletion from unrelated list changes at multiple call sites.
3. **Transactional ordering.** Validate first, persist canonical state, apply/reconcile live state, then publish derived state. If a stage cannot be made atomic, return a structured partial failure and queue/perform deterministic reconciliation.
4. **No silent resurrection.** Startup, reconnect, and polling may restore only state authorized by the current canonical configuration or a documented unmanaged-discovery policy.
5. **Clear result payloads.** Configuration saves return `created`, `updated`, `removed`, `disconnected`, `invalidated`, `restartRequired`, and `warnings` arrays where relevant, not only `hotApplied`.
6. **Read-path parity.** Dashboard, health, stats, MCP tools, routing, permissions, and console forms all consume one effective-state projection per resource.
7. **Idempotency.** Repeating a remove/reset/reconcile must be safe and produce the same final state.
8. **User-browser safety.** Cleanup may release Navigator state and relay connections but must never close user-owned tabs/windows unless the user explicitly requested tab/window closure.

## 9. Evidence Table

| Resource | Transition | Canonical result | Runtime result | Durable result | Read-path result | Test | Finding / fix |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `BROWSERS` relay entry | Remove through Manage | Entry removed from `.env` | `relayServer.forget(name)` closes entry | `relay_sessions` row deleted | Driver panel no longer projects it | `tests/mcp-server.test.js` | Fixed 2026-09-18. |
| `BROWSERS` | Reset to default | Env key removed | Default browser array hot-applied | Removed relay sessions deleted | Removed relays do not reappear as dynamic drivers | `tests/mcp-server.test.js` | Fixed 2026-09-18 through the shared browser lifecycle boundary. |
| `BROWSERS` | Revert backup | Backup restored | Restored browser array hot-applied | Relays absent from the restored array are deleted | Driver panel matches restored config | `tests/mcp-server.test.js` | Fixed 2026-09-18; reverts previously only rewrote `.env` and left runtime state stale. |
| `BROWSERS` | External edit | `.env` remains canonical | Next `/console/config` refresh validates and hot-applies the browser array | Removed relay sessions deleted | Config payload reports external apply/error; driver panel matches the file | `tests/mcp-server.test.js` | Fixed 2026-09-18. Invalid external values preserve the current live array and surface `externalBrowsersError`. |
| `BROWSERS` | Restart | `.env` (on disk) is authoritative | Only persisted sessions for names still configured `navigator-cdp` are restored into `_tokenToName` | Unconfigured `relay_sessions` rows are kept in SQLite but not authorized | Dashboard shows them as known/disconnected (recoverable unmanaged), not paired | `tests/relay-server.test.js` ("restores persisted pairings only for names still configured navigator-cdp") | Fixed 2026-10-01 (B1). Standalone callers that pass no `configuredBrowsers` keep legacy restore-all. |

## 9b. Full Audit Evidence Register

Audit run 2026-09-18 (four independent passes: browser/relay, API keys/permissions, search/models, hints/caches/process). Status column: PENDING = not yet fixed, DEPLOYED = fixed and live-verified.

### 9b.1 Browser and relay lifecycle

| # | Severity | Finding | Evidence | Status |
| --- | --- | --- | --- | --- |
| B1 | Critical | Startup restores every durable relay token before validating against current `BROWSERS`; removed relays reappear as dynamic browsers after restart and can route traffic | `src/relay-server.js:88-105` loads all `relay_sessions`; `getStatusEntries()`:238-253 projects unconfigured pairings; `src/browser.js:1149-1204` exposes them; `src/mcp-server.js:3197-3205` init order | FIXED 2026-10-01: `RelayServer.init({ configuredBrowsers })` restores a persisted token into `_tokenToName` only when the current config still declares that name `navigator-cdp`. Unconfigured rows stay in SQLite and in the known registry (recoverable unmanaged — shown known/disconnected, not paired) but are not authorized, so a removed relay cannot route after restart. Wired at `src/mcp-server.js:4763` (`configuredBrowsers: manager.config.browsers`); legacy restore-all preserved when no config is supplied. Regression: `tests/relay-server.test.js` "restores persisted pairings only for names still configured navigator-cdp (plan 60 B1)". |
| B2 | Critical | Server-initiated Forget closes with code 4000 which both extensions treat as expired-PIN and retain the token — forgotten extensions reconnect with stale pairing material | `src/relay-server.js:162-168`; `chrome-extension/core/connection-manager.js:279-292`; `firefox-extension/core/connection-manager.js:254-263` | FIXED 2026-10-01: server closes forgotten sockets with code **4004** ("forget") instead of 4000 ("PIN wrong/expired"). Both extensions gained a 4004 branch that clears the session token, clears the connected flag, stops auto-reconnect, and surfaces a "forgotten by navigator" error, so a forgotten browser presents the pairing screen instead of silently reconnecting with stale material. Tests: `tests/relay-server.test.js` "forget closes an open socket with 4004"; `firefox-extension/test/unit-ff.mjs` 5e; `chrome-extension/test/unit-ext.mjs` forgotten-browser case. |
| B3 | High | Same-name `cdp` → `navigator-cdp` type change reuses the old direct-CDP puppeteer connection: `_ensureAddOnConnection()` keys `_addOnState` by name only, so user-browser requests can drive the former endpoint | `src/browser.js:708-715`; `src/mcp-server.js:710-730` type-change path misses plain-addon invalidation | FIXED 2026-09-18: `BrowserManager.invalidateAddOn(name)` (new) drops our puppeteer handle, clears the probe cache, and closes navigator-owned shared CDP browsers for that name; `reconcileBrowserChanges()` (replaces `reconcileRemovedRelayBrowsers`) invalidates on removal AND on same-name identity change (type or cdpUrl). Config read path now reports `invalidatedBrowsers` (console config payload includes `envFile.externalBrowsersInvalidated`). Regression tests: "invalidates the stale add-on connection when a browser changes type in place" + "invalidates add-on state + devtools targets when a plain-cdp browser is removed" (tests/mcp-server.test.js). |
| B4 | High | Adopted user tabs are closed by the 5-minute inactivity cleanup (`state.page.close()` unconditional); manual close correctly only releases the handle | `src/devtools.js:412-418`; manual path :692-699; tests/devtools.test.js:402-425 covers manual only | FIXED 2026-09-18: inactivity sweep extracted into exported `runInactivityTick(now)`; adopted targets are released (handle dropped, `page.close()` never sent, no `closedTargets` tombstone). Regression test: "inactivity cleanup releases adopted target without closing its tab". Pre-existing unrelated failure noted: `formatDevtoolsToolResponse` "includes tool name and JSON payload" test (expects count in JSON render; current renderer emits markdown) fails identically at HEAD. |
| B5 | High | Rename is delete-plus-create without migration; extension identity not migrated, old name resurrects as dynamic relay after re-pair | `src/mcp-server.js:710-720` forgets only; no rename op in relay/DB/BrowserManager/extensions | RESOLVED 2026-10-07 — rename semantics **declared as delete+create** (an allowed §3 declaration; atomic migration deliberately declined). Rationale: a `BROWSERS` save (and external edit/revert/reset, which carry no intent metadata) sees only an ambiguous name diff — remove-paired-A + add-new-B is indistinguishable from a rename, and migration is impossible without the extension adopting the new name (the strict `_tokenToName` name check correctly rejects a re-keyed token under the old identity, and an alias-acceptance window would let the removed machine masquerade as the added one). What rename already gets right, now proven: the removal chain covers every keyed dependent — `relayServer.remove()` (session row, known row, meta, live ws via 4004, gateway clients, pending commands via `_teardownEntry`), `invalidateAddOn`, `releaseTargetsByBackend` — and the old name vanishes from `.env`, the config payload, and `getStatusEntries`. The stale extension is orphaned cleanly by close 4004 (B2: clears token, no reconnect loop) and re-pairs under its new popup name with a fresh PIN. Regression: `tests/mcp-server.test.js` "treats a rename as delete+create with full old-name cleanup (plan 60 B5)". Residual symptom "old name can be re-PINed as a dynamic browser" is B6's tombstone scope, not this row. API-key `allowed_browsers` name references are K5. |
| B6 | High | No persisted forget tombstone; a forgotten name can be revived by a fresh pairing (no unmanaged-discovery policy) | `src/relay-server.js:374-414,556-580` accept any hello | PENDING |
| B7 | Medium | Dynamic relay can collide with a configured plain-CDP browser name; hidden/conflicting routing state | `src/relay-server.js:556-580` `_ensureEntry` accepts all names; `getStatusEntries()`:211-216 builds configByRelayName from all add-ons | PENDING |
| B8 | High | Removal/type-change does not release devtools `targetsById` state (adopted tabs plus navigator targets left stale) | `relayServer.forget()` closes gateway clients only; no devtools callback | FIXED 2026-09-18 (with B3): new export `releaseTargetsByBackend(name)` (src/devtools.js) tears down every tracked target for a backend — agent targets close normally, adopted user tabs are only released (never closed) — called from `reconcileBrowserChanges()` on removal and same-name identity change. Tests: "invalidates add-on state + devtools targets when a plain-cdp browser is removed" (mcp-server) + "releaseTargetsByBackend closes agent targets and releases adopted tabs, other backends untouched" (devtools). |
| B9 | Medium | External plain-CDP proxy sockets survive browser removal because untracked | `src/cdp-share.js:437-452` raw upstream; no session registry | FIXED 2026-09-18 (partial, with B3/B8): navigator-owned shared CDP browsers for a removed/retyped name are closed by `invalidateAddOn`; the raw upstream proxy pipe registry cleanup in `src/cdp-share.js` remains to be wired (K4/B9-deep) when the API-key group is implemented. |

### 9b.1a Deployment record — B3/B4/B8/B9 (2026-09-18)

Deployed live after the first browser/relay slice: `docker compose restart navigator`, health OK. Full vitest sweep: 643 pass; the only 2 failures are pre-existing and unrelated (svg.test.js `centers lone lines vertically` fails identically at HEAD, svg unchanged by this work; `formatDevtoolsToolResponse` "includes tool name and JSON payload" expects raw `"count"` in a markdown render). Console config payload now exposes `envFile.externalBrowsersInvalidated`.

**Live-verification side effect (logged honestly):** an interactive BROWSERS PUT used as a smoke test sent a browser list that omitted the configured `macbook chrome` relay, which correctly forget it (`forgottenRelayBrowsers: ["macbook chrome"]`) and deleted its SQLite `relay_sessions` row on the production instance. The revert path restored the `.env` and the configured entry, but the durable session token was already deleted — `macbook chrome`'s next reconnect presents a now-invalid token and the extension prompts for a fresh PIN. One-time re-pair required; a reminder that live config surfaces must never be used as test fixtures. Other relays (`dev-chrome`, `Chrome`, `mac firefox`) were unaffected.

### 9b.1b Deployment record — B1/B2 (2026-10-01)

`RelayServer.init()` now takes an optional `configuredBrowsers` allowlist; `mcp-server.js` passes `manager.config.browsers`. Server-initiated forget closes with 4004. Verified in-container: `tests/relay-server.test.js` 26/26 including both new cases. Extension suites (standalone vm harnesses): `firefox-extension/test/unit-ff.mjs` 63 pass / 2 pre-existing probe fails (20d/20e, documented in AGENTS.md); `chrome-extension/test/unit-ext.mjs` 51/51.

### 9b.2 API key and permission lifecycle

| # | Severity | Finding | Evidence | Status |
| --- | --- | --- | --- | --- |
| K1 | Critical | `MCP_API_KEYS` has two conflicting authorities: env imported once at startup, then SQLite restores/overrides; hot applier also mutates runtime directly — live vs restart disagree | `src/db.js:215-230` `initializeMcpApiKeys`; `src/mcp-server.js:592-595,3199-3201` `syncMcpApiKeys`; `src/config-manager.js:175` | PENDING |
| K2 | High | Persistent MCP sessions capture `allowedTools` at initialize and never re-resolve; `set_tools` updates DB but not live sessions | `src/mcp-server.js:3266,3302,3317-3324,3131-3162,666-675` | PENDING |
| K3 | High | CDP authorization checked once at WS upgrade; active pipes keep forwarding after revoke/scope-change/browser removal | `src/cdp-share.js:370-449`; revoke at `src/mcp-server.js:644-650` never closes sockets | PENDING |
| K4 | High | Plain `cdp` browser removal leaves `_addOnState` connections and devtools handles; external `/cdp/<name>` pipes persist | `src/browser.js:708-763`; `src/devtools.js:246-256`; cleanup only handles navigator-cdp (`src/mcp-server.js:710-730`) | PENDING |
| K5 | High | Deleted/renamed browser names stay in API-key `allowed_browsers` (no referential cleanup); stale grants can later attach to a new same-name browser | `src/db.js:232-263`; `src/cdp-share.js:120-141` name-only enforcement | PENDING |
| K6 | Medium | Restricted keys can discover all browser names/status via `GET /cdp` (health unfiltered before per-browser scope check) | `src/mcp-server.js:3430-3440`; `src/cdp-share.js:164-178` | PENDING |
| K7 | Medium | Key edit UI does three independent mutations with no transaction (partial apply on failure) | `src/web-console/src/pages/keys/index.jsx:87-107`; `src/mcp-server.js:653-687` | PENDING |

### 9b.3 Search engine and model lifecycle

| # | Severity | Finding | Evidence | Status |
| --- | --- | --- | --- | --- |
| S1 | Critical | `.env` revert hot-applies only `BROWSERS`; engines/credentials/models/scheduler revert in file but runtime stays on newer values | `src/mcp-server.js:760-790`; test at tests/mcp-server.test.js:687-703 checks file text only | PENDING |
| S2 | Critical | External `.env` edits reconcile only browsers; engines/credentials/models/scheduler report a change but never apply | `src/mcp-server.js:479-491,3641-3643` | PENDING |
| S3 | Critical | Saved hints survive model removal/rename; validation checks only that `postProcessor` is a non-empty string, fetches silently degrade | `src/config-manager.js:177-179`; `src/domain-hints.js:732-736,439-442`; `src/extractors/index.js:73-81` | PENDING |
| S4 | Critical | AI model IDs accepted as extractor `format` but never executed (default fetch and flow-block both no-op) | `src/domain-hints.js:727-730,405-442`; `src/extractors/index.js:164-187`; `src/search.js:494-527`; test tests/domain-hints.test.js:790-809 only proves validation | PENDING |
| S5 | High | Config save hot-applies before durable persistence — failed `.env` write leaves runtime diverged from canonical | `src/mcp-server.js:819-846,864-866` | PENDING |
| S6 | High | Multi-key credential/engine update is order-dependent via stale `process.env`; restart yields a different enabled list | `src/config-manager.js:74-84,85-139`; `src/mcp-server.js:867-873` | PENDING |
| S7 | High | Empty `SEARCH_ENABLED_ENGINES` means “use defaults,” not disabled | `src/config-manager.js:32-37,74-84`; `src/search.js:1166-1169` | PENDING |
| S8 | High | Engine disable/key removal leaves scheduler profiles, circuits, telemetry, cache behind; re-enable inherits stale cooldown | `src/engine-scheduler.js:95-109`; `src/search.js:121-150`; stats expose all profiles `src/mcp-server.js:3472-3474` | PENDING |
| S9 | High | Warmup engine list changes never affect existing warm search windows | `src/config-manager.js:73`; warmup only at startup `src/browser.js:1445-1474` | PENDING |
| S10 | High | Cached fetch/search results outlive hint/model/config changes (cache keys are args only) | `src/mcp-server.js:200-249,2246-2319`; `src/domain-hints.js:849-870`; cache-retention test tests/mcp-server.test.js:1912-1945 | PENDING |
| S11 | Medium | Scheduler profile-path hot apply deferred until next fallback search | `src/config-manager.js:193`; configure only at `src/search.js:1170` | PENDING |
| S12 | Medium | Malformed model registry accepted and silently empties models; duplicate model ids allowed | `src/config-schema.js:67`; `src/config.js:132-167`; `src/post-processor.js:308` first-match | PENDING |

### 9b.4 Hints, cache, and process lifecycle

Audit pass completed 2026-09-18.

| # | Severity | Finding | Evidence | Status |
| --- | --- | --- | --- | --- |
| H1 | Critical | Malformed `domain-hints.json` kills ALL extraction — no last-known-good. `loadDomainHints()` `JSON.parse` throws with no catch; `getDomainHints()` caches only successful loads so every later fetch re-parses the dead file; if a cache exists it silently serves stale hints | `src/domain-hints.js:144-186`; call site `src/search.js:2136` | PENDING |
| H2 | High | External domain-hint edits never reach extraction after first load — path-keyed cache with no mtime/size/revision check; only `clearDomainHintCache()` invalidates. Console hints GET reads the file uncached, so the panel shows the fresh edit while extraction ignores it | `src/domain-hints.js:179-191`; `src/mcp-server.js:3717`; only `saveDomainHints` :869 + `DOMAIN_HINTS_PATH` hot apply (`src/config-manager.js:202`) clear it | PENDING |
| H3 | High | Hint mutation queue (`queueHintMutation`) serializes server writers only; a panel save re-reads+writes the whole file with no CAS against external writes — silent clobber of concurrent disk edits (survives only in `.bak`) | `src/mcp-server.js:952-957`; `src/domain-hints.js:849-877` | PENDING |
| H4 | High | VNC/browser process keys are marked `applies:"hot"` but live process uses startup-only state. `HEADLESS`/`CHROME_PATH`/`CHROME_USER_DATA_DIR`/`CHROME_PROFILE_DIR`/`PRELAUNCH_BROWSER`/`STARTUP_URL`/`BROWSER_USER_AGENT` hot-apply only mutate `config.*`; the running Chromium launched at boot is never relaunched (`relaunchDefaultBackend` only from `handleConsoleVnc`). Manage reports `hotApplied`, `/health` mirrors config, live process unchanged. `VncManager` constructed with fixed defaults 1995/1996, never configured from config; with non-default ports console adopt kills nothing and probes the wrong port | `src/config-schema.js:5-11`; `src/config-manager.js:180-189,173-174`; `src/vnc-manager.js:40-41,249`; `src/browser.js:1483`; `src/mcp-server.js:902,917,3409` | PENDING |
| H5 | High | `.env` overlay never clears keys absent from the file — `applyEnvFileToProcessEnv` only assigns present keys; stale inherited env outlives removal/reset for the whole session until restart | `src/config.js:395-407`; only BROWSERS special-cased at `src/mcp-server.js:750` | PENDING |
| H6 | Medium | `checkEnvFileChanged()` sets `envFileState.changed = true` and nothing in that path resets it; the "changed on disk" banner sticks forever after a successful BROWSERS reconcile. Non-BROWSERS edits never reconcile at all | `src/mcp-server.js:480-492,3641-3646,733-751` | PENDING |
| H7 | Low-Medium | `toolResultCache` + `extractHtmlCache` + link-ref memory/SQLite have no clear control; `bypassCache` skips reads but never deletes stale entries; admin must restart to flush | `src/mcp-server.js:113-118`; `src/ref-memory.js:5-6` | PENDING |

## 10. Implementation Order

1. Build the complete lifecycle inventory and evidence table for browser/relay state first.
2. Implement one `BrowserLifecycle` reconciliation boundary if the audit confirms cleanup is split across config save, relay, browser manager, and startup paths.
3. Complete API key/tool/browser permission removal and active-session behavior.
4. Complete search-engine, credential, and post-processor dependency cleanup.
5. Complete hints, caches, external edits, reset/revert, and restart reconciliation.
6. Add a small reusable lifecycle-test harness for canonical state + runtime endpoint + restart verification only after the repeated fixture shape is proven across at least two resource families.
7. Archive this plan only when every inventory row has a documented policy, evidence, and public-boundary regression coverage.

## 11. Acceptance

1. Removing or changing any console-managed resource cannot leave it visible, routable, authorized, cached as active, or reconnectable contrary to its documented policy.
2. Every reset, revert, external-file change, and process restart converges to the same effective state as a fresh console save.
3. The console accurately explains side effects, including disconnected relays, invalidated permissions, cleared caches, and restart-required changes.
4. A user can distinguish unmanaged discovery from a configured resource and can explicitly forget an unmanaged resource without it returning unexpectedly.
5. Each confirmed lifecycle bug has an end-to-end regression test that exercises the public endpoint and verifies the user-visible/read-path outcome.

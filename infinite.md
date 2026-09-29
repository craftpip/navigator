# Infinite — the forever task queue

The agent's protocol for this file is `AGENTS.md` § Infinite loop. Nothing here is
read by the app; it exists so I can drop work in and you pick it up on the next
"keep going".

**How to use:** append one line per item to `## Queue`, top line = next up:

```md
- [ ] plans/some-plan.md
```

Then say **"check infinite"** (or **"keep going"** / **"drain"**). It works
infinite: implement each item, test it, commit it, then move straight to the next
until the queue is empty. **Infinite means keep going — never stop after one.**

An item file is one `.md` in `plans/` (see `plans/README.md`). When it is finished,
its durable knowledge is absorbed into `AGENTS.md` / `docs/` and the file moves to
`plans/archive/` — that is what the tick in `## Done` means.

## Needs your call

Decisions only I can make. Deliberately **not** `- [ ]` lines and **not** in
`## Queue`, so a "drain the queue" run cannot take a destructive or irreversible
action on its own recognizance — your job is to surface these, not to guess.
Each one should be a single reply away from done.

- **jsdom test harness is dead repo-wide.** `tests/setup.js` imports `node:fs`/`node:os`/`node:path`, and under vitest 4.1.10 + `environment: "jsdom"` *any* node builtin import in a setup file aborts collection with `Error: No such built-in module: node:`. Every `// @vitest-environment jsdom` test fails to run — including the in-flight `tests/modal-dismiss.test.jsx`. Bisected: no-imports setup passes; `node:fs`, bare `fs`, `await import("node:fs")` and `createRequire` all fail. `globalThis.process` *is* available, so the fix could drop the imports — but then the per-file `mkdtemp` isolation becomes a fixed shared dir (SQLite cross-file contention), which is your call, not mine. Options: (a) fixed shared `test.env` path, (b) split setup — DB isolation only for `environment: "node"`, (c) leave broken. Plan 49's own 7-case unit test is written and held at `testing/console/console-driver-collapse.test.jsx` — deliberately **not** under `tests/`, because vitest would collect it there and it would show up as a NEW red suite. Its header says how to run it once the harness is fixed. Note `tests/modal-dismiss.test.jsx` is the one in-flight test that is still misfiled under `tests/` and does add a red file to the suite.
- **Plan 49 (security hardening) needs a sequencing decision before code — deferred 2026-09-29.** You marked it Low ("later, not now"), so it sits at the bottom of `## Queue` and no drain run will touch it. The decision is still recorded here for whenever you pick it back up. Validated 2026-09-29: 0/6 work items done, zero HMAC/challenge/nonce in `relay-server.js`, `relay_sessions` still the bearer table. §5.1 is a *coordinated v2-only break* — shipping the server half first rejects every paired relay browser with `4001` and forces a re-PIN, and `AGENTS.md` says you actively drive `maclap2` through the relay. A `RELAY_AUTH_V2=0` flag would sequence it safely but directly overrides the plan's stated "no legacy compat" decision, so I did not add one. Also open: `?token=` in the northbound URL leaks to process lists (Bearer-header support in `puppeteer.connect` is the constraint), and whether keys live in DB rows or a `0600` file. Full write-up in `plans/49_browser-extension-security-hardening.md` §9.

## Queue

- [x] plans/archive/51_relay-timeout-and-close.md — validated + absorbed + archived 2026-09-29
- [~] plans/57_mcp-browser-permissions.md — started 2026-09-29 (validate)
- [ ] plans/59_llm_browser_tool_reliability_audit.md — validate (`proposed`, no checklist). Same rule: done → absorb into `docs/` + archive; else run the plan.
- [ ] plans/60_configuration_lifecycle_integrity_audit.md — validate (`proposed`, no checklist). Same rule: done → absorb into `docs/` + archive; else run the plan.
- [ ] plans/61_wedged-relay-target-purge.md — validate (`proposed`, 10 unticked). Same rule: done → absorb into `docs/` + archive; else run the plan.
- [ ] plans/69_cdp_relay_test_hardening.md — validate (`Planned`, no checklist). Same rule: done → absorb into `docs/` + archive; else run the plan.
- [ ] plans/14_request-activity-trend-graph.md — **priority Low** (user 2026-09-29: "can be done later, not in priority"). `In progress`: server + core chart built; remaining gaps are the engine selector, legend toggles, tooltip/tap readout, empty state, 3 test cases, and the `Browser.` devtools category bug.
- [ ] plans/49_browser-extension-security-hardening.md — **priority Low** (user 2026-09-29: "mark priority for later, not now") — deferred to last. Validated 0/6, nothing implemented; still needs your v2-only sequencing call before any code (see `## Needs your call` + plan §9).

## Done

- [x] plans/archive/55_cdp-url-sharing-api-keys.md — validated + archived 2026-09-30 (already implemented and already absorbed). All 3 requirements ship: `allowed_browsers` per-key scoping (`src/db.js:136` migration, `:353` setter), the console "Browser CDP access" modal with per-browser rows and per-browser Puppeteer connect URLs, and `ws://<host>:<port>/cdp/<browser>?key=` (`src/cdp-share.js`) with 401/403/404/429/502 gates. All §7 invariants hold and all three §8 "remaining decisions" were built with the recommended defaults (fresh per-session Chromium via `createSharedBrowser()` + `_sharedBrowsers` reap, shared add-on exposure, `SHARED_CHROMIUM_CAP = 3`). Re-verified: `tests/cdp-share.test.js` + `tests/mcp-server.test.js` 133/133; live `/cdp` unauthenticated → 401 (fails closed) and `/stats` counters carry `cdpConnections: 1`; full vitest 756 pass / 1 pre-existing plan-37 SVG failure / 1 known jsdom-harness suite error. Pre-existing revoke FK bug (mcp_calls.api_key_id has no `ON DELETE`) really fixed in `revokeMcpApiKey()`. Absorbed in `docs/guides/browsers/cdp-sharing.md` + `docs/reference/browsers/cdp-sharing.md`, both in the VitePress sidebar. Archived **as-is** by user call 2026-09-30 — the 8 validation defects (notably the §2.2-vs-§7.7 gate-order contradiction: the code resolves the browser at `src/cdp-share.js:380` *before* the access check at `:386`, so §2.2's step 4/5 numbering is backwards) were knowingly left in place.)

- [x] plans/archive/56_open-windows-instead-of-tabs.md — validated + absorbed 2026-09-30 (implementation was already committed in `1d2253e`; re-verified `unit-ext.mjs` 50/50, `unit-ff.mjs` 55 pass with the 2 pre-existing 20d/20e Probe failures, `tests/relay-server.test.js` 21/21, full vitest 756 pass at the documented baseline. Absorbed in `docs/guides/browsers/chrome-extension.md`, `docs/guides/browsers/firefox-extension.md`, `docs/reference/browsers/extensions.md` — plus a docs accuracy fix: window browser contexts are **lazy on both** extensions, not just Firefox.)

- [x] plans/archive/50_request-activity-ui-changes.md — archived 2026-09-29 **without implementation**: the original request never described the change, so it was closed by archiving rather than by picking A/B/D. Validated first (C already shipped, A absent, B partial) and absorbed into `docs/code/runtime-and-tests.md` §"Request Activity Trend Card" — including the orphaned `style.css` rules (`.request-trend-legend`, `.request-trend-plots`, `.request-trend-plot-heading`, `.request-trend-switch`, `.request-trend-detail`) for a per-engine layout that was never built.

- [x] plans/archive/39_dynamic-browser-array.md — absorbed 2026-09-29 (all 3 housekeeping gaps closed: stale `plans/39_…` duplicate deleted, `README.md` env list replaced with `BROWSERS` + the `browser` tool param, archived file set to `Complete` with an `[x]` checklist; also fixed the stale `tests/devtools.test.js` `Target.getTargets` format assertion — full suite 755 pass / 1 pre-existing plan-37 SVG failure / 1 known jsdom-harness suite error.)

- [x] plans/archive/52_live-feed-api-key-pill.md — absorbed 2026-09-29 (already implemented; verified live end-to-end: server attribution 18/21 searches + 97/100 page ops, console renders 90 adjacent backend+key pill pairs, standalone key pill where the backend pill is suppressed, and nothing for unauthenticated rows. Documented in `docs/operations/operations-and-configuration.md` §"API key attribution in the activity feed".)

- [x] plans/43_script-hint.md — absorbed 2026-09-29
- [x] plans/44_popup-validation-connected-ux.md — absorbed 2026-09-29
- [x] plans/45_browser-connection-name-and-llm-description.md — absorbed 2026-09-29
- [x] plans/46_more-devtools-window-focus.md — validated + absorbed 2026-09-29
- [x] plans/49_browser-drivers-collapsible-tabs.md — absorbed 2026-09-29 (missing `.driver-toggle-chevron` element rendered + live-verified)

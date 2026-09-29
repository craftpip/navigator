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

- **jsdom test harness is dead repo-wide.** `tests/setup.js` imports `node:fs`/`node:os`/`node:path`, and under vitest 4.1.10 + `environment: "jsdom"` *any* node builtin import in a setup file aborts collection with `Error: No such built-in module: node:`. Every `// @vitest-environment jsdom` test fails to run — including the in-flight `tests/modal-dismiss.test.jsx`. Bisected: no-imports setup passes; `node:fs`, bare `fs`, `await import("node:fs")` and `createRequire` all fail. `globalThis.process` *is* available, so the fix could drop the imports — but then the per-file `mkdtemp` isolation becomes a fixed shared dir (SQLite cross-file contention), which is your call, not mine. Options: (a) fixed shared `test.env` path, (b) split setup — DB isolation only for `environment: "node"`, (c) leave broken. Plan 49's own 7-case unit test (`tests/console-driver-collapse.test.jsx`) is written and held back until this is resolved.
- **Plan 49 (security hardening) needs a sequencing decision before code.** Validated 2026-09-29: 0/6 work items done, zero HMAC/challenge/nonce in `relay-server.js`, `relay_sessions` still the bearer table. §5.1 is a *coordinated v2-only break* — shipping the server half first rejects every paired relay browser with `4001` and forces a re-PIN, and `AGENTS.md` says you actively drive `maclap2` through the relay. A `RELAY_AUTH_V2=0` flag would sequence it safely but directly overrides the plan's stated "no legacy compat" decision, so I did not add one. Also open: `?token=` in the northbound URL leaks to process lists (Bearer-header support in `puppeteer.connect` is the constraint), and whether keys live in DB rows or a `0600` file. Full write-up in `plans/49_browser-extension-security-hardening.md` §9.
- **Plan 50 (request activity UI) has no spec to implement.** Validated 2026-09-29: option **C (summary → header) is already shipped** — `total / succeeded / failed` sit in `.request-trend-heading` beside the `<h2>` in `ActivityChart.jsx:89-97`. So the real choice is **A** (collapsible chart, small), **B** — and only the missing half of it, the engine filter + legend toggles, since the segmented range control already exists (`ActivityChart.jsx:99-105`, `aria-pressed`) — or **D** (no change). The plan also has a stale file table: the component moved from `pages/status/index.jsx` to `ActivityChart.jsx`. Details in plan §6.

## Queue

- [ ] plans/49_browser-extension-security-hardening.md — blocked 2026-09-29: needs your call on the v2-only break sequencing (see `## Needs your call` + plan §9). Validated 0/6, nothing implemented.
- [ ] plans/50_request-activity-ui-changes.md — blocked 2026-09-29: plan is a "never specified" placeholder; needs you to pick A / B / D. Validated: **C is already shipped**, A absent, B partial (see plan §6).
- [ ] plans/51_relay-timeout-and-close.md — validate (`Planned`, 8 unticked). Same rule: done → absorb into `docs/` + archive; else run the plan.
- [ ] plans/52_live-feed-api-key-pill.md — validate (`Planned`, no checklist). Same rule: done → absorb into `docs/` + archive; else run the plan.
- [ ] plans/53_loading-spinners.md — validate (`Planned`, no checklist). Same rule: done → absorb into `docs/` + archive; else run the plan.
- [ ] plans/57_mcp-browser-permissions.md — validate (`Plan`, no checklist). Same rule: done → absorb into `docs/` + archive; else run the plan.
- [ ] plans/59_llm_browser_tool_reliability_audit.md — validate (`proposed`, no checklist). Same rule: done → absorb into `docs/` + archive; else run the plan.
- [ ] plans/60_configuration_lifecycle_integrity_audit.md — validate (`proposed`, no checklist). Same rule: done → absorb into `docs/` + archive; else run the plan.
- [ ] plans/61_wedged-relay-target-purge.md — validate (`proposed`, 10 unticked). Same rule: done → absorb into `docs/` + archive; else run the plan.
- [ ] plans/69_cdp_relay_test_hardening.md — validate (`Planned`, no checklist). Same rule: done → absorb into `docs/` + archive; else run the plan.
- [ ] plans/archive/39_dynamic-browser-array.md — **priority Normal** (user 2026-09-29). Functionally `Complete` — validated 2026-09-29 (all 5 "Missing / TODO" items implemented; plan-39 test area 294/294 pass; `list_browsers` + `web_fetch(browser:)` + lazy add-on connect confirmed live). Only 3 housekeeping gaps left. **Where to continue:** (1) delete the stale duplicate `plans/39_dynamic-browser-array.md` — 941-line pre-plan-48 copy still sitting in `plans/`, missing the role-supersession note the archived copy carries; (2) `README.md` still documents the env vars plan 39 deleted — lines 21, 99, 423-424 name `BROWSER_BACKEND` / `DEVTOOLS_BROWSER_BACKEND`; replace with `BROWSERS` + the `browser` tool param; (3) the archived file's status header still reads `**Status:** Draft v2` with no `[x]` checklist — set to `Complete` per the item-file convention. Optional while in there: `tests/devtools.test.js:181` is a stale test asserting the pre-plan-42 raw-JSON `Target.getTargets` format (plan 42 replaced it with the ownership-grouped markdown render). Not plan-39 scope, but it is the only non-SVG failure in the suite.
- [ ] plans/14_request-activity-trend-graph.md — **priority Low** (user 2026-09-29: "can be done later, not in priority"). `In progress`: server + core chart built; remaining gaps are the engine selector, legend toggles, tooltip/tap readout, empty state, 3 test cases, and the `Browser.` devtools category bug.

## Done

- [x] plans/43_script-hint.md — absorbed 2026-09-29
- [x] plans/44_popup-validation-connected-ux.md — absorbed 2026-09-29
- [x] plans/45_browser-connection-name-and-llm-description.md — absorbed 2026-09-29
- [x] plans/46_more-devtools-window-focus.md — validated + absorbed 2026-09-29
- [x] plans/49_browser-drivers-collapsible-tabs.md — absorbed 2026-09-29 (missing `.driver-toggle-chevron` element rendered + live-verified)

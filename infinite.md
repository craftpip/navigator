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

- (empty — items get appended here as they come up)

## Queue

- [ ] plans/44_popup-validation-connected-ux.md — validate; header says `Draft`, no checklist. Verify the 3 goals (inline validation, spinner for all async calls, connected summary card) in both `chrome-extension/` and `firefox-extension/`, then absorb into docs + archive if done.
- [ ] plans/45_browser-connection-name-and-llm-description.md — **validation first**: the user reported it done, but 2026-09-29 checks found zero implementation (`Az01-`, `browserDescription`, `update_description`, `relay_browser_meta`, `descriptionUpdatedAt` appear nowhere outside the plan file; `chrome-extension/popup.html` still has `Browser Name` / placeholder `Chrome Dev`). Confirm with the user whether to implement, re-scope, or drop before touching status.
- [ ] plans/46_more-devtools-window-focus.md — validate (`Proposed`, no checklist). If the window-focus devtools tools exist and behave as specified, absorb into AGENTS.md + archive; else run the plan.
- [ ] plans/49_browser-drivers-collapsible-tabs.md — validate (`Planned`, 12 unticked). If collapsible browser-driver tabs are live in the console, absorb + archive; else run the plan. NOTE: number 49 is used twice — see the next line.
- [ ] plans/49_browser-extension-security-hardening.md — validate (`Draft 2026-09-06`, no checklist). Same rule: done → absorb + archive; else run the plan.
- [ ] plans/50_request-activity-ui-changes.md — validate (`Planned`, no checklist). Same rule: done → absorb + archive; else run the plan.
- [ ] plans/51_relay-timeout-and-close.md — validate (`Planned`, 8 unticked). Same rule: done → absorb + archive; else run the plan.
- [ ] plans/52_live-feed-api-key-pill.md — validate (`Planned`, no checklist). Same rule: done → absorb + archive; else run the plan.
- [ ] plans/53_loading-spinners.md — validate (`Planned`, no checklist). Same rule: done → absorb + archive; else run the plan.

## Done

- [x] plans/43_script-hint.md — absorbed 2026-09-29

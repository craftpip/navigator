# Plan 66 — Blind interactive drive: click/type/navigate/back-console-network

Routine step: plan. Execution blind (browser tools only); report in
`friction/README.md` as run 4. Runs 1–3 covered search/fetch/links/
visuals/DOM/setup-lifecycle. This run covers the INTERACTIVE devtools:
input, navigation, console, network.

## Tools covered

- `Target.createTarget` / `getTargets` / `activateTarget` / `closeTarget`
- `DOM.getDocument`, `DOM.querySelector(All)`, `DOM.scrollIntoViewIfNeeded`
- `Input.dispatchMouseEvent` (click), `Input.insertText` (type),
  `Input.dispatchKeyEvent` (Enter/Tab/Escape)
- `Page.navigate`, `Page.goBack`, `Page.goForward`, `Page.reload`
- `Runtime.evaluate`, `Runtime.getConsoleMessages`
- `Network.getRequests`
- `web_page_screenshot` (before/after states only if needed)

## Site selection (fixed upfront)

Query `react todomvc example`, take the 1st successful interactive result
(todo app = click + type + Enter + toggle + reload, all read-safe on a demo).
If it fails requirements (login/paywall/dead), take the next result and
record why.

## Run steps + expected observables

1. **Open + inspect:** createTarget, getDocument (~30), note input/button
   selectors; console messages baseline (expect clean or benign).
2. **Type + submit:** insertText into new-todo box, dispatch Enter, expect
   the item in the list (DOM re-query proves it).
3. **Click:** toggle a checkbox, click a filter link (Active/Completed);
   expect list state change via DOM.
4. **Keyboard:** Tab order sanity + Escape in an edit field if present.
5. **Navigate:** Page.navigate to a second page, goBack (expect todo page
   back), goForward, reload (expect state per app semantics).
6. **Observe:** getConsoleMessages (expect no new errors caused by us),
   getRequests (expect page's own requests listed, failedOnly empty).
7. **Targets:** getTargets lists our tab; activateTarget; closeTarget.
8. **Cleanup:** tab closed; managed store untouched (list before/after).

## Safety rules

- Demo/todo data only; never log in, never submit external forms.
- A blocked step is a `tool:` finding with the verbatim error — never skipped.
- No setup-store mutations in this run (no hints needed).

## Reporting

Append run 4 to `friction/README.md` from `RUN-TEMPLATE.md`. Fix proposals
→ plan 67+; no code changes in this run.

## Testing / success criteria (this run IS the test)

- Each step's expected observable met or logged as a finding.
- No silent workarounds; store and tabs clean at the end.
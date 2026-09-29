# LLM-Friendly DevTools

## Status: Complete — 2026-09-29

**Status: Complete** — closed 2026-09-29, archived to `plans/archive/`. Historical
note: DRAFT (planned only) at the time of writing.

### Checklist

- [ ] 1. Add post-action wait conditions to page navigation and input tools.
- [ ] 2. Add `Page.setViewport` for responsive testing after target creation.
- [ ] 3. Add stable network request IDs and `Network.getResponseBody`.
- [ ] 4. Add `DOM.getInteractiveElements` for accessible, reliable control discovery.
- [ ] 5. Make CSS/XPath locator inputs unambiguous and reject unsupported syntax.
- [ ] 6. Add complete form controls: append/replace text modes, checkbox/radio state, and select options.
- [ ] 7. Improve DevTools response metadata and incremental console/network reads.
- [ ] 8. Document the persistent-tab screenshot workflow and update tool references.
- [ ] 9. Add focused unit tests and browser-backed integration coverage for each new flow.
- [ ] 10. Restart the live server and verify the MCP schema and full website-development workflow.

## Goal

Make the DevTools MCP tools dependable for an LLM developing and testing a website.

The LLM should be able to:

1. Open a tab at desktop or mobile size.
2. See the actual interactive controls and select the right one.
3. Click, type, or submit, then wait for the page result instead of racing an SPA update.
4. Check console errors and network failures.
5. Read the failing API response when a request is not behaving as expected.
6. Verify the resulting page visually with the existing `web_page_screenshot(targetId)` capability.

## Current Tools

The existing DevTools surface already has persistent targets, creation-time viewport support, navigation/history/reload, runtime evaluation, console messages, network request summaries, DOM inspection, mouse/keyboard/text input, and target screenshots through `web_page_screenshot(targetId)`.

This plan does not add broad raw-CDP or browser administration APIs. It focuses on the small set of missing pieces that block normal website-development debugging.

## Changes

### 1. Wait After Actions

**Problem:** `Page.navigate`, `Page.reload`, `Page.goBack`, `Page.goForward`, `Input.dispatchMouseEvent`, `Input.insertText`, and `Input.dispatchKeyEvent` can return before a redirect, modal, validation message, network response, or SPA render has completed. The next LLM call then reads stale state.

**Change:** Add optional wait arguments to these existing tools:

```js
{
  waitForSelector: "[data-testid='saved']",
  waitForURL: "**/dashboard",
  timeout: 10000
}
```

- `waitForSelector` waits for a CSS selector after the action.
- `waitForURL` waits for the resulting URL to match a simple URL pattern.
- `timeout` defaults to the existing browser operation timeout and is capped safely.
- If no wait option is supplied, preserve the current immediate-return behavior.
- A response that waited must include `waitedFor`, `waitSatisfied`, `elapsedMs`, final URL, and final title.

Do not add several nearly identical standalone wait tools. The useful point is binding the wait to the action that triggered the page change.

### 2. `Page.setViewport`

**Problem:** `Target.createTarget` can now set a viewport before navigation, but responsive development requires switching between desktop and mobile in the same tab.

**Tool:**

```js
Page.setViewport({
  targetId: "<id>",
  width: 390,
  height: 844
})
```

- Accept only positive CSS-pixel `width` and `height`.
- Call Puppeteer's `page.setViewport()`.
- Store and return the effective viewport in the target summary.
- Keep device emulation, user-agent overrides, touch emulation, and media emulation out of scope. Viewport is the only responsive control needed now.

### 3. Actionable Network Inspection

**Problem:** `Network.getRequests` currently reports method, URL, status, resource type, cache state, approximate duration, and failures. It cannot explain a failing API call because it has no request identity or response content.

**Change `Network.getRequests`:**

- Add an opaque stable `requestId` to every returned request entry.
- Keep the current `filter`, `failedOnly`, `status`, and `limit` filters.
- Keep the rolling per-target buffer and its 200-entry cap.

**New tool:**

```js
Network.getResponseBody({
  targetId: "<id>",
  requestId: "<request-id>",
  maxChars: 20000
})
```

- Return response body text or JSON for the selected completed request.
- Return content type, status, truncation state, and original URL.
- Bound body storage and output size so one download cannot exhaust context.
- Do not return sensitive request/response headers, cookies, or authorization tokens.

This is the only network expansion required now. Do not add request interception, request mutation, throttling, offline emulation, HAR export, or raw CDP access.

### 4. `DOM.getInteractiveElements`

**Problem:** `DOM.getDocument` is a broad shallow selector scan. It can miss relevant controls and does not reliably expose what an LLM needs to operate a form: accessible name, role, current state, and a locator.

**Tool:**

```js
DOM.getInteractiveElements({
  targetId: "<id>",
  limit: 50
})
```

Return only visible actionable elements such as buttons, links, text fields, textareas, selects, checkboxes, radios, and elements with interactive ARIA roles. Each entry should include:

- `role`
- accessible `name`
- `selector` and `xpath`
- `tagName`
- `value`
- relevant state: `disabled`, `checked`, `selected`, `expanded`, `readonly`
- bounds and visibility

Return `total`, `shown`, and `truncated` so the LLM knows whether it saw every control.

Keep `DOM.getDocument` as the existing lightweight broad page snapshot.

### 5. Reliable Locators

**Problem:** DOM and input schemas allow both `selector` and `xpath`, while handlers silently prefer CSS. `DOM.querySelector*` also silently removes unsupported `:has-text()` and `:text()` syntax, which can turn a precise query into an incorrect broad query.

**Change:**

- Require exactly one of `selector` or `xpath` for locator-required tools.
- Return a validation error when both are supplied.
- Reject unsupported selector syntax instead of rewriting it.
- Preserve CSS and XPath as the only locator formats. Do not add text or role locator input formats in this plan; `DOM.getInteractiveElements` supplies reliable locator candidates.

Apply this consistently to DOM query, scroll, mouse click, and text input tools.

### 6. Complete Form Controls

**Problem:** `Input.insertText` always clears the value. There is no supported semantic way to set checkbox/radio state or select an option.

**Change `Input.insertText`:**

```js
{
  mode: "replace" // default, or "append"
}
```

- Preserve current behavior as `replace`.
- `append` focuses the field and types without clearing it.
- Return final value and the selected mode.

**New tools:**

```js
Input.setChecked({ targetId, selector, checked: true })
Input.selectOption({ targetId, selector, value })
```

- Each uses the existing CSS-or-XPath locator convention.
- `Input.setChecked` must avoid toggling an already-correct checkbox/radio state.
- `Input.selectOption` selects by option value and returns the final selected value.
- Both return final semantic state and a clear error when the element type is wrong.

File uploads and direct arbitrary JavaScript value assignment remain out of scope.

### 7. Response and Polling Ergonomics

**Problem:** DevTools responses are independent raw JSON payloads. Console and network reads return the latest entries repeatedly, wasting LLM context and obscuring which errors are new.

**Change:**

- Add common result fields where applicable: final `url`, `title`, `elapsedMs`, `shown`, and `truncated`.
- Add monotonic entry IDs to console and network buffers.
- Add optional `since` to `Runtime.getConsoleMessages` and `Network.getRequests`.
- Return `nextSince` so the LLM can poll only entries it has not seen.
- Keep the existing default behavior when `since` is omitted.

Do not change MCP transport formatting or add a second result envelope.

### 8. Screenshot Workflow

`web_page_screenshot(targetId)` already captures an existing DevTools tab. Make this explicit in DevTools descriptions and documentation:

1. Create target with viewport.
2. Inspect interactive elements.
3. Act with an attached wait condition.
4. Read console and network deltas.
5. Capture a target screenshot to verify the final UI.

No duplicate DevTools screenshot tool is needed.

## Files

| File | Change |
|---|---|
| `src/devtools.js` | Wait handling, viewport setter, network request IDs/body storage, interactive-element snapshot, locator validation, form controls, incremental buffer reads, schemas, dispatch. |
| `tests/devtools.test.js` | Schema, validation, dispatch, wait, network body, interactive snapshot, form state, viewport, and incremental-read coverage. |
| `README.md` | Concise persistent DevTools workflow including target screenshots. |
| `AGENTS.md` | Update the documented DevTools count and references after implementation. |

## Verification

1. Run `docker exec navigator npm install --include=dev` after every container restart.
2. Run `docker exec navigator npx vitest run tests/devtools.test.js`.
3. Run ESLint directly on changed files.
4. Restart: `docker restart navigator`.
5. Verify the live `tools/list` schema exposes every planned tool and option.
6. Run one browser-backed website flow at desktop and mobile viewport:

```text
Target.createTarget(viewport)
DOM.getInteractiveElements
Input.insertText(mode)
Input.dispatchMouseEvent(waitForSelector)
Network.getRequests(since)
Network.getResponseBody(requestId)
Runtime.getConsoleMessages(since)
web_page_screenshot(targetId)
```

7. Verify failure cases: invalid dual locator, missing wait selector, unknown request ID, truncated response body, wrong input type, and already-correct checkbox state.

## Out of Scope

- Request interception, mocking, and mutation.
- Network throttling, offline mode, HAR export, and raw CDP sessions.
- Full browser/device emulation beyond width and height.
- File upload automation.
- A duplicate DevTools screenshot tool.
- Text and role locator input formats.

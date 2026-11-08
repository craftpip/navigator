# 76 — Live DOM and CSS Collaboration
## Status: Proposed — 2026-10-15 — design written, 0/6 implementation phases complete

## Goal

The user tweaks a page in browser DevTools: changes a class, adjusts padding,
edits text, moves an element, or modifies a CSS rule. The LLM reads exactly what
changed and applies the same intent to the project's source code. The browser
becomes a shared workspace between the user and the coding agent.

Example:

1. LLM starts tracking the user's existing tab, scoped to the component being worked on.
2. User changes `.card` padding from `16px` to `24px`, then adds `compact` to its class list.
3. LLM reads the changes: before/after values, element context, stylesheet URL and rule location when available.
4. LLM finds the component and stylesheet in the repo and edits the source.
5. After reload/HMR, LLM checks that the source produces the intended result and reads any newer user edits.

Navigator supplies browser evidence. The coding agent, which has repo access,
maps that evidence to source files and makes the edits.

## 1. Proposed tool contract

Add one tool, `DOM.trackChanges`, using the existing devtools naming convention.
It is a cursor-based pull API; no background MCP notification dependency.

| Action | Inputs | Behavior |
| --- | --- | --- |
| `start` | `targetId`, optional `selector`, `includeStylesheets` (default true) | Attach to that exact tab, establish baseline, return `trackingId`, initial cursor and capabilities. |
| `read` | `trackingId`, optional `after`, `limit` (default 50, max 200), `waitMs` (default 0, max 20000) | Return ordered change batches after the cursor. Optional bounded wait for new changes. Re-reading a cursor is repeatable. |
| `stop` | `trackingId` | Flush pending records, stop collection, retain unread records briefly for final reads; never close the tab. |

Schema uses action-specific validation: `targetId` is required only for start;
`trackingId` is required for read/stop. Unknown options are rejected. Only one
active tracker per caller + target + scope; repeated start returns the existing
tracker rather than silently resetting its baseline.

Example calls:

```json
{"action":"start","targetId":"<existing-user-tab>","selector":"#preview"}
{"action":"read","trackingId":"<tracker>","after":0,"waitMs":10000}
{"action":"stop","trackingId":"<tracker>"}
```

Reads return `trackingId`, `targetId`, URL, `documentEpoch`, status,
`changes`, `nextCursor`, `hasMore`, `oldestCursor`, dropped-record count,
capabilities and warnings. `nextCursor` advances only through returned batches,
never past an undisplayed record. No read consumes or acknowledges records.

Each change includes:

- Monotonic sequence, timestamp, document epoch, frame context and change kind.
- Document-local element identity plus before/after selector hints, XPath,
  tag, stable attributes, short text and bounded ancestor/HTML context.
  Identity must survive a class/id change; selectors alone are not identity.
- Before/after values: class tokens, inline CSS declarations, text, attributes,
  inserted/removed markup, or stylesheet text/rule differences as appropriate.
- CSS evidence when available: stylesheet URL, origin, source-map URL, rule
  selector, original range and changed declarations including `!important`.
  Missing source metadata is explicit, never a fabricated repo filename.
- `origin`: `agent`, `unknown`, or `user-confirmed`; optional correlation ID.
  A browser event alone never proves that a human caused the change.

Text output should lead with a short actionable diff, e.g.:

```text
#12 .card (element e7) — class changed
  before: card
  after:  card compact
  origin: unknown
#13 /assets/app.css — .card
  padding: 16px -> 24px
  source map: /assets/app.css.map
```

Large values carry explicit truncation markers and lengths. Keep full baseline
data within the collection budget so output truncation cannot corrupt later diffs.

## 2. Capture design

Implement a `ChangeTrackingManager` with per-tracker state and small capture
adapters in a dedicated module, proposed `src/dom-change-tracker.js`. Keep
`src/devtools.js` responsible for schema, authorization and target resolution.
Reuse existing browser/session lifecycle and relay transport.

### DOM adapter

- Install a MutationObserver with attribute/character-data old values and
  child-list tracking. Capture classes, inline style, attributes, text and
  added/removed/moved nodes, including edits made through Elements DevTools.
- Establish baseline and subscribe without an unobserved gap. Preserve removed
  node context before it becomes unavailable. Batch synchronous mutations;
  coalesce edit bursts while retaining first-before and last-after values.
  An edit followed by undo should have no net effect in the batch summary.
- Observe the selected subtree and accessible open shadow roots. Watch the
  scope root's parent for replacement/removal. Report a lost scope instead of
  silently switching to the whole document. Report unsupported frame/shadow
  coverage explicitly; initial scope is the main frame plus open shadow roots.
- Exclude form control values and sensitive input content from collection.
  Avoid full-page HTML dumps. Bound observer-side queues as well as server buffers.

### Stylesheet adapter

- A MutationObserver is insufficient: changing a stylesheet rule in DevTools
  or through CSSOM need not change a DOM attribute or style element text.
- On Chromium-capable backends, subscribe to CSS stylesheet added/changed/
  removed events and obtain baseline/current text with `CSS.getStyleSheetText`.
  Enable the prerequisite DOM/CSS domains and retain stylesheet headers.
  Diff authored declarations/rules, preserving custom properties, media rules,
  selector changes, disabled declarations and `!important` where supported.
- Probe actual support through built-in Chromium, CDP add-ons and Chrome relay.
  Confirm whether DevTools and navigator debugging sessions coexist on the
  installed browser. Do not claim success if opening DevTools detaches collection.
- Validate CSSOM `insertRule`, `deleteRule`, `replaceSync` and adopted stylesheet
  behavior live. Where protocol events miss changes, use bounded periodic
  stylesheet reconciliation if readable, with explicit coverage reporting.
  Avoid globally monkey-patching page APIs as the default capture mechanism.
- Firefox/BiDi and non-rendering backends return precise capabilities. A DOM-only
  fallback must say stylesheet tracking is unavailable; inaccessible cross-origin
  sheets must not be represented as unchanged. Full browser parity is not assumed.
- When DOM scope is set, DOM records stay scoped. Stylesheet changes may affect
  multiple components: label them document-global rather than implying the rule
  belongs solely to the selected subtree.

### Attribution and noise

MutationObserver and CSS events do not identify the human editor. App timers,
framework renders, HMR and user actions all produce changes. Default origin is
`unknown`; describe these as observed edits, not guaranteed user edits.

Tag navigator mutation operations using operation IDs where deterministic, and
surface agent changes separately. Temporal overlap alone is not sufficient to
attribute every concurrent mutation to the agent. Arbitrary `Runtime.evaluate`
side effects remain unknown unless instrumented reliably. Narrow scope and
coalescing reduce noise without hiding uncertain changes. A future explicit
user selection/confirmation UI can mark intent; it is not required for v1.

## 3. Lifecycle, isolation and bounds

- Trackers belong to the authenticated caller/session and browser permission
  context. Recheck browser access on every action; knowing an ID grants no access.
  Restricted callers cannot read another caller's buffers or continue after revocation.
- A tracker pins an adopted handle while active, preventing the existing five-minute
  target inactivity reap from silently ending collaboration. Release the pin on
  stop/expiry. Never close the user's underlying tab.
- Navigation ends the old document epoch and emits a boundary event. Reattach
  with a fresh baseline when possible; never diff two documents as a giant edit.
  Classify new documents/HMR replacements as context changes, not human intent.
- On browser disconnect, target closure or observer loss, return a clear status
  and gap warning. Reconnection cannot promise recovery of missed edits.
- Proposed defaults: 30-minute read-idle expiry, 1000 buffered batches / 5 MiB
  per tracker, 60-second stopped-buffer retention, bounded baseline storage
  and per-caller/global tracker caps. Finalize constants with memory/load tests.
  Eviction emits a gap/dropped count and requires a new baseline where necessary.
- Clean up observers, bindings, listeners and timers on stop, expiry and teardown.
  Do not disable shared CDP domains that another consumer still needs.
  Process restart ends trackers explicitly; persistence is not part of v1.

## 4. Mapping browser edits back into code

The tool response is an evidence bundle, not an automatic generated patch.
Document the consumer workflow:

1. Read a batch and identify the intended edits with the user when origin is unclear.
2. Find source using class names, surrounding markup/text, stylesheet URL, rule
   selector and source map. CSS-module hashes and compiled URLs are hints, not
   original component names. Report ambiguous matches instead of guessing.
3. Apply the intent in the component's conventions: JSX/className, templates,
   CSS/SCSS, utility classes or CSS-in-JS. Don't paste compiled DOM into source.
4. Keep the read cursor, rebuild/reload, and compare resulting DOM/styles with
   the desired after-state. Check for new user edits before overwriting a newer
   decision. Mark source-application results in the agent's task flow.

No repository filesystem access is added to the MCP server. Screenshot crops
and existing DOM tools provide optional visual/context verification.

## 5. Implementation phases and tests

- [ ] **Phase 1 — capability spike.** Exercise real Elements class/inline-style
  edits and Styles-panel rule edits on built-in Chromium and Chrome relay while
  DevTools is open. Check CSSOM, cross-origin sheets, frame/shadow coverage and
  Firefox fallback. Record supported/unsupported paths before locking adapters.
  Test: live MCP-driven fixture plus manual human DevTools edits; verify the
  observer/CDP stream sees them without disconnecting the user's browser.
- [ ] **Phase 2 — capture and diff core.** Implement manager, DOM/CSS adapters,
  identities, baselines, batching and bounded storage.
  Test: old/new values, repeated edits, undo, class/id identity changes, node
  moves/removal, CSS selector/declaration/rule changes, duplicate event sources,
  malformed CSS, Unicode, large documents and overflow. Events alone without
  changed text must not manufacture an edit.
- [ ] **Phase 3 — MCP contract and lifecycle.** Wire schema, dispatch, formatter,
  permission isolation, cursor reads, bounded wait, stop and cleanup.
  Test: validation, repeatable reads, pagination without skips, empty/time-out
  reads, concurrent readers, denied/revoked access, stop with unread records,
  navigation epochs, reconnect gaps, session end and adopted-tab pin/release.
- [ ] **Phase 4 — attribution and backend integration.** Correlate supported
  agent writes; expose unknowns and per-backend capability limits honestly.
  Test: concurrent app/user/agent changes; app mutation during an agent operation
  must not be confidently mislabeled. Chrome/Firefox extension tests cover any
  required event forwarding changes; no relay changes without demonstrated need.
- [ ] **Phase 5 — end-to-end collaboration.** On a small source-backed fixture,
  start tracking, have a human change class + stylesheet rule + text in DevTools,
  read evidence through MCP, apply to source, reload, and compare desired styles
  and structure. Include app noise, HMR and a newer conflicting edit.
  Test desktop and mobile layout after the source change; inspect console/request
  failures. Automated page edits complement, but do not replace, human DevTools
  edits. Log consumer-surface friction following `friction/AGENTS.md`.
- [ ] **Phase 6 — release verification and docs.** Run relevant tests and full
  suite in-container with zero new failures against a freshly recorded baseline;
  run lint, deploy/restart and verify the actual advertised tool through MCP.
  Document contract in `docs/api/tool-reference.md`, lifecycle/backend coverage
  in `docs/architecture/browser-runtime.md`, and a browser-to-source example in
  `docs/guides/`. Rebuild docs; absorb durable behavior and archive this plan
  only after implementation and live verification are complete.

## 6. Acceptance criteria

- A human class/inline-style edit and a DevTools stylesheet-rule edit both reach
  the LLM as useful before/after evidence on supported Chromium/Chrome relay.
- The LLM can turn those edits into a verified source change using the supplied
  context, without manually taking and comparing whole-page DOM dumps.
- Unknown origin, missing source locations, unsupported coverage and lost records
  are visible. Ordinary app mutations are never automatically called human edits.
- Cursor reads are repeatable and gap-aware, resources are bounded, browser
  permissions hold, and stopping leaves the user's tab open and usable.

## References

- [Chrome DevTools Protocol — CSS](https://chromedevtools.github.io/devtools-protocol/tot/CSS/)
  — stylesheet events, text retrieval and source headers.
- [MDN — MutationObserver](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver)
  — DOM observation; not a general CSSOM or edit-origin feed.
- Existing integration points: `src/devtools.js` tool definitions/dispatch and
  target lifecycle; `src/browser.js` adopted targets; `src/relay-server.js` and
  extension CDP event routing. Trace these during implementation before editing.

# Plan 62 — web_fetch_setup + inline script on web_fetch

**Created:** 2026-09-23
**Status:** Draft
**Scope:** Page-extraction customisation via a new `web_fetch_setup` MCP tool + per-call `script` param on `web_fetch`
**Relates to:** `plans/43_script-hint.md` (stored script execution model — REUSED, not duplicated), `plans/04_llm-managed-domain-hints.md` (request-scoped vs persisted customisation — REUSED)

---

## Problem

Declarative hints (`default` / `flow`) cannot read chart series, SPA API state, or aggregated values — exactly the NSE hourly / TradingEconomics 1H pain. Plan 43 solves execution (vm sandbox with live `page`), Plan 04 solves lifecycle (request-scoped vs persisted). Neither gives the LLM what was asked:

1. A named setup tool for page-extraction customisation (`web_fetch_setup`).
2. A per-call script escape hatch directly on `web_fetch`.

Without both, the LLM must either edit `domain-hints.json` + restart (human loop) or guess selectors.

---

## Design (reuse first)

### What is reused verbatim (do not re-spec)

- From Plan 43: result schema (`{text*, title?, url?, tables?, links?, warnings?, seo?}`, string auto-wrap), vm sandbox contents (`page`, `capturePageState`, console, builtins; NO `require/process/fs/net`), wrapper `(async () => { … })()`, `validateScript` syntax check, `scriptOptions.timeoutMs` default 30000 max 60000, mutual exclusivity (`default` | `flow` | `script`), wildcard never supports `script`, no caching for script runs, `requireSelector` still allowed as pre-gate.
- From Plan 04: single-target-only rule for request-scoped customisation, merge/replace semantics, managed-vs-static precedence, revision-keyed cache invalidation, disabled-by-default mutation tool, `additionalProperties: false`, telemetry redaction, never touch `domain-hints.json` from runtime.

Any change to sandbox shape, result schema, or timeout handling lands in Plan 43 first, then this plan inherits it.

### 1. `web_fetch` gains `script` + `scriptOptions`

```json
{
  "url": "https://tradingeconomics.com/nifty:ind",
  "script": "const s = await page.evaluate(() => document.querySelector('#UpdatePanelChart')?.innerText); return { text: s };",
  "scriptOptions": { "timeoutMs": 15000 }
}
```

Contract (mirrors Plan 04 §Request-Scoped):

- Applies to current call only, never persisted.
- Single-target only — reject with `urls`/`ref_ids` batch (same error shape as `domainHint` multi-target rejection).
- Mutually exclusive with request `domainHint` and with resolved stored script — request `script` wins, no merge.
- Excluded from nothing in cache key — script runs bypass cache entirely (same as Plan 43 §Open Q5: no caching).
- Validation = Plan 43 `validateScript` + `scriptOptions` bounds check, before any navigation.
- Execution = Plan 43 `runScriptExtraction` (same sandbox, same truncation-note + hintNote path).

### 2. New tool `web_fetch_setup` (persisted customisation)

Name (user-locked): **`web_fetch_setup`**. Underscore form matches `web_fetch` / `web_search` convention; console label "Fetch Setup".

It manages persisted script customisations only (declarative hints stay in `domain-hints.json` + HintEditor). Backing store = Plan 04 `ManagedDomainHintStore` path (`DOMAIN_HINTS_MANAGED_PATH`), filtered to entries carrying `script`. No second store.

Operations (same envelope as Plan 04 `domain_hints`):

```json
{ "operation": "list" }
{ "operation": "get", "url": "https://example.com/page" }
{ "operation": "validate", "hint": { "domain": "example.com", "pathPattern": "/*", "script": "return {text: 'hi'}" } }
{ "operation": "upsert", "hint": { "id": "ex-1h-v1", "domain": "example.com", "pathPattern": "/*", "pageType": "chart", "comment": "reads 1H series", "script": "…" } }
{ "operation": "disable", "id": "ex-1h-v1" }
{ "operation": "remove", "id": "ex-1h-v1" }
```

- `id` regex, `priority`, `enabled`, `createdAt/updatedAt`, atomic 0600 write, revision bump + `web_fetch` cache clear — all per Plan 04 §Persistence.
- Gated by `ENABLE_DOMAIN_HINT_MANAGEMENT=1` (no new flag; this tool IS the script surface of that management plane). Absent from `tools/list` when disabled; direct calls reject.
- Stored entry shape = Plan 43 script hint + Plan 04 management metadata (`id/enabled/priority/...`). `validateHintRule` already covers mutual exclusivity once Plan 43 lands.

### Resolution order (single source)

1. Request `script` (per-call param).
2. `web_fetch_setup` persisted script (managed store, priority → specificity → file order per Plan 04).
3. Static `script` hint in `domain-hints.json` (Plan 43).
4. Flow / default / generic (unchanged).

First match wins. Log only `{source, id, pageType}` under `DEBUG=1`.

---

## Implementation Plan

### Phase 1: Server — script param (`src/mcp-server.js` + `src/search.js`)

- Requires Plan 43 Phase 1 (`validateScript`, `runScriptExtraction`, dispatch in `browserOpenAndExtract`) — depend, don't duplicate.
- `src/mcp-server.js`: add `script` (string) + `scriptOptions` (object, `additionalProperties:false`) to `web_fetch` schema; reject multi-target + `script`+`domainHint` combos before `openTargetsParallel`; thread through to `browserOpenAndExtract`; bypass cache read/write when `script` present.
- `src/search.js`: check request `script` first in dispatch (before managed/static/flow); same result shaping + truncation note.

### Phase 2: Server — setup tool (`src/mcp-server.js` + `src/domain-hints.js`)

- Requires Plan 04 §§3–4 (managed store, revision-keyed invalidation) — depend, don't duplicate.
- Advertise `web_fetch_setup` only when `ENABLE_DOMAIN_HINT_MANAGEMENT=1`; implement `list/get/validate/upsert/disable/remove` as thin wrappers over the managed store filtered to `script` entries; `additionalProperties:false`; redact bodies in telemetry.
- `get` reports effective script for a URL + source (`request|managed|static|none`).

### Phase 3: Docs + console (defer code)

- `AGENTS.md` Tool Contract: `web_fetch_setup` ops + `web_fetch.script` contract (single-target, no-cache, precedence).
- HintGuide: point script authoring at Plan 43 examples; note request-script for one-offs, setup-tool for persists.
- Console: no new editor — Script tab (Plan 43 Phase 2) remains the authoring UI; setup-tool rows render in the same list.

---

## Files to Change (new code only)

| File | Change |
|------|--------|
| `src/mcp-server.js` | `web_fetch` schema `+script/scriptOptions`, multi-target + exclusivity rejects, `web_fetch_setup` tool + gating |
| `src/search.js` | Request-`script` first in dispatch, cache bypass |
| `src/domain-hints.js` | Only via Plan 43/04 (no new validation here) |
| `AGENTS.md` | Tool Contract + precedence |

---

## Tests

- Request `script` changes output for one fetch, not reused by next plain fetch; multi-target rejected; `script`+`domainHint` rejected; invalid syntax rejected pre-navigation; timeout surfaces friendly error; script runs never hit cache.
- Setup tool absent when disabled, rejects direct mutation; upsert→fetch applies, disable→generic resumes, remove→gone; static file untouched; revision invalidates stale fetches.
- Live: TradingEconomics 1H + NSE live-indices via request script vs screenshot/DOM (chat-test protocol).

---

## Open Questions

1. Should request `script` allow `requireSelector` pre-gate? Proposal: no — script checks DOM itself; keeps per-call path minimal.
2. Separate enable flag (`ENABLE_FETCH_SETUP`) or reuse `ENABLE_DOMAIN_HINT_MANAGEMENT`? Proposal: reuse — one management plane.
3. `scriptOptions` beyond `timeoutMs` (e.g. maxChars override)? Proposal: no — `maxChars` stays top-level.

---

## Non-Goals

- New sandbox, new result schema, second managed store, auto-save after fetch, declarative-hint management (stays in Plan 04), console script editor (stays in Plan 43).

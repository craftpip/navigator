# Plan 43 — Script Extraction Hints

**Created:** 2026-09-04
**Status:** Draft
**Scope:** New third extraction method for domain hints — "script"

---

## Problem

Domain hints currently support two extraction methods:
1. **Default** — single-shot: navigate → stabilize → extract once via a configured extractor (Readability, HTML-to-markdown, etc.)
2. **Flow** — interactive multi-step: scripted extract/click/type/navigate steps, each gated and stabilized

Both are limited to a fixed vocabulary of actions and a fixed set of extractors. Some pages need full programmatic control — dynamic SPAs that load data via API calls, pages requiring math/aggregation across elements, content that only appears after complex DOM manipulation, or outputs that don't fit the extractor pipeline.

**Script** is a third method where the user writes a JavaScript function that receives the live Puppeteer `page` object and returns a structured result directly — no extractor, no post-processor.

---

## Design

### Hint Shape

A script hint carries a `script` field (string of JS) instead of `default` or `flow`:

```json
{
  "domain": "example.com",
  "pathPattern": "/dashboard",
  "pageType": "analytics-dashboard",
  "comment": "Extracts KPI values from a React SPA after chart render",
  "script": "const data = await page.evaluate(() => {\n  const cards = document.querySelectorAll('.kpi-card');\n  return [...cards].map(c => ({\n    label: c.querySelector('.label')?.textContent?.trim(),\n    value: c.querySelector('.value')?.textContent?.trim()\n  }));\n});\nreturn {\n  text: data.map(d => `- **${d.label}:** ${d.value}`).join('\\n'),\n  title: await page.title()\n};",
  "scriptOptions": {
    "timeoutMs": 15000
  }
}
```

### Result Schema

The script must return (or resolve to) an object with this shape:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | `string` | Yes | The extracted content (markdown or plain text) |
| `title` | `string` | No | Page title override |
| `url` | `string` | No | Page URL override (e.g. after redirects) |
| `tables` | `Array<{context, headers, rows}>` | No | Structured table data |
| `links` | `Array<{url, text}>` | No | Links to include |
| `warnings` | `string[]` | No | Non-fatal warnings to append |
| `seo` | `object` | No | SEO snapshot override (usually omitted; auto-captured) |

Everything is optional except `text`. If the script returns a plain string, it's treated as `{ text: returnValue }`.

### Execution Context

The script runs in **Node.js** (not browser context) because it needs the Puppeteer `page` object. It's sandboxed via Node's `vm` module:

```js
const vm = require('vm');
const sandbox = {
  page,                                              // live Puppeteer Page
  capturePageState: () => capturePageState(page),    // {html, url, title, browserText}
  console,                                           // logging
  setTimeout, setInterval, clearTimeout, clearInterval,
  URL, URLSearchParams,                              // web APIs
  JSON, Math, Date, parseInt, parseFloat, isNaN, isFinite,
  Promise, Array, Object, String, Number, Boolean, Map, Set, RegExp,
  Error, TypeError, RangeError,
  undefined
};
const context = vm.createContext(sandbox, { name: 'script-hint' });
const script = new vm.Script(hint.script, { filename: `hint:${hint.domain}` });
const result = await script.runInContext(context, { timeout: scriptTimeoutMs });
```

**What's available inside the script:**
- `page` — full Puppeteer Page API (`page.evaluate()`, `page.click()`, `page.type()`, `page.$$eval()`, `page.goto()`, etc.)
- `capturePageState()` — returns `{html, url, title, browserText}` from the current page
- `console.log/warn/error` — logged to navigator's console
- Standard JS builtins (Array, Object, JSON, Math, Date, Promise, Map, Set, RegExp, URL, etc.)
- `setTimeout`/`setInterval` — for delays/polling

**What's NOT available:**
- `require()` / `import` / `process` / `fs` / `child_process` / `net` / `http` / `crypto`
- `eval()` / `new Function()` (the vm sandbox blocks these by default)
- Global Node.js modules

**Return behavior:**
- The script can be a statement body (synchronous) or an async function body
- If the last expression is a Promise, it's awaited
- If the return value is a string, it's wrapped as `{ text: string }`
- If the return value is falsy or throws, the extraction fails with a descriptive error

### Script Wrapper

The user writes the **body** of the function, not the full `async function(page) {...}` wrapper. The executor wraps it:

```js
const wrapped = `(async () => { ${userScript} })()`;
```

This lets users write bare statements and use `return` naturally.

### Validation (`validateScript` in `src/domain-hints.js`)

```js
function validateScript(script, { scope = 'static' } = {}) {
  const errors = [];
  if (typeof script !== 'string' || !script.trim()) {
    errors.push({ field: 'script', message: 'script must be a non-empty string' });
    return errors;
  }
  // Syntax check: try to parse it
  try {
    new vm.Script(script, { filename: 'validate' });
  } catch (e) {
    errors.push({ field: 'script', message: `script syntax error: ${e.message}` });
  }
  return errors;
}
```

### Mutual Exclusivity

Update `validateHintRule` (line 824–831):

```js
const methodKeys = ["default", "flow", "script"].filter((key) => hint[key] !== undefined);
if (isWildcard && (hint.flow !== undefined || hint.script !== undefined)) {
  errors.push({ field: "...", message: "wildcard hints only support default extraction" });
} else if (methodKeys.length > 1) {
  for (const key of methodKeys) {
    errors.push({ field: key, message: 'choose exactly one extraction method: "default", "flow", or "script"' });
  }
}
```

---

## Implementation Plan

### Phase 1: Core Server (`src/domain-hints.js` + `src/search.js`)

**1.1 `src/domain-hints.js`**
- Add `"script"` and `"scriptOptions"` to `TOP_LEVEL_KEYS` (line 667)
- Add `validateScript(script)` function — syntax check via `vm.Script`
- Update `validateHintRule` mutual exclusivity to include `"script"` in `methodKeys` (line 824)
- Update wildcard restriction to reject `script` (line 825)
- Update `getExtractionMethod()` to return `"script"` when `hint.script` is set (line 193)
- Validate `scriptOptions.timeoutMs` (optional, positive integer, max 60000, default 30000)

**1.2 `src/search.js`**
- Import `vm` from `'node:vm'`
- Add `runScriptExtraction()` function:
  ```
  async function runScriptExtraction({ page, hint, config, maxChars, debug, debugLog,
    withPageTimeout, withOperationDeadline, operationTimeoutMs, includeSeoAnalysis,
    hintNote, startTime, defaultExtractSkipSelectors, signal })
  ```
  - Wraps `hint.script` in `(async () => { ... })()`
  - Creates `vm.createContext()` sandbox with `page`, `capturePageState`, standard builtins
  - Runs with `timeout: hint.scriptOptions?.timeoutMs || 30000`
  - Validates result shape: must be object with `text` (string) or a string (auto-wrapped)
  - Captures final page state + SEO if `includeSeoAnalysis`
  - Applies truncation note + hintNote
  - Returns standard `{ title, url, text, textOriginalLength, tables?, links?, warnings?, seo? }`
- Wire into `browserOpenAndExtract` dispatch (line 2291):
  ```js
  if (hint?.script) {
    return runScriptExtraction({ ... });
  } else if (hint?.flow?.length) {
    ...
  ```
- Also handle script hints in the cached HTML path (line 2148): script hints always need a browser, so skip the cache fast-path

**1.3 Timeout and error handling**
- `vm.Script` timeout throws `Error: Script execution timed out` — catch and return a user-friendly error
- Script errors (thrown exceptions) include the script's error message and stack
- Bot detection: script hints do NOT auto-run `detectBotChallenge` — the script is responsible for checking if needed
- Signal abort: check `signal.aborted` before execution, and periodically during long-running scripts (the script can check it via a helper, or we rely on the vm timeout)

### Phase 2: Console UI (`src/web-console/`)

**2.1 `constants.js`**
- Update `emptyHint()` — no change needed (script hints don't need defaults)
- Update `modeFromHint()` (line 58): add `if (hint?.script) return "script";`
- Update `hintMeta()` (line 63): add script display (`script: <N> chars`)

**2.2 `HintEditor.jsx`**
- Add third tab button: **"Script"** with subtitle `arbitrary JS — full page control`
- Add `switchToScript()` handler: ensures `hint.script` exists (default empty string), sets mode
- Update `cleanedHint` (line 36): strip `default`/`flow`/`flowOptions` when mode is `"script"`, strip `script`/`scriptOptions` when mode is `"default"` or `"flow"`
- Render script editor when `mode === "script"` (a `<textarea>` with monospace font, line numbers, basic syntax highlighting)

**2.3 `ScriptEditor.jsx`** (new file)
- Monospace `<textarea>` for the script body
- Shows available APIs in a collapsible reference panel
- `scriptOptions.timeoutMs` input (number, default 30000)
- Character count display
- Syntax validation indicator (valid/invalid based on server-side check or client-side `try { new Function(script) }`)

**2.4 `HintTest.jsx`**
- No changes needed — the test panel already sends the full `cleanedHint` JSON to `/extract?hint=`, so script hints just work

### Phase 3: `/extract` Endpoint (`src/mcp-server.js`)

**3.1 Validation**
- The `/extract?hint=` path already calls `validateHintRule(candidate, { scope: "test" })` — script hints will be validated there
- Ensure `scope: "test"` also allows `script` field (no special restrictions needed)

**3.2 Response**
- Script hints go through the same `browserOpenAndExtract` → `runScriptExtraction` path as MCP `web_fetch`
- No special handling needed in the endpoint

### Phase 4: Documentation

- Update `AGENTS.md` Domain Hints Workflow section
- Update `HintGuide.jsx` with script mode documentation
- Add example scripts to the guide

---

## Files to Change

| File | Change |
|------|--------|
| `src/domain-hints.js` | Add `TOP_LEVEL_KEYS` entries, `validateScript()`, update `validateHintRule`, update `getExtractionMethod` |
| `src/search.js` | Add `runScriptExtraction()`, update `browserOpenAndExtract` dispatch |
| `src/mcp-server.js` | No changes needed (validation flows through `validateHintRule`) |
| `src/web-console/src/pages/hints/constants.js` | Update `modeFromHint()`, `hintMeta()` |
| `src/web-console/src/pages/hints/HintEditor.jsx` | Add third tab, `switchToScript()`, `cleanedHint` update, render `ScriptEditor` |
| `src/web-console/src/pages/hints/ScriptEditor.jsx` | **New file** — script editor component |
| `src/web-console/src/pages/hints/HintGuide.jsx` | Add script mode documentation |

---

## Example Scripts

### Simple text extraction from a SPA
```js
const items = await page.evaluate(() => {
  return [...document.querySelectorAll('.product-card')].map(card => ({
    name: card.querySelector('.name')?.textContent?.trim(),
    price: card.querySelector('.price')?.textContent?.trim(),
  }));
});
return {
  text: items.map(i => `- **${i.name}:** ${i.price}`).join('\n')
};
```

### Multi-page aggregation
```js
const results = [];
for (const link of await page.$$eval('.category-link', els => els.map(e => e.href))) {
  await page.goto(link, { waitUntil: 'domcontentloaded' });
  const items = await page.$$eval('.item', els => els.map(e => e.textContent?.trim()));
  results.push(...items);
}
return { text: results.join('\n') };
```

### Polling for dynamic content
```js
let content = null;
for (let i = 0; i < 20; i++) {
  content = await page.evaluate(() => document.querySelector('.loaded-content')?.textContent?.trim());
  if (content) break;
  await new Promise(r => setTimeout(r, 500));
}
return { text: content || 'Content did not load in time' };
```

---

## Security Considerations

- **VM sandbox isolation:** No `require`, `import`, `process`, `fs`, `net`, `http`, `crypto` access
- **Timeout enforcement:** `vm.Script` hard-kills execution after `timeoutMs` (default 30s, max 60s)
- **Input validation:** Syntax check via `vm.Script` before execution; reject invalid JS at hint save time
- **Scope:** Scripts only run when `web_fetch` is called for a matching domain+path — not on every page load
- **No persistence:** Scripts are not evaluated at hint load time, only at fetch time

---

## Open Questions

1. **Should scripts have access to `extractTextFromHtml` / `extractTablesFromDocument`?** These are internal utilities that could be useful but couple the script to navigator internals. Decision: **not initially** — scripts should be self-contained. If needed, we can add them as optional sandbox helpers later.

2. **Script hints + `requireSelector`?** Should a script hint be gated by a DOM selector check? The script itself can check, but `requireSelector` is more efficient (no page open if selector absent). Decision: **yes, support it** — the selector check runs before the page opens, same as default/flow.

3. **Should the wildcard hint ever support script?** No — same restriction as flow. The wildcard is the fallback; it must use a deterministic extractor.

4. **Console script editor — syntax highlighting?** A full CodeMirror/Monaco editor is heavy. Decision: start with a plain `<textarea>` with monospace font; add highlighting later if needed.

5. **Should script hints be cacheable?** Cached HTML can't be used for script hints (scripts need the live page). Decision: **no caching** — always open a fresh page.

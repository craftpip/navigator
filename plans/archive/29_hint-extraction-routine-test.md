# Plan 29: Manual Domain Hints Extraction Test Routine

## Status: Complete — 2026-09-29

**Status:** Complete — closed 2026-09-29, archived to `plans/archive/`. The routine
it describes is documented in `AGENTS.md` → [Domain Hints Workflow](../AGENTS.md).

**Created:** 2026-08-18

---

## Problem

Every time domain hints change or code is modified, we need to verify that every hint still extracts correctly. Automated tests can check HTTP status codes but can't tell whether the **output is actually correct** — whether the right content was extracted, whether it's readable, whether noise was excluded, whether the formatting makes sense.

This plan defines a **manual routine** where I (the agent) use the browser tools to navigate the console's Domain hints editor, test each hint against its test URLs, and validate the extracted output by reading it. This catches things no automated test can: garbled text, missing sections, broken formatting, wrong content.

---

## How it works

### The routine (performed by the agent)

1. Open the console's Domain hints view at `/console/hints`
2. For each hint in `domain-hints.json`:
   a. Select the hint in the list
   b. Verify the test URL is populated (from `testUrls`)
   c. Click "Run test"
   d. Read the extracted output
   e. Validate against rules (see checklist below)
   f. Test UI options (Keep window open, Auto re-run)
3. Record pass/fail for each hint
4. Report results

### What "validate" means

For each hint, I read the extracted text and check:

| Check | What I look for |
|-------|----------------|
| **Content present** | Output is not empty or suspiciously short (< 50 chars) |
| **Right content** | The extracted text matches what the page actually contains (compare with the page description in `domain-hints.json` comment) |
| **No noise** | Skipped elements (nav, ads, footer, popups, sidebars) don't appear in the output |
| **Tables rendered** | If format is `table*`, tables appear as pipe-separated / JSON / CSV rows |
| **Flow steps complete** | If the hint has a flow, all labeled sections appear in the output in order |
| **Selectors matched** | No `⚠ section selector "…" matched 0 elements` warnings |
| **requireSelector applied** | No `⚠ requireSelector "…" not found` warning |
| **Formatting clean** | Markdown headings, lists, and paragraphs are readable — no raw HTML leaking through |

---

## UI options to test

### "Keep window open" checkbox

For a representative subset of hints (at least 3):

1. Enable "Keep window open" before running
2. Run the test — verify extraction succeeds
3. **Run the test again** without changing anything — verify second extraction also succeeds (same tab reused)
4. Change the test URL to a different page — verify the tab navigates and extracts the new page
5. Disable "Keep window open" — verify the tab closes

### "Auto re-run on edit" checkbox

For a representative subset of hints (at least 2):

1. Enable "Auto re-run on edit"
2. Run the test once to get a baseline result
3. Edit the hint's `comment` field (add a character)
4. Wait ~1 second — verify the result refreshes automatically
5. Edit the hint's `format` field (e.g., `text` → `readability_to_markdown`)
6. Wait ~1 second — verify the result updates to reflect the new format

---

## Hint test order

Hints are tested in file order (matching `domain-hints.json` index). The wildcard hint (index 0) is skipped — it has no `testUrls`.

### Test matrix (from `domain-hints.json`)

| # | Domain | Path | Page Type | Format | Key Feature |
|---|--------|------|-----------|--------|-------------|
| 1 | github.com | /*/* | repo | flow (wait + extract) | Turbo/React, waitForSelector |
| 2 | github.com | /*/*/issues | issues | flow | List extraction |
| 3 | github.com | /*/*/pulls | prs | flow | List extraction |
| 4 | github.com | /*/*/issues/* | issue-detail | flow (html_to_markdown) | Markdown body |
| 5 | github.com | /*/*/pull/* | pr-detail | flow (html_to_markdown) | Markdown body |
| 6 | 10.69.1.164 | / | home | readability_to_markdown | Basic extraction |
| 7 | 10.69.1.164 | /post/ | blog-post | readability_to_markdown | Semantic HTML |
| 8 | 10.69.1.164 | /profile/ | profile | flow (multi-block) | Mixed formats: text, html, list, table, table_json, table_csv, readability |
| 9 | 10.69.1.164 | /news/ (requireSelector) | news-lead | readability_to_markdown | requireSelector split |
| 10 | 10.69.1.164 | /news/ (fallback) | news-fallback | readability_to_markdown | Fallback hint |
| 11 | 10.69.1.164 | /table/ | tables | table | Pipe-separated tables |
| 12 | 10.69.1.164 | /interactive/ | interactive | flow (3 clicks) | Click steps, content_idle |
| 13 | 10.69.1.164 | /chaos/ | chaos | flow (multi-block) | Noise removal, skipSelectors |
| 14 | 10.69.1.164 | /readability-good/article/ | article-good | readability_to_markdown | Gold standard semantic |
| 15 | 10.69.1.164 | /readability-bad/article/ | article-bad | html_to_markdown + skipSelectors | Bad HTML cleanup |
| 16 | 10.69.1.164 | /spa/ | spa | readability + waitForSelector | JS-rendered content |
| 17 | 10.69.1.164 | /infinite-scroll/ | infinite-scroll | readability + waitForSelector | Dynamic content |
| 18 | 10.69.1.164 | /paywall/ | paywall | readability + skipSelectors | Paywall overlay skip |
| 19 | 10.69.1.164 | /cookie-consent/ | recipe | readability + skipSelectors + waitForContent | Cookie banner skip |
| 20 | 10.69.1.164 | /ecommerce/ | product | flow (1 click, multi-block) | Mixed formats, record fields |
| 21 | 10.69.1.164 | /social/ | social-profile | readability_to_markdown | Div-based content |
| 22 | 10.69.1.164 | /docs/ | api-docs | html + skipSelectors | Code blocks, nav skip |
| 23 | 10.69.1.164 | /reference/ | wiki | readability + content_idle + skipSelectors | Infobox, TOC skip |
| 24 | 10.69.1.164 | /video/ | video | flow (multi-block) | Player info, comment skip |
| 25 | 10.69.1.164 | /finance/ | finance | table_json | Dense financial tables |
| 26 | 10.69.1.164 | /blog/ | blog-index | readability + skipSelectors | Sidebar/popup skip |
| 27 | 10.69.1.164 | /blog/article/ | blog-article | readability + skipSelectors | Comments/related skip |
| 28 | 10.69.1.164 | /live/ | live-dashboard | readability + content_idle | Live-updating content |
| 29 | 10.69.1.164 | /lazy/ | lazy-load | readability_to_markdown | Lazy-load content |
| 30 | 10.69.1.164 | /slow/ | slow-load | readability + content_idle + waitForSelector + waitForContent | Staged loading |
| 31 | 10.69.1.164 | /redirect/ | redirect | readability + waitForSelector | Client-side redirect |
| 32 | 10.69.1.164 | /ecommerce/compare/ | compare | table_csv | CSV table format |
| 33 | 10.69.1.164 | /form/ | form | flow (type + submit) | Form interaction flow |
| 34 | 10.69.1.164 | /flow/step1/ | onboarding | flow (navigate between steps) | Multi-step wizard |
| 35 | 10.69.1.164 | /portfolio/ | portfolio | flow (multi-block) | Mixed formats |
| 36 | 10.69.1.164 | /social/thread/ | thread | readability_to_markdown | Threaded posts |
| 37 | 10.69.1.164 | /docs/tutorial/ | tutorial | html_to_markdown | Nested docs |
| 38 | 10.69.1.164 | /news/investigation/ | investigation | readability + skipSelectors | Long-form article |
| 39 | 10.69.1.164 | /404/ | error | text + postProcessor | Error page, postProcessor fallback |
| 40 | nseindia.com | /option-chain | — | flow (wait + table) | External site, dense data |
| 41 | boniface.pe | /** | — | readability_to_markdown | External portfolio site |

---

## Result tracking

For each hint, I record:

```
✅ PASS — [domain] [path] — [summary of what was extracted]
❌ FAIL — [domain] [path] — [what went wrong]
⚠️ WARN — [domain] [path] — [minor issue, still works]
```

At the end of the routine, a summary table:

```
Total: 41 hints
✅ Pass: XX
❌ Fail: XX  
⚠️ Warn: XX
```

---

## When to run this routine

- After any code change to `src/search.js`, `src/domain-hints.js`, `src/mcp-server.js`, or extraction pipeline
- After editing `domain-hints.json`
- After a container rebuild
- Before committing hint-related changes
- Periodically as a health check

---

## Scope

### In scope
- Every hint in `domain-hints.json` that has `testUrls`
- "Keep window open" checkbox tested on 3+ hints
- "Auto re-run on edit" checkbox tested on 2+ hints
- Extraction output read and validated against expected content
- Warnings and selector mismatches checked

### Out of scope
- Automated test scripts (this is a manual agent routine)
- External site regression (NSE, boniface.pe — tested but not fixable here)
- AI post-processor output validation (requires reader-lm endpoint)
- Screenshot/visual comparison

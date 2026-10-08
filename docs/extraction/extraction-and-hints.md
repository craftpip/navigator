# Extraction, Markdown, and Domain Hints

> **AI-model post-processors** (reader-lm, MinerU-HTML) run *after* the pipeline below
> on matched pages — an extractor formats the content first, then the model rewrites it.
> AI model ids are never valid extractor formats (plan 60 S4). See
> [MinerU-HTML GPU Sidecar](navigator-mineru-sidecar.md) for the GPU-backed post-processor's
> pipeline, KV-cache limits, and fallback behavior.

## Fetch Pipeline

`browserOpenAndExtract()` in `src/search.js` is the page-extraction entry point used by `web_fetch` and HTTP `/extract`.

```text
URL / ref ID
  -> load matching domain hints
  -> open direct-backend page and navigate
  -> choose matching requireSelector candidate
  -> detect bot challenge and page-state warnings
  -> serialize HTML + browser text + SEO snapshot
  -> extract text, tables, and links
  -> return structured page result
```

Hints can override the browser-free extraction from `cachedHtml`; otherwise extraction occurs from a live page. Fetch navigation waits for `domcontentloaded`, then uses configured browser timeouts, optional hint selector gates, and a stabilization strategy: `network_idle`, `content_idle`, `mutation`, or `none`.

## Text Selection Order

Interactive flows run against the live page before `extractTextFromHtml()`. That function creates a JSDOM document, removes configured noise and hint skip selectors, then uses the first applicable strategy.

1. **Readability**: parse cleaned DOM with Mozilla Readability and convert resulting HTML to Markdown. When visible browser text is substantially larger, cleaned body HTML is converted to Markdown instead to avoid dropping rendered content.
2. **Candidate blocks**: score semantic containers such as `main`, `article`, `[role=main]`, application roots, and common content classes using word count, sentence punctuation, and literal HTTP URL count.
3. **Body text**: final fallback when no usable candidate remains.

`captureSeoSnapshot()` runs in the browser before JSDOM processing. `buildSeoAnalysis()` combines that snapshot and final extraction into title, canonical URL, metadata, heading structure, candidates, and main content information.

## Markdown Conversion

`htmlToMarkdown()` in `src/markdown.js` wraps Turndown with GFM support.

- Relative links and images resolve against the source page URL.
- It removes form, script, media, and visual noise before conversion.
- Custom rules preserve tables, `details`, definition lists, quotation blocks, `sub`, `sup`, `mark`, abbreviations, and empty fragment-link behavior.
- It is used by Readability output, candidate extraction, and supported hint formats.

## Tables

Tables are extracted from the cleaned DOM by `extractTablesFromDocument()`.

- Rows and cells are expanded for `rowspan` and `colspan`.
- Multi-row headers are combined.
- Empty edge columns, presentation/navigation tables, no-data tables, and duplicate tables are removed.
- The nearest heading becomes table context.
- `insertTablesInline()` places rendered pipe tables under their related heading where possible, or appends them.

The extractor (`default.format`) decides how tables are rendered — `html_to_markdown` produces markdown tables, `readability_to_markdown` keeps what Readability keeps, and `table`/`table_json`/`table_csv` return tables-only output.

## Links and References

`extractLinksFromHtml()` resolves each useful anchor to an absolute URL, ignores anchors, JavaScript URLs, and table links, and deduplicates by URL. It carries nearest-heading context and enriches numeric anchor text from accessible metadata, image text, titles, or URL paths.

The server records each link through `rememberLink()` and rewrites in-document Markdown destinations to numeric IDs. Links remain available through `web_page_links`; they are not appended as a separate text section.

## Page State and Blocking

Live extraction checks common bot-challenge indicators before returning content. It also reports likely auth walls (for example, a password field) and image-heavy, low-text pages. These detections describe the loaded page; they are not a substitute for an authenticated browser profile.

## Domain Hint File

Hints live in `domain-hints.json` by default, or at `DOMAIN_HINTS_PATH`. `getDomainHints()` caches parsed and migrated rules by file path. `saveDomainHints()` writes atomically via a temporary file, preserves the previous contents as `.bak`, and clears the cache.

### Matching

- Host matching accepts the configured domain and subdomains.
- Paths are case-normalized with the trailing slash removed except at root.
- `*` matches within one segment; `**` may cross segments.
- Hints are tested in file order.
- A rule with `requireSelector` applies when that selector exists after navigation. If no candidate matched, matching is retried after stabilization. This lets the same domain and path hold multiple page types, with a selectorless rule acting as fallback.

### Default Extraction Hint

```json
{
  "domain": "example.com",
  "pathPattern": "/articles/**",
  "default": {
    "waitForSelector": "article",
    "stabilizeStrategy": "content_idle",
    "waitForContent": ["article"],
    "skipSelectors": [".newsletter", ".advertisement"],
    "format": "readability_to_markdown"
  }
}
```

Use a `flow` when precise selected containers or page interaction are required. Its `extract` steps carry `content.blocks`.

### Wildcard Hint (No-Hint Fallback)

Pages that match **no** domain hint get default extraction from the wildcard hint (`domain: "*"`). The wildcard hint is always present in `domain-hints.json` — the console auto-creates it with sensible defaults if missing. It cannot be deleted and appears with a "default" badge in the Domain hints editor.

Default settings: `readability_to_markdown` extractor, `network_idle` stabilization, no skip selectors, no wait gates.

The wildcard hint works the same as any other hint (format, stabilization, skip selectors, wait gates), but the `domain`/`pathPattern`/`requireSelector` fields are hidden. Both the wildcard hint and domain-specific hints can have `skipSelectors` (stacking model — both are stripped during extraction).

On first load, if `DEFAULT_EXTRACT_*` environment variables are set, their values are migrated into the wildcard hint and the env vars are no longer read.

### Flow Hint

Flows exist for pages which must be interacted with before content appears.

```json
{
  "domain": "example.com",
  "pathPattern": "/search",
  "flow": [
    { "action": "type", "selector": "input[name=q]", "text": "navigator", "submit": true, "waitForSelector": "#results" },
    { "action": "extract", "label": "Results", "content": { "blocks": [{ "selector": "#results", "priority": "high" }] } }
  ]
}
```

Allowed actions are `extract`, `click`, `wait`, `type`, and `navigate`. Validation limits a flow to eight steps and four clicks, prohibits directly adjacent interaction actions, requires at least one extraction and a final extraction, bounds per-step timeouts to 250-20,000 ms, and caps total time at 45 seconds. Click targets must resolve to one visible element.

## Hint APIs

When the web console is enabled, these APIs author hints without container restart:

| Endpoint | Behavior |
|---|---|
| `GET /console/api/hints` | Raw ordered rules, including malformed entries retained in the file |
| `POST /console/api/hints/validate` | Validate static or test-scope candidate |
| `POST /console/api/hints` | Create a validated rule |
| `PUT /console/api/hints/:index` | Replace a validated rule |
| `DELETE /console/api/hints/:index` | Delete a rule |

Writes are serialized. Exact `domain|pathPattern|requireSelector` duplicates are rejected; variants using another `requireSelector` are allowed.

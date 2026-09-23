# Search Tips

Get better results from Navigator's search.

## Use Multiple Query Variations

Different search engines rank results differently. Use 2-3 variations of your query:

```json
{
  "queries": [
    "MCP protocol specification",
    "model context protocol docs",
    "context protocol for LLMs"
  ]
}
```

This gives you broader coverage and finds results that a single query might miss.

## Be Specific

Vague queries return vague results. Be as specific as possible:

```json
// Good
{ "queries": ["Node.js 24 LTS release date April 2026"] }

// Less good
{ "queries": ["node version"] }
```

## Use `limit` for Depth

The default is 5 results per query. Increase for research tasks:

```json
{
  "queries": ["comparing React Vue Angular Svelte 2026"],
  "limit": 10
}
```

Decrease for quick lookups:

```json
{
  "queries": ["what is MCP protocol"],
  "limit": 3
}
```

## Bypass Cache for Fresh Data

For breaking news or live data, skip the cache:

```json
{
  "queries": ["latest news today"],
  "bypassCache": true
}
```

Regular queries benefit from caching — repeated identical queries return instantly.

## Combine with Extraction

Search finds pages, extraction reads them:

1. Search to discover URLs
2. Extract the best results for content
3. Answer based on what you found

```json
// Step 1: Search
{ "queries": ["React hooks tutorial 2026"], "limit": 5 }

// Step 2: Extract the best result
{ "ref_ids": [1] }

// Step 3: Your agent now has the article content
```

## Force a Specific Engine

If you know which engine works best for your query:

```json
{
  "queries": ["academic paper search"],
  "engine": "google"
}
```

Use `select_best` (default) unless you have a specific reason.

## Handle Failures Gracefully

Navigator returns partial results even when some routes fail:

```
Results:
- **...** [example.com](1)
  ...

Errors:
- mojeek: "Mojeek blocked this request"
```

Your agent can still use the successful results. Check the Errors section if results seem incomplete.

## Research Pattern

For deep research on a topic:

```json
// Broad initial search
{ "queries": ["topic overview", "topic explained", "topic guide"], "limit": 10 }

// Extract top results
{ "ref_ids": [1, 2, 3] }

// Follow-up search based on what you learned
{ "queries": ["specific subtopic found in results"], "limit": 5 }
```

## Next Steps

- [Extraction Overview](/guides/extraction/overview) — Read page content
- [Link Navigation](/guides/extraction/links) — Follow links deeper

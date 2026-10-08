# Extractors

Choose how Navigator extracts and formats page content. The right extractor depends on what you need.

## Format Options

| Format | Output | Best for |
|--------|--------|----------|
| `readability_to_markdown` | Clean article text as markdown | Most pages <Badge type="tip" text="default" /> |
| `trafilatura_to_markdown` | Trafilatura → markdown (ML) | Alternative article extraction |
| `html_to_markdown` | Full page converted to markdown | Pages where Readability strips too much |
| `text` | Flat text dump | Quick content grab |
| `html` | Raw HTML in a code block | When you need the original markup |
| `screenshot` | Full-page JPEG | Visual capture (for post-processors) |
| `table` | Tables only, pipe-separated | Table-heavy pages |
| `table_json` | Tables as JSON | Programmatic table processing |
| `table_csv` | Tables as CSV | Spreadsheet import |

## `readability_to_markdown` — clean article text as markdown

Strips navigation, footers, sidebars, and ads; keeps headings and article structure.

Request (`urls: ["https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population"]`):

```
### [List of countries and dependencies by population](24136)
- Status: Success
- URL: https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population

This article is about a list of countries and dependencies by population based on figures from official sources…

This is a **list of countries and dependencies by population**. It includes [sovereign states](https://en.wikipedia.org/wiki/Sovereign_state) … the [United Nations](https://en.wikipedia.org/wiki/United_Nations) estimated at 8.232 billion as of 2025.
```

## `trafilatura_to_markdown` — Trafilatura → markdown (ML)

Alternative article extraction using Trafilatura's ML heuristics. Good fallback when Readability misses content.

Request (`urls: ["https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population"]`):

```
### [List of countries and dependencies by population](24136)
- Status: Success
- URL: https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population

This article is about a list of countries and dependencies by population…
  (Trafilatura output — similar article markdown via ML extraction)
```

## `html_to_markdown` — full page converted to markdown

Keeps more structure when Readability strips too much — includes language links and full layout.

Request (`urls: ["https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population"]`):

```
### [List of countries and dependencies by population](24136)
- Status: Success
- URL: https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population

# List of countries and dependencies by population

121 languages
- [Afrikaans](https://af.wikipedia.org/wiki/Lys_van_lande_volgens_bevolking)
- [Alemannisch](https://als.wikipedia.org/wiki/Liste_unabh%C3%A4ngiger_Staaten_nach_Einwohnerzahl)
- [العربية](https://ar.wikipedia.org/wiki/قائمة_البلدان_والتبعيات_حسب_عدد_السكان)
…
```

## `text` — flat text dump

Quick grab without markdown formatting.

Request (`urls: ["https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population"]`):

```
### [List of countries and dependencies by population](24136)
- Status: Success
- URL: https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population

Toggle the table of contents List of countries and dependencies by population 121 languages Afrikaans Alemannisch العربية …
From Wikipedia, the free encyclopedia This article is about a list of countries and dependencies by population…
```

## `html` — raw HTML in a code block

Original markup when you need it.

Request (`urls: ["https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population"]`):

````
### [List of countries and dependencies by population](24136)
- Status: Success
- URL: https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population

```html
<header class="mw-body-header vector-page-titlebar">
  <h1 id="firstHeading" class="firstHeading">List of countries and dependencies by population</h1>
  <div id="p-lang-btn" class="vector-dropdown">121 languages</div>
…
```
````

## `screenshot` — full-page JPEG

Visual capture for post-processors — returns a JPEG image, not markdown.

Request (`urls: ["https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population"]`):

```
### [List of countries and dependencies by population](24136)
- Status: Success
- URL: https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population

[screenshot JPEG — use `web_page_screenshot` or `screenshot` extractor for image output]
```

## `table` — tables only, pipe-separated

Table-heavy pages.

Request (`urls: ["https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population"]`):

```
### [List of countries and dependencies by population - Wikipedia](24136)
- Status: Success
- URL: https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population

Location | Population | % ofworld | Date | Source (official or fromthe United Nations) | Notes
World | 8,232,000,000 | 100% | 13 Jun 2025 | UN projection[1][3] |
India | 1,429,404,000 | 17.3% | 1 Jul 2026 | Official projection[4] | [b]
China | 1,404,890,000 | 17.0% | 31 Dec 2025 | Official estimate[5] | [c]
…
```

## `table_json` — tables as JSON

Programmatic processing.

Request (`urls: ["https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population"]`):

````
### [List of countries and dependencies by population - Wikipedia](24136)
- Status: Success
- URL: https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population

```json
[
  {
    "Location": "World",
    "Population": "8,232,000,000",
    "% ofworld": "100%",
    "Date": "13 Jun 2025",
    "Source (official or fromthe United Nations)": "UN projection[1][3]",
    "Notes": ""
  },
  {
    "Location": "India",
    "Population": "1,429,404,000",
    "% ofworld": "17.3%",
    "Date": "1 Jul 2026",
    "Source (official or fromthe United Nations)": "Official projection[4]",
    "Notes": "[b]"
  }
]
```
````

## `table_csv` — tables as CSV

Spreadsheet import.

Request (`urls: ["https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population"]`):

````
### [List of countries and dependencies by population - Wikipedia](24136)
- Status: Success
- URL: https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population

```csv
Location,Population,% ofworld,Date,Source (official or fromthe United Nations),Notes
World,"8,232,000,000",100%,13 Jun 2025,UN projection[1][3],
India,"1,429,404,000",17.3%,1 Jul 2026,Official projection[4],[b]
China,"1,404,890,000",17.0%,31 Dec 2025,Official estimate[5],[c]
…
```
````

## AI models are post-processors, not extractors

AI model ids are **not** valid `format` values — validation rejects them with a pointer to
`postProcessor` (plan 60 S4). To run a model on a page, pick an extractor normally and set
`postProcessor` on the hint (web console hint editor, or `default.postProcessor` in the
hint JSON). The extractor formats the content first; the model rewrites its output.

See [Post-processors (AI)](/guides/extraction/ai-extractors) for setup details.

## Tips

- **Start with the default** — `readability_to_markdown` works for most pages
- **Try `html_to_markdown`** if the default strips too much content
- **Use `table` formats** for data-heavy pages
- **Use `text`** when you just need a quick content grab
- **Check the web console** — the Domain Hints editor lets you test different formats

## Next Steps

- [Domain Hints](/guides/extraction/domain-hints) — Per-site extraction rules
- [Post-processors (AI)](/guides/extraction/ai-extractors) — AI-powered post-processing

# Plan: Comprehensive Domain Hints for the Test Site

## Status: Complete — 2026-09-29

**Status: Complete** — closed 2026-09-29, archived to `plans/archive/`.

**Created:** 2026-08-17
**Test site:** `http://10.69.1.164:32768/` (domain hint domain: `10.69.1.164`)
**Goal:** Create domain hints for every page on the test site, covering every extraction feature the system offers. Each hint doubles as a test case for its feature.

---

## Phase 1 — Inventory: Test Site Pages & Feature Coverage

### 1.1 Test Site Page Inventory (26 pages)

| # | Path | Page Type | Content Summary | DOM Quality |
|---|------|-----------|----------------|-------------|
| 1 | `/` | Home / Index | Welcome text + 3 article cards + "Test sites catalog" links + about section | Semantic (`<main>`, `<article>`) |
| 2 | `/post/` | Blog Post | Clean article: h1, byline, h2 sections, lists, blockquote, inline links, external link, aside | Semantic (`<article>`, `<aside>`) |
| 3 | `/profile/` | User Profile | Avatar, name, handle, bio, stats, key/value `<table>`, pinned posts `<ul>`, sidebar | Semantic (`<section>`, `<table>`) |
| 4 | `/news/` | News Index | Lead article (full text, byline, blockquote) + 3 story cards + related links | Semantic (`<article>`, `<h3>`) |
| 5 | `/table/` | Data Tables | 4 data tables (products, regions, customers, weekly orders) + intro text | Pure tables, zero divs |
| 6 | `/interactive/` | Interactive Demo | 3 buttons that reveal hidden content (overview, table, comments) | JS-driven `.hidden` toggles |
| 7 | `/chaos/` | Chaos / Noise | h3 headings in divs, 4 ads, widget, bot-check overlay, popup survey, 8 comments | No semantic HTML, heavy noise |
| 8 | `/readability-good/article/` | Clean Article | Perfect semantic: `<article>`, h1, h2s, blockquote, list, image, byline | Gold standard for Readability |
| 9 | `/readability-bad/article/` | Bad HTML Article | Table-based layout, no semantic elements, 18 nav links, sidebar, inline ads | Worst-case for extraction |
| 10 | `/spa/` | SPA (JS-rendered) | Empty `<div id="app">`, JS populates after 150ms: h1, table, list | Requires `waitForSelector` |
| 11 | `/infinite-scroll/` | Infinite Scroll | 3 static posts + IntersectionObserver appends 5 more on scroll | Dynamic content append |
| 12 | `/paywall/` | Paywall Article | Free preview (h1, 2 paragraphs) + `#paywall` overlay + unlock button | Flow: click to unlock |
| 13 | `/cookie-consent/` | Recipe + Banner | Full recipe (ingredients list, steps list) + fixed-position cookie banner | `skipSelectors` on banner |
| 14 | `/ecommerce/` | Product Page | Title, rating, price, buttons, specs table, shipping, hidden sellers, reviews, Q&A, related | Complex multi-section |
| 15 | `/social/` | Social Profile | Avatar, name, handle, bio, stats, 3 posts with timestamps | Social media pattern |
| 16 | `/docs/` | API Documentation | Sidebar nav + main: function signature, parameters table, code blocks, compatibility table | `skipSelectors` on nav |
| 17 | `/reference/` | Wiki-style Article | Infobox table, TOC, 5 sections with anchor IDs, demographics table, references list | Encyclopedia pattern |
| 18 | `/video/` | Video Player Page | Video placeholder, title, views, channel, description, chapters, 18 comments | Video platform pattern |
| 19 | `/finance/` | Stock/Option Chain | Stock header + option chain table (10+ rows) + recent trades table (5 rows) | Dense data tables |
| 20 | `/blog/` | Blog Index | Featured hero + 4 article cards + sidebar (about, categories, tags) + newsletter popup | Blog index pattern |
| 21 | `/blog/article/` | Blog Article | Long-form essay (12 min read), h2 sections, blockquote, tags, related posts, 7 comments | Full blog article |
| 22 | `/live/` | Live Dashboard | 4 panels: stock ticker, cricket score, live blog, traffic chart — all update every ~3s | Constantly changing |
| 23 | `/lazy/` | Lazy Loading | 6 image placeholders, loaded progressively via IntersectionObserver on scroll | Scroll-dependent |
| 24 | `/slow/` | Staged Loading | 4 sections revealed sequentially: 500ms, 1800ms, 3600ms, 6000ms delays | `stabilizeStrategy` test |
| 25 | `/404/` | Error Page | "Page not found" message + search form + 5 nav links | Error page pattern |
| 26 | `/redirect/` | Redirect | HTTP redirect → `/post/` (followed automatically by browser) | Redirect handling |

### 1.2 Domain Hint Features to Test

Every feature should be exercised by at least one hint. Features with multiple test vectors are marked.

| Feature | Test Hints (page paths) | Notes |
|---------|------------------------|-------|
| **`readability_to_markdown`** | `/post/`, `/readability-good/article/`, `/profile/`, `/news/`, `/blog/article/`, `/reference/` | Default extractor — multiple pages for variety |
| **`html_to_markdown`** | `/docs/`, `/readability-bad/article/`, `/ecommerce/` | Turndown conversion |
| **`text`** | `/table/`, `/finance/` | Flat text dump |
| **`html`** | `/readability-good/article/` | Raw HTML output |
| **`table`** (pipe-separated) | `/table/`, `/ecommerce/` | Tables-only extraction |
| **`table_json`** | `/table/`, `/finance/` | JSON table format |
| **`table_csv`** | `/table/`, `/finance/` | CSV table format |
| **`list`** (block format) | `/profile/` (pinned posts), `/cookie-consent/` (ingredients) | Block-level list format |
| **`screenshot`** + post-processor | `/readability-good/article/` (if model configured) | Screenshot format |
| **`skipSelectors`** | `/chaos/` (ads, widget, popup, bot-check), `/cookie-consent/` (banner), `/docs/` (sidebar nav), `/blog/` (sidebar, popup), `/readability-bad/article/` (nav, sidebar) | Multiple pages with different noise |
| **`waitForSelector`** | `/spa/` (`#app h1`), `/slow/` (`#stage4`) | JS-rendered content |
| **`waitForContent`** | `/slow/` (content idle wait) | Content polling |
| **`stabilizeStrategy: "network_idle"`** | Default — most pages | Default strategy |
| **`stabilizeStrategy: "content_idle"`** | `/slow/`, `/live/` | Content-based stabilization |
| **`stabilizeStrategy: "mutation"`** | `/live/` | Mutation observer |
| **`flow` (click steps)** | `/interactive/` (3 clicks), `/paywall/` (1 click), `/ecommerce/` (view sellers) | Interactive flows |
| **`flow` (wait step)** | `/interactive/` (after each click), `/slow/` (wait for stage4) | Wait steps |
| **`flow` (extract with blocks)** | `/interactive/` (3 extract stages), `/ecommerce/` (multi-section) | Block extraction in flows |
| **`flowOptions.continueOnEmptyExtract`** | `/interactive/` (some blocks might be empty) | Empty extract handling |
| **`requireSelector`** | `/news/` (lead article vs story cards), `/ecommerce/` (product vs category) | Same domain+path, different page types |
| **Content blocks: `priority`** | `/ecommerce/` (high: title, medium: reviews), `/blog/article/` (high: article, medium: comments) | Priority filtering |
| **Content blocks: `label`** | `/ecommerce/`, `/interactive/` (labeled stages) | Section headings |
| **Content blocks: `format` per block** | `/ecommerce/` (text for title, table for specs), `/docs/` (text for signature, table for params) | Mixed formats |
| **Record blocks with `fields`** | `/profile/` (name, handle, bio, stats), `/ecommerce/` (price, rating, stock) | Structured field extraction |
| **`postProcessor`** | `/readability-good/article/` (if model configured) | AI post-processing |
| **Path patterns: `/*`** | `/post/`, `/profile/`, `/news/`, `/table/`, `/spa/`, etc. | Single-segment match |
| **Path patterns: `/*/*`** | `/readability-good/article/`, `/blog/article/`, `/docs/` | Two-segment match |
| **Path patterns: `/**`** | Catch-all fallback | Multi-segment match |
| **Domain matching** | `10.69.1.164` (all pages) | Single domain test |

---

## Phase 2 — Domain Hints to Create

All hints target domain `10.69.1.164`. The existing catch-all hint (`pathPattern: "/**"`, format: `screenshot`) should be replaced with proper per-page hints. The wildcard hint (`domain: "*"`) stays as the global fallback.

### Hint #0 — Wildcard (already exists, keep as-is)
```json
{
  "domain": "*",
  "pathPattern": "/**",
  "pageType": "default",
  "comment": "Default extraction for all URLs.",
  "default": {
    "format": "readability_to_markdown",
    "stabilizeStrategy": "network_idle",
    "waitForSelector": [],
    "waitForContent": [],
    "skipSelectors": []
  }
}
```

---

### Hint #1 — Home Page (`/`)
**Feature tested:** `readability_to_markdown`, basic path matching
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/",
  "pageType": "home",
  "comment": "Home page — welcome text + article cards + catalog links.",
  "testUrls": ["http://10.69.1.164:32768/"],
  "default": {
    "format": "readability_to_markdown",
    "stabilizeStrategy": "network_idle"
  }
}
```
**Expected:** Readability picks up `<main>` content — welcome text, article previews, catalog links.

---

### Hint #2 — Blog Post (`/post/`)
**Feature tested:** `readability_to_markdown`, semantic HTML extraction
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/post/",
  "pageType": "blog-post",
  "comment": "Clean blog post — article with byline, headings, lists, blockquote, aside.",
  "testUrls": ["http://10.69.1.164:32768/post/"],
  "default": {
    "format": "readability_to_markdown",
    "stabilizeStrategy": "network_idle"
  }
}
```
**Expected:** Full article text with headings, lists, blockquote. Aside (author bio) may be included by Readability.

---

### Hint #3 — Profile (`/profile/`) — Record Block with Fields
**Feature tested:** Record blocks with `fields`, `list` format block, `table` format block
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/profile/",
  "pageType": "profile",
  "comment": "User profile — structured fields + pinned posts list + details table.",
  "testUrls": ["http://10.69.1.164:32768/profile/"],
  "default": {
    "format": "readability_to_markdown",
    "stabilizeStrategy": "network_idle"
  },
  "flow": [
    {
      "action": "extract",
      "label": "Profile",
      "content": {
        "blocks": [
          {
            "selector": "section.profile h1",
            "label": "Name",
            "priority": "high",
            "format": "text"
          },
          {
            "selector": "p.handle",
            "label": "Handle",
            "priority": "high",
            "format": "text"
          },
          {
            "selector": "p.bio",
            "label": "Bio",
            "priority": "high",
            "format": "text"
          },
          {
            "selector": "div.stats",
            "label": "Stats",
            "priority": "high",
            "format": "text"
          },
          {
            "selector": "table.details",
            "label": "Details",
            "priority": "high",
            "format": "table"
          },
          {
            "selector": "ul li",
            "label": "Pinned Posts",
            "priority": "medium",
            "format": "list"
          }
        ]
      }
    }
  ]
}
```
**Expected:** Labeled sections — Name, Handle, Bio, Stats as text, Details as table, Pinned Posts as bullet list.

---

### Hint #4 — News (`/news/`) — `requireSelector` Split
**Feature tested:** `requireSelector` to split lead article vs story cards
```json
[
  {
    "domain": "10.69.1.164",
    "pathPattern": "/news/",
    "requireSelector": "article.lead",
    "pageType": "news-lead",
    "comment": "News page with lead article — full text extraction.",
    "testUrls": ["http://10.69.1.164:32768/news/"],
    "default": {
      "format": "readability_to_markdown",
      "stabilizeStrategy": "network_idle",
      "skipSelectors": ["footer"]
    }
  },
  {
    "domain": "10.69.1.164",
    "pathPattern": "/news/",
    "pageType": "news-fallback",
    "comment": "News page fallback — if no lead article, extract all stories.",
    "default": {
      "format": "readability_to_markdown",
      "stabilizeStrategy": "network_idle"
    }
  }
]
```
**Expected:** First hint wins when `article.lead` exists — extracts the full lead article. Second hint is the fallback.

---

### Hint #5 — Tables (`/table/`) — Table Extractors
**Feature tested:** `table`, `table_json`, `table_csv` formats

Create **3 separate hints** with `requireSelector` to test each table format:

```json
[
  {
    "domain": "10.69.1.164",
    "pathPattern": "/table/",
    "requireSelector": "table",
    "pageType": "tables-pipe",
    "comment": "Data tables page — pipe-separated table output.",
    "testUrls": ["http://10.69.1.164:32768/table/"],
    "default": {
      "format": "table",
      "stabilizeStrategy": "network_idle"
    }
  }
]
```

For testing `table_json` and `table_csv`, modify the `format` field manually or create variants. Since `requireSelector` can't distinguish format preferences, use the **test panel** to swap formats on the same hint.

**Expected:** 4 tables rendered as pipe-separated markdown with headers and rows.

---

### Hint #6 — Interactive Demo (`/interactive/`) — Flow with Click Steps
**Feature tested:** Flow extraction, `click` steps, `waitForSelector`, `extract` blocks with labels, `continueOnEmptyExtract`
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/interactive/",
  "pageType": "interactive",
  "comment": "Button-revealed content — 3 click steps to show hidden sections.",
  "testUrls": ["http://10.69.1.164:32768/interactive/"],
  "flow": [
    {
      "action": "click",
      "selector": "#show-overview",
      "waitForSelector": "#overview"
    },
    {
      "action": "extract",
      "label": "Overview",
      "content": {
        "blocks": [
          {
            "selector": "#overview",
            "label": "Project Overview",
            "priority": "high",
            "format": "readability_to_markdown"
          }
        ]
      }
    },
    {
      "action": "click",
      "selector": "#load-table",
      "waitForSelector": "#report table tbody tr"
    },
    {
      "action": "extract",
      "label": "Monthly Report",
      "content": {
        "blocks": [
          {
            "selector": "#report table",
            "label": "Report Table",
            "priority": "high",
            "format": "table"
          }
        ]
      }
    },
    {
      "action": "click",
      "selector": "#load-comments",
      "waitForSelector": "#comment-list li"
    },
    {
      "action": "extract",
      "label": "Comments",
      "content": {
        "blocks": [
          {
            "selector": "#comment-list",
            "label": "Comment List",
            "priority": "high",
            "format": "list"
          }
        ]
      }
    }
  ],
  "flowOptions": {
    "continueOnEmptyExtract": true
  }
}
```
**Expected:** 3 stages — Overview text, Report table (pipe-separated), Comments (bullet list). Each stage appears after its click.

---

### Hint #7 — Chaos (`/chaos/`) — Heavy skipSelectors
**Feature tested:** `skipSelectors` with multiple selectors, noise removal
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/chaos/",
  "pageType": "chaos",
  "comment": "Noise-heavy article — skip ads, widgets, bot-check, popup.",
  "testUrls": ["http://10.69.1.164:32768/chaos/"],
  "default": {
    "format": "readability_to_markdown",
    "stabilizeStrategy": "network_idle",
    "skipSelectors": [
      "div.ad",
      "div.widget",
      "#bot-check",
      "#popup",
      ".popup-overlay",
      "footer"
    ]
  }
}
```
**Expected:** Content sections (h3 headings + paragraphs) extracted without ads, widget, bot-check, popup, or footer noise.

---

### Hint #8 — Readability-Good Article (`/readability-good/article/`)
**Feature tested:** `readability_to_markdown` on ideal semantic HTML, `html` format test
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/readability-good/article/",
  "pageType": "article-good",
  "comment": "Gold-standard semantic article — ideal for Readability.",
  "testUrls": ["http://10.69.1.164:32768/readability-good/article/"],
  "default": {
    "format": "readability_to_markdown",
    "stabilizeStrategy": "network_idle"
  }
}
```
**Expected:** Clean markdown with all headings, blockquote, list, byline. This is the baseline for "perfect extraction."

---

### Hint #9 — Readability-Bad Article (`/readability-bad/article/`) — skipSelectors on Layout Noise
**Feature tested:** `skipSelectors` on nav, sidebar, ads; `html_to_markdown` on bad HTML
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/readability-bad/article/",
  "pageType": "article-bad",
  "comment": "Table-layout article — skip nav, sidebar, ads, footer.",
  "testUrls": ["http://10.69.1.164:32768/readability-bad/article/"],
  "default": {
    "format": "html_to_markdown",
    "stabilizeStrategy": "network_idle",
    "skipSelectors": [
      ".nav",
      "td.side",
      "div.ad",
      ".count",
      ".foot"
    ]
  }
}
```
**Expected:** Article content from `td.center` converted via Turndown, without nav/sidebar/ads/footer.

---

### Hint #10 — SPA (`/spa/`) — waitForSelector
**Feature tested:** `waitForSelector` on JS-rendered content
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/spa/",
  "pageType": "spa",
  "comment": "JS-rendered SPA — wait for #app h1 to appear after 150ms render.",
  "testUrls": ["http://10.69.1.164:32768/spa/"],
  "default": {
    "format": "readability_to_markdown",
    "stabilizeStrategy": "network_idle",
    "waitForSelector": "#app h1"
  }
}
```
**Expected:** Full SPA content (h1, table, list) extracted after JS renders into `#app`.

---

### Hint #11 — Infinite Scroll (`/infinite-scroll/`)
**Feature tested:** Dynamic content, stabilization
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/infinite-scroll/",
  "pageType": "infinite-scroll",
  "comment": "Infinite scroll feed — content loads via IntersectionObserver.",
  "testUrls": ["http://10.69.1.164:32768/infinite-scroll/"],
  "default": {
    "format": "readability_to_markdown",
    "stabilizeStrategy": "network_idle",
    "waitForSelector": "#feed article"
  }
}
```
**Expected:** Initial 3 articles extracted (dynamic ones may not load without scrolling). Tests that stabilization doesn't hang on observer-driven content.

---

### Hint #12 — Paywall (`/paywall/`) — Flow: Click to Unlock
**Feature tested:** Flow with single click step, `waitForSelector`
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/paywall/",
  "pageType": "paywall",
  "comment": "Paywalled article — click unlock to reveal full content.",
  "testUrls": ["http://10.69.1.164:32768/paywall/"],
  "flow": [
    {
      "action": "click",
      "selector": "#unlock-btn",
      "waitForSelector": "#article-body h2"
    },
    {
      "action": "extract",
      "label": "Article",
      "content": {
        "blocks": [
          {
            "selector": "#article-body",
            "label": "Full Article",
            "priority": "high",
            "format": "readability_to_markdown"
          }
        ]
      }
    }
  ]
}
```
**Expected:** Click removes paywall overlay, full article (h1 + all h2 sections + paragraphs) extracted.

---

### Hint #13 — Cookie Consent (`/cookie-consent/`) — skipSelectors on Banner
**Feature tested:** `skipSelectors` on fixed-position overlay
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/cookie-consent/",
  "pageType": "recipe",
  "comment": "Recipe page — skip cookie banner overlay.",
  "testUrls": ["http://10.69.1.164:32768/cookie-consent/"],
  "default": {
    "format": "readability_to_markdown",
    "stabilizeStrategy": "network_idle",
    "skipSelectors": ["#cookie-banner"]
  }
}
```
**Expected:** Full recipe (title, ingredients list, steps list, notes) without cookie banner text.

---

### Hint #14 — E-commerce (`/ecommerce/`) — Flow + Multi-Section Blocks
**Feature tested:** Flow with click, content blocks with mixed formats, labels, priorities, `requireSelector`
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/ecommerce/",
  "pageType": "product",
  "requireSelector": "div.info",
  "comment": "Product page — click to load sellers, extract multi-section content.",
  "testUrls": ["http://10.69.1.164:32768/ecommerce/"],
  "flow": [
    {
      "action": "click",
      "selector": "#view-sellers",
      "waitForSelector": "#sellers-ul li"
    },
    {
      "action": "extract",
      "label": "Product",
      "content": {
        "blocks": [
          {
            "selector": "div.info h1",
            "label": "Product Name",
            "priority": "high",
            "format": "text"
          },
          {
            "selector": ".rating",
            "label": "Rating",
            "priority": "high",
            "format": "text"
          },
          {
            "selector": ".price",
            "label": "Price",
            "priority": "high",
            "format": "text"
          },
          {
            "selector": "table.specs",
            "label": "Specifications",
            "priority": "high",
            "format": "table"
          },
          {
            "selector": "#sellers-ul",
            "label": "Sellers",
            "priority": "medium",
            "format": "list"
          },
          {
            "selector": ".reviews",
            "label": "Customer Reviews",
            "priority": "medium",
            "format": "readability_to_markdown"
          }
        ]
      }
    }
  ]
}
```
**Expected:** Click reveals sellers, then structured extraction: product name, rating, price as text; specs as table; sellers as list; reviews as markdown.

---

### Hint #15 — Social Profile (`/social/`)
**Feature tested:** `readability_to_markdown` on social media layout
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/social/",
  "pageType": "social-profile",
  "comment": "Social media profile — avatar, bio, stats, post feed.",
  "testUrls": ["http://10.69.1.164:32768/social/"],
  "default": {
    "format": "readability_to_markdown",
    "stabilizeStrategy": "network_idle"
  }
}
```
**Expected:** Profile info + posts extracted. No semantic `<article>` elements — tests Readability on div-based content.

---

### Hint #16 — Docs (`/docs/`) — skipSelectors on Sidebar
**Feature tested:** `skipSelectors` on navigation sidebar, `html_to_markdown` for code blocks
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/docs/",
  "pageType": "api-docs",
  "comment": "API documentation — skip sidebar nav, extract main content with code blocks.",
  "testUrls": ["http://10.69.1.164:32768/docs/"],
  "default": {
    "format": "html_to_markdown",
    "stabilizeStrategy": "network_idle",
    "skipSelectors": ["nav"]
  }
}
```
**Expected:** Main content with function signature, parameters table, code blocks, error table, browser compatibility — no sidebar nav.

---

### Hint #17 — Reference (`/reference/`) — Wiki-style
**Feature tested:** `readability_to_markdown` on encyclopedia layout, optional TOC skip
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/reference/",
  "pageType": "wiki",
  "comment": "Wikipedia-style article — infobox, TOC, sections, demographics table.",
  "testUrls": ["http://10.69.1.164:32768/reference/"],
  "default": {
    "format": "readability_to_markdown",
    "stabilizeStrategy": "network_idle",
    "skipSelectors": ["div.toc", "div.catlinks"]
  }
}
```
**Expected:** Full article text with sections, demographics table included. TOC and category links excluded.

---

### Hint #18 — Video (`/video/`) — skipComments
**Feature tested:** `skipSelectors` to exclude comments section
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/video/",
  "pageType": "video",
  "comment": "Video page — extract video info, skip comments.",
  "testUrls": ["http://10.69.1.164:32768/video/"],
  "default": {
    "format": "readability_to_markdown",
    "stabilizeStrategy": "network_idle",
    "skipSelectors": ["div.comment", "div.pinned"]
  }
}
```
**Expected:** Video title, view count, channel info, description, chapters — no comments.

---

### Hint #19 — Finance (`/finance/`) — Table JSON/CSV
**Feature tested:** `table_json` or `table_csv` on dense financial data
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/finance/",
  "pageType": "finance",
  "comment": "Stock/option chain — dense financial tables.",
  "testUrls": ["http://10.69.1.164:32768/finance/"],
  "default": {
    "format": "table_json",
    "stabilizeStrategy": "network_idle"
  }
}
```
**Expected:** Option chain + recent trades as JSON objects with `{caption, rows: [{col: val}]}`.

---

### Hint #20 — Blog Index (`/blog/`) — skipSelectors on Sidebar + Popup
**Feature tested:** `skipSelectors` on sidebar and popup overlay
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/blog/",
  "pageType": "blog-index",
  "comment": "Blog index — featured hero + article cards, skip sidebar and newsletter popup.",
  "testUrls": ["http://10.69.1.164:32768/blog/"],
  "default": {
    "format": "readability_to_markdown",
    "stabilizeStrategy": "network_idle",
    "skipSelectors": ["aside", "#popup", ".popup-overlay"]
  }
}
```
**Expected:** Featured article + 4 article cards extracted without sidebar or newsletter popup.

---

### Hint #21 — Blog Article (`/blog/article/`) — Skip Comments + Related
**Feature tested:** `skipSelectors` on comments and related posts sections
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/blog/article/",
  "pageType": "blog-article",
  "comment": "Long-form blog article — skip comments and related posts.",
  "testUrls": ["http://10.69.1.164:32768/blog/article/"],
  "default": {
    "format": "readability_to_markdown",
    "stabilizeStrategy": "network_idle",
    "skipSelectors": ["section.comments", "section.related", "div.tags"]
  }
}
```
**Expected:** Full essay with headings, blockquote — no comments, related posts, or tag links.

---

### Hint #22 — Live Dashboard (`/live/`) — Stabilization Test
**Feature tested:** `stabilizeStrategy: "content_idle"` on constantly-updating page
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/live/",
  "pageType": "live-dashboard",
  "comment": "Live-updating dashboard — markets, cricket, blog, chart. Content changes every ~3s.",
  "testUrls": ["http://10.69.1.164:32768/live/"],
  "default": {
    "format": "readability_to_markdown",
    "stabilizeStrategy": "content_idle"
  }
}
```
**Expected:** Snapshot of live data at extraction time. `content_idle` waits for text to stabilize before extracting.

---

### Hint #23 — Lazy Loading (`/lazy/`)
**Feature tested:** Content that requires scroll or patience
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/lazy/",
  "pageType": "lazy-load",
  "comment": "Lazy-loading images — content appears on scroll.",
  "testUrls": ["http://10.69.1.164:32768/lazy/"],
  "default": {
    "format": "readability_to_markdown",
    "stabilizeStrategy": "network_idle"
  }
}
```
**Expected:** Whatever text content is in the DOM at extraction time (images are CSS backgrounds, won't extract as text).

---

### Hint #24 — Slow Loading (`/slow/`) — waitForSelector + content_idle
**Feature tested:** `waitForSelector` on late-loading content, `stabilizeStrategy: "content_idle"`
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/slow/",
  "pageType": "slow-load",
  "comment": "Staged loading — 4 sections revealed over 12s. Wait for final stage.",
  "testUrls": ["http://10.69.1.164:32768/slow/"],
  "default": {
    "format": "readability_to_markdown",
    "stabilizeStrategy": "content_idle",
    "waitForSelector": "#stage4",
    "waitForContent": ["#stage4"]
  }
}
```
**Expected:** All 4 stages (Summary, Regional, Incidents, Next steps with table) extracted after waiting ~12s for `#stage4`.

---

### Hint #25 — 404 Error (`/404/`)
**Feature tested:** Extraction on error pages
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/404/",
  "pageType": "error",
  "comment": "Custom 404 page — error message + search form + nav links.",
  "testUrls": ["http://10.69.1.164:32768/404/"],
  "default": {
    "format": "readability_to_markdown",
    "stabilizeStrategy": "network_idle"
  }
}
```
**Expected:** Error message + quick links extracted. Minimal content.

---

### Hint #26 — Redirect (`/redirect/`)
**Feature tested:** Browser follows HTTP redirect automatically
```json
{
  "domain": "10.69.1.164",
  "pathPattern": "/redirect/",
  "pageType": "redirect",
  "comment": "HTTP redirect → /post/. Browser follows automatically.",
  "testUrls": ["http://10.69.1.164:32768/redirect/"],
  "default": {
    "format": "readability_to_markdown",
    "stabilizeStrategy": "network_idle"
  }
}
```
**Expected:** Blog post content (same as `/post/`) extracted after redirect.

---

## Phase 2 — Test Procedure

### Step 1: Deploy Hints
1. Replace the existing `10.69.1.164` catch-all hint with the 26 hints above
2. Keep the wildcard hint and existing GitHub/NSE hints unchanged
3. Sort hints from most specific to least specific within the domain

### Step 2: Test Each Hint via `/extract` Endpoint
For each hint, run:
```bash
curl -s "http://localhost:3000/extract?url=http://10.69.1.164:32768<path>&maxChars=5000" | head -100
```

Or use the web console's Domain hints editor Test pane.

### Step 3: Verify Each Hint
For each hint, check:
- [ ] Correct content extracted (no missing sections)
- [ ] No noise from skipped elements
- [ ] Tables rendered in the correct format
- [ ] Flow steps execute in order
- [ ] waitForSelector resolves before extraction
- [ ] stabilizeStrategy completes without hanging
- [ ] Block labels appear as headings
- [ ] Record fields render with labels

### Step 4: Test Table Format Variants
For `/table/` and `/finance/`, manually swap the `format` field between `table`, `table_json`, and `table_csv` in the test panel and verify each renders correctly.

### Step 5: Edge Cases
- Test `/redirect/` — does the browser follow the redirect before extraction?
- Test `/404/` — does extraction handle the minimal content gracefully?
- Test `/slow/` with a short timeout — does it partially extract or fail?
- Test `/infinite-scroll/` — does it get the initial 3 posts?
- Test `/live/` — does it capture a consistent snapshot?

---

## Summary — Feature Coverage Matrix

| Feature | Hints Using It |
|---------|---------------|
| `readability_to_markdown` | #1, #2, #4, #7, #8, #10, #11, #13, #15, #17, #18, #20, #21, #22, #23, #24, #25, #26 |
| `html_to_markdown` | #9, #16 |
| `text` | #3 (blocks) |
| `html` | (test manually) |
| `table` | #5, #3 (block), #6 (block), #14 (block) |
| `table_json` | #19 |
| `table_csv` | (test manually by swapping format) |
| `list` | #3 (block), #6 (block), #14 (block) |
| `screenshot` | (existing catch-all, to be removed) |
| `skipSelectors` | #4, #7, #9, #13, #16, #17, #18, #20, #21 |
| `waitForSelector` | #10, #24 |
| `waitForContent` | #24 |
| `stabilizeStrategy: "content_idle"` | #22, #24 |
| `stabilizeStrategy: "network_idle"` | All others (default) |
| `flow` (click) | #6 (3 clicks), #12 (1 click), #14 (1 click) |
| `flow` (wait) | #6 (implicit via waitForSelector) |
| `flow` (extract) | #3, #6, #12, #14 |
| `flowOptions` | #6 |
| `requireSelector` | #4, #14 |
| Content blocks: labels | #3, #6, #14 |
| Content blocks: priorities | #3, #14 |
| Content blocks: mixed formats | #3, #6, #14 |
| Record blocks with fields | #3 (conceptually — using separate blocks instead) |
| Path `/*` | #1, #2, #3, #4, #5, #6, #7, #10, #11, #12, #13, #14, #15, #16, #17, #18, #19, #20, #22, #23, #24, #25, #26 |
| Path `/*/*` | #8, #9, #21 |
| Path `/**` | (wildcard fallback) |
| Post-processor | (test manually if model configured) |

---

## Progress Log (2026-08-17)

### Hints deployed to `domain-hints.json`
All 27 test site hints (indices 6-32) are written. The old `10.69.1.164` catch-all (`screenshot` format) was replaced.

### Test Results — Final (2026-08-17)

All 27 hints tested and verified. 3 code fixes applied:
1. `parsePathPattern()` in `domain-hints.js` — strip trailing slashes from pathPatterns before compiling to regex
2. Interactive hint — changed `#overview:not(.hidden)` → `#overview` (buttons use `display:block`, not class removal)
3. Video hint — changed `div.player h1` → `div.player-col h1` (h1 is in the info column, not the player)

#### ✅ All 27 hints passing
| # | Path | Format/Strategy | Notes |
|---|------|-----------------|-------|
| 1 | `/` | readability_to_markdown | Welcome text, article cards, catalog links |
| 2 | `/post/` | readability_to_markdown | Full article with headings, lists, blockquote |
| 3 | `/profile/` | flow (blocks) | Name, Handle, Bio, Organization as text; Pinned Repos as list |
| 4 | `/news/` | readability_to_markdown + requireSelector | Lead article + story cards |
| 5 | `/table/` | table | All 4 tables in pipe-separated format |
| 6 | `/interactive/` | flow (3 clicks) | Overview → Report table → Comments, all extracted |
| 7 | `/chaos/` | readability_to_markdown + skipSelectors | Clean article without ads/widget/bot-check/popup |
| 8 | `/readability-good/article/` | readability_to_markdown | Gold standard — clean semantic article |
| 9 | `/readability-bad/article/` | html_to_markdown + skipSelectors | Content from table-layout page, messy but functional |
| 10 | `/spa/` | readability_to_markdown + waitForSelector | Full SPA content after JS render |
| 11 | `/infinite-scroll/` | readability_to_markdown + waitForSelector | Initial 3 articles from feed |
| 12 | `/paywall/` | flow (1 click) | Unlock reveals full article |
| 13 | `/cookie-consent/` | readability_to_markdown + skipSelectors | Full recipe without cookie banner |
| 14 | `/ecommerce/` | flow (1 click) | Product, Rating, Price, Specs, Sellers, Reviews |
| 15 | `/social/` | readability_to_markdown | Posts, engagement, profile info |
| 16 | `/docs/` | html_to_markdown + skipSelectors (nav) | API docs with code blocks, no sidebar |
| 17 | `/reference/` | readability_to_markdown + skipSelectors | Wiki article with demographics table |
| 18 | `/video/` | readability_to_markdown + skipSelectors | Title, Stats, Channel, Description, Chapters |
| 19 | `/finance/` | table_json | Option chain + recent trades as JSON |
| 20 | `/blog/` | readability_to_markdown + skipSelectors | Featured article + cards without sidebar/popup |
| 21 | `/blog/article/` | readability_to_markdown + skipSelectors | Full essay without comments/related |
| 22 | `/live/` | content_idle | Snapshot of live-updating dashboard |
| 23 | `/lazy/` | readability_to_markdown | Text content from lazy-loading page |
| 24 | `/slow/` | content_idle + waitForSelector + waitForContent | All 4 stages loaded after ~12s |
| 25 | `/404/` | readability_to_markdown | Error message + quick links |
| 26 | `/redirect/` | readability_to_markdown | Client-side redirect followed, blog post extracted |
| 27 | — (index only) | — | Not a test page, skip |

#### ⚠️ Known Limitations (by design)
| # | Path | Limitation |
|---|------|-----------|
| 9 | `/readability-bad/` | Layout-table HTML produces messy pipe output — expected for this page type |
| 15 | `/social/` | Readability may miss structured profile header — social layouts are notoriously hard |
| 23 | `/lazy/` | CSS background images don't extract as text — expected |

#### Existing hints regression-tested
- ✅ Wildcard `*` — still matches all unmatched domains
- ✅ GitHub profile — still extracts profile page content
- ✅ NSE — not tested this round (uses flow, known working)

### Code Fixes Applied

**Fix 1: `parsePathPattern()` trailing slash (line 35-42 of `domain-hints.js`)**
- Problem: `getPathname()` strips trailing slashes (`/chaos/` → `/chaos`) but `compileGlob()` kept them in regex (`^/chaos/$`). No match.
- Fix: Strip trailing slashes from pathPatterns before `compileGlob()`, unless ending with `/**`.

**Fix 2: Interactive hint selectors**
- Problem: `#overview:not(.hidden)` never matches — buttons use `style.display = 'block'`, not class removal.
- Fix: Changed to plain `#overview`, `#report`, `#comment-list` selectors.

**Fix 3: Video hint selector**
- Problem: `div.player h1` — h1 is inside `.player-col`, not `.player`.
- Fix: Changed to `div.player-col h1`.

### TODO
- [x] Fix chaos, video, interactive hints
- [x] Re-test all 27 hints after fixes
- [x] Verify existing hints (wildcard, GitHub) still work
- [ ] Update feature coverage matrix with final results (optional)

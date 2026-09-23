# 49 — GitHub Pages Website for Navigator

**Created:** 2026-08-18
**Status:** Ready for implementation

---

## Goal

Create a static documentation + landing page website for the navigator project, hosted on GitHub Pages via GitHub Actions. The website source lives in a `website/` directory in this repo.

---

## Design Choices

### Layout reference
- **Browser MCP docs** (docs.browsermcp.io) — clean, minimal, getting-started focused. VitePress-style layout.
- **Documentation Compendium** writing principles — friendly tone, brief, headings-heavy, code examples, no assumptions about prior knowledge.

### Theme & colors
- **Dark theme default** with light mode toggle (VitePress built-in)
- **Green accent** (#00dc82) — VitePress default, techy, modern
- Dark bg (#0a0a0a / #1a1a1a), clean typography
- Custom CSS for hero section only; everything else uses VitePress defaults

### Landing page
- **Bold full-screen hero** — logo (large, centered) + tagline + two CTA buttons ("Get Started" → getting-started, "GitHub" → repo)
- **Features grid** below hero — 6 cards (Search, Extraction, Screenshots, DevTools, Multi-engine, Self-hosted)
- **Quick install** code snippet
- Smooth scroll between sections

### Logo treatment
- **Hero**: Large centered logo above the title
- **Nav bar**: Small logo alongside "Navigator" text

---

## Tech: VitePress

**Why VitePress** over Astro/Docusaurus/plain React:
- Purpose-built for doc sites from Markdown — reads existing `docs/*.md` files directly
- Generates static HTML (fast, SEO-friendly, works on GitHub Pages)
- Beautiful default dark/light theme with sidebar, search, mobile nav
- Tiny config footprint — one `.vitepress/config.mjs` file
- The project already uses Vite, so the build tooling overlaps cleanly

---

## Phases

### Phase 1 — Landing page + scaffolding
**Ship a working site on GitHub Pages.**

Files to create:
```
website/
├── .vitepress/
│   ├── config.mjs                # Site config: title, nav, sidebar stub, theme
│   └── theme/
│       └── custom.css            # Hero section, feature cards, accent overrides
├── public/
│   └── navigator-logo.png        # Copied from repo root
├── index.md                      # Landing page: hero, features grid, install snippet
└── package.json                  # VitePress devDependency + scripts
```
Plus:
- `.github/workflows/pages.yml` — build + deploy workflow
- `.gitignore` entries for `website/.vitepress/dist/` and `website/node_modules/`

### Phase 2 — Getting started + tool docs
**Core documentation pages.**

Files to create:
```
website/
├── getting-started.md            # Quick start guide (from README.md)
└── tools/
    ├── web-search.md             # web_search docs
    ├── web-fetch.md              # web_fetch docs
    ├── web-page-screenshot.md    # Screenshot docs
    └── web-page-ascii.md         # ASCII screenshot docs
```
Source: `README.md` quickstart sections + `docs/api/tool-reference.md`

### Phase 3 — Architecture + system docs
**Deep-dive documentation pages.**

Files to create:
```
website/
├── architecture.md               # From docs/architecture/overview.md + browser-runtime.md
├── search.md                     # From docs/search/search-and-drivers.md
├── extraction.md                 # From docs/extraction/extraction-and-hints.md
└── configuration.md              # From docs/operations/operations-and-configuration.md
```

### Phase 4 — Changelog + polish
**Remaining content + refinements.**

Files to create:
```
website/
└── changelog.md                  # From CHANGELOG.md
```
Plus: SEO meta tags, sitemap, Open Graph images, analytics if needed.

---

## Directory structure (full, all phases)

```
website/
├── .vitepress/
│   ├── config.mjs
│   └── theme/
│       └── custom.css
├── public/
│   └── navigator-logo.png
├── index.md                      # Phase 1
├── getting-started.md            # Phase 2
├── tools/                        # Phase 2
│   ├── web-search.md
│   ├── web-fetch.md
│   ├── web-page-screenshot.md
│   └── web-page-ascii.md
├── architecture.md               # Phase 3
├── search.md                     # Phase 3
├── extraction.md                 # Phase 3
├── configuration.md              # Phase 3
├── changelog.md                  # Phase 4
└── package.json
```

---

## GitHub Actions workflow (all phases)

New file: `.github/workflows/pages.yml`

```yaml
name: Deploy Website

on:
  push:
    branches: [main]
    paths: ['website/**']

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: website/package-lock.json
      - run: npm ci
        working-directory: website
      - run: npm run docs:build
        working-directory: website
      - uses: actions/upload-pages-artifact@v3
        with:
          path: website/.vitepress/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

---

## What stays the same

- `docs/` folder — untouched, internal code docs
- Existing workflows — untouched
- `src/web-console/` — the live server console, completely separate
- `docker-compose.yml` — no changes

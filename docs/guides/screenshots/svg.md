# SVG Renders <Badge type="danger" text="Disabled by default" />

`web_page_svg` captures a webpage as a structured vector image — every element is a filled `<rect>` (real background, border, and radius) plus `<text>` laid out with the page's own font metrics, and `<image href>` for `img`/`canvas` content. The SVG looks like the screenshot and doubles as a layout database via `data-*` attributes.

> **Disabled by default** — remove `web_page_svg` from `DISABLE_TOOLS` in `.env` / Configs ([http://localhost:1994/console/manage](http://localhost:1994/console/manage)) and restart (`docker compose up -d`) to enable. When disabled the tool is hidden from `tools/list` and returns `Tool "web_page_svg" is disabled`.

## Flow

```
URL ──→│ Browser → DOM capture → Style → Text layout → SVG builder │──→ User
       └──────────────────────────────────────────────────────────┘
              rect geometry + data-* + <text>/<image> + viewBox = page size
```

The browser renders the page, the extractor captures geometry and computed styles, the builder assembles a faithful SVG. `viewBox` equals the page size, so coordinates are document-relative CSS pixels.

## Request

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `urls` | `string[]` | — | One or more URLs |
| `ref_ids` | `number[]` | — | Refs from `web_search` |
| `targetId` | `string` | — | Existing `Target.createTarget` tab — snapshots live JS state |
| `fullPage` | `boolean` | `false` | `false` = viewport only, `true` = full scrollable document |
| `elementLimit` | `number` | `100` (api default) / `5000` (tool max) | Max elements in the SVG (1–5000) |
| `viewport` | `object` | — | `{ width, height }` — `fullPage:true` → only `width` matters; `fullPage:false` → both |
| `includeSelector` | `boolean` | `true` | Emit `data-selector` on each `<g>` |
| `includeXpath` | `boolean` | `true` | Emit `data-xpath` on each `<g>` |
| `hybrid` | `boolean` | `false` | `true` = add `<foreignObject>` with inlined HTML for pixel-perfect visuals behind the `data-*` geometry |
| `output` | `string` | `inline` | `inline` = markdown ` ```svg` block, `file` = save to `screenshots/*.svg`, `url` = download URL |

`elementLimit` is the strongest size knob — the console page at `fullPage:true` is ~235 KB at the default limit.

## Response

With `output: "inline"` (default), the tool returns a markdown fence:

````md
```svg
<?xml version="1.0" encoding="UTF-8"?>
<svg width="1920" height="3343" viewBox="0 0 1920 3343" ...>
  <g data-tag="header" data-kind="container" data-x="0" data-y="0" data-width="1920" data-height="64"
     data-selector="header.site-header" data-xpath="/html[1]/body[1]/header[1]">
    <rect x="0" y="0" width="1920" height="64" rx="0" fill="#0f1115"/>
    <text x="24" y="38" font-family="Inter, monospace" font-size="16" fill="#f0f0f0">Navigator</text>
  </g>
  ...
</svg>
```
````

The SVG is also rendered inline in the console tools view with a **Download SVG** button (slugified from `data-page-title`).

`output: "file"` and `output: "url"` behave like `web_page_screenshot` — they require `ENABLE_SCREENSHOT_PATH` / `ENABLE_SCREENSHOT_DOWNLOAD_LINK` and write to `screenshots/*.svg`.

## What Gets Captured

Each `<g>` carries:

- `data-tag`, `data-kind`, `data-x/y/width/height`, `data-z`, `data-visible`
- `data-selector`, `data-xpath` (when enabled)
- Content: `data-href`/`data-src`/`data-alt` for links and media
- Style: `data-box-shadow`, `data-bg-image`, `data-transform`, etc. (only when that property exists)
- Geometry: `<rect x/y/width/height rx>` with real `fill`/`stroke`, `<text x/y>` with real `font-size/color/weight/style`, `<image href>` for `img`/`canvas` (capped ~180 KB), `<clipPath>` for `overflow:hidden` and rounded media.

Text layout is computed at build time via per-glyph em-bucket measurement — `wrap`/`ellipsis`/`line-clamp` are resolved before emitting, and per-word browser Range rects pin positions for `letterSpacing`/CJK.

## Examples

### Single page, full document

```json
{
  "urls": ["https://example.com"],
  "fullPage": true
}
```

### Live tab (after interaction)

```json
{
  "targetId": "abc123",
  "fullPage": true,
  "elementLimit": 250
}
```

### Minimal geometry (smaller file)

```json
{
  "urls": ["https://example.com"],
  "includeSelector": false,
  "includeXpath": false
}
```

## Screenshot vs ASCII vs SVG

| Tool | Output | Geometry | Best for |
|------|--------|----------|----------|
| `web_page_screenshot` | JPEG (pixels) | None | Visual verification |
| `web_page_ascii` | ANSI half-blocks + legend | Selectors + x/y via legend | Terminal layout overview |
| `web_page_svg` | Vector SVG (`<rect>` + `<text>` + `data-*`) | Full `data-x/y/width/height` + `selector`/`xpath` on every `<g>` | Agent layout math without decoding pixels |

SVG size scales with element count × metadata. Dense dashboards are larger than their JPEG; content pages are typically smaller.

## Tips

- Use `targetId` to snapshot a tab after you have interacted with it via DevTools — the SVG reflects the live DOM.
- Lower `elementLimit` for large pages if you only need above-the-fold geometry.
- Set `includeSelector: false` / `includeXpath: false` for a compact visual-only SVG.
- Pair with `web_fetch` — SVG for where things are, fetch for what the text says — or use the Download button in the console tools view.

## Next Steps

- [Screenshot Overview](/guides/screenshots/overview) — JPEG screenshots
- [ASCII Renders](/guides/screenshots/ascii) — Terminal renders
- [Output Options](/guides/screenshots/output) — File and URL output

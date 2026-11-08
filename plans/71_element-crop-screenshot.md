# 71 — `web_page_screenshot_crop` (element / region screenshot)

**Status:** In progress — implementation complete (committed 2026-10-09), live MCP verification pending
**Priority:** Normal
**Created:** 2026-10-05

> Note (2026-10-09): this plan carried `[x]` items and a `## Done` entry in
> `infinite.md` before the code actually existed — `src/crop.js` did not exist,
> the dispatch was a stub, and calling the tool returned a full-page ~1.8MB JPEG
> (targetId) or "No screenshot data available" (urls/region). The work below
> re-implements it for real. Status stays "In progress" until the live MCP check.

## 1. Goal

A new MCP tool that returns a **cropped** screenshot — of one element, or of an
explicit rectangle — instead of the whole page. The LLM picks the target by CSS
selector or XPath, and controls how much padding surrounds the crop.

Existing `web_page_screenshot` (whole page / viewport) and the devtools
`browser_web_page_screenshot` are **unchanged**. This is a third, separate tool.

## 2. Tool Surface

```json
{
  "name": "web_page_screenshot_crop",
  "description": "Screenshot a specific element or a specific rectangle of a page, with optional padding around it. Returns a cropped JPEG instead of the whole page. Provide a target (targetId, urls, or ref_ids) plus a crop: either selector/xpath, or an explicit region {x,y,width,height}.",
  "inputSchema": {
    "target":  "targetId | urls | ref_ids   (same convention as web_page_screenshot)",
    "crop":    "selector | xpath | region",
    "padding": "number, default 0",
    "quality": "low | medium | high, default medium",
    "output":  "base64 | file | url (same gating as web_page_screenshot)",
    "browser": "same as web_page_screenshot",
    "viewport":"same as web_page_screenshot"
  }
}
```

Proposed params:

| Param | Type | Default | Notes |
|---|---|---|---|
| `targetId` | string | — | screenshot an existing tab instead of opening one |
| `urls` / `ref_ids` | string[] / number[] | — | open fresh, same as `web_page_screenshot` |
| `selector` | string | — | CSS selector for the element to crop |
| `xpath` | string | — | XPath alternative to `selector` |
| `region` | `{x,y,width,height}` | — | explicit rectangle, **document CSS pixels** (page space, not viewport) |
| `padding` | number | `0` | CSS px added on all four sides of the resolved rect |
| `quality` | `"low"\|"medium"\|"high"` | `medium` | same presets (30/55/75) as `web_page_screenshot` |
| `output` | `"base64"\|"file"\|"url"` | `base64` | same server-config gating |
| `browser` | string | — | same description text |
| `viewport` | `{width,height}` | — | same as `web_page_screenshot`, so layout matches a full-page shot |

Exactly one crop form must be present: `selector`, `xpath`, **or** `region`.
No `fullPage` param — a crop is inherently a rect.

## 3. Behaviour

1. Resolve the page (`targetId` → existing tab; `urls`/`ref_ids` → open, apply
   `viewport`, `goto`, `waitForContent`).
2. Resolve the crop rect **in page coordinates**:
   - `selector`/`xpath` → `document.querySelector` / `document.evaluate` →
     `getBoundingClientRect()` + `window.scrollX/scrollY`.
   - `region` → used as given.
3. Expand by `padding` on all sides, then **clamp** to
   `[0, scrollWidth] × [0, scrollHeight]`.
4. Capture with `page.screenshot({ clip, captureBeyondViewport: true })` so an
   element below the fold (or taller than the viewport) still captures in place —
   no scrolling, no layout shift.
5. Reuse `storeScreenshotDownload()` for `file`/`url` output, and the existing
   JPEG quality preset map.

### Response must report what was actually captured

```
### <title> — cropped screenshot
- Page: <title> (<url>)
- Crop: selector "#main .card:nth-child(2)" → matched 1 of 3 elements (first match)
- Rect: 120,340 640x480  (document CSS px)
- Padding: 8px applied on all sides → final 104,332 656x496
- Clamped: left edge 0 (requested -8)
- Output: 41 KB jpeg (quality medium/55)
```

Reporting the **padding actually used** and the final rect is a hard requirement —
the LLM must be able to see whether its padding request was honoured or clipped.

### Edge cases

| Case | Behaviour |
|---|---|
| `selector`/`xpath` matches nothing | error, message includes candidate visible elements (same shape as `DOM.querySelector`) |
| matches several | first match, report `matched N of M` |
| element has zero area (`display:none`, collapsed) | error naming the selector and the zero rect |
| requested rect outside page bounds | clamp, report which edges were clamped |
| both `selector` and `region`, or neither | reject with a message naming the three crop forms |
| `region` width or height ≤ 0 | reject |
| element taller than the viewport | `captureBeyondViewport` handles it; no special case |
| ephemeral `urls` path | same bot-check + `waitForContent(5000)` as `web_page_screenshot` |

## 4. Work

- [x] 1. **Tool schema** — add the `web_page_screenshot_crop` block to
      `getToolsListResponse()` in `src/mcp-server.js`, next to `web_page_screenshot`.
      Add the name to `WEB_TOOL_NAMES` (`:104`) so it shows in the console's error
      banner and `/stats` by-tool counters, and to the `isPage` list at `:1380` so
      activity rows label it by browser.
- [x] 2. **Capture logic** (minimal) — new exported function in `src/search.js` beside
      `browserCaptureScreenshot` (`:2729`), e.g. `browserCaptureCropScreenshot`.
      Resolve target → resolve rect → clamp → `page.screenshot` with clip.
      Bump `activityCounters.screenshots` and `recordPageOpStart` like the existing one.
- [x] 3. **Dispatch** — a `name === "web_page_screenshot_crop"` branch in
      `handleToolCall()` (`src/mcp-server.js`, next to `:2785`), supporting the
      single-`targetId` path and the `urls`/`ref_ids` batch path (cap 10 per call),
      with the response block from §3.
- [x] 4. **Tests** — `tests/mcp-server.test.js`: schema shape (present in
      `tools/list`, `additionalProperties:false`), reject-without-crop, reject-two-crops,
      region validation. Unit-test the pure helpers (rect expansion, clamping to page
      bounds, zero-area rejection) by exporting them from a small module rather than
      testing through a live browser.
- [x] 5. **Docs** — `AGENTS.md` Tool Contract section, `README.md` tool table +
      section, `docs/api/tool-reference.md`. Rebuild docs and confirm `/docs/` → 200.

## 5. Testing

- [x] Unit: rect expansion + clamping + validation matrix (no browser) —
      `tests/crop.test.js` (27 tests: parseCropArgs, isValidCropRect,
      expandAndClampRect, resolveCropRectInPage via jsdom with stubbed
      `getBoundingClientRect` reading a `data-rect` attribute).
- [x] `npx vitest run` — full suite, no new failures vs the documented baseline
      (878 passed / 3 pre-existing failures: config `prompt` field + 2 svg tests;
      +35 new crop tests all pass; lint back to the 70 baseline).
- [x] `npm run lint`.
- [ ] Live through MCP, as a consumer would:
      `web_page_screenshot_crop(selector: "h1")` on a real page; on a below-the-fold
      element; with `padding: 16`; with `region`; against a nonexistent selector
      (error must name candidates); `output: "file"`. Requires `docker restart navigator`.
- [ ] Visual check that the crop rect matches `web_page_screenshot` of the same page
      (same `viewport`, so offsets are comparable).

## 6. Decisions Made Where the Spec Was Silent

- **Padding defaults to `0`** — no padding unless the LLM asks. Exposed as a param
  (user: "no padding … give that option to the LLM also").
- **`region` is document CSS pixels**, not viewport — the only space that works for
  below-the-fold regions and matches Puppeteer's `clip`.
- **First match wins** on a multi-match selector, with the count reported.
- **Both `selector` and `xpath`** accepted (matches the DOM tools' convention).
- **No `fullPage`** — the crop *is* the frame.
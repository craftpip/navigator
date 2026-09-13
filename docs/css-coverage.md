# CSS Coverage — SVG Fidelity

Generated 2026-08-22 17:25 via `page.evaluate(getComputedStyle)` on `http://localhost:1994/` (1920×947, 60 visible els, 443 total props).

## Summary
- Captured today (`extractor.js:91` + `dom-snapshot.js:72`): ~34 props
- High-impact missing (non-default, affects pixels): ~18 props
- Layout-only (already via `getBoundingClientRect`): flex/grid/gap/align/justify etc — no SVG rendering needed

## Missing Visual Props — Priority

| Priority | Prop | Hits/40 | Sample (console) | SVG mapping | Status |
|---|---|---|---|---|---|
| P0 | `text-decoration-line/color/style/thickness` | 40 | `none` default, but links have `underline rgb(66,133,244)` | `<line>`/`<text text-decoration>` | TODO |
| P0 | `transform-origin` | 40 | `960px 10px`, `50% 50%` | `transformOrigin` attr | TODO |
| P0 | `vertical-align` | 40 | `middle`, `baseline` | `dominant-baseline`/`alignment-baseline` | TODO |
| P0 | `object-fit/position` | 40 | `cover`, `50% 50%` (img/canvas) | `preserveAspectRatio` | TODO |
| P0 | `outline-offset` | 8 | `2px` | extra `<rect stroke>` offset | TODO |
| P0 | `border-*-radius` per-corner (already `borderRadius` shorthand) | 10 | `8px` | `parseRadii` separate → `<path>` `src/svg/style.js:32` | DONE (shorthand covers, but per-corner extract needed) |
| P0 | `overflow-wrap/word-break` | 5 | `normal`/`break-word` | wrap engine `src/svg/text.js` | TODO |
| P0 | `text-transform` | 4 | `uppercase` on headers | `textTransform` | TODO |
| P1 | `clip-path` | 40 (default `none`) but modals use | `none` | `<clipPath>` | TODO |
| P1 | `mask*` (clip/mode/origin/position) | 40 | `border-box` | `<mask>` | TODO |
| P1 | `mix-blend-mode/isolation` | 40 | `normal`/`auto` | `mix-blend-mode` CSS → `style` | TODO |
| P1 | `stroke/fill` for inline SVG | 40 | `rgb(0,0,0)` | `fill`/`stroke` | TODO (for `<svg>` children) |
| P2 | `border-image` | 40 | `stretch` | ignore (rare) | DEFER |
| P2 | `list-style` | low | `disc outside` | `::marker` | DEFER |

Layout-only (ignore): `flex-*`, `grid-*`, `gap`, `align-*`, `justify-*`, `display`, `position`, `width/height` (via rect), `margin/padding` (via rect), `box-sizing`.

## Next — Phase 1
Implement P0 in `computedStyleSvg` + `dom-snapshot` + `style.js` parsers + `builder.js` rendering. See `plans/37_svg-screenshot.md §14.7`.

Validation: fixture `tests/fixtures/css-text-deco.html` etc → `buildSvg` contains `<line>`/filter + `svg-diff <2%`.

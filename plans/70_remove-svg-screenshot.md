# 70 — Disable the SVG Screenshot Feature (`web_page_svg`)

**Status:** Proposed — 0/2 items done
**Priority:** Normal
**Created:** 2026-10-05

## 1. Goal

Discontinue `web_page_svg` — the same way `web_page_ascii` and
`DOM.getCompactHTML` were discontinued: add the name to `DISABLE_TOOLS` in `.env`.
The tool disappears from `tools/list` and calls to it are rejected. **Code stays.**

## 2. Work

- [ ] 1. Add `web_page_svg` to `DISABLE_TOOLS` in `.env:15` →
      `DISABLE_TOOLS=web_page_ascii,DOM.getCompactHTML,web_page_svg`
- [ ] 2. Recreate the container (`docker compose up -d` — the env var is read once at
      config load, `src/config.js:505`) and verify: `tools/list` no longer advertises
      `web_page_svg`, and a `tools/call` for it returns "Tool \"web_page_svg\" is
      disabled (listed in DISABLE_TOOLS)" (`src/mcp-server.js:2531`).

## 3. Not Doing

- No code deletion. `src/svg/`, `src/svg-diff.js`, `scripts/svg-diff.mjs`,
  `tests/svg.test.js`, the `svg-preview` console renderer, the docs page and the
  `web_page_svg` Tool Contract block in `AGENTS.md` all stay as they are.
- No commit unless asked.
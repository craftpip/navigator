# Browsers Overview

Every Navigator tool runs inside a real browser — `web_search`, `web_fetch`, screenshots, SVG renders, and the interactive devtools. The `BROWSERS` array decides **which** browsers Navigator can use and **what each one is for**. You manage it in the web console (**Manage → Browsers**: "+ Add browser") or in `.env`.

There are three ways to supply a browser to Navigator:

| Entry `type` | What it is | Who runs it | Ownership |
|---|---|---|---|
| `inbuilt` | The built-in Chromium launched by Navigator itself | Navigator | `agent` |
| `cdp` | Any external browser you point Navigator at via a CDP address (`ws://…` or `http://…`) | You — e.g. a CloakBrowser or Lightpanda sidecar | `agent` |
| `navigator-cdp` | The browser-relay extensions — a real Chrome/Firefox on your machine that dials in and pairs with Navigator | The extension dials Navigator's `/relay` | `user` |

## The default browser — built-in Chromium

Navigator always has one browser it owns and launches itself: **Chromium**, via Puppeteer. It is:

- **Always present** — even if you do not list it in `BROWSERS`, Navigator appends it as the final fallback.
- **Self-healing** — if it crashes or its idle page is closed, the next call relaunches it.
- **Full rendering** — JavaScript, CSS, screenshots, SVG all work as expected.
- **The search engine browser** — all `web_search` routes run on the built-in Chromium; search engines never use add-on browsers.

It is the safe default: no external dependencies, nothing to configure beyond the optional Chromium profile variables (see [Environment Variables](/guides/self-hosting/env-vars)).

## External browsers (CDP add-ons)

A `cdp` entry connects Navigator to a browser that is already running and exposing the Chrome DevTools Protocol:

- `ws://host:port` — a direct browser WebSocket endpoint (e.g. Lightpanda's `serve`).
- `http://host:port` — a CDP server / multiplexer (e.g. CloakBrowser's `cloakserve`).

Navigator connects lazily and reuses the connection; it never launches or closes these processes — **you own the sidecar**. Use them for anti-bot browsing, fast/lightweight extraction, or any specialized browser you already run.

- [External CDP Browsers](/guides/browsers/cdp-addons) — the user guide
- [Reference: External CDP](/reference/browsers/external-cdp) — endpoint forms, launch flags, `/json/version`

## The browser-relay extensions

A `navigator-cdp` entry is the reverse: a browser-relay extension installed in a **real user browser** dials **into** Navigator's relay endpoint (`/relay`), gets paired with a one-time PIN, and lets Navigator drive that visible browser. Ownership is `user` — it is the user's real, visible, non-headless window, and everything Navigator does there appears on screen.

Two extensions exist:

- [Chrome Extension](/guides/browsers/chrome-extension) — via `chrome.debugger` (true CDP).
- [Firefox Extension](/guides/browsers/firefox-extension) — via Firefox's WebDriver BiDi, mapped to CDP in the extension.

Both speak the same [relay protocol](/reference/browsers/extensions) — the server side needed zero changes for Firefox.

## The `BROWSERS` array

A compact example — every entry needs a unique `name` and the `role`s it should serve:

```json
[
  { "name": "chromium", "role": [], "type": "inbuilt" },
  {
    "name": "cloakbrowser",
    "role": ["default", "fetch", "screenshot", "devtools"],
    "type": "cdp",
    "cdpUrl": "http://cloak-browser:9222"
  }
]
```

The full field table — `type` defaults, `cdpUrl` requirements per type, `plugin`, `prompt`, role semantics — is the [`BROWSERS` Configuration Reference](/reference/browsers/browser-array). The console editor normalizes entries for you (a type-less entry becomes `cdp`, `plugin` defaults to `auto`).

## How routing works

1. **Array order is the rollback chain.** For a call without an explicit browser, the add-ons are tried in `BROWSERS` order — the first connected one that carries the needed role serves the call; each down add-on is reported in `rollbackNotes` and the chain moves on.
2. **Explicit `browser` parameter is strict.** Naming a browser that is down or lacks the required role is an error — no silent re-routing.
3. **Chromium is the last resort.** If no add-on serves the call (or none is connected), the built-in Chromium handles it.
4. **Roles gate the call.** Devtools tools require a browser carrying `devtools` (or `default`); page tools get whichever connected add-on covers their role first.

## Ownership — `user` vs `agent`

`list_browsers` and `Target.getTargets` label every browser:

- **`user`** (`navigator-cdp`) — a real, visible browser window on the user's machine. Tabs, clicks, and navigation happen on the user's screen; drive with care (the user may be mid-use). Navigator never closes these tabs — closing an adopted tab only releases Navigator's handle.
- **`agent`** (Chromium + `cdp` add-ons) — Navigator-owned, headless/invisible. Safe to drive freely.

## The `Browser drivers` panel

The console's **Status** page lists every configured browser in one panel, and each row can expand to show the tabs it currently holds.

- **A row is only expandable when the browser is online *and* has at least one tab.** Rows with nothing to show are not clickable and carry no chevron — there is no dead disclosure control to hunt for.
- **Expansion is per browser and per session.** Each row remembers its own state, and the console's 2-second poll never collapses a row you just opened.
- **The chevron is the affordance:** `▸` collapsed, `▾` expanded. The row's own click area is the large title region, not just the glyph.
- **Other controls are never swallowed.** `Forget`, `Edit…` and `Copy endpoint` sit outside the toggle, so a misclick on them does not expand the row — and a relay browser awaiting a PIN keeps that prompt visible regardless of tab state.
- Tabs within a row animate open/closed, and the animation is disabled under `prefers-reduced-motion`.

State is in-memory only: a page reload returns every row to collapsed. No `localStorage` is involved.

## Sharing a browser externally

Because Navigator *runs* these browsers, it can also hand an authenticated CDP entry point to **external** tooling — `puppeteer.connect`, `chrome-remote-interface`, anything that speaks CDP — scoped per API key, BrowserStack-style. See [CDP Sharing](/guides/browsers/cdp-sharing) and its [technical reference](/reference/browsers/cdp-sharing).

## Config sources

- `.env` in the repo root (`BROWSERS='[…]'`) — or edit it live in the console.
- Config edits **hot-reload** — no container restart needed.
- See [Environment Variables → Browser Array](/guides/self-hosting/env-vars) for the field table and defaults.

## Next Steps

- [External CDP Browsers](/guides/browsers/cdp-addons) — connect CloakBrowser, Lightpanda, or any CDP endpoint
- [Chrome Extension](/guides/browsers/chrome-extension) — drive your real Chrome
- [Firefox Extension](/guides/browsers/firefox-extension) — drive your real Firefox
- [CDP Sharing](/guides/browsers/cdp-sharing) — share a browser with external tools
- [DevTools Overview](/guides/devtools/overview) — the tools that target these browsers
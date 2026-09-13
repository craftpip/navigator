# `BROWSERS` Configuration Reference

The `BROWSERS` array is the single place that defines which browsers Navigator may use and what each one is for. It is a JSON array read from the `.env` file (`BROWSERS='[…]'`) or edited live in the web console (**Manage → Browsers**). Edits hot-reload — no container restart needed.

## JSON shape

```json
[
  { "name": "chromium", "role": [], "type": "inbuilt" },
  {
    "name": "cloakbrowser",
    "role": ["default", "fetch", "screenshot", "devtools"],
    "type": "cdp",
    "cdpUrl": "http://cloak-browser:9222",
    "plugin": "auto",
    "prompt": "Optional agent-facing description"
  }
]
```

| Field | Values | Description |
|-------|--------|-------------|
| `name` | string (unique) | Routes tools via the `browser` parameter. Also the relay paired name for `navigator-cdp` entries |
| `role` | `default` · `search` · `fetch` · `screenshot` · `devtools` | Which tools the browser serves. `default` = everything. An **empty array** marks a fallback/backup-only entry |
| `type` | `inbuilt` · `cdp` · `navigator-cdp` | How the browser is supplied. Omitted → `inbuilt` for `chromium`, `cdp` for anything else |
| `cdpUrl` | URL | Required for `cdp`-type entries (`http://…` browserURL or `ws://…` browserWSEndpoint). Must be **absent** for `inbuilt` and `navigator-cdp` — relay entries dial Navigator, Navigator provides the endpoint |
| `plugin` | `auto` · `chrome` · `firefox` | Relay extension kind — `navigator-cdp` only. `auto` infers the platform from the live connection |
| `prompt` | string | Optional agent-facing instruction shown in `list_browsers` (add-ons only) |

The console `BrowserArrayEditor` normalizes on save: an entry named `chromium` becomes `inbuilt`, a type-less entry becomes `cdp`, `plugin` defaults to `auto`, and `role` to `[]` — you can edit JSON directly, but the form writes canonical entries.

## Entry types

| `type` | What it is | Who runs it | Ownership |
|---|---|---|---|
| `inbuilt` | The built-in Chromium launched by Navigator itself (Puppeteer). Always present as the final fallback even if unlisted; self-healing | Navigator | `agent` |
| `cdp` | Any external endpoint already exposing the Chrome DevTools Protocol — `ws://…` or `http://…`. Navigator connects lazily and reuses the connection; it never launches or closes these processes | You (owner of the sidecar/process) | `agent` |
| `navigator-cdp` | A browser-relay extension (Chrome `chrome.debugger`, Firefox WebDriver BiDi) installed in a real user browser that dials **into** Navigator's `/relay` endpoint and pairs over a one-time PIN | The extension | `user` |

## Roles and routing

1. **Array order is the rollback chain.** For a call without an explicit browser, add-ons are tried in `BROWSERS` order — the first connected one carrying the needed role serves the call; each down add-on is reported in `rollbackNotes` and the chain moves on.
2. **Explicit `browser` parameter is strict.** Naming a browser that is down or lacks the required role is an error — no silent re-routing.
3. **Chromium is the last resort.** If no add-on serves the call (or none is connected), the built-in Chromium handles it.
4. **Roles gate the call.** Devtools tools require a browser carrying `devtools` (or `default`); page tools get whichever connected add-on covers their role first.
5. **Search engines never use add-ons.** All `web_search` routes run on the built-in Chromium. (Lightpanda-powered routes like `google_lp` use Lightpanda through Navigator's internal engine pools, independent of `BROWSERS`.)

## Ownership — `user` vs `agent`

`list_browsers` and `Target.getTargets` label every browser. The classification is derived from the entry type:

- **`user`** (`navigator-cdp`) — a real, visible browser window on the user's machine. Tabs, clicks, and navigation happen on the user's screen; drive with care. Navigator never closes these tabs — closing an adopted tab only releases Navigator's handle.
- **`agent`** (Chromium + `cdp` add-ons) — Navigator-owned, headless/invisible. Safe to drive freely.

## Add-on lifecycle

- Connections are **lazy and reused**: the first call dials the endpoint (`_ensureAddOnConnection`), the connection is kept, and a `disconnected` event clears the cached state so the next call reconnects.
- **You own the lifecycle** of `cdp` and `navigator-cdp` processes — Navigator never launches or closes them (except its own built-in Chromium).

## See also

- [External CDP Browsers](/reference/browsers/external-cdp) — the `cdpUrl` endpoint forms + launching a self-hosted Chromium
- [CloakBrowser](/reference/browsers/cloakbrowser) · [Lightpanda](/reference/browsers/lightpanda) — sidecar entries
- [Relay Extensions](/reference/browsers/extensions) — `navigator-cdp` entries
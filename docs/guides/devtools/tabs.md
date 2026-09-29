# Tabs & Navigation

Manage persistent browser tabs and navigate them. These 7 tools cover the tab lifecycle and history — all responses are JSON.

The window hosting a tab has its own four tools (`Target.activateTarget`,
`Browser.focusWindow`, `Browser.getWindowForTarget`, `Browser.setWindowBounds`)
— see [DevTools Overview](/guides/devtools/overview#window--focus).

## Target.createTarget

Create a persistent tab. Provide `url`, `ref_id`, and optional `viewport`. Tabs auto-close after 5 minutes of inactivity.

**Request**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `targetId` | `string` | — | Optional custom id. Random if omitted |
| `url` | `string` | `about:blank` | Starting URL |
| `ref_id` | `number` | — | Numeric ref from `web_search`/`web_fetch` (overridden by `url`) |
| `viewport` | `object` | — | `{ width, height }` in CSS pixels, e.g. `{ width: 390, height: 844 }` |

Response:

```json
{
  "targetId": "abc123",
  "backend": "cloakbrowser",
  "ownership": "agent",
  "url": "https://example.com/",
  "title": "Example Domain",
  "viewport": { "width": 390, "height": 844 },
  "createdAt": "2026-08-21T20:00:00.000Z"
}
```

## Target.getTargets

List open tabs.

**Request**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| — | — | — | No parameters |

Response:

```json
{
  "targets": [
    {
      "targetId": "abc123",
      "url": "https://example.com/",
      "title": "Example Domain",
      "backend": "cloakbrowser",
      "ownership": "agent",
      "lastActiveAt": "2026-08-21T20:00:00.000Z",
      "viewport": { "width": 1280, "height": 800 }
    }
  ]
}
```

## Target.closeTarget

Close a tab.

**Request**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `targetId` | `string` | — | Target id to close |

Response:

```json
{ "targetId": "abc123", "closed": true }
```

## Page.navigate

Navigate a tab to a new URL. If `targetId` doesn't exist, creates a new tab with that id (`created: true`).

**Request**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `targetId` | `string` | — | Target id |
| `url` | `string` | — | URL to navigate to |

Response:

```json
{
  "targetId": "abc123",
  "url": "https://example.com/next",
  "title": "Next Page",
  "navigated": true,
  "created": false
}
```

## Page.reload

Reload the current page. `ignoreCache: true` hard-refreshes (bypasses HTTP cache).

**Request**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `targetId` | `string` | — | Target id |
| `ignoreCache` | `boolean` | `false` | Hard refresh |

Response:

```json
{
  "targetId": "abc123",
  "url": "https://example.com/",
  "title": "Example Domain",
  "reloaded": true,
  "ignoreCache": true
}
```

## Page.goBack / Page.goForward

Browser history navigation. Returns `navigated: false` when no history.

**Request**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `targetId` | `string` | — | Target id |

Response:

```json
{
  "targetId": "abc123",
  "url": "https://example.com/prev",
  "title": "Previous Page",
  "navigated": true,
  "direction": "back"
}
```

`goForward` returns `direction: "forward"`.

## Tips

- **Reuse tabs** — `createTarget` once, then `navigate`/`reload`/`goBack` to avoid opening new tabs
- **Set `viewport` at creation** for mobile emulation — `Page.navigate` keeps the same viewport
- **List before acting** — `getTargets` to confirm `targetId` exists
- **Close when done** — or let the 5-minute inactivity timer clean up

## Next Steps

- [DOM Inspection](/guides/devtools/dom) — Read page structure
- [Interaction](/guides/devtools/interaction) — Click and type

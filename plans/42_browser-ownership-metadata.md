# 42 — Browser Ownership Metadata (Agent vs User Browsers)

**Status:** In progress
**Created:** 2026-08-28

## Problem

Navigator can drive two fundamentally different classes of browsers, and the
agent (LLM) currently has no reliable way to tell them apart from tool
metadata:

1. **Agent browsers** — `type: "builtin"` (the bundled Chromium) and
   `type: "cdp"` add-ons (e.g. `cloakbrowser`, `lightpanda`). These are
   navigator's own windows: headless / invisible. Anything the agent does
   there is private and cannot be seen by the user.

2. **User browsers** — `type: "navigator-cdp"` add-ons (e.g. `maclap2`,
   the relay browser). These are the **user's real, visible browser window**
   (non-headless). Every tab opened, every click, every navigation the agent
   performs there is **directly visible to the user**.

The machine can already distinguish the two classes: `type === "navigator-cdp"`
is always a user browser; `builtin` and `cdp` are agent browsers. This
must be surfaced explicitly in tool output and tool descriptions so the LLM
(and any client) understands the visibility/association of what it operates on.

## Requirements

1. **Tag every browser** with its ownership in the output of:
   - `list_browsers`
   - `Target.getTargets` (devtools `listTargets`)
2. **Describe ownership in tool descriptions** so the LLM knows:
   - Actions in a **user browser** are visible to the user (not headless) —
     drive with care, e.g. don't open many throwaway tabs, don't leave clutter.
   - Actions in an **agent browser** are invisible/private.

## Ownership rule (single source of truth)

| `type` | Ownership | Runtime | Visible to user? |
|--------|-----------|---------|------------------|
| `navigator-cdp` | `user` | real user browser (relay) | **Yes** (window is on the user's screen) |
| `builtin` (chromium) | `agent` | navigator's bundled Chromium | No (headless / off-screen) |
| `cdp` (cloakbrowser, lightpanda, …) | `agent` | navigator-owned CDP browser | No |
| `unknown` / missing | `agent` | — | No (defensive default) |

## Implementation

### `src/browser.js` — ownership helper

Add a small helper (or export from a shared util) so both `mcp-server.js`
(`list_browsers`) and `devtools.js` (`listTargets`) derive the same value:

```js
function browserOwnership(type) {
  return type === "navigator-cdp" ? "user" : "agent";
}
```

`type` is already present on every browser entry in both code paths, so this is
a pure derivation — no new config, no drift risk.

### `src/mcp-server.js` — `list_browsers`

For each browser entry (chromium + each effective add-on) add:
- `ownership: "user" | "agent"` (derived from `type`)
- Keep `type` and `connected` as-is.

Update the `list_browsers` tool description to explain the two classes and that
user browsers are **not headless — the user can see all activity**.

### `src/devtools.js` — `listTargets` (`Target.getTargets`)

For each browser entry in the `browsers` array add `ownership` derived from
`type`. Users can then see at a glance which browser is theirs.

Update the `Target.getTargets` and `Target.createTarget` descriptions:
- Drive adopted `origin:"browser"` tabs (user browsers) knowing they are
  visible to the user.
- Note that closing an adopted tab does not close the user's real tab
  (safe release), per existing behavior.

### Page tools (`web_fetch`, `web_page_screenshot`, …)

Their `browser` param already says "an add-on name from list_browsers". After
calling `list_browsers`, the agent sees `ownership` and `type` per browser. We
add a one-line note to the `browser` param descriptions reminding that
`navigator-cdp` browsers are the user's visible window.

## Verification

- `list_browsers` shows `ownership:"user"` for the `maclap2` relay entry and
  `ownership:"agent"` for `chromium` / `cloakbrowser` / `lightpanda`.
- `Target.getTargets` browser entries carry `ownership`.
- Restart `navigator` so tool schema/descriptions are live; confirm via MCP
  `tools/list` and actual calls.

## Related

- `plans/39_dynamic-browser-array.md` (BROWSERS array, `navigator-cdp` type)
- `plans/41_navigator-cdp-relay.md` (relay)
- AGENTS.md "Browser Backend Dispatch Verification" (superseded by plan 39 /
  the `BROWSERS` array model)

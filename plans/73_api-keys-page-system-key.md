# 73 — API Keys Page: System Key Non-Revokable + One-Line Access Column

**Status:** Complete — 4/4 items done (2026-10-11)
**Priority:** Normal
**Created:** 2026-10-10

## 1. Goal

Navigator creates its own internal key named **"Web Tools UI"** the first time it
boots (`src/mcp-server.js:4241` → `ensureConsoleToolsApiKey()`), and the Web Tools
page in the console uses it to call `/console/mcp` (`src/web-console/src/pages/tools/useTools.js:9,71`
via `GET /console/mcp-client-key`, `src/mcp-server.js:4686`). That key is an internal
implementation detail, not an operator key — so the **API keys page must not let it
be revoked**, and the list must **say it is used by navigator for the web tools page**.

Separately, the **Access** column currently stacks its three counts on three lines, which alone
makes every key row ~3 lines tall — collapse it to **one line** so rows are compact (§3.4).

## 2. Current Behaviour

- The key is created on first boot and re-created on demand by `ensureConsoleToolsApiKey()`
  (`src/mcp-server.js:776-783`), matched by name via `CONSOLE_TOOLS_KEY_NAME = "Web Tools UI"` (`:774`).
- It is a normal row in the `api_keys` table, so `GET /console/api-keys` returns it like
  any other key (`getConsoleApiKeysPayload`, `src/mcp-server.js:707-715`) and the console's
  Keys page renders a **Revoke** button for every row unconditionally
  (`src/web-console/src/pages/keys/index.jsx:359-368`).
- Revoking it is handled like any key (`action: "revoke"`, `src/mcp-server.js:811-820`),
  so nothing stops an operator deleting the key navigator depends on.
- Revoke is hard-delete: `revokeMcpApiKey()` deletes the row (`src/db.js:367-377`), so a
  revoked system key only comes back on the next `ensureConsoleToolsApiKey()` call.

## 3. Changes

### 3.1 Server — expose a `system` flag on each key
In `getConsoleApiKeysPayload()` (`src/mcp-server.js:707-715`) add
`system: key.name === CONSOLE_TOOLS_KEY_NAME` to each key object, so the console can
label and lock the row without hardcoding the name client-side.

### 3.2 Server — make the system key non-revokable (and stable)
In `handleConsoleApiKeys()` (`src/mcp-server.js:785`), identify the system key by id
before mutating and refuse the guards:
- `revoke` (`:811`) — return `{ ok: false, error: "The system key used by the web tools page cannot be revoked." }`
  when the id is the system key. (This is the user's explicit requirement.)
- `rename` (`:822`) and the `name` branch of `update` (`:872-897`) — refuse a name change for the
  system key, because its identity is name-based. Without this a rename silently detaches
  `ensureConsoleToolsApiKey()` from the row (it would create a second "Web Tools UI" key).
- Add a small helper (e.g. `isSystemApiKey(id)` using `listMcpApiKeys()` + `CONSOLE_TOOLS_KEY_NAME`)
  so the identity rule lives in one place.

### 3.3 Console — label + lock the row
In `src/web-console/src/pages/keys/index.jsx`:
- Render a **"System"** badge (existing `Pill`) on the system row and a note that it is
  **used by navigator for the Web Tools page** (internal).
- Show no **Revoke** button for `key.system` rows (button removed, not just disabled, so
  there is no target to click); keep **Edit** only if name-locking from §3.2 is in place —
  otherwise hide Edit too.
- Count/heading stays as-is; the row simply reads as internal.

### 3.4 Console — one-line Access column (row height)
The Access column stacks its three `<span>` children vertically because
`.api-key-row small` is `display: grid; gap: 2px` (`src/web-console/src/style.css:3177-3183`),
so every key row is forced to ~3 lines tall from this column alone. Collapse it to one line and
give the column room:
- **JSX** (`src/web-console/src/pages/keys/index.jsx:354-358`): render the three counts on a
  single line — e.g. `12 tools · 2 CDP browsers · 3 MCP browsers` (one `<small>` text with a ` · `
  separator, no wrapping). Keep the `null` = "all …" wording.
- **CSS** (`src/web-console/src/style.css:3128-3137, 3177`): make the Access track fit that
  line — drop the vertical stack (e.g. `.api-key-row small { display: flex; gap: 6px }`, keeping
  the existing `white-space: nowrap`) and widen the 4th `grid-template-columns` track (currently
  the `110px` Access track at `:3130`) so a typical three-count line fits without ellipsis.
  Check the responsive rule at `:3297+` still collapses cleanly.

Result: each row is a single line tall unless the name/key/actions wrap.

## 4. Out of Scope

- No new DB column for the system key — identity stays the existing name constant.
- No change to how the key is generated, stored, or served to the Web Tools page.
- No change to `/console/mcp-client-key` or the Web Tools page itself.
- No change to any other key's revoke/rename behaviour.

## 5. Testing

**Unit (`tests/mcp-server.test.js`):**
- `GET /console/api-keys` payload includes the system key with `system: true` and a normal
  key with `system: false`.
- `POST /console/api-keys { action: "revoke", id: <systemId> }` → 400, error names the system key,
  key still present on the next GET.
- `POST ... { action: "rename"|"update" (name only), id: <systemId> }` → 400, name unchanged.
- A normal key still revokes/renames successfully (guard did not over-match).

**Console build:** `docker exec navigator npm install --include=dev && docker exec navigator npm run console:build`.

**Live (after `docker restart navigator`):**
- `/console/keys` shows the `Web Tools UI` row with the System badge + used-by note and **no**
  Revoke button; other rows unchanged.
- Each key row's Access column renders on one line, so a row is not 3 lines tall; check both
  wide and narrow (responsive) widths.
- Confirm the Web Tools page still works (calls `/console/mcp` successfully) after the change.

**Lint/tests:** `npx vitest run tests/mcp-server.test.js` and `npm run lint` clean on touched files.

## 6. Checklist

- [x] 1. Server: `system` flag in `getConsoleApiKeysPayload()`.
- [x] 2. Server: guard `revoke` (and `rename` / `update` name) for the system key.
- [x] 3. Console: System badge + "used by navigator (Web Tools page)" note, no Revoke button.
- [x] 4. Console: Access column on one line (JSX + CSS track width) so rows aren't 3 lines tall.

## 7. Not Doing

- No commit unless asked.

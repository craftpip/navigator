# 45 — Browser connection name + LLM description (extension → server → tools)

> Status: **Plan** — not started
> Owner: navigator extensions + relay-server + browser/mcp-server surface
> Request: *"in the navigator browser extensions, we will take input of the name of the connection name the examples of the names more understandable, Firefox laptop, Chrome Desktop, Personal browser, like this what u call this browser, and another new field we add that is description -> this is given to the llm to make decisions on what to select, this the user will enter the description or instructions for llm for this browser, make a plan first"*

---

## 1. Goal

Make the paired **user browser** self-describing so the LLM can pick the right one without guessing.

Two user-visible changes in the **Chrome + Firefox** relay extensions:

1. **Connection name** — the existing `browserName` field, relabeled and re-hinted with human-friendly examples. **Name must be prefixed `Az01-`** (e.g. `Az01-Firefox`, `Az01-Chrome`, `Az01-Personal`). This string remains the **stable key** (`/relay` hello `browserName` == `relay_sessions.name` == `BrowserManager` entry name). No separate technical id.
2. **Description / LLM instructions** — a new optional free-text field stored alongside the pairing. The server persists it and surfaces it on every browser listing the LLM sees (`list_browsers`, `Target.getTargets`, `/health`, `/stats`, web console). The popup hint tells the user: *"This is instructions for the AI — when you have multiple browsers, the AI reads this to decide which to use."*

The description is **LLM-facing, user-authored**. No auto-generated content.

---

## 2. Current state (what exists today)

| Layer | How `browserName` works today | Description |
|---|---|---|
| **Popup** `chrome-extension/popup.html` + `firefox-extension/popup.html` | Single line input `browserName` — label "Browser Name", placeholder `Chrome Dev` / `Firefox`, validation 2–48 chars, regex `^[A-Za-z0-9 _\-.()]+$`. **Target change:** name must start with `Az01-` (`^Az01-[A-Za-z0-9 _\-.()]+$`, 6–48 chars). Stored in `chrome.storage.local.browserName`. | Does not exist. |
| **Storage** `chrome-extension/utils/config.js` `firefox-extension/utils/config.js` | `getBrowserName` / `saveBrowserName`, + `_pendingBrowserName` durable flag. | — |
| **Hello** `chrome-extension/core/connection-manager.js` `firefox-extension/core/connection-manager.js` → `src/relay-server.js` | `connect()` reads `browserName` + `sessionToken`, sends `{type:"navigator-hello", browserName, sessionToken, extensionVersion, platform}`. Server creates `_entries` keyed by `name` and `relay_sessions.name` row. | — |
| **Server** `src/relay-server.js` | `RelayServer._entries` map, `getStatusEntries(configured)` merges `BROWSERS` + dynamic. `gatewayWsUrl(name)`. Persisted pairing = `relay_sessions(name PK, session_token, created_at)` via `src/db.js` `saveRelaySession` / `loadRelaySessions`. | Not stored anywhere. |
| **BrowserManager** `src/browser.js` | `_effectiveAddOns()` returns `{name, type:"navigator-cdp", status, paired, ...}`. `getHealth()` / `getInstanceStats()` / `_navigatorCdpStat()` emit `name` but no description. | — |
| **Tool surface** `src/mcp-server.js` `src/devtools.js` | `list_browsers` returns `{name, type, ownership:"user", status, role, ...}`. `Target.getTargets` devtools listing returns `backend` per `name`. Tool markdown re-states ownership but has no per-browser hint. | — |
| **BROWSERS env** `src/config.js:parseBrowsersEnv` | `BROWSERS` entries have `{name, type, role, cdpUrl, plugin}`. No description. | — |
| **Web console** `src/web-console/src/main.jsx` | Browser status section re-renders `_effectiveAddOns()` output; shows name + pin/connected but no description. | — |

**Pain this fixes:** with 2+ user browsers (e.g. `Chrome` + `Firefox`, or `Chrome` + `Chromeasd`) the LLM sees only opaque names and picks arbitrarily; user has no way to say "use the personal laptop for Gmail tasks" without prompt engineering.

---

## 3. Design — target state

### 3.1 UX & copy (both extensions, keep parity)

**Popup field changes** (`popup.html`):

- `Browser Name` → **"Connection name"** (Chrome) / **"Connection name"** (Firefox) — single label across both; subtitle `What should we call this browser?`
- Keep the same input `id="browserName"` (no data migration — storage key stays `browserName` for compat).
- **Name is validated to ONLY accept names prefixed `Az01-`** (e.g. `Az01-Firefox`, `Az01-Chrome`, `Az01-Personal`). This is the user's naming convention — the connection name must start with `Az01-`.
  - **Validation:** case-sensitive prefix `Az01-` required. Full regex `^Az01-[A-Za-z0-9 _\-.()]+$`, length 6–48 chars (the 5-char `Az01-` prefix + 1–43 chars of label). A name that does not start with `Az01-` fails immediately with an inline error: `Name must start with "Az01-" — e.g. Az01-Firefox`.
  - Hint under the field (always visible, grey):  
    `A friendly name for this browser, prefixed with “Az01-”. Examples: “Az01-Firefox Laptop”, “Az01-Chrome Desktop”, “Az01-Personal Browser”. Shown to you and to the AI.`  
  - This replaces the old 2–48 regex; every paired browser already configured must carry the `Az01-` prefix.
- **New textarea field** directly below connection name:

  ```
  label:  Description for AI (optional)
  tag:    <textarea id="browserDescription" rows="3">
  placeholder: Firefox → "User's Firefox"  ·  Chrome → "User's Chrome"      (or unified: "User's Firefox"/"User's Chrome" per-browser variant)
  hint:   Instructions for the AI. When you have multiple browsers, the AI reads this to choose the right one.
  counter: 0 / 500 (optional, nice-to-have)
  ```

  **Placeholder copy (`browserDescription` placeholder):** show `User's Firefox` on the Firefox popup variant and `User's Chrome` on the Chrome popup variant (per-browser default, matching the existing per-browser name placeholders). This is the primary suggestion the user wants; the generic "Personal laptop — Gmail…" example is dropped in favor of the per-browser "User's Chrome/Firefox" default.

  Styling: same `field` pattern but `textarea` with `resize: vertical; min-height: 64px; max-height: 140px;` inheriting the input palette. Disabled while `connecting` / `pairing`? **No** — same as `browserName`/`serverUrl`: locked (`disabled`) when `connecting`/`pairing`, enabled when `disconnected`/`connected`. While `connected`, editing should be allowed without reconnect — see 3.3.

- **Connected summary** (`#connectedSummary`): add a fourth row `Description` (only rendered when non-empty, truncated to 60 chars with `title` holding full). Keeps the green summary as the glanceable state while the inputs are hidden.

- **Firefox parity:** same two fields; keep the per-browser defaults for both the connection-name label (`Az01-Firefox` style) and the description placeholder (`User's Firefox` on Firefox, `User's Chrome` on Chrome). No unified copy — keep the per-browser variant minimal as today.

**Validation — description:**

- Optional. Empty = no description (omitted on hello).
- When non-empty: 1–500 chars (warn at 400, hard cap 500). Single line or multi-line allowed; trim, collapse `\r`, keep `\n` as `·` on the server side, but store raw.
- Forbid control chars `\x00-\x1F` except `\n\t` (strip nulls).
- On `connect`, validate both fields together; description errors render inline under the textarea like the existing `field.error` pattern (`field-browserDescription` + `browserDescriptionError`).

### 3.2 Extension storage (`utils/config.js` both variants)

Add symmetric accessors:

```js
getBrowserDescription(callback) // -> string ("")
saveBrowserDescription(value, callback)
```

Store under `chrome.storage.local.browserDescription` (one key, string). Keep `browserName` key as-is.

Extend the durable pending flag to carry it so a popup closed mid-connect restores it:

- `setPendingConnecting(serverUrl, browserName, browserDescription, cb)`
- pending keys: `_pendingBrowserDescription` alongside `_pendingBrowserName`.

Existing installs: `getBrowserDescription` returns `""` when missing — no migration.

### 3.3 Wire protocol (extension → navigator)

**Hello — additive, backwards compatible:**

```js
{
  type: "navigator-hello",
  browserName: "Az01-Firefox",
  browserDescription: "Personal laptop — Gmail + LinkedIn ...", // NEW, optional string <=500
  sessionToken: "...", // existing
  platform: "firefox",
  extensionVersion: "0.3.1"
}
```

- Server ignores unknown keys from old extensions → old extensions keep working (description simply absent).
- On every (re)connect — including token-auth reconnect (no PIN) — the extension resends the *current* `browserDescription` so edits propagate without re-pairing.
- **Live update while connected** (no reconnect): new message

  ```js
  { type: "update_description", description: "..." }
  ```

  Sent by `popup.js` on textarea blur / save while `State.isConnected()`. Server updates in-memory entry + persistent row, then broadcasts health. No PIN required — session token already authenticates the channel.

### 3.4 Server persistence (`src/db.js`)

Reuse the existing SQLite DB; add a sibling table so pairing token and human metadata have separate lifecycles (token rotates rarely, description edits freely).

```sql
CREATE TABLE IF NOT EXISTS relay_browser_meta (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
```

Helpers:

```js
saveRelayBrowserMeta(name, description)  // INSERT OR REPLACE
loadRelayBrowserMetas()                  // SELECT name, description FROM relay_browser_meta
deleteRelayBrowserMeta(name)             // DELETE WHERE name=?
```

On `RelayServer.init()`:

- After restoring `relay_sessions` tokens into `_tokenToName`, also load every `relay_browser_meta` row and hydrate each `_entries` matching name (or keep a separate `Map _meta`) so a cold restart still serves descriptions even before the extension reconnects. A paired-but-disconnected browser should still show its description in `getStatusEntries`.

On hello / `update_description`:

- Trim + validate (≤500) in `relay-server.js` (reject >500 with an error reply but keep the connection alive; old value stays).
- `saveRelayBrowserMeta(name, description)` + update `entry.description` / `entry.descriptionUpdatedAt`.
- Re-emit via health — no extra broadcast needed; polling + next `/stats` pickup is enough, but also `notify()` if the web console wants live.

On `forget(name)`:

- Delete both `relay_sessions` and `relay_browser_meta` for that name.

**Why not extend `relay_sessions`:** pairing metadata (token) and user metadata (description) have different write patterns; a separate table avoids widening the existing migration and keeps `loadRelaySessions` untouched.

**Alternative considered — store only in memory:** loses user work on navigator restart; rejected.

### 3.5 In-memory model (`src/relay-server.js`)

- `_entries: Map<name, Entry>` gains `Entry.description: string` (default `""`) and `descriptionUpdatedAt: number|null`.
- `_statusFor(cfg)`, `getStatusEntries()`, `getEntry()`, `refreshTabList()` helpers, and the `gatewayWsUrl` debug paths propagate `description` unchanged.
- `_statusFor` return shape adds:

  ```js
  { name, type, description, descriptionUpdatedAt, ... }
  ```

  Truncate only at presentation layers, never in storage.

### 3.6 Config surface (`src/config.js` + `BROWSERS` env)

For completeness (not required for the extension feature but keeps static browsers self-describing):

- `parseBrowsersEnv` accepts optional `description?: string` (trimmed, ≤500, control-char sanitized). Omitted → `""`.
- Stored as `browser.description` alongside `name/role/type/cdpUrl/plugin`.
- Static browsers (e.g. `cloakbrowser`) can carry a description like `"Stealth Chromium for web_search/fetch"` without touching the extension path. This is purely additive — existing configs validate without it.

### 3.7 Health & stats (`src/browser.js`)

- `getHealth().browsers[]`, `getInstanceStats()[]`, and `_navigatorCdpStat(entry)` include `description` and `descriptionUpdatedAt` (pass-through from relay).
- `_effectiveAddOns()` already delegates to `relayServer.getStatusEntries(...)`; no extra wiring beyond the enriched entry.
- Filter/display: health keeps full description; `openTabs` listings do not repeat it per-tab.

### 3.8 MCP tool surface (`src/mcp-server.js` + `src/devtools.js`)

**`list_browsers` (MCP tool + `GET /health` proxy):**

- Each navigator-cdp entry now includes `description: string` (empty when absent) and `ownership: "user"` already signals visibility. No breaking change.

  ```json
  {
    "name": "Az01-Firefox",
    "type": "navigator-cdp",
    "ownership": "user",
    "status": "connected",
    "description": "User's Firefox — personal laptop, has Gmail, LinkedIn logged in. Prefer for personal tasks.",
    "cdpUrl": "ws://host:port/browser/Az01-Firefox"
  }
  ```

- Tool description string: append one sentence so the LLM knows the field exists:  
  `"For navigator-cdp browsers, description (if present) is user-authored instructions for choosing among your browsers — respect it when picking a browser."` — keeps the generic role text and appends this line.

**`Target.getTargets` (devtools):**

- Per-entry additive field `description` (same string as the browser-level description — one browser, one description, shared across its tabs). Avoids per-tab bloat.

  ```json
  { "targetId": "ABC", "backend": "Az01-Firefox", "description": "...", "url": "https://...", "title": "..." }
  ```

**`web_fetch` / `web_page_screenshot` + `resolveBrowserParam` rollback notes:**

- No functional change to `browser` param handling (explicit `browser: "Az01-Firefox"` already works via name match; spaces are URL-encoded for the gateway). Optionally include a one-line hint in rollback notes: `"hint: see list_browsers descriptions to choose among user browsers"` when >1 user browser is connected — cheap, keeps guidance discoverable without extra tool calls.

### 3.9 Web console (`src/web-console/src/main.jsx` + `style.css`)

- Browser drivers panel: render description under the name (muted, 12px, line-clamped to 2) when present; tooltip/title holds full. Name stays the primary label.
- Running config / BROWSERS header: tooltip on `BROWSERS` chip shows description for that entry if non-empty.
- No editor in the console — description is owned by the extension popup. Console is read-only for this field.

### 3.10 Migration & compat

- **Backwards compatible** at every boundary: missing `browserDescription` → `""`; missing `description` on hello → preserve existing server value; old extensions never send it and remain valid.
- Existing `relay_sessions` rows unaffected; new table is `IF NOT EXISTS`.
- Packaged extensions bump minor: `manifest.json` `0.3.0 → 0.3.1`; no permission changes.
- No env-file change, no container env migration.

---

## 4. Implementation phases — files & order

**Phase A — Database + protocol** (no UI yet, safe to deploy):

1. `src/db.js` — add `relay_browser_meta` migration + `save/load/deleteRelayBrowserMeta`.
2. `src/relay-server.js` — add `description` to `_entries`, wire `navigator-hello.browserDescription` ingestion + `update_description` handler, persist via db, include in `getStatusEntries` / `_statusFor` / `getEntry` / `forget` / `init` hydration.
3. `src/config.js` — accept `description` in `parseBrowsersEnv`.

**Phase B — Browser manager & tool surface:**

4. `src/browser.js` — thread `_entries.description` through `_navigatorCdpStat` / `getHealth` / `getInstanceStats` / `_buildAddOnHealth` / `getRelaySummary`.
5. `src/mcp-server.js` — `list_browsers` payload + tool description line; `/health` already reflects `browser.js` so nothing extra.
6. `src/devtools.js` — `listTargets` / `Target.getTargets` per-target include `description` (one backend lookup, no extra CDP work).

**Phase C — Extensions (both, keep diff symmetric):**

7. `chrome-extension/utils/config.js` + `firefox-extension/utils/config.js` — `getBrowserDescription` / `saveBrowserDescription` / `setPendingConnecting` 3-arg.
8. `chrome-extension/popup.html` + `firefox-extension/popup.html` — rename label, add textarea + hints + connected-summary row; reuse `field` styling.
9. `chrome-extension/popup.js` + `firefox-extension/popup.js` — wire textarea: load/prefill, `_descriptionDirty` guard, inline validation, `connect` includes `browserDescription`, blur-while-connected sends `update_description` via `chrome.runtime.sendMessage({type:"update-description", description})`.
10. `chrome-extension/background.js` + `firefox-extension/background.html` + `firefox-extension/background.js` — handle `connect` 3-field chain, `update-description` forwarding, `navigator-hello` includes `browserDescription`, keep `_pendingBrowserDescription` on reconnect.

**Phase D — Console & polish:**

11. `src/web-console/src/main.jsx` + `style.css` — render description in browser panel; optional native tooltip on hover.

**Phase E — Tests, docs, pack:**

12. `chrome-extension/test/unit-ext.mjs` + `firefox-extension/test/unit-ff.mjs` — extend hello/message routing tests for `browserDescription` + `update_description`.
13. `tests/browser.test.js` + `tests/db.test.js` (or `tests/relay.test.js` if exists) — cover db migration + health includes description.
14. `AGENTS.md` + `chrome-extension/README.md` + `firefox-extension/README.md` — update popup field docs, relay contract.
15. `chrome-extension/pack.sh` + `firefox-extension/pack-firefox.sh` — bump version only if not auto.

**Checkpoint after each phase:** run `docker compose build && docker compose up -d` / `docker exec navigator npx vitest run` + load the unpacked extension in a scratch Chrome profile and verify the popup → hello → `GET /health` round-trip.

---

## 5. Validation & edge cases

- **Name uniqueness:** `description` does not affect uniqueness; `name` uniqueness stays `seen` check in `parseBrowsersEnv` and `String(name).trim()` identity on the relay.
- **Routing with spaces:** `/browser/<name>` already uses `encodeURIComponent(name)` client-side (`relayServer.gatewayWsUrl`) and `decodeURIComponent(match[1])` server-side (`_handleGatewayUpgrade`) — `"Az01-Firefox Laptop"` works without extra encoding work. Verify with an explicit `Target.createTarget({browser:"Az01-Firefox Laptop"})` in the test matrix.
- **Length & charset:** name `Az01-` prefix required, 6–48 chars; description 0/1–500. Control chars stripped server-side; never throw on bad description — coerce to `""` + in-popup error rather than closing the WS.
- **Stale description on restart:** `init()` hydrates `relay_browser_meta` before any extension reconnects, so a cold start already shows prior descriptions in `list_browsers` (status `disconnected` or `paired — disconnected`) — important for offline decision-making.
- **Concurrent edits:** last-write wins (`INSERT OR REPLACE` + `updated_at` monotonic). No merge needed at 500 chars.
- **Null vs empty:** normalize to `""`; API never returns `null` so LLM field checks are simple `if (description)`.

---

## 6. How the LLM uses it

- **Discovery:** call `list_browsers` → each `ownership:"user"` entry now has `description`. If `description` is present, it is the user's instruction for when to use that browser. Prefer it over guessing by `name` alone.
- **Selection:** `web_fetch({urls:[...], browser:"Az01-Firefox"})` or `Target.createTarget({browser:"Az01-Firefox", url:"..."})` — same explicit routing as today, just with a better name to target.
- **Adoption:** `Target.getTargets` → per-target `description` mirrors the browser-level one, so the LLM knows which *group* a tab belongs to without a second tool call.
- **Fallback:** empty `description` → behave as today (choose by `name`, tab title/url, or ask user).

**Tool hint text (append-only, not a breaking rewrite):**

> *For `navigator-cdp` ("user") browsers, `description` is user-provided guidance for this browser (e.g. "Work laptop — has Gmail logged in"). When multiple user browsers are available, prefer the one whose description best matches the task.*

---

## 7. Open decisions (resolve before coding)

1. **`Az01-` name prefix** — enforced as a hard validation rule on both popups (name must start with `Az01-`). **Resolved by user:** yes, only `Az01-`-prefixed names are accepted.
2. **Description placeholder copy** — per-browser default `User's Firefox` / `User's Chrome`. **Resolved by user:** use `User's Firefox` on Firefox, `User's Chrome` on Chrome (no unified generic example).
3. **Counter / hint density** — show `0/500` live counter or just rely on validation? Counter is mild value-add, no risk.
4. **Console editability** — keep description read-only in the web console (extension is source of truth) vs allow console edits that push `saveRelayBrowserMeta` directly? **Leaning:** read-only for v1; fewer auth paths.
5. **BROWSERS `description` visibility** — expose for static browsers now or defer to follow-up? Cheap to do in Phase A, so include.

---

## 8. Rollout checklist

- [ ] DB migration + helpers
- [ ] `relay-server.js` hello + `update_description` + hydration
- [ ] `config.js` `description` parse
- [ ] `browser.js` health plumbing
- [ ] `mcp-server.js` + `devtools.js` payloads + tool-doc line
- [ ] `chrome-extension` storage + popup + background — **name regex `^Az01-…` enforced; description placeholder `User's Chrome`**
- [ ] `firefox-extension` storage + popup + background (mirror) — **name regex `^Az01-…` enforced; description placeholder `User's Firefox`**
- [ ] Re-pair existing browsers with `Az01-`-prefixed names (old unprefixed names fail the new validation)
- [ ] `web-console` read-only render
- [ ] Unit tests extended (both harnesses)
- [ ] `AGENTS.md` + extension READMEs updated
- [ ] Unpacked extension smoke + `GET /health` → `list_browsers` e2e (verify `Az01-` name + `User's Chrome/Firefox` description appear)
- [ ] Version bump `0.3.1` + pack scripts

---

## 9. Future — not in this change

- Per-tab descriptions (out of scope — description is per-browser).
- LLM-side auto-summarization of open tabs into a suggested description (could be a console helper later).
- i18n of hint copy.

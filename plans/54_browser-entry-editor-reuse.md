# 54 — Reusable Browser Entry Editor: Manage Listing + Drivers Edit

**Status:** Implemented (2026-09-11)
**Created:** 2026-09-11
**Scope:** Console UI — `Browser drivers` panel on the status page (`src/web-console/src/pages/status/Drivers.jsx`) and the `Browser Array` editor on the manage page (`src/web-console/src/pages/manage/BrowserArrayEditor.jsx`). No server logic change.

---

## Summary

Add an **Edit** action to the browser drivers ⋮ menu and to the manage page's browser array UI, both opening the **same reusable browser-edit form**. Today the editors are duplicated/inline: the drivers panel renders a bare `Forget` action in its ⋮ menu; the manage page renders every browser's full field form always-expanded in cards. The request:

1. **Drivers section** — a new **Edit** entry in the existing 3-dot menu (added in the previous task) opens a form for that browser.
2. **Reusable form** — one `BrowserEntryForm` component used in *both* places.
3. **Manage page** — turn the always-expanded card field forms into a **small compact listing** of browsers where clicking an **Edit** button opens the same reusable form.

---

## 1. Current Behavior

*Source: `src/web-console/src/pages/status/Drivers.jsx:150-197` (⋮ menu), `src/web-console/src/pages/manage/BrowserArrayEditor.jsx:54-183` (card forms), `src/web-console/src/pages/manage/ValueControl.jsx:55-64` (BROWSERS wiring).*

**Drivers panel** (`Drivers.jsx`):
- Each browser row renders a ⋮ menu (`isRelay && !pending` only) with a single `Forget` action (`Drivers.jsx:150-197`).
- Row data comes from `health.browsers[]` (projection: `name`, `role`, `type`, `plugin`, `configured`, `status`, `pair`, `connected`, `cdpUrl`, `relayWsUrl`).

**Manage page** (`BrowserArrayEditor.jsx`):
- `ValueControl` renders `BrowserArrayEditor` for the `BROWSERS` key with `value` = serialized JSON string.
- `BrowserArrayEditor` keeps `entries = parseBrowsersEntries(value)` and every browser is rendered as a `pp-card` with header actions (move/duplicate/remove) **and its full field form always expanded** (`pp-card-fields`: Type, Name*, ROLES checkboxes, CDP URL, Plugin) — `BrowserArrayEditor.jsx:98-184`.
- `"Form view"` default / `"JSON view"` toggle at the toolbar (`:80-85`); `+ Add browser` appends `BROWSER_EMPTY_ENTRY` (`:54`).
- `parseBrowsersEntries` / `serializeBrowsersEntries` / `normalizeBrowserType` live in `BrowserArrayEditor.jsx:4-31` and are exported.
- Saving (the `Save changes` button in `pages/manage/index.jsx:113-127`) PUTs `{ updates: { BROWSERS } }` to `/console/config`.

**Modal patterns already in the codebase** to reuse:
- `ActivityDetailModal.jsx` (`createPortal` + `.activity-detail-backdrop`/`.modal`, Escape + body-scroll lock).
- `pages/keys/index.jsx:130-180` (`api-key-modal-backdrop` + `.api-key-modal`, `apiKeyModal` state) — the closest "edit form in modal" precedent.
- CSS: `.api-key-modal*` at `style.css:2600-2660`; `.pp-*` at `style.css:2042-2200`.

---

## 2. Goal

```
DRIVERS panel (after):
┌─ BROWSER DRIVERS ───────────────────────────────┐
│ ⋮ ● cloakbrowser  navigator-cdp   offline  ⠿   │   ← ⋮ menu now on every row
│     └ [Edit] [Forget]                           │   ← Edit opens shared form (relay also keeps Forget)
│ ⋮ ● chromium     inbuilt         2 tabs  ⠿      │   ← Edit disabled/hidden for inbuilt (locked form)
└─────────────────────────────────────────────────┘

MANAGE page (after):
┌ BROWSERS — Browser Array ─────────────────────────────┐
│ ▸ cloakbrowser          navigator-cdp  [↑][↓][⧉][✕]  │  compact row
│      roles: default · devtools              [Edit]   │  Edit → same shared form (modal)
│ ▸ chromium              inbuilt                     │  no Edit for inbuilt
│ + Add browser                                      │  opens modal with empty entry
└───────────────────────────────────────────────────────┘
```

Both entry points open **one `BrowserEntryForm`**. Editing a browser in the drivers panel persists through the exact same `/console/config` `{ updates: { BROWSERS } }` path the manage page uses.

---

## 3. Requirements

| # | Requirement | Notes |
|---|-------------|-------|
| R1 | One reusable single-browser edit form component | `BrowserEntryForm({ entry, onChange, locked })` — field-level, parent owns array↔entry mapping |
| R2 | Type-change side effects live inside the form | `inbuilt → name="chromium", cdpUrl=""`; `!navigator-cdp → plugin="auto"`; `!cdp → cdpUrl=""` (today in `BrowserArrayEditor.jsx:127-133`) |
| R3 | Inbuilt (chromium) renders a locked/read-only form | Fixed name, no options — same as `BrowserArrayEditor.jsx:142-145` today |
| R4 | Drivers ⋮ menu gains `Edit`; `Forget` stays relay-only | Menu visibility expanded to all rows (see §6 + Open Question 1) |
| R5 | Manage page browsers render as a compact listing + Edit | Full field forms no longer always expanded inline |
| R6 | `+ Add browser` opens the same form (empty entry) | Appends only on Save |
| R7 | Saving both places writes full serialized `BROWSERS` array via `/console/config` PUT | Reuses `serializeBrowsersEntries`; `reload()` after save; restart warning surfaced |
| R8 | Keyboard + Escape to close; no background scroll | Reuse `.api-key-modal*` / `.activity-detail-*` patterns |
| R9 | No server change | `health.browsers`, `config.configValues.BROWSERS`, `/console/config PUT` all already exist |

---

## 4. Design — Shared Components

### 4.1 Split parsing helpers out of `BrowserArrayEditor.jsx`

`parseBrowsersEntries`, `serializeBrowsersEntries`, `normalizeBrowserType` move to a new shared module so `Drivers.jsx` can import them without a circular dependency. Recommended home: `src/web-console/src/pages/manage/browser-utils.js` (constants stay in `constants.js`). `BrowserArrayEditor.jsx` re-imports from there (keeps its public exports for any existing importers).

```
BrowserArrayEditor.jsx ──> browser-utils.js  (parse/serialize/normalize)
BrowserEntryForm.jsx    ──> browser-utils.js, constants.js
Drivers.jsx             ──> BrowserEntryForm.jsx, browser-utils.js
```

### 4.2 `BrowserEntryForm` (new)

Props:
- `entry` — one browser object `{ name, role[], type, cdpUrl, plugin, index }`.
- `onChange(nextEntry)` — parent applies it back into its array.
- `locked` (bool) — inbuilt view: renders the "Built-in browser. Fixed name, no options." note instead of fields (matching `BrowserArrayEditor.jsx:142-145`).

Content (migrate verbatim from `BrowserArrayEditor.jsx:120-179`):
- `Type` select (from `BROWSER_TYPES`), `disabled` when `lockType`.
- Name input (hidden/disabled for inbuilt; `placeholder="e.g. cloakbrowser"`).
- `ROLES:` checkbox group (`BROWSER_ROLES`) toggling `entry.role` — only when `!isBuiltIn`.
- `CDP URL` input when `type === "cdp"`.
- `Plugin` select (`BROWSER_PLUGINS`) when `type === "navigator-cdp"`.

Type-change handler moves into the form (currently a bespoke `patch` call at `BrowserArrayEditor.jsx:127-135`): it computes the next entry including the name/cdpUrl/plugin resets, then calls `onChange`.

### 4.3 `BrowserEditModal` (new, thin wrapper)

Opens the form in a modal so both hosts share one open-mechanism. Wraps `BrowserEntryForm` with: backdrop + modal shell (reuse `.api-key-modal-backdrop` / `.api-key-modal` styling), `Save` / `Cancel` buttons, `saving` busy state, inline error line, Escape key + backdrop click + body-scroll lock (copy the hooks from `ActivityDetailModal.jsx:65-75`). Props:

- `title` — e.g. `cloakbrowser` / `Add browser`.
- `initial` — entry to edit, or `BROWSER_EMPTY_ENTRY` for add.
- `locked` (bool), `onClose()`, `onSave(entry)` → fires on Save; parent does the array serialize + PUT.

Hosts decide their own array wiring and save call; the modal is purely presentational for "edit one browser".

---

## 5. Design — Manage Page (`BrowserArrayEditor.jsx`)

### 5.1 Compact listing rows

Replace the always-expanded `pp-card` body:

```jsx
<div key={index} className="pp-card">
  <div className="pp-card-header">
    <div className="pp-card-title">
      <span>{isBuiltIn ? "Chromium" : entry.name || `Browser ${index + 1}`}</span>
      <small className="pp-card-url">{BROWSER_TYPE_LABEL[entry.type] || "CDP"}</small>
    </div>
    <div className="pp-card-actions">
      {/* move ↑/↓, duplicate ⧉, remove ✕ — unchanged */}
      {!isBuiltIn && <button className="button small" onClick={openEdit(index)}>Edit</button>}
    </div>
  </div>
  <div className="pp-card-summary">          {/* NEW compact body */}
    {!isBuiltIn && (entry.role || []).length
      ? <span className="pp-card-roles">roles: {entry.role.join(" · ")}</span>
      : isBuiltIn ? "Built-in browser" : "No roles"}
  </div>
</div>
```

- `+ Add browser` now calls `openAdd()` → modal with `BROWSER_EMPTY_ENTRY`; entry appended to the array only on Save (instead of the current click-appends-and-patches behavior at `:54`). Keeps `Form view`/`JSON view` toggle and the JSON pane untouched.
- `Edit`/`Add` save path (same as today's `updateEntry`/`addEntry`): `patch(nextEntries)` → `serializeBrowsersEntries` → `onChange(serialized)` → manage page `Save changes` persists. No change to the waiting-for-Save draft model.

### 5.2 Modal state inside `BrowserArrayEditor`

```
const [editIndex, setEditIndex] = useState(null);   // -1 = add, null = closed
const openEdit  = (i) => setEditIndex(i);
const openAdd   = () => setEditIndex(-1);
onSave(entry) → entries edited in place (+ append when add) → patch() → close
```

Rendering: `{editIndex !== null && <BrowserEditModal … />}` inside the same editor (portal). When `editIndex === -1` use `BROWSER_EMPTY_ENTRY`, else `entries[editIndex]`.

### 5.3 Styling

New `.pp-card-summary` (small muted line under the header) + `.pp-card-roles`. `pp-card-fields` block stays in the file/sheet for the future but is no longer rendered by `BrowserArrayEditor` (the reusable form owns it now). The `pp-cards`/`pp-card` shell is reused as-is → minimal CSS delta.

---

## 6. Design — Drivers Panel (`Drivers.jsx`)

### 6.1 Menu gains `Edit`, visibility expanded

- Show the ⋮ menu on **every** browser row, not just relay: change the render condition from `isRelay && !pending` (`Drivers.jsx:151`) to a per-row `showMenu`, keeping `pending` (PIN) rows collapsed as today.
- Menu content:
  - `Edit` — shown for all browsers (disabled/hidden when `browser.type === "inbuilt"`, since the inbuilt form is locked — matching R3/manage).
  - `Forget` — unchanged, relay browsers only (`isRelay && !pending`), exact existing confirm + `/console/relay/forget` call.

### 6.2 Edit → modal → save

`Drivers.jsx` owns the save (it has `request` + `reload` already). Flow:

1. Click `Edit` → `setEditTarget(browser)`.
2. Resolve the browser's config entry: parse the current `BROWSERS` value and find by `name`. Two options for getting the value (pick in Open Question 2):
   - **(A) Fresh fetch (recommended):** on modal open, `request("/console/config")` → `configValues.BROWSERS`, `parseBrowsersEntries`, find by `name`. Self-contained, never stale; needs a tiny "loading" state before the form shows.
   - **(B) Prop pass-through:** `StatusView` already holds `config` in its snapshot (`status/index.jsx:11`) — pass `browsersConfig={config.configValues?.BROWSERS}` down through `<Drivers …>`. Zero extra fetch but value can lag manage edits between polls.
3. If found → edit it. If **not** found (dynamic/unconfigured relay) → seed a draft from the health projection (`name`, `role`, `type: "navigator-cdp"`) and *add* it on Save — lets "Edit" also register a running relay that isn't yet in `BROWSERS`.
4. `onSave(nextEntry)` → build the next array → `serializeBrowsersEntries` → `request("/console/config", { method: "PUT", body: { updates: { BROWSERS } } })` → `reload()` → `setEditTarget(null)`.
5. Surface `result.restartRequired?.includes("BROWSERS")` as a small notice in the modal footer ("Apply with a container recreate") — `BROWSERS` is a recreate-apply key (per `MANAGE_GROUPS`/`pages/manage/index.jsx` amber pill).

### 6.3 Close-vs-forget interplay

Closing the modal must not fire Forget's confirm; the two buttons share the menu only. After Forget today the panel reloads (`Drivers.jsx:184`); keep that. If the user edits a browser and then the row disappears (unlikely), the modal just closes on the next `reload`.

---

## 7. Edge Cases

- **Inbuilt chromium:** no Edit (locked form adds no value) — manage listing shows "Built-in browser", drivers menu hides Edit. Forget never applies.
- **Dynamic relay (not in `BROWSERS`):** drivers Edit seeds from `health.browsers` projection and adds the entry on save (Option 2 above). If no name, treat as add with empty name → validation on save.
- **Unconfigured CDP add-on rows:** same as dynamic relay — Edit adds them to `BROWSERS` rather than editing a nonexistent entry.
- **Two browsers same name:** `find by name` picks the first; the edit then rewrites that entry. Acceptable (config parser already keys the array positionally).
- **Empty roles:** manage listing shows "No roles"; serialization keeps `role: []` — matches parse behavior (`BrowserArrayEditor.jsx:15`).
- **Modal open + poll reload:** `reload()` after save closes the modal first, so a poll mid-save can't clobber the draft; keep `editTarget` state outside the mapped rows.
- **JSON view tab open while editing:** the form only exists in Form view (`BrowserArrayEditor.jsx:80-85`); `Edit` buttons render only in the form branch.
- **Pinned height (`driverHeight`):** the drivers modal is `createPortal`-based, so the height-synced `.list` never contains the form — no height-sync interaction.

---

## 8. Files Touched

| File | Change |
|------|--------|
| `src/web-console/src/pages/manage/browser-utils.js` | **New** — `normalizeBrowserType`, `parseBrowsersEntries`, `serializeBrowsersEntries` moved here |
| `src/web-console/src/pages/manage/BrowserEntryForm.jsx` | **New** — shared single-browser form (R2/R3 field logic) |
| `src/web-console/src/pages/manage/BrowserEditModal.jsx` | **New** — modal shell wrapping `BrowserEntryForm` (Save/Cancel/saving/error/Escape/scroll-lock) |
| `src/web-console/src/pages/manage/BrowserArrayEditor.jsx` | Use shared utils; compact listing rows + `Edit`/`+ Add browser` → modal; keep JSON view |
| `src/web-console/src/pages/status/Drivers.jsx` | ⋮ menu on every row with `Edit` (+ relay `Forget`); edit modal + `/console/config` save + restart notice |
| `src/web-console/src/pages/status/index.jsx` | Only if Open Question 2 → Option (B): pass `browsersConfig` prop to `<Drivers …>` at `:138` |
| `src/web-console/src/style.css` | `.pp-card-summary`, `.pp-card-roles`; optionally reuse/augment `.api-key-modal*` for the shared modal |

No server change. `health.browsers`, `config.configValues.BROWSERS`, `/console/config` PUT, `/console/relay/forget` are all existing.

---

## 9. Implementation Steps

1. **Extract utils:** create `browser-utils.js`, move the three helpers, update `BrowserArrayEditor.jsx` imports/exports accordingly.
2. **Build `BrowserEntryForm`:** migrate the `pp-card-fields` block (`type`/`name`/roles/cdpUrl/plugin + type-change side effects + inbuilt locked note) into a controlled single-entry form.
3. **Build `BrowserEditModal`:** form + Save/Cancel + busy/error + Escape/backdrop/scroll-lock (modeled on `keys/index.jsx` + `ActivityDetailModal.jsx`).
4. **Manage page:** swap always-expanded `pp-card-fields` for `.pp-card-summary` + per-row `Edit`; rewire `+ Add browser` and `Edit` through the modal; `onSave` → `patch()`.
5. **Drivers page:** expand ⋮ menu to all rows; add `Edit`; wire modal with `request("/console/config")` (or prop per Q2), save via `/console/config` PUT, `reload()`, restart notice.
6. **Styling:** add `.pp-card-summary`/`.pp-card-roles`; verify `.api-key-modal*` reuse works in both light/dark themes.
7. **Build & verify:**
   ```bash
   docker exec navigator npm run console:build
   ```
   hard-refresh `http://10.69.1.164:1994/console`, exercise §10.
8. **Lint/tests:** `npm run lint` over `src/web-console/src/`; run existing vitest suite if a console test asserts `BrowserArrayEditor` output shape (`npx vitest run`).

---

## 10. Verification Checklist

- [x] `npm run console:build` succeeds; no new lint errors.
- [x] Manage page: browsers render as compact rows (name + type + roles); no inline field forms.
- [x] Manage `Edit` on a row opens the modal prefilled; changes patch the array; `Save changes` persists JSON; JSON view still round-trips.
- [x] Manage `+ Add browser` opens empty form; only appended on Save.
- [x] Manage inbuilt row shows no Edit button.
- [x] Drivers panel: every non-pending row has a ⋮ menu; `Edit` opens the modal for that browser; saving persists via `/console/config` and the panel reloads; restart notice shows.
- [x] Drivers relay row still offers `Forget` with the same confirm; Forget does not enable Edit and vice versa.
- [x] Drivers inbuilt row: menu shows (if any) without Edit.
- [x] Dynamic relay browser (unconfigured) — Edit seeds from health projection and adds to `BROWSERS` on save.
- [x] Escape / backdrop click close the modal; background scroll locked while open; `prefers-reduced-motion` unaffected.
- [x] Light/dark theme check on the modal and the new summary lines.
- [x] Existing poll loop (2s) does not reset or interfere with an open modal.

---

## 11. Risks & Mitigations

- **Stale `BROWSERS` in Option (B) prop:** mitigated by preferring Option (A) fresh fetch on modal open.
- **Drivers edit diverging from manage draft model:** drivers saves immediately (PUT), manage keeps a draft — both end at the same `/console/config` write, no conflict beyond the env-file locking already handled server-side (`applyConfigUpdates`).
- **Circular import from moving helpers:** avoided by the dedicated `browser-utils.js` module (no component imports a sibling that imports it back).
- **Modal shell duplication:** shared `BrowserEditModal` prevents two divergent "edit all" UIs; it stays presentational so hosts keep their own save semantics.

---

## 12. Open Questions (Needs User Confirmation)

1. **Drivers ⋮ menu scope:** expand the menu to **every** browser row (recommended — Edit applies to CDP add-ons too, not just relay), or keep it relay-only and add Edit only there? The previous task deliberately rendered it `isRelay && !pending`.
2. **Config value source for drivers edit:** (A) fetch `/console/config` fresh when Edit opens (recommended, self-contained, no staleness) vs (B) pass `config.configValues.BROWSERS` down from `StatusView` to `Drivers` (zero extra fetch, smaller change).
3. **Manage listing compactness:** keep the `pp-card` shell with a one-line summary (recommended, minimal CSS) or move to a plain table-style row list (more visual change)?
4. **`+ Add browser` behavior:** confirm switching from "add immediately on click, patch draft" to "open modal, append on Save" is desired (needed for a shared add/edit form).
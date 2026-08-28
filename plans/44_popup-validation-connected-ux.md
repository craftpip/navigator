# Plan 44 — Popup Form Validation, Spinner & Connected Summary

**Created:** 2026-08-28
**Status:** Draft — implements UX polish for chrome-extension + firefox-extension popups
**Related:** Plans 38 (Chrome), 40 (Firefox), 41 (Relay)

## Problem

The popup "Connect" form has no validation. Clicking **Connect** with empty fields silently sends a trimmed empty string to `ConnectionManager.connect()` which then fails with a generic WebSocket error (`No relay server URL configured`) surfaced only after the async attempt. No inline guidance.

While connecting (WebSocket handshake + `navigator-hello` + PIN dance) the UI shows a brief spinner but not consistently for every async path — attach/detach already has a row spinner, but the main Connect button's spinner is gated only by `connecting` flag and not by validation failure vs success.

When connected, the two inputs (Browser Name, Navigator Server) remain visible and only dimmed (`opacity:0.6; disabled`). User asked they should be hidden entirely and replaced by a summary card — cleaner, professional, prevents accidental edits while live.

## Goals

1. **Validate on Connect** — if Browser Name or Server empty/invalid, show professional inline errors next to the fields and a top validation summary. Do not start the connection.
2. **Spinner for all API calls** — Connect (incl. fallback candidates), PIN Verify, Attach/Detach, Disconnect all show a spinner + progress bar + disabled button for the duration of the async call. Never leave the UI idle while the network is in-flight.
3. **Connected = summary, not form** — when `snapshot.connected` is true, hide the editable fields; show a read-only summary card: Connected status, Browser name, Server URL, Connected since. Inputs are not editable in this state.

Applies to **both** `chrome-extension/` and `firefox-extension/` (Firefox's hidden `bidiBox` is untouched; same conn-form UX).

## Professional copy

Validation messages use complete, calm sentences — no jargon, no red shouting beyond the inline field hint:

- Browser Name empty → "Browser name is required — please enter an identifier for this browser (e.g., Chrome Dev)."
- Browser Name <2 chars → "Browser name must be at least 2 characters."
- Browser Name >48 chars → "Browser name must be 48 characters or fewer."
- Browser Name invalid chars → "Browser name may only include letters, numbers, spaces, hyphens and underscores."
- Server empty → "Navigator server address is required — please enter host and port (e.g., localhost:1994)."
- Server invalid format → "Please enter a valid server address — expected host:port or ws(s)://host:port/relay (e.g., 10.69.1.164:1994)."
- Top summary when any field fails → "Please correct the highlighted fields before connecting."
- PIN empty / non-6-digit → "Please enter the 6-digit pairing PIN shown in the Navigator console (Browser drivers → PIN required)." / "PIN must be 6 digits."

## Design

### HTML / CSS

New styles (both popups):

```css
.field.error input { border-color:#f44336; background:rgba(244,67,54,0.06); }
.field-error { color:#ff6b6b; font-size:11px; margin-top:5px; display:none; }
.field.error .field-error { display:block; }
.field-hint { font-size:11px; color:#666; margin-top:4px; }

/* Connected summary card */
.connected-summary { background:rgba(76,175,80,0.08); border:1px solid rgba(76,175,80,0.35); border-radius:8px; padding:12px; margin-bottom:12px; display:none; }
.connected-summary.visible { display:block; }
.connected-summary .summary-title { display:flex; align-items:center; gap:8px; font-weight:600; color:#4caf50; margin-bottom:10px; font-size:13px; }
.summary-row { display:flex; justify-content:space-between; gap:12px; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.06); font-size:12px; }
.summary-row:last-of-type { border-bottom:none; margin-bottom:2px; }
.summary-label { color:#999; }
.summary-value { color:#e8e8ec; font-weight:500; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.conn-fields.hidden { display:none; }
```

Structure change (Chrome example — Firefox identical + keeps hidden bidiBox):

```html
<div class="conn-form">
  <div class="connected-summary" id="connectedSummary"> ... </div>

  <div class="conn-fields" id="connFields">
    <div class="field" id="field-browserName">
      <label for="browserName">Browser Name</label>
      <input ...>
      <div class="field-error" id="browserNameError"></div>
    </div>
    <div class="field" id="field-serverUrl">
      <label for="serverUrl">Navigator Server</label>
      <input ...>
      <div class="field-hint" id="serverHint">Just enter host:port — tries wss:// first, then ws://</div>
      <div class="field-error" id="serverUrlError"></div>
    </div>
  </div>

  <button class="btn-full" id="connectBtn">...</button>
  <div class="pin-box" id="pinBox">...</div>
</div>
```

When `connected` → `connFields` gets `.hidden`, `connectedSummary` gets `.visible` and is populated; `connectBtn` text stays "Disconnect" but lives below the summary.

### JS

Shared helpers added to both `popup.js`:

- `validateBrowserName(v)` / `validateServerUrl(v)` → string|null
- `showFieldError(fieldId, msg)` / `clearFieldErrors()`
- `validateForm()` → boolean, drives `errorBox` top summary and per-field `.error`
- `updateConnectedSummary(snapshot)` — fills `#summaryBrowser / #summaryServer / #summarySince`
- `setFormVisibility(connected)` toggles `connFields` / `connectedSummary`

Flow:

1. `connectBtn.click`:
   - if connected → disconnect path unchanged (spinner → `disconnect` message).
   - else → `clearFieldErrors(); if (!validateForm()) { setStatus('error','Please correct the highlighted fields'); return; }` → then `setConnectBusy(true)` and send `connect`.
2. Input `input` events clear their field error immediately (so typing removes red).
3. `pinSubmitBtn.click` validates 6-digit before sending; on failure shows `setPinError` with professional copy and does not send.
4. `loadState()` now handles three rendering branches:
   - `connected` → hide fields, show summary, hide field errors, ensure spinner off.
   - `connecting` / `pairing` / `pinRequired` → keep fields disabled (existing) + spinner/progress on.
   - `error` / `off` → show fields, hide summary.
5. Spinner for all API calls: `setConnectBusy` already covers Connect; `setPinBusy` covers PIN; attach/detach already has per-row spinner + `setProgress(true)`. Disconnect now also sets spinner before `sendMessage`.

No background.js changes required — validation is popup-only. Relay protocol unchanged.

## Verification

- Click Connect with both fields empty → inline errors under each field + top `errorBox` "Please correct the highlighted fields…", no WebSocket attempt (`State.getWs()` stays null).
- Fill valid values → spinner + progress bar appear, button disabled, fields disabled until `connected` arrives; then fields hidden, summary visible, Disconnect enabled.
- Click Disconnect → spinner on button, progress bar, then fields reappear empty.
- Empty PIN / 5-digit PIN → `pinError` shows professional message, no send.
- Existing vm harness `node test/unit-ext.mjs` still green (popup not covered there; relay logic unchanged).
- Manual load unpacked in Chrome + Firefox (about:debugging) — same UX in both.

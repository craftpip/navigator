# 72 — `/browser/<name>` Gateway API-Key Auth

**Status:** Complete — 3/3 items done. 2026-10-10; user directive 2026-10-09.

## Origin — how this issue was found

- **Found while verifying the MCP unauthenticated-off flip (2026-10-09 session).** The user
  asked to disable unauthenticated MCP requests (`MCP_ALLOW_UNAUTHENTICATED=0`), which was
  done and verified. While walking the upstream surfaces to confirm nothing else was affected,
  the **northbound relay gateway** `/browser/<name>` was re-examined and found to have
  **zero authentication** — `_handleGatewayUpgrade` → `attachGatewayClient` validates only
  "entry exists && connected" (close 4003), never a key.
- **Flagged in plan 49 §5.4 first.** This exact gap is item §5.4 of
  `plans/49_browser-extension-security-hardening.md` ("Northbound gateway auth"), which is
  **deferred** (user re-confirmed "Keep deferred" 2026-10-08) and sits at the bottom of the
  `infinite.md` queue. The `/cdp` external surface (plan 55, `src/cdp-share.js`) already has
  the key gate; the relay gateway leg does not.
- **User decision 2026-10-09:** "Require API key in the WebSocket URL — `?key=` in the query
  parameter, the same way as we have done in the CDP." This plan is the standalone,
  single-leg fix (gateway only). It does NOT spin up the rest of plan 49 (HMAC challenges,
  session rotation, extension-side changes) — those stay deferred.

## Goal

Any client dialing `ws://<host>:1994/browser/<name>` must present a valid navigator MCP API
key (`?key=` query param, mirroring `src/cdp-share.js` `authorizeCdpKey`). Invalid/missing
key → the upgrade is rejected **before** any target enumeration. Navigator's own loopback
client (the puppeteer that dials via `gatewayWsUrl`) must present the key too — it must not
be locked out.

## Work Items

- [x] **1. Reuse the CDP auth gate for the gateway upgrade.**
  `initCdpSharing` (`src/mcp-server.js` around :5395) and `_handleUpgrade`
  (`src/relay-server.js:558-579`) both run on the shared HTTP server's `upgrade` event.
  Design: after the relay's `_handleUpgrade` matches `/browser/<name>`, authenticate the
  request with the same rules as `/cdp`:
  - Present key = `?key=` query param (user-mandated form) **or** `Authorization: Bearer <key>`
    header (`getMcpApiKey`), query wins (`authorizeCdpKey` in `src/cdp-share.js:101`, `matchKey`
    :84 constant-time compare).
  - Validate against `manager.config.mcpApiKeys` + console key — the same trust set `/mcp` uses.
  - Missing → close with the CDP-style failure message; invalid → same.
  - Keep the CDP carve-out (`src/relay-server.js:566-568`) untouched — `/cdp*` stays owned by
    `src/cdp-share.js`.
  - Approach options (pick during implementation): (a) pass an auth callback/config into
    `relayServer.init` (called at `mcp-server.js:5371-5380`) so the relay validates against the
    live key list; or (b) implement the gateway gate inside `src/mcp-server.js`'s upgrade
    handling before it defers to the relay. Prefer whichever keeps `src/relay-server.js` free
    of imports from `src/cdp-share.js` but reuses the exact matching semantics.
- [x] **2. Navigator's own gateway client must authenticate.**
  All 7 `relayServer.gatewayWsUrl(name)` call sites in `src/browser.js` (lines 836, 1448,
  1498, 1581, 1607, 1641, 1921) resolve to `ws://…/browser/<name>` with no key. Navigator
  dials that URL as a puppeteer gateway client (`gatewayWsUrl` `src/relay-server.js:196-198`).
  The URL constructor must append `?key=<console key>` (the per-boot console key,
  `CONSOLE_API_KEY`, `src/mcp-server.js:104`) so navigator's own loopback passes the gate.
  Decide: does `gatewayWsUrl` need the console key passed in (parameter/registry), or does
  mcp-server set it on the relay at init? Options may add the key only in the in-process
  dial path (browser.js call sites) rather than inside `gatewayWsUrl` — but the URL must be
  consistently keyed wherever the browser-facing `cdpUrl` is surfaced (`/console/api-keys`,
  `list_browsers`, config-preview) so a user pasting that `cdpUrl` into an external client
  also gets a working, authenticated URL.
- [x] **3. Docs + verification.**
  Update the Tool Contract / docs (`docs/`, `AGENTS.md`) for the gateway URL: `/browser/<name>`
  requires `?key=<api key>`. Verify live: unauthenticated `/browser/<name>` rejected with the
  auth failure before target enumeration; valid `?key=` connects and `Target.getTargets`
  enumerates tabs; navigator's own devtools tools still work end-to-end on a relay browser
  after the change (they dial the authenticated gateway internally).

## Testing (mandatory per plan)

- Unit: extend `tests/relay-server.test.js` with gateway-auth cases — missing key, bad key,
  valid key (connects as a gateway client), and navigator-loopback URL carrying the key.
  Reuse the existing fake extension/ws harness from those tests. Mirror the `/cdp` auth test
  cases from plan 55 where applicable.
- Live MCP: rebuild/restart the container, then through the MCP tools only — confirm a raw
  unauthenticated `ws://…/browser/<name>` dial is rejected, and that `Target.getTargets` /
  `Runtime.evaluate` on the relay browser still work (pad's own dial carries the key).
- Full suite must show zero new failures vs the documented baseline (878 passed / 3 known
  failed; lint 70).

## Notes / non-goals

- Only the northbound **gateway leg** gets the key gate. The extension `/relay` handshake
  (PIN + token) is unchanged. `/cdp*` is untouched (already authenticated, plan 55).
- Plan 49's other five items (HMAC challenge/response, session key rotation, extension-side
  changes, DB key storage vs 0600 file, coordinating the v2 protocol break) remain deferred.
- The per-boot console key approach means navigator's internal dial re-keys every restart;
  externally issued keys (in `api_keys` DB) are stable. Both must pass the gate.
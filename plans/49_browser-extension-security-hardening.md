# 49 — Browser Extension Security Hardening (OpenClaw parity, PIN kept)

**Status:** Draft 2026-09-06 — re-validated 2026-09-29: **0 of 6 work items
done.** Ground truth checked this run: `src/relay-server.js` contains no
`hmac` / `createHmac` / `challenge` / `nonce` and no `Authorization`/`Bearer`
check; `relay_sessions` is still the 3-column bearer table
(`name, session_token, created_at`, `src/db.js:102-107`). The whole HMAC
challenge-response redesign, the northbound gateway auth and the logical-session
ownership model are absent. **Held, not started** — see §9 for why.
**Created:** 2026-09-06
**Scope:** relay pairing + auth + gateway auth + multi-client safety (`src/relay-server.js`, `src/db.js`, `src/mcp-server.js`, `src/browser.js`, `chrome-extension/`, `firefox-extension/`, console relay UI, tests)

---

## 1. Problem

Southbound (`/relay`) pairing is a bearer `sessionToken`: minted after a 6-digit console PIN, then replayed verbatim on every reconnect (`src/relay-server.js:386-446`). Northbound (`/browser/<name>`) has no auth at all (`src/relay-server.js:10,16,336-340,703-709` — only `entry exists && connected`, else close `4003`). Competing gateway clients share native debugger sessions with no ownership rules (Fetch interception takeover is silent).

OpenClaw's relay (docs `openclaw.ai/tools/chrome-extension`, store repack `nglingapjinhecnfejdcpihlpneeadjp`) solved the auth side: connection-bound HMAC proofs (key never on wire, v2-only) and logical per-client sessions (one Fetch owner per target, per-client Runtime bindings, union of auto-attach filters). We port those — minus their onboarding machinery and minus tab access modes (decision: always All tabs, §5.2).

## 2. Goals

- PIN stays the **only** pairing ceremony, always required for a new pairing. No native host, no Store-ID / `Preferences` verification, no silent auto-bootstrap.
- Post-pairing auth upgrades from bearer replay to challenge-response (key never on wire), v2-only from day one (we ship both ends; no legacy compat unlike OpenClaw).
- Tab access: always **All tabs** (user directive — no selectable mode, no Pause/Allow). Connected = all visible tabs as today.
- Multi-client safety on the shared relay: logical sessions, Fetch single-owner with explicit errors, per-client Runtime bindings.
- Northbound gateway auth: `Authorization: Bearer <MCP_API_KEYS>` (or `?token=`) on `/browser/<name>` upgrade.
- Key hygiene: per-host keys, `0600`, ownership checks, rotation/revocation, key-ID-only logs.

## 3. Non-goals

- NativeMessaging host (`ai.openclaw.browser_bootstrap`), origin lock, Store publication/ID checks, `Preferences`/`Secure Preferences` inspection, loopback daemon wake-up (`ensure_relay`), remote `--gateway-url` onboarding. Ruled out: pairing is local-only.
- Playwright-native server protocol. Northbound stays pure CDP (`puppeteer.connect`, `connectOverCDP`).
- Changing CDP coverage (LOCAL/SPECIAL/FORWARD split stays).

## 4. Current behavior (ground truth)

| Surface | Auth today | Code |
|---|---|---|
| `/relay` hello | `navigator-hello {browserName, sessionToken?}`; no token → 6-digit PIN (60s, one guess kills the PIN), console-printed, popup-submitted | `src/relay-server.js:367-446` |
| `/relay` resume | valid token → `connected` with **same** token, never rotates; `4001` on stale token clears + re-pairs | same + extension `connection-manager.js:239` |
| `/browser/<name>` | none — `handleUpgrade` ignores headers; `_handleGateway` checks connected only | `src/relay-server.js:336-340,703-709` |
| Tab access | always All tabs (no selectable mode, per user directive); `isVisiblePageUrl` filter only | `src/browser.js:22`, `_navigatorCdpStat` |
| Client sharing | `entry.clients` + `sessionForTarget`/`extSessionToTarget` maps exist but no ownership policy | `src/relay-server.js:539-542,885-927` |
| Key store | `relay_sessions` (name → token), restored on boot | `src/relay-server.js:81-89`, `src/db.js` |

## 5. Proposal

### 5.1 Pairing: PIN always, then HMAC (v2-only)

- New pairing (no/expired token) → PIN exactly as today. No bypass path: there is no local check that can skip it.
- On PIN accept, server mints **per-host relay key** (32B random) + `keyId`; stores `name → {keyHash, keyId, createdAt, lastUsed}` (migrate `relay_sessions`: add columns; existing bearer rows are carried over for audit but the bearer path is dead — every pre-existing browser re-pairs once via PIN, fail closed). The key is delivered once inside the pairing response on the same socket (plaintext on `ws://` — accepted for local-only scope; use `wss://` off-host). It is never logged and never appears in URL/header/frame afterwards. Returns `{type:'connected', keyId}`.
- Reconnects use challenge-response: server sends nonce → extension replies `HMAC(key, nonce|browserName)` → server verifies with constant-time compare. Key never appears in URL/header/frame afterwards. Wrong proof → drop only the attempting socket (close `4001`); the stored key stays valid so anyone cannot force re-PIN loops. Only an explicit revoke (`relay/forget`) or a `4001` on a stale/unknown `keyId` sends the client back to PIN.
- Token-resumption stays silent (that is not pairing). Any *new* browserName, revoked key, or `4001` → PIN again. "PIN always" = every pairing, not every socket.
- Logs carry `keyId` only, never key/PIN material.

### 5.2 Tab access: always All (no selectable mode)

Removed per user directive. Connected = all visible tabs, as today. No mode switch, no Pause/Allow, no group-boundary enforcement. Agent-created tabs keep landing in the collapsed `Navigator: <name>` group (existing behavior, unchanged).

### 5.3 Multi-client logical sessions

- Formalize what `client.sessionForTarget` started: each gateway client gets logical sessions; native attachment is the union of clients' auto-attach filters; new/broadened interests receive existing children only after accept.
- **Fetch: one owner per native target.** Second owner's intercept request errors explicitly (no silent takeover); response streams belong to the acquiring session.
- **Runtime bindings:** registered per logical session; removing/disconnecting preserves other clients' same-name registrations; context-specific same-name registrations share native Runtime (document: use distinct names).
- Connection drop: retire debugger attachments before the replacement reattaches; bounded Fetch cleanup; never retry a failed op against a replacement session; clients take a fresh snapshot after reattach. Keep `GET /debug/detach_all` as the manual lever.

### 5.4 Northbound gateway auth

- `_handleGatewayUpgrade` checks `Authorization: Bearer <key>` (accept `?token=` for `browserWSEndpoint` URLs that can't set headers) against `MCP_API_KEYS` + console key — same trust as `/mcp` (`src/mcp-server.js:3024`). Missing/invalid → close `4001`, no target enumeration. Effect: only API-key holders can drive the paired personal browser northbound; anonymous LAN clients are rejected before learning any target. Navigator's own loopback client (`gatewayWsUrl`, `src/browser.js:625`) authenticates via `?token=<console key>` in the URL (no dependency on header support in `puppeteer.connect`).
- Browser name stays in path; no `?caps=` provisioning (no fleet — one personal browser, not per-session VMs).

### 5.5 Key hygiene + console

- Server key file/rows: reject foreign-owned/non-regular, tighten group/other-readable to `0600` or refuse (POSIX); Windows keeps existing ACL policy.
- Rotation/revocation: extend `POST /console/relay/forget` to revoke key (immediate disconnect + clients dropped); rotation = revoke + next connect re-PINs. Status shows `keyId`, `connectedAt` — never secrets.
- Timers unchanged: PIN 60s expiry, one guess per issuance, heartbeat 15s/45s.

## 6. Work items

1. `src/db.js`: migrate `relay_sessions` (keyHash, keyId, alg=`hmac-sha256`, createdAt, lastUsed); hash-migrate existing tokens.
2. `src/relay-server.js`: challenge-response handshake; v2-only enforcement; gateway Bearer/`?token=` check; logical-session ownership (Fetch/Runtime/attach-union); keyId logging.
3. `chrome-extension/`: `connection-manager` (challenge reply, no bearer replay), manual Server URL + Browser Name fields stay — target is typed, not baked into a pairing string. No access-mode UI. `mock-relay-server.mjs` + `unit-ext.mjs` parity.
4. `firefox-extension/`: same handshake port (BiDi mapping untouched).
5. `src/mcp-server.js` + console: key-rotation endpoint, relay status columns (`keyId`, `connectedAt`).
6. Tests: pairing → restart-resume → wrong-PIN → revoked-key → challenge-replay rejection → Fetch-conflict error → gateway `4001` without token.

## 7. Verification

- `node chrome-extension/test/unit-ext.mjs` + Firefox harness green; mock-relay exercises PIN → challenge → paired → resume → revoke.
- Live: pair personal browser (PIN), restart navigator (silent resume), wrong PIN (fresh PIN, old dead), revoke (disconnect + re-PIN), two `puppeteer.connect` clients (Fetch conflict errors, Runtime bindings independent).
- `/health` + `/stats` show `keyId`; logs contain no key/PIN material.

## 8. Risks

- Both-ends ship required (server + extension together); old bearer-only extensions fail closed with `4001` → re-pair. Acceptable: we own both ends, no store lag to manage (unlike OpenClaw).
- `?token=` in URLs leaks to process lists/logs — document Bearer-header preference; keep query as compat for `browserWSEndpoint`.

---

## 9. Why this is held (2026-09-29)

Implementation is deliberately not begun. §5.1 makes this a **coordinated
protocol break**, and one work item alone is worse than none:

- **v2-only fail-closed means a partial ship breaks live pairings.** If the
  server stops accepting bearer tokens before both extensions ship the
  challenge reply, every paired relay browser is rejected with `4001` and must
  re-PIN. `AGENTS.md` records the user actively driving `maclap2` through the
  relay, so those are real machines with real work in them — re-pairing them is
  the user-visible cost of an out-of-order deploy.
- **A feature flag would be the safe way to sequence it, but the plan forbids
  it.** §5.1 is explicit: "v2-only from day one (we ship both ends; no legacy
  compat unlike OpenClaw)". A `RELAY_AUTH_V2=0` default would let server,
  Chrome and Firefox land independently and flip on together — but that is a
  direct override of a stated decision, so it needs the user, not me.
- **Migrations are one-way.** §6.1 hash-migrates the existing bearer rows
  "for audit" while declaring the bearer path dead. Doing that before any
  client can answer a challenge is unrecoverable without a second migration.

Sequencing that works, once approved: §6.1 → §6.2 (behind the decision) →
§6.3 Chrome → §6.4 Firefox → §6.5 console → §6.6 tests, with the server's
bearer acceptance removed **last**, in its own commit.

Open decisions for the user before starting:

1. Break now (v2-only, everyone re-PINs once) vs. ship behind a flag and flip later?
2. Is `?token=` in the northbound URL acceptable, or Bearer-header only? It
   leaks to process lists and logs; §8 notes it as a risk, and
   `puppeteer.connect` support for custom headers on `browserWSEndpoint` is the
   constraint to confirm first.
3. Key storage: DB rows only (as §6.1 implies), or a `0600` key file as §5.5
   describes? The two are not obviously the same thing.

// src/relay-server.js
//
// navigator-cdp — our own plugin interface (plans 38/40/41).
//
// Two WebSocket surfaces on the existing HTTP server:
//
//   /relay           the extensions (Chrome + Firefox) dial INTO us: hello, PIN
//                    pairing, session tokens, heartbeat, tab listing, and CDP
//                    message transport (commands out, responses/events in).
//   /browser/<name>  a PURE CDP endpoint (no auth, direct connect) that
//                    puppeteer dials with connect({ browserWSEndpoint }) to
//                    drive the paired remote browser. It speaks browser-level
//                    CDP to the puppeteer client and translates every command
//                    into /relay traffic for the extension.
//
// Auth lives ONLY on /relay. The CDP gateway is intentionally unauthenticated
// (same trust boundary as /extract). PINs are in-memory, per-connection-attempt,
// expire after PIN_EXPIRY_MS, and are printed to the navigator console. Session
// tokens ARE durable — persisted in SQLite (relay_sessions) and restored in
// init(), so a navigator restart never forces a re-PIN. Known relay browsers
// (any extension that dials in, regardless of pairing) are ALSO persisted
// (known_relay_browsers) so forget() — which clears ONLY the pairing — keeps the
// dashboard row visible until remove() (or a BROWSERS config removal) exists.
//
// A browser's own LLM-facing description is durable too (relay_browser_meta):
// the extension authors it in its popup, sends it on every hello, and can
// update it live over an authenticated channel. It is hydrated in init() so a
// paired-but-offline browser still shows what it is for.

import { WebSocketServer } from "ws";
import { randomInt, randomUUID } from "node:crypto";
import { deleteKnownRelayBrowser, deleteRelayBrowserMeta, deleteRelaySession, getAppState, setAppState, initDb, loadKnownRelayBrowsers, loadRelayBrowserMetas, loadRelaySessions, loadRelayTombstones, saveKnownRelayBrowser, saveRelayBrowserMeta, saveRelaySession, saveRelayTombstone } from "./db.js";
import { PLUGIN_PLATFORMS } from "./config.js";

const RELAY_CONFIGURED_NAMES_KEY = "relay_configured_names";

const PIN_EXPIRY_MS = 60_000;
// A browser's self-description is read by the model on every list_browsers
// call, so it stays short enough to be useful inline.
const DESCRIPTION_MAX_CHARS = 500;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const HELLO_TIMEOUT_MS = 10_000;
const GATEWAY_WAIT_MS = 3_000;
// Deadline for commands the gateway forwards to the extension via
// `_sendExtensionCommand`. A response the extension never sends (socket flap
// dropped the frame, SW suspended) must not orphan its pending and leave the
// gateway client waiting on its own timeout — the relay resolves it with an
// explicit error so the caller fails fast. Mirrors the standard op window so a
// healthy-but-slow command (heavy evaluate, big screenshot serialization) is
// never false-faulted.
const RELAY_COMMAND_TIMEOUT_MS = 60_000;
// Created-target attach retry: the gateway acks Target.createTarget and then
// attaches the new tab; puppeteer hard-waits 30s (waitForTarget default) for the
// synthesized attachedToTarget. If the extension socket flaps between the two,
// retry while the socket settles — bounded a few seconds under the 30s wait so
// the ack is never the thing that hangs.
const CREATOR_ATTACH_ATTEMPTS = 4;
const CREATOR_ATTACH_RETRY_MS = 750;

function log(message, ...args) {
  console.error(`[relay] ${message}`, ...args);
}

function sendJson(ws, message) {
  if (!ws || ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function isPageTarget(targetInfo) {
  return Boolean(targetInfo && (targetInfo.type === "page" || targetInfo.type === "tab"));
}

function freshPin() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function clientSessions(client) {
  if (!client.sessionForTarget) client.sessionForTarget = new Map();
  return client.sessionForTarget;
}

/**
 * Domain-enable semantics for the shared tab debugger.
 *
 * On real Chrome every CDP session has its own domain state, so a fresh
 * session's `Runtime.enable` reports every existing execution context
 * (`Runtime.executionContextCreated`). The extension instead multiplexes all
 * logical sessions for a tab onto ONE chrome.debugger attachment, and that
 * attachment outlives gateway clients, extension socket flaps, and navigator
 * restarts. Chrome only reports existing state on the disabled → enabled
 * transition, so a new session's `X.enable` on an already-enabled debugger is a
 * silent no-op: puppeteer never learns the main-world context and every
 * `page.evaluate` waits for it forever (Runtime.evaluate hung after a restart
 * while a raw context-less Target.sendCommand Runtime.evaluate still worked).
 *
 * For the domains listed here the gateway resets the domain on the shared
 * debugger before forwarding the enable, so each logical session observes the
 * state a dedicated session would. Add a domain only when its enable replays
 * existing state that clients depend on and its disable is harmless to the
 * other sessions sharing the debugger.
 */
class SharedDebuggerDomains {
  static #RESET_BEFORE_ENABLE = new Map([
    // executionContextCreated for every live context (puppeteer main/isolated worlds)
    ["Runtime.enable", "Runtime.disable"]
  ]);

  /** @returns {string|null} the reset command to send before `method`, if any */
  static resetBefore(method) {
    return SharedDebuggerDomains.#RESET_BEFORE_ENABLE.get(method) || null;
  }
}

/**
 * WebSocket close codes the relay sends. This table is the protocol contract
 * with the extensions (chrome-extension and firefox-extension
 * core/connection-manager.js mirror it). It is the only place these numbers
 * are defined on the server side.
 *
 * | code | name             | sent to   | the extension then                          |
 * |------|------------------|-----------|---------------------------------------------|
 * | 4000 | PIN_REJECTED     | /relay    | stops; keeps its previous pairing (no retry) |
 * | 4001 | INVALID_TOKEN    | /relay    | drops its token, re-pairs with a fresh PIN   |
 * | 4003 | NOT_CONNECTED    | /browser  | (gateway client) browser is not connected    |
 * | 4004 | FORGOTTEN        | /relay    | drops its token, stops                       |
 * | 4005 | REMOVED          | /relay    | drops its token, stops (name tombstoned)     |
 * | 4006 | NAME_COLLISION   | /relay    | drops its token, stops (name is direct-CDP)  |
 * | 4007 | HELLO_TIMEOUT    | /relay    | reconnects with backoff                      |
 * | 4008 | PROTOCOL_ERROR   | /relay    | reconnects with backoff                      |
 * | 4009 | SUPERSEDED       | /relay    | stops; another connection took the pairing   |
 *
 * 4000 is reserved for PIN failures. Transient handshake problems
 * (timeout, malformed hello) use the reconnectable 4007/4008: extensions
 * older than chrome 0.4.5 / firefox 0.2.3 treat any unknown code as
 * "reconnect", so these stay backward compatible.
 */
export const RelayCloseCode = Object.freeze({
  PIN_REJECTED: 4000,
  INVALID_TOKEN: 4001,
  NOT_CONNECTED: 4003,
  FORGOTTEN: 4004,
  REMOVED: 4005,
  NAME_COLLISION: 4006,
  HELLO_TIMEOUT: 4007,
  PROTOCOL_ERROR: 4008,
  SUPERSEDED: 4009
});

/**
 * A /relay socket that has not authenticated yet. It carries the hello
 * details and, on the PIN path, the pending PIN. It is bound to the browser's
 * registry entry only after a valid session token or the correct PIN
 * (RelayServer._bindExtension), so an unauthenticated peer that merely knows
 * a browser's name cannot replace, flip or tear down that browser's live
 * entry.
 */
class ExtensionHandshake {
  constructor(ws) {
    this.ws = ws;
    this.name = null; // set by the hello
    this.platform = null;
    this.extensionVersion = null;
    this.bidiOrigin = null;
    // undefined = the hello carried no description (old extension: keep the stored one)
    this.description = undefined;
    this.sessionToken = ""; // presented token, "" = PIN path
    this.pin = null; // { pin, expiresAt } while a PIN pairing is pending
    this.closed = false; // the server has rejected this socket; ignore anything it still sends
    this._helloTimer = null;
  }

  get greeted() {
    return this.name !== null;
  }

  /** Record the hello. Returns an error string when it is unusable. */
  acceptHello(msg) {
    const name = typeof msg.browserName === "string" ? msg.browserName.trim() : "";
    if (!name) return "navigator-hello requires browserName";
    this.name = name;
    if (PLUGIN_PLATFORMS.has(msg.platform)) this.platform = msg.platform;
    if (typeof msg.extensionVersion === "string") this.extensionVersion = msg.extensionVersion;
    // The extension reports the exact "moz-extension://<uuid>" origin its
    // BiDi WebSocket connects from — surfaced via status()/stats so the
    // Remote Agent allow-list (--remote-allow-origins) can be set correctly.
    if (typeof msg.bidiOrigin === "string" && msg.bidiOrigin.startsWith("moz-extension://")) this.bidiOrigin = msg.bidiOrigin;
    // Re-sent on EVERY hello (including a silent token reconnect) so edits
    // made while offline still land — but applied only after authentication.
    if (msg.browserDescription !== undefined) this.description = msg.browserDescription;
    this.sessionToken = typeof msg.sessionToken === "string" ? msg.sessionToken : "";
    this.clearHelloTimer();
    return null;
  }

  startHelloTimer(ms, onTimeout) {
    this.clearHelloTimer();
    this._helloTimer = setTimeout(onTimeout, ms);
    if (this._helloTimer.unref) this._helloTimer.unref();
  }

  clearHelloTimer() {
    if (this._helloTimer) clearTimeout(this._helloTimer);
    this._helloTimer = null;
  }

  issuePin() {
    this.pin = { pin: freshPin(), expiresAt: Date.now() + PIN_EXPIRY_MS };
    return this.pin.pin;
  }

  pinExpired(now = Date.now()) {
    return Boolean(this.pin && now > this.pin.expiresAt);
  }

  close(code, reason) {
    this.closed = true;
    this.clearHelloTimer();
    try { this.ws.close(code, String(reason).slice(0, 120)); } catch {}
  }
}

/**
 * Per-gateway-client ordering of commands forwarded to the extension. Most
 * forwards are synchronous, but some wait first (the shared-domain reset
 * before Runtime.enable). Without a queue, that client's later commands would
 * overtake the held one, e.g. a Runtime.evaluate arriving at the tab before
 * the Runtime.enable it was sent after. Each client has its own queue, so one
 * client's wait never delays another client.
 */
class ClientForwardQueue {
  #tail = Promise.resolve();

  /** Run `step` after every step enqueued before it; resolves/rejects with it. */
  enqueue(step) {
    const run = this.#tail.then(step);
    this.#tail = run.catch(() => {});
    return run;
  }
}

export class RelayServer {
  constructor() {
    this._entries = new Map(); // name -> entry (authenticated extensions only)
    this._pairings = new Map(); // name -> ExtensionHandshake awaiting its PIN (latest request wins)
    this._tokenToName = new Map(); // sessionToken -> name
    this._knownBrowsers = new Map(); // name -> { plugin, firstSeenAt } — durable "has dialed in" registry, survives forget()
    this._meta = new Map(); // name -> { description, updatedAt } — durable user-authored LLM hint, survives disconnect AND restart
    this._tombstones = new Set(); // names explicitly removed (remove()) — blocks dynamic hello re-discovery (plan 60 B6)
    this._configuredRelayNames = new Set(); // current BROWSERS navigator-cdp names — the live authorization set for hellos
    this._configuredDirectNames = new Set(); // current BROWSERS non-relay names — dynamic relays may not claim them (plan 60 B7)
    this._wss = null;
    this._server = null;
    this._host = "127.0.0.1";
    this._port = 0;
    this._nextCommandId = 1;
    this._pendingCommands = new Map(); // globalId -> { clientId, id, marker?, targetId?, resolve? }
    this._heartbeat = null;
  }

  init({ server, host, port, configuredBrowsers, gatewayAuth, navigatorGatewayKey } = {}) {
    if (!server) throw new Error("relay init requires the HTTP server");
    this._server = server;
    if (host) this._host = host;
    if (port) this._port = port;
    this._wss = new WebSocketServer({ noServer: true });
    this._gatewayAuth = typeof gatewayAuth === "function" ? gatewayAuth : null;
    if (navigatorGatewayKey) this._navigatorGatewayKey = String(navigatorGatewayKey);

    // The db helpers are silent no-ops until the database is open, so
    // restoring persisted state here would quietly restore nothing when the
    // relay is mounted before anything called initDb(). initDb() is
    // idempotent, so claiming it here makes this module's persistence
    // self-contained instead of depending on mcp-server's call order.
    try {
      initDb();
    } catch (e) {
      log(`relay database unavailable: ${String(e && e.message)}`);
    }

    // Restore persisted pairings so a navigator restart does not force a
    // re-PIN — the extension reconnects with the same session token.
    // Plan 60 B1: a persisted pairing is only authorized for names that the
    // CURRENT configuration still declares navigator-cdp. A token for a
    // browser removed from BROWSERS is kept in the DB but not restored into
    // the token map, so it cannot silently route traffic after a restart —
    // it presents as recoverable unmanaged state (known, unpaired) until the
    // user explicitly re-PINs (plan 60 §5 restart row). When no browsers
    // config is supplied (standalone relay tests), legacy restore-all applies.
    //
    // Ad-hoc pairings — a browser PIN-paired while it was never listed in
    // BROWSERS — survive restarts too: at runtime the hello gate admits such
    // names, so dropping their token on restart only forced a pointless re-PIN
    // after every deploy. What B1 protects against is a browser that WAS
    // configured and has since been removed. Removal while running already
    // deletes the pairing and tombstones the name (reconcileBrowserChanges →
    // remove()); for a removal made while navigator was down, the previous
    // run's configured names are persisted (RELAY_CONFIGURED_NAMES_KEY), and a
    // name configured then but not now is not restored.
    let previouslyConfigured = new Set();
    let previousKnown = false;
    if (configuredBrowsers) {
      try {
        const raw = getAppState(RELAY_CONFIGURED_NAMES_KEY);
        if (raw) {
          previouslyConfigured = new Set(JSON.parse(raw));
          previousKnown = true;
        }
      } catch {}
    }
    let tombstoned = new Set();
    try { tombstoned = new Set(loadRelayTombstones().map((t) => t.name)); } catch {}
    this.updateConfiguredBrowsers(configuredBrowsers);
    const restoreAllowed = configuredBrowsers
      ? (name) => {
          if (this._configuredRelayNames.has(name)) return true;
          if (this._configuredDirectNames.has(name)) return false; // B7 collision
          if (tombstoned.has(name)) return false; // explicitly removed
          if (previousKnown && previouslyConfigured.has(name)) return false; // removed from BROWSERS while down
          return true; // ad-hoc pairing, never configured
        }
      : () => true;
    try {
      const sessions = loadRelaySessions();
      let restored = 0;
      let retained = 0;
      for (const s of sessions) {
        if (restoreAllowed(s.name)) {
          this._tokenToName.set(s.session_token, s.name);
          restored++;
        } else {
          retained++;
        }
      }
      if (restored || retained) {
        log(`restored ${restored} persisted relay session(s)` + (retained ? `, retained ${retained} unconfigured pairing(s) un-authorized` : ""));
      }
    } catch (e) {
      log(`restore relay sessions skipped: ${String(e && e.message)}`);
    }

    try {
      const known = loadKnownRelayBrowsers();
      for (const k of known) {
        this._knownBrowsers.set(k.name, { plugin: k.plugin || "auto", firstSeenAt: k.first_seen_at || Date.now() });
      }
      if (known.length) log(`restored ${known.length} known relay browser(s)`);
    } catch (e) {
      log(`restore known relay browsers skipped: ${String(e && e.message)}`);
    }

    // Descriptions are hydrated up front so a paired-but-disconnected browser
    // still tells the agent what it is for, before any extension reconnects.
    try {
      const metas = loadRelayBrowserMetas();
      for (const m of metas) {
        this._meta.set(m.name, { description: m.description || "", updatedAt: m.updated_at || Date.now() });
      }
      if (metas.length) log(`restored ${metas.length} relay browser description(s)`);
    } catch (e) {
      log(`restore relay browser descriptions skipped: ${String(e && e.message)}`);
    }

    // Plan 60 B6: removal tombstones are durable — a restart must keep
    // rejecting hellos for names the user explicitly removed, otherwise the
    // whole protection evaporates on the first container restart.
    try {
      const tombs = loadRelayTombstones();
      for (const t of tombs) this._tombstones.add(t.name);
      if (tombs.length) log(`restored ${tombs.length} relay removal tombstone(s)`);
    } catch (e) {
      log(`restore relay tombstones skipped: ${String(e && e.message)}`);
    }

    server.on("upgrade", (req, socket, head) => {
      this._handleUpgrade(req, socket, head);
    });

    if (this._heartbeat) clearInterval(this._heartbeat);
    this._heartbeat = setInterval(() => this._heartbeatTick(), HEARTBEAT_INTERVAL_MS);
    if (this._heartbeat.unref) this._heartbeat.unref();

    log(`mounted: /relay (extensions) + /browser/<name> (pure CDP, host=${this._host} port=${this._port})`);
  }

  gatewayWsUrl(name, key = null) {
    const base = `ws://${this._host}:${this._port}/browser/${encodeURIComponent(name)}`;
    const useKey = key || this._navigatorGatewayKey;
    if (!useKey) return base;
    try {
      const u = new URL(base);
      u.searchParams.set("key", String(useKey));
      return u.toString();
    } catch {
      return `${base}?key=${encodeURIComponent(String(useKey))}`;
    }
  }

  // ---- Registry access for BrowserManager --------------------------------

  isConnected(name) {
    const entry = this._entries.get(name);
    return Boolean(entry && entry.status === "connected" && entry.ws && entry.ws.readyState === entry.ws.OPEN);
  }

  /**
   * A PIN pairing is waiting for the user. An expired PIN is not pending: the
   * previous pairing (if any) stays valid and no "expired" UI is shown. The
   * heartbeat sweep closes expired pairings.
   */
  isPending(name) {
    const pairing = this._pairings.get(name);
    return Boolean(pairing && !pairing.pinExpired());
  }

  isPaired(name) {
    if (!name) return false;
    for (const pairedName of this._tokenToName.values()) {
      if (pairedName === name) return true;
    }
    return false;
  }

  /**
   * Clear a pairing only — session token, live connection, and pending-command
   * state. The browser's known-registry row (set the first time it dials in)
   * is KEPT, so the dashboard entry stays visible as "disconnected — not
   * paired" until the browser itself is removed (remove() or a BROWSERS config
   * removal). Forget and Remove are different actions.
   *
   * The owner-authored description is KEPT: it is not part of the pairing (it
   * lives in relay_browser_meta, not relay_sessions), so re-pairing restores
   * the same description the owner wrote.
   */
  forget(name) {
    if (!name) return false;
    const trimmed = String(name).trim();
    if (!trimmed) return false;
    let found = false;
    // Remove from token map (token -> name)
    for (const [token, n] of [...this._tokenToName.entries()]) {
      if (n === trimmed) {
        this._tokenToName.delete(token);
        found = true;
      }
    }
    // Remove from live entries (close ws if connected). FORGOTTEN (4004),
    // not PIN_REJECTED (4000, "revert to your previous pairing and keep the
    // token"): a forgotten browser must drop its stored pairing material and
    // stop, otherwise it reconnects with a token the server no longer honors
    // (plan 60 B2).
    const entry = this._entries.get(trimmed);
    if (entry) {
      found = true;
      try {
        if (entry.ws && entry.ws.readyState === entry.ws.OPEN) entry.ws.close(RelayCloseCode.FORGOTTEN, "forget");
      } catch {}
      this._teardownEntry(entry);
    }
    // A PIN pairing still waiting for this name is cancelled the same way.
    const pairing = this._pairings.get(trimmed);
    if (pairing) {
      found = true;
      this._pairings.delete(trimmed);
      pairing.close(RelayCloseCode.FORGOTTEN, "forget");
    }
    // Remove from DB (persisted pairing). The description is deliberately
    // KEPT: it is not part of the pairing, and Forget answers "drop the
    // pairing", not "forget who this browser is". remove() owns the deletion.
    try {
      if (deleteRelaySession(trimmed)) found = true;
    } catch {}
    return found;
  }

  /**
   * Full removal — forget() the pairing, drop the browser from the known
   * registry so its dashboard row disappears entirely, and delete its
   * owner-authored description with it. Used for dynamic (unconfigured)
   * browsers the user explicitly removes, and by BROWSERS config
   * reconciliation when an entry is deleted (so it cannot linger as a
   * dynamic driver). Deleting a configured browser is always a config action;
   * the reconciliation path calls this.
   */
  remove(name) {
    if (!name) return false;
    const trimmed = String(name).trim();
    if (!trimmed) return false;
    const hadKnown = this._knownBrowsers.delete(trimmed);
    const found = this.forget(trimmed);
    try {
      deleteKnownRelayBrowser(trimmed);
    } catch {}
    // Gone for good: the known row, the pairing, and what it said about itself.
    this._meta.delete(trimmed);
    try {
      deleteRelayBrowserMeta(trimmed);
    } catch {}
    // Plan 60 B6: explicit removal also tombstones the name. forget() never
    // does — a forgotten browser keeps its row and its re-PIN path; remove()
    // means "this browser should not come back on its own", so a later
    // unconfigured hello is rejected instead of recreating a dynamic row.
    // Re-adding the name to BROWSERS re-authorizes it (the gate checks the
    // configured set first).
    this._tombstones.add(trimmed);
    try {
      saveRelayTombstone(trimmed);
    } catch (e) {
      log(`persist tombstone for "${trimmed}" failed`, String(e && e.message));
    }
    return found || hadKnown;
  }

  /**
   * Refresh the live authorization set used by the hello admission gate
   * (plan 60 B6). Called from init() and from BROWSERS reconciliation, so
   * console saves, external edits, reset, and revert all keep the gate in
   * sync with the canonical config.
   */
  updateConfiguredBrowsers(browsers) {
    const list = browsers || [];
    this._configuredRelayNames = new Set(list.filter((b) => b && b.type === "navigator-cdp").map((b) => b.name));
    this._configuredDirectNames = new Set(list.filter((b) => b && b.type !== "navigator-cdp").map((b) => b.name));
    // Remember which relay names this run treats as configured, so the next
    // startup can tell "removed from BROWSERS while down" from "ad-hoc".
    if (browsers) {
      try { setAppState(RELAY_CONFIGURED_NAMES_KEY, JSON.stringify([...this._configuredRelayNames])); } catch {}
    }
    // Plan 60 B7: a live dynamic relay must not keep a name the config now
    // owns as a direct browser — otherwise its gateway still routes commands
    // to the replaced browser while the dashboard/routing reads the direct
    // add-on. Evict the pairing (forget: keeps the known row for the record,
    // closes the socket with 4004); the hello gate then refuses the name
    // (4006) so the conflict cannot be recreated.
    for (const name of new Set([...this._entries.keys(), ...this._pairings.keys()])) {
      if (this._configuredDirectNames.has(name)) {
        log(`evicting dynamic relay "${name}" — collision with configured direct-CDP browser`);
        this.forget(name);
      }
    }
  }

  /**
   * Hello admission policy (plan 60 B6/B7): dynamic discovery is valid only
   * for names the current config authorizes as navigator-cdp, or names the
   * user has never explicitly removed. A name the config owns as a direct
   * browser (plain cdp / builtin) is a collision and is refused too. remove()
   * writes the tombstone; forget() deliberately does not.
   */
  _discoverable(name) {
    if (this._configuredRelayNames.has(name)) return true;
    if (this._configuredDirectNames.has(name)) return false; // plan 60 B7 — collision with a configured direct browser
    return !this._tombstones.has(name);
  }

  /** Durable "this browser has dialed in" marker — feeds getStatusEntries so a
   *  forgotten/unpaired browser stays listed until remove()d. */
  _rememberKnown(name, plugin) {
    if (!name || this._knownBrowsers.has(name)) return;
    const meta = { plugin: plugin || "auto", firstSeenAt: Date.now() };
    this._knownBrowsers.set(name, meta);
    try {
      saveKnownRelayBrowser(name, meta.plugin);
    } catch (e) {
      log(`persist known relay browser "${name}" failed`, String(e && e.message));
    }
  }

  /**
   * The user-authored, LLM-facing description for a relay browser. Returns ""
   * when the browser has never set one — the caller decides how to present
   * "no description" (the console-configured BROWSERS prompt is the fallback).
   */
  getDescription(name) {
    return this._meta.get(name)?.description || "";
  }

  /**
   * Persist a description typed in the extension's own popup. Returns
   * { ok, description } — a bad value is rejected but never throws and never
   * drops the connection; the previous value is kept.
   */
  setDescription(name, raw) {
    const trimmed = String(name || "").trim();
    if (!trimmed) return { ok: false, error: "name required" };
    const raw0 = raw === undefined || raw === null ? "" : String(raw);
    // Control characters are meaningless to the model and can corrupt log lines.
    // eslint-disable-next-line no-control-regex -- matching them is the point
    const cleaned = raw0.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
    if (cleaned.length > DESCRIPTION_MAX_CHARS) {
      return { ok: false, error: `description must be ${DESCRIPTION_MAX_CHARS} characters or fewer` };
    }
    const updatedAt = Date.now();
    this._meta.set(trimmed, { description: cleaned, updatedAt });
    const entry = this._entries.get(trimmed);
    if (entry) {
      entry.description = cleaned;
      entry.descriptionUpdatedAt = updatedAt;
    }
    try {
      saveRelayBrowserMeta(trimmed, cleaned, updatedAt);
    } catch (e) {
      log(`persist description for "${trimmed}" failed`, String(e && e.message));
    }
    return { ok: true, description: cleaned, updatedAt };
  }

  /**
   * Live registry entry for a relay browser. Unlike getStatusEntries() (a
   * projection with no tabs), this returns the tracked entry object including
   * `tabs`, `tabIdToTarget`, `clients`, `connectedAt`, `extensionVersion`.
   * Returns null when the name was never registered.
   */
  getEntry(name) {
    return this._entries.get(name) || null;
  }

  /**
   * Tabs for a relay browser, refreshed only when the cached list is older
   * than `maxAgeMs`, and never waiting longer than `waitMs` for the extension.
   * For snapshot callers (Target.getTargets) that must not stall on a slow
   * browser but also must not report a list from minutes ago. Extensions
   * since chrome 0.4.4 / firefox 0.2.2 push on every tab change, so the cache
   * is normally fresh and this returns immediately.
   * @param {string} name
   * @param {{maxAgeMs?: number, waitMs?: number}} [opts]
   * @returns {Promise<Array>}
   */
  async freshTabList(name, { maxAgeMs = 2_000, waitMs = 1_500 } = {}) {
    const entry = this._entries.get(name);
    if (!entry) return [];
    if (!this._canSend(entry) || Date.now() - (entry.tabsAt || 0) < maxAgeMs) return entry.tabs.slice();
    let timer;
    const cached = new Promise((resolve) => { timer = setTimeout(() => resolve(entry.tabs.slice()), waitMs); });
    try {
      return await Promise.race([this.refreshTabList(name), cached]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Ask the extension for a fresh tab list for a relay browser, then resolve
   * with the updated entry.tabs. Used by callers that must see user-opened
   * tabs immediately instead of a stale cache.
   * @param {string} name
   * @returns {Promise<Array>} the (possibly unchanged) tabs for that entry
   */
  async refreshTabList(name) {
    const entry = this._entries.get(name);
    if (!entry) return [];
    if (!this._canSend(entry)) return entry.tabs.slice();
    try {
      return await this._requestTabList(entry);
    } catch {
      return entry.tabs.slice();
    }
  }

  /**
   * Normalized status entries merged over configured BROWSERS entries.
   * `configured` = config.browsers (each {name, role, cdpUrl, type, plugin, addOn}).
   * Pre-declared navigator-cdp entries keep their configured roles/order;
   * dynamic registrations (extension name not configured) get role ["default"]
   * and are appended after configured add-ons.
   */
  getStatusEntries(configured = []) {
    const out = [];
    const configByRelayName = new Map();
    for (const cfg of configured || []) {
      if (cfg && cfg.addOn) configByRelayName.set(cfg.name, cfg);
    }

    for (const cfg of configured || []) {
      if (!cfg || !cfg.addOn) continue;
      if (cfg.type === "navigator-cdp") {
        const st = this._statusFor({ ...cfg, configured: true });
        out.push(st);
      } else {
        out.push({
          name: cfg.name,
          type: "cdp",
          plugin: "auto",
          status: "available",
          role: cfg.role || [],
          cdpUrl: cfg.cdpUrl,
          configured: true,
          dynamic: false,
          connectedAt: null
        });
      }
    }

    for (const [name, entry] of this._entries) {
      const cfg = configByRelayName.get(name);
      if (cfg) continue; // already emitted above
      out.push(this._statusFor({ name, role: ["default"], type: "navigator-cdp", plugin: entry.plugin, configured: false }));
    }

    // Paired but no live entry (disconnected dynamic browsers) — keep visible
    // as "paired — disconnected" so a manual Disconnect doesn't look like
    // "not paired". User asked to "show all" and have a remove button.
    const seen = new Set(out.map((b) => b.name));
    for (const pairedName of new Set(this._tokenToName.values())) {
      if (seen.has(pairedName)) continue;
      if (configByRelayName.has(pairedName)) continue;
      if (this._entries.has(pairedName)) continue;
      out.push(this._statusFor({ name: pairedName, role: ["default"], type: "navigator-cdp", plugin: "auto", configured: false }));
      seen.add(pairedName);
    }

    // Known but never-configured (dynamic) relay browsers that are not live
    // and not paired — emitted as "disconnected — not paired". forget() clears
    // only the pairing, so the row survives until remove() or a BROWSERS
    // config removal deletes it from the known registry.
    for (const knownName of new Set(this._knownBrowsers.keys())) {
      if (seen.has(knownName)) continue;
      if (configByRelayName.has(knownName)) continue;
      if (this._entries.has(knownName)) continue;
      const known = this._knownBrowsers.get(knownName);
      out.push(this._statusFor({ name: knownName, role: ["default"], type: "navigator-cdp", plugin: known?.plugin || "auto", configured: false }));
      seen.add(knownName);
    }
    return out;
  }

  /**
   * Status projection for one relay browser. Read-only: expired PIN pairings
   * are swept by the heartbeat, never by a status read.
   */
  _statusFor(cfg) {
    const name = cfg.name;
    const entry = this._entries.get(name);
    const connected = this.isConnected(name);
    const pending = this.isPending(name);
    const pairing = pending ? this._pairings.get(name) : null;
    return {
      name,
      type: "navigator-cdp",
      plugin: entry?.platform || pairing?.platform || entry?.plugin || cfg.plugin || "auto",
      status: connected ? "connected" : pending ? "auth_pending" : "disconnected",
      paired: this.isPaired(name),
      role: cfg.role || [],
      configured: Boolean(cfg.configured),
      dynamic: !cfg.configured,
      cdpUrl: connected ? this.gatewayWsUrl(name) : null,
      connectedAt: entry?.connectedAt || null,
      extensionVersion: entry?.extensionVersion || pairing?.extensionVersion || null,
      bidiOrigin: entry?.bidiOrigin || pairing?.bidiOrigin || null,
      // The browser's own words first; the live entry is the writer of truth
      // when connected, the durable map covers every offline case.
      description: entry?.description ?? this.getDescription(name),
      descriptionUpdatedAt: entry?.descriptionUpdatedAt ?? this._meta.get(name)?.updatedAt ?? null,
      // A pending pairing's PIN is shown even while an older socket for the
      // same name still counts as connected, so the user can complete a
      // re-pair that replaces it.
      pin: pairing ? pairing.pin.pin : null,
      pinExpiresAt: pairing ? pairing.pin.expiresAt : null
    };
  }

  // ---- HTTP upgrade dispatch ---------------------------------------------

  _handleUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    // /cdp/* is owned by the authenticated external CDP surface
    // (src/cdp-share.js, plan 55) — never destroy those sockets here.
    if (url.pathname === "/cdp" || url.pathname.startsWith("/cdp/")) return;
    if (url.pathname === "/relay") {
      this._handleExtensionUpgrade(req, socket, head);
      return;
    }
    const match = url.pathname.match(/^\/browser\/([^/]+)$/);
    if (match) {
      this._handleGatewayUpgrade(decodeURIComponent(match[1]), req, socket, head);
      return;
    }
    socket.destroy();
  }

  _handleExtensionUpgrade(req, socket, head) {
    this._wss.handleUpgrade(req, socket, head, (ws) => {
      this._handleExtension(ws);
    });
  }

  _handleGatewayUpgrade(name, req, socket, head) {
    let url;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    if (typeof this._gatewayAuth === "function") {
      const result = this._gatewayAuth(req, url);
      if (result && result.status) {
        this._writeUpgradeError(socket, result.status, result.error);
        return;
      }
    }
    this._wss.handleUpgrade(req, socket, head, (ws) => {
      this.attachGatewayClient(name, ws);
    });
  }

  _writeUpgradeError(socket, status, message) {
    const reason = { 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 429: "Too Many Requests", 502: "Bad Gateway" }[status] || "Error";
    const body = JSON.stringify({ ok: false, error: message });
    try {
      socket.write(
        `HTTP/1.1 ${status} ${reason}\r\n` +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "Connection: close\r\n\r\n" +
        body
      );
    } catch {}
    try { socket.destroy(); } catch {}
  }

  // ---- Extension side (/relay) -------------------------------------------

  /**
   * One /relay socket. Until it authenticates, every message goes to the
   * handshake (hello, then a session token or a PIN); the registry entry is
   * not touched. Once authenticated the socket is bound to the entry and its
   * messages are connected traffic — for as long as it is still the entry's
   * socket (a superseded or torn-down socket's late frames are dropped).
   */
  _handleExtension(ws) {
    const handshake = new ExtensionHandshake(ws);
    let entry = null;

    handshake.startHelloTimer(HELLO_TIMEOUT_MS, () => {
      if (!handshake.greeted) handshake.close(RelayCloseCode.HELLO_TIMEOUT, "hello timeout");
    });

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (!entry) {
        entry = this._onHandshakeMessage(handshake, msg);
        return;
      }
      if (entry.ws !== ws || this._entries.get(entry.name) !== entry) return;
      entry.lastActivity = Date.now();
      this._onExtensionMessage(entry, msg);
    });

    ws.on("close", () => {
      handshake.clearHelloTimer();
      if (handshake.greeted && this._pairings.get(handshake.name) === handshake) this._pairings.delete(handshake.name);
      if (entry && entry.ws === ws) {
        log(`extension "${entry.name}" disconnected`);
        this._teardownEntry(entry);
      }
    });

    ws.on("error", () => {
      try { ws.close(); } catch {}
    });
  }

  /**
   * Pre-authentication traffic: the hello, then either a session token check
   * or a PIN exchange. Returns the bound entry once the socket authenticated,
   * else null. Nothing here mutates a live entry before authentication.
   */
  _onHandshakeMessage(handshake, msg) {
    if (handshake.closed) return null;
    if (!handshake.greeted) {
      if (msg.type !== "navigator-hello") return null;
      const problem = handshake.acceptHello(msg);
      if (problem) {
        handshake.close(RelayCloseCode.PROTOCOL_ERROR, problem);
        return null;
      }
      const name = handshake.name;
      // Plan 60 B6/B7 — hello admission gate: a name the user explicitly
      // removed (4005) or that the config owns as a direct-CDP browser (4006)
      // is rejected before any known-row is created, so it cannot
      // re-materialize as a dynamic browser.
      if (!this._discoverable(name)) {
        if (this._configuredDirectNames.has(name)) {
          log(`extension "${name}" rejected — name is configured as a direct-CDP browser (plan 60 B7)`);
          handshake.close(RelayCloseCode.NAME_COLLISION, "configured as direct browser");
        } else {
          log(`extension "${name}" rejected — name was removed from navigator (tombstone)`);
          handshake.close(RelayCloseCode.REMOVED, "removed by navigator");
        }
        return null;
      }
      this._rememberKnown(name, handshake.platform);

      if (handshake.sessionToken) {
        if (this._tokenToName.get(handshake.sessionToken) !== name) {
          // A token that is stale or belongs to a different browser is a
          // state leak, not a new pairing — reject this socket only. The live
          // entry (if any) is not this socket's to disturb.
          log(`extension "${name}" presented an invalid/expired session token`);
          handshake.close(RelayCloseCode.INVALID_TOKEN, "invalid session token");
          return null;
        }
        log(`extension "${name}" reconnected with valid session token`);
        const entry = this._bindExtension(handshake);
        sendJson(entry.ws, { type: "connected", sessionToken: handshake.sessionToken });
        this._applyHelloDescription(entry, handshake);
        this._onPairingComplete(entry);
        return entry;
      }

      this._beginPinPairing(handshake);
      return null;
    }

    if (msg.type !== "pin") return null;
    const name = handshake.name;
    if (!handshake.pin || this._pairings.get(name) !== handshake) {
      handshake.close(RelayCloseCode.PROTOCOL_ERROR, "No pending PIN");
      return null;
    }
    if (handshake.pinExpired()) {
      this._pairings.delete(name);
      log(`extension "${name}" PIN expired`);
      handshake.close(RelayCloseCode.PIN_REJECTED, "PIN expired");
      return null;
    }
    if (String(msg.pin) !== handshake.pin.pin) {
      this._pairings.delete(name);
      log(`extension "${name}" submitted wrong PIN`);
      handshake.close(RelayCloseCode.PIN_REJECTED, "Invalid PIN");
      return null;
    }
    this._pairings.delete(name);
    handshake.pin = null;
    const entry = this._bindExtension(handshake);
    entry.sessionToken = randomUUID().replace(/-/g, "");
    this._tokenToName.set(entry.sessionToken, name);
    try {
      saveRelaySession(name, entry.sessionToken);
    } catch (e) {
      log(`persist session for "${name}" failed`, String(e && e.message));
    }
    log(`extension "${name}" PIN accepted`);
    sendJson(entry.ws, { type: "pin_accepted" });
    sendJson(entry.ws, { type: "connected", sessionToken: entry.sessionToken });
    this._applyHelloDescription(entry, handshake);
    this._onPairingComplete(entry);
    return entry;
  }

  /**
   * Issue a PIN for a token-less hello. The newest request for a name wins;
   * an older socket still waiting on its PIN is closed with PIN_REJECTED so it
   * reverts to its previous pairing instead of typing a PIN that no longer
   * exists.
   */
  _beginPinPairing(handshake) {
    const name = handshake.name;
    const previous = this._pairings.get(name);
    if (previous && previous !== handshake) previous.close(RelayCloseCode.PIN_REJECTED, "PIN request superseded");
    const pin = handshake.issuePin();
    this._pairings.set(name, handshake);
    this._printPin(name, pin);
    sendJson(handshake.ws, { type: "pin_required" });
  }

  /**
   * Make an authenticated handshake the browser's live connection. An older
   * socket still bound to the entry (a reconnect the server has not noticed
   * dropping, or a second instance) is closed with SUPERSEDED; its close
   * handler then sees it is no longer the entry's socket and leaves the
   * entry, its gateway clients and their sessions intact.
   */
  _bindExtension(handshake) {
    const entry = this._ensureEntry(handshake.name);
    const previous = entry.ws;
    entry.ws = handshake.ws;
    if (previous && previous !== handshake.ws) {
      log(`extension "${entry.name}" — replacing the previous connection`);
      try { previous.close(RelayCloseCode.SUPERSEDED, "replaced by a newer connection"); } catch {}
    }
    if (handshake.platform) entry.platform = handshake.platform;
    if (handshake.extensionVersion) entry.extensionVersion = handshake.extensionVersion;
    if (handshake.bidiOrigin) entry.bidiOrigin = handshake.bidiOrigin;
    entry.status = "connected";
    entry.connectedAt = Date.now();
    entry.lastActivity = Date.now();
    return entry;
  }

  /**
   * A description that rode along on the hello is written only now that the
   * socket has authenticated — otherwise an unauthenticated peer that merely
   * knows a browser's name could rewrite that browser's description.
   */
  _applyHelloDescription(entry, handshake) {
    if (handshake.description === undefined) return;
    const applied = this.setDescription(entry.name, handshake.description);
    if (!applied.ok) {
      log(`extension "${entry.name}" description rejected: ${applied.error}`);
      sendJson(entry.ws, { type: "description_error", error: applied.error });
    }
    handshake.description = undefined;
  }

  /** Traffic from an authenticated extension socket. */
  _onExtensionMessage(entry, msg) {
    const name = entry.name;
    const ws = entry.ws;

    // ---- live description update -------------------------------------------
    // The popup lets the owner re-word their browser while it stays paired
    // and connected — no re-PIN, no reconnect. The channel is already
    // authenticated by the session token.
    if (msg.type === "update_description") {
      const applied = this.setDescription(name, msg.description);
      if (applied.ok) {
        log(`extension "${name}" description updated`);
        sendJson(ws, { type: "description_updated", description: applied.description });
      } else {
        log(`extension "${name}" description update rejected: ${applied.error}`);
        sendJson(ws, { type: "description_error", error: applied.error });
      }
      return;
    }

    if (msg.type === "ping") {
      sendJson(ws, { type: "pong" });
      return;
    }
    if (msg.type === "pong") return;
    if (msg.type === "tab_list" && Array.isArray(msg.tabs)) {
      this._onTabList(entry, msg.tabs);
      return;
    }
    if (msg.type === "tab_detached" && msg.tabId != null) {
      this._onTabDetached(entry, msg);
      return;
    }
    if (msg.type === "cdp_event" && typeof msg.method === "string") {
      this._onCdpEvent(entry, msg);
      return;
    }
    if (typeof msg.type === "undefined" && typeof msg.id === "number") {
      this._onCdpResponse(entry, msg);
      return;
    }
    if (msg.type === "detach_all_result") {
      log(`extension "${name}" detach_all done (success=${Boolean(msg.success)})`);
    }
  }

  /**
   * Extension's chrome.debugger.onDetach — the user closed the "started
   * debugging this browser" banner (canceled_by_user) or a tab was closed.
   * Purge the stale session maps so the next _ensureTargetSession creates a
   * fresh chrome.debugger.attach instead of replaying the dead sessionId
   * ("Tab not attached").
   *
   * BEFORE clearing the maps, forward a session-scoped
   * Target.detachedFromTarget to every client tracking the target — that
   * event is what resolves puppeteer's page.close() (TargetManager listens on
   * the session), and this is the only moment the sessionId is still known:
   * once the maps are purged here, the later _diffTabs can only emit
   * destroy-without-detach and page.close() hangs forever.
   */
  _onTabDetached(entry, msg) {
    const name = entry.name;
    const tabIdStr = String(msg.tabId);
    const notifyAndForget = (targetId) => {
      for (const client of [...entry.clients.values()]) {
        const cs = client.sessionForTarget;
        if (cs && cs.has(targetId)) {
          this._emitToClient(client, {
            method: "Target.detachedFromTarget",
            params: { sessionId: cs.get(targetId), targetId }
          });
          log(`[relay] tab_detached: emitting detachedFromTarget session=${cs.get(targetId)} (client ${client.id})`);
          cs.delete(targetId);
        }
      }
    };
    const targetId = entry.tabIdToTarget.get(tabIdStr);
    if (targetId) {
      const sess = entry.sessionForTarget.get(targetId);
      if (sess) {
        notifyAndForget(targetId);
        entry.sessionForTarget.delete(targetId);
        entry.extSessionToTarget.delete(sess);
        log(`extension "${name}" detached tab ${msg.tabId} (target ${targetId}) reason=${msg.reason || ""} — cleared stale session`);
      }
      return;
    }
    // No targetId mapping yet (tab list race) — still clear any session that
    // was mapped via extSessionToTarget → tabId.
    for (const [sess, tid] of [...entry.extSessionToTarget.entries()]) {
      const mappedTab = [...entry.tabIdToTarget.entries()].find(([, v]) => v === tid)?.[0];
      if (mappedTab !== tabIdStr) continue;
      notifyAndForget(tid);
      entry.sessionForTarget.delete(tid);
      entry.extSessionToTarget.delete(sess);
      log(`extension "${name}" detached tab ${msg.tabId} (session ${sess}) — cleared stale session (fallback)`);
      break;
    }
  }

  /**
   * The registry entry for an authenticated browser — created by
   * _bindExtension only, so every entry in `_entries` is an authenticated
   * connection (pending PIN pairings live in `_pairings`).
   */
  _ensureEntry(name) {
    let entry = this._entries.get(name);
    if (!entry) {
      const meta = this._meta.get(name);
      entry = {
        name,
        plugin: "auto",
        platform: null,
        extensionVersion: null,
        bidiOrigin: null,
        status: "connected",
        ws: null,
        connectedAt: null,
        sessionToken: null,
        tornDown: false,
        // Carry the durable description onto a fresh live entry so a browser
        // that reconnects with an old extension (no browserDescription field)
        // keeps the description it set earlier.
        description: meta?.description || "",
        descriptionUpdatedAt: meta?.updatedAt || null,
        tabs: [],
        tabWaiters: [],
        sessionForTarget: new Map(), // targetId -> extSessionId
        extSessionToTarget: new Map(), // extSessionId -> targetId
        tabIdToTarget: new Map(),
        clients: new Map(), // gatewayClientId -> client
        lastActivity: Date.now()
      };
      this._entries.set(name, entry);
    }
    return entry;
  }

  /**
   * Drop an entry and fail everything waiting on it. Idempotent: forget() and
   * the heartbeat tear down synchronously and the socket's close event
   * arrives later; the second call must not touch a newer entry that has
   * since registered under the same name.
   */
  _teardownEntry(entry) {
    if (entry.tornDown) return;
    entry.tornDown = true;
    // Flush every pending command for THIS entry's clients so gateway clients
    // (puppeteer) get clean "browser disconnected" errors instead of hanging
    // until their own timeout. The pending map is instance-level
    // (this._pendingCommands) — match by gateway clientId, or by the entryName
    // tag carried on attach / sendCommand pendings (which have clientId null).
    for (const [id, pending] of [...this._pendingCommands]) {
      if (pending.entryName && pending.entryName !== entry.name) continue;
      if (pending.clientId != null && !entry.clients.has(pending.clientId)) continue;
      this._pendingCommands.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.marker === "attach") {
        pending.resolve({ sessionId: null, reason: `browser "${entry.name}" disconnected while attaching target ${pending.targetId}` });
        continue;
      }
      if (pending.reject) {
        pending.reject(new Error(`browser "${entry.name}" disconnected`));
        continue;
      }
      if (pending.clientId != null) {
        const client = entry.clients.get(pending.clientId);
        if (client && client.ws.readyState === client.ws.OPEN) {
          this._reply(client, pending.id, null, { code: -32000, message: "browser disconnected" });
        }
      }
    }
    for (const waiter of [...entry.tabWaiters]) {
      waiter();
    }
    for (const client of [...entry.clients.values()]) {
      this._closeGatewayClient(entry, client, "browser disconnected");
    }
    if (this._entries.get(entry.name) === entry) this._entries.delete(entry.name);
  }

  _printPin(name, pin) {
    for (const line of [
      "",
      "┌────────────────────────────────────────────────┐",
      `│  🔐 "${name}" wants to connect                  │`,
      `│     PIN: ${pin}  (expires in 60s)                 │`,
      "│     Enter this PIN in the browser extension.     │",
      "└────────────────────────────────────────────────┘",
      ""
    ]) console.error(line);
  }

  _onPairingComplete(entry) {
    void this._requestTabList(entry);
  }

  // ---- Tab list + target diff machinery ----------------------------------

  _canSend(entry) {
    return Boolean(entry && entry.ws && entry.ws.readyState === entry.ws.OPEN && entry.status === "connected");
  }

  _requestTabList(entry) {
    if (!this._canSend(entry)) return Promise.resolve(entry.tabs.slice());
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const i = entry.tabWaiters.indexOf(finish);
        if (i !== -1) entry.tabWaiters.splice(i, 1);
        resolve(entry.tabs.slice());
      };
      entry.tabWaiters.push(finish);
      sendJson(entry.ws, { type: "list_tabs_request" });
      setTimeout(finish, GATEWAY_WAIT_MS); // never leave puppeteer hanging
    });
  }

  _onTabList(entry, tabs) {
    const incoming = Array.isArray(tabs) ? tabs.slice() : [];
    // Any tab_list is a fresh answer, including an ignored empty one — a
    // browser with no page tabs must not refresh on every getTargets.
    entry.tabsAt = Date.now();
    if (incoming.length === 0 && entry.tabs.length > 0) {
      // A delayed extension response must not turn a populated registry into an
      // empty browser and tear down every client session. A real tab close is
      // reported through tab_detached / Target.closeTarget instead.
      log(`[relay] ignoring empty tab_list from "${entry.name}"; preserving ${entry.tabs.length} known target(s)`);
    } else {
      const incomingIds = new Set(incoming.map((tab) => tab.targetId));
      for (const tab of entry.tabs) {
        // A list snapshot can predate Target.createTarget. Keep an actively
        // attached target until its explicit detach or close confirmation.
        if (entry.sessionForTarget.has(tab.targetId) && !incomingIds.has(tab.targetId)) {
          incoming.push(tab);
        }
      }
      entry.tabs = incoming;
    }
    for (const finish of [...entry.tabWaiters]) finish();
    entry.tabWaiters.length = 0;

    const tabIdToTarget = new Map();
    for (const t of entry.tabs) {
      if (t.tabId != null) tabIdToTarget.set(String(t.tabId), t.targetId);
    }
    entry.tabIdToTarget = tabIdToTarget;

    for (const client of [...entry.clients.values()]) {
      this._diffTabsForClient(entry, client);
    }
  }

  _diffTabsForClient(entry, client) {
    const current = new Map(entry.tabs.map((t) => [t.targetId, t]));
    for (const [targetId] of client.tabs) {
      if (!current.has(targetId)) {
        this._emitToClient(client, { method: "Target.targetDestroyed", params: { targetId } });
        log(`[relay] _diffTabsForClient: emitting targetDestroyed for ${targetId} (client ${client.id})`);
        // Chromium also detaches the session when a target is destroyed — the
        // session-scoped detachedFromTarget is what resolves puppeteer's
        // page.close() (TargetManager's session-level detached listener).
        const session = clientSessions(client).get(targetId);
        if (session) {
          clientSessions(client).delete(targetId);
          this._emitToClient(client, {
            method: "Target.detachedFromTarget",
            params: { sessionId: session, targetId }
          });
          log(`[relay] _diffTabsForClient: emitting detachedFromTarget session=${session} (client ${client.id})`);
        }
      }
    }
    for (const [targetId, info] of current) {
      const prev = client.tabs.get(targetId);
      if (!prev) {
        if (client.discover) {
          this._emitToClient(client, { method: "Target.targetCreated", params: { targetInfo: info } });
        }
      } else if ((prev.url !== info.url || prev.title !== info.title) && client.discover) {
        this._emitToClient(client, { method: "Target.targetInfoChanged", params: { targetInfo: info } });
      }
    }
    client.tabs = current;
  }

  // ---- Gateway (/browser/<name>) -----------------------------------------

  /**
   * Register a WebSocket as a browser-level CDP client of a relay browser.
   * Used by the in-process puppeteer gateway (`/browser/<name>`) and by the
   * authenticated external CDP surface (`/cdp/<name>`, src/cdp-share.js) —
   * one representation of client registration, cannot drift.
   * @param {string} name browser name
   * @param {WebSocket} ws raw WebSocket (a raw CDP socket, not the extension's)
   */
  attachGatewayClient(name, ws) {
    const entry = this._entries.get(name);
    if (!entry || entry.status !== "connected") {
      log(`gateway connect for unknown/disconnected browser "${name}"`);
      try { ws.close(RelayCloseCode.NOT_CONNECTED, "browser not connected"); } catch {}
      return;
    }
    const client = {
      id: randomUUID(),
      ws,
      tabs: new Map(),
      discover: false,
      autoAttach: false,
      browserTargetSent: false,
      forwardQueue: new ClientForwardQueue()
    };
    entry.clients.set(client.id, client);

    log(`puppeteer client connected to "${name}" (${client.id})`);
    sendJson(entry.ws, { type: "client-connected", clientId: client.id });

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!msg || typeof msg.id === "undefined" || typeof msg.method !== "string") return;
      this._onGatewayMessage(entry, client, msg).catch((error) => {
        this._reply(client, msg.id, null, error);
      });
    });

    ws.on("close", () => {
      this._closeGatewayClient(entry, client, "client closed");
    });
    ws.on("error", () => {
      try { ws.close(); } catch {}
    });
  }

  _closeGatewayClient(entry, client, reason) {
    if (!entry.clients.has(client.id)) return;
    entry.clients.delete(client.id);
    log(`puppeteer client ${client.id} for "${entry.name}" closed (${reason})`);
    sendJson(entry.ws, { type: "client-disconnected", clientId: client.id });
    try { client.ws.close(); } catch {}
  }

  _emitToClient(client, message) {
    sendJson(client.ws, message);
  }

  _reply(client, id, result, error, sessionId = null) {
    const msg = { id };
    if (sessionId) msg.sessionId = sessionId;
    if (error) {
      const errObj = error instanceof Error ? error : error && typeof error === "object" ? error : { message: String(error) };
      msg.error = { code: Number.isInteger(errObj.code) ? errObj.code : -32000, message: String(errObj.message || errObj) };
    } else {
      msg.result = result || {};
    }
    sendJson(client.ws, msg);
  }

  async _onGatewayMessage(entry, client, msg) {
    const { id, method, params = {}, sessionId } = msg;

    switch (method) {
      case "Target.setDiscoverTargets": {
        client.discover = Boolean(params.discover);
        this._reply(client, id, {});
        this._emitBrowserTarget(entry, client);
        if (client.discover) {
          void this._requestTabList(entry).then(() => this._diffTabsForClient(entry, client));
        }
        return;
      }
      case "Target.setAutoAttach": {
        client.autoAttach = Boolean(params.autoAttach);
        // Puppeteer sends this both at browser level and through every newly
        // attached page session. Session-scoped replies must keep that session
        // id or CDP drops them as replies for the wrong transport.
        this._reply(client, id, {}, null, sessionId);
        this._emitBrowserTarget(entry, client);
        // Don't mass-attach pages at browser level.  puppeteer v24's TargetManager
        // sends setAutoAttach with filter [{type:'page',exclude:true}] (expects
        // 'tab'-level attachment, which the relay doesn't have).  Mass-attaching
        // all 13+ pages generates a thundering herd of chrome.debugger.attach +
        // attachedToTarget + setAutoAttach + Runtime.runIfWaitingForDebugger per
        // target that overwhelms the extension and blocks goto/close.
        // Pages are discovered via setDiscoverTargets (targetCreated) and attached
        // on-demand when the client sends Target.attachToTarget for a specific tab.
        return;
      }
      case "Target.getTargets": {
        const tabs = await this._requestTabList(entry);
        this._diffTabsForClient(entry, client);
        this._reply(client, id, { targetInfos: tabs.slice() });
        return;
      }
      // Target.getBrowserContexts intentionally falls through to `default` and
      // is forwarded to the extension: when the "open new windows instead of
      // tabs" flag is on, real window-scoped contexts live on the extension
      // side and only it can enumerate them. The reply is sanitized in
      // _onCdpResponse so missing browserContextIds fall back to ["default"].
      case "Target.attachToTarget": {
        await this._handleAttachToTarget(entry, client, id, params);
        return;
      }
      case "Target.detachFromTarget": {
        await this._handleDetachFromTarget(entry, client, id, params);
        return;
      }
      case "Browser.close": {
        // Never let a puppeteer client close the user's real browser.
        this._closeGatewayClient(entry, client, "Browser.close overridden");
        return;
      }
      default: {
        // Forwarded in the order the client sent them, even when one waits
        // for a shared-domain reset first (see ClientForwardQueue).
        const reset = sessionId ? SharedDebuggerDomains.resetBefore(method) : null;
        await client.forwardQueue.enqueue(async () => {
          if (reset) await this._resetSharedDomain(entry, sessionId, reset);
          this._sendExtensionCommand(entry, { id, method, params, sessionId }, client.id);
        });
      }
    }
  }

  /**
   * Reset a domain on the tab's shared debugger so the enable that follows
   * replays existing state (see SharedDebuggerDomains). Best-effort and
   * bounded: a failed or slow reset must never block the client's own enable,
   * which is forwarded either way.
   */
  async _resetSharedDomain(entry, sessionId, method) {
    try {
      const resp = await this.sendCdpCommand(entry.name, { method, sessionId, timeoutMs: GATEWAY_WAIT_MS });
      if (resp.error) log(`${method} before re-enable on session ${sessionId} failed: ${resp.error.message || resp.error.code}`);
    } catch (error) {
      log(`${method} before re-enable on session ${sessionId} failed: ${error?.message || error}`);
    }
  }

  _sendExtensionCommand(entry, { id, method, params, sessionId }, clientId, timeoutMs = RELAY_COMMAND_TIMEOUT_MS) {
    if (!this._canSend(entry)) {
      const client = entry.clients.get(clientId);
      if (client) this._reply(client, id, null, new Error("browser disconnected"));
      return;
    }
    const globalId = this._nextCommandId++;
    const pending = { clientId, id, sessionId, method, params: params || {} };
    this._pendingCommands.set(globalId, pending);
    // Every forwarded command carries a reply deadline so a dropped response
    // (extension flap, suspended SW) surfaces as a clean error to the awaiting
    // client instead of an orphaned pending that outlives the client's wait.
    pending.timer = setTimeout(() => {
      if (!this._pendingCommands.has(globalId)) return;
      this._pendingCommands.delete(globalId);
      log(`[relay] ${method} got no extension reply within ${timeoutMs}ms — replying timeout to client ${clientId}`);
      if (clientId != null) {
        const client = entry.clients.get(clientId);
        if (client && client.ws.readyState === client.ws.OPEN) {
          this._reply(client, id, null, {
            code: -32000,
            message: `${method} timed out on the browser (no reply within ${timeoutMs}ms)`
          });
        }
      }
    }, timeoutMs);
    const msg = { id: globalId, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    sendJson(entry.ws, msg);
  }

  /**
   * Register a just-created target with the gateway registry so a client's
   * immediate Target.attachToTarget / getTargetInfo finds it. Without this,
   * Target.createTarget succeeds but the very next attach fails "Target not
   * found" — the created tab can never be driven (stuck at about:blank).
   */
  _registerCreatedTarget(entry, { targetId, tabId = null, url = "about:blank", browserContextId = "default" } = {}, creatorClientId = null) {
    if (!targetId) return null;
    const info = {
      targetId,
      type: "page",
      title: "",
      url,
      attached: false,
      canAccessOpener: false,
      browserContextId,
      tabId
    };
    const existing = entry.tabs.find((t) => t.targetId === targetId);
    if (existing) Object.assign(existing, info);
    else entry.tabs.push(info);
    if (tabId != null) entry.tabIdToTarget.set(String(tabId), targetId);
    // The creator gets an immediate attachedToTarget (puppeteer waits for it
    // on Target.createTarget); every other client gets the normal
    // targetCreated diff.  This avoids a late-joining client storm. Returns the
    // creator's attach promise (null when no creator attach is pending, so the
    // createTarget ack can go straight out).
    let creatorAttach = null;
    for (const client of [...entry.clients.values()]) {
      if (creatorClientId && client.id === creatorClientId && isPageTarget(info)) {
        creatorAttach = this._attachCreatedTarget(entry, client, info);
      } else {
        this._diffTabsForClient(entry, client);
      }
    }
    return creatorAttach;
  }

  /**
   * Attach a just-created target and emit the synthesized attachedToTarget to
   * its creator. Runs with flap retry: a socket swap during attach (old socket
   * closed but the entry's ws already replaced, so teardown never ran) must not
   * strand the creator — the attach is re-sent on the live socket. On a same-
   * socket attach timeout the tab is genuinely unresponsive, so stop (a retry on
   * the same socket could hit a duplicate-attach error where the first attach
   * actually landed). Bounded a few seconds under puppeteer's 30s waitForTarget.
   *
   * @returns {Promise<boolean>} true when attached and the event was emitted.
   */
  async _attachCreatedTarget(entry, client, info) {
    const name = entry.name;
    const targetId = info.targetId;
    let cur = entry;
    for (let attempt = 0; attempt < CREATOR_ATTACH_ATTEMPTS; attempt++) {
      if (!this._canSend(cur)) {
        cur = this._entries.get(name);
        if (!cur || !this._canSend(cur)) {
          await new Promise((r) => setTimeout(r, CREATOR_ATTACH_RETRY_MS));
          continue;
        }
      }
      const { sessionId } = await this._ensureTargetSession(cur, info);
      if (sessionId) {
        if (cur.clients.has(client.id)) {
          client.tabs.set(targetId, { ...info });
          clientSessions(client).set(targetId, sessionId);
          this._emitToClient(client, {
            method: "Target.attachedToTarget",
            params: { sessionId, targetInfo: { ...info, attached: true }, waitingForDebugger: false }
          });
        }
        return true;
      }
      // Timeout on the current socket. Only retry across an entry replacement
      // (a fresh entry means a fresh socket — the previous attach is moot);
      // a same-socket timeout means the extension is unresponsive, not slow.
      const after = this._entries.get(name);
      if (!after || after === cur) return false;
      cur = after;
      await new Promise((r) => setTimeout(r, CREATOR_ATTACH_RETRY_MS));
    }
    return false;
  }

  /**
   * Attach a target (manual or auto). Idempotent per target: the extension
   * attaches once per target; every gateway client shares that session.
   * Resolves to `{ sessionId, reason }` — `sessionId` is the extension session
   * (null on failure) and `reason` is the failure text for *this* attach.
   *
   * The reason travels with the result instead of a shared `this._attachFailure`
   * slot: concurrent attaches (a createTarget ack racing a manual attach, or two
   * gateway clients attaching different tabs) used to overwrite each other's
   * reason, so one target's failure was reported against another target.
   */
  _ensureTargetSession(entry, targetInfo) {
    const targetId = targetInfo.targetId;
    const existing = entry.sessionForTarget.get(targetId);
    if (existing) return Promise.resolve({ sessionId: existing, reason: null });

    return new Promise((resolve) => {
      const globalId = this._nextCommandId++;
      this._pendingCommands.set(globalId, { clientId: null, marker: "attach", entryName: entry.name, targetId, resolve });
      sendJson(entry.ws, {
        id: globalId,
        method: "Target.attachToTarget",
        params: { targetId, flatten: true }
      });
      setTimeout(() => {
        if (this._pendingCommands.has(globalId)) {
          this._pendingCommands.delete(globalId);
          resolve({ sessionId: null, reason: `attach timed out after ${GATEWAY_WAIT_MS}ms` });
        }
      }, GATEWAY_WAIT_MS);
    });
  }

  async _handleAttachToTarget(entry, client, id, params) {
    const target = entry.tabs.find((t) => t.targetId === params.targetId);
    if (!target) {
      this._reply(client, id, null, { code: -32000, message: `Target ${params.targetId} not found` });
      return;
    }
    const { sessionId, reason } = await this._ensureTargetSession(entry, target);
    if (!sessionId) {
      this._reply(client, id, null, { code: -32000, message: `Failed to attach target ${params.targetId}: ${reason || "unknown extension error"}` });
      return;
    }
    const sessions = clientSessions(client);
    const alreadyAttached = sessions.has(params.targetId);
    sessions.set(params.targetId, sessionId);
    if (!alreadyAttached) {
      this._emitToClient(client, {
        method: "Target.attachedToTarget",
        params: { sessionId, targetInfo: { ...target, attached: true }, waitingForDebugger: false }
      });
    }
    // A newly discovered target needs its event before Puppeteer resolves the
    // attach call. A page created by this client already has that session, and
    // re-emitting it would replace Puppeteer's active page session.
    this._reply(client, id, { sessionId });
  }

  /**
   * Adopt an EXISTING browser-origin tab so a puppeteer gateway client (i.e.
   * navigator) gets a managed Page for it. The relay deliberately never
   * auto-attaches pre-existing tabs (perf — avoids a chrome.debugger.attach
   * thundering herd), so puppeteer's browser.pages() doesn't include them.
   * Emitting a synthesized `Target.attachedToTarget` — with the real extension
   * sessionId — makes puppeteer's Connection create a session (Connection#onMessage
   * registers it) and its TargetManager create a managed Page, identical to the
   * proven Target.createTarget path.
   *
   * Navigator is the sole gateway (/browser/<name>) consumer per add-on, so we
   * emit to every connected gateway client for that entry.
   *
   * @returns {Promise<{found, attached, backend}>}
   */
  async attachExistingTabToClients(entryName, targetId) {
    const entry = this._entries.get(entryName);
    if (!entry || entry.status !== "connected") {
      return { found: false, attached: false, reason: "browser not connected" };
    }
    // Refresh the extension's tab list so the (possibly just-connected) tab is
    // present before we search for it.
    try { await this._requestTabList(entry); } catch { /* use cached tabs */ }
    const target = entry.tabs.find((t) => t.targetId === targetId);
    if (!target) {
      return { found: false, attached: false, reason: "target not found" };
    }
    const { sessionId, reason } = await this._ensureTargetSession(entry, target);
    if (!sessionId) {
      return { found: true, attached: false, reason: reason || "attach failed" };
    }
    for (const client of [...entry.clients.values()]) {
      if (!client.ws || client.ws.readyState !== client.ws.OPEN) continue;
      client.tabs.set(targetId, { ...target });
      clientSessions(client).set(targetId, sessionId);
      this._emitToClient(client, {
        method: "Target.attachedToTarget",
        params: { sessionId, targetInfo: { ...target, attached: true }, waitingForDebugger: false }
      });
    }
    return { found: true, attached: true, backend: entry.name };
  }

  async _handleDetachFromTarget(entry, client, id, params) {
    const sessionId = params.sessionId;
    const targetId = params.targetId || (sessionId ? this._targetIdForSession(entry, sessionId) : null);
    if (targetId && client.sessionForTarget) client.sessionForTarget.delete(targetId);
    const detachSession = sessionId || (targetId ? entry.sessionForTarget.get(targetId) : null);
    this._sendExtensionCommand(entry, {
      id,
      method: "Target.detachFromTarget",
      params: detachSession ? { sessionId: detachSession } : { targetId: targetId || "" },
      sessionId: undefined
    }, client.id);
    if (sessionId) {
      this._emitToClient(client, { method: "Target.detachedFromTarget", params: { sessionId } });
    }
  }

  _targetIdForSession(entry, sessionId) {
    for (const [targetId, sid] of entry.sessionForTarget) {
      if (sid === sessionId) return targetId;
    }
    return null;
  }

  async _attachAllTabs(entry, client) {
    const sessions = clientSessions(client);
    const ATTACH_DELAY_MS = 40;
    for (const target of entry.tabs) {
      if (!isPageTarget(target) || sessions.has(target.targetId)) continue;
      // Skip targets that cannot be debugged — chrome:// and extension
      // background pages crash the relay ws when the extension tries
      // chrome.debugger.attach on them.
      const u = (target.url || "").toLowerCase();
      if (u.startsWith("chrome://") || u.startsWith("chrome-extension://")) continue;
      const { sessionId } = await this._ensureTargetSession(entry, target);
      if (!sessionId) continue;
      sessions.set(target.targetId, sessionId);
      this._emitToClient(client, {
        method: "Target.attachedToTarget",
        params: { sessionId, targetInfo: { ...target, attached: true }, waitingForDebugger: false }
      });
      // Small delay between attaches to avoid overwhelming the extension.
      await new Promise((r) => setTimeout(r, ATTACH_DELAY_MS));
    }
  }

  _emitBrowserTarget(entry, client) {
    if (client.browserTargetSent) return;
    client.browserTargetSent = true;
    this._emitToClient(client, {
      method: "Target.targetCreated",
      params: {
        targetInfo: {
          targetId: entry.browserTargetId || (entry.browserTargetId = `browser:${entry.name}`),
          type: "browser",
          title: entry.name,
          url: "about:blank",
          attached: true,
          canAccessOpener: false,
          browserContextId: "default"
        }
      }
    });
  }

  // ---- Extension cdp responses / events ----------------------------------

  _onCdpResponse(entry, msg) {
    const pending = this._pendingCommands.get(msg.id);
    if (!pending) {
      log(`[relay] cdp_response WITH NO PENDING for id=${msg.id} (method=${msg.method || "?"}) result=${JSON.stringify(msg.result || msg.error || {}).slice(0, 120)}`);
      return;
    }
    this._pendingCommands.delete(msg.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.method === "Target.closeTarget") {
      const tracked = [...entry.clients.values()].map((c) => (c.tabs.has(pending.params?.targetId) ? 1 : 0)).join(",");
      log(`[relay] closeTarget response arrived id=${msg.id} target=${pending.params?.targetId} err=${msg.error ? 1 : 0} clientsTracking=[${tracked}]`);
    }

    if (pending.marker === "attach") {
      if (!msg.error && msg.result && typeof msg.result.sessionId === "string") {
        const targetId = pending.targetId;
        entry.sessionForTarget.set(targetId, msg.result.sessionId);
        entry.extSessionToTarget.set(msg.result.sessionId, targetId);
        pending.resolve({ sessionId: msg.result.sessionId, reason: null });
      } else {
        pending.resolve({
          sessionId: null,
          reason: msg.error?.message || "unexpected extension reply (no sessionId)"
        });
      }
      return;
    }

    // A client-created target must enter the registry immediately, otherwise
    // the client's own Target.attachToTarget can't find it (stuck about:blank).
    // The createTarget ack is HELD until the attach settles: puppeteer's
    // browser.newPage() hard-waits (30s default waitForTarget) on the
    // synthesized attachedToTarget for the new tab, so a flap between the
    // createTarget reply and the attach must not strand it. On success the ack
    // goes out with the extension's result; on attach failure the orphan tab is
    // closed best-effort and the command errors fast instead of being left to
    // the client's own timeout.
    if (pending.clientId != null &&
        pending.method === "Target.createTarget" &&
        !msg.error && msg.result && msg.result.targetId) {
      const attach = this._registerCreatedTarget(entry, {
        targetId: msg.result.targetId,
        tabId: msg.result.tabId ?? null,
        url: pending.params?.url || "about:blank",
        browserContextId: msg.result.browserContextId || pending.params?.browserContextId || "default"
      }, pending.clientId);
      if (attach) {
        const creator = entry.clients.get(pending.clientId);
        if (creator && creator.ws.readyState === creator.ws.OPEN) {
          void attach.then((attached) => {
            const live = entry.clients.get(pending.clientId);
            if (!live || live.ws.readyState !== live.ws.OPEN) return; // client went away mid-attach
            if (attached) {
              this._reply(live, pending.id, msg.result || {});
              return;
            }
            const cur = this._entries.get(entry.name);
            if (cur && this._canSend(cur)) {
              this._sendExtensionCommand(cur, {
                id: this._nextCommandId++,
                method: "Target.closeTarget",
                params: { targetId: msg.result.targetId }
              }, null, GATEWAY_WAIT_MS);
            }
            log(`[relay] new tab ${msg.result.targetId} created but never attached — erroring the client command`);
            this._reply(live, pending.id, null, {
              code: -32000,
              message: `New tab ${msg.result.targetId} was created but the extension did not attach it (unresponsive browser)`
            });
          });
        }
        return; // the ack is deferred to the attach settlement above
      }
    }

    // Proactively evict a closed target so puppeteer doesn't wait for a
    // tab_list poll that may never come.  The destroy/detached events are
    // what resolve page.close() (TargetManager's detached listener).
    if (pending.method === "Target.closeTarget" && !msg.error) {
      const targetId = pending.params?.targetId || msg.result?.targetId;
      if (targetId) {
        const idx = entry.tabs.findIndex((t) => t.targetId === targetId);
        if (idx !== -1) entry.tabs.splice(idx, 1);
        for (const [k, v] of [...entry.tabIdToTarget.entries()]) {
          if (v === targetId) entry.tabIdToTarget.delete(k);
        }
        const sess = entry.sessionForTarget.get(targetId);
        if (sess) {
          entry.sessionForTarget.delete(targetId);
          entry.extSessionToTarget.delete(sess);
        }
        for (const c of [...entry.clients.values()]) {
          this._diffTabsForClient(entry, c);
        }
      }
    }

    // Stale session recovery: the user closed the debugger banner
    // (canceled_by_user) or a tab navigated and destroyed the execution
    // context. The extension already sent "tab_detached" but this in-flight
    // command still fails with "Tab not attached" / "Cannot find context".
    // Purge the dead mapping so the *next* _ensureTargetSession re-attaches
    // (banner reappears) instead of replaying the dead sessionId forever.
    if (msg.error && typeof msg.error.message === "string") {
      const emsg = msg.error.message;
      const isStale = emsg.includes("Tab not attached") || emsg.includes("No target found") || emsg.includes("Target closed") || emsg.includes("Cannot find context") || emsg.includes("Execution context was destroyed") || emsg.includes("Session closed");
      if (isStale) {
        let tid = pending.targetId || null;
        if (!tid && pending.sessionId) tid = entry.extSessionToTarget.get(pending.sessionId) || null;
        if (!tid && pending.params && pending.params.targetId) tid = String(pending.params.targetId);
        if (tid) {
          const sess = entry.sessionForTarget.get(tid);
          if (sess) {
            entry.sessionForTarget.delete(tid);
            entry.extSessionToTarget.delete(sess);
            for (const c of entry.clients.values()) {
              if (c.sessionForTarget) c.sessionForTarget.delete(tid);
            }
            log(`cleared stale session for target ${tid} after "${emsg.slice(0, 80)}"`);
          }
        } else if (pending.sessionId) {
          const t = entry.extSessionToTarget.get(pending.sessionId);
          if (t) {
            entry.sessionForTarget.delete(t);
            entry.extSessionToTarget.delete(pending.sessionId);
            for (const c of entry.clients.values()) if (c.sessionForTarget) c.sessionForTarget.delete(t);
            log(`cleared stale session ${pending.sessionId} → ${t} after "${emsg.slice(0, 80)}"`);
          }
        }
      }
    }

    // In-process callers (relayServer.sendCdpCommand) resolve here — the
    // pending entry carries its own resolve callback and has no websocket
    // client to route the reply to. Target.createTarget registration +
    // stale-session recovery above already ran, matching the client path.
    if (pending.marker === "sendCommand") {
      if (pending.resolve) pending.resolve(msg);
      return;
    }

    if (pending.clientId == null) return;
    const client = entry.clients.get(pending.clientId);
    if (!client || client.ws.readyState !== client.ws.OPEN) {
      log(`[relay] DROPPING client reply id=${pending.id} method=${pending.method} (clientId=${pending.clientId} gone or not open)`);
      return;
    }
    const reply = { id: pending.id };
    if (msg.error) {
      reply.error = msg.error;
    } else {
      reply.result = msg.result || {};
    }
    // Forwarded Target.getBrowserContexts: a client that predates the window
    // flag (or an extension reply without browserContextIds) must still see the
    // historical single "default" context instead of an empty/absent list.
    if (pending.method === "Target.getBrowserContexts" && !reply.error) {
      if (!Array.isArray(reply.result.browserContextIds)) {
        reply.result.browserContextIds = ["default"];
      }
    }
    // Session-scoped replies must carry the sessionId the client used on the
    // command — the extension's echo wins; the gateway's record backstops it
    // for extensions that reply without echoing (CDP clients drop replies
    // whose id resolves to a session but which arrive session-less).
    if (msg.sessionId) reply.sessionId = msg.sessionId;
    else if (pending.sessionId) reply.sessionId = pending.sessionId;
    sendJson(client.ws, reply);
    if (pending.method === "Target.closeTarget") {
      log(`[relay] replied closeTarget id=${pending.id} to client ${pending.clientId}`);
    }
  }

  _onCdpEvent(entry, msg) {
    // Attach/detach lifecycle is synthesized by the gateway itself — a real
    // extension's own Target.attachToTarget/FromTarget events would otherwise
    // double-report to puppeteer clients.
    if (msg.method === "Target.attachedToTarget" || msg.method === "Target.detachedFromTarget") return;

    let targetId = null;
    if (msg.sessionId && entry.extSessionToTarget.has(msg.sessionId)) {
      targetId = entry.extSessionToTarget.get(msg.sessionId);
    }
    if (!targetId && msg.tabId != null && entry.tabIdToTarget.has(String(msg.tabId))) {
      targetId = entry.tabIdToTarget.get(String(msg.tabId));
    }

    const base = { method: msg.method, params: msg.params || {} };
    if (targetId) {
      for (const client of entry.clients.values()) {
        const session = client.sessionForTarget && client.sessionForTarget.get(targetId);
        if (!session) continue;
        this._emitToClient(client, { ...base, sessionId: session });
      }
      return;
    }
    for (const client of entry.clients.values()) {
      this._emitToClient(client, { ...base });
    }
  }

  _heartbeatTick() {
    const now = Date.now();
    for (const entry of [...this._entries.values()]) {
      if (!entry.ws || entry.ws.readyState !== entry.ws.OPEN) continue;
      if (now - entry.lastActivity > HEARTBEAT_TIMEOUT_MS) {
        // terminate(), not close(): a silent peer will not answer a close
        // handshake either, and close() would keep the dead entry (and route
        // commands into it) for the 30s closing timeout.
        log(`extension "${entry.name}" heartbeat timeout — terminating`);
        try { entry.ws.terminate(); } catch {}
        this._teardownEntry(entry);
        continue;
      }
      sendJson(entry.ws, { type: "ping" });
    }
    // Expired PIN pairings are closed here rather than as a side effect of
    // a status read; the extension reverts to its previous pairing.
    for (const [name, pairing] of [...this._pairings]) {
      if (!pairing.pinExpired(now)) continue;
      this._pairings.delete(name);
      log(`extension "${name}" PIN expired`);
      pairing.close(RelayCloseCode.PIN_REJECTED, "PIN expired");
    }
  }

  /**
   * Send a CDP command to a relay extension IN-PROCESS and resolve with the
   * extension's `{ result }` / `{ error }` — no second socket, no gateway
   * client. This is how the MCP devtools window tools (Target.activateTarget,
   * Browser.*, Target.sendCommand) reach the user's browser: the extension's
   * LOCAL/SPECIAL handlers are in-process exactly as when an attached puppeteer
   * client sends the same method — the gateway's pending machinery is reused
   * (marker "sendCommand" resolves in `_onCdpResponse`).
   *
   * When `targetId` is given, the target is resolved to its extension session
   * (reusing an existing attach), so session-scoped methods like
   * Page.getNavigationHistory reach chrome.debugger on the right tab.
   *
   * @param {string} entryName
   * @param {{method: string, params?: object, targetId?: string|null,
   *          sessionId?: string|null, timeoutMs?: number}} cmd
   * @returns {Promise<{result: object, error?: {code?: number, message: string}}>}
   */
  async sendCdpCommand(entryName, { method, params = {}, targetId = null, sessionId = null, timeoutMs = null } = {}) {
    const entry = this._entries.get(entryName);
    if (!entry || !this._canSend(entry)) {
      throw new Error(`browser "${entryName}" is not connected`);
    }
    if (!method || typeof method !== "string") {
      throw new Error("sendCdpCommand requires a method");
    }

    if (targetId && !sessionId) {
      const existing = entry.sessionForTarget.get(targetId);
      if (existing) {
        sessionId = existing;
      } else {
        const target = entry.tabs.find((t) => t.targetId === targetId);
        if (!target) {
          throw new Error(`Target ${targetId} not found in browser "${entryName}" — run Target.getTargets first`);
        }
        const { sessionId: sid, reason } = await this._ensureTargetSession(entry, target);
        if (!sid) {
          throw new Error(`Failed to attach target ${targetId}: ${reason || "unknown extension error"}`);
        }
        sessionId = sid;
      }
    }

    const globalId = this._nextCommandId++;
    const deadline = timeoutMs || GATEWAY_WAIT_MS;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pendingCommands.has(globalId)) {
          this._pendingCommands.delete(globalId);
          reject(new Error(`CDP command ${method} timed out after ${deadline}ms`));
        }
      }, deadline);
      this._pendingCommands.set(globalId, {
        clientId: null,
        id: globalId,
        marker: "sendCommand",
        entryName: entry.name,
        sessionId,
        method,
        params: params || {},
        resolve: (msg) => {
          clearTimeout(timer);
          if (msg && msg.error) resolve({ error: msg.error });
          else resolve({ result: (msg && msg.result) || {} });
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      const msg = { id: globalId, method, params: params || {} };
      if (sessionId) msg.sessionId = sessionId;
      sendJson(entry.ws, msg);
    });
  }

  detachAllDebuggers() {
    let count = 0;
    for (const entry of this._entries.values()) {
      if (!entry.ws || entry.ws.readyState !== entry.ws.OPEN) continue;
      try {
        sendJson(entry.ws, { type: "detach_all" });
        // Clear relay-side session maps so next attach is fresh
        entry.sessionForTarget.clear();
        entry.extSessionToTarget.clear();
        for (const client of entry.clients.values()) {
          if (client.sessionForTarget) client.sessionForTarget.clear();
          if (client.tabs) client.tabs.clear();
        }
        count++;
        log(`detach_all sent to "${entry.name}" and cleared session maps`);
      } catch (e) {
        log(`detach_all failed for "${entry.name}": ${e.message}`);
      }
    }
    return { sentTo: count };
  }
}

export const relayServer = new RelayServer();

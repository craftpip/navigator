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
// init(), so a navigator restart never forces a re-PIN.

import { WebSocketServer } from "ws";
import { randomInt, randomUUID } from "node:crypto";
import { deleteRelaySession, loadRelaySessions, saveRelaySession } from "./db.js";
import { PLUGIN_PLATFORMS } from "./config.js";

const PIN_EXPIRY_MS = 60_000;
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

export class RelayServer {
  constructor() {
    this._entries = new Map(); // name -> entry
    this._tokenToName = new Map(); // sessionToken -> name
    this._wss = null;
    this._server = null;
    this._host = "127.0.0.1";
    this._port = 0;
    this._nextCommandId = 1;
    this._pendingCommands = new Map(); // globalId -> { clientId, id, marker?, targetId?, resolve? }
    this._heartbeat = null;
  }

  init({ server, host, port }) {
    if (!server) throw new Error("relay init requires the HTTP server");
    this._server = server;
    if (host) this._host = host;
    if (port) this._port = port;
    this._wss = new WebSocketServer({ noServer: true });

    // Restore persisted pairings so a navigator restart does not force a
    // re-PIN — the extension reconnects with the same session token.
    try {
      const sessions = loadRelaySessions();
      for (const s of sessions) {
        this._tokenToName.set(s.session_token, s.name);
      }
      if (sessions.length) log(`restored ${sessions.length} persisted relay session(s)`);
    } catch (e) {
      log(`restore relay sessions skipped: ${String(e && e.message)}`);
    }

    server.on("upgrade", (req, socket, head) => {
      this._handleUpgrade(req, socket, head);
    });

    if (this._heartbeat) clearInterval(this._heartbeat);
    this._heartbeat = setInterval(() => this._heartbeatTick(), HEARTBEAT_INTERVAL_MS);
    if (this._heartbeat.unref) this._heartbeat.unref();

    log(`mounted: /relay (extensions) + /browser/<name> (pure CDP, host=${this._host} port=${this._port})`);
  }

  gatewayWsUrl(name) {
    return `ws://${this._host}:${this._port}/browser/${encodeURIComponent(name)}`;
  }

  // ---- Registry access for BrowserManager --------------------------------

  isConnected(name) {
    const entry = this._entries.get(name);
    return Boolean(entry && entry.status === "connected" && entry.ws && entry.ws.readyState === entry.ws.OPEN);
  }

  isPending(name) {
    const entry = this._entries.get(name);
    if (!entry || entry.status !== "auth_pending") return false;
    // Expired PIN is no longer pending — treat as not pending so the
    // previous pairing (if any) stays valid and no "expired" UI is shown.
    if (entry.pendingPin && Date.now() > entry.pendingPin.expiresAt) return false;
    return true;
  }

  isPaired(name) {
    if (!name) return false;
    for (const pairedName of this._tokenToName.values()) {
      if (pairedName === name) return true;
    }
    return false;
  }

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
    // Remove from live entries (close ws if connected)
    const entry = this._entries.get(trimmed);
    if (entry) {
      found = true;
      try {
        if (entry.ws && entry.ws.readyState === entry.ws.OPEN) {
          entry.ws.close(4000, "forget");
        }
      } catch {}
      this._teardownEntry(entry);
    }
    // Remove from DB (persisted pairing)
    try {
      if (deleteRelaySession(trimmed)) found = true;
    } catch {}
    return found;
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
   * Ask the extension for a fresh tab list for a relay browser, then resolve
   * with the updated entry.tabs. Used by callers that must see user-opened
   * tabs immediately (e.g. Target.getTargets) instead of a stale cache.
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
    }
    return out;
  }

  _statusFor(cfg) {
    const name = cfg.name;
    const entry = this._entries.get(name);
    const connected = this.isConnected(name);
    let pending = this.isPending(name);
    let pendingPin = entry?.pendingPin || null;
    // If PIN is expired, clear it and revert to previous state — the
    // previously paired browser (if any) stays valid, no "expired" UI.
    if (pending && pendingPin && Date.now() > pendingPin.expiresAt) {
      entry.pendingPin = null;
      pendingPin = null;
      pending = false;
      // Fresh pending entry that never paired and never connected — remove it
      // so it doesn't linger as "not paired" after expiry.
      if (!this.isPaired(name) && !connected) {
        this._entries.delete(name);
        // Return a synthetic disconnected entry (paired==false) — the
        // caller (getStatusEntries) will handle synthetic paired entries
        // separately, but for unpaired we just return disconnected.
        return {
          name,
          type: "navigator-cdp",
          plugin: cfg.plugin || "auto",
          status: "disconnected",
          paired: false,
          role: cfg.role || [],
          configured: Boolean(cfg.configured),
          dynamic: !cfg.configured,
          cdpUrl: null,
          connectedAt: null,
          extensionVersion: null,
          bidiOrigin: null,
          pin: null,
          pinExpiresAt: null
        };
      }
    }
    return {
      name,
      type: "navigator-cdp",
      plugin: entry?.platform || entry?.plugin || cfg.plugin || "auto",
      status: connected ? "connected" : pending ? "auth_pending" : "disconnected",
      paired: this.isPaired(name),
      role: cfg.role || [],
      configured: Boolean(cfg.configured),
      dynamic: !cfg.configured,
      cdpUrl: connected ? this.gatewayWsUrl(name) : null,
      connectedAt: entry?.connectedAt || null,
      extensionVersion: entry?.extensionVersion || null,
      bidiOrigin: entry?.bidiOrigin || null,
      pin: pending && pendingPin ? pendingPin.pin : null,
      pinExpiresAt: pending && pendingPin ? pendingPin.expiresAt : null
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
    this._wss.handleUpgrade(req, socket, head, (ws) => {
      this._handleGateway(name, ws);
    });
  }

  // ---- Extension side (/relay) -------------------------------------------

  _handleExtension(ws) {
    let name = null;
    let entry = null;
    let settled = false;

    const fail = (code, reason) => {
      settled = true;
      try { ws.close(code, String(reason).slice(0, 120)); } catch {}
    };

    const helloTimer = setTimeout(() => {
      if (!settled) fail(4000, "hello timeout");
    }, HELLO_TIMEOUT_MS);

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;

      if (!entry) {
        // ---- navigator-hello ------------------------------------------------
        if (msg.type !== "navigator-hello") return;
        name = typeof msg.browserName === "string" && msg.browserName.trim() ? msg.browserName.trim() : "";
        if (!name) {
          fail(4000, "navigator-hello requires browserName");
          return;
        }
        clearTimeout(helloTimer);
        entry = this._ensureEntry(name);
        entry.ws = ws;
        if (PLUGIN_PLATFORMS.has(msg.platform)) entry.platform = msg.platform;
        if (typeof msg.extensionVersion === "string") entry.extensionVersion = msg.extensionVersion;
        // The extension reports the exact "moz-extension://<uuid>" origin its
        // BiDi WebSocket connects from — surfaced via status()/stats so the
        // Remote Agent allow-list (--remote-allow-origins) can be set correctly.
        if (typeof msg.bidiOrigin === "string" && msg.bidiOrigin.startsWith("moz-extension://")) entry.bidiOrigin = msg.bidiOrigin;
        entry.lastActivity = Date.now();

        const token = typeof msg.sessionToken === "string" && msg.sessionToken ? msg.sessionToken : "";
        if (token) {
          if (this._tokenToName.get(token) === name) {
            log(`extension "${name}" reconnected with valid session token`);
            entry.status = "connected";
            entry.connectedAt = Date.now();
            entry.pendingPin = null;
            sendJson(ws, { type: "connected", sessionToken: token });
            this._onPairingComplete(entry);
          } else {
            // A token that is stale or that belongs to a different browser is a
            // state leak, not a new pairing — reject the connection outright.
            log(`extension "${name}" presented an invalid/expired session token`);
            fail(4001, "invalid session token");
          }
        } else {
          const pin = freshPin();
          entry.pendingPin = { pin, expiresAt: Date.now() + PIN_EXPIRY_MS };
          entry.status = "auth_pending";
          this._printPin(entry, pin);
          sendJson(ws, { type: "pin_required" });
        }
        return;
      }

      entry.lastActivity = Date.now();

      // ---- PIN submission ---------------------------------------------------
      if (msg.type === "pin" && entry.status === "auth_pending") {
        const pending = entry.pendingPin;
        if (!pending) {
          fail(4000, "No pending PIN");
          return;
        }
        if (Date.now() > pending.expiresAt) {
          entry.pendingPin = null;
          log(`extension "${name}" PIN expired`);
          fail(4000, "PIN expired");
          return;
        }
        if (String(msg.pin) !== pending.pin) {
          entry.pendingPin = null;
          log(`extension "${name}" submitted wrong PIN`);
          fail(4000, "Invalid PIN");
          return;
        }
        entry.pendingPin = null;
        entry.status = "connected";
        entry.connectedAt = Date.now();
        entry.sessionToken = randomUUID().replace(/-/g, "");
        this._tokenToName.set(entry.sessionToken, name);
        try {
          saveRelaySession(name, entry.sessionToken);
        } catch (e) {
          log(`persist session for "${name}" failed`, String(e && e.message));
        }
        log(`extension "${name}" PIN accepted`);
        sendJson(ws, { type: "pin_accepted" });
        sendJson(ws, { type: "connected", sessionToken: entry.sessionToken });
        this._onPairingComplete(entry);
        return;
      }

      // ---- connected traffic ------------------------------------------------
      if (entry.status !== "connected") return;

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
        // Extension's chrome.debugger.onDetach — the user closed the
        // "started debugging this browser" banner (canceled_by_user) or a
        // tab was closed. Purge the stale session maps so the next
        // _ensureTargetSession creates a fresh chrome.debugger.attach instead
        // of replaying the dead sessionId ("Tab not attached").
        //
        // BEFORE clearing the maps, forward a session-scoped
        // Target.detachedFromTarget to every client tracking the target —
        // that event is what resolves puppeteer's page.close() (TargetManager
        // listens on the session), and this is the only moment the sessionId
        // is still known: once the maps are purged here, the later _diffTabs
        // can only emit destroy-without-detach and page.close() hangs forever.
        const tabIdStr = String(msg.tabId);
        const targetId = entry.tabIdToTarget.get(tabIdStr);
        if (targetId) {
          const sess = entry.sessionForTarget.get(targetId);
          if (sess) {
            for (const client of [...entry.clients.values()]) {
              const cs = client.sessionForTarget;
              if (cs && cs.has(targetId)) {
                this._emitToClient(client, {
                  method: "Target.detachedFromTarget",
                  params: { sessionId: cs.get(targetId), targetId }
                });
                log(`[relay] tab_detached: emitting detachedFromTarget session=${cs.get(targetId)} (client ${client.id})`);
              }
            }
            entry.sessionForTarget.delete(targetId);
            entry.extSessionToTarget.delete(sess);
            for (const client of entry.clients.values()) {
              if (client.sessionForTarget) client.sessionForTarget.delete(targetId);
            }
            log(`extension "${name}" detached tab ${msg.tabId} (target ${targetId}) reason=${msg.reason || ""} — cleared stale session`);
          }
        } else {
          // No targetId mapping yet (tab list race) — still clear any session
          // that was mapped via extSessionToTarget → tabId
          for (const [sess, tid] of [...entry.extSessionToTarget.entries()]) {
            const mappedTab = [...entry.tabIdToTarget.entries()].find(([, v]) => v === tid)?.[0];
            if (mappedTab === tabIdStr) {
              for (const client of [...entry.clients.values()]) {
                const cs = client.sessionForTarget;
                if (cs && cs.has(tid)) {
                  this._emitToClient(client, {
                    method: "Target.detachedFromTarget",
                    params: { sessionId: cs.get(tid), targetId: tid }
                  });
                }
              }
              entry.sessionForTarget.delete(tid);
              entry.extSessionToTarget.delete(sess);
              for (const client of entry.clients.values()) {
                if (client.sessionForTarget) client.sessionForTarget.delete(tid);
              }
              log(`extension "${name}" detached tab ${msg.tabId} (session ${sess}) — cleared stale session (fallback)`);
              break;
            }
          }
        }
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
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (entry && entry.ws === ws) {
        log(`extension "${name || "?"}" disconnected`);
        this._teardownEntry(entry);
      }
    });

    ws.on("error", () => {
      try { ws.close(); } catch {}
    });
  }

  _ensureEntry(name) {
    let entry = this._entries.get(name);
    if (!entry) {
      entry = {
        name,
        plugin: "auto",
        platform: null,
        extensionVersion: null,
        bidiOrigin: null,
        status: "auth_pending",
        ws: null,
        connectedAt: null,
        sessionToken: null,
        pendingPin: null,
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

  _teardownEntry(entry) {
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
        pending.resolve(null);
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
    this._entries.delete(entry.name);
  }

  _printPin(entry, pin) {
    for (const line of [
      "",
      "┌────────────────────────────────────────────────┐",
      `│  🔐 "${entry.name}" wants to connect                  │`,
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
    entry.tabs = tabs || [];
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

  _handleGateway(name, ws) {
    const entry = this._entries.get(name);
    if (!entry || entry.status !== "connected") {
      log(`gateway connect for unknown/disconnected browser "${name}"`);
      try { ws.close(4003, "browser not connected"); } catch {}
      return;
    }
    const client = {
      id: randomUUID(),
      ws,
      tabs: new Map(),
      discover: false,
      autoAttach: false,
      browserTargetSent: false
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

  _reply(client, id, result, error) {
    const msg = { id };
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
        this._reply(client, id, {});
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
      case "Target.getBrowserContexts": {
        // The gateway models a single browser context ("default") — the
        // extension's browser is one container; subsets are not exposed.
        this._reply(client, id, { browserContextIds: ["default"] });
        return;
      }
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
        this._sendExtensionCommand(entry, { id, method, params, sessionId }, client.id);
      }
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
  _registerCreatedTarget(entry, { targetId, tabId = null, url = "about:blank" } = {}, creatorClientId = null) {
    if (!targetId) return null;
    const info = {
      targetId,
      type: "page",
      title: "",
      url,
      attached: false,
      canAccessOpener: false,
      browserContextId: "default",
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
      const sessionId = await this._ensureTargetSession(cur, info);
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
   * Resolves to the extension sessionId (or null on failure).
   */
  _ensureTargetSession(entry, targetInfo) {
    const targetId = targetInfo.targetId;
    const existing = entry.sessionForTarget.get(targetId);
    if (existing) return Promise.resolve(existing);

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
          this._attachFailure = "attach timed out";
          resolve(null);
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
    const sessionId = await this._ensureTargetSession(entry, target);
    if (!sessionId) {
      const reason = this._attachFailure || "unknown extension error";
      this._attachFailure = null;
      this._reply(client, id, null, { code: -32000, message: `Failed to attach target ${params.targetId}: ${reason}` });
      return;
    }
    clientSessions(client).set(params.targetId, sessionId);
    this._reply(client, id, { sessionId });
    this._emitToClient(client, {
      method: "Target.attachedToTarget",
      params: { sessionId, targetInfo: { ...target, attached: true }, waitingForDebugger: false }
    });
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
    const sessionId = await this._ensureTargetSession(entry, target);
    if (!sessionId) {
      return { found: true, attached: false, reason: this._attachFailure || "attach failed" };
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
      const sessionId = await this._ensureTargetSession(entry, target);
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
        pending.resolve(msg.result.sessionId);
      } else {
        this._attachFailure = msg.error?.message || "unexpected extension reply";
        pending.resolve(null);
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
        url: pending.params?.url || "about:blank"
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
    for (const entry of this._entries.values()) {
      if (!entry.ws || entry.ws.readyState !== entry.ws.OPEN) continue;
      if (now - entry.lastActivity > HEARTBEAT_TIMEOUT_MS) {
        log(`extension "${entry.name}" heartbeat timeout — closing`);
        try { entry.ws.close(); } catch {}
        continue;
      }
      sendJson(entry.ws, { type: "ping" });
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
        const sid = await this._ensureTargetSession(entry, target);
        if (!sid) {
          const reason = this._attachFailure || "unknown extension error";
          this._attachFailure = null;
          throw new Error(`Failed to attach target ${targetId}: ${reason}`);
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
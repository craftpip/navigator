/**
 * CDP URL sharing (plan 55) — expose configured browsers as authenticated
 * CDP WebSocket endpoints, BrowserStack-style:
 *
 *   ws://<host>:<port>/cdp/<browserName>?key=<API_KEY>
 *
 * External clients (puppeteer.connect, chrome-remote-interface, raw CDP)
 * get a browser-level CDP session bound to that browser, gated by the
 * API key's `allowed_browsers` (NULL = all browsers). CDP ALWAYS requires
 * a valid key — MCP_ALLOW_UNAUTHENTICATED never applies here.
 *
 * Transports per backend (plan 55 §2.3):
 * - navigator-cdp (relay) → attach into the existing extension gateway
 *   (relayServer.attachGatewayClient — same code as /browser/<name>).
 * - cdp add-on → dedicated raw WS to the entry's cdpUrl, duplex-piped.
 * - inbuilt chromium → fresh dedicated Chromium per session
 *   (manager.createSharedBrowser), piped to its wsEndpoint, closed on end.
 */

import { timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { getMcpApiKey } from "./mcp-api-auth.js";
import { listMcpApiKeys } from "./db.js";
import { recordMcpCall } from "./activity.js";
import { recordCdpConnection } from "./search.js";
import { relayServer } from "./relay-server.js";

export const CDP_PATH_RE = /^\/cdp\/([^/]+)$/;
const BACKEND_DIAL_TIMEOUT_MS = 10_000;
// Plan 55 §8.3 — cap concurrent fresh-Chromium /cdp sessions.
const SHARED_CHROMIUM_CAP = 3;

/** Mirror of parseAllowedTools (mcp-server.js) for the allowed_browsers column. */
export function parseAllowedBrowsers(value) {
  if (!value) return null;
  try {
    const names = JSON.parse(value);
    return Array.isArray(names) ? names.filter((name) => typeof name === "string") : [];
  } catch {
    return [];
  }
}

/** Same preview shape as maskApiKey (mcp-server.js) — first12...last12. */
function maskCdpKey(key) {
  const secret = String(key || "");
  if (secret.length <= 24) return "********";
  return `${secret.slice(0, 12)}...${secret.slice(-12)}`;
}

/**
 * Advertised CDP base URL. MCP_PUBLIC_URL (plan 55 §7.5) wins when set
 * (reverse-proxy/TLS deployments); otherwise derive ws://host:port from
 * mcpApiHost/mcpApiPort like the relay gateway URL does.
 */
export function cdpBaseUrl(config = {}) {
  const pub = String(config.mcpPublicUrl || "").trim().replace(/\/+$/, "");
  if (pub) return pub.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  let host = "127.0.0.1";
  if (config.mcpApiHost) {
    try {
      host = new URL(config.mcpApiHost).hostname || host;
    } catch {
      // keep default
    }
  }
  return `ws://${host}:${config.mcpApiPort || 1994}`;
}

export function cdpConnectUrl(config, browserName) {
  return `${cdpBaseUrl(config)}/cdp/${encodeURIComponent(browserName)}?key=<your key>`;
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim().slice(0, 100);
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) return realIp.trim().slice(0, 100);
  return (req.socket?.remoteAddress || "").slice(0, 100);
}

function matchKey(presented, keys) {
  if (!presented) return null;
  const actual = Buffer.from(presented);
  return keys.find((key) => {
    const expected = Buffer.from(key);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }) || null;
}

/**
 * Steps 1–3 of the gate (plan 55 §2.2): extract key (query wins over
 * headers), constant-time match against the live secret list, load DB row.
 * Console/internal keys without a DB row get full access (§7.1).
 * @returns {{ key, record } | { status, error }}
 */
export function authorizeCdpKey(req, url, config) {
  const queryKey = String(url.searchParams.get("key") || "").trim();
  const presented = queryKey || getMcpApiKey(req.headers);
  if (!presented) return { status: 401, error: "CDP requires an API key (?key= or Authorization header)" };
  const keys = Array.isArray(config.mcpApiKeys) ? config.mcpApiKeys : [];
  const key = matchKey(presented, keys);
  if (!key) return { status: 401, error: "Invalid API key" };
  let record = null;
  try {
    record = listMcpApiKeys().find((entry) => entry.secret === key) || null;
  } catch {
    record = null;
  }
  if (key && !record) {
    // Known secret with no DB row (in-boot console key, env key pre-import):
    // full access, like allowed_browsers NULL (§7.1, §7.2).
    return { key, record: null };
  }
  if (!record) return { status: 401, error: "Unknown or revoked API key" };
  return { key, record };
}

/** Step 4 of the gate: NULL (or missing row) = all browsers, else exact name match. */
export function checkBrowserAccess(record, browserName) {
  if (!record) return true;
  const allowed = parseAllowedBrowsers(record.allowed_browsers);
  if (allowed === null) return true;
  return allowed.includes(browserName);
}

/**
 * Step 5 of the gate: resolve a name to a shareable backend without
 * opening anything. Returns { name, type, cdpUrl?, status? } or null.
 */
export function resolveCdpBrowser(manager, name) {
  const lower = String(name || "").toLowerCase();
  if (!lower) return null;
  const cfg = (manager.config.browsers || []).find(
    (b) => !b.addOn && String(b.name || "").toLowerCase() === lower
  );
  if (cfg) return { name: cfg.name, type: "inbuilt" };
  const eff = (typeof manager._effectiveAddOns === "function" ? manager._effectiveAddOns() : [])
    .find((b) => String(b.name || "").toLowerCase() === lower);
  if (eff) return { name: eff.name, type: eff.type, cdpUrl: eff.cdpUrl, status: eff.status };
  return null;
}

/**
 * All browser names a key may be granted (configured + dynamic relay).
 * Used to validate create/set_browsers payloads (unknown names dropped).
 */
export function listShareableBrowserNames(manager) {
  const names = new Set();
  for (const b of manager.config.browsers || []) {
    if (b?.name) names.add(String(b.name));
  }
  const effective = typeof manager._effectiveAddOns === "function" ? manager._effectiveAddOns() : [];
  for (const b of effective) {
    if (b?.name) names.add(String(b.name));
  }
  return [...names];
}

/**
 * Authenticated discovery payload (plan 55 §2.5) — the GET /cdp body.
 * URL templates carry a <your key> placeholder (never echo secrets).
 */
export async function getCdpDiscoveryPayload(manager) {
  const health = await manager.getHealth();
  const base = cdpBaseUrl(manager.config);
  return {
    ok: true,
    base,
    browsers: (health.browsers || []).map((b) => ({
      name: b.name,
      type: b.type,
      role: b.role,
      status: b.status,
      connected: Boolean(b.connected),
      cdpUrl: `${base}/cdp/${encodeURIComponent(b.name)}?key=<your key>`
    }))
  };
}

function writeUpgradeError(socket, status, message) {
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

/** Open a raw CDP WebSocket to a plain cdp add-on (ws:// direct, http:// via /json/version). */
async function dialAddOnCdp(cdpUrl) {
  const raw = String(cdpUrl || "").trim();
  if (!raw) throw new Error("browser has no cdpUrl");
  let target = raw;
  if (/^https?:\/\//i.test(raw)) {
    const versionUrl = `${raw.replace(/\/+$/, "")}/json/version`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), BACKEND_DIAL_TIMEOUT_MS);
    try {
      const res = await fetch(versionUrl, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`CDP /json/version HTTP ${res.status}`);
      const data = await res.json();
      if (!data?.webSocketDebuggerUrl) throw new Error("CDP /json/version has no webSocketDebuggerUrl");
      target = data.webSocketDebuggerUrl;
    } finally {
      clearTimeout(timer);
    }
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws = null;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws?.close(); } catch {}
        reject(new Error("CDP dial timed out"));
      }
    }, BACKEND_DIAL_TIMEOUT_MS);
    try {
      ws = new WebSocket(target);
    } catch (err) {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    ws.once("open", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(ws);
      }
    });
    ws.once("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/**
 * Duplex-pipe two raw CDP sockets (plan 55 §2.4). The upstream browser
 * multiplexes multiple clients natively — no command correlation needed.
 * Exactly-once teardown: first close/error wins, both sockets die, then
 * `cleanup` runs (disconnect/close the owned backend handle).
 */
function pipeSockets(external, backend, label, cleanup) {
  let done = false;
  const teardown = (reason) => {
    if (done) return;
    done = true;
    try { external.removeAllListeners("message"); } catch {}
    try { backend.removeAllListeners("message"); } catch {}
    try {
      if (external.readyState === WebSocket.OPEN) external.close();
    } catch {}
    try {
      if (backend.readyState === WebSocket.OPEN) backend.close();
    } catch {}
    if (typeof cleanup === "function") {
      try {
        const out = cleanup(reason);
        if (out && typeof out.catch === "function") out.catch(() => {});
      } catch {}
    }
  };
  external.on("message", (data, isBinary) => {
    try {
      if (backend.readyState === WebSocket.OPEN) backend.send(data, { binary: Boolean(isBinary) });
    } catch {
      teardown("backend send failed");
    }
  });
  backend.on("message", (data, isBinary) => {
    try {
      if (external.readyState === WebSocket.OPEN) external.send(data, { binary: Boolean(isBinary) });
    } catch {
      teardown("external send failed");
    }
  });
  external.once("close", () => teardown(`external closed (${label})`));
  backend.once("close", () => teardown(`backend closed (${label})`));
  external.once("error", () => teardown(`external error (${label})`));
  backend.once("error", () => teardown(`backend error (${label})`));
}

/**
 * handleUpgrade guarded: if the socket died while we were dialing the
 * backend, upgrading throws — run backend cleanup instead of leaking it.
 */
function safeHandleUpgrade(wss, req, socket, head, onWs, onUpgradeFailed) {
  try {
    wss.handleUpgrade(req, socket, head, onWs);
  } catch {
    try {
      const out = onUpgradeFailed?.();
      if (out && typeof out.catch === "function") out.catch(() => {});
    } catch {}
    try { socket.destroy(); } catch {}
  }
}

function auditCdpConnection({ req, record, browserName, ok = true, error = "" }) {  try {
    recordMcpCall({
      tool: `cdp:${browserName}`,
      args: { browser: browserName },
      responsePreview: null,
      ip: clientIp(req),
      apiKeyId: record?.id ?? null,
      apiKeyName: record?.name ?? null,
      apiKeyPreview: record ? maskCdpKey(record.secret) : null,
      durationMs: 0,
      ok: ok ? 1 : 0,
      error: ok ? "" : String(error || "").slice(0, 500),
      source: "cdp"
    });
  } catch {}
}

/**
 * Mount the authenticated external CDP surface. Owns /cdp/* upgrade paths
 * only — every other path is ignored so the relay's upgrade handler
 * (which destroys unknown sockets) keeps working. Requires the relay
 * carve-out: relay _handleUpgrade must return early for /cdp paths.
 */
export function initCdpSharing({ server, manager, logToolError }) {
  const config = manager.config;
  if (!config.enableCdpSharing) {
    console.error("CDP sharing disabled (ENABLE_CDP_SHARING=0) — /cdp/* upgrades refused");
    return { enabled: false };
  }
  const wss = new WebSocketServer({ noServer: true });

  const failAuth = (req, socket, head, browserName, status, message) => {
    void head;
    writeUpgradeError(socket, status, message);
    auditCdpConnection({ req, record: null, browserName: browserName || "?", ok: false, error: message });
    if (typeof logToolError === "function") {
      try {
        logToolError({ tool: `cdp:${browserName || "?"}`, args: { browser: browserName || "?" }, error: new Error(message), transport: "cdp" });
      } catch {}
    }
  };

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      return; // not ours — relay owns unknown paths
    }
    const match = url.pathname.match(CDP_PATH_RE);
    if (!match) return; // not ours — relay/browser paths untouched
    let browserName;
    try {
      browserName = decodeURIComponent(match[1]);
    } catch {
      try { socket.destroy(); } catch {}
      return;
    }

    (async () => {
      // Gate steps 1–3: key
      const auth = authorizeCdpKey(req, url, config);
      if (auth.status) {
        failAuth(req, socket, head, browserName, auth.status, auth.error);
        return;
      }
      // Gate step 5 then 4 (plan §7.7): resolution before access, so
      // unknown names 404 even for restricted keys and stale names in
      // allowed_browsers simply stop resolving instead of 403ing.
      const backend = resolveCdpBrowser(manager, browserName);
      if (!backend) {
        failAuth(req, socket, head, browserName, 404, `Unknown browser "${browserName}"`);
        return;
      }
      // Gate step 4: per-key browser access (exact name match, NULL = all)
      if (!checkBrowserAccess(auth.record, backend.name)) {
        failAuth(req, socket, head, backend.name, 403, `API key has no CDP access to browser "${backend.name}"`);
        return;
      }

      try {
        if (backend.type === "navigator-cdp") {
          if (backend.status !== "connected") {
            failAuth(req, socket, head, backend.name, 409, `Browser "${backend.name}" is not connected — pair the extension first`);
            return;
          }
          safeHandleUpgrade(wss, req, socket, head, (ws) => {
            recordCdpConnection();
            auditCdpConnection({ req, record: auth.record, browserName: backend.name, ok: true });
            relayServer.attachGatewayClient(backend.name, ws);
          });
          return;
        }

        if (backend.type === "inbuilt") {
          if (manager._sharedBrowsers.size >= SHARED_CHROMIUM_CAP) {
            failAuth(req, socket, head, backend.name, 429, `Too many concurrent shared Chromium sessions (cap ${SHARED_CHROMIUM_CAP})`);
            return;
          }
          let shared;
          try {
            shared = await manager.createSharedBrowser();
          } catch (err) {
            failAuth(req, socket, head, backend.name, 502, `Could not launch shared Chromium: ${err?.message || err}`);
            return;
          }
          const endpoint = shared.wsEndpoint();
          let upstream;
          try {
            upstream = await dialAddOnCdp(endpoint);
          } catch (err) {
            try { await manager.closeSharedBrowser(shared); } catch {}
            failAuth(req, socket, head, backend.name, 502, `Could not reach shared Chromium: ${err?.message || err}`);
            return;
          }
          safeHandleUpgrade(wss, req, socket, head, (ws) => {
            recordCdpConnection();
            auditCdpConnection({ req, record: auth.record, browserName: backend.name, ok: true });
            pipeSockets(ws, upstream, backend.name, () => manager.closeSharedBrowser(shared));
          }, () => {
            try { upstream.close(); } catch {}
            manager.closeSharedBrowser(shared).catch(() => {});
          });
          return;
        }

        // Plain cdp add-on: dedicated second connection, duplex-piped.
        // Add-on-owned → disconnect our socket only, never close theirs.
        let upstream;
        try {
          upstream = await dialAddOnCdp(backend.cdpUrl);
        } catch (err) {
          failAuth(req, socket, head, backend.name, 502, `Could not reach browser "${backend.name}": ${err?.message || err}`);
          return;
        }
        safeHandleUpgrade(wss, req, socket, head, (ws) => {
          recordCdpConnection();
          auditCdpConnection({ req, record: auth.record, browserName: backend.name, ok: true });
          pipeSockets(ws, upstream, backend.name, null);
        }, () => {
          try { upstream.close(); } catch {}
        });
      } catch (err) {
        failAuth(req, socket, head, browserName, 500, `CDP proxy error: ${err?.message || err}`);
      }
    })().catch(() => {
      try { socket.destroy(); } catch {}
    });
  });

  console.error("CDP sharing enabled — browsers at /cdp/<browser>?key= (key always required)");
  return { enabled: true };
}

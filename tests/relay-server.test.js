import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import puppeteer from "puppeteer-core";
import { RelayServer, relayServer } from "../src/relay-server.js";

const ONE_PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop();
    try { await fn(); } catch { /* ignore cleanup errors */ }
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function ephemeralRelay() {
  // Each test starts from a clean persistence slate — the same state a fresh
  // navigator has. Without this, rows written by an earlier test (known
  // browsers, sessions, descriptions) are hydrated into this relay and leak
  // into its status entries.
  const { deleteKnownRelayBrowser, deleteRelaySession, deleteRelayTombstone, loadKnownRelayBrowsers, loadRelaySessions, loadRelayTombstones } = await import("../src/db.js");
  for (const k of loadKnownRelayBrowsers()) deleteKnownRelayBrowser(k.name);
  for (const s of loadRelaySessions()) deleteRelaySession(s.name);
  for (const t of loadRelayTombstones()) deleteRelayTombstone(t.name);

  const server = http.createServer(() => {});
  server.on("error", () => {});
  const port = await listen(server);
  if (server.unref) server.unref();
  const relay = new RelayServer();
  // Include gateway auth that accepts a test console key, mirroring production
  // behavior where navigator's loopback dial uses CONSOLE_API_KEY.
  const TEST_CONSOLE_KEY = "test-console-key";
  relay.init({
    server,
    host: "127.0.0.1",
    port,
    navigatorGatewayKey: TEST_CONSOLE_KEY,
    gatewayAuth: (req, url) => {
      try {
        const queryKey = String(url.searchParams.get("key") || "").trim();
        const headerKey = String(req.headers?.authorization?.replace(/^Bearer\s+/i, "") || "").trim();
        const presented = queryKey || headerKey;
        if (presented !== TEST_CONSOLE_KEY) {
          return { status: 401, error: "Invalid API key" };
        }
        return null;
      } catch {
        return { status: 401, error: "CDP requires an API key (?key= or Authorization header)" };
      }
    }
  });
  cleanups.push(() => {
    for (const entry of relay._entries.values()) {
      try { entry.ws?.close(); } catch {}
    }
    return new Promise((res) => {
      const guard = setTimeout(res, 800);
      server.close(() => { clearTimeout(guard); res(); });
    });
  });
  cleanups.push(() => relay._entries.clear());
  return { server, relay, port, wsBase: `ws://127.0.0.1:${port}`, testConsoleKey: TEST_CONSOLE_KEY };
}

function open(rawUrl, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(rawUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error(`open timeout: ${rawUrl}`)); }, timeoutMs);
    ws.once("open", () => { clearTimeout(timer); resolve(ws); });
    ws.once("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

const QUEUE = Symbol("messageQueue");

function installQueue(ws) {
  if (ws[QUEUE]) return ws[QUEUE];
  const queue = [];
  const waiters = [];
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    const idx = waiters.findIndex((w) => w.predicate(msg));
    if (idx !== -1) {
      const waiter = waiters.splice(idx, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    } else {
      queue.push(msg);
    }
  });
  ws[QUEUE] = { queue, waiters };
  return ws[QUEUE];
}

function nextMessage(ws, predicate, timeoutMs = 4000) {
  const { queue, waiters } = installQueue(ws);
  const idx = queue.findIndex((m) => !predicate || predicate(m));
  if (idx !== -1) return Promise.resolve(queue.splice(idx, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate: predicate || (() => true),
      resolve,
      timer: null
    };
    waiter.timer = setTimeout(() => {
      const i = waiters.indexOf(waiter);
      if (i !== -1) waiters.splice(i, 1);
      reject(new Error("timeout waiting for message"));
    }, timeoutMs);
    waiters.push(waiter);
  });
}

function flushAll(ws) {
  const { queue, waiters } = installQueue(ws);
  queue.length = 0;
  for (const w of waiters.splice(0)) clearTimeout(w.timer);
}

function nextClose(ws, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for close")), timeoutMs);
    ws.once("close", (code) => { clearTimeout(timer); resolve(code); });
  });
}

async function pairExtension(relay, wsBase, browserName, { platform = "chrome", sessionToken, bidiOrigin } = {}) {
  const ws = await open(`${wsBase}/relay`);
  ws.send(JSON.stringify({ type: "navigator-hello", browserName, platform, extensionVersion: "0.1.0", ...(bidiOrigin ? { bidiOrigin } : {}), ...(sessionToken ? { sessionToken } : {}) }));
  const pinRequired = await nextMessage(ws, (m) => m.type === "pin_required");
  expect(pinRequired).toEqual({ type: "pin_required" });
  const entry = relay._entries.get(browserName);
  const pin = entry.pendingPin.pin;
  ws.send(JSON.stringify({ type: "pin", pin }));
  await nextMessage(ws, (m) => m.type === "pin_accepted");
  const connected = await nextMessage(ws, (m) => m.type === "connected");
  return { ws, entry, token: connected.sessionToken };
}

describe("relay registry + PIN pairing (/relay)", () => {
  it("hello → pin_required → pin → pin_accepted + connected, status auth_pending→connected", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    const { ws, entry, token } = await pairExtension(relay, wsBase, "browser-a");
    expect(entry.status).toBe("connected");
    expect(typeof token).toBe("string");
    expect(entry.sessionToken).toBe(token);
    expect(entry.platform).toBe("chrome");
    expect(entry.extensionVersion).toBe("0.1.0");
    expect(entry.bidiOrigin).toBeNull(); // not sent → stays null
    expect(typeof entry.connectedAt).toBe("number");
    flushAll(ws);
    ws.close();
  });

  it("valid token skips PIN on reconnect; wrong PIN closes 4000", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    const { token, ws } = await pairExtension(relay, wsBase, "browser-b");
    ws.close();

    const re = await open(`${wsBase}/relay`);
    re.send(JSON.stringify({ type: "navigator-hello", browserName: "browser-b", platform: "chrome", sessionToken: token }));
    const connected = await nextMessage(re, (m) => m.type === "connected");
    expect(connected.sessionToken).toBe(token);
    expect(relay._entries.get("browser-b").status).toBe("connected");
    re.close();

    const bad = await open(`${wsBase}/relay`);
    bad.send(JSON.stringify({ type: "navigator-hello", browserName: "browser-b", platform: "chrome" }));
    await nextMessage(bad, (m) => m.type === "pin_required");
    const entry = relay._entries.get("browser-b");
    const wrongPin = entry.pendingPin.pin === "000000" ? "000001" : "000000";
    bad.send(JSON.stringify({ type: "pin", pin: wrongPin }));
    const closeCode = await nextClose(bad);
    expect(closeCode).toBe(4000);
    expect(relay._entries.get("browser-b").status).toBe("auth_pending");
  });

  it("expired PIN closes 4000; token for another name closes 4001", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    const { token } = await pairExtension(relay, wsBase, "name-one");

    const forOther = await open(`${wsBase}/relay`);
    forOther.send(JSON.stringify({ type: "navigator-hello", browserName: "name-two", platform: "chrome", sessionToken: token }));
    const otherClose = await nextClose(forOther);
    expect(otherClose).toBe(4001);

    const expired = await open(`${wsBase}/relay`);
    expired.send(JSON.stringify({ type: "navigator-hello", browserName: "name-three", platform: "chrome" }));
    await nextMessage(expired, (m) => m.type === "pin_required");
    relay._entries.get("name-three").pendingPin.expiresAt = Date.now() - 1000;
    expired.send(JSON.stringify({ type: "pin", pin: "123456" }));
    const expiredClose = await nextClose(expired);
    expect(expiredClose).toBe(4000);
  });

  it("status summaries: pre-declared roles honored, dynamic default appended, disconnect drops entry", async () => {
    const { relay } = await ephemeralRelay();
    const configured = [
      { name: "chromium", role: ["default"], addOn: false },
      { name: "pre-declared", role: ["default", "devtools"], type: "navigator-cdp", plugin: "chrome", addOn: true },
      { name: "plain-cdp", role: [], cdpUrl: "http://x:9222", type: "cdp", addOn: true }
    ];

    // disconnected pre-declared
    let entries = relay.getStatusEntries(configured);
    const pre = entries.find((e) => e.name === "pre-declared");
    expect(pre.status).toBe("disconnected");
    expect(pre.role).toEqual(["default", "devtools"]);
    expect(pre.configured).toBe(true);
    entries.find((e) => e.name === "plain-cdp");

    // connected via registry (same name) keeps configured roles
    relay._entries.set("pre-declared", {
      name: "pre-declared", plugin: "chrome", platform: "chrome", extensionVersion: "1.2.3",
      bidiOrigin: "moz-extension://11111111-2222-3333-4444-555555555555",
      status: "connected", ws: {}, connectedAt: 1, sessionToken: "t", pendingPin: null,
      tabs: [], tabWaiters: [], sessionForTarget: new Map(), extSessionToTarget: new Map(),
      tabIdToTarget: new Map(), clients: new Map(), lastActivity: Date.now()
    });
    entries = relay.getStatusEntries(configured);
    const preConnected = entries.find((e) => e.name === "pre-declared");
    expect(preConnected.status).toBe("connected");
    expect(preConnected.role).toEqual(["default", "devtools"]);
    expect(preConnected.connectedAt).toBe(1);
    expect(preConnected.extensionVersion).toBe("1.2.3");
    expect(preConnected.bidiOrigin).toBe("moz-extension://11111111-2222-3333-4444-555555555555");

    // dynamic registration (name not in config) appended with role ["default"]
    relay._entries.set("dynamic-ff", {
      name: "dynamic-ff", plugin: "firefox", platform: "firefox", extensionVersion: "0.0.9",
      status: "auth_pending", ws: {}, connectedAt: null, sessionToken: null,
      pendingPin: { pin: "654321", expiresAt: Date.now() + 60000 },
      tabs: [], tabWaiters: [], sessionForTarget: new Map(), extSessionToTarget: new Map(),
      tabIdToTarget: new Map(), clients: new Map(), lastActivity: Date.now()
    });
    entries = relay.getStatusEntries(configured);
    expect(entries[0].name).toBe("pre-declared");
    expect(entries[1].name).toBe("plain-cdp");
    expect(entries[2].name).toBe("dynamic-ff"); // after configured add-ons
    expect(entries[2].status).toBe("auth_pending");
    expect(entries[2].configured).toBe(false);
    expect(entries[2].role).toEqual(["default"]);

    // register each configured username in order → order preserved
    relay._entries.set("plain-cdp", {
      name: "plain-cdp", status: "connected", ws: {}, connectedAt: 2, sessionToken: "t2", pendingPin: null,
      tabs: [], tabWaiters: [], sessionForTarget: new Map(), extSessionToTarget: new Map(),
      tabIdToTarget: new Map(), clients: new Map(), lastActivity: Date.now()
    });
    entries = relay.getStatusEntries(configured);
    expect(entries.map((e) => e.name)).toEqual(["pre-declared", "plain-cdp", "dynamic-ff"]);
  });

  it("forget clears pairing but keeps the row; remove deletes the row entirely", async () => {
    const { relay } = await ephemeralRelay();
    relay._rememberKnown("ghost", "chrome");

    let entries = relay.getStatusEntries([]);
    const ghost = entries.find((e) => e.name === "ghost");
    expect(ghost).toBeTruthy();
    expect(ghost.status).toBe("disconnected");
    expect(ghost.paired).toBe(false);
    expect(ghost.configured).toBe(false);

    // Pair it the way the PIN flow does.
    relay._tokenToName.set("tok", "ghost");
    entries = relay.getStatusEntries([]);
    expect(entries.find((e) => e.name === "ghost").paired).toBe(true);

    // Forget: pairing cleared, token gone — but the row stays (disconnected, not paired).
    expect(relay.forget("ghost")).toBe(true);
    expect(relay.isPaired("ghost")).toBe(false);
    entries = relay.getStatusEntries([]);
    const afterForget = entries.find((e) => e.name === "ghost");
    expect(afterForget).toBeTruthy();
    expect(afterForget.status).toBe("disconnected");
    expect(afterForget.paired).toBe(false);

    // Remove: forget + drop the known-registry row entirely.
    expect(relay.remove("ghost")).toBe(true);
    expect(relay.getStatusEntries([]).map((e) => e.name)).not.toContain("ghost");
    expect(relay._knownBrowsers.has("ghost")).toBe(false);
  });

  it("forget closes an open socket with 4004 (distinct from PIN-expiry 4000, plan 60 B2)", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    const { ws } = await pairExtension(relay, wsBase, "forget-me");
    // A 4000 close means "PIN wrong/expired — keep your pairing". A server-initiated
    // forget must use a DIFFERENT code so the extension drops its stored token.
    expect(relay.forget("forget-me")).toBe(true);
    const closeCode = await nextClose(ws);
    expect(closeCode).toBe(4004);
  });

  it("remove() tombstones the name; a later hello is rejected 4005 — no dynamic resurrection (plan 60 B6)", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    const { ws } = await pairExtension(relay, wsBase, "removed-b6");
    expect(relay.remove("removed-b6")).toBe(true);
    const alertCode = await nextClose(ws); // removal still alerts the live socket via forget's 4004
    expect(alertCode).toBe(4004);

    // A fresh hello for the removed name must NOT recreate an entry or known row.
    const re = await open(`${wsBase}/relay`);
    re.send(JSON.stringify({ type: "navigator-hello", browserName: "removed-b6", platform: "chrome" }));
    const rejectCode = await nextClose(re);
    expect(rejectCode).toBe(4005);
    expect(relay._entries.has("removed-b6")).toBe(false);
    const { loadRelayTombstones } = await import("../src/db.js");
    expect(loadRelayTombstones().map((t) => t.name)).toContain("removed-b6");
  });

  it("a restarted relay rehydrates tombstones and keeps rejecting the removed name (plan 60 B6)", async () => {
    const { relay } = await ephemeralRelay();
    relay.remove("gone-b6"); // never paired — the removal stands on its own

    // Second instance over the SAME persistence slate (no wipe this time):
    // init() must hydrate the tombstone so the protection survives restarts.
    const server2 = http.createServer(() => {});
    server2.on("error", () => {});
    server2.unref?.();
    const port2 = await listen(server2);
    const relay2 = new RelayServer();
    relay2.init({ server: server2, host: "127.0.0.1", port: port2 });
    const ws2 = await open(`ws://127.0.0.1:${port2}/relay`);
    ws2.send(JSON.stringify({ type: "navigator-hello", browserName: "gone-b6", platform: "chrome" }));
    const code2 = await nextClose(ws2);
    expect(code2).toBe(4005);
    relay2._entries.clear();
    await new Promise((res) => {
      const g = setTimeout(res, 800);
      server2.close(() => { clearTimeout(g); res(); });
    });
  });

  it("re-adding the name to BROWSERS re-authorizes it — configured navigator-cdp bypasses the tombstone (plan 60 B6)", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    relay.remove("readded-b6");
    expect(relay._tombstones.has("readded-b6")).toBe(true);
    relay.updateConfiguredBrowsers([{ name: "readded-b6", type: "navigator-cdp" }]);
    // pairExtension's hello → pin_required flow proves the gate let it through.
    const { token } = await pairExtension(relay, wsBase, "readded-b6");
    expect(typeof token).toBe("string");
    expect(relay._entries.get("readded-b6").status).toBe("connected");
  });

  it("a dynamic hello for a name configured as a direct-CDP browser is rejected 4006 (collision, plan 60 B7)", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    relay.updateConfiguredBrowsers([{ name: "chromium", addOn: false }, { name: "dup-b7", type: "cdp", cdpUrl: "http://x:9222", addOn: true }]);
    const ws = await open(`${wsBase}/relay`);
    ws.send(JSON.stringify({ type: "navigator-hello", browserName: "dup-b7", platform: "chrome" }));
    const closeCode = await nextClose(ws);
    expect(closeCode).toBe(4006);
    expect(relay._entries.has("dup-b7")).toBe(false);
    // The builtin chromium name is equally unclaimable.
    const ws2 = await open(`${wsBase}/relay`);
    ws2.send(JSON.stringify({ type: "navigator-hello", browserName: "chromium", platform: "chrome" }));
    expect(await nextClose(ws2)).toBe(4006);
  });

  it("configuring a plain-cdp name evicts a live dynamic relay of that name — forget 4004, known row kept (plan 60 B7)", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    const { ws } = await pairExtension(relay, wsBase, "dup-b7");
    expect(relay._entries.has("dup-b7")).toBe(true);
    relay.updateConfiguredBrowsers([{ name: "dup-b7", type: "cdp", cdpUrl: "http://x:9222", addOn: true }]);
    const closeCode = await nextClose(ws);
    expect(closeCode).toBe(4004); // forget's close — not a new entry
    expect(relay._entries.has("dup-b7")).toBe(false);
    // forget keeps the known row (record of the dial-in), but a re-hello is
    // refused by the gate, so routing cannot stay conflicted.
    expect(relay._knownBrowsers.has("dup-b7")).toBe(true);
    const re = await open(`${wsBase}/relay`);
    re.send(JSON.stringify({ type: "navigator-hello", browserName: "dup-b7", platform: "chrome" }));
    expect(await nextClose(re)).toBe(4006);
  });
});

describe("browser description (plan 45) — auth gate, hello, live update, lifecycle", () => {
  it("setDescription normalizes CRLF, strips control chars, trims, caps 500", async () => {
    const { relay } = await ephemeralRelay();
    // Unauthenticated in-memory set is fine here: setDescription is the
    // validated entry point both the hello and update paths funnel through.
    // CRLF folds to LF, C0 controls (except tab/LF) and DEL are dropped, and
    // the ends are trimmed. Line structure is PRESERVED — list_browsers
    // flattens newlines when it renders the table cell.
    const messy = relay.setDescription("normalize", "  my\r\ndaily \u0000driver  ");
    expect(messy.ok).toBe(true);
    expect(messy.description).toBe("my\ndaily driver");
    expect(relay.getDescription("normalize")).toBe("my\ndaily driver");

    // Exactly 500 is allowed; 501 is not.
    expect(relay.setDescription("cap", "y".repeat(500)).ok).toBe(true);
    const tooLong = relay.setDescription("cap", "y".repeat(501));
    expect(tooLong.ok).toBe(false);
    expect(tooLong.error).toMatch(/500/);
    // The rejected write must not clobber the good one.
    expect(relay.getDescription("cap")).toBe("y".repeat(500));
  });

  it("does NOT apply a description from an unauthenticated hello (no PIN accepted yet)", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    const ws = await open(`${wsBase}/relay`);
    // Attacker-style hello: knows the name, claims a description, never pairs.
    ws.send(JSON.stringify({
      type: "navigator-hello",
      browserName: "victim",
      platform: "chrome",
      browserDescription: "hijacked by an unauthenticated peer"
    }));
    await nextMessage(ws, (m) => m.type === "pin_required");
    // Auth is still pending — the description must NOT have been written.
    expect(relay.getDescription("victim")).toBe("");
    expect(relay.getStatusEntries([]).find((e) => e.name === "victim")?.description).toBe("");
    ws.close();
  });

  it("ignores update_description before authentication, applies it once connected", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    const ws = await open(`${wsBase}/relay`);
    ws.send(JSON.stringify({ type: "navigator-hello", browserName: "late", platform: "chrome" }));
    await nextMessage(ws, (m) => m.type === "pin_required");
    // Rejected: not connected yet. No ack, no write.
    ws.send(JSON.stringify({ type: "update_description", description: "too early" }));
    await new Promise((r) => setTimeout(r, 120));
    expect(relay.getDescription("late")).toBe("");

    // Pair it for real.
    const pin = relay._entries.get("late").pendingPin.pin;
    ws.send(JSON.stringify({ type: "pin", pin }));
    await nextMessage(ws, (m) => m.type === "connected");

    // Now the same message is honoured, and acked.
    ws.send(JSON.stringify({ type: "update_description", description: "my daily driver" }));
    const acked = await nextMessage(ws, (m) => m.type === "description_updated");
    expect(acked.description).toBe("my daily driver");
    expect(relay.getDescription("late")).toBe("my daily driver");
    ws.close();
  });

  it("applies the hello-carried description only after a valid token reconnect", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    const { token, ws } = await pairExtension(relay, wsBase, "roamer");
    expect(relay.getDescription("roamer")).toBe("");
    ws.close();

    // Silent token reconnect that also carries a description edited while offline.
    const re = await open(`${wsBase}/relay`);
    re.send(JSON.stringify({
      type: "navigator-hello",
      browserName: "roamer",
      platform: "chrome",
      sessionToken: token,
      browserDescription: "the laptop I take everywhere"
    }));
    await nextMessage(re, (m) => m.type === "connected");
    expect(relay.getDescription("roamer")).toBe("the laptop I take everywhere");
    re.close();
  });

  it("applies the hello description on first-time PIN pairing", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    const ws = await open(`${wsBase}/relay`);
    ws.send(JSON.stringify({
      type: "navigator-hello",
      browserName: "fresh",
      platform: "chrome",
      browserDescription: "first pair, description included"
    }));
    await nextMessage(ws, (m) => m.type === "pin_required");
    expect(relay.getDescription("fresh")).toBe("");
    const pin = relay._entries.get("fresh").pendingPin.pin;
    ws.send(JSON.stringify({ type: "pin", pin }));
    await nextMessage(ws, (m) => m.type === "connected");
    expect(relay.getDescription("fresh")).toBe("first pair, description included");
    ws.close();
  });

  it("survives disconnect + re-pair, is deleted only by remove()", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    const { token, ws } = await pairExtension(relay, wsBase, "keepme");
    relay.setDescription("keepme", "still me after re-pairing");
    expect(relay.getDescription("keepme")).toBe("still me after re-pairing");

    // forget() drops the pairing but is NOT "forget who this browser is".
    expect(relay.forget("keepme")).toBe(true);
    expect(relay.isPaired("keepme")).toBe(false);
    expect(relay.getDescription("keepme")).toBe("still me after re-pairing");

    // Re-pair with a brand new token; the description is still ours.
    const again = await pairExtension(relay, wsBase, "keepme");
    expect(relay.getDescription("keepme")).toBe("still me after re-pairing");
    expect(again.token).not.toBe(token);
    ws.close();
    again.ws.close();

    // remove() is the full delete — the description goes with the row.
    expect(relay.remove("keepme")).toBe(true);
    expect(relay.getDescription("keepme")).toBe("");
  });

  it("rejects a >500 char description and echoes the limit", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    const { ws } = await pairExtension(relay, wsBase, "chatty");
    ws.send(JSON.stringify({ type: "update_description", description: "x".repeat(501) }));
    const err = await nextMessage(ws, (m) => m.type === "description_error");
    expect(err.error).toMatch(/500/);
    expect(relay.getDescription("chatty")).toBe("");
    ws.close();
  });

  it("an old extension (no browserDescription field) leaves an existing description intact", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    const { token, ws } = await pairExtension(relay, wsBase, "legacy");
    relay.setDescription("legacy", "written by the new popup");
    ws.close();

    // Reconnect with no browserDescription key at all (old extension build).
    const re = await open(`${wsBase}/relay`);
    re.send(JSON.stringify({ type: "navigator-hello", browserName: "legacy", platform: "chrome", sessionToken: token }));
    await nextMessage(re, (m) => m.type === "connected");
    expect(relay.getDescription("legacy")).toBe("written by the new popup");
    re.close();
  });

  it("an explicit empty browserDescription CLEARS the description (new popup emptied the field)", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    const { token, ws } = await pairExtension(relay, wsBase, "wiper");
    relay.setDescription("wiper", "no longer accurate");
    ws.close();

    // Present-but-empty is the "user cleared it" signal and must wipe the
    // value. This is the exact counterpart of the previous test: absent
    // field = keep, empty field = clear. Both extensions send the field
    // unconditionally (typeof check, not truthiness) to make this reachable.
    const re = await open(`${wsBase}/relay`);
    re.send(JSON.stringify({
      type: "navigator-hello",
      browserName: "wiper",
      platform: "chrome",
      sessionToken: token,
      browserDescription: ""
    }));
    await nextMessage(re, (m) => m.type === "connected");
    expect(relay.getDescription("wiper")).toBe("");
    re.close();

    // And the same over the live path.
    const { ws: back } = await pairExtension(relay, wsBase, "wiper");
    relay.setDescription("wiper", "typed again");
    back.send(JSON.stringify({ type: "update_description", description: "" }));
    const acked = await nextMessage(back, (m) => m.type === "description_updated");
    expect(acked.description).toBe("");
    expect(relay.getDescription("wiper")).toBe("");
    back.close();
  });

  it("persists a description to SQLite and hydrates it into a fresh RelayServer (survives a navigator restart)", async () => {
    const { relay } = await ephemeralRelay();
    // setDescription is the single write path for both the hello and the live
    // update, so writing through it exercises the DB round-trip too.
    relay.setDescription("persisted", "the studio machine");
    const { loadRelayBrowserMetas, deleteRelayBrowserMeta } = await import("../src/db.js");
    const rows = loadRelayBrowserMetas();
    expect(rows.find((r) => r.name === "persisted")?.description).toBe("the studio machine");
    expect(typeof rows.find((r) => r.name === "persisted")?.updated_at).toBe("number");

    // A brand new server instance (what a container restart gives us) starts
    // with an empty in-memory map and must pick the description back up.
    const fresh = new RelayServer();
    expect(fresh.getDescription("persisted")).toBe("");
    fresh.init({ server: http.createServer(() => {}), host: "127.0.0.1", port: 0 });
    expect(fresh.getDescription("persisted")).toBe("the studio machine");

    // remove() is the only thing that drops the row from disk.
    expect(deleteRelayBrowserMeta("persisted")).toBe(true);
    expect(loadRelayBrowserMetas().find((r) => r.name === "persisted")).toBeUndefined();
  });

  it("restores persisted pairings only for names still configured navigator-cdp (plan 60 B1)", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    const { token, ws } = await pairExtension(relay, wsBase, "configured-relay");
    ws.close();

    // A brand new server instance (a navigator restart). The persisted pairing
    // is authorized only when the fresh server's BROWSERS config still names
    // the browser as navigator-cdp; otherwise the row is kept but the token is
    // NOT restored, so a removed relay cannot silently route traffic again.
    const retained = new RelayServer();
    retained.init({
      server: http.createServer(() => {}),
      host: "127.0.0.1",
      port: 0,
      configuredBrowsers: [{ name: "something-else", type: "navigator-cdp" }]
    });
    expect(retained._tokenToName.has(token)).toBe(false);
    expect(retained._tokenToName.size).toBe(0);

    const authorized = new RelayServer();
    authorized.init({
      server: http.createServer(() => {}),
      host: "127.0.0.1",
      port: 0,
      configuredBrowsers: [{ name: "configured-relay", type: "navigator-cdp" }]
    });
    expect(authorized._tokenToName.get(token)).toBe("configured-relay");

    // Without any browser config (standalone embedder), legacy restore-all
    // still applies so the relay does not silently drop pairings it knows
    // nothing about.
    const legacy = new RelayServer();
    legacy.init({ server: http.createServer(() => {}), host: "127.0.0.1", port: 0 });
    expect(legacy._tokenToName.get(token)).toBe("configured-relay");
  });
});

describe("pure CDP gateway (/browser/<name>) with a fake-extension backend", () => {
  class FakeExtension {
    constructor(ws) {
      this.ws = ws;
      this.tabs = new Map();
      this.attached = new Map(); // targetId -> extSessionId
      this.next = 1;
      ws.on("message", (data) => this._onMessage(String(data)));
    }

    send(msg) { this.ws.send(JSON.stringify(msg)); }
    reply(id, result) { this.send({ id, result }); }
    fail(id, message) { this.send({ id, error: { code: -32000, message } }); }

    tabList() {
      return [...this.tabs.values()].map((t) => ({
        targetId: t.targetId,
        type: "page",
        title: t.title,
        url: t.url,
        attached: this.attached.has(t.targetId),
        // Plan 56: real extension's tab_list emits the window context id too.
        browserContextId: t.browserContextId || "default"
      }));
    }

    emit(sessionId, method, params) {
      this.send({ type: "cdp_event", method, params, sessionId });
    }

    sessionTab(sessionId) {
      for (const [targetId, sid] of this.attached) {
        if (sid === sessionId) return this.tabs.get(targetId);
      }
      return null;
    }

    _onMessage(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ping") { this.send({ type: "pong" }); return; }
      if (msg.type === "list_tabs_request") { this.send({ type: "tab_list", tabs: this.tabList() }); return; }
      if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
      this._onCommand(msg);
    }

    _onCommand(msg) {
      const { id, method, params = {}, sessionId } = msg;
      switch (method) {
        case "Browser.getVersion":
          return this.reply(id, { protocolVersion: "1.3", product: "Fake/0.1.0 (test)", revision: "1", userAgent: "fake-agent/0.1", jsVersion: "1.8" });
        case "Target.createTarget": {
          const targetId = `tab-${this.next++}`;
          this.tabs.set(targetId, {
            targetId, type: "page", title: "New Tab", url: String(params.url || "about:blank"),
            browserContextId: params.browserContextId || "default"
          });
          // Window-mode (plan 56): echo the browserContextId like the real
          // extension's createWindowTab does, so the relay can record it.
          this.reply(id, params.browserContextId ? { targetId, browserContextId: params.browserContextId } : { targetId });
          this.send({ type: "tab_list", tabs: this.tabList() });
          return;
        }
        case "Target.getBrowserContexts":
          // Plan 56 pass-through: the contexts live on the extension side.
          return this.reply(id, { browserContextIds: ["default", "window-42"] });
        case "Target.attachToTarget": {
          const tab = this.tabs.get(params.targetId);
          if (!tab) return this.fail(id, `No target: ${params.targetId}`);
          const extSession = `ext-${params.targetId}`;
          this.attached.set(params.targetId, extSession);
          this.reply(id, { sessionId: extSession });
          return;
        }
        case "Target.detachFromTarget": {
          for (const [targetId, sid] of this.attached) {
            if (sid === params.sessionId || targetId === params.targetId) {
              this.attached.delete(targetId);
              this.send({ type: "cdp_event", method: "Target.detachedFromTarget", sessionId: sid, params: { sessionId: sid } });
            }
          }
          return this.reply(id, {});
        }
        case "Target.getTargetInfo": {
          const tab = this.tabs.get(params.targetId);
          if (!tab) return this.fail(id, `No target: ${params.targetId}`);
          return this.reply(id, { targetInfo: this.tabList().find((t) => t.targetId === params.targetId) });
        }
        case "Page.getFrameTree": {
          const tab = this.sessionTab(sessionId);
          const frameId = `frame-${sessionId}`;
          return this.reply(id, {
            frameTree: {
              frame: {
                id: frameId,
                loaderId: `loader-${frameId}`,
                url: tab?.url || "about:blank",
                mimeType: "text/html",
                securityOrigin: "https://example.com"
              },
              childFrames: []
            }
          });
        }
        case "Page.navigate": {
          const tab = this.sessionTab(sessionId);
          const frameId = `frame-${sessionId}`;
          const loaderId = `loader-${frameId}-${this.next++}`;
          const url = String(params.url || tab?.url || "about:blank");
          if (tab) { tab.url = url; tab.title = url; this.send({ type: "tab_list", tabs: this.tabList() }); }
          this.reply(id, { frameId, loaderId });
          const now = Date.now() / 1000;
          this.emit(sessionId, "Page.lifecycleEvent", { frameId, loaderId, name: "init", timestamp: now });
        this.emit(sessionId, "Page.frameStartedLoading", { frameId });
          this.emit(sessionId, "Page.frameNavigated", {
            frame: {
              id: frameId,
              loaderId,
              url,
              name: "",
              securityOrigin: "https://example.com",
              mimeType: "text/html",
              parentId: undefined
            }
          });
          this.emit(sessionId, "Page.lifecycleEvent", { frameId, loaderId, name: "load", timestamp: now });
          this.emit(sessionId, "Page.loadEventFired", { frameId, loaderId, timestamp: now });
          return;
        }
        case "Runtime.enable": {
        this.emit(sessionId, "Runtime.executionContextCreated", { context: { id: 1, origin: "https://example.com", name: "", uniqueId: "ctx-1", auxData: { isDefault: true, frameId: `frame-${sessionId}`, type: "default" } } });
        return this.reply(id, {});
      }
      case "Runtime.evaluate":
          return this.reply(id, { result: { type: "number", value: 42 } });
        case "Target.closeTarget": {
          const tab = this.tabs.get(params.targetId);
          if (!tab) return this.fail(id, `No target: ${params.targetId}`);
          this.tabs.delete(params.targetId);
          const sid = this.attached.get(params.targetId);
          if (sid) this.attached.delete(params.targetId);
          this.reply(id, {});
          this.send({ type: "tab_list", tabs: this.tabList() });
          return;
        }
        case "Runtime.callFunctionOn":
          return this.reply(id, { result: { type: "number", value: 42 } });
        case "Page.captureScreenshot":
          return this.reply(id, { data: ONE_PX_PNG, captureError: undefined });
        default:
          // Blank result for enables/overrides — nothing the puppeteer handshake needs a real value from.
          return this.reply(id, {});
      }
    }
  }

  it("drives browser.version(), newPage, goto, evaluate, screenshot, pages() through the gateway", async () => {
    const { relay, wsBase, testConsoleKey } = await ephemeralRelay();
    const { token, ws } = await pairExtension(relay, wsBase, "fake-chrome");
    const fake = new FakeExtension(ws);

    const browser = await puppeteer.connect({
      browserWSEndpoint: `${wsBase}/browser/fake-chrome?key=${testConsoleKey}`,
      defaultViewport: { width: 800, height: 600 }
    });
    cleanups.push(() => { try { browser.disconnect(); } catch {} });

    try {
      const version = await browser.version();
      expect(version).toContain("Fake/0.1.0");

      expect((await browser.pages()).length).toBe(0);

      const page = await browser.newPage();
      page.setDefaultTimeout(6000);
      expect((await browser.pages()).length).toBe(1);

      const session = await page.createCDPSession();
      await session.send("Network.enable");
      expect(await page.evaluate(() => 1 + 1)).toBe(42);

      const frameUrlBefore = page.url();
      expect(frameUrlBefore).toBe("about:blank");

      const response = await page.goto("https://example.com/landing", { waitUntil: "load", timeout: 6000 });
      expect([null, 200]).toContain(response?.status?.() ?? null);
      expect(page.url()).toBe("https://example.com/landing");

      const evaluated = await page.evaluate(() => 1 + 1);
      expect(evaluated).toBe(42);

      const shot = await page.screenshot({ type: "png" });
      expect(Buffer.isBuffer(shot)).toBe(true);
      expect(shot.length).toBeGreaterThan(10);

      await page.close();
      await new Promise((r) => setTimeout(r, 150));
      expect((await browser.pages()).length).toBe(0);
    } finally {
      try { await browser.disconnect(); } catch {}
    }
  }, 30000);

  it("createTarget ack is held until the new tab attaches (attachedToTarget precedes the ack)", async () => {
    const { relay, wsBase, testConsoleKey } = await ephemeralRelay();
    const { ws } = await pairExtension(relay, wsBase, "hold-browser");
    const fake = new FakeExtension(ws);
    const gw = await open(`${wsBase}/browser/hold-browser?key=${testConsoleKey}`);
    flushAll(gw);
    gw.send(JSON.stringify({ id: 1, method: "Target.setDiscoverTargets", params: { discover: true } }));
    await nextMessage(gw, (m) => m.id === 1);
    gw.send(JSON.stringify({ id: 2, method: "Target.createTarget", params: { url: "about:blank" } }));

    const attached = await nextMessage(gw, (m) => m.method === "Target.attachedToTarget", 8000);
    expect(attached.params.targetInfo.targetId).toMatch(/^tab-/);
    const ack = await nextMessage(gw, (m) => m.id === 2, 8000);
    expect(ack.result.targetId).toBe(attached.params.targetInfo.targetId);
    expect(ack.error).toBeUndefined();
    gw.close();
  });

  it("preserves sessionId for session-scoped Target.setAutoAttach", async () => {
    const { relay, wsBase, testConsoleKey } = await ephemeralRelay();
    const { ws } = await pairExtension(relay, wsBase, "auto-attach-session-browser");
    new FakeExtension(ws);
    const gw = await open(`${wsBase}/browser/auto-attach-session-browser?key=${testConsoleKey}`);
    flushAll(gw);

    gw.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: "about:blank" } }));
    const attached = await nextMessage(gw, (m) => m.method === "Target.attachedToTarget", 8000);
    await nextMessage(gw, (m) => m.id === 1, 8000);

    gw.send(JSON.stringify({
      id: 2,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, flatten: true },
      sessionId: attached.params.sessionId
    }));
    const reply = await nextMessage(gw, (m) => m.id === 2, 8000);
    expect(reply.error).toBeUndefined();
    expect(reply.sessionId).toBe(attached.params.sessionId);
    gw.close();
  });

  it("forwards Target.getBrowserContexts and threads browserContextId through created targets", async () => {
    const { relay, wsBase, testConsoleKey } = await ephemeralRelay();
    const { ws } = await pairExtension(relay, wsBase, "ctx-browser");
    const fake = new FakeExtension(ws);
    const gw = await open(`${wsBase}/browser/ctx-browser?key=${testConsoleKey}`);
    flushAll(gw);

    // 1. getBrowserContexts — the relay returns the extension's list, not the
    //    hardcoded ["default"] (plan 56 pass-through).
    gw.send(JSON.stringify({ id: 1, method: "Target.getBrowserContexts", params: {} }));
    const ctxReply = await nextMessage(gw, (m) => m.id === 1, 8000);
    expect(ctxReply.error).toBeUndefined();
    expect(ctxReply.result.browserContextIds).toEqual(["default", "window-42"]);

    // 2. createTarget with a window context id — the browserContextId survives
    //    _registerCreatedTarget into the synthesized attachedToTarget info and
    //    the relay's own tab registry.
    gw.send(JSON.stringify({ id: 2, method: "Target.createTarget", params: { url: "about:blank", browserContextId: "window-42" } }));
    const attached = await nextMessage(gw, (m) => m.method === "Target.attachedToTarget", 8000);
    const ack = await nextMessage(gw, (m) => m.id === 2, 8000);
    expect(ack.result.targetId).toBe(attached.params.targetInfo.targetId);
    expect(attached.params.targetInfo.browserContextId).toBe("window-42");
    expect(fake.tabs.get(ack.result.targetId)).toEqual(expect.objectContaining({ browserContextId: "window-42" }));
    expect(relay._entries.get("ctx-browser").tabs.find((t) => t.targetId === ack.result.targetId))
      .toEqual(expect.objectContaining({ browserContextId: "window-42" }));
    gw.close();
  });

  it("createTarget errors fast (not a 30s hang) when the extension never attaches — flapped attach", async () => {
    const { relay, wsBase, testConsoleKey } = await ephemeralRelay();
    const { ws } = await pairExtension(relay, wsBase, "flap-browser");
    const orphanCloses = [];
    const fake = new FakeExtension(ws);
    const baseCommand = fake._onCommand.bind(fake);
    fake._onCommand = (msg) => {
      if (msg.method === "Target.attachToTarget") return; // flap dropped the reply
      if (msg.method === "Target.closeTarget") {
        orphanCloses.push(msg.params.targetId);
        return fake.reply(msg.id, {});
      }
      return baseCommand(msg);
    };

    const gw = await open(`${wsBase}/browser/flap-browser?key=${testConsoleKey}`);
    flushAll(gw);
    gw.send(JSON.stringify({ id: 1, method: "Target.setDiscoverTargets", params: { discover: true } }));
    await nextMessage(gw, (m) => m.id === 1);
    const start = Date.now();
    gw.send(JSON.stringify({ id: 2, method: "Target.createTarget", params: { url: "about:blank" } }));
    const reply = await nextMessage(gw, (m) => m.id === 2, 12000);
    const elapsed = Date.now() - start;
    // Far under puppeteer's 30s waitForTarget — the relay must settle the
    // command itself instead of leaving the client to time out.
    expect(elapsed).toBeLessThan(10000);
    expect(reply.error).toBeTruthy();
    expect(reply.error.message).toMatch(/did not attach/);
    // The orphan tab is closed best-effort by the relay so no ghost tab is left
    // in the user's browser after a failed createTarget.
    await new Promise((r) => setTimeout(r, 600));
    expect(orphanCloses).toContain(reply.error.message.match(/New tab (\S+) was created/)?.[1]);
    gw.close();
  });
});

describe("routing: auth_pending navigator-cdp is never a routing candidate (resolveBrowserParam)", () => {
  it("skips auth_pending in the fallback chain and errors on an explicit request", async () => {
    const { resolveBrowserParam } = await import("../src/browser.js");
    relayServer._entries.set("pending-browser", {
      name: "pending-browser", plugin: "auto", platform: "chrome", extensionVersion: null,
      status: "auth_pending", ws: null, connectedAt: null, sessionToken: null,
      pendingPin: { pin: "111111", expiresAt: Date.now() + 60000 },
      tabs: [], tabWaiters: [], sessionForTarget: new Map(), extSessionToTarget: new Map(),
      tabIdToTarget: new Map(), clients: new Map(), lastActivity: Date.now()
    });
    const cfg = {
      browsers: [
        { name: "chromium", role: ["default"], addOn: false },
        { name: "pending-browser", role: ["default"], type: "navigator-cdp", plugin: "auto", addOn: true }
      ]
    };
    const connectSpy = vi.fn(async (entry) => ({ fake: entry.name }));
    const chromiumSpy = vi.fn(async () => ({ fake: "chromium" }));
    const mgr = {
      config: cfg,
      _effectiveAddOns: () => relayServer.getStatusEntries(cfg.browsers),
      _connectAddOnPage: connectSpy,
      _newChromiumPage: chromiumSpy
    };

    // explicit → hard error, not a fallback
    await expect(
      resolveBrowserParam({ browser: "pending-browser" }, cfg, mgr)
    ).rejects.toThrow(/auth_pending/);
    expect(connectSpy).not.toHaveBeenCalled();

    // implicit → falls through to chromium with a rollback note
    const result = await resolveBrowserParam({}, cfg, mgr);
    expect(result.browser).toBe("chromium");
    expect(result.rollbackNotes).toContain("pending-browser: auth_pending");
    expect(connectSpy).not.toHaveBeenCalled();
    expect(chromiumSpy).toHaveBeenCalledOnce();

    cleanups.push(() => relayServer._entries.delete("pending-browser"));
  });
});


describe("attach failure reason identity (plan 59 §9a)", () => {
  // The reason used to live in a single `relayServer._attachFailure` slot that
  // was written by whichever attach failed and read-and-cleared by whichever
  // waiter woke first, so two concurrent attaches could report each other's
  // failure. The client socket below IS the extension: it answers the
  // relay's Target.attachToTarget frames itself.
  function attachResponder(ws, handlers) {
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
      if (msg.method !== "Target.attachToTarget") return;
      const h = handlers[msg.params?.targetId];
      if (typeof h !== "function") return;
      h(msg.id);
    });
  }

  it("two concurrent failed attaches each keep their own reason (out-of-order replies)", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    const { ws } = await pairExtension(relay, wsBase, "attach-race");
    const entry = relay._entries.get("attach-race");
    entry.tabs = [
      { targetId: "tab-A", type: "page", title: "A", url: "https://a.example/" },
      { targetId: "tab-B", type: "page", title: "B", url: "https://b.example/" },
    ];
    // tab-B is answered FIRST, tab-A second — the inverse of request order.
    attachResponder(ws, {
      "tab-B": (id) => setTimeout(() => ws.send(JSON.stringify({
        id, error: { code: -32000, message: "reason-for-B" } })), 0),
      "tab-A": (id) => setTimeout(() => ws.send(JSON.stringify({
        id, error: { code: -32000, message: "reason-for-A" } })), 40),
    });

    const [a, b] = await Promise.all([
      relay._ensureTargetSession(entry, { targetId: "tab-A" }),
      relay._ensureTargetSession(entry, { targetId: "tab-B" }),
    ]);

    expect(a.sessionId).toBeNull();
    expect(b.sessionId).toBeNull();
    expect(a.reason).toContain("reason-for-A");
    expect(b.reason).toContain("reason-for-B");
    expect(a.reason).not.toContain("reason-for-B");
    expect(b.reason).not.toContain("reason-for-A");
  }, 20000);

  it("the shared attach-failure slot no longer exists on the relay", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    await pairExtension(relay, wsBase, "attach-slot");
    expect(relay._attachFailure).toBeUndefined();
  }, 20000);

  it("a successful attach resolves { sessionId, reason: null }", async () => {
    const { relay, wsBase } = await ephemeralRelay();
    const { ws } = await pairExtension(relay, wsBase, "attach-ok");
    const entry = relay._entries.get("attach-ok");
    entry.tabs = [{ targetId: "tab-OK", type: "page", title: "OK", url: "https://ok.example/" }];
    attachResponder(ws, {
      "tab-OK": (id) => setTimeout(() => ws.send(JSON.stringify({
        id, result: { sessionId: "sess-1" } })), 0),
    });

    const res = await relay._ensureTargetSession(entry, { targetId: "tab-OK" });
    expect(res.sessionId).toBe("sess-1");
    expect(res.reason).toBeNull();
  }, 20000);
});

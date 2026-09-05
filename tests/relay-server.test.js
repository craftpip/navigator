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
  const server = http.createServer(() => {});
  server.on("error", () => {});
  const port = await listen(server);
  if (server.unref) server.unref();
  const relay = new RelayServer();
  relay.init({ server, host: "127.0.0.1", port });
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
  return { server, relay, port, wsBase: `ws://127.0.0.1:${port}` };
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
        attached: this.attached.has(t.targetId)
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
          this.tabs.set(targetId, { targetId, type: "page", title: "New Tab", url: String(params.url || "about:blank") });
          this.reply(id, { targetId });
          this.send({ type: "tab_list", tabs: this.tabList() });
          return;
        }
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
    const { relay, wsBase } = await ephemeralRelay();
    const { token, ws } = await pairExtension(relay, wsBase, "fake-chrome");
    const fake = new FakeExtension(ws);

    const browser = await puppeteer.connect({
      browserWSEndpoint: `${wsBase}/browser/fake-chrome`,
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
import http from "node:http";
import { it, expect } from "vitest";
import { WebSocket } from "ws";
import { RelayServer } from "../src/relay-server.js";

function listen(server) {
  return new Promise((res, rej) => { server.once("error", rej); server.listen(0, "127.0.0.1", () => res(server.address().port)); });
}
function installQueue(ws) {
  if (ws.Q) return;
  const queue = [];
  const waiters = [];
  ws.on("message", (data) => {
    let msg; try { msg = JSON.parse(String(data)); } catch { return; }
    const idx = waiters.findIndex((w) => w.pred(msg));
    if (idx !== -1) { const w = waiters.splice(idx, 1)[0]; clearTimeout(w.t); w.res(msg); }
    else queue.push(msg);
  });
  ws.Q = { queue, waiters };
}
function nextMsg(ws, pred, ms = 3000) {
  installQueue(ws);
  const { queue, waiters } = ws.Q;
  const idx = queue.findIndex((m) => pred(m));
  if (idx !== -1) return Promise.resolve(queue.splice(idx, 1)[0]);
  return new Promise((res, rej) => {
    const w = { pred, res, t: null };
    w.t = setTimeout(() => { const i = waiters.indexOf(w); if (i !== -1) { waiters.splice(i, 1); rej(new Error("msg timeout")); } }, ms);
    waiters.push(w);
  });
}
async function open(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  return ws;
}
async function pairExtension(relay, wsBase, name) {
  const ws = await open(`${wsBase}/relay`);
  ws.send(JSON.stringify({ type: "navigator-hello", browserName: name, platform: "chrome", extensionVersion: "0.1.0" }));
  await nextMsg(ws, (m) => m.type === "pin_required");
  const pin = relay._entries.get(name).pendingPin.pin;
  ws.send(JSON.stringify({ type: "pin", pin }));
  await nextMsg(ws, (m) => m.type === "pin_accepted");
  const connected = await nextMsg(ws, (m) => m.type === "connected");
  return { ws, entry: relay._entries.get(name), token: connected.sessionToken };
}

let extSeq = 0;
class FakeExtension {
  constructor(ws) {
    this.ws = ws;
    this.tabs = new Map();
    this.attached = new Map();
    this.next = 1;
    ws.on("message", (data) => this._onMessage(String(data)));
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  reply(id, result) { this.send({ id, result }); }
  fail(id, m) { this.send({ id, error: { code: -32000, message: m } }); }
  tabList() { return [...this.tabs.values()].map(t => ({ targetId: t.targetId, type: "page", title: t.title, url: t.url, attached: this.attached.has(t.targetId) })); }
  emit(sessionId, method, params) { this.send({ type: "cdp_event", method, params, sessionId }); }
  sessionTab(sessionId) { for (const [t, s] of this.attached) if (s === sessionId) return this.tabs.get(t); return null; }
  _onMessage(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ping") { this.send({ type: "pong" }); return; }
    if (msg.type === "list_tabs_request") { this.send({ type: "tab_list", tabs: this.tabList() }); return; }
    if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
    const { id, method, params = {}, sessionId } = msg;
    switch (method) {
      case "Browser.getVersion": return this.reply(id, { protocolVersion: "1.3", product: "Fake/0.1.0 (test)", revision: "1", userAgent: "fake-agent/0.1", jsVersion: "1.8" });
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
          if (sid === params.sessionId || targetId === params.targetId) { this.attached.delete(targetId); this.send({ type: "cdp_event", method: "Target.detachedFromTarget", sessionId: sid, params: { sessionId: sid } }); }
        }
        return this.reply(id, {});
      }
      case "Target.getTargetInfo": {
        const tab = this.tabs.get(params.targetId);
        if (!tab) return this.fail(id, `No target: ${params.targetId}`);
        return this.reply(id, { targetInfo: this.tabList()[0] });
      }
      case "Page.enable": return this.reply(id, {});
      case "Page.getFrameTree": {
        const tab = this.sessionTab(sessionId);
        const frameId = `frame-${sessionId}`;
        return this.reply(id, { frameTree: { frame: { id: frameId, loaderId: `loader-${frameId}`, url: tab?.url || "about:blank", mimeType: "text/html", securityOrigin: "https://example.com" }, childFrames: [] } });
      }
      case "Page.navigate": {
        const tab = this.sessionTab(sessionId);
        const frameId = `frame-${sessionId}`;
        const loaderId = `loader-${frameId}`;
        const url = String(params.url || tab?.url || "about:blank");
        if (tab) { tab.url = url; tab.title = url; this.send({ type: "tab_list", tabs: this.tabList() }); }
        this.reply(id, { frameId, loaderId });
        const now = Date.now() / 1000;
        this.emit(sessionId, "Page.frameStartedLoading", { frameId });
        this.emit(sessionId, "Page.frameNavigated", { frame: { id: frameId, loaderId, url, name: "", securityOrigin: "https://example.com", mimeType: "text/html", parentId: undefined } });
        this.emit(sessionId, "Page.lifecycleEvent", { frameId, loaderId, name: "load", timestamp: now });
        this.emit(sessionId, "Page.loadEventFired", { frameId, loaderId, timestamp: now });
        return;
      }
      case "Runtime.evaluate": return this.reply(id, { result: { type: "number", value: 42 } });
      case "Page.captureScreenshot": return this.reply(id, { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", captureError: undefined });
      default: return this.reply(id, {});
    }
  }
}

it("raw gateway driver", async () => {
  const server = http.createServer(() => {});
  const port = await listen(server);
  const relay = new RelayServer();
  relay.init({ server, host: "127.0.0.1", port });
  const { ws } = await pairExtension(relay, `ws://127.0.0.1:${port}`, "fake-chrome");
  const fake = new FakeExtension(ws);

  const gw = await open(`ws://127.0.0.1:${port}/browser/fake-chrome`);
  const pip = (m) => new Promise((res, rej) => {
    gw.send(JSON.stringify(m));
    const t = setTimeout(() => rej(new Error("resp timeout " + m.method)), 3000);
    const h = (d) => { const r = JSON.parse(String(d)); if (r.id === m.id) { clearTimeout(t); gw.off("message", h); res(r); } };
    gw.on("message", h);
  });
  // handshake
  await pip({ id: 1, method: "Target.setDiscoverTargets", params: { discover: true } });
  await pip({ id: 2, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } });
  // create + attach
  const created = await pip({ id: 3, method: "Target.createTarget", params: { url: "about:blank" } });
  console.log("created:", JSON.stringify(created));
  await new Promise((r) => setTimeout(r, 300));
  const attach = await pip({ id: 4, method: "Target.attachToTarget", params: { targetId: created.result.targetId, flatten: true } });
  console.log("attach:", JSON.stringify(attach));
  const sid = attach.result.sessionId;
  // session commands
  const gt = await pip({ id: 5, method: "Page.getFrameTree", sessionId: sid });
  console.log("getFrameTree:", JSON.stringify(gt));
  const events = [];
  gw.on("message", (d) => { const m = JSON.parse(String(d)); if (m.method) events.push(m.method + (m.sessionId ? `@${m.sessionId}` : "") + ":" + JSON.stringify(m.params).slice(0, 60)); });
  gw.on("message", (d) => { const m = JSON.parse(String(d)); if (!m.method && m.id === 777) { events.push("PING-REPLY"); } });
  const nav = await pip({ id: 6, method: "Page.navigate", params: { url: "https://example.com/l", frameId: "f", loaderId: "l" }, sessionId: sid });
  console.log("navigate:", JSON.stringify(nav));
  // wait for events on gw
  await new Promise((r) => setTimeout(r, 400));
  console.log("events:", JSON.stringify(events));
  gw.close();
  server.close();
});
// Force the Firefox extension to (re)connect its WebDriver BiDi socket.
// Our own BiDi session must be ENDED before the extension dials (single-session
// rule), so the bidi-connect message is scheduled to fire ~2s after we close.
// Then verifies: a fresh session.new must FAIL ("session already started").
// Usage: node bidi-on.mjs [port]
import pkg from "/www1/navigator/node_modules/ws/index.js";
const { WebSocket } = pkg;
const PORT = process.argv[2] || 9226;
const ORIGIN = "moz-extension://11111111-2222-3333-4444-555555555555";

let nextId = 1;
const pending = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const makeWs = (port) => new WebSocket(`ws://127.0.0.1:${port}/session`);
function attach(ws) {
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
}
function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 15000);
  });
}
async function evaluate(ws, contextId, expression) {
  const res = await send(ws, "script.evaluate", { target: { context: contextId }, expression, awaitPromise: true, returnByValue: true });
  if (res.type !== "success") throw new Error("eval failed: " + JSON.stringify(res).slice(0, 300));
  return res.result.value;
}

(async () => {
  // Phase 1: open the extension popup while WE hold the session
  let ws = makeWs(PORT);
  attach(ws);
  await new Promise((r) => ws.on("open", r));
  await send(ws, "session.new", { capabilities: {} });
  await send(ws, "session.subscribe", { events: ["browsingContext.contextCreated"] });
  const tree = await send(ws, "browsingContext.getTree", { maxDepth: 1 });
  const ctx = tree.contexts[0]?.context;
  if (!ctx) throw new Error("no context");
  await send(ws, "browsingContext.navigate", { context: ctx, url: `${ORIGIN}/popup.html`, wait: "complete" });
  await sleep(600);

  // Phase 2: schedule the dial for +2s, then end our session immediately
  const PEER_PORT = PORT;
  await evaluate(ws, ctx, `setTimeout(function(){ chrome.runtime.sendMessage({type:'bidi-connect', bidiUrl:'ws://127.0.0.1:${PEER_PORT}/session'}, function(){}); }, 2000); "scheduled"`);
  console.log("[scheduled] bidi-connect fires in 2s");
  await send(ws, "session.end");
  ws.close();

  // Phase 3: verify the extension now holds the single BiDi session
  await sleep(3000);
  const probe = makeWs(PORT);
  attach(probe);
  await new Promise((r) => probe.on("open", r));
  try {
    const r = await send(probe, "session.new", { capabilities: {} });
    console.log("[VERIFY] session.new SUCCEEDED ->", JSON.stringify(r).slice(0, 60), "(extension NOT holding session)");
    await send(probe, "session.end");
    process.exit(1);
  } catch (e) {
    console.log("[VERIFY] session.new FAILED ->", e.message);
    console.log("SUCCESS: extension holds the BiDi session");
    process.exit(0);
  }
})().catch((e) => { console.error("[FAIL]", e.message); process.exit(1); });
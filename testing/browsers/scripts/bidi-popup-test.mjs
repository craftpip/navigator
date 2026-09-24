import WebSocket from "/www1/navigator/node_modules/ws/index.js";

const PORT = 9226;
const EXT_UUID = "11111111-2222-3333-4444-555555555555";
const H = `ws://127.0.0.1:${PORT}/session`;

let ws, msgId = 0;
const pending = new Map();

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error("timeout: " + method)); }
    }, 8000);
  });
}

ws = new WebSocket(H);
ws.on("message", (data) => {
  const m = JSON.parse(data.toString());
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(`${m.id} ${m.error.code}: ${m.error.message}`));
    else p.resolve(m.result);
  }
});

function log(name, obj) { console.log(`\n=== ${name} ===\n` + JSON.stringify(obj, null, 2)); }

await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
console.log("connected to", H);

const session = await send("session.new", { capabilities: {} });
log("session.new", { sessionId: session.sessionId });

const tree = await send("browsingContext.getTree", {});
log("getTree", tree);

const ctxId = tree.contexts[0].context;
if (typeof ctxId !== "string" || !ctxId) { console.log("NO CONTEXT"); ws.close(); process.exit(1); }

console.log("\n=== navigating context " + ctxId + " to extension popup.html ===");
try {
  const nav = await send("browsingContext.navigate", { context: ctxId, url: `moz-extension://${EXT_UUID}/popup.html`, wait: "complete" });
  log("navigate", nav);
} catch (e) {
  console.log("navigate FAILED:", e.message);
}

console.log("\n=== script.evaluate inside the extension page ===");
try {
  const ev = await send("script.evaluate", {
    expression: `JSON.stringify({url: location.href, title: document.title, hasRuntime: !!chrome.runtime, hasRuntimeMessage: !!(chrome.runtime && chrome.runtime.sendMessage), bodyText: document.body ? document.body.innerText.slice(0, 200) : null})`,
    target: { context: ctxId },
    awaitPromise: true,
    resultOwnership: "none",
  });
  log("evaluate", ev);
} catch (e) {
  console.log("evaluate FAILED:", e.message);
}

console.log("\n=== script.callFunction chrome.runtime.sendMessage({type:'popup-query'}) from extension page ===");
try {
  const cf = await send("script.callFunction", {
    functionDeclaration: `() => new Promise((resolve) => {
      const t0 = Date.now();
      try {
        chrome.runtime.sendMessage({ type: 'popup-query' }, (resp) => {
          resolve(JSON.stringify({ err: chrome.runtime.lastError && chrome.runtime.lastError.message, resp: resp || null, ms: Date.now() - t0 }));
        });
      } catch (e) { resolve(JSON.stringify({ thrown: String(e), ms: Date.now() - t0 })); }
    })`,
    target: { context: ctxId },
    awaitPromise: true,
    resultOwnership: "none",
  });
  log("callFunction sendMessage(popup-query)", cf);
} catch (e) {
  console.log("callFunction sendMessage FAILED:", e.message);
}

try { await send("session.end", {}); } catch (e) { console.log("session.end:", e.message); }
ws.close();
process.exit(0);
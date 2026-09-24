// Automated relay pairing for the navigator Firefox extension.
// Usage: node /tmp/ffx/pair.mjs [origin] [serverUrl] [browserName]
// Drives the extension POPUP page via BiDi -> sends {type:'connect'} +
// {type:'send-pin'} to the background. Scrapes a fresh PIN from `docker logs`.
import pkg from "/www1/navigator/node_modules/ws/index.js";
import { execSync } from "child_process";
const { WebSocket } = pkg;

const ORIGIN = process.argv[2] || "moz-extension://11111111-2222-3333-4444-555555555555";
const SERVER_URL = process.argv[3] || "http://10.69.1.164:1994";
const BROWSER_NAME = process.argv[4] || "Firefox";
const PORT = 9226;

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/session`);
let nextId = 1;
const pending = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); }
    }, 15000);
  });
}

function getPin() {
  try {
    const out = execSync("docker logs navigator 2>&1 | grep -a 'PIN:' | tail -1").toString();
    const m = out.match(/PIN:\s*(\d{4,8})\b/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function evaluate(contextId, expression) {
  const res = await send("script.evaluate", {
    target: { context: contextId },
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.type !== "success") throw new Error("eval failed: " + JSON.stringify(res).slice(0, 300));
  return res.result.value;
}

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

ws.on("open", async () => {
  try {
    console.log("[1] session.new");
    await send("session.new", { capabilities: {} });
    await send("session.subscribe", { events: ["browsingContext.contextCreated"] });

    const tree = await send("browsingContext.getTree", { maxDepth: 1 });
    const ctx = tree.contexts[0]?.context;
    if (!ctx) throw new Error("no context");

    const popupUrl = `${ORIGIN}/popup.html`;
    console.log("[2] navigate to popup", popupUrl);
    await send("browsingContext.navigate", { context: ctx, url: popupUrl, wait: "complete" });
    await sleep(800);

    console.log("[3] send connect to background");
    const connectRes = await evaluate(ctx,
      `new Promise(r => chrome.runtime.sendMessage({type:'connect', serverUrl:${JSON.stringify(SERVER_URL)}, browserName:${JSON.stringify(BROWSER_NAME)}}, x => r(JSON.stringify({ok:true, x}))))`);
    console.log("   connect ->", connectRes);

    await sleep(3000);
    const pin = getPin();
    if (!pin) throw new Error("no PIN found in docker logs");
    console.log("[4] PIN scraped:", pin);

    console.log("[5] send-pin to background");
    const pinRes = await evaluate(ctx,
      `new Promise(r => chrome.runtime.sendMessage({type:'send-pin', pin:${JSON.stringify(pin)}}, x => r(JSON.stringify({ok:true, x}))))`);
    console.log("   send-pin ->", pinRes);

    console.log("[6] poll popup-query for connected state");
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      const st = await evaluate(ctx,
        `new Promise(r => chrome.runtime.sendMessage({type:'popup-query'}, x => r(JSON.stringify(x))))`);
      try {
        const s = JSON.parse(st);
        console.log(`   t+${i + 1}s connected=${s.connected} pairing=${s.pairing} pinRequired=${s.pinRequired} hasToken=${s.hasToken}`);
        if (s.connected) { console.log("PAIRED"); process.exit(0); }
        if (s.pinError || s.lastError) console.log("   err:", s.pinError || s.lastError);
      } catch { console.log("   raw:", st.slice(0, 200)); }
    }
    throw new Error("not connected after polling");
  } catch (e) {
    console.error("FAIL", e.message);
    process.exit(1);
  }
});

ws.on("error", (e) => { console.error("WSERR", e.message); process.exit(1); });
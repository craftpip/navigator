// Automated relay pairing for the navigator Chrome extension.
// Usage: node chrome-pair.mjs [port] [extensionId] [serverUrl] [browserName]
// Drives the extension SERVICE WORKER via Chrome's browser-level CDP (port 9223):
// Target.getTargets -> attachToTarget(flatten) -> Runtime.evaluate in the SW.
import pkg from "/www1/navigator/node_modules/ws/index.js";
import { execSync } from "child_process";
const { WebSocket } = pkg;

const PORT = process.argv[2] || 9223;
const EXT_ID = process.argv[3] || "fignfifoniblkonapihmkfakmlgkbkcf";
const SERVER_URL = process.argv[4] || "http://10.69.1.164:1994";
const BROWSER_NAME = process.argv[5] || "test-chrome";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextId = 1;
const pending = new Map();

function getPin() {
  const out = execSync("docker logs navigator 2>&1 | grep -a 'PIN:' | tail -1").toString();
  const m = out.match(/PIN:\s*(\d{4,8})\b/);
  return m ? m[1] : null;
}

(async () => {
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  await new Promise((r) => (ws.on("open", r)));
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 15000);
  });

  console.log("[1] find extension service worker (waiting for 30s alarm wake)");
  let sw = null;
  for (let i = 0; i < 40; i++) {
    const { targetInfos } = await send("Target.getTargets");
    sw = targetInfos.find(t => t.type === "service_worker" && t.url.includes(EXT_ID));
    if (sw) break;
    await sleep(1000);
  }
  if (!sw) throw new Error("SW not found after 40s");
  console.log("   sw:", sw.url);

  const { sessionId } = await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
  const ev = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId).then(r => {
    if (r.exceptionDetails) throw new Error("eval exception: " + JSON.stringify(r.exceptionDetails).slice(0, 250));
    return r.result?.value;
  });
  await send("Runtime.enable", {}, sessionId);

  console.log("[2] connect (browserName " + BROWSER_NAME + ")");
  console.log("   ->", await ev(`new Promise(r => chrome.runtime.sendMessage({type:'connect', serverUrl:${JSON.stringify(SERVER_URL)}, browserName:${JSON.stringify(BROWSER_NAME)}}, x => r(JSON.stringify({ok:true,x}))))`));

  await sleep(3000);
  const pin = getPin();
  if (!pin) throw new Error("no PIN");
  console.log("[3] PIN:", pin);

  console.log("[4] send-pin");
  console.log("   ->", await ev(`new Promise(r => chrome.runtime.sendMessage({type:'send-pin', pin:${JSON.stringify(pin)}}, x => r(JSON.stringify({ok:true,x}))))`));

  console.log("[5] poll popup-query");
  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    const st = await ev(`new Promise(r => chrome.runtime.sendMessage({type:'popup-query'}, x => r(JSON.stringify({connected:x.connected, pairing:x.pairing, pinRequired:x.pinRequired, hasToken:x.hasToken}))))`);
    console.log(`   t+${i + 1}s ${st}`);
    if (JSON.parse(st).connected) { console.log("PAIRED"); process.exit(0); }
  }
  throw new Error("not paired after polling");
})().catch((e) => { console.error("[FAIL]", e.message); process.exit(1); });
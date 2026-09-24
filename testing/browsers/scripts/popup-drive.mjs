// Drive the Chrome relay extension via its POPUP page (a real extension context).
// Strategy: open chrome-extension://<id>/popup.html as a tab -> full chrome.* APIs ->
// sendMessage wakes/uses the SW. Pair via connect -> name-aware PIN scrape -> send-pin.
// Usage: node popup-drive.mjs [port] [extensionId] [serverUrl] [browserName]
import pkg from "/www1/navigator/node_modules/ws/index.js";
import { execSync } from "child_process";
const { WebSocket } = pkg;

const PORT = process.argv[2] || 9223;
const EXT_ID = process.argv[3] || "fignfifoniblkonapihmkfakmlgkbkcf";
const SERVER_URL = process.argv[4] || "http://10.69.1.164:1994";
const BROWSER_NAME = process.argv[5] || "test-chrome";
const POPUP = `chrome-extension://${EXT_ID}/popup.html`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextId = 1;
const pending = new Map();

function getPin() {
  try {
    const log = execSync("docker logs navigator 2>&1").toString();
    const wants = [...log.matchAll(new RegExp(`🔐\\s+"${BROWSER_NAME}" wants to connect`, "g"))];
    if (!wants.length) return null;
    const after = log.slice(wants[wants.length - 1].index);
    return (after.match(/PIN:\s*(\d{4,8})\b/) || [])[1] || null;
  } catch { return null; }
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 20000);
  });

  let targetId;
  try { targetId = (await send("Target.createTarget", { url: POPUP })).targetId; }
  catch (e) { console.log("[create.warn]", e.message); }
  await sleep(1500);
  if (targetId) {
    try { await send("Target.closeTarget", { targetId }); } catch {}
    await sleep(300);
  }
  const { targetInfos } = await send("Target.getTargets");
  const page = targetInfos.find(t => t.type === "page" && t.url.startsWith(`chrome-extension://${EXT_ID}`));
  if (!page) throw new Error("no extension page target");
  console.log("[page]", page.url);

  const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  const ev = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId).then(r => {
    if (r.exceptionDetails) return "EXC: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  });

  console.log("[probe]", await ev(`JSON.stringify({hasChrome: !!chrome.runtime, href: location.href})`));

  console.log("[connect]", await ev(`(async () => {
    return await new Promise(res => chrome.runtime.sendMessage({type:'connect', serverUrl:${JSON.stringify(SERVER_URL)}, browserName:${JSON.stringify(BROWSER_NAME)}}, x => res(JSON.stringify(x))));
  })()`));

  await sleep(2500);
  const pin = getPin();
  console.log("[pin]", pin);
  if (pin) {
    console.log("[send-pin]", await ev(`(async () => {
      return await new Promise(res => chrome.runtime.sendMessage({type:'send-pin', pin:${JSON.stringify(pin)}}, x => res(JSON.stringify(x))));
    })()`));
  }

  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    console.log("[t+" + (i + 1) + "s] " + await ev(`(async () => {
      const q = await chrome.runtime.sendMessage({type:'popup-query'}, x => x);
      if (!q) return 'NO-RESPONSE';
      return JSON.stringify({connected:q.connected, connecting:q.connecting, pairing:q.pairing, pinRequired:q.pinRequired, lastError:q.lastError, hasToken:q.hasToken});
    })()`));
  }
  process.exit(0);
})().catch((e) => { console.error("[FAIL]", e.message); process.exit(1); });
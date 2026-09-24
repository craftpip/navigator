// Inspect the Chrome relay extension SW state + (re)connect + (re)send PIN.
// Usage: node chrome-inspect.mjs [port] [extensionId] [serverUrl] [browserName]
// Polls for the SW (alarm wakes every ~30s), attaches, runs one async rollup
// that reports storage/state, fires connect, and sends the newest PIN.
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
  let evStream = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (!msg.id || !pending.has(msg.id)) {
      if (msg.method === "Runtime.consoleAPICalled") {
        const a = msg.params.args.map(a => a.value ?? a.description ?? "").join(" ");
        evStream.push(`[console] ${msg.params.type}: ${a}`);
      } else if (msg.method === "Runtime.exceptionThrown") {
        evStream.push(`[exception] ${JSON.stringify(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text).slice(0,300)}`);
      } else if (msg.method === "Network.webSocketCreated") {
        evStream.push(`[ws-create] ${msg.params.url}`);
      } else if (msg.method === "Network.webSocketClosed") {
        evStream.push(`[ws-close] code=${msg.params.closeCode} reason=${msg.params.closeReason}`);
      } else if (msg.method === "Network.webSocketFrameSent") {
        evStream.push(`[ws-sent] ${String(msg.params.response.payloadData).slice(0,120)}`);
      } else if (msg.method === "Network.webSocketFrameReceived") {
        evStream.push(`[ws-recv] ${String(msg.params.response.payloadData).slice(0,120)}`);
      }
    }
  });
  const drain = () => { const out = evStream; evStream = []; return out.length ? out.join("\n") : "(no events)"; };

  let sw = null;
  for (let i = 0; i < 50; i++) {
    const { targetInfos } = await send("Target.getTargets");
    sw = targetInfos.find(t => t.type === "service_worker" && t.url.includes(EXT_ID));
    if (sw) break;
    await sleep(1000);
  }
  if (!sw) throw new Error("SW not found in 50s");
  console.log("[sw]", sw.url);
  const { sessionId } = await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
  const ev = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId).then(r => {
    if (r.exceptionDetails) return "EXC: " + JSON.stringify(r.exceptionDetails).slice(0, 300);
    return r.result?.value;
  });
  await send("Runtime.enable", {}, sessionId);
  await send("Network.enable", {}, sessionId);

  console.log("[pre]", await ev(`(async () => {
    const st = await chrome.storage.local.get(['serverUrl','browserName','sessionToken','autoConnect']);
    const q = await chrome.runtime.sendMessage({type:'popup-query'}, x => x);
    return JSON.stringify({st, connected:q.connected, connecting:q.connecting, pairing:q.pairing, pinRequired:q.pinRequired, lastError:q.lastError, hasToken:q.hasToken, serverUrl:q.serverUrl, browserName:q.browserName});
  })()`));

  console.log("[connect]", await ev(`(async () => {
    const r = await new Promise(res => chrome.runtime.sendMessage({type:'connect', serverUrl:${JSON.stringify(SERVER_URL)}, browserName:${JSON.stringify(BROWSER_NAME)}}, x => res(JSON.stringify(x))));
    return r;
  })()`));

  await sleep(2500);
  console.log("[events 1]\n" + drain());
  const pin = getPin();
  console.log("[pin]", pin);
  if (pin) {
    console.log("[send-pin]", await ev(`(async () => {
      const r = await new Promise(res => chrome.runtime.sendMessage({type:'send-pin', pin:${JSON.stringify(pin)}}, x => res(JSON.stringify(x))));
      return r;
    })()`));
  }

  for (let i = 0; i < 8; i++) {
    await sleep(1000);
    console.log("[t+" + (i + 1) + "s] " + await ev(`(async () => {
      const q = await chrome.runtime.sendMessage({type:'popup-query'}, x => x);
      return JSON.stringify({connected:q.connected, connecting:q.connecting, pairing:q.pairing, pinRequired:q.pinRequired, lastError:q.lastError, hasToken:q.hasToken, wsUp:!!q.ws});
    })()`));
    const evs = drain();
    if (evs !== "(no events)") console.log("  " + evs + "\n");
  }
  process.exit(0);
})().catch((e) => { console.error("[FAIL]", e.message); process.exit(1); });
// Attach to the extension service worker ASAP after launch, dump ALL execution
// contexts, and evaluate typeof chrome per context. Settles whether raw-CDP
// attach can see extension APIs.
import pkg from "/www1/navigator/node_modules/ws/index.js";
const { WebSocket } = pkg;
const PORT = process.argv[2] || 9223;
const EXT_ID = process.argv[3] || "fignfifoniblkonapihmkfakmlgkbkcf";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let n = 0; const pend = new Map();
  const events = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
    else if (m.method === "Runtime.executionContextCreated") events.push(m.params.context);
  });
  await new Promise((r) => ws.on("open", r));
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++n; pend.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { if (pend.has(id)) { pend.delete(id); reject(new Error(`timeout ${method}`)); } }, 15000);
  });

  let sw = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    try { sw = (await send("Target.getTargets")).targetInfos.find(t => t.type === "service_worker" && t.url.includes(EXT_ID)); } catch {}
    if (sw) break;
    await sleep(400);
  }
  if (!sw) throw new Error("no SW in 60s");
  console.log("[sw]", sw.url, `(@${(Date.now() - t0) / 1000}s)`);

  const { sessionId } = await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await sleep(1200);
  const ev = (expression, contextId) => send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}),
  }, sessionId).then(r => r.result?.value ?? r.exceptionDetails?.text ?? "?");
  console.log("contexts:", events.length);
  for (const c of events) {
    console.log("  ctx", c.id, "|", c.name || "", "|", c.origin || "", "|", JSON.stringify(c.auxData || {}).slice(0, 120));
  }
  for (const c of events) {
    const r = await ev(`(() => ({ chrome: typeof chrome, runtime: typeof (chrome && chrome.runtime) , storage: typeof (chrome && chrome.storage), loc: location.href }))()`, c.id);
    console.log("  ctx", c.id, "->", r);
  }
  process.exit(0);
})().catch((e) => { console.error("[FAIL]", e.message); process.exit(1); });
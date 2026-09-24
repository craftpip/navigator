import pkg from "/www1/navigator/node_modules/ws/index.js"; const { WebSocket } = pkg;

const port = process.argv[2] || "9226";
const expr = process.argv[3] || "document.title";
const urlArg = process.argv[4];

const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout for ${method}`));
      }
    }, 15000);
  });
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
    const newS = await send("session.new", { capabilities: {} });
    console.log("NEW", JSON.stringify(newS).slice(0, 80));
    await send("session.subscribe", { events: ["browsingContext.contextCreated"] });
    let tree = null;
    for (let i = 0; i < 8; i++) {
      tree = await send("browsingContext.getTree", { maxDepth: 1 });
      console.log("GOTREE", i, JSON.stringify(tree).slice(0, 220));
      if (tree.contexts && tree.contexts.length) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    const ctxs = tree.contexts.map((c) => c.context);
    console.log("CONTEXTS", ctxs.join(","));
    let ctx = ctxs[0];
    if (urlArg) {
      const nav = await send("browsingContext.navigate", {
        context: ctx,
        url: urlArg,
        wait: "complete",
      });
      console.log("NAV", JSON.stringify(nav));
    }
    const res = await send("script.evaluate", {
      expression: expr,
      target: { context: ctx },
      awaitPromise: true,
      resultOwnership: "none",
    });
    const extract = (v) => {
      if (!v) return null;
      if (v.type === "string") return v.value;
      if (v.type === "number" || v.type === "boolean") return String(v.value);
      if (v.type === "object" && v.value) {
        try { return JSON.stringify(v.value); } catch { return "[obj]"; }
      }
      return `[${v.type}]`;
    };
    console.log("EVAL", extract(res.result));
    try { await send("session.end"); } catch {}
  } catch (e) {
    console.log("ERROR", e.message);
    try { await send("session.end"); } catch {}
  }
  process.exit(0);
});
ws.on("error", (e) => {
  console.log("WSERR", e.message);
  process.exit(1);
});
setTimeout(() => {
  console.log("GLOBAL TIMEOUT");
  process.exit(2);
}, 20000);
process.on("exit", (code) => {
  console.log("EXIT", code, "(sessions ended?)");
});

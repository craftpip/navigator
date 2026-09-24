const pkg = require("/www1/navigator/node_modules/ws");
const ws = new pkg(`ws://127.0.0.1:9226/session`);
let id = 1;
const send = (method, params = {}) => {
  const i = id++;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res) => {
    const h = (d) => {
      const m = JSON.parse(d.toString());
      if (m.id === i) { ws.removeListener("message", h); res(m); }
    };
    ws.on("message", h);
  });
};
ws.on("open", async () => {
  try {
    console.log("status", JSON.stringify(await send("session.status", {})));
    const fresh = await send("session.new", { capabilities: {} });
    const sid = fresh.result.sessionId;
    console.log("new sid:", sid);
    await send("session.subscribe", { events: ["browsingContext.contextCreated"] });
    await new Promise((r) => setTimeout(r, 1200));
    const tree = await send("browsingContext.getTree", {});
    console.log("tree0", JSON.stringify(tree.result).slice(0, 400));
    const tree2 = await send("browsingContext.getTree", { maxDepth: 1 });
    console.log("tree1", JSON.stringify(tree2.result).slice(0, 400));
    await send("session.end", {});
    process.exit(0);
  } catch (e) {
    console.log("ERR", e.message);
    process.exit(1);
  }
});
ws.on("error", (e) => { console.log("WSERR", e.message); process.exit(1); });
setTimeout(() => { console.log("timeout"); process.exit(2); }, 15000);
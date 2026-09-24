const pkg = require("/www1/navigator/node_modules/ws");
const ws = new pkg(`ws://127.0.0.1:9226/session`);
let id = 1;
const send = (method, params) => new Promise((res) => {
  const i = id++;
  ws.send(JSON.stringify({ id: i, method, params }));
  const h = (d) => { const m = JSON.parse(d.toString()); if (m.id === i) { ws.removeListener("message", h); if (m.error) res({ error: m.error }); else res(m.result); } };
  ws.on("message", h);
});
ws.on("open", async () => {
  try {
    await send("session.new", { capabilities: {} });
    await send("session.subscribe", { events: ["browsingContext.contextCreated"] });
    let tree = null;
    for (let i = 0; i < 8; i++) {
      tree = await send("browsingContext.getTree", { maxDepth: 1 });
      if (tree.contexts && tree.contexts.length) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    const ctx = tree.contexts[0].context;
    await send("browsingContext.navigate", { context: ctx, url: "https://example.com", wait: "complete" });
    await new Promise((r) => setTimeout(r, 1500));
    const shot = await send("browsingContext.captureScreenshot", { context: ctx, origin: "viewport" });
    if (shot.error) { console.log("SHOT-ERR", JSON.stringify(shot.error)); process.exit(1); }
    const b64 = shot.data;
    require("fs").writeFileSync("/tmp/ffx/example.png", Buffer.from(b64, "base64"));
    console.log("saved bytes:", Buffer.from(b64, "base64").length);
    await send("session.end", {});
    process.exit(0);
  } catch (e) { console.log("ERR", e.message); process.exit(1); }
});
ws.on("error", (e) => { console.log("WSERR", e.message); process.exit(1); });
setTimeout(() => { console.log("timeout"); process.exit(2); }, 15000);

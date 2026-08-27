const BASE = "http://localhost:1994/mcp";

async function call(name, args = {}) {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method: "tools/call", params: { name, arguments: args } }),
  });
  let j = {};
  try { j = await res.json(); } catch { j = {}; }
  const content = j.result?.content || [];
  const text = content.map((x) => x.text ?? "").join("\n");
  const err = j.error ? `RPC-ERR ${j.error.code}` : j.result?.isError ? "TOOL-ERROR" : "ok";
  console.log(`${name.padEnd(28)} ${String(res.status).padEnd(3)} ${err.padEnd(11)} bytes=${String(text.length).padEnd(6)} :: ${text.slice(0, 110).replace(/\n/g, " ")}`);
  return { ok: err === "ok", text };
}

const refs = (t) => [...t.matchAll(/\]\((\d+)\)/g)].map((m) => Number(m[1]));

// --- web tools ---
await call("list_browsers");
const s = await call("web_search", { queries: ["vitest latest version"], limit: 3 });
const rid = refs(s.text)[0];
if (rid) await call("web_page_links", { ref_ids: [rid] });
const f = await call("web_fetch", { urls: ["https://example.com"], maxChars: 2500 });
const linkId = refs(f.text)[0];
if (linkId) await call("web_page_links", { ref_ids: [linkId] });
await call("web_page_screenshot", { urls: ["https://example.com"], quality: "low", fullPage: false });
await call("web_page_svg", { urls: ["https://example.com"], elementLimit: 40, fullPage: false });

// --- devtools tools ---
const tgt = await call("Target.createTarget", { url: "https://example.com" });
const tid = (tgt.text.match(/["']?targetId["']?\s*[:=]\s*"?([a-f0-9]{12,})/i) || [])[1];
console.log("TARGET_ID:", tid ? tid.slice(0, 24) : "NONE");
if (tid) {
  await call("Page.navigate", { targetId: tid, url: "https://example.com/abc/nonexistent" });
  await call("DOM.getDocument", { targetId: tid, limit: 12 });
  await call("DOM.querySelector", { targetId: tid, selector: "h1" });
  await call("DOM.querySelectorAll", { targetId: tid, selector: "p", limit: 3 });
  await call("DOM.getOuterHTML", { targetId: tid, selector: "h1", maxChars: 1000 });
  await call("DOM.scrollIntoViewIfNeeded", { targetId: tid, selector: "p" });
  await call("Runtime.evaluate", { targetId: tid, expression: "document.title" });
  await call("Runtime.getConsoleMessages", { targetId: tid, limit: 5 });
  await call("Network.getRequests", { targetId: tid, limit: 5 });
  await call("Input.insertText", { targetId: tid, selector: "body", text: "x" });
  await call("Input.dispatchKeyEvent", { targetId: tid, key: "Tab" });
  await call("web_page_screenshot", { targetId: tid, quality: "low", fullPage: false });
  await call("Page.goBack", { targetId: tid });
  await call("Page.goForward", { targetId: tid });
  await call("Page.reload", { targetId: tid });
  await call("Target.closeTarget", { targetId: tid });
}
console.log("DONE");
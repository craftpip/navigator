#!/usr/bin/env node
// Independent end-to-end test for "can we open YouTube in the remote Firefox?"
//
// This drives the Mac's Firefox Remote Agent (WebDriver BiDi) DIRECTLY over a
// raw WebSocket — zero dependency on navigator, the MCP tools, the extension,
// or the relay. It is the true "does the Firefox side work" oracle.
//
// Usage:
//   node firefox-extension/test/bidi-direct.mjs                # defaults below
//   node firefox-extension/test/bidi-direct.mjs --url ws://10.69.1.178:9222/session --target https://www.youtube.com
//
// What it does:
//   1. WebSocket handshake to ws://<host>:9222/session
//      - sends Host: 127.0.0.1:9222 (the Remote Agent's DNS-rebinding guard
//        requires the loopback literal in the Host header; same class of
//        gotcha as Lightpanda — see AGENTS.md Project Learnings).
//   2. session.new  -> establishes a BiDi session
//   3. browsingContext.create { type: "tab" }  -> opens a NEW tab
//   4. browsingContext.navigate to the target URL
//   5. optionally browsingContext.close the created tab, and session.end
//
// IMPORTANT (single-session rule): Firefox's Remote Agent allows only ONE
// active BiDi session per process. The script ALWAYS sends `session.end` and
// closes the socket on every exit path (success, error, SIGINT/SIGTERM) so it
// never orphans a session and blocks the extension / other clients.
//
// Exit code 0 = full success. Non-zero = failure with a clear reason.
//
// Requires `ws` (a navigator prod dep, present in node_modules).

import WebSocket from "ws";

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i === -1 ? def : args[i + 1];
}

const BIDI_WS = arg("--url", "ws://10.69.1.178:9222/session");
const TARGET = arg("--target", "https://www.youtube.com");
const HOST_HEADER = arg("--host-header", "127.0.0.1:9222");
const OPEN_TAB = arg("--open-tab", "1") === "1";
const CLOSE_TAB = arg("--close-tab", "1") === "1";
const END_SESSION = arg("--end-session", "1") !== "0"; // always end unless explicitly --end-session 0
const TIMEOUT_MS = parseInt(arg("--timeout", "20000"), 10);
const VERBOSE = arg("--verbose", "1") === "1";

let nextId = 1;
const pending = new Map();
let ws = null;

function connect(url) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url, { perMessageDeflate: false, headers: { Host: HOST_HEADER } });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("connect timeout")); }, 8000);
    ws.on("open", () => { clearTimeout(timer); resolve(); });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
    ws.on("message", (data) => handleMessage(data.toString()));
    ws.on("close", (code, reason) => {
      for (const [, h] of pending) {
        h.reject(new Error(`BiDi closed (code ${code}${reason ? " " + reason.toString() : ""})`));
      }
      pending.clear();
    });
  });
}

function send(method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error("socket not open")); return; }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout: ${method} after ${timeoutMs}ms`));
    }, timeoutMs || TIMEOUT_MS);
    pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

function handleMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.id != null && pending.has(msg.id)) {
    const h = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.type === "error" || msg.message) {
      // BiDi error shape: { type:"error", id, error:"<code>", message:"<human>" }
      h.reject(new Error(msg.message || `BiDi error ${msg.error || "unknown"}`));
    } else {
      h.resolve(msg.result || {});
    }
    return;
  }
  if (VERBOSE && msg.method) {
    console.log(`  [event] ${msg.method}: ${JSON.stringify(msg.params).slice(0, 160)}`);
  }
}

function ok(msg) { console.log("  \u2713 " + msg); }
function title(label) { console.log(`\n== ${label} ==`); }

// Guaranteed cleanup — every exit path calls this exactly once.
let cleanupsRun = false;
async function cleanup() {
  if (cleanupsRun) return;
  cleanupsRun = true;
  if (ws && ws.readyState === WebSocket.OPEN && END_SESSION) {
    try { await send("session.end", {}, 3000); } catch { /* ignore */ }
  }
  try { if (ws) ws.close(); } catch { /* ignore */ }
}
function exitCode(code) {
  cleanup().finally(() => process.exit(code));
}
process.on("SIGINT", () => exitCode(130));
process.on("SIGTERM", () => exitCode(143));

async function main() {
  console.log(`BiDi direct test\n  ws:        ${BIDI_WS}\n  target:    ${TARGET}\n  host-hdr:  ${HOST_HEADER}`);
  console.log("  (drive Firefox's Remote Agent directly, no navigator/extension/relay)\n");

  try {
    title("1. Connect WebSocket");
    await connect(BIDI_WS);
    ok("WS open");

    title("2. session.new");
    let hello;
    try {
      hello = await send("session.new", { capabilities: {} });
    } catch (e) {
      const msg = e.message || "";
      if (msg.includes("Maximum number of active sessions")) {
        console.error(
          "\n  \u2717 Firefox's Remote Agent allows only ONE active BiDi session at a time,\n" +
            "    and one is already held open (a stuck/orphaned session, usually a\n" +
            "    probe/test that exited without `session.end` — or the extension's own\n" +
            "    BidiClient session on this same Firefox).\n" +
            "  \n  Remediation:\n" +
            "    - Quit Firefox and relaunch it with --remote-debugging-port=9222\n" +
            "      (this resets the Remote Agent and clears all hung sessions), then\n" +
            "      reload the extension in about:debugging.\n" +
            "    - Or, if the extension is connected, drive YouTube through the relay\n" +
            "      gateway instead (scripts/ff-gateway-test.mjs) rather than a second\n" +
            "      direct BiDi session.\n"
        );
        return exitCode(3);
      }
      throw e;
    }
    const caps = hello.capabilities || {};
    ok(`session ${hello.sessionId} | ${caps.browserName} ${caps.browserVersion} | headless=${caps["moz:headless"]}`);
    if (caps.browserName !== "firefox") {
      console.error("  \u2717 expected browserName 'firefox'");
      return exitCode(1);
    }

    let contextId = null;
    if (OPEN_TAB) {
      title("3. Open a new tab");
      const created = await send("browsingContext.create", { type: "tab" });
      contextId = created.context;
      if (!contextId) { console.error("  \u2717 no context id returned"); return exitCode(1); }
      ok(`created tab context=${contextId}`);
    }

    title(`4. Navigate to ${TARGET}`);
    const nav = await send("browsingContext.navigate", {
      context: contextId,
      url: TARGET,
      wait: "complete",
    });
    ok(`navigated ${nav.url || TARGET} (nav id ${nav.navigation || "n/a"})`);

    title("5. Verify page state");
    const evalRes = await send("script.evaluate", {
      expression: "JSON.stringify({ title: document.title, url: location.href, hasVid: !!document.querySelector('video, ytd-watch-grid') })",
      target: { context: contextId },
      awaitPromise: false,
    });
    let state = {};
    if (evalRes.type === "success" && evalRes.result) {
      const v = evalRes.result.value;
      try { state = typeof v === "string" ? JSON.parse(v) : v; } catch { state = { raw: v }; }
    }
    ok(`title: ${state.title || "(n/a)"}`);
    ok(`url:   ${state.url || "(n/a)"}`);
    const isYoutube = TARGET.includes("youtube.com");
    if (isYoutube && state.url && !/youtube\.com/.test(state.url)) {
      console.error("  \u2717 did not land on youtube.com");
      return exitCode(2);
    }

    if (OPEN_TAB && CLOSE_TAB && contextId) {
      title("6. Cleanup");
      try { await send("browsingContext.close", { context: contextId }); ok("closed tab"); }
      catch (e) { console.warn("  ! close failed: " + e.message); }
    }

    console.log("\n\u2713 PASS: Firefox is reachable and opened " + TARGET);
    return exitCode(0);
  } catch (e) {
    console.error(`\n\u2717 FAIL: ${e.message}`);
    return exitCode(1);
  }
}

main();

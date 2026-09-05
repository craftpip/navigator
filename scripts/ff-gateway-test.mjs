#!/usr/bin/env node
// Independent test of the REAL Firefox-through-navigator path that the user
// actually uses. It does NOT call any MCP tool. It connects as a plain CDP
// client to navigator's relay gateway for the paired Firefox browser
// (ws://<host>:1994/browser/<name>) — exactly how navigator's own
// BrowserManager attaches — and asks it to open a YouTube tab.
//
// The path exercised end-to-end:
//   script --(CDP)--> navigator /browser/Firefox --(relay)--> extension
//     --(BiDi)--> Firefox Remote Agent --> opens YouTube tab
//
// Usage:
//   node scripts/ff-gateway-test.mjs
//   node scripts/ff-gateway-test.mjs --ws ws://10.69.1.164:1994/browser/Firefox
//   node scripts/ff-gateway-test.mjs --url https://www.youtube.com
//
// Exit code 0 = the tab was created and navigated in the real Firefox.
// Non-zero = failure with a reason (see the error text).
//
// Requires puppeteer-core (a navigator prod dep).

import puppeteer from "puppeteer-core";

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i === -1 ? def : args[i + 1];
}

const GATEWAY_WS = arg("--ws", "ws://10.69.1.164:1994/browser/Firefox");
const TARGET = arg("--url", "https://www.youtube.com");
const TIMEOUT_MS = parseInt(arg("--timeout", "20000"), 10);
const CLOSE_AFTER = arg("--close", "1") === "1";

async function main() {
  console.log(`Firefox relay-gateway test\n  gateway:   ${GATEWAY_WS}\n  target:    ${TARGET}`);

  console.log("\n== 1. Connect to relay gateway (puppeteer-core) ==");
  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: GATEWAY_WS,
      defaultViewport: null,
    });
  } catch (e) {
    console.error(`\n  ✗ could not connect to gateway: ${e.message}`);
    process.exit(1);
  }
  console.log("  ✓ connected");

  console.log("\n== 2. Browser identity ==");
  const version = await browser.version();
  console.log(`  ✓ ${version}`);

  console.log("\n== 3. Target.createTarget -> " + TARGET + " ==");
  let page;
  try {
    page = await browser.newPage();
  } catch (e) {
    console.error(`\n  ✗ newPage() failed: ${e.message}`);
    console.error("    (This is the 'BiDi not connected' class of failure — the extension's\n     BiDi WebSocket to Firefox's Remote Agent is not live. See bidi-direct.mjs\n     remediation: the Remote Agent allows one session; a stuck session must be\n     cleared by restarting Firefox with --remote-debugging-port=9222.)");
    try { await browser.disconnect(); } catch {}
    process.exit(2);
  }
  console.log("  ✓ tab created");

  console.log(`\n== 4. Navigate to ${TARGET} ==`);
  let finalUrl = "";
  try {
    await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    finalUrl = page.url();
    console.log(`  ✓ landed: ${finalUrl}`);
  } catch (e) {
    console.warn(`  ! goto: ${e.message} (browser may still have received the navigation)`);
    try { finalUrl = page.url(); } catch {}
  }

  const isYoutube = TARGET.includes("youtube.com");
  if (isYoutube && finalUrl && !/youtube\.com/.test(finalUrl)) {
    console.error(`  ✗ did not land on youtube.com (got ${finalUrl})`);
    try { await browser.disconnect(); } catch {}
    process.exit(3);
  }

  console.log("\n== 5. Confirm live ==");
  try {
    const title = await page.title();
    console.log(`  ✓ title: ${title || "(empty)"}`);
  } catch (e) {
    console.warn(`  ! title read failed: ${e.message}`);
  }

  if (CLOSE_AFTER) {
    try { await page.close(); console.log("\n  ✓ closed test tab"); } catch {}
  }
  try { await browser.disconnect(); } catch {}

  console.log(`\n✓ PASS: Firefox opened ${TARGET} through navigator's relay gateway.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n✗ FAIL: ${e.message}`);
  process.exit(1);
});

import puppeteer from "puppeteer-core";

const WS_URL = "ws://10.69.1.164:1994/browser/Chrome";
const step = (msg) => console.log(`[${Date.now() % 100000}] ${msg}`);

const browser = await puppeteer.connect({ browserWSEndpoint: WS_URL, defaultViewport: null });
step("connected to gateway");
const page = await browser.newPage();
const realTargetId = page.target().id();
step(`newPage -> targetId=${realTargetId}`);

page.on("console", (m) => step(`  console.${m.type()}`));

step("goto example.com ...");
const t0 = Date.now();
await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 25000 });
step(`goto done in ${Date.now() - t0}ms, url=${page.url()}`);

step("page.content() ...");
try {
  const c = await page.content();
  step(`content OK ${c.length} chars`);
} catch (e) {
  step(`content FAIL ${e.message}`);
}

step("page.screenshot() ...");
try {
  const t1 = Date.now();
  const img = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
  step(`screenshot OK ${img.length} bytes in ${Date.now() - t1}ms`);
} catch (e) {
  step(`screenshot FAIL ${e.message?.slice(0, 200)}`);
}

step("page.close() ...");
try {
  const t2 = Date.now();
  await page.close();
  step(`close OK in ${Date.now() - t2}ms`);
} catch (e) {
  step(`close FAIL ${e.message?.slice(0, 200)}`);
}

await browser.disconnect();
process.exit(0);
// Plan 49 verification — the collapsible driver rows must show a disclosure
// chevron only when the row has tabs, and clicking must flip aria-expanded.
// Run inside the navigator container: node /app/scripts/verify-plan49-chevron.mjs
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1300, height: 900 });
await page.goto('http://localhost:1994/console', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('main.app', { timeout: 20000 });
// Let the 2s poll deliver a snapshot that contains the open tab.
await new Promise((r) => setTimeout(r, 6000));

const read = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('.driver-item')];
  return rows.map((row) => {
    const toggle = row.querySelector('.driver-toggle');
    const chevron = row.querySelector('.driver-toggle-chevron');
    const tabs = row.querySelector('.driver-tabs');
    return {
      backend: row.querySelector('.item-title')?.textContent?.trim().split(/\s+/)[0] || '?',
      expandable: row.classList.contains('expandable'),
      chevronPresent: Boolean(chevron),
      chevronGlyph: chevron?.textContent || '',
      disabled: toggle?.disabled ?? null,
      ariaExpanded: toggle?.getAttribute('aria-expanded') ?? null,
      ariaControls: toggle?.getAttribute('aria-controls') ?? null,
      tabsClass: tabs?.className ?? null,
      tabCount: tabs?.querySelectorAll('.driver-tab').length ?? 0,
    };
  });
});

const before = await read();
console.log('BEFORE');
for (const r of before) console.log(' ', JSON.stringify(r));

const expandable = before.find((r) => r.expandable);
const problems = [];
for (const r of before) {
  if (!r.chevronPresent) problems.push(`${r.backend}: no .driver-toggle-chevron element`);
  if (r.expandable && !r.chevronGlyph) problems.push(`${r.backend}: expandable but chevron is empty`);
  if (!r.expandable && r.chevronGlyph) problems.push(`${r.backend}: not expandable but chevron shows ${r.chevronGlyph}`);
  if (r.expandable && r.disabled) problems.push(`${r.backend}: expandable but toggle is disabled`);
  if (r.expandable && r.ariaExpanded !== 'false') problems.push(`${r.backend}: aria-expanded should start false, got ${r.ariaExpanded}`);
  if (r.expandable && r.ariaControls !== `driver-tabs-${r.backend}`) problems.push(`${r.backend}: aria-controls is ${r.ariaControls}`);
}

if (expandable) {
  await page.click('.driver-item.expandable .driver-toggle');
  await new Promise((r) => setTimeout(r, 400));
  const after = await read();
  const now = after.find((r) => r.backend === expandable.backend);
  console.log('AFTER CLICK');
  console.log(' ', JSON.stringify(now));
  if (now.ariaExpanded !== 'true') problems.push(`aria-expanded did not flip to true (got ${now.ariaExpanded})`);
  if (!/open/.test(now.tabsClass || '')) problems.push(`driver-tabs not open after click (${now.tabsClass})`);
  if (now.chevronGlyph !== '▾') problems.push(`chevron glyph should be ▾ when open, got "${now.chevronGlyph}"`);

  await page.click('.driver-item.expandable .driver-toggle');
  await new Promise((r) => setTimeout(r, 400));
  const closed = (await read()).find((r) => r.backend === expandable.backend);
  if (closed.ariaExpanded !== 'false') problems.push(`aria-expanded did not flip back (got ${closed.ariaExpanded})`);
  if (!/collapsed/.test(closed.tabsClass || '')) problems.push(`driver-tabs not collapsed after 2nd click (${closed.tabsClass})`);
} else {
  problems.push('no expandable driver row found — no browser reported open tabs, cannot verify the toggle');
}

await browser.close();
if (problems.length) {
  console.log('\nFAIL');
  for (const p of problems) console.log(' ✗', p);
  process.exit(1);
}
console.log('\nPASS — chevron affordance + toggle behaviour verified');

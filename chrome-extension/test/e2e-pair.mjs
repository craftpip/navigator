#!/usr/bin/env node
// Complete the Navigator Browser Relay pairing PIN flow end-to-end by driving
// the extension service worker over raw CDP, then confirm navigator sees the
// browser as connected.
//
//   node test/e2e-pair.mjs
//   env: CDP_URL=http://172.22.0.4:9222  NAVIGATOR_URL=http://127.0.0.1:1994  BROWSER_NAME=dev-chrome
//
// Why SW: the popup page is blocked when opened via page.goto (ERR_BLOCKED_BY_CLIENT)
// and `chrome.windows.create` is flaky under puppeteer. The service worker is the
// extension runtime and handles the same { connect, send-pin } messages.
import WebSocket from 'ws';

const CDP_URL = process.env.CDP_URL || 'http://172.22.0.4:9222';
// RELAY_URL is what the extension dials (bare host:port — the extension builds
// ws://<hostport>/relay). NAV_URL is only for fetching /stats on the relay side.
const RELAY_URL = process.env.RELAY_URL || '10.69.1.164:1994';
const NAV_URL = process.env.NAVIGATOR_URL || 'http://127.0.0.1:1994';
const BROWSER_NAME = process.env.BROWSER_NAME || 'dev-chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJsonList() {
  const r = await fetch(`${CDP_URL}/json/list`);
  return r.json();
}

async function getRelay() {
  const r = await fetch(`${NAV_URL}/stats`);
  const stats = await r.json();
  return { pending: stats?.relay?.pending || [], connected: stats?.relay?.connected || [] };
}

class CdpSession {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.ws = null;
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url, { perMessageDeflate: false });
      this.ws.on('open', () => resolve());
      this.ws.on('error', (e) => reject(new Error(`ws error: ${e.message}`)));
      this.ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
    return res.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  console.log(`▶ CDP ${CDP_URL}`);
  const list = await getJsonList();
  const sw = list.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
  if (!sw) throw new Error('extension service worker not found');
  console.log(`  SW: ${sw.url.replace(/^chrome-extension:\/\/[^/]+\//, 'ext/')} (${sw.id})`);

  const cdp = new CdpSession(sw.webSocketDebuggerUrl);
  await cdp.open();
  console.log('  connected to SW');

  // 0. Reset to a truly fresh pairing: disconnect + clear the stored session
//    token (the token normally persists across reconnects by design).
  await cdp.evaluate(`new Promise(r => { try { ConnectionManager.disconnect(); } catch(e){} Config.clearSessionToken(() => r(true)); })`);
  await sleep(1500);

  // 1. Connect to the relay. First persist the browserName/serverUrl (the connect
//    path reads saved Config for the name if not already set, which is why the
//    first run connected as "Chrome").
  console.log(`▶ connect as "${BROWSER_NAME}" <- ${RELAY_URL}`);
  const connectResult = await cdp.evaluate(`new Promise(async (res) => {
    try {
      await new Promise(r => Config.saveServerUrl(${JSON.stringify(RELAY_URL)}, r));
      await new Promise(r => Config.saveBrowserName(${JSON.stringify(BROWSER_NAME)}, r));
      ConnectionManager.connect({ serverUrl: ${JSON.stringify(RELAY_URL)}, browserName: ${JSON.stringify(BROWSER_NAME)} }, r => res(r));
    } catch (e) { res({ error: String(e) }); }
  })`);
  console.log('  connect sent:', JSON.stringify(connectResult));

  // 2. Wait for pending PIN on navigator.
  let pin = null;
  for (let i = 0; i < 15; i++) {
    const { pending } = await getRelay();
    if (pending.length) { pin = pending[0].pin; console.log(`  pending PIN: ${pin}`); break; }
    await sleep(1000);
  }
  if (!pin) {
    console.error('✗ no pending PIN — relay.pending =', JSON.stringify(await getRelay()));
    return 1;
  }

  // 3. Submit PIN directly to the connection manager.
  const pinResult = await cdp.evaluate(`new Promise((res) => {
    const sent = ConnectionManager.send({ type: 'pin', pin: ${JSON.stringify(String(pin))} });
    res({ success: true, sent });
  })`);
  console.log('  PIN submitted:', JSON.stringify(pinResult));

  // 4. Confirm connected.
  for (let i = 0; i < 15; i++) {
    const { connected } = await getRelay();
    const me = connected.find((e) => e.name === BROWSER_NAME);
    if (me && me.status === 'connected') {
      console.log(`  ✔ CONNECTED name=${me.name} ws=${me.wsUrl}`);
      console.log(`  connected: ${connected.map((e) => e.name).join(', ')}`);
      return 0;
    }
    await sleep(1000);
  }
  console.error(`✗ not connected after timeout`);
  return 1;
}

main().then((code) => process.exit(code)).catch((e) => { console.error('error:', e.message); process.exit(1); });
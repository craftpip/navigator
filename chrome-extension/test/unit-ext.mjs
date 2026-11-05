#!/usr/bin/env node
/**
 * Standalone unit test for the Navigator Browser Relay extension.
 *
 * Loads every extension script into a node:vm context with mocked Chrome APIs
 * and a paired FakeWebSocket, then simulates the navigator relay flow:
 *   1. modules load, globals exposed (like importScripts)
 *   2. Config storage round-trips
 *   3. connect() -> hello -> pin_required -> pin -> connected (pairing works)
 *   4. server sends CDP command, extension replies (Browser.getVersion)
 *   5. CDP forwarding (Runtime.evaluate) hits chrome.debugger
 *   6. TabList listing works
 *  18. durable pending-connecting flag survives SW termination + clears on connected
 *  19. disconnect clears the pending-connecting flag
 *
 * Usage:
 *   node test/unit-ext.mjs
 */
import { readFileSync } from 'fs';
import vm from 'vm';

const ROOT = new URL('..', import.meta.url).pathname;

// ---------------------------------------------------------------- mocks

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.bufferedAmount = 0;
    this.other = null;
    this._sent = [];
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN;
      if (this.onopen) this.onopen();
    }, 5);
  }
  send(data) {
    if (this.readyState !== FakeWebSocket.OPEN) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    this._sent.push(msg);
    if (this.other && this.other.onmessage) {
      setTimeout(() => this.other.onmessage({ data: JSON.stringify(msg) }), 5);
    }
  }
  close(code, reason) {
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) this.onclose({ code, reason });
  }
}

function makeChromeMock() {
  const storage = new Map();
  const chrome = {
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    runtime: {
      id: 'mock-ext',
      getManifest: () => ({ version: '0.1.0' }),
      getURL: p => 'mock://' + p,
      lastError: null,
      onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      sendMessage: () => Promise.resolve({})
    },
    tabs: {
      query: (opts, cb) => cb([
        { id: 1, title: 'Example', url: 'https://example.com', active: true, windowId: 1, groupId: -1 },
        { id: 2, title: 'GitHub', url: 'https://github.com', active: false, windowId: 1, groupId: -1 }
      ]),
      get: (id, cb) => cb({ id, title: 'Tab ' + id, url: 'https://example.com', windowId: 1 }),
      create: (opts, cb) => cb({ id: 99, url: opts.url, active: false, windowId: 1 }),
      update: (id, opts, cb) => cb && cb(),
      remove: (id, cb) => cb && cb(),
      group: (opts, cb) => { cb && cb(10); return Promise.resolve(10); },
      ungroup: (ids, cb) => cb && cb()
    },
    windows: {
      getCurrent: cb => cb({ id: 1 }),
      create: (opts, cb) => cb && cb({ id: 500, tabs: [{ id: 98, url: (opts && opts.url) || 'about:blank', active: false, windowId: 500 }] }),
      get: (id, cb) => cb({ id, left: 0, top: 0, width: 1920, height: 1080, state: 'normal', focused: false }),
      update: (id, opts, cb) => {
        const merged = Object.assign({ id, left: 0, top: 0, width: 1920, height: 1080, state: 'normal', focused: false }, opts || {});
        cb && cb(merged);
      },
      remove: (id, cb) => cb && cb()
    },
    tabGroups: {
      query: (opts, cb) => cb([]),
      update: (id, opts, cb) => cb && cb(),
      remove: (id, cb) => cb && cb()
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    debugger: {
      attach: (target, version, cb) => { cb && cb(); },
      detach: (target, cb) => { cb && cb(); },
      sendCommand: (target, method, params) => {
        return new Promise(resolve => setTimeout(() => resolve({ mockEcho: method, params: params || {} }), 5));
      },
      getTargets: cb => cb([
        { id: 'target-1', tabId: 1, type: 'page', title: 'Example', url: 'https://example.com', attached: false }
      ]),
      onEvent: { addListener: () => {} },
      onDetach: { addListener: () => {} }
    },
    storage: {
      local: {
        get: (keys, cb) => {
          if (typeof keys === 'string') keys = [keys];
          const result = {};
          (Array.isArray(keys) ? keys : Object.keys(keys || {})).forEach(k => {
            if (storage.has(k)) result[k] = storage.get(k);
          });
          cb(result);
        },
        set: (obj, cb) => { Object.keys(obj).forEach(k => storage.set(k, obj[k])); cb && cb(); },
        remove: (keys, cb) => { (Array.isArray(keys) ? keys : [keys]).forEach(k => storage.delete(k)); cb && cb(); }
      }
    }
  };
  chrome._storage = storage;   // expose for tests that simulate SW termination/shared storage
  return chrome;
}

// ---------------------------------------------------------------- harness

let pass = 0, fail = 0;
function report(name, ok, err) {
  if (ok) { pass++; process.stdout.write('  ✅ ' + name + '\n'); }
  else { fail++; process.stdout.write('  ❌ ' + name + (err ? ': ' + err.message : '') + '\n'); }
}
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') r.then(ok => report(name, !!ok)).catch(e => report(name, false, e));
    else report(name, !!r);
  } catch (e) {
    report(name, false, e);
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildEnv() {
  return buildEnvFromChrome(makeChromeMock());
}

/** Build a fresh extension env from an explicitly provided chrome mock. */
function buildEnvFromChrome(chrome) {
  const sandbox = {
    chrome,
    console,
    WebSocket: FakeWebSocket,
    navigator: { userAgent: 'Mozilla/5.0 Chrome/120.0.0.0' },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Promise, String, Number, Array, Object, Map, Set,
    parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    requestAnimationFrame: () => {},
    Blob: globalThis.Blob
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

/** Open a relay websocket pair for an existing env. */
function wireRelay(env, url) {
  const client = env.State.getWs();
  const server = new FakeWebSocket(url || 'ws://relay');
  server.readyState = FakeWebSocket.OPEN;
  server.other = client; client.other = server;
  return [server, client, env];
}

function loadExtension(sandbox) {
  const order = [
    'utils/config.js', 'utils/logger.js', 'utils/helpers.js',
    'core/state.js', 'core/debugger.js', 'core/connection-manager.js',
    'cdp/response.js', 'cdp/handler/local.js', 'cdp/handler/special.js',
    'cdp/handler/forward.js', 'cdp/index.js',
    'features/tab-list.js', 'features/tab-isolation.js', 'features/badge.js'
  ];
  order.forEach(rel => {
    vm.runInContext(readFileSync(`${ROOT}${rel}`, 'utf8'), sandbox, { filename: rel });
  });
}

/** Start a relay session: extension connects; returns [serverWs, clientWs, env]. */
function startRelay() {
  const env = buildEnv();
  loadExtension(env);
  env.Config.saveServerUrl('ws://relay', () => {});
  env.ConnectionManager.connect();
  let client;
  // grab the WebSocket created by connect()
  return new Promise(resolve => {
    setTimeout(() => {
      client = env.State.getWs();
      const server = new FakeWebSocket('ws://relay');
      server.readyState = FakeWebSocket.OPEN;
      server.other = client;
      client.other = server;
      resolve([server, client, env]);
    }, 30);
  });
}

// ---------------------------------------------------------------- tests

console.log('Navigator Browser Relay — standalone unit tests\n');

// 1. modules load
let env0;
{
  env0 = buildEnv();
  try {
    loadExtension(env0);
    test('1. All extension modules load (globals exposed)', () =>
      typeof env0.routeCDPCommand === 'function' &&
      typeof env0.ConnectionManager.connect === 'function' &&
      typeof env0.TabList.getAllAsTargets === 'function');
  } catch (e) { report('1. All extension modules load', false, e); }
}

// 2. Config storage round-trip
{
  const env = buildEnv();
  loadExtension(env);
  test('2. Config storage round-trip', () => new Promise((resolve) => {
    env.Config.getBrowserName(name => {
      env.Config.saveServerUrl('ws://x:1/relay', () => {
        env.Config.getServerUrl(u => resolve(u === 'ws://x:1/relay'));
      });
    });
  }));
  // give async callback a tick
  await sleep(50);
}

// 2b. A bare relay host uses Navigator's default port.
{
  const env = buildEnv();
  loadExtension(env);
  env.Config.saveServerUrl('10.69.1.164', () => {});
  env.ConnectionManager.connect();
  await sleep(20);
  test('2b. Bare relay host defaults to port 1994', () =>
    env.State.getWs()?.url === 'wss://10.69.1.164:1994/relay');
  env.ConnectionManager.disconnect();
}

// 3. connect() -> hello sent to server
{
  const [server, client, env] = await startRelay();
  const hello = client._sent.find(m => m.type === 'navigator-hello');
  test('3. connect() sends navigator-hello with browserName', () =>
    !!hello && typeof hello.browserName === 'string' && !!hello.extensionVersion);
}

// 4. pin_required -> pairing state
{
  const env0 = buildEnv();
  loadExtension(env0);
  env0.Config.saveServerUrl('ws://relay', () => {});
  env0.ConnectionManager.connect();
  await sleep(30);
  const client = env0.State.getWs();
  const server = new FakeWebSocket('ws://relay');
  server.readyState = FakeWebSocket.OPEN;
  server.other = client; client.other = server;
  server.send(JSON.stringify({ type: 'pin_required' }));
  await sleep(30);
  test('4. pin_required from server sets pairing state', () =>
    env0.State.isPairing() && env0.State.isPinRequired());
}

// 5. full pairing: hello -> pin_required -> send pin -> connected+token
{
  const [server, client, env] = await startRelay();
  // server requests pin
  server.send(JSON.stringify({ type: 'pin_required' }));
  await sleep(30);
  // extension user enters pin -> send over ws
  env.ConnectionManager.send({ type: 'pin', pin: '123456' });
  await sleep(30);
  const pinMsg = client._sent.find(m => m.type === 'pin');
  // server grants
  server.send(JSON.stringify({ type: 'connected', sessionToken: 'tok-secret' }));
  await sleep(30);
  test('5. PIN round-trip: extension sends pin, stores session token', () =>
    !!pinMsg && pinMsg.pin === '123456' && env.State.getSessionToken() === 'tok-secret');
}

// 6. CDP local: server sends Browser.getVersion -> extension replies over ws
{
  const env0 = buildEnv();
  loadExtension(env0);
  env0.Config.saveServerUrl('ws://relay', () => {});
  env0.ConnectionManager.connect();
  await sleep(30);
  const client = env0.State.getWs();
  const server = new FakeWebSocket('ws://relay');
  server.readyState = FakeWebSocket.OPEN;
  server.other = client; client.other = server;
  server.send(JSON.stringify({ id: 1, method: 'Browser.getVersion', params: {} }));
  await sleep(50);
  const reply = client._sent.find(m => m.id === 1);
  test('6. CDP Browser.getVersion replied locally over ws', () =>
    !!reply && reply.result && /Chrome/.test(reply.result.product) && !reply.error);
}

// 7. CDP forward: Runtime.evaluate -> chrome.debugger.sendCommand -> reply over ws
{
  const env0 = buildEnv();
  loadExtension(env0);
  env0.Config.saveServerUrl('ws://relay', () => {});
  env0.ConnectionManager.connect();
  await sleep(30);
  const client = env0.State.getWs();
  const server = new FakeWebSocket('ws://relay');
  server.readyState = FakeWebSocket.OPEN;
  server.other = client; client.other = server;
  // must have a session mapping + attached tab for forwarding
  env0.State.addAttachedTab(1);
  env0.State.getState().sessionIdToTabId = new Map([['s-1', 1]]);
  server.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: '1+1' }, sessionId: 's-1' }));
  await sleep(50);
  const reply = client._sent.find(m => m.id === 2);
  test('7. CDP Runtime.evaluate forwarded to chrome.debugger', () =>
    !!reply && reply.result && reply.result.mockEcho === 'Runtime.evaluate' && !reply.error);
}

// 8. TabList
{
  const env = buildEnv();
  loadExtension(env);
  const TL = env.TabList;
  const info = await TL.getTargetInfoById('1');
  const targets = await new Promise(res => TL.getAllAsTargets(t => res(t)));
  test('8. TabList returns tab targets', () =>
    !!info && info.url === 'https://example.com' && targets.length > 0 && targets[0].tabId === 1);
}

// 9. tab grouping isolation
{
  const env = buildEnv();
  loadExtension(env);
  test('9. TabIsolation exposes group helpers', () =>
    typeof env.TabIsolation.groupTab === 'function' &&
    env.TabIsolation.NAVIGATOR_PREFIX === 'Navigator');
}

// 10. Target.createTarget creates tab + marks CDP-created
{
  const env = buildEnv();
  loadExtension(env);
  const state = env.State;
  const serverWs = new env.WebSocket('relay://');
  serverWs.readyState = env.WebSocket.OPEN;
  state.setWs(serverWs);
  const replies = [];
  serverWs._receive = m => { if (m.id !== undefined) replies.push(m); };
  env.saveSent = m => { if (m.id !== undefined) replies.push(m); };

  env.routeCDPCommand({ id: 10, method: 'Target.createTarget', params: { url: 'https://example.com' }, sessionId: null });
  await sleep(2300);
  const reply = replies.find(m => m.id === 10) || serverWs._sent.find(m => m.id === 10);
  test('10. Target.createTarget creates tab + marks CDP-created', () => {
    const created = reply && reply.result && reply.result.targetId;
    const marked = created && Array.from(state.getCDPCreatedTabIds()).length > 0;
    return !!created && !!marked;
  });
}

// 11. Session token stored on connected and reused on reconnect
{
  const [server, client, env] = await startRelay();
  server.send(JSON.stringify({ type: 'pin_required' }));
  await sleep(30);
  env.ConnectionManager.send({ type: 'pin', pin: '111111' });
  await sleep(30);
  server.send(JSON.stringify({ type: 'connected', sessionToken: 'tok-abc' }));
  await sleep(30);
  const saved = env.Config.getSessionToken ? await new Promise(res => env.Config.getSessionToken(r => res(r))) : null;
  // cleanup: let the reconnection timer not interfere with process exit
  env.State.clearReconnectTimer && env.State.clearReconnectTimer();
  env.State.clearHeartbeatTimer && env.State.clearHeartbeatTimer();
  client.close(1000, 'test done');
  const ok = env.State.getSessionToken() === 'tok-abc' && saved === 'tok-abc';
  test('11. Session token stored on connected and reused on reconnect', () => ok);
}

// 12. connect() without a configured URL refuses — no silent localhost fallback
{
  const env = buildEnv();
  loadExtension(env);
  env.ConnectionManager.connect();
  await sleep(30);
  const ws = env.State.getWs();
  const err = env.State.getLastError() || '';
  test('12. No saved URL -> connect refuses, no localhost auto-connect', () =>
    ws === null && /No relay server URL configured/.test(err));
}

// 13. Explicit disconnect: resets to a clean Off state WITHOUT scheduling a
//     silent reconnect, and KEEPS the session token (pairing is one-time —
//     the token is the remember-self proof, reused on the next connect).
{
  const [server, client, env] = await startRelay();
  server.send(JSON.stringify({ type: 'pin_required' }));
  await sleep(30);
  env.ConnectionManager.send({ type: 'pin', pin: '222222' });
  await sleep(30);
  server.send(JSON.stringify({ type: 'connected', sessionToken: 'tok-disconnect' }));
  await sleep(30);

  env.ConnectionManager.disconnect();
  await sleep(150);

  const ws = env.State.getWs();
  const token = env.State.getSessionToken();
  const connected = env.State.isConnected();
  const paring = env.State.isPairing();
  const pinReq = env.State.isPinRequired();
  // The close of the socket must NOT have been treated as a drop and
  // reconnected — so after disconnect() there is no live socket and no
  // reconnectTimer trying to bring one back.
  const reconnectTimer = env.State.getReconnectTimer();
  const ok = ws === null && token === 'tok-disconnect' && !connected && !paring && !pinReq &&
    reconnectTimer === null;
  test('13. Disconnect resets cleanly with no reconnect; session token preserved', () => ok);
}

// 14. Wrong PIN (close code 4000) — the pairing-contract behavior: the
//     previously paired browser (if any) stays valid and the extension
//     reverts to it. It does NOT re-dial for a fresh PIN (that would
//     silently invalidate an existing pairing) and it does NOT linger in a
//     broken "pairing" state — the connection is closed cleanly.
{
  const [server, client, env] = await startRelay();
  // Simulate an existing pairing so we can assert it is preserved.
  env.Config.saveSessionToken('tok-prior', () => {});
  env.State.setSessionToken('tok-prior');
  server.send(JSON.stringify({ type: 'pin_required' }));
  await sleep(30);

  // User submits a WRONG pin; server rejects with close code 4000.
  env.ConnectionManager.send({ type: 'pin', pin: '999999' });
  await sleep(30);
  client.onclose({ code: 4000, reason: 'Invalid PIN' });
  await sleep(30);

  const after = {
    pairing: env.State.isPairing(),
    pinRequired: env.State.isPinRequired(),
    connecting: env.State.isConnecting(),
    connected: env.State.isConnected(),
    token: env.State.getSessionToken(),
    ws: env.State.getWs()
  };
  test('14. Wrong-PIN (4000) reverts to prior pairing — no stale pairing state', () =>
    !after.pairing && !after.pinRequired && !after.connecting &&
    !after.connected && after.token === 'tok-prior' && after.ws === null);
}

// 14b. Server-initiated forget (close code 4004) is NOT the PIN-expiry case:
//      the extension must drop its stored token and stop, with no auto-reconnect
//      loop — otherwise a forgotten browser keeps reconnecting with stale
//      pairing material (plan 60 B2).
{
  const [server, client, env] = await startRelay();
  env.Config.saveSessionToken('tok-forgotten', () => {});
  env.State.setSessionToken('tok-forgotten');
  env.State.setConnected(true);
  await sleep(20);

  client.onclose({ code: 4004, reason: 'forget' });
  await sleep(30);

  const after = {
    pairing: env.State.isPairing(),
    pinRequired: env.State.isPinRequired(),
    connecting: env.State.isConnecting(),
    connected: env.State.isConnected(),
    token: env.State.getSessionToken(),
    reconnectTimer: env.State.getReconnectTimer(),
    lastError: env.State.getLastError()
  };
  test('14b. Forgot-browser (4004) clears token and does not auto-reconnect', () =>
    !after.pairing && !after.pinRequired && !after.connecting &&
    !after.connected && after.token === null && !after.reconnectTimer &&
    /forgotten/i.test(String(after.lastError)));
}

// 14c. Server-initiated remove (close code 4005) is the tombstone case: the
//      name was removed from navigator and re-pairing stays rejected until it
//      is re-added in the console. The extension must drop its stored token and
//      stop, with no auto-reconnect loop — same handling as 4004, but the error
//      tells the user re-pairing alone will not work (plan 60 B6).
{
  const [server, client, env] = await startRelay();
  env.Config.saveSessionToken('tok-removed', () => {});
  env.State.setSessionToken('tok-removed');
  env.State.setConnected(true);
  await sleep(20);

  let reconnects = 0;
  const originalConnect = env.ConnectionManager.connect;
  env.ConnectionManager.connect = function() { reconnects++; return originalConnect.apply(this, arguments); };

  client.onclose({ code: 4005, reason: 'removed by navigator' });
  await sleep(40);

  test('14c. Removed-browser (4005) clears token, no auto-reconnect, removed error', () =>
    env.State.getSessionToken() === null &&
    !env.State.isConnected() &&
    reconnects === 0 &&
    /removed/i.test(String(env.State.getLastError())));
}

// 14d. Server-initiated collision (close code 4006): the name is configured
//      as a direct-CDP browser in BROWSERS, so the relay is refused. Same
//      handling as 4004/4005 (token cleared, no auto-reconnect), but the
//      error tells the user the fix is in the BROWSERS entry (plan 60 B7).
{
  const [server, client, env] = await startRelay();
  env.Config.saveSessionToken('tok-collision', () => {});
  env.State.setSessionToken('tok-collision');
  env.State.setConnected(true);
  await sleep(20);

  let reconnects = 0;
  const originalConnect = env.ConnectionManager.connect;
  env.ConnectionManager.connect = function() { reconnects++; return originalConnect.apply(this, arguments); };

  client.onclose({ code: 4006, reason: 'configured as direct browser' });
  await sleep(40);

  test('14d. Collision-name (4006) clears token, no auto-reconnect, direct-browser error', () =>
    env.State.getSessionToken() === null &&
    !env.State.isConnected() &&
    reconnects === 0 &&
    /direct browser/i.test(String(env.State.getLastError())));
}

// 15. Target.activateTarget / Target.closeTarget resolve CDP target ids to
//     real tab ids (hex chrome.debugger ids, not numeric tab ids) — the old
//     parseInt(targetId) bug rounded hex ids into a random tab.
{
  const env = buildEnv();
  loadExtension(env);
  const state = env.State;
  const serverWs = new env.WebSocket('relay://');
  serverWs.readyState = env.WebSocket.OPEN;
  state.setWs(serverWs);
  const sent = [];
  serverWs.send = (d) => { sent.push(JSON.parse(d)); };
  // mock: debugger.getTargets maps targetId 'ABCD1234' -> tabId 42
  env.chrome.debugger.getTargets = (cb) => cb([
    { id: 'ABCD1234', tabId: 42, type: 'page', title: 'T', url: 'https://x.test', attached: false }
  ]);
  let removed = null;
  let activated = null;
  env.chrome.tabs.remove = (tabId, cb) => { removed = tabId; cb && cb(); };
  env.chrome.tabs.update = (tabId, opts, cb) => { activated = { tabId, opts }; cb && cb(); };

  await env.routeCDPCommand({ id: 151, method: 'Target.activateTarget', params: { targetId: 'ABCD1234' }, sessionId: null });
  await env.routeCDPCommand({ id: 152, method: 'Target.closeTarget', params: { targetId: 'ABCD1234' }, sessionId: null });
  await sleep(60);
  const okActivate = activated && activated.tabId === 42 && activated.opts.active === true;
  const okClose = removed === 42;
  test('15. activate/closeTarget resolve hex CDP id -> tabId', () => okActivate && okClose);
}

// 15b. Browser window commands resolve REAL window geometry
//      (Browser.getWindowForTarget / setWindowBounds) via chrome.tabs.get +
//      chrome.windows.get/update — not the old hardcoded 1920x1080 stub.
{
  const env = buildEnv();
  loadExtension(env);
  env.chrome.debugger.getTargets = (cb) => cb([
    { id: 'W1N-D0W', tabId: 7, type: 'page', title: 'T', url: 'https://x.test', attached: false }
  ]);
  env.chrome.tabs.get = (id, cb) => cb({ id, title: 'T', url: 'https://x.test', windowId: 3 });
  let updated = null;
  env.chrome.windows.update = (id, opts, cb) => {
    updated = { id, opts };
    cb({ id, left: 10, top: 20, width: opts.width || 1920, height: opts.height || 1080, state: opts.state || 'normal', focused: !!opts.focused });
  };
  const out = [];
  const run = (id, method, params) => env.routeCDPCommand({ id, method, params, sessionId: null }).then(r => out.push(r));
  await run(153, 'Browser.getWindowForTarget', { targetId: 'W1N-D0W' });
  await run(154, 'Browser.setWindowBounds', { targetId: 'W1N-D0W', bounds: { width: 1280, height: 900, windowState: 'maximized' } });
  await sleep(80);

  const got = (out[0] && (out[0].result || out[0].error)) || {};
  const setRes = (out[1] && (out[1].result || {})) || {};
  const okGet = got.windowId === 3 && got.bounds && got.bounds.width === 1920 && got.bounds.windowState === 'normal';
  const okSet = updated && updated.id === 3 && updated.opts.width === 1280 && updated.opts.state === 'maximized';
  const okBounds = setRes.bounds && setRes.bounds.windowState === 'maximized';
  test('15b. Browser window commands resolve real window geometry', () => okGet && okSet && okBounds);
}

// 16. Target.attachToTarget success path must resolve a sessionId (regression:
//     the final .then read `tabId` from a callback param -> ReferenceError at
//     runtime; the response carried an error most relay clients saw as a generic
//     "Failed to attach target <id>")
{
  const env = buildEnv();
  loadExtension(env);
  const state = env.State;
  const serverWs = new env.WebSocket('relay://');
  serverWs.readyState = env.WebSocket.OPEN;
  state.setWs(serverWs);
  const replies = [];
  serverWs._receive = m => { if (m.id !== undefined) replies.push(m); };
  env.saveSent = m => { if (m.id !== undefined) replies.push(m); };

  await env.routeCDPCommand({ id: 161, method: 'Target.attachToTarget', params: { targetId: '1', flatten: true }, sessionId: null });
  await sleep(60);
  const reply = replies.find(m => m.id === 161) || serverWs._sent.find(m => m.id === 161);
  const sessionId = reply && reply.result && reply.result.sessionId;
  test('16. attachToTarget resolves an idempotent sessionId (no ReferenceError)', () => {
    const mapped = sessionId && state.getState().sessionIdToTabId && state.getState().sessionIdToTabId.get(sessionId) === 1;
    return !!sessionId && !!mapped && state.isTabAttached(1);
  });
}

// 17. DebuggerManager.attach falls back from {tabId} to {targetId} shape;
//     surfaces the full lastError when both fail
{
  const env = buildEnv();
  loadExtension(env);
  const state = env.State;
  const serverWs = new env.WebSocket('relay://');
  serverWs.readyState = env.WebSocket.OPEN;
  state.setWs(serverWs);
  const replies = [];
  serverWs._receive = m => { if (m.id !== undefined) replies.push(m); };
  env.saveSent = m => { if (m.id !== undefined) replies.push(m); };

  // tabId shape fails, targetId shape works
  env.chrome.debugger.attach = (shape, version, cb) => {
    const t = env.chrome;
    if (shape.tabId) { t.runtime.lastError = { message: 'Another debugger is already attached' }; setTimeout(() => cb && cb(), 2); }
    else { delete t.runtime.lastError; setTimeout(() => cb && cb(), 2); }
  };

  await env.routeCDPCommand({ id: 171, method: 'Target.attachToTarget', params: { targetId: 'target-1', flatten: true }, sessionId: null });
  await sleep(80);
  const reply = replies.find(m => m.id === 171) || serverWs._sent.find(m => m.id === 171);
  const sessionId = reply && reply.result && reply.result.sessionId;
  test('17. attach falls back to targetId shape + carries lastError', () => {
    const okSess = !!sessionId && state.isTabAttached(1);
    // and when both shapes fail, the surfaced message includes the lastError
    return okSess;
  });

  // both fail -> error message carries the JSON lastError
  const env2 = buildEnv();
  loadExtension(env2);
  env2.chrome.debugger.attach = (shape, version, cb) => {
    env2.chrome.runtime.lastError = { message: 'cannot attach' };
    cb && cb();
  };
  const replies2 = [];
  const s2 = new env2.WebSocket('relay://');
  s2.readyState = env2.WebSocket.OPEN;
  env2.State.setWs(s2);
  s2._receive = m => { if (m.id !== undefined) replies2.push(m); };
  env2.saveSent = m => { if (m.id !== undefined) replies2.push(m); };
  await env2.routeCDPCommand({ id: 172, method: 'Target.attachToTarget', params: { targetId: 'target-1', flatten: true }, sessionId: null });
  await sleep(60);
  const r2 = replies2.find(m => m.id === 172) || s2._sent.find(m => m.id === 172);
  const errMsg = r2 && r2.error && r2.error.message;
  test('17b. double-failure error includes lastError JSON', () => !!errMsg && errMsg.includes('cannot attach'));
}

// 18. Durable "connecting intent" flag survives a simulated service-worker
// termination (fresh extension context rebuilt from the SAME storage).
{
  const chrome1 = makeChromeMock();
  const storage = chrome1._storage;          // shared across "contexts"
  const chrome2 = makeChromeMock();
  chrome2._storage = storage;                // reuse the same storage
  chrome2.storage.local.get = chrome1.storage.local.get;
  chrome2.storage.local.set = chrome1.storage.local.set;
  chrome2.storage.local.remove = chrome1.storage.local.remove;

  const env1 = buildEnvFromChrome(chrome1);
  loadExtension(env1);
  const env2 = buildEnvFromChrome(chrome2);
  loadExtension(env2);

  // "User clicks Connect then the popup closes / SW is killed mid-connect"
  env1.Config.setPendingConnecting('10.69.1.164:1994', 'Chrome', () => {});

  const pending = await new Promise(res => env2.Config.getPendingConnecting(x => res(x)));
  test('18. Pending-connecting flag survives SW termination (storage-backed)', () =>
    pending.pending === true &&
    pending.serverUrl === '10.69.1.164:1994' &&
    pending.browserName === 'Chrome');

  // Once connect() reaches `connected`, the flag must clear so the popup
  // no longer shows Connecting… / empty-state forever.
  env2.Config.saveServerUrl('10.69.1.164:1994', () => {});
  env2.ConnectionManager.connect();
  await sleep(30);
  const [, cli] = wireRelay(env2, '10.69.1.164:1994');
  cli.other.send(JSON.stringify({ type: 'connected', sessionToken: 'tok-x' }));
  await sleep(40);
  const after = await new Promise(res => env2.Config.getPendingConnecting(x => res(x)));
  test('18b. connected resolves -> pending-connecting flag cleared', () =>
    after.pending === false && env2.State.isConnected());
}

// 19. Disconnect clears the pending flag too (paired browser, clean drop)
{
  const chrome = makeChromeMock();
  const env = buildEnvFromChrome(chrome);
  loadExtension(env);
  env.Config.setPendingConnecting('ws://relay', 'Chrome', () => {});
  env.ConnectionManager.disconnect();
  const after = await new Promise(res => env.Config.getPendingConnecting(x => res(x)));
  test('19. disconnect clears the pending-connecting flag', () => after.pending === false);
}

// 20-24. "Open windows instead of tabs" (plan 56) — window-mode behavior.
// Flag OFF: createTarget keeps today's tab path (tabs.create + grouping),
// contexts stay mock. Flag ON: createTarget/createBrowserContext open real
// windows, getBrowserContexts lists them, closeTarget removes the window.

// 20. flag OFF -> createTarget uses the plain tab path (tabs.create + grouping)
{
  const env = buildEnv();
  loadExtension(env);
  env.Config.setOpenInWindow(false, () => {});
  // known target for the new tab so waitForTargetByTabId resolves fast
  env.chrome.debugger.getTargets = (cb) => cb([
    { id: 'target-99', tabId: 99, type: 'page', title: 'T', url: 'https://example.com', attached: false },
    { id: 'target-1', tabId: 1, type: 'page', title: 'Example', url: 'https://example.com', attached: false }
  ]);
  const rec = { tabsCreate: 0, windowsCreate: 0, groups: 0 };
  const origTabsCreate = env.chrome.tabs.create;
  env.chrome.tabs.create = (opts, cb) => { rec.tabsCreate++; return origTabsCreate(opts, cb); };
  env.chrome.windows.create = (opts, cb) => { rec.windowsCreate++; cb({ id: 500, tabs: [{ id: 98 }] }); };
  env.chrome.tabs.group = (opts, cb) => { rec.groups++; return Promise.resolve(10); };

  const res = await env.routeCDPCommand({ id: 201, method: 'Target.createTarget', params: { url: 'https://example.com' }, sessionId: null });
  const r = res && res.result;
  test('20. flag OFF -> createTarget = tabs.create path + grouping', () =>
    !!r && r.targetId === 'target-99' &&
    rec.tabsCreate === 1 && rec.windowsCreate === 0 && rec.groups >= 1);
}

// 21. flag ON -> createTarget opens a real window, result carries the context
{
  const env = buildEnv();
  loadExtension(env);
  env.Config.setOpenInWindow(true, () => {});
  env.chrome.debugger.getTargets = (cb) => cb([
    { id: 'target-98', tabId: 98, type: 'page', title: 'T', url: 'https://example.com', attached: false },
    { id: 'target-1', tabId: 1, type: 'page', title: 'Example', url: 'https://example.com', attached: false }
  ]);
  const rec = { windowsCreate: [], groups: 0, tabsUpdate: [] };
  env.chrome.windows.create = (opts, cb) => {
    rec.windowsCreate.push(opts);
    cb({ id: 500, tabs: [{ id: 98, url: 'about:blank', active: false, windowId: 500 }] });
  };
  env.chrome.tabs.group = (opts, cb) => { rec.groups++; return Promise.resolve(10); };
  env.chrome.tabs.update = (id, opts, cb) => { rec.tabsUpdate.push({ id, opts }); cb && cb(); };

  const res = await env.routeCDPCommand({ id: 210, method: 'Target.createTarget', params: { url: 'https://example.com' }, sessionId: null });
  const r = res && res.result;
  const createOpts = rec.windowsCreate[0] || {};
  test('21. flag ON -> createTarget opens a window with browserContextId', () =>
    !!r && r.targetId === 'target-98' && r.browserContextId === 'window-500' && r.windowId === 500 &&
    rec.windowsCreate.length === 1 && rec.groups === 0 &&
    // windows.create rejects `active` (tabs.create-only); `focused:false` keeps it background.
    !('active' in createOpts) && createOpts.focused === false &&
    rec.tabsUpdate.length === 1 && rec.tabsUpdate[0].opts.url === 'https://example.com');
}

// 22. flag ON -> createBrowserContext lazy window-<ts>-<rand> id (no window
//     opens); getBrowserContexts lists it; dispose drops it with no close
{
  const env = buildEnv();
  loadExtension(env);
  env.Config.setOpenInWindow(true, () => {});
  let createdWindows = 0;
  const createOpts = [];
  env.chrome.windows.create = (opts, cb) => {
    createOpts.push(opts);
    createdWindows++;
    cb({ id: 600, tabs: [{ id: 97, url: 'about:blank', active: false, windowId: 600 }] });
  };
  const removed = [];
  env.chrome.windows.remove = (id, cb) => { removed.push(id); cb && cb(); };

  const r1 = await env.routeCDPCommand({ id: 221, method: 'Target.createBrowserContext', params: {}, sessionId: null });
  const r2 = await env.routeCDPCommand({ id: 222, method: 'Target.getBrowserContexts', params: {}, sessionId: null });
  const bctx = r1 && r1.result && r1.result.browserContextId;
  const r3 = await env.routeCDPCommand({ id: 223, method: 'Target.disposeBrowserContext', params: { browserContextId: bctx }, sessionId: null });
  const r4 = await env.routeCDPCommand({ id: 224, method: 'Target.getBrowserContexts', params: {}, sessionId: null });
  test('22. flag ON -> lazy window-<ts>-<rand> context; no window; dispose drops id', () =>
    !!bctx && !r1.result._mock && r1.result._lazyWindow === true &&
    /^window-\d+-[a-z0-9]+$/.test(bctx) &&
    createdWindows === 0 && createOpts.length === 0 &&
    Array.isArray(r2.result.browserContextIds) && r2.result.browserContextIds.join() === 'default,' + bctx &&
    r3 && r3.result && removed.length === 0 &&
    Array.isArray(r4.result.browserContextIds) && r4.result.browserContextIds.join() === 'default');
}

// 23. flag OFF -> contexts stay exactly today's mock
{
  const env = buildEnv();
  loadExtension(env);
  env.Config.setOpenInWindow(false, () => {});
  const removed = [];
  env.chrome.windows.remove = (id, cb) => { removed.push(id); cb && cb(); };

  const r1 = await env.routeCDPCommand({ id: 231, method: 'Target.createBrowserContext', params: {}, sessionId: null });
  const r2 = await env.routeCDPCommand({ id: 232, method: 'Target.getBrowserContexts', params: {}, sessionId: null });
  await env.routeCDPCommand({ id: 233, method: 'Target.disposeBrowserContext', params: { browserContextId: 'context-whatever' }, sessionId: null });
  test('23. flag OFF -> contexts stay mock, dispose no window action', () =>
    !!r1.result._mock && /^context-/.test(r1.result.browserContextId) &&
    r2.result.browserContextIds.join() === 'default' && removed.length === 0);
}

// 24. closeTarget: last tab of a CDP-created window closes the window,
//     otherwise it plain-removes the tab
{
  const env = buildEnv();
  loadExtension(env);
  env.Config.setOpenInWindow(true, () => {});
  const state = env.State;
  state.addCDPCreatedTab(500);
  state.addCDPCreatedWindow(77);          // 1-tab CDP window
  state.addCDPCreatedTab(501);
  state.addCDPCreatedWindow(78);          // 2-tab CDP window

  const rec = { winRemove: [], tabRemove: [] };
  env.chrome.windows.remove = (id, cb) => { rec.winRemove.push(id); cb && cb(); };
  env.chrome.tabs.remove = (id, cb) => { rec.tabRemove.push(id); cb && cb(); };
  env.chrome.tabs.get = (id, cb) => {
    const map = { 500: 77, 501: 78, 502: 78 };
    cb({ id, windowId: map[id] != null ? map[id] : 1, title: 'T', url: 'about:blank' });
  };
  env.chrome.windows.get = (id, opts, cb) => {
    if (id === 77) cb({ id: 77, tabs: [{ id: 500 }] });
    else if (id === 78) cb({ id: 78, tabs: [{ id: 501 }, { id: 502 }] });
    else cb({ id, tabs: [] });
  };

  const o1 = await env.routeCDPCommand({ id: 241, method: 'Target.closeTarget', params: { targetId: '500' }, sessionId: null });
  await sleep(40);
  const okLast = o1 && o1.result && o1.result.success === true &&
    rec.winRemove.join() === '77' && rec.tabRemove.length === 0 &&
    !state.isCDPCreatedWindow(77);
  const o2 = await env.routeCDPCommand({ id: 242, method: 'Target.closeTarget', params: { targetId: '501' }, sessionId: null });
  await sleep(40);
  const okOther = o2 && o2.result && o2.result.success === true &&
    rec.winRemove.join() === '77' && rec.tabRemove.join() === '501' && state.isCDPCreatedWindow(78);
  test('24. closeTarget closes a 1-tab CDP window, plain-removes otherwise', () => okLast && okOther);
}

// 25. flag OFF + explicit newWindow:true still opens a window (wantWindow
//     override); a lone window tab is never grouped
{
  const env = buildEnv();
  loadExtension(env);
  env.Config.setOpenInWindow(false, () => {});
  env.chrome.debugger.getTargets = (cb) => cb([
    { id: 'target-98', tabId: 98, type: 'page', title: 'T', url: 'https://example.com', attached: false },
    { id: 'target-1', tabId: 1, type: 'page', title: 'Example', url: 'https://example.com', attached: false }
  ]);
  const rec = { windowsCreate: 0, tabsCreate: 0, groups: 0 };
  const origTabsCreate = env.chrome.tabs.create;
  env.chrome.tabs.create = (opts, cb) => { rec.tabsCreate++; return origTabsCreate(opts, cb); };
  env.chrome.windows.create = (opts, cb) => { rec.windowsCreate++; cb({ id: 501, tabs: [{ id: 98, windowId: 501 }] }); };
  env.chrome.tabs.group = (_opts, _cb) => { rec.groups++; return Promise.resolve(10); };

  const res = await env.routeCDPCommand({ id: 251, method: 'Target.createTarget', params: { url: 'https://example.com', newWindow: true }, sessionId: null });
  const r = res && res.result;
  test('25. flag OFF + newWindow -> still a window (tab path skipped, no grouping)', () =>
    !!r && r.browserContextId === 'window-501' && r.windowId === 501 &&
    rec.windowsCreate === 1 && rec.tabsCreate === 0 && rec.groups === 0);
}

// 26. flag OFF + non-default browserContextId still opens a window — this is
//     exactly what puppeteer's context.newPage() sends through the relay
{
  const env = buildEnv();
  loadExtension(env);
  env.Config.setOpenInWindow(false, () => {});
  env.chrome.debugger.getTargets = (cb) => cb([
    { id: 'target-98', tabId: 98, type: 'page', title: 'T', url: 'https://example.com', attached: false },
    { id: 'target-1', tabId: 1, type: 'page', title: 'Example', url: 'https://example.com', attached: false }
  ]);
  const rec = { windowsCreate: 0, tabsCreate: 0 };
  const origTabsCreate = env.chrome.tabs.create;
  env.chrome.tabs.create = (opts, cb) => { rec.tabsCreate++; return origTabsCreate(opts, cb); };
  env.chrome.windows.create = (opts, cb) => { rec.windowsCreate++; cb({ id: 502, tabs: [{ id: 98, windowId: 502 }] }); };

  const res = await env.routeCDPCommand({ id: 261, method: 'Target.createTarget', params: { url: 'https://example.com', browserContextId: 'window-42' }, sessionId: null });
  const r = res && res.result;
  test('26. flag OFF + browserContextId -> window path (puppeteer context.newPage)', () =>
    !!r && r.browserContextId === 'window-502' && r.windowId === 502 &&
    rec.windowsCreate === 1 && rec.tabsCreate === 0);
}

// 27. TabList: a window-created tab reports windowId + window-<id> context
//     (this is what the relay's tab registry sees), plain tabs stay 'default'
{
  const env = buildEnv();
  loadExtension(env);
  const state = env.State;
  state.addCDPCreatedWindow(9);
  env.chrome.debugger.getTargets = (cb) => cb([
    { id: 'target-40', tabId: 40, type: 'page', title: 'Win', url: 'https://win.test', attached: false },
    { id: 'target-41', tabId: 41, type: 'page', title: 'Plain', url: 'https://plain.test', attached: false }
  ]);
  env.chrome.tabs.get = (id, cb) => cb({ id, title: 'T' + id, url: id === 40 ? 'https://win.test' : 'https://plain.test', windowId: id === 40 ? 9 : 1 });
  const targets = await new Promise(res => env.TabList.getAllAsTargets(t => res(t)));
  const win = targets.find(t => t.tabId === 40);
  const plain = targets.find(t => t.tabId === 41);
  test('27. TabList: window target emits windowId + window-<id> context', () =>
    !!win && win.browserContextId === 'window-9' && win.windowId === 9 &&
    !!plain && plain.browserContextId === 'default' && plain.windowId === 1);
}

// 28. Context lifecycle (lazy): createBrowserContext registers a lazy id;
//     createTarget opens the real window+context; closing its last tab drops
//     the real context; dispose drops the lazy id
{
  const env = buildEnv();
  loadExtension(env);
  env.Config.setOpenInWindow(true, () => {});
  env.chrome.debugger.getTargets = (cb) => cb([
    { id: 'target-98', tabId: 98, type: 'page', title: 'T', url: 'https://example.com', attached: false },
    { id: 'target-1', tabId: 1, type: 'page', title: 'Example', url: 'https://example.com', attached: false }
  ]);
  const winIds = [600, 500];
  env.chrome.windows.create = (opts, cb) => {
    const id = winIds.shift();
    cb({ id, tabs: [{ id: 98, windowId: id }] });
  };
  const removedWin = [];
  const removedTab = [];
  env.chrome.windows.remove = (id, cb) => { removedWin.push(id); cb && cb(); };
  env.chrome.tabs.remove = (id, cb) => { removedTab.push(id); cb && cb(); };
  env.chrome.windows.get = (id, opts, cb) => cb({ id, tabs: [{ id: 98 }] });
  env.chrome.tabs.get = (id, cb) => cb({ id, title: 'T', url: 'about:blank', windowId: id === 98 ? 600 : 1 });

  const c1 = await env.routeCDPCommand({ id: 281, method: 'Target.createBrowserContext', params: {}, sessionId: null });
  const c2 = await env.routeCDPCommand({ id: 282, method: 'Target.createTarget', params: { url: 'https://example.com' }, sessionId: null });
  const c3 = await env.routeCDPCommand({ id: 283, method: 'Target.getBrowserContexts', params: {}, sessionId: null });
  await env.routeCDPCommand({ id: 284, method: 'Target.closeTarget', params: { targetId: c2.result.targetId }, sessionId: null });
  await sleep(40);
  const c4 = await env.routeCDPCommand({ id: 285, method: 'Target.getBrowserContexts', params: {}, sessionId: null });
  await env.routeCDPCommand({ id: 286, method: 'Target.disposeBrowserContext', params: { browserContextId: c1.result.browserContextId }, sessionId: null });
  const c5 = await env.routeCDPCommand({ id: 287, method: 'Target.getBrowserContexts', params: {}, sessionId: null });

  const lazyId = c1 && c1.result && c1.result.browserContextId;
  test('28. lazy context: createTarget opens the real window; closeTarget+dispose unregister all', () =>
    /^window-\d+-[a-z0-9]+$/.test(lazyId) && c1.result._lazyWindow === true &&
    c2.result.browserContextId === 'window-600' && c2.result.windowId === 600 &&
    c3.result.browserContextIds.join() === 'default,window-600,' + lazyId &&
    removedWin.join() === '600' && removedTab.length === 0 &&
    c4.result.browserContextIds.join() === 'default,' + lazyId &&
    c5.result.browserContextIds.join() === 'default');
}

// 29. Browser description (plan 45) — storage, hello carriage, live update.
{
  const env = buildEnv();
  loadExtension(env);

  // 29a. Storage round-trips, defaulting to "".
  const empty = await new Promise(res => env.Config.getBrowserDescription(x => res(x)));
  test('29a. browserDescription defaults to empty string', () => empty === '');

  await new Promise(res => env.Config.saveBrowserDescription("my daily driver for gmail", res));
  const stored = await new Promise(res => env.Config.getBrowserDescription(x => res(x)));
  test('29b. browserDescription round-trips through chrome.storage.local', () =>
    stored === 'my daily driver for gmail');

  // 29c. The hello carries it, so a navigator that restarted still learns it.
  env.Config.saveServerUrl('10.69.1.164:1994', () => {});
  env.ConnectionManager.connect();
  await sleep(30);
  const [server, client] = wireRelay(env, '10.69.1.164:1994');
  const hello = client._sent.find(m => m.type === 'navigator-hello');
  test('29c. navigator-hello carries browserDescription', () =>
    !!hello && hello.browserDescription === 'my daily driver for gmail');

  // 29d. The extension gates the live update on the SOCKET being open, not on
  //      being authenticated — the server is what enforces auth (and it
  //      rejects update_description before a PIN/token is accepted; see
  //      tests/relay-server.test.js). A value edited while merely socket-open
  //      is still sent; the server decides.
  const before = client._sent.filter(m => m.type === 'update_description').length;
  await new Promise(res => env.ConnectionManager.updateDescription('edited', res));
  const sentCount = client._sent.filter(m => m.type === 'update_description').length;
  test('29d. updateDescription is sent whenever the socket is open', () =>
    sentCount === before + 1);

  // 29e. With NO socket at all, nothing is sent but the value still persists,
  //      so it rides the next hello instead.
  env.ConnectionManager.disconnect();
  const afterDisconnect = client._sent.filter(m => m.type === 'update_description').length;
  await new Promise(res => env.ConnectionManager.updateDescription('while fully offline', res));
  const offlineStored = await new Promise(res => env.Config.getBrowserDescription(x => res(x)));
  test('29e. disconnected: no frame sent, but the value is stored for the next hello', () =>
    client._sent.filter(m => m.type === 'update_description').length === afterDisconnect &&
    offlineStored === 'while fully offline');
}

// 30. Live update over an authenticated, already-connected channel.
{
  const env = buildEnv();
  loadExtension(env);
  await new Promise(res => env.Config.saveBrowserDescription('first take', res));
  env.Config.saveServerUrl('10.69.1.164:1994', () => {});
  env.ConnectionManager.connect();
  await sleep(30);
  const [server, client] = wireRelay(env, '10.69.1.164:1994');
  client.other.send(JSON.stringify({ type: 'connected', sessionToken: 'tok-live' }));
  await sleep(40);
  test('30a. connected before the live update', () => env.State.isConnected());

  const res = await new Promise(r => env.ConnectionManager.updateDescription('second take', r));
  const sent = client._sent.find(m => m.type === 'update_description');
  test('30b. updateDescription sends update_description while connected', () =>
    res.success === true && !!sent && sent.description === 'second take');

  // The local copy is authoritative for the next hello too.
  const persisted = await new Promise(r => env.Config.getBrowserDescription(x => r(x)));
  test('30c. updateDescription also persists locally', () => persisted === 'second take');
}

// 31. The pending-connecting flag carries the description so a popup that
//     reopens mid-connect restores what the user typed.
{
  const env = buildEnv();
  loadExtension(env);
  env.Config.setPendingConnecting('10.69.1.164:1994', 'Az01-Chrome', 'restored description', () => {});
  const pending = await new Promise(res => env.Config.getPendingConnecting(x => res(x)));
  test('31. pending-connecting carries browserDescription across SW kill', () =>
    pending.pending === true && pending.browserDescription === 'restored description');

  // 3-arg legacy form (older caller passing a callback) must still work.
  env.Config.setPendingConnecting('10.69.1.164:1994', 'Chrome', () => {});
  const legacy = await new Promise(res => env.Config.getPendingConnecting(x => res(x)));
  test('31b. 3-arg setPendingConnecting (callback 3rd) stays back-compatible', () =>
    legacy.browserName === 'Chrome' && legacy.browserDescription === '');
}

// 32. Emptying the field is a real edit, not a no-op. The server treats an
//     ABSENT browserDescription as "old extension, keep what's stored" (see
//     tests/relay-server.test.js), so the hello must carry an explicit "" to
//     clear it. Gating the field on truthiness would strand the old value for
//     anyone who empties it while offline.
{
  const env = buildEnv();
  loadExtension(env);
  await new Promise(res => env.Config.saveBrowserDescription('to be removed', res));
  env.Config.saveServerUrl('10.69.1.164:1994', () => {});
  env.ConnectionManager.connect();
  await sleep(30);
  const [server, client] = wireRelay(env, '10.69.1.164:1994');
  const before = client._sent.find(m => m.type === 'navigator-hello');
  test('32a. hello carries the saved description first', () =>
    !!before && before.browserDescription === 'to be removed');

  // User empties the field while disconnected, then reconnects.
  env.ConnectionManager.disconnect();
  await new Promise(res => env.Config.saveBrowserDescription('', res));
  env.ConnectionManager.connect();
  await sleep(30);
  const [, client2] = wireRelay(env, '10.69.1.164:1994');
  const cleared = client2._sent.find(m => m.type === 'navigator-hello');
  test('32b. empty description is sent explicitly so the server clears it', () =>
    !!cleared && cleared.browserDescription === '');
}

// 33. background.js startup resume — the description must survive a suspension
// between the popup's save and the relay handshake. This path lives inside
// init() in background.js, so the whole script has to run for it to be reached.
{
  const env = buildEnv();
  loadExtension(env);
  const listeners = { installed: [], startup: [], message: [], alarm: [] };
  env.chrome.runtime.onInstalled = { addListener: (f) => listeners.installed.push(f) };
  env.chrome.runtime.onStartup = { addListener: (f) => listeners.startup.push(f) };
  env.chrome.runtime.onMessage = { addListener: (f) => listeners.message.push(f) };
  env.chrome.alarms.onAlarm = { addListener: (f) => listeners.alarm.push(f) };

  // The user had a description stored, then typed a NEW one and hit Connect:
  // storage holds the new text only inside the durable pending flag.
  await new Promise(res => env.Config.saveBrowserDescription('stale old text', res));
  await new Promise(res => env.Config.setPendingConnecting(
    'ws://relay', 'maclap2', 'the description typed before suspension', res));
  const storedDescriptionAsync = () => new Promise(res => env.Config.getBrowserDescription(res));

  let booted = false;
  try {
    // background.js is a service worker, so it pulls its modules in with
    // importScripts; give the sandbox the same module order loadExtension uses.
    const order = [
      'utils/config.js', 'utils/logger.js', 'utils/helpers.js',
      'core/state.js', 'core/debugger.js', 'core/connection-manager.js',
      'cdp/response.js', 'cdp/handler/local.js', 'cdp/handler/special.js',
      'cdp/handler/forward.js', 'cdp/index.js',
      'features/tab-list.js', 'features/tab-isolation.js', 'features/badge.js'
    ];
    env.importScripts = (...rels) => {
      for (const rel of rels) vm.runInContext(readFileSync(`${ROOT}${rel}`, 'utf8'), env, { filename: rel });
    };
    vm.runInContext(readFileSync(`${ROOT}background.js`, 'utf8'), env, { filename: 'background.js' });
    booted = true;
  } catch (e) { report('33. background.js boots in the harness', false, e); }
  test('33. background.js boots in the harness', () => booted);
  test('33a. it registered a startup listener', () => listeners.startup.length === 1);

  // Browser startup: the pending connect is resumed.
  for (const fn of listeners.startup) fn({});
  await sleep(60);

  test('33b. resume committed the pending description to storage', async () =>
    (await storedDescriptionAsync()) === 'the description typed before suspension');

  const client3 = env.State.getWs();
  const server3 = client3 && new FakeWebSocket('ws://relay');
  if (client3) { server3.readyState = FakeWebSocket.OPEN; server3.other = client3; client3.other = server3; }
  const hello = client3 && client3._sent.find(m => m.type === 'navigator-hello');
  test('33c. the resumed hello carries the pending description, not the stale one', () =>
    !!hello && hello.browserDescription === 'the description typed before suspension');
  test('33d. the pending flag is consumed by the resume', async () => {
    const after = await new Promise(res => env.Config.getPendingConnecting(res));
    return after.pending === false;
  });
}

// 34. An explicitly cleared description in the pending flag must not fall back
// to the stale stored value (the "no owner description" case is meaningful).
{
  const env = buildEnv();
  loadExtension(env);
  await new Promise(res => env.Config.saveBrowserDescription('stale old text', res));
  await new Promise(res => env.Config.setPendingConnecting('ws://relay', 'maclap2', '', res));
  const restored = await new Promise(res => env.Config.getPendingConnecting(res));
  test('34. a pending clear keeps the empty string instead of the stale value', () =>
    restored.pending === true && restored.browserDescription === '');
}

// 35. The browser name persists across disconnect + worker restart, and a fresh
// install gets a random two-word default instead of a fixed "Chrome". The
// in-memory State used to start as "Chrome", so the popup's "use the saved
// name if the in-memory one is empty" fallback never ran: after a disconnect or
// a worker restart the field showed "Chrome" again and the next Connect
// saved it over the user's name.
{
  const bootBackground = (env) => {
    const listeners = { installed: [], startup: [], message: [], alarm: [] };
    env.chrome.runtime.onInstalled = { addListener: (f) => listeners.installed.push(f) };
    env.chrome.runtime.onStartup = { addListener: (f) => listeners.startup.push(f) };
    env.chrome.runtime.onMessage = { addListener: (f) => listeners.message.push(f) };
    env.chrome.alarms.onAlarm = { addListener: (f) => listeners.alarm.push(f) };
    const order = [
      'utils/config.js', 'utils/logger.js', 'utils/helpers.js',
      'core/state.js', 'core/debugger.js', 'core/connection-manager.js',
      'cdp/response.js', 'cdp/handler/local.js', 'cdp/handler/special.js',
      'cdp/handler/forward.js', 'cdp/index.js',
      'features/tab-list.js', 'features/tab-isolation.js', 'features/badge.js'
    ];
    env.importScripts = (...rels) => {
      for (const rel of rels) vm.runInContext(readFileSync(`${ROOT}${rel}`, 'utf8'), env, { filename: rel });
    };
    vm.runInContext(readFileSync(ROOT + 'background.js', 'utf8'), env, { filename: 'background.js' });
    return (message) => new Promise((resolve) => {
      let done = false;
      const reply = (r) => { if (!done) { done = true; resolve(r); } };
      for (const fn of listeners.message) fn(message, {}, reply);
      setTimeout(() => reply(undefined), 500);
    });
  };
  const sharedChrome = () => {
    const base = makeChromeMock();
    return (into) => {
      into.storage.local.get = base.storage.local.get;
      into.storage.local.set = base.storage.local.set;
      into.storage.local.remove = base.storage.local.remove;
      into._storage = base._storage;
      return into;
    };
  };
  const share = sharedChrome();

  // Fresh install: no stored name.
  const env1 = buildEnvFromChrome(share(makeChromeMock()));
  loadExtension(env1);
  const send1 = bootBackground(env1);
  const snap1 = await send1({ type: 'popup-query' });
  const generated = snap1 && snap1.browserName;
  test('35a. a fresh install defaults to a random two-word name, not "Chrome"', () =>
    typeof generated === 'string' && /^[a-z]+-[a-z]+$/.test(generated) && generated !== 'Chrome');
  // Resolve before moving on: test() does not await async checks, and the
  // connect below would otherwise race the storage read.
  const again1 = await send1({ type: 'popup-query' });
  const stored1 = await new Promise((res) => env1.Config.getBrowserName(res));
  test('35b. the generated default is saved and stable across queries', () =>
    again1 && again1.browserName === generated && stored1 === generated);

  // User renames it, connects, then disconnects.
  await send1({ type: 'connect', serverUrl: 'ws://relay', browserName: 'ChromeLinux', browserDescription: '' });
  await sleep(40);
  await send1({ type: 'disconnect' });
  await sleep(20);
  const snapAfterDisconnect = await send1({ type: 'popup-query' });
  test('35c. after disconnect the popup still shows the typed name', () =>
    snapAfterDisconnect && snapAfterDisconnect.browserName === 'ChromeLinux');

  // Worker / event page is killed and restarted from the same storage.
  const env2 = buildEnvFromChrome(share(makeChromeMock()));
  loadExtension(env2);
  const send2 = bootBackground(env2);
  const snapAfterRestart = await send2({ type: 'popup-query' });
  test('35d. after a worker restart the popup still shows the typed name (was "Chrome")', () =>
    snapAfterRestart && snapAfterRestart.browserName === 'ChromeLinux');

  // Reconnecting uses the saved name in the hello.
  await send2({ type: 'connect', serverUrl: 'ws://relay', browserName: snapAfterRestart.browserName, browserDescription: '' });
  await sleep(60);
  const client = env2.State.getWs();
  const hello = client && client._sent.find((m) => m.type === 'navigator-hello');
  test('35e. the reconnect hello carries the persisted name', () => !!hello && hello.browserName === 'ChromeLinux');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

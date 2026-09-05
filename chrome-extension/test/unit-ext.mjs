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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
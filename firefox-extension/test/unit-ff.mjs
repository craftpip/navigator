#!/usr/bin/env node
/**
 * Standalone unit tests for the Firefox extension (background-bridge layer).
 *
 * Loads every extension script into a node:vm context with mocked Firefox
 * (chrome.* namespace) APIs, a paired FakeWebSocket for the relay, and a
 * FakeBiDi "Remote Agent" WebSocket that responds to the session.new dance and
 * echoes commands. No real Firefox needed.
 *
 * What's verified:
 *   1. modules load                                13. remote-value deserialization
 *   2. Config round-trip (Firefox defaults)         14. Input.dispatchMouseEvent -> input.performActions
 *   3. BiDi session.new + subscribe handshake       15. session token reuse on reconnect
 *   4. relay navigator-hello                        16. TabList over tabs.query (no getTargets)
 *   5. PIN round-trip                               17. BidiUrl persisted after session.new
 *   6. Browser.getVersion is Firefox-branded LOCAL
 *   7. Page.navigate -> browsingContext.navigate (translated + transformed)
 *   8. Runtime.evaluate remote value -> CDP result
 *   9. Runtime.evaluate exception -> exceptionDetails (full routed path)
 *  10. Target.createTarget -> browsingContext.create + navigate
 *  11. BiDi events -> CDP events (load / detached via real contextDestroyed)
 *  12. unmapped CDP method -> -32601 UnsupportedOperation
 *  18. durable pending-connecting flag survives suspension + clears on connected
 *  19. disconnect clears the pending-connecting flag
 *  31. browser description: storage, hello carriage, live update
 *  32. live description update over a connected channel
 *  33. pending-connecting carries the description
 *  34. empty description is sent explicitly (clear is a real edit)
 *
 * 20d/20e fail pre-existing and are unrelated: the probe reports
 * mode:'unknown' when both schemes fail, those tests expect refused/dns.
 *
 * Usage: node test/unit-ff.mjs
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
      id: 'navigator-browser-relay@navigator.local',
      getManifest: () => ({ version: '0.1.0' }),
      getURL: p => 'moz-extension://abc/' + p,
      lastError: null,
      onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      sendMessage: () => Promise.resolve({})
    },
    tabs: {
      query: (opts, cb) => cb([
        { id: 1, title: 'Example', url: 'https://example.com', active: true, windowId: 1, index: 0 },
        { id: 2, title: 'GitHub', url: 'https://github.com', active: false, windowId: 1, index: 1 }
      ]),
      get: (id, cb) => cb({ id, title: 'Tab ' + id, url: id === 2 ? 'https://github.com' : 'https://example.com', windowId: 1, index: id === 2 ? 1 : 0 }),
      create: (opts, cb) => cb && cb({ id: 99, url: opts.url, active: false, windowId: 1, index: 2 }),
      update: (id, opts, cb) => cb && cb(),
      remove: (id, cb) => cb && cb(),
      hide: (ids, cb) => cb && cb(),
      show: (ids, cb) => cb && cb(),
      onCreated: { addListener: () => {} }
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
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
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
  chrome._storage = storage;   // expose for tests that simulate suspend/shared storage
  return chrome;
}

/** Build a fresh extension env from an explicitly provided chrome mock. */
function buildEnvFromChrome(chrome) {
  const sandbox = {
    chrome,
    console,
    WebSocket: FakeWebSocket,
    navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0' },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Promise, String, Number, Array, Object, Map, Set,
    parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    requestAnimationFrame: () => {},
    Blob: globalThis.Blob
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  sandbox._ctx = ctx;
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

const LOAD_ORDER = [
  'utils/config.js', 'utils/logger.js', 'utils/helpers.js', 'utils/probe.js',
  'core/state.js',
  'cdp/bidi/remote-value.js', 'cdp/bidi/mapper.js', 'cdp/bidi/bidi-client.js',
  'core/session-manager.js', 'core/connection-manager.js',
  'cdp/response.js', 'cdp/handler/local.js', 'cdp/handler/special.js',
  'cdp/handler/forward.js', 'cdp/index.js',
  'features/tab-list.js', 'features/tab-isolation.js', 'features/badge.js'
];

function buildEnv() {
  return buildEnvFromChrome(makeChromeMock());
}

function loadExtension(sandbox) {
  LOAD_ORDER.forEach(rel => {
    vm.runInContext(readFileSync(`${ROOT}${rel}`, 'utf8'), sandbox, { filename: rel });
  });
  // background.js wires this listener — replicate inline for the harness
  sandbox.BidiClient.setListener(ev => sandbox.Mapper.handleBiDiEvent(ev));
}

/** Start a relay session: extension connects; returns [serverWs, clientWs, env]. */
function startRelay() {
  const env = buildEnv();
  loadExtension(env);
  env.Config.saveServerUrl('ws://relay', () => {});
  env.ConnectionManager.connect();
  return new Promise(resolve => {
    setTimeout(() => {
      const client = env.State.getWs();
      const server = new FakeWebSocket('ws://relay');
      server.readyState = FakeWebSocket.OPEN;
      server.other = client;
      client.other = server;
      resolve([server, client, env]);
    }, 30);
  });
}

// FakeBiDi "Remote Agent" — auto-answers the handshake + echoes commands.
let bidiSeed = 0;
let replyOverrides = {};   // method -> reply `result` to force (test injection)
function setBidiReply(method, result) {
  if (result === null) delete replyOverrides[method];
  else replyOverrides[method] = result;
}

function attachBidi(env, url) {
  const client = env.BidiClient.getSocket();
  const server = new FakeWebSocket(url || 'ws://127.0.0.1:9222/session');
  server.readyState = FakeWebSocket.OPEN;
  server.onmessage = e => bidiServerOnMessage(server, e.data);
  client.other = server;
  server.other = client;
  return [server, client, env];
}

function bidiServerOnMessage(server, data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (msg.id == null) return;
  setTimeout(() => {
    const id = msg.id;
    const sendResult = (result) => server.send(JSON.stringify({ id, type: 'success', result }));
    const sendEvent = (method, params) => server.send(JSON.stringify({ method, type: 'event', params }));

    switch (msg.method) {
      case 'session.new':
        sendResult({ sessionId: 'mock-sess-' + (++bidiSeed), capabilities: { browserName: 'firefox', browserVersion: '129.0' } });
        break;
      case 'session.subscribe':
        sendResult({});
        break;
      case 'browsingContext.getTree':
        sendResult({ contexts: [
          { context: 'ctx-1', parent: null, url: 'about:blank', children: [], clientWindow: 'w1' },
          { context: 'ctx-2', parent: null, url: 'https://example.com', children: [], clientWindow: 'w1' }
        ] });
        break;
      case 'browsingContext.create': {
        const ctx = 'ctx-new-' + (++bidiSeed);
        sendResult({ context: ctx });
        sendEvent('browsingContext.contextCreated', { context: ctx, url: 'about:blank', children: [], parent: null });
        break;
      }
      case 'browsingContext.navigate': {
        const nav = 'nav-' + (++bidiSeed);
        sendResult({ navigation: nav, url: (msg.params && msg.params.url) || 'about:blank' });
        ['navigationStarted', 'domContentLoaded', 'load'].forEach(ev => {
          sendEvent('browsingContext.' + ev, { context: msg.params && msg.params.context, navigation: nav, url: msg.params && msg.params.url });
        });
        break;
      }
      case 'browsingContext.reload':
        sendResult({ navigation: 'nav-r' + (++bidiSeed) });
        sendEvent('browsingContext.navigationStarted', { context: msg.params && msg.params.context, navigation: 'nav-r' + (bidiSeed), url: msg.params && msg.params.url });
        break;
      case 'browsingContext.captureScreenshot':
        sendResult({ data: 'aGVsbG8tc25hcHNob3Q=' });
        break;
      case 'browsingContext.activate':
        sendResult({});
        break;
      case 'browsingContext.close':
        sendEvent('browsingContext.contextDestroyed', { context: msg.params && msg.params.context });
        sendResult({});
        break;
      case 'script.evaluate': {
        if (replyOverrides['script.evaluate']) {
          sendResult(replyOverrides['script.evaluate']);
          break;
        }
        const expr = (msg.params && msg.params.expression) || '';
        let result;
        if (expr.startsWith('(() => {')) {
          result = { type: 'string', value: JSON.stringify({
            nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', childNodeCount: 1, attributes: [],
            children: [{ nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'HTML', localName: 'html', childNodeCount: 0, attributes: [], children: [] }]
          }) };
        } else {
          result = { type: 'string', value: expr.substring(0, 40) };
        }
        // Real Firefox reply: msg.result = { type:'success', result:<RemoteValue>, realm }
        sendResult({ type: 'success', result, realm: 'realm-1' });
        break;
      }
      case 'script.callFunction':
        sendResult({ type: 'success', result: { type: 'number', value: 42 }, realm: 'realm-1' });
        break;
      case 'input.performActions':
        sendResult({});
        break;
      default:
        server.send(JSON.stringify({ id, type: 'error', error: { code: -32601, message: 'Method not found: ' + msg.method } }));
    }
  }, 5);
}

async function bootBidiEnv(relayPair) {
  const [, client, env] = relayPair || (await startRelay());
  env.BidiClient.connect(env.Config.defaultBidiUrl);
  const [bidiServer] = attachBidi(env);
  return [client, env, bidiServer];
}

function relayReply(clientWs, id) {
  return (clientWs._sent || []).find(m => m.id === id) || null;
}

function bidiCommands(clientWs, method) {
  return (clientWs._sent || []).filter(m => m.method === method);
}

// ---------------------------------------------------------------- tests

// 33. background.js startup resume — the description must survive an event-page
// suspension between the popup save and the relay handshake. Mirrors the Chrome
// harness (Chrome test 33) so the two extensions cannot drift on this path.
{
  const env = buildEnv();
  loadExtension(env);
  const listeners = { installed: [], startup: [], message: [], alarm: [] };
  env.chrome.runtime.onInstalled = { addListener: (f) => listeners.installed.push(f) };
  env.chrome.runtime.onStartup = { addListener: (f) => listeners.startup.push(f) };
  env.chrome.runtime.onMessage = { addListener: (f) => listeners.message.push(f) };
  env.chrome.alarms.onAlarm = { addListener: (f) => listeners.alarm.push(f) };

  await new Promise(res => env.Config.saveBrowserDescription('stale old text', res));
  await new Promise(res => env.Config.setPendingConnecting(
    'ws://relay', 'firefox-mac', 'the description typed before suspension', res));

  let booted = false;
  try {
    vm.runInContext(readFileSync(ROOT + 'background.js', 'utf8'), env, { filename: 'background.js' });
    booted = true;
  } catch (e) { report('33. background.js boots in the harness', false, e); }
  test('33. background.js boots in the harness', () => booted);
  test('33a. it registered a startup listener', () => listeners.startup.length === 1);

  for (const fn of listeners.startup) fn({});
  await sleep(60);

  const stored = await new Promise(res => env.Config.getBrowserDescription(res));
  test('33b. resume committed the pending description to storage', () =>
    stored === 'the description typed before suspension');

  const client = env.State.getWs();
  const server = client && new FakeWebSocket('ws://relay');
  if (client) { server.readyState = FakeWebSocket.OPEN; server.other = client; client.other = server; }
  const hello = client && client._sent.find(m => m.type === 'navigator-hello');
  test('33c. the resumed hello carries the pending description, not the stale one', () =>
    !!hello && hello.browserDescription === 'the description typed before suspension');
  const after = await new Promise(res => env.Config.getPendingConnecting(res));
  test('33d. the pending flag is consumed by the resume', () => after.pending === false);
}

// 34. An explicitly cleared description in the pending flag must not fall back
// to the stale stored value — "no owner description" is a meaningful choice.
{
  const env = buildEnv();
  loadExtension(env);
  await new Promise(res => env.Config.saveBrowserDescription('stale old text', res));
  await new Promise(res => env.Config.setPendingConnecting('ws://relay', 'firefox-mac', '', res));
  const restored = await new Promise(res => env.Config.getPendingConnecting(res));
  test('34. a pending clear keeps the empty string instead of the stale value', () =>
    restored.pending === true && restored.browserDescription === '');
}

console.log('Navigator Browser Relay — Firefox (BiDi) standalone unit tests\n');

// 1. modules load
{
  const env = buildEnv();
  try {
    loadExtension(env);
    test('1. All Firefox extension modules load (globals exposed)', () =>
      typeof env.routeCDPCommand === 'function' &&
      typeof env.BidiClient.connect === 'function' &&
      typeof env.Mapper.translateCommand === 'function' &&
      typeof env.CDPSessionManager.attachToTarget === 'function');
  } catch (e) { report('1. All Firefox extension modules load', false, e); }
}

// 2. Config storage round-trip (Firefox defaults)
{
  const env = buildEnv();
  loadExtension(env);
  await new Promise(resolve => {
    env.Config.getBrowserName(name => {
      env.Config.saveServerUrl('ws://x:1/relay', () => {
        env.Config.getServerUrl(u => resolve(
          name === 'Firefox' &&
          env.Config.defaultBidiUrl === 'ws://127.0.0.1:9222/session' &&
          u === 'ws://x:1/relay'));
      });
    });
  }).then(ok => report('2. Config round-trip + Firefox defaults', ok));
}

// 3. BiDi handshake: session.new -> subscribe
{
  const [client, env] = await bootBidiEnv();
  await sleep(80);
  const sent = env.BidiClient.getSocket()._sent;
  const handshake = sent.filter(m => m.method === 'session.new' || m.method === 'session.subscribe');
  test('3. BiDi session.new + subscribe handshake', () =>
    handshake.length === 2 &&
    handshake[0].method === 'session.new' &&
    handshake[1].method === 'session.subscribe' &&
    env.BidiClient.isConnected() &&
    env.BidiClient.getBrowserVersion() === '129.0');
}

// 4. relay connect sends navigator-hello
{
  const [server, client, env] = await startRelay();
  const hello = client._sent.find(m => m.type === 'navigator-hello');
  test('4. connect() sends navigator-hello with browserName', () =>
    !!hello && hello.browserName === 'Firefox' && !!hello.extensionVersion);
}

// 5. PIN round-trip
{
  const [server, client, env] = await startRelay();
  server.send(JSON.stringify({ type: 'pin_required' }));
  await sleep(30);
  env.ConnectionManager.send({ type: 'pin', pin: '123456' });
  await sleep(30);
  const pinMsg = client._sent.find(m => m.type === 'pin');
  server.send(JSON.stringify({ type: 'connected', sessionToken: 'tok-secret' }));
  await sleep(30);
  test('5. PIN round-trip: sends pin, stores session token', () =>
    !!pinMsg && pinMsg.pin === '123456' && env.State.getSessionToken() === 'tok-secret');
}

// 5a. Auth contract: isConnected() is the AUTH flag, not socket-open
{
  const env = buildEnv();
  loadExtension(env);
  env.State.setConnected(false);
  env.State.setConnecting(false);
  env.State.setPinRequired(true);
  // A bare socket-open must NOT report connected before auth round-trip
  const socketOpenButNotAuthed = env.State.isConnected();
  env.State.setConnected(true);
  const authed = env.State.isConnected();
  test('5a. isConnected() = auth flag, not socket-open', () =>
    socketOpenButNotAuthed === false && authed === true);
  env.State.setConnected(false);
}

// 5b. Auth contract: pending PIN stash / take
{
  const env = buildEnv();
  loadExtension(env);
  env.State.setPendingPin('654321');
  const took = env.State.takePendingPin();
  const afterTake = env.State.takePendingPin();
  test('5b. setPendingPin/takePendingPin stash and clear once', () =>
    took === '654321' && afterTake === null);
}

// 5c. Auth contract: pin_required auto-submits a pending PIN
{
  const [server, client, env] = await startRelay();
  env.State.setPendingPin('111222');
  server.send(JSON.stringify({ type: 'pin_required' }));
  await sleep(30);
  const autoPin = client._sent.find(m => m.type === 'pin');
  test('5c. pin_required auto-submits stashed PIN and clears it', () =>
    autoPin && autoPin.pin === '111222' && env.State.takePendingPin() === null);
}

// 5d. Auth contract: ConnectionManager.send returns false with no live socket
//     (this is the guard the background `send-pin` handler keys on to stash the PIN)
{
  const env = buildEnv();
  loadExtension(env);
  const sent = env.ConnectionManager.send({ type: 'pin', pin: '222333' });
  test('5d. ConnectionManager.send returns false with no live socket', () =>
    sent === false);
}

// 5e. Server-initiated forget (close code 4004) is NOT the PIN-expiry case:
//     the extension must drop its stored token and stop, with no reconnect
//     attempt — otherwise a forgotten browser reconnects with stale material
//     (plan 60 B2).
{
  const [server, client, env] = await startRelay();
  env.Config.saveSessionToken('tok-forgotten', () => {});
  env.State.setSessionToken('tok-forgotten');
  env.State.setConnected(true);
  await sleep(20);

  let reconnects = 0;
  const originalConnect = env.ConnectionManager.connect;
  env.ConnectionManager.connect = function() { reconnects++; return originalConnect.apply(this, arguments); };

  client.onclose({ code: 4004, reason: 'forget' });
  await sleep(40);

  test('5e. Forgot-browser (4004) clears token, no auto-reconnect, forgotten error', () =>
    env.State.getSessionToken() === null &&
    !env.State.isConnected() &&
    reconnects === 0 &&
    /forgotten/i.test(String(env.State.getLastError())));
}

// 5f. Server-initiated remove (close code 4005) is the tombstone case: the
//     name was removed from navigator and re-pairing stays rejected until it is
//     re-added in the console. Same handling as 4004, but the error says so
//     (plan 60 B6).
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

  test('5f. Removed-browser (4005) clears token, no auto-reconnect, removed error', () =>
    env.State.getSessionToken() === null &&
    !env.State.isConnected() &&
    reconnects === 0 &&
    /removed/i.test(String(env.State.getLastError())));
}

// 6. Browser.getVersion is Firefox-branded LOCAL
{
  const env = buildEnv();
  loadExtension(env);
  env.ConnectionManager.connect();
  await sleep(30);
  const client = env.State.getWs();
  const server = new FakeWebSocket('ws://relay');
  server.readyState = FakeWebSocket.OPEN;
  server.other = client; client.other = server;
  server.send(JSON.stringify({ id: 6, method: 'Browser.getVersion', params: {} }));
  await sleep(50);
  const reply = relayReply(client, 6);
  test('6. Browser.getVersion answered locally, Firefox-branded', () =>
    !!reply && reply.result && /Firefox/.test(reply.result.product) && !reply.error && reply.result.protocolVersion === '1.3');
}

// 7. Page.navigate -> browsingContext.navigate (translated + transformed)
{
  const [client, env] = await bootBidiEnv();
  await sleep(80);
  const sess = await env.CDPSessionManager.attachToTarget('ctx-1');
  await env.routeCDPCommand({ id: 7, method: 'Page.navigate', params: { url: 'https://example.com/foo' }, sessionId: sess.sessionId });
  await sleep(120);
  const navs = bidiCommands(env.BidiClient.getSocket(), 'browsingContext.navigate');
  const reply = relayReply(client, 7);
  test('7. Page.navigate translated to browsingContext.navigate', () =>
    !!navs.length &&
    navs[0].params.context === 'ctx-1' &&
    navs[0].params.url === 'https://example.com/foo' &&
    !!reply && reply.result && reply.result.frameId && reply.result.errorText === null && !reply.error);
}

// 8. Runtime.evaluate remote value -> CDP result
{
  const [client, env] = await bootBidiEnv();
  await sleep(80);
  const sess = await env.CDPSessionManager.attachToTarget('ctx-1');
  await env.routeCDPCommand({ id: 8, method: 'Runtime.evaluate', params: { expression: '1+1' }, sessionId: sess.sessionId });
  await sleep(120);
  const evals = bidiCommands(env.BidiClient.getSocket(), 'script.evaluate');
  const reply = relayReply(client, 8);
  test('8. Runtime.evaluate -> script.evaluate, remote value deserialized', () =>
    !!evals.length &&
    evals[0].params.target.context === 'ctx-1' &&
    evals[0].params.expression === '1+1' &&
    !!reply && reply.result && reply.result.result &&
    reply.result.result.type === 'string' && !reply.error);
}

// 9. Runtime.evaluate exception -> exceptionDetails (full routed path)
{
  const [client, env] = await bootBidiEnv();
  await sleep(80);
  const sess = await env.CDPSessionManager.attachToTarget('ctx-9');
  setBidiReply('script.evaluate', {
    type: 'exception',
    exceptionDetails: { text: 'boom', lineNumber: 1, columnNumber: 2, exception: { type: 'string', value: 'boom' } }
  });
  await env.routeCDPCommand({ id: 9, method: 'Runtime.evaluate', params: { expression: 'throw new Error("boom")' }, sessionId: sess.sessionId });
  await sleep(120);
  setBidiReply('script.evaluate', null);
  const reply = relayReply(client, 9);
  test('9. Runtime.evaluate exception maps to CDP exceptionDetails', () =>
    !!reply && reply.result && reply.result.exceptionDetails &&
    reply.result.exceptionDetails.text === 'boom' &&
    reply.result.exceptionDetails.exception.value === 'boom' &&
    reply.result.result.type === 'undefined' && !reply.error);
}

// 10. Target.createTarget -> browsingContext.create + navigate
{
  const env = buildEnv();
  loadExtension(env);
  const serverWs = new env.WebSocket('relay://');
  serverWs.readyState = env.WebSocket.OPEN;
  env.State.setWs(serverWs);
  env.BidiClient.connect(env.Config.defaultBidiUrl);
  attachBidi(env);
  await sleep(80);
  await env.routeCDPCommand({ id: 10, method: 'Target.createTarget', params: { url: 'https://example.com' }, sessionId: null });
  await sleep(120);
  const creates = bidiCommands(env.BidiClient.getSocket(), 'browsingContext.create');
  const navs = bidiCommands(env.BidiClient.getSocket(), 'browsingContext.navigate');
  const reply = serverWs._sent.find(m => m.id === 10);
  test('10. Target.createTarget -> browsingContext.create + navigate', () =>
    !!creates.length && creates[0].params.type === 'tab' &&
    !!navs.length && navs[0].params.url === 'https://example.com' && navs[0].params.context === reply.result.targetId &&
    !!reply && reply.result && /^ctx-new-/.test(reply.result.targetId));
}

// 11. BiDi events -> CDP events (load + detached via real contextDestroyed)
{
  const [client, env, bidiServer] = await bootBidiEnv();
  await sleep(80);
  const sess = await env.CDPSessionManager.attachToTarget('ctx-1');
  const sid = sess.sessionId;
  await env.routeCDPCommand({ id: 11, method: 'Page.navigate', params: { url: 'https://example.com/foo' }, sessionId: sid });
  await sleep(150);
  const loads = client._sent.filter(m => m.type === 'cdp_event' && m.method === 'Page.loadEventFired');
  // A real contextDestroyed event from the BiDi side -> Target.detachedFromTarget
  bidiServer.send(JSON.stringify({ method: 'browsingContext.contextDestroyed', type: 'event', params: { context: 'ctx-1' } }));
  await sleep(80);
  const detaches = client._sent.filter(m => m.type === 'cdp_event' && m.method === 'Target.detachedFromTarget');
  test('11. BiDi load + contextDestroyed -> CDP events with session', () =>
    loads.length === 1 && loads[0].sessionId === sid &&
    detaches.length === 1 && detaches[0].sessionId === sid && detaches[0].params.sessionId === sid);
}

// 12. unmapped CDP method -> -32601 UnsupportedOperation
{
  const [client, env] = await bootBidiEnv();
  await sleep(80);
  const sess = await env.CDPSessionManager.attachToTarget('ctx-1');
  await env.routeCDPCommand({ id: 12, method: 'Emulation.setDeviceMetricsOverride', params: {}, sessionId: sess.sessionId });
  await sleep(100);
  const reply = relayReply(client, 12);
  test('12. Unmapped CDP method errors with -32601', () =>
    !!reply && reply.error && reply.error.code === -32601 && /UnsupportedOperation/.test(reply.error.message));
}

// 13. remote-value deserializer (pure)
{
  const env = buildEnv();
  loadExtension(env);
  const R = env.RuntimeResult;
  const arr = R.deserialize({ type: 'array', value: [
    { type: 'string', value: 'a' },
    { type: 'number', value: 2 },
    { type: 'object', value: [['k', { type: 'boolean', value: true }]] }
  ] });
  const cdpRem = R.toCdp({ type: 'object', value: [['a', { type: 'number', value: 1 }]] });
  // map/set must NOT recurse into toCdp (regression: used to stack-overflow)
  const cdpMap = R.toCdp({ type: 'map', value: [['k', { type: 'number', value: 7 }]] });
  test('13. remote-value deserialization + CDP shapes (incl. map)', () =>
    JSON.stringify(arr) === '["a",2,{"k":true}]' &&
    cdpRem.type === 'object' && cdpRem.value.a === 1 &&
    cdpMap.type === 'object' && cdpMap.subtype === 'map' && cdpMap.value.k === 7);
}

// 14. Input.dispatchMouseEvent -> input.performActions pointer chain
{
  const [client, env] = await bootBidiEnv();
  await sleep(80);
  const sess = await env.CDPSessionManager.attachToTarget('ctx-1');
  await env.routeCDPCommand({ id: 14, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 }, sessionId: sess.sessionId });
  await sleep(120);
  const acts = bidiCommands(env.BidiClient.getSocket(), 'input.performActions');
  test('14. mousePressed maps to pointer performActions', () =>
    !!acts.length &&
    acts[0].params.actions[0].type === 'pointer' &&
    acts[0].params.actions[0].parameters.pointerType === 'mouse' &&
    acts[0].params.actions[0].actions.some(a => a.type === 'pointerDown'));
}

// 15. session token included on reconnect
{
  const env = buildEnv();
  loadExtension(env);
  env.Config.saveServerUrl('ws://relay', () => {});
  env.Config.saveSessionToken('tok-stored', () => {});
  env.ConnectionManager.connect();
  await sleep(30);
  const client = env.State.getWs();
  const server = new FakeWebSocket('ws://relay');
  server.readyState = FakeWebSocket.OPEN;
  server.other = client; client.other = server;
  const hello = client._sent.find(m => m.type === 'navigator-hello');
  test('15. Session token reused on reconnect', () => !!hello && hello.sessionToken === 'tok-stored');
}

// 16. TabList over tabs.query (no chrome.debugger.getTargets)
{
  const env = buildEnv();
  loadExtension(env);
  const targets = await new Promise(res => env.TabList.getAllAsTargets(t => res(t)));
  const info = await env.TabList.getTargetInfoById('tab-1');
  test('16. TabList returns tab targets', () =>
    Array.isArray(targets) && targets.length >= 2 &&
    targets.some(t => t.tabId === 1 && t.url === 'https://example.com') &&
    !!info && info.targetId === 'tab-1');
}

// 17. BidiUrl persisted after session.new (auto-remember)
{
  const env = buildEnv();
  loadExtension(env);
  env.State.clearBidiError();
  env.BidiClient.connect(env.Config.defaultBidiUrl);
  attachBidi(env, 'ws://127.0.0.1:9222/session');
  await sleep(80);
  test('17. Bidi session established -> isConnected + bidiUrl remembered', () =>
    env.BidiClient.isConnected() &&
    env.State.isBidiConnected() === true &&
    env.State.getBidiUrl() === 'ws://127.0.0.1:9222/session');
}

// 18. Durable "connecting intent" flag survives a simulated event-page
// suspension (fresh extension context rebuilt from the SAME storage).
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

  // "User clicks Connect then the popup closes / background suspends mid-connect"
  env1.Config.setPendingConnecting('10.69.1.164:1994', 'Firefox', () => {});

  const pending = await new Promise(res => env2.Config.getPendingConnecting(x => res(x)));
  test('18. Pending-connecting flag survives suspension (storage-backed)', () =>
    pending.pending === true &&
    pending.serverUrl === '10.69.1.164:1994' &&
    pending.browserName === 'Firefox');

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
  env.Config.setPendingConnecting('ws://relay', 'Firefox', () => {});
  env.ConnectionManager.disconnect();
  const after = await new Promise(res => env.Config.getPendingConnecting(x => res(x)));
  test('19. disconnect clears the pending-connecting flag', () => after.pending === false);
}

// 31. Browser description (plan 45) — storage, hello carriage, live update.
{
  const chrome = makeChromeMock();
  const env = buildEnvFromChrome(chrome);
  loadExtension(env);

  // 21a. Storage round-trips, defaulting to "".
  const empty = await new Promise(res => env.Config.getBrowserDescription(x => res(x)));
  test('31a. browserDescription defaults to empty string', () => empty === '');

  await new Promise(res => env.Config.saveBrowserDescription("my daily driver for gmail", res));
  const stored = await new Promise(res => env.Config.getBrowserDescription(x => res(x)));
  test('31b. browserDescription round-trips through storage.local', () =>
    stored === 'my daily driver for gmail');

  // 21c. The hello carries it, so a navigator that restarted still learns it.
  env.Config.saveServerUrl('10.69.1.164:1994', () => {});
  env.ConnectionManager.connect();
  await sleep(30);
  const [, client] = wireRelay(env, '10.69.1.164:1994');
  const hello = client._sent.find(m => m.type === 'navigator-hello');
  test('31c. navigator-hello carries browserDescription', () =>
    !!hello && hello.browserDescription === 'my daily driver for gmail' && hello.platform === 'firefox');

  // 21d. The extension gates the live update on the SOCKET, not on auth — the
  //      server enforces auth (and rejects pre-auth updates; see
  //      tests/relay-server.test.js). A value edited while merely socket-open
  //      is still sent; the server decides.
  const before = client._sent.filter(m => m.type === 'update_description').length;
  await new Promise(res => env.ConnectionManager.updateDescription('edited', res));
  const sentCount = client._sent.filter(m => m.type === 'update_description').length;
  test('31d. updateDescription is sent whenever the socket is open', () =>
    sentCount === before + 1);

  // 21e. With NO socket at all, nothing is sent but the value still persists,
  //      so it rides the next hello instead.
  env.ConnectionManager.disconnect();
  const afterDisconnect = client._sent.filter(m => m.type === 'update_description').length;
  await new Promise(res => env.ConnectionManager.updateDescription('while fully offline', res));
  const offlineStored = await new Promise(res => env.Config.getBrowserDescription(x => res(x)));
  test('31e. disconnected: no frame sent, but the value is stored for the next hello', () =>
    client._sent.filter(m => m.type === 'update_description').length === afterDisconnect &&
    offlineStored === 'while fully offline');
}

// 32. Live update over an authenticated, already-connected channel.
{
  const chrome = makeChromeMock();
  const env = buildEnvFromChrome(chrome);
  loadExtension(env);
  await new Promise(res => env.Config.saveBrowserDescription('first take', res));
  env.Config.saveServerUrl('10.69.1.164:1994', () => {});
  env.ConnectionManager.connect();
  await sleep(30);
  const [, client] = wireRelay(env, '10.69.1.164:1994');
  client.other.send(JSON.stringify({ type: 'connected', sessionToken: 'tok-live' }));
  await sleep(40);
  test('37a. connected before the live update', () => env.State.isConnected());

  const res = await new Promise(r => env.ConnectionManager.updateDescription('second take', r));
  const sent = client._sent.find(m => m.type === 'update_description');
  test('37b. updateDescription sends update_description while connected', () =>
    res.success === true && !!sent && sent.description === 'second take');

  // The local copy is authoritative for the next hello too.
  const persisted = await new Promise(r => env.Config.getBrowserDescription(x => r(x)));
  test('37c. updateDescription also persists locally', () => persisted === 'second take');
}

// 33. The pending-connecting flag carries the description so a popup that
//     reopens mid-connect restores what the user typed.
{
  const chrome = makeChromeMock();
  const env = buildEnvFromChrome(chrome);
  loadExtension(env);
  env.Config.setPendingConnecting('10.69.1.164:1994', 'Firefox', 'restored description', () => {});
  const pending = await new Promise(res => env.Config.getPendingConnecting(x => res(x)));
  test('35. pending-connecting carries browserDescription across event-page suspend', () =>
    pending.pending === true && pending.browserDescription === 'restored description');

  // 3-arg legacy form (older caller passing a callback) must still work.
  env.Config.setPendingConnecting('10.69.1.164:1994', 'Firefox', () => {});
  const legacy = await new Promise(res => env.Config.getPendingConnecting(x => res(x)));
  test('35b. 3-arg setPendingConnecting (callback 3rd) stays back-compatible', () =>
    legacy.browserName === 'Firefox' && legacy.browserDescription === '');
}

// 34. Emptying the field is a real edit, not a no-op. The server treats an
//     ABSENT browserDescription as "old extension, keep what's stored" (see
//     tests/relay-server.test.js), so the hello must carry an explicit "" to
//     clear it. Gating the field on truthiness would strand the old value for
//     anyone who empties it while offline.
{
  const chrome = makeChromeMock();
  const env = buildEnvFromChrome(chrome);
  loadExtension(env);
  await new Promise(res => env.Config.saveBrowserDescription('to be removed', res));
  env.Config.saveServerUrl('10.69.1.164:1994', () => {});
  env.ConnectionManager.connect();
  await sleep(30);
  const [, client] = wireRelay(env, '10.69.1.164:1994');
  const before = client._sent.find(m => m.type === 'navigator-hello');
  test('31a. hello carries the saved description first', () =>
    !!before && before.browserDescription === 'to be removed');

  // User empties the field while disconnected, then reconnects.
  env.ConnectionManager.disconnect();
  await new Promise(res => env.Config.saveBrowserDescription('', res));
  env.ConnectionManager.connect();
  await sleep(30);
  const [, client2] = wireRelay(env, '10.69.1.164:1994');
  const cleared = client2._sent.find(m => m.type === 'navigator-hello');
  test('31b. empty description is sent explicitly so the server clears it', () =>
    !!cleared && cleared.browserDescription === '');
}

// 20. Probe — reachability diagnostics (parse + fetch-backed HTTP probe)
{
  const chrome = makeChromeMock();
  const sandbox = {
    chrome, console,
    WebSocket: FakeWebSocket,
    navigator: { userAgent: 'Mozilla/5.0' },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Promise, String, Number, Array, Object, Map, Set,
    parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    requestAnimationFrame: () => {},
    AbortController: globalThis.AbortController,
    fetch: (url, opts) => {
      const u = String(url);
      if (u.indexOf('https://10.0.0.5:1994/health') === 0) return Promise.resolve({ status: 200, text: () => Promise.resolve('{"ok":true}') });
      if (u.indexOf('http://10.0.0.5:1994/health') === 0) return Promise.resolve({ status: 200, text: () => Promise.resolve('{"ok":true}') });
      if (u.indexOf('https://10.0.0.6:1994/health') === 0) return Promise.reject(new Error('Failed to fetch: connection refused at 10.0.0.6:1994'));
      if (u.indexOf('http://10.0.0.6:1994/health') === 0) return Promise.reject(new Error('Failed to fetch: connection refused at 10.0.0.6:1994'));
      if (u.indexOf('https://fail.dns.test:1994/health') === 0) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.reject(new Error('Failed to fetch'));
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox._ctx = vm.createContext(sandbox);
  loadExtension(sandbox);

  const P = () => sandbox.Probe;

  test('20a. parseHostPort defaults missing port to 1994', () =>
    P().parseHostPort('10.0.0.5') === '10.0.0.5:1994');

  test('20b. parseHostPort strips scheme + trailing slash', () =>
    P().parseHostPort('https://10.0.0.5:1994/relay') === '10.0.0.5:1994');

  test('20c. probe returns ok on reachable host', async () => {
    const r = await sandbox.Probe.probe('10.0.0.5:1994');
    return r.ok === true && r.status === 200 && r.mode === 'http';
  });

  test('20d. probe reports refused after both schemes fail', async () => {
    const r = await sandbox.Probe.probe('10.0.0.6:1994');
    return r.ok === false && r.mode === 'refused';
  });

  test('20e. probe reports dns on failed resolution', async () => {
    const r = await sandbox.Probe.probe('fail.dns.test:1994');
    return r.ok === false && r.mode === 'dns';
  });
}

// 21. Browser window commands resolve REAL window geometry via
//     CDPSessionManager.resolveContext + chrome.tabs.get + chrome.windows
//     (not the old hardcoded 1920x1080 stub).
{
  const env = buildEnv();
  loadExtension(env);
  env.CDPSessionManager.addContextMapping('ctx-window', 5);
  let updated = null;
  env.chrome.tabs.get = (id, cb) => cb({ id, title: 'T', url: 'https://x.test', windowId: 3 });
  env.chrome.windows.update = (id, opts, cb) => {
    updated = { id, opts };
    cb({ id, left: 0, top: 0, width: opts.width || 1920, height: opts.height || 1080, state: opts.state || 'normal', focused: !!opts.focused });
  };
  const out = [];
  const run = (id, method, params) => env.routeCDPCommand({ id, method, params, sessionId: null }).then(r => out.push(r));
  await run(21, 'Browser.getWindowForTarget', { targetId: 'ctx-window' });
  await run(22, 'Browser.setWindowBounds', { targetId: 'ctx-window', bounds: { height: 760, windowState: 'minimized' } });
  await sleep(80);

  const got = (out[0] && (out[0].result || out[0].error)) || {};
  const setRes = (out[1] && (out[1].result || {})) || {};
  const okGet = got.windowId === 3 && got.bounds && got.bounds.width === 1920 && got.bounds.windowState === 'normal';
  const okSet = updated && updated.id === 3 && updated.opts.height === 760 && updated.opts.state === 'minimized';
  const okBounds = setRes.bounds && setRes.bounds.windowState === 'minimized';
  test('21. Firefox window commands resolve real window geometry', () => okGet && okSet && okBounds);
}

// 22-27. "Open windows instead of tabs" (plan 56) — Firefox window mode.
// Flag ON forces browsingContext.create type:'window'; window-created
// contexts are never tab-hidden. Context handlers return real window-<ts>
// ids under the flag, mock otherwise.

// 22. flag ON -> browsingContext.create gets type:'window'
{
  const env = buildEnv();
  loadExtension(env);
  env.Config.setOpenInWindow(true, () => {});
  const serverWs = new env.WebSocket('relay://');
  serverWs.readyState = env.WebSocket.OPEN;
  env.State.setWs(serverWs);
  env.BidiClient.connect(env.Config.defaultBidiUrl);
  attachBidi(env);
  await sleep(80);
  await env.routeCDPCommand({ id: 22, method: 'Target.createTarget', params: { url: 'https://example.com' }, sessionId: null });
  await sleep(120);
  const creates = bidiCommands(env.BidiClient.getSocket(), 'browsingContext.create');
  test('22. flag ON -> createTarget creates a window context', () =>
    !!creates.length && creates[0].params.type === 'window');
}

// 23. flag OFF -> tab (today's behavior); newWindow still forces a window
{
  const env = buildEnv();
  loadExtension(env);
  env.Config.setOpenInWindow(false, () => {});
  const serverWs = new env.WebSocket('relay://');
  serverWs.readyState = env.WebSocket.OPEN;
  env.State.setWs(serverWs);
  env.BidiClient.connect(env.Config.defaultBidiUrl);
  attachBidi(env);
  await sleep(80);
  await env.routeCDPCommand({ id: 23, method: 'Target.createTarget', params: { url: 'https://example.com' }, sessionId: null });
  await sleep(120);
  const tabCreates = bidiCommands(env.BidiClient.getSocket(), 'browsingContext.create');
  await env.routeCDPCommand({ id: 231, method: 'Target.createTarget', params: { url: 'https://example.com', newWindow: true }, sessionId: null });
  await sleep(120);
  const winCreates = bidiCommands(env.BidiClient.getSocket(), 'browsingContext.create');
  test('23. flag OFF -> tab; explicit newWindow still -> window', () =>
    tabCreates.length === 1 && tabCreates[0].params.type === 'tab' &&
    winCreates.length === 2 && winCreates[1].params.type === 'window');
}

// 24. A non-default browserContextId on createTarget forces a window too
{
  const env = buildEnv();
  loadExtension(env);
  env.Config.setOpenInWindow(false, () => {});
  const serverWs = new env.WebSocket('relay://');
  serverWs.readyState = env.WebSocket.OPEN;
  env.State.setWs(serverWs);
  env.BidiClient.connect(env.Config.defaultBidiUrl);
  attachBidi(env);
  await sleep(80);
  await env.routeCDPCommand({ id: 24, method: 'Target.createTarget', params: { url: 'https://example.com', browserContextId: 'window-lazy-1' }, sessionId: null });
  await sleep(120);
  const creates = bidiCommands(env.BidiClient.getSocket(), 'browsingContext.create');
  test('24. non-default browserContextId -> window context', () =>
    creates.length === 1 && creates[0].params.type === 'window');
}

// 25. Window-created contexts are never tab-hidden; plain ones still are
{
  const env = buildEnv();
  loadExtension(env);
  const hidden = [];
  env.chrome.tabs.hide = (ids, cb) => { hidden.push(ids); cb && cb(); };
  env.CDPSessionManager.noteContextCreated('ctx-win-1', { window: true });
  env.CDPSessionManager.noteContextCreated('ctx-tab-1');
  env.CDPSessionManager.handleTabCreated({ id: 30 }); // pairs ctx-win-1
  env.CDPSessionManager.handleTabCreated({ id: 31 }); // pairs ctx-tab-1
  test('25. window contexts skip TabIsolation.isolate', () =>
    hidden.length === 1 && JSON.stringify(hidden[0]) === '[31]' &&
    env.CDPSessionManager.isWindowContext('ctx-win-1') === true &&
    env.CDPSessionManager.isWindowContext('ctx-tab-1') === false);
}

// 26. Context handlers: flag ON real window-<ts> contexts, flag OFF mock
{
  const env = buildEnv();
  loadExtension(env);
  env.Config.setOpenInWindow(true, () => {});
  const r1 = await env.routeCDPCommand({ id: 26, method: 'Target.createBrowserContext', params: {}, sessionId: null });
  const r2 = await env.routeCDPCommand({ id: 261, method: 'Target.getBrowserContexts', params: {}, sessionId: null });
  const ctx1 = r1 && r1.result && r1.result.browserContextId;
  const okOn = !!ctx1 && /^window-/.test(ctx1) && !r1.result._mock &&
    r2.result.browserContextIds.join() === 'default,' + ctx1;
  await env.routeCDPCommand({ id: 262, method: 'Target.disposeBrowserContext', params: { browserContextId: ctx1 }, sessionId: null });
  const r4 = await env.routeCDPCommand({ id: 263, method: 'Target.getBrowserContexts', params: {}, sessionId: null });
  test('26. flag ON -> window context listed; dispose drops it', () =>
    okOn && r4.result.browserContextIds.join() === 'default');
}

// 27. Context handlers: flag OFF keeps exactly today's mock
{
  const env = buildEnv();
  loadExtension(env);
  env.Config.setOpenInWindow(false, () => {});
  const r1 = await env.routeCDPCommand({ id: 27, method: 'Target.createBrowserContext', params: {}, sessionId: null });
  const r2 = await env.routeCDPCommand({ id: 271, method: 'Target.getBrowserContexts', params: {}, sessionId: null });
  test('27. flag OFF -> contexts stay mock', () =>
    !!r1.result.browserContextId && /^context-/.test(r1.result.browserContextId) &&
    !!r1.result._mock && r2.result.browserContextIds.join() === 'default');
}

// 28. TabList reports the real windowId + window-<id> context for a
//     window-created tab, 'default' otherwise (tab-list threads the tab).
{
  const env = buildEnv();
  loadExtension(env);
  env.CDPSessionManager.noteContextCreated('ctx-win-real', { window: true });
  env.CDPSessionManager.addContextMapping('ctx-win-real', 40);
  env.CDPSessionManager.addContextMapping('ctx-plain-real', 41);
  env.chrome.tabs.query = (opts, cb) => cb([
    { id: 40, title: 'Win', url: 'https://win.test', active: false, windowId: 9, index: 0 },
    { id: 41, title: 'Plain', url: 'https://plain.test', active: false, windowId: 1, index: 1 }
  ]);
  const targets = await new Promise(res => env.TabList.getAllAsTargets(t => res(t)));
  const win = targets.find(t => t.tabId === 40);
  const plain = targets.find(t => t.tabId === 41);
  test('28. TabList: window target emits windowId + window-<id> context', () =>
    !!win && win.browserContextId === 'window-9' && win.windowId === 9 &&
    !!plain && plain.browserContextId === 'default' && plain.windowId === 1);
}

// 29. The real puppeteer multi-context flow: createBrowserContext returns a
//     lazy window-<ts> id, the next createTarget carrying it opens that window
//     (browsingContext.create type:'window' + navigate), the context stays
//     listed until disposeBrowserContext drops it.
{
  const env = buildEnv();
  loadExtension(env);
  env.Config.setOpenInWindow(true, () => {});
  const serverWs = new env.WebSocket('relay://');
  serverWs.readyState = env.WebSocket.OPEN;
  env.State.setWs(serverWs);
  env.BidiClient.connect(env.Config.defaultBidiUrl);
  attachBidi(env);
  await sleep(80);

  const r1 = await env.routeCDPCommand({ id: 29, method: 'Target.createBrowserContext', params: {}, sessionId: null });
  const ctx = r1 && r1.result && r1.result.browserContextId;
  await env.routeCDPCommand({ id: 291, method: 'Target.createTarget', params: { url: 'https://example.com', browserContextId: ctx }, sessionId: null });
  await sleep(120);
  const creates = bidiCommands(env.BidiClient.getSocket(), 'browsingContext.create');
  const navigates = bidiCommands(env.BidiClient.getSocket(), 'browsingContext.navigate');
  const r2 = await env.routeCDPCommand({ id: 292, method: 'Target.getBrowserContexts', params: {}, sessionId: null });
  await env.routeCDPCommand({ id: 293, method: 'Target.disposeBrowserContext', params: { browserContextId: ctx }, sessionId: null });
  const r3 = await env.routeCDPCommand({ id: 294, method: 'Target.getBrowserContexts', params: {}, sessionId: null });
  test('29. context.newPage flow: window-<id> forces type:window, listed until dispose', () =>
    !!ctx && /^window-/.test(ctx) && !r1.result._mock &&
    creates.length === 1 && creates[0].params.type === 'window' &&
    navigates.length === 1 &&
    r2.result.browserContextIds.join() === 'default,' + ctx &&
    r3.result.browserContextIds.join() === 'default');
}

// 30. A window-mode-created target activates (browsingContext.activate) and
//     closes (browsingContext.close) via its own BiDi window context.
{
  const env = buildEnv();
  loadExtension(env);
  env.Config.setOpenInWindow(true, () => {});
  const serverWs = new env.WebSocket('relay://');
  serverWs.readyState = env.WebSocket.OPEN;
  env.State.setWs(serverWs);
  env.BidiClient.connect(env.Config.defaultBidiUrl);
  attachBidi(env);
  await sleep(80);

  const c1 = await env.routeCDPCommand({ id: 30, method: 'Target.createTarget', params: { url: 'about:blank' }, sessionId: null });
  await sleep(100);
  const targetId = c1 && c1.result && c1.result.targetId;
  await env.routeCDPCommand({ id: 301, method: 'Target.activateTarget', params: { targetId }, sessionId: null });
  await sleep(60);
  await env.routeCDPCommand({ id: 302, method: 'Target.closeTarget', params: { targetId }, sessionId: null });
  await sleep(60);
  const socket = env.BidiClient.getSocket();
  const activates = bidiCommands(socket, 'browsingContext.activate');
  const closes = bidiCommands(socket, 'browsingContext.close');
  test('30. activate/close on a window target hit browsingContext.activate/close', () =>
    !!targetId && activates.length === 1 && activates[0].params.context === targetId &&
    closes.length === 1 && closes[0].params.context === targetId && closes[0].params.promptUnload === false);
}

// 59. discoverContextForTab must never guess. A guessed context binding is
//     PERSISTED, so the agent would silently drive a different tab than the one
//     the target names — for the rest of the session. It used to fall back to
//     "first free top-level context" whenever the URL filter came up empty or
//     ambiguous, which is exactly the two-tabs-on-the-same-URL case.
{
  const env = buildEnv();
  loadExtension(env);
  env.BidiClient.connect(env.Config.defaultBidiUrl);
  attachBidi(env);
  await sleep(80); // the fake socket only answers after the event loop settles
  const SM = env.CDPSessionManager;

  // Guard against a vacuous block: if getTree never round-trips, every
  // "returns null" assertion below would pass for the wrong reason.
  const tree = await env.BidiClient.send('browsingContext.getTree', {});
  const treeLive = !!(tree && Array.isArray(tree.contexts) && tree.contexts.length === 2);
  test('59z. the fake getTree round-trips (block is not vacuous)', () => treeLive);

  // The fake getTree above serves ctx-1=about:blank, ctx-2=example.com.
  // No URL match at all -> must return null instead of grabbing ctx-1.
  const noMatch = await SM.discoverContextForTab({ id: 90, url: 'https://elsewhere.test/page' });
  test('59a. no URL match resolves to null, never a guessed context', () =>
    noMatch === null && SM.contextIdForTab(90) === null);

  // Two contexts on the same URL -> ambiguous -> refuse to bind either.
  env.BidiClient.send = async () => ({
    contexts: [
      { context: 'ctx-dup-1', parent: null, url: 'https://dup.test', children: [] },
      { context: 'ctx-dup-2', parent: null, url: 'https://dup.test', children: [] }
    ]
  });
  const ambiguous = await SM.discoverContextForTab({ id: 91, url: 'https://dup.test' });
  test('59b. ambiguous same-URL match is refused, nothing is bound', () =>
    ambiguous === null && SM.contextIdForTab(91) === null);

  // A missing tab URL gives no correlation evidence at all.
  env.BidiClient.send = async () => ({
    contexts: [{ context: 'ctx-x', parent: null, url: 'https://a.test', children: [] }]
  });
  const noUrl = await SM.discoverContextForTab({ id: 92, url: '' });
  test('59c. tab without a URL is never bound to a context', () =>
    noUrl === null && SM.contextIdForTab(92) === null);

  // The happy path still works: one unique free match binds.
  env.BidiClient.send = async () => ({
    contexts: [
      { context: 'ctx-ok-1', parent: null, url: 'https://one.test', children: [] },
      { context: 'ctx-ok-2', parent: null, url: 'https://two.test', children: [] }
    ]
  });
  const unique = await SM.discoverContextForTab({ id: 93, url: 'https://two.test' });
  test('59d. a unique unclaimed URL match still binds', () =>
    unique === 'ctx-ok-2' && SM.contextIdForTab(93) === 'ctx-ok-2' && SM.tabIdForContext('ctx-ok-2') === 93);

  // Once claimed, the same URL cannot be stolen by a second tab.
  env.BidiClient.send = async () => ({
    contexts: [{ context: 'ctx-ok-2', parent: null, url: 'https://two.test', children: [] }]
  });
  const steal = await SM.discoverContextForTab({ id: 94, url: 'https://two.test' });
  test('59e. an already-claimed context is never re-bound to another tab', () =>
    steal === null && SM.tabIdForContext('ctx-ok-2') === 93 && SM.contextIdForTab(94) === null);

  // Fragments are ignored when correlating (same document, different #hash).
  env.BidiClient.send = async () => ({
    contexts: [{ context: 'ctx-frag', parent: null, url: 'https://frag.test/page', children: [] }]
  });
  const frag = await SM.discoverContextForTab({ id: 95, url: 'https://frag.test/page#section-2' });
  test('59f. a fragment-only URL difference still correlates', () =>
    frag === 'ctx-frag' && SM.contextIdForTab(95) === 'ctx-frag');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
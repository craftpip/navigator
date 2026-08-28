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
      remove: (id, cb) => cb && cb(),
      update: (id, opts, cb) => cb && cb()
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
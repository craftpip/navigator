#!/usr/bin/env node
/**
 * Mock BiDi server — simulates Firefox's Remote Agent WebDriver BiDi endpoint,
 * so the extension can be tested standalone (no real Firefox needed).
 *
 * Implements the protocol dance the extension performs:
 *   1. extension connects to ws://127.0.0.1:<port>/session
 *   2. sends session.new            -> success with browserVersion
 *   3. sends session.subscribe      -> success
 *   4. sends browsingContext.* / script.* / input.* commands -> logged + echoed
 *   navigate/load also emits browsingContext.load + domContentLoaded events
 *   so the CDP event mapping can be observed in the mock-relay log.
 *
 * Usage:
 *   node test/mock-bidi-server.mjs [port]
 *     (default 9223 — pair with the extension's BiDi URL field)
 */
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

const port = parseInt(process.argv[2] || '9223', 10);
const server = createServer();
const wss = new WebSocketServer({ server });

let ctxSeq = 0;
let navSeq = 0;

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function reply(ws, id, result) {
  send(ws, { id, type: 'success', result });
  console.log(`  [bidi] → result  id=${id} ${JSON.stringify(result).substring(0, 120)}`);
}

function errorReply(ws, id, code, message) {
  send(ws, { id, type: 'error', error: { code, message } });
  console.log(`  [bidi] → error   id=${id} ${message}`);
}

function handleCommand(ws, msg) {
  const { id, method, params } = msg;
  console.log(`  ${method}(${JSON.stringify(params || {}).substring(0, 160)})`);

  switch (method) {
    case 'session.new':
      reply(ws, id, {
        sessionId: 'mock-bidi-session-' + Date.now(),
        capabilities: {
          browserName: 'firefox',
          browserVersion: '129.0',
          acceptInsecureCerts: false,
          setWindowRect: true,
          webSocketUrl: 'ws://127.0.0.1:' + port + '/session'
        }
      });
      break;

    case 'session.subscribe':
      reply(ws, id, { subscribed: (params && params.events) || [] });
      break;

    case 'session.unsubscribe':
      reply(ws, id, {});
      break;

    case 'browsingContext.getTree':
      reply(ws, id, {
        contexts: [
          {
            context: 'ctx-1',
            parent: null,
            url: 'about:blank',
            children: [],
            clientWindow: 'win-1'
          },
          {
            context: 'ctx-2',
            parent: null,
            url: 'https://example.com',
            children: [],
            clientWindow: 'win-1'
          }
        ]
      });
      break;

    case 'browsingContext.create': {
      const contextId = 'ctx-new-' + (++ctxSeq);
      reply(ws, id, { context: contextId });
      // Emit contextCreated so the event mapping is observable
      send(ws, {
        method: 'browsingContext.contextCreated',
        type: 'event',
        params: { context: contextId, url: 'about:blank', children: [], parent: null }
      });
      console.log('  → event browsingContext.contextCreated', contextId);
      break;
    }

    case 'browsingContext.navigate':
      ++navSeq;
      reply(ws, id, { navigation: 'nav-' + navSeq, url: (params && params.url) || 'about:blank' });
      // Emit a load dance so CDP event mapping shows up end-to-end
      send(ws, {
        method: 'browsingContext.navigationStarted', type: 'event',
        params: { context: params && params.context, navigation: 'nav-' + navSeq, url: (params && params.url) || 'about:blank', timestamp: Date.now() }
      });
      send(ws, {
        method: 'browsingContext.domContentLoaded', type: 'event',
        params: { context: params && params.context, navigation: 'nav-' + navSeq, url: (params && params.url) || 'about:blank', timestamp: Date.now() }
      });
      send(ws, {
        method: 'browsingContext.load', type: 'event',
        params: { context: params && params.context, navigation: 'nav-' + navSeq, url: (params && params.url) || 'about:blank', timestamp: Date.now() }
      });
      console.log('  → events navigationStarted/domContentLoaded/load');
      break;

    case 'browsingContext.reload':
      reply(ws, id, { navigation: 'nav-r' + (++navSeq), url: (params && params.url) || 'about:blank' });
      break;

    case 'browsingContext.captureScreenshot':
      reply(ws, id, { data: 'aGVsbG8tc25hcHNob3Q=' }); // base64 of "hello-snapshot"
      break;

    case 'browsingContext.activate':
      reply(ws, id, {});
      break;

    case 'browsingContext.close':
      send(ws, {
        method: 'browsingContext.contextDestroyed', type: 'event',
        params: { context: params && params.context }
      });
      console.log('  → event browsingContext.contextDestroyed');
      reply(ws, id, {});
      break;

    case 'script.evaluate':
      // Echo a deterministic remote value so deserialization is observable
      reply(ws, id, {
        type: 'success',
        result: { type: 'string', value: String((params && params.expression) || '').substring(0, 40) },
        realm: 'realm-1'
      });
      break;

    case 'script.callFunction':
      reply(ws, id, {
        type: 'success',
        result: { type: 'number', value: 42 },
        realm: 'realm-1'
      });
      break;

    case 'input.performActions':
      reply(ws, id, {});
      break;

    default:
      errorReply(ws, id, -32601, `Method not found: ${method}`);
  }
}

wss.on('connection', (ws, req) => {
  console.log(`\n[bidi] Connection opened (origin: ${req.headers.origin || 'none'})`);
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    console.log(`[bidi] ← id=${msg.id} method=${msg.method}`);
    if (msg.id != null && typeof msg.method === 'string') {
      handleCommand(ws, msg);
    }
  });
  ws.on('close', () => console.log('[bidi] Connection closed'));
});

server.listen(port, () => {
  console.log(`\n[mock-bidi] Firefox Remote Agent (BiDi) simulator on ws://127.0.0.1:${port}/session`);
  console.log('Set the extension popup BiDi URL to this address and hit Connect.');
  console.log('');
});
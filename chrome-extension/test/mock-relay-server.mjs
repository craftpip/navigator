#!/usr/bin/env node
/**
 * Mock Navigator Relay server — simulates what navigator's /relay endpoint
 * will do during Phase 3, so the extension can be tested standalone now.
 *
 * Protocol implemented (mirrors plan §6 + the extension's expected flow):
 *   1. extension connects and sends  { type: 'navigator-hello', browserName, extensionVersion, sessionToken? }
 *   2. no valid token  -> server generates PIN, prints to console, sends { type: 'pin_required' }
 *   3. extension sends { type: 'pin', pin }  -> verify, send { type: 'connected', sessionToken }
 *   4. CDP commands arrive as { id, method, params, sessionId } -> server replies
 *
 * Usage:
 *   node test/mock-relay-server.mjs [port] [--pin 123456]
 *     --pin <6digits>  fixes the PIN so an automated client can pair deterministically
 */
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

const args = process.argv.slice(2);
const pinIdx = args.indexOf('--pin');
const fixedPin = pinIdx !== -1 ? String(args[pinIdx + 1]) : null;
const port = parseInt(args.find(a => /^\d+$/.test(a)) || '9515', 10);

const server = createServer();
const wss = new WebSocketServer({ server });

const PIN_EXPIRY_MS = 60000;
const sessions = new Map(); // browserName -> { ws, sessionToken, connectedAt }
const pendingPins = new Map(); // browserName -> { pin, expiresAt }
const replies = { ok: 0 };

function genPin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function genToken() {
  return 'mock-token-' + Date.now() + '-' + Math.random().toString(36).slice(2, 12);
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function handleHello(ws, msg) {
  const browserName = msg.browserName || 'Chrome';
  const token = msg.sessionToken || null;

  // Reconnection with valid token (same as extension stored)
  if (token && [...sessions.values()].some(s => s.sessionToken === token)) {
    console.log(`[mock-relay] Reconnected browser "${browserName}" with stored session token`);
    sessions.set(browserName, { ws, sessionToken: token, connectedAt: Date.now() });
    send(ws, { type: 'connected', sessionToken: token });
    return;
  }

  // Fresh pairing
  const pin = fixedPin || genPin();
  pendingPins.set(browserName, { pin, expiresAt: Date.now() + PIN_EXPIRY_MS });
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log(`  │ 🔐 "${browserName}" wants to connect            │`);
  console.log(`  │    PIN: ${pin}   (expires in 60s)         │`);
  console.log('  │    Enter this PIN in the Chrome extension.  │');
  console.log('  └─────────────────────────────────────────────┘');
  console.log('');
  send(ws, { type: 'pin_required' });
}

function handlePin(ws, msg) {
  const browserName = msg.browserName || msg.name || 'Chrome';
  const pending = pendingPins.get(browserName);
  if (!pending) {
    console.log(`[mock-relay] No pending PIN for "${browserName}"`);
    ws.close(4000, 'No pending PIN');
    return;
  }
  if (Date.now() > pending.expiresAt) {
    console.log(`[mock-relay] PIN expired for "${browserName}"`);
    ws.close(4000, 'PIN expired');
    return;
  }
  if (String(msg.pin) !== pending.pin) {
    console.log(`[mock-relay] Wrong PIN for "${browserName}": ${String(msg.pin)}`);
    ws.close(4000, 'Invalid PIN');
    return;
  }

  const token = genToken();
  sessions.set(browserName, { ws, sessionToken: token, connectedAt: Date.now() });
  pendingPins.delete(browserName);
  console.log(`[mock-relay] ✅ "${browserName}" paired. token: ${token}`);
  send(ws, { type: 'connected', sessionToken: token });
  send(ws, { type: 'client-connected', clientId: 'mock-client-1' });

  // Drive a few CDP commands to prove routing works end-to-end
  setTimeout(() => driveTest(ws, browserName), 500);
}

function handleCDP(ws, msg) {
  // A CDP command from navigator -> respond with a mock result
  const { id, method, sessionId } = msg;
  console.log(`[mock-relay] → CDP command to extension: ${method} (id=${id})`);
}

function handleCDPReply(ws, msg) {
  // The extension responded to a CDP command we sent — proves routing round-trip.
  const got = msg.result ? 'result' : (msg.error ? `error ${msg.error.code}` : '?');
  console.log(`[mock-relay] ← CDP reply from extension: id=${msg.id} ${got}`);
  replies.ok++;
}

function driveTest(ws, browserName) {
  if (ws.readyState !== 1) return;
  console.log(`\n[mock-relay] Sending test commands to "${browserName}"...`);
  send(ws, { type: 'list_tabs_request' });
  setTimeout(() => send(ws, { id: 1, method: 'Browser.getVersion', params: {} }), 300);
  setTimeout(() => send(ws, { id: 2, method: 'Target.getTargets', params: {} }), 600);
  setTimeout(() => send(ws, { type: 'ping' }), 900);
}

wss.on('connection', (ws) => {
  console.log('[mock-relay] Connection opened');
  ws.on('message', (data) => {
    const text = data.toString();
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    const type = msg.type || msg.method || '';
    console.log(`[mock-relay] ← ${text.substring(0, 160)}`);

    if (type === 'navigator-hello') return handleHello(ws, msg);
    if (type === 'pin') return handlePin(ws, msg);
    if (type === 'cdp_event') return console.log(`[mock-relay] CDP event: ${msg.method}`);
    if (type === 'tab_list') return console.log(`[mock-relay] tab_list (${msg.tabs ? msg.tabs.length : 0} tabs)`);
    if (type === 'keepalive' || type === 'ping') return;
    if (type === 'attach_result') return;
    if (msg.id !== undefined && msg.method) return handleCDP(ws, msg);
    if (msg.id !== undefined && (msg.result !== undefined || msg.error)) return handleCDPReply(ws, msg);
  });
  ws.on('close', (code, reason) => {
    console.log(`[mock-relay] Connection closed (${code}) ${reason}`);
    // remove from sessions
    for (const [name, s] of sessions) {
      if (s.ws === ws) { sessions.delete(name); }
    }
  });
});

server.listen(port, () => {
  console.log(`\n[mock-relay] Navigator relay simulator listening on ws://localhost:${port}\n`);
  console.log('Load the extension in Chrome and connect to:');
  console.log(`  ws://localhost:${port}`);
  console.log('');
});
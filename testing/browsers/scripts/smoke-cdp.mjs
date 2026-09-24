// Minimal CDP driver for the smoke test: connect to a raw CDP target
// (e.g. the extension service worker on --remote-debugging-port=9223)
// and evaluate one or more expressions in that execution context.
//
// Usage: node smoke-cdp.mjs <wsUrl> <expression> [expression...]
import WebSocket from '/www1/navigator/node_modules/ws/index.js';

const [, , wsUrl, ...exprs] = process.argv;
if (!wsUrl || !exprs.length) {
  console.error('usage: node smoke-cdp.mjs <wsUrl> <expression> [...]');
  process.exit(2);
}

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();
const logs = [];

ws.on('open', () => {
  for (const expr of exprs) {
    const id = ++nextId;
    pending.set(id, { expr, done: false });
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression: expr, awaitPromise: true, returnByValue: true }
    }));
  }
});

ws.on('message', (data) => {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    p.done = true;
    let out = msg.result || msg.error;
    if (msg.result && msg.result.exceptionDetails) {
      const ed = msg.result.exceptionDetails;
      out = `EXCEPTION: ${ed.text} ${ed.exception ? JSON.stringify(ed.exception.description || ed.exception.value) : ''}`;
    } else if (msg.result && msg.result.result) {
      out = msg.result.result.value;
    }
    logs.push(`#${msg.id} [${p.expr}] => ${JSON.stringify(out)}`);
    if ([...pending.values()].every(x => x.done)) {
      setTimeout(() => ws.close(), 200);
    }
  }
});

ws.on('close', () => {
  console.log(logs.join('\n'));
  const unfinished = [...pending.values()].filter(p => !p.done);
  process.exit(unfinished.length ? 1 : 0);
});

ws.on('error', (e) => {
  console.error('ws error:', e.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('timeout after 15s');
  ws.close();
  process.exit(1);
}, 15000);
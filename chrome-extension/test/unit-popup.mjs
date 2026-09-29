#!/usr/bin/env node
/**
 * Popup DOM tests (plan 45) — jsdom, no browser needed.
 *
 * The vm harness (unit-ext.mjs) covers background/connection-manager logic but
 * never loads popup.js, which is where the description field actually lives.
 * These tests load the real popup.html + popup.js against a mocked chrome.*
 * namespace and assert the user-visible behaviour:
 *
 *   1. the field is OUTSIDE #connFields, so it stays editable while connected
 *   2. it is prefilled from storage, and a periodic loadState() refresh never
 *      clobbers what the user is typing
 *   3. empty is valid (optional field) and never blocks connecting
 *   4. over 500 chars / control characters show an inline error and are NOT sent
 *   5. blur while connected pushes a live update_description
 *   6. blur while disconnected only persists locally
 *   7. the connected summary shows a Description row only when non-empty
 *
 * Both extensions share this logic, so the same suite runs against either
 * one:
 *
 *   node chrome-extension/test/unit-popup.mjs chrome-extension
 *   node firefox-extension/test/unit-popup.mjs firefox-extension
 */
import { readFileSync } from 'fs';
import vm from 'vm';
import { JSDOM } from 'jsdom';

// The extension under test. Defaults to the tree this file lives in; the other
// extension passes its own root so one suite serves both and neither can drift.
const ROOT = (process.argv[2] || new URL('..', import.meta.url).pathname)
  .replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const failures = [];
function test(name, fn) {
  try {
    if (fn()) {
      pass += 1;
      console.log(`  ✅ ${name}`);
    } else {
      fail += 1;
      failures.push(name);
      console.log(`  ❌ ${name}`);
    }
  } catch (err) {
    fail += 1;
    failures.push(name);
    console.log(`  ❌ ${name} — ${err && err.message}`);
  }
}

function makeChromeMock(initial = {}) {
  const storage = { ...initial };
  return {
    runtime: {
      getManifest: () => ({ version: '0.4.0' }),
      getURL: (p) => `chrome-extension://abc/${p || ''}`,
      sendMessage: (msg, cb) => { setTimeout(() => cb && cb({ success: true }), 0); },
      lastError: null,
    },
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) if (storage[k] !== undefined) out[k] = storage[k];
          setTimeout(() => cb(out), 0);
        },
        set(values, cb) { Object.assign(storage, values); setTimeout(() => cb && cb(), 0); },
        remove(keys, cb) {
          for (const k of (Array.isArray(keys) ? keys : [keys])) delete storage[k];
          setTimeout(() => cb && cb(), 0);
        }
      }
    },
    tabs: { query: (_q, cb) => cb([]) },
    windows: { getCurrent: (_q, cb) => cb({ id: 1 }) },
    _storage: storage,
  };
}

/**
 * Load the real popup.html + popup.js into a jsdom window with the mocked
 * chrome namespace. Returns handles the tests poke at.
 */
async function loadPopup({ storage = {}, snapshot = {} } = {}) {
  const html = readFileSync(`${ROOT}/popup.html`, 'utf8');
  // popup.html loads these as classic scripts on the page scope, in this order.
  const configJs = readFileSync(`${ROOT}/utils/config.js`, 'utf8');
  const popupJs = readFileSync(`${ROOT}/popup.js`, 'utf8');
  const chrome = makeChromeMock(storage);
  const sent = [];
  // `popup-query` is how the popup polls the background for its state; the
  // snapshot it replies with is the only thing that drives rendering.
  let state = { ...snapshot };
  chrome.runtime.sendMessage = (msg, cb) => {
    sent.push(msg);
    setTimeout(() => cb && cb({ success: true, ...(msg.type === 'popup-query' ? state : {}) }), 0);
  };

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'chrome-extension://abc/popup.html' });
  const { window } = dom;
  const listeners = [];
  window.chrome = chrome;
  window.console = console;
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  window.setInterval = () => 0;          // no polling in tests
  window.clearInterval = () => {};
  window.addEventListener = () => {};
  window.removeEventListener = () => {};
  window.close = () => dom.window.close();

  // The popup listens for the background's state broadcasts. Capture them so
  // the tests can drive connected / disconnected states on demand.
  chrome.runtime.onMessage = { addListener: (fn) => { listeners.push(fn); } };
  const ctx = window;
  const context = vm.createContext(
    Object.assign(Object.getOwnPropertyDescriptors(ctx), {
      chrome, console, document: window.document, window: ctx,
      setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: () => {},
      WebSocket: function () {}, Date, JSON, Promise, Math, Object, Array, String, Number, Boolean, Error,
    })
  );
  vm.runInContext(configJs, context, { filename: 'config.js' });
  vm.runInContext(popupJs, context, { filename: 'popup.js' });
  await sleep(80);

  // A state broadcast makes the popup re-query; tests drive it through setState
  // so rendering follows the same path it takes in the real extension.
  const emit = (message) => { for (const fn of listeners) fn(message); };
  const setState = async (patch) => {
    state = { ...patch };
    emit({ type: 'stateUpdate' });
    await sleep(30);
  };
  return { window, document: window.document, chrome, sent, emit, setState, storage: chrome._storage, context };
}

// 1. Structure: the field must be reachable while connected.
{
  const { document } = await loadPopup();
  const field = document.getElementById('field-browserDescription');
  const connFields = document.getElementById('connFields');
  test('1a. the description field exists with a textarea', () => !!field && !!field.querySelector('textarea#browserDescription'));
  test('1b. it is NOT inside #connFields (stays visible while connected)', () => !!connFields && !connFields.contains(field));
  test('1c. it is optional and capped at 500 characters', () => {
    const label = field.querySelector('label');
    return /optional/i.test(label.textContent) && field.querySelector('textarea').getAttribute('maxlength') === '500';
  });
  test('1d. the connected summary has a (hidden) description row', () => {
    const row = document.getElementById('summaryDescriptionRow');
    return !!row && row.hasAttribute('hidden') && !!document.getElementById('summaryDescription');
  });
}

// 2. Prefill + dirty guard.
{
  const { document, window, emit } = await loadPopup({ storage: { browserDescription: 'my daily driver' } });
  const input = document.getElementById('browserDescription');
  test('2a. the field is prefilled from storage', () => input.value === 'my daily driver');
  test('2b. the character counter is shown', () => /15 \/ 500/.test(document.getElementById('descriptionCount').textContent));
  // A refresh mid-edit must not clobber the user's text.
  input.value = 'half-typed thought';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  test('2c. a state refresh does not clobber the half-typed text', () => {
    emit({ connected: false, connecting: false, serverUrl: '', browserName: '' });
    return input.value === 'half-typed thought';
  });
}

// 3/4/5/6. Validation, live send while connected, local-only while offline.
{
  const { document, window, sent } = await loadPopup({ storage: { browserDescription: 'keep me' } });
  const input = document.getElementById('browserDescription');
  const field = document.getElementById('field-browserDescription');
  const error = document.getElementById('browserDescriptionError');

  // Over-long value: inline error, nothing sent, nothing persisted over.
  input.value = 'x'.repeat(501);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('blur', { bubbles: false }));
  await sleep(20);
  test('3a. >500 chars shows an inline error on the field', () => field.classList.contains('error') && /500/.test(error.textContent));
  test('3b. an invalid value is never sent to the relay', () => !sent.some((m) => m.type === 'update-description'));

  // Control characters (tab/newline allowed) — the same rule the server enforces.
  input.value = 'clean\u0007text';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('blur', { bubbles: false }));
  await sleep(20);
  test('4a. control characters are rejected inline', () => /control characters/i.test(error.textContent));

  // Valid value while NOT connected → persist only, no live send.
  input.value = 'edited while offline';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('blur', { bubbles: false }));
  await sleep(40);
  const offlineSent = sent.filter((m) => m.type === 'update-description');
  test('5a. blur while disconnected does not send a live update', () => offlineSent.length === 0);
  test('5b. but it is persisted for the next hello', () => {
    const ctxStorage = document.defaultView.chrome._storage;
    return ctxStorage.browserDescription === 'edited while offline';
  });
  test('5c. the field is no longer in an error state', () => !field.classList.contains('error'));
}

// 6. Connected: the field stays editable and blurring pushes a live update.
{
  const { document, window, sent, setState } = await loadPopup({ storage: { browserDescription: 'old text' } });
  const input = document.getElementById('browserDescription');
  const row = document.getElementById('summaryDescriptionRow');
  const summary = document.getElementById('summaryDescription');

  await setState({ connected: true, serverUrl: 'http://localhost:1994', browserName: 'maclap2', browserDescription: 'old text' });
  test('6a. the field is NOT disabled while connected', () => !input.disabled && !document.getElementById('field-browserDescription').classList.contains('disabled'));
  test('6b. the connected summary shows a Description row for a non-empty value', () => !row.hasAttribute('hidden') && summary.textContent === 'old text');

  input.value = 'renamed while connected';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('blur', { bubbles: false }));
  await sleep(40);
  const live = sent.filter((m) => m.type === 'update-description');
  test('6c. blur while connected sends exactly one live update', () => live.length === 1);
  test('6d. the live update carries the new text', () => live[0] && live[0].description === 'renamed while connected');
  test('6e. the summary picks the new text up without a reload', () => summary.textContent === 'renamed while connected');

  // An explicitly cleared description is a real instruction ("no owner
  // description") — it must reach the relay as "", not be dropped as "unset".
  input.value = '';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('blur', { bubbles: false }));
  await sleep(40);
  const cleared = sent.filter((m) => m.type === 'update-description');
  test('6f. clearing while connected sends an explicit empty string', () => cleared.length === 2 && cleared[1].description === '');
  test('6g. an empty description hides the summary row again', () => row.hasAttribute('hidden'));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log('failed:', failures.join(' | '));
process.exit(fail > 0 ? 1 : 0);

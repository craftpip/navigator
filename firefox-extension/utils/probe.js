// Reachability probe for debugging "why won't it connect?".
//
// The WebSocket connect already reports its own errors, but those don't tell
// you whether the host:port is even reachable (DNS, firewall, server down).
// This probes the navigator HTTP health endpoint (http(s)://host:port/health)
// which the server exposes with access-control-allow-origin: *, so the probe
// works cross-origin from both the background and the popup without needing
// host_permissions.
//
// Result shape (always resolves, never rejects):
//   { ok, hostPort, scheme, status, body, error, mode }
//   ok      — true iff an HTTP response was received (any status)
//   scheme  - "http" | "https" (which one succeeded / was tried)
//   status  - HTTP status (e.g. 200) or null
//   body    - first ~80 chars of the body (e.g. '{"ok":true,...}')
//   error   - friendly failure message, or null
//   mode    - 'dns' | 'refused' | 'timeout' | 'http' | 'cors' | 'unknown'
var Probe = (function() {
  'use strict';

  var TIMEOUT_MS = 4000;

  function parseHostPort(input) {
    var v = String(input || '').trim();
    if (!v) return null;
    if (v.indexOf('://') !== -1) v = v.replace(/^[a-z]+:\/\//i, '');
    v = v.split('/')[0].trim().replace(/:+$/, '');
    if (!v) return null;
    // Default to port 1994 if none given (matches navigator default).
    if (v.indexOf(':') === -1) v = v + ':1994';
    return v;
  }

  function fetchOnce(url) {
    return new Promise(function(resolve) {
      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = setTimeout(function() {
        if (controller) { try { controller.abort(); } catch (e) {} }
        resolve({ ok: false, timedOut: true, error: 'timed out after ' + (TIMEOUT_MS / 1000) + 's' });
      }, TIMEOUT_MS);
      var opts = { method: 'GET', cache: 'no-store', mode: 'cors', redirect: 'follow' };
      if (controller) opts.signal = controller.signal;
      fetch(url, opts).then(function(res) {
        clearTimeout(timer);
        return res.text().then(function(body) {
          resolve({ ok: true, status: res.status, body: (body || '').trim().substring(0, 120) });
        }).catch(function() {
          resolve({ ok: true, status: res.status, body: '' });
        });
      }).catch(function(e) {
        clearTimeout(timer);
        var msg = String((e && e.message) || e || 'fetch failed');
        var lower = msg.toLowerCase();
        if (lower.indexOf('dns') !== -1) resolve({ ok: false, error: msg, mode: 'dns' });
        else if (lower.indexOf('refused') !== -1) resolve({ ok: false, error: msg, mode: 'refused' });
        else if (lower.indexOf('cors') !== -1) resolve({ ok: false, error: msg, mode: 'cors' });
        else if (lower.indexOf('abort') !== -1 || lower.indexOf('timeout') !== -1) resolve({ ok: false, error: msg, mode: 'timeout' });
        else resolve({ ok: false, error: msg, mode: 'unknown' });
      });
    });
  }

  function probe(input) {
    var hostPort = parseHostPort(input);
    if (!hostPort) {
      return Promise.resolve({ ok: false, error: 'No host:port to probe', mode: 'unknown' });
    }
    Logger.info('[Probe] Testing reachability of', hostPort);

    // Try https then http (mirrors the WebSocket candidate order).
    var attempts = [
      { scheme: 'https', url: 'https://' + hostPort + '/health' },
      { scheme: 'http', url: 'http://' + hostPort + '/health' }
    ];

    // Network-level failures, one per scheme. When every scheme fails, the
    // result reports the most specific cause seen (refused/dns/timeout/cors
    // from either attempt), not a blanket 'unknown': that cause is what the
    // popup shows the user.
    var failures = [];
    function allFailed() {
      var specific = failures.filter(function(f) { return f.mode && f.mode !== 'unknown'; })[0];
      return {
        ok: false,
        hostPort: hostPort,
        scheme: specific ? specific.scheme : null,
        status: null,
        body: null,
        error: hostPort + ' not reachable via http or https (' +
          failures.map(function(f) { return f.scheme + ': ' + f.error; }).join('; ') + ')',
        mode: specific ? specific.mode : 'unknown'
      };
    }

    function attempt(i) {
      if (i >= attempts.length) return Promise.resolve(allFailed());
      var a = attempts[i];
      Logger.info('[Probe] Trying', a.url);
      return fetchOnce(a.url).then(function(res) {
        if (res.ok) {
          Logger.info('[Probe] OK', a.url, '->', res.status, res.body);
          return { ok: true, hostPort: hostPort, scheme: a.scheme, status: res.status, body: res.body, error: null, mode: 'http' };
        }
        var mode = res.timedOut ? 'timeout' : (res.mode || 'unknown');
        Logger.warn('[Probe] Failed', a.url, ':', res.error, mode);
        failures.push({ scheme: a.scheme, error: res.error, mode: mode });
        return attempt(i + 1);
      });
    }

    return attempt(0);
  }

  return {
    probe: probe,
    parseHostPort: parseHostPort
  };
})();

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

    var attemptIndex = 0;
    function nextTry() {
      if (attemptIndex >= attempts.length) {
        // Both schemes failed to even reach the server (network layer).
        return Promise.resolve({
          ok: false,
          hostPort: hostPort,
          error: hostPort + ' not reachable via http or https (DNS/connection/timeout)',
          mode: 'unknown'
        });
      }
      var a = attempts[attemptIndex++];
      Logger.info('[Probe] Trying', a.url);
      return fetchOnce(a.url).then(function(res) {
        if (res.ok) {
          Logger.info('[Probe] OK', a.url, '->', res.status, res.body);
          return { ok: true, hostPort: hostPort, scheme: a.scheme, status: res.status, body: res.body, error: null, mode: 'http' };
        }
        // Network-level failure on this scheme: remember and try the other.
        Logger.warn('[Probe] Failed', a.url, ':', res.error, res.mode);
        return nextTry().then(function(r2) {
          return { ok: r2.ok, hostPort: hostPort, scheme: r2.scheme, status: r2.status, body: r2.body, error: r2.error || res.error, mode: r2.mode || res.mode };
        });
      });
    }

    return nextTry();
  }

  return {
    probe: probe,
    parseHostPort: parseHostPort
  };
})();

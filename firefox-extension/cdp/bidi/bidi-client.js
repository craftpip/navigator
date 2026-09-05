/**
 * BidiClient — the WebSocket to Firefox's Remote Agent (WebDriver BiDi endpoint).
 *
 * Handles the connection lifecycle: WS open -> mandatory `session.new` ->
 * `session.subscribe` (auto-subscribe to the modules navigator cares about).
 * JSON-RPC framing: { id, method, params } out, { id, result } replies with
 * id-correlated promises, { method, params } events to listeners.
 */
var BidiClient = (function() {
  'use strict';

  var SEND_TIMEOUT_MS = 30000;

  // Module/event names auto-subscribed once a session exists. Firefox 129+.
  var SUBSCRIPTIONS = [
    'browsingContext.contextCreated',
    'browsingContext.contextDestroyed',
    'browsingContext.navigationStarted',
    'browsingContext.domContentLoaded',
    'browsingContext.load',
    'browsingContext.userPromptOpened',
    'script.message',
    'script.realmCreated',
    'script.realmDestroyed',
    'log.entryAdded',
    'network.responseCompleted'
  ];

  var _ws = null;
  var _sessionId = null;
  var _browserVersion = null;
  var _browserName = null;
  var _nextId = 1;
  var _pending = new Map();
  var _listeners = [];
  var _statusListeners = [];

  // ------------------------------------------------------------ accessors

  function getSocket() { return _ws; }
  function isConnected() { return !!(_ws && _ws.readyState === WebSocket.OPEN && _sessionId); }
  function getSessionId() { return _sessionId; }
  function getBrowserVersion() { return _browserVersion; }
  function getBrowserName() { return _browserName; }

  function setListener(fn) { _listeners.push(fn); }
  function addStatusListener(fn) { _statusListeners.push(fn); }

  function _notifyStatus() {
    for (var i = 0; i < _statusListeners.length; i++) {
      try { _statusListeners[i](); } catch (e) {}
    }
  }

  // ------------------------------------------------------------ lifecycle

  function connect(url, callback) {
    callback = callback || function() {};

    if (_ws && _ws.readyState === WebSocket.OPEN && _sessionId) {
      callback({ success: true, already: true });
      return;
    }
    if (_ws && (_ws.readyState === WebSocket.CONNECTING || _ws.readyState === WebSocket.OPEN)) {
      try { _ws.close(); } catch (e) {}
      _ws = null;
    }

    Logger.info('[BiDi] Connecting to', url);
    var ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      Logger.error('[BiDi] Failed to create WS:', e);
      State.setBidiError('Invalid BiDi URL: ' + url);
      _notifyStatus();
      callback({ success: false, error: String(e) });
      return;
    }
    _ws = ws;

    ws.onopen = function() {
      Logger.info('[BiDi] Socket open');
      _sendRaw({ method: 'session.new', params: { capabilities: {} } }, {
        resolve: function(result) { _handleSessionNew(result, callback); },
        reject: function(err) {
          Logger.error('[BiDi] session.new failed:', err.message);
          State.setBidiError('session.new: ' + err.message);
          _notifyStatus();
          callback({ success: false, error: err.message });
        }
      });
    };

    ws.onmessage = function(event) { _handleMessage(event.data); };

    ws.onerror = function() {
      Logger.error('[BiDi] Socket error');
      State.setBidiError('BiDi WebSocket error');
      _notifyStatus();
    };

    ws.onclose = function(event) {
      Logger.info('[BiDi] Closed:', event.code, event.reason);
      var hadSession = !!_sessionId;
      CDPSessionManager.handleBidiDisconnected();
      _sessionId = null;
      _browserVersion = null;
      var pendings = Array.from(_pending.values());
      _pending.clear();
      pendings.forEach(function(p) {
        if (p.reject) p.reject(new Error('BiDi connection closed'));
      });
      if (hadSession || State.isBidiConnected()) {
        State.setBidiConnected(false);
        State.setBidiError('BiDi disconnected (' + (event.code || '') + ')');
        _notifyStatus();
      }
    };
  }

  function disconnect() {
    if (_ws) {
      try { _ws.close(); } catch (e) {}
      _ws = null;
    }
    _sessionId = null;
    _browserVersion = null;
  }

  function ensureConnected() {
    if (isConnected()) return;
    Config.getBidiUrl(function(url) {
      connect(url || Config.defaultBidiUrl);
    });
  }

  /**
   * Lazily ensure a live BiDi session before dispatching a command. If the
   * session dropped (e.g. the background event page suspended the WS, or the
   * Remote Agent wasn't up at extension load), this (re)connects so navigator
   * driving Firefox "just works" on the next CDP command instead of failing
   * forever with "BiDi not connected".
   */
  function _ensureSession(timeoutMs) {
    return new Promise(function(resolve, reject) {
      if (isConnected()) { resolve(); return; }
      Config.getBidiUrl(function(url) {
        connect(url || Config.defaultBidiUrl);
        var waited = 0;
        var step = 80;
        var iv = setInterval(function() {
          if (isConnected()) { clearInterval(iv); resolve(); return; }
          waited += step;
          if (waited >= (timeoutMs || 4000)) {
            clearInterval(iv);
            reject(new Error('BiDi not connected'));
          }
        }, step);
      });
    });
  }

  // ------------------------------------------------------------ transport

  function _sendRaw(msg, handlers) {
    if (!_ws || _ws.readyState !== WebSocket.OPEN) {
      if (handlers && handlers.reject) handlers.reject(new Error('BiDi socket not open'));
      return;
    }
    var id = msg.id || (_nextId++);
    msg.id = id;
    if (handlers) _pending.set(id, handlers);
    try {
      _ws.send(JSON.stringify(msg));
    } catch (e) {
      _pending.delete(id);
      if (handlers && handlers.reject) handlers.reject(e);
    }
  }

  function send(method, params, timeoutMs) {
    return _ensureSession().then(function() {
      return new Promise(function(resolve, reject) {
        if (!_ws || _ws.readyState !== WebSocket.OPEN || !_sessionId) {
          reject(new Error('BiDi not connected'));
          return;
        }
        var timer = setTimeout(function() {
          if (_pending.has(_nextId)) { _pending.delete(_nextId); reject(new Error('BiDi timeout: ' + method)); }
        }, timeoutMs || SEND_TIMEOUT_MS);

        _sendRaw({ method: method, params: params || {} }, {
          resolve: function(r) { clearTimeout(timer); resolve(r); },
          reject: function(e) { clearTimeout(timer); reject(e); }
        });
      });
    });
  }

  // ------------------------------------------------------------ protocol

  function _handleSessionNew(result, callback) {
    _sessionId = result.sessionId || null;
    var caps = result.capabilities || {};
    _browserVersion = caps.browserVersion || null;
    _browserName = caps.browserName || 'firefox';
    Logger.info('[BiDi] Session established:', _sessionId, 'Firefox', _browserVersion);
    State.setBidiConnected(true);
    State.setBidiUrl(State.getBidiUrl() || Config.defaultBidiUrl);
    State.clearBidiError();
    _notifyStatus();
    _subscribe();
    if (callback) callback({ success: true, sessionId: _sessionId, browserVersion: _browserVersion });
  }

  function _subscribe() {
    _sendRaw({ method: 'session.subscribe', params: { events: SUBSCRIPTIONS } }, {
      resolve: function() { Logger.info('[BiDi] Subscribed to events'); },
      reject: function(err) { Logger.warn('[BiDi] subscribe failed:', err.message); }
    });
  }

  function _handleMessage(data) {
    var text;
    if (data instanceof Blob) {
      data.text().then(function(t) { _parse(t); }).catch(function() {});
      return;
    }
    _parse(data);
  }

  function _parse(text) {
    var msg;
    try { msg = JSON.parse(text); } catch (e) { return; }

    if (msg.id != null && _pending.has(msg.id)) {
      var p = _pending.get(msg.id);
      _pending.delete(msg.id);
      if (msg.type === 'error' || msg.error) {
        var err = msg.error || {};
        if (p.reject) p.reject(new Error(err.message || ('BiDi error ' + (err.code || 'unknown'))));
      } else {
        if (p.resolve) p.resolve(msg.result || {});
      }
      return;
    }

    if (msg.method) {
      var ev = { method: msg.method, params: msg.params || {} };
      for (var i = 0; i < _listeners.length; i++) {
        try { _listeners[i](ev); } catch (e) {}
      }
    }
  }

  return {
    getSocket: getSocket,
    isConnected: isConnected,
    getSessionId: getSessionId,
    getBrowserVersion: getBrowserVersion,
    getBrowserName: getBrowserName,
    setListener: setListener,
    addStatusListener: addStatusListener,
    connect: connect,
    disconnect: disconnect,
    ensureConnected: ensureConnected,
    send: send
  };
})();
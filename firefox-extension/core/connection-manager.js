var ConnectionManager = (function() {
  var _connection = null;
  var _listeners = [];
  var _intentionalDisconnect = false;

  // Close codes navigator's relay sends — mirror of RelayCloseCode in
  // navigator's src/relay-server.js, which documents each one. Every 4xxx
  // code is the server's verdict on this connection: trying the alternate
  // candidate URL after one is pointless.
  var CloseCode = {
    PIN_REJECTED: 4000,   // stop; keep the previous pairing
    INVALID_TOKEN: 4001,  // drop the token, re-pair with a fresh PIN
    FORGOTTEN: 4004,      // drop the token, stop
    REMOVED: 4005,        // drop the token, stop (name tombstoned)
    NAME_COLLISION: 4006, // drop the token, stop (name is a direct-CDP browser)
    HELLO_TIMEOUT: 4007,  // transient: reconnect with backoff
    PROTOCOL_ERROR: 4008, // transient: reconnect with backoff
    SUPERSEDED: 4009      // another connection took this pairing: stop
  };

  function isServerVerdict(code) {
    return code >= 4000 && code <= 4999;
  }

  /**
   * Capped exponential reconnect delay: 1s, 2s, 4s … up to 30s, back to 1s
   * once the server accepts us. A navigator restart of any length is
   * survived without hammering a server that is down.
   */
  var Backoff = (function() {
    var _attempt = 0;
    return {
      next: function() {
        var delay = Math.min(Config.RECONNECT_MAX_DELAY, Config.RECONNECT_BASE_DELAY * Math.pow(2, _attempt));
        if (delay < Config.RECONNECT_MAX_DELAY) _attempt++;
        return delay;
      },
      reset: function() { _attempt = 0; }
    };
  })();

  /**
   * Half-dead socket detection. navigator pings every 15s and answers our
   * pings, so an open socket that has delivered nothing for
   * Config.LIVENESS_TIMEOUT is dead even though the browser still reports it
   * OPEN (NAT/proxy drop, suspended peer). It is abandoned and redialled.
   */
  var Liveness = (function() {
    var _lastInboundAt = 0;
    return {
      noteInbound: function() { _lastInboundAt = Date.now(); },
      reset: function() { _lastInboundAt = Date.now(); },
      isStale: function() { return Date.now() - _lastInboundAt > Config.LIVENESS_TIMEOUT; }
    };
  })();

  function get() {
    return _connection;
  }

  function addListener(fn) {
    _listeners.push(fn);
  }

  function notify(message) {
    for (var i = 0; i < _listeners.length; i++) {
      try { _listeners[i](message); } catch (e) {}
    }
  }

  // The durable "connecting intent" flag is only meaningful while a connect
  // attempt is actually in flight. Once the connection resolves — connected,
  // waiting for a PIN, or all candidates failed — the flag no longer applies.
  function ClearPending() {
    Config.clearPendingConnecting();
  }

  function buildCandidateUrls(raw) {
    var input = String(raw || '').trim();
    if (!input) return [];
    if (input.indexOf('://') !== -1) {
      var url = input.replace(/\/+$/, '');
      if (url.indexOf('/relay') === -1) {
        url = url.replace(/\/$/, '') + '/relay';
      }
      // Normalize http(s) → ws(s) so new WebSocket() works, and try the plain
      // (non-TLS) variant first — navigator's relay serves plain HTTP, so a
      // wss:// probe only fails the TLS handshake and flashes a confusing error.
      if (url.indexOf('https://') === 0) {
        return ['ws://' + url.substring(8), 'wss://' + url.substring(8)];
      }
      if (url.indexOf('http://') === 0) {
        return ['ws://' + url.substring(7), 'wss://' + url.substring(7)];
      }
      if (url.indexOf('wss://') === 0) {
        // Explicitly TLS-requested: honor it, but still offer the plain fallback.
        return ['ws://' + url.substring(5), url];
      }
      return [url];
    }
    var hostPort = input.split('/')[0].trim().replace(/:+$/, '');
    if (!hostPort) return [];
    // Navigator's relay serves plain HTTP (no TLS on the MCP/http port), so
    // always try the plain `ws://` first — `wss://` fails the TLS handshake
    // against a non-TLS relay and surfaces a confusing error.
    return ['ws://' + hostPort + '/relay', 'wss://' + hostPort + '/relay'];
  }

  function connect(options, callback) {
    options = options || {};
    _intentionalDisconnect = false;
    State.setConnecting(true);
    State.setLastError(null);
    notify({ type: 'connection-status-changed' });

    Config.getServerUrl(function(serverUrl) {
      Config.getBrowserName(function(browserName) {
        Config.getBrowserDescription(function(browserDescription) {
        Config.getSessionToken(function(sessionToken) {
          var rawUrl = options.serverUrl || serverUrl || Config.defaultWsUrl;
          if (!rawUrl) {
            Logger.error('[Connection] No relay URL configured');
            State.setLastError('No relay server URL configured — open the extension popup and set it');
            State.setConnecting(false);
            ClearPending();
            notify({ type: 'connection-status-changed' });
            if (callback) callback({ success: false, error: 'No relay server URL configured' });
            return;
          }
          var candidates = buildCandidateUrls(rawUrl);
          if (!candidates.length) candidates = [String(rawUrl).trim()];
          Logger.info('[Connection] Candidates for', rawUrl, ':', candidates.join(' , '), 'as', browserName);

          if (_connection) {
            try { _connection.close(); } catch (e) {}
            _connection = null;
          }

          var tried = 0;
          var callbackFired = false;
          function fireCallbackOnce(result) {
            if (callbackFired) return;
            callbackFired = true;
            if (callback) callback(result);
          }

          function tryNext() {
            if (tried >= candidates.length) {
              Logger.error('[Connection] All candidates failed for', rawUrl);
              State.setConnecting(false);
              ClearPending();
              // navigator is down or restarting: keep trying, slower each
              // time, instead of going offline until the user notices.
              var retryIn = scheduleBackoffReconnect();
              State.setLastError('Could not connect to ' + rawUrl + ' (tried ' + candidates.join(', ') + ')' +
                (retryIn ? ' — retrying in ' + Math.round(retryIn / 1000) + 's' : ''));
              notify({ type: 'connection-status-changed' });
              fireCallbackOnce({ success: false, error: 'All candidates failed' });
              return;
            }
            var wsUrl = candidates[tried++];
            Logger.info('[Connection] Trying', wsUrl, 'as', browserName);

            var ws;
            try {
              ws = new WebSocket(wsUrl);
            } catch (e) {
              Logger.error('[Connection] Failed to create WebSocket for', wsUrl, e);
              setTimeout(tryNext, 300);
              return;
            }

            _connection = ws;
            State.setWs(ws);
            State.clearReconnectTimer();
            State.clearHeartbeatTimer();

            var opened = false;
            var fallbackTimer = setTimeout(function() {
              if (!opened && State.getWs() === ws) {
                Logger.warn('[Connection] Timeout for', wsUrl, '— trying next');
                try { ws.close(); } catch (e) {}
              }
            }, 4000);

            ws.onopen = function() {
              opened = true;
              clearTimeout(fallbackTimer);
              Logger.info('[Connection] WebSocket open via', wsUrl);
              State.setLastError(null);
              State.setConnectedAt(Date.now());
              Config.saveServerUrl(rawUrl);
              notify({ type: 'connection-status-changed' });

              var msg = {
                type: 'navigator-hello',
                browserName: browserName,
                platform: 'firefox',
                extensionVersion: chrome.runtime.getManifest().version
              };
              // Sent on EVERY hello, including a silent token reconnect, so a
              // description edited while offline still lands on the server.
              // The check is on TYPE, not truthiness: an empty string is a
              // deliberate "clear it" (the user emptied the field), and the
              // server only treats an ABSENT field as "old extension, keep
              // what's stored". Truthiness here would strand the old value.
              if (typeof browserDescription === 'string') {
                msg.browserDescription = browserDescription;
              }
              // The Remote Agent allow-lists WebSocket origins exactly
              // (scheme/host/port). The extension connects from a
              // "moz-extension://<uuid>" origin — report it so navigator (and
              // the launch script) can pass --remote-allow-origins correctly.
              try {
                var origin = String(chrome.runtime.getURL('') || '')
                  .replace(/\/$/, '');
                if (origin) msg.bidiOrigin = origin;
              } catch (e) { /* ignore */ }
              if (sessionToken) {
                msg.sessionToken = sessionToken;
                Logger.info('[Connection] Including session token');
              }
              ConnectionManager.send(msg);
              fireCallbackOnce({ success: true });
            };

            ws.onclose = function(event) {
              clearTimeout(fallbackTimer);
              if (State.getWs() !== ws) return;
              Logger.info('[Connection] Closed for', wsUrl, ':', event.code, event.reason);
              State.setWs(null);
              State.clearHeartbeatTimer();
              State.setConnecting(false);
              State.setConnected(false);
              // Never opened: move on to the next candidate (tryNext reports
              // and schedules the retry once they are exhausted) — unless the
              // server itself closed us; its verdict holds for every URL.
              if (!opened && !_intentionalDisconnect && !isServerVerdict(event.code)) {
                Logger.info('[Connection] Falling back to next candidate');
                State.setConnecting(true);
                tryNext();
                return;
              }
              _handleClose(event);
              notify({ type: 'connection-status-changed' });
            };

            ws.onerror = function(error) {
              if (State.getWs() !== ws) return;
              Logger.error('[Connection] Error for', wsUrl, ':', error);
              // A failed candidate (e.g. a `wss://` TLS probe against a plain
              // HTTP relay) sets off a fallback to the next candidate. Only
              // surface a hard error when every candidate has failed — a
              // pending fallback should not flash a scary error to the user.
              if (tried >= candidates.length) {
                State.setLastError('WebSocket error for ' + wsUrl);
                notify({ type: 'connection-status-changed' });
              }
            };

            ws.onmessage = function(event) {
              if (State.getWs() !== ws) return; // abandoned socket
              Liveness.noteInbound();
              _handleMessage(event.data);
            };
          }

          tryNext();
        });
        });
      });
    });
  }

  /**
   * Push a re-worded description to navigator while staying connected — no
   * re-PIN, no reconnect. The relay channel is already authenticated by the
   * session token, so this needs nothing extra. Persists locally first so a
   * later reconnect re-sends it in the hello even if this call fails.
   * @param {string} description
   * @returns {boolean} true when the message went out on a live socket
   */
  function updateDescription(description, callback) {
    Config.saveBrowserDescription(description || '', function() {
      var ok = send({ type: 'update_description', description: description || '' });
      Logger.info('[Connection] Description update', ok ? 'sent' : 'queued for next hello');
      if (callback) callback({ success: ok, queued: !ok });
    });
  }

  function disconnect() {
    Logger.info('[Connection] Disconnecting');
    _intentionalDisconnect = true;
    State.setConnecting(false);
    State.setConnected(false);
    ClearPending();
    State.clearReconnectTimer();
    State.clearHeartbeatTimer();
    State.setPairing(false);
    State.setPinRequired(false);
    State.setLastError(null);
    State.setPinError(null);
    if (_connection) {
      try { _connection.close(); } catch (e) {}
      _connection = null;
    }
    State.setWs(null);
    notify({ type: 'connection-status-changed' });
  }

  function send(message) {
    var ws = State.getWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch (e) {
      Logger.error('[Connection] Send failed:', e);
      return false;
    }
  }

  function scheduleReconnect(delay) {
    State.clearReconnectTimer();
    var timer = setTimeout(function() {
      State.setReconnectTimer(null);
      if (_intentionalDisconnect) return;
      Logger.info('[Connection] Reconnecting...');
      ConnectionManager.connect();
    }, delay);
    State.setReconnectTimer(timer);
  }

  /** Schedule the next backoff reconnect; returns its delay, or 0 when the user disconnected. */
  function scheduleBackoffReconnect() {
    if (_intentionalDisconnect) return 0;
    var delay = Backoff.next();
    Logger.info('[Connection] Reconnecting in', delay, 'ms');
    scheduleReconnect(delay);
    return delay;
  }

  function startHeartbeat() {
    Liveness.reset();
    State.startHeartbeat(keepalive);
  }

  /**
   * Periodic upkeep of an open connection (heartbeat interval and the
   * background's keepalive alarm): ping navigator, and abandon the
   * socket if navigator has gone silent.
   */
  function keepalive() {
    var ws = State.getWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (State.isConnected() && Liveness.isStale()) {
      Logger.warn('[Connection] No traffic from navigator for over', Config.LIVENESS_TIMEOUT, 'ms — reconnecting');
      State.setWs(null);
      State.clearHeartbeatTimer();
      State.setConnected(false);
      try { ws.close(); } catch (e) {}
      notify({ type: 'connection-status-changed' });
      scheduleBackoffReconnect();
      return;
    }
    send({ type: 'ping' });
  }

  /**
   * True when nothing is connected, connecting, or scheduled to reconnect —
   * the state a dropped socket ends in when its reconnect timer was lost
   * (e.g. the event page was suspended). The keepalive alarm auto-connects
   * from here.
   */
  function isIdle() {
    return !State.getWs() && !State.getReconnectTimer() && !State.isConnecting() && !_intentionalDisconnect;
  }

  function _handleClose(event) {
    if (_intentionalDisconnect) return;
    if (event.code === CloseCode.INVALID_TOKEN) {
      Logger.warn('[Connection] Server rejected: bad session token');
      State.setConnecting(false);
      State.setPinError('Session invalid for this server — pairing with a new PIN');
      Config.clearSessionToken(function() {
        State.setSessionToken(null);
        State.setLastError('Session expired. Reconnect and re-pair.');
      });
      State.setPairing(true);
      State.setPinRequired(true);
      notify({ type: 'pin-required' });
      scheduleReconnect(300);
      return;
    }
    if (event.code === CloseCode.FORGOTTEN || event.code === CloseCode.REMOVED || event.code === CloseCode.NAME_COLLISION) {
      // 4004 = forgotten (plan 60 B2); 4005 = name removed from navigator
      // and tombstoned; 4006 = name configured as a direct-CDP browser in
      // BROWSERS, so a relay may not claim it (plan 60 B6/B7). Drop our
      // stored token and stop without an auto-reconnect loop either way.
      const collision = event.code === CloseCode.NAME_COLLISION;
      const removed = event.code === CloseCode.REMOVED;
      Logger.warn(collision
        ? '[Connection] This browser name is configured as a direct browser on the server'
        : removed
          ? '[Connection] This browser name was removed on the server'
          : '[Connection] This browser was forgotten by the server');
      State.setConnecting(false);
      State.setConnected(false);
      State.setPairing(false);
      State.setPinRequired(false);
      State.setPinError(null);
      Config.clearSessionToken(function() {
        State.setSessionToken(null);
        State.setLastError(collision
          ? 'This browser name is configured as a direct browser in navigator — remove or rename its BROWSERS entry to pair it'
          : removed
            ? 'This browser was removed from navigator — add it back in Manage to pair again'
            : 'This browser was forgotten by navigator — connect again to re-pair');
      });
      ClearPending();
      notify({ type: 'connection-status-changed' });
      return;
    }
    if (event.code === CloseCode.SUPERSEDED) {
      // Another connection authenticated as this browser (a second instance
      // using the same pairing). Reconnecting would only take it back and
      // start a tug of war, so stop and leave auto-connect off until the
      // user connects again. The token stays valid.
      Logger.warn('[Connection] Another connection took over this browser\'s pairing');
      State.setConnecting(false);
      State.setPairing(false);
      State.setPinRequired(false);
      State.setLastError('Another connection took over this browser\'s pairing in navigator — connect again to take it back');
      ClearPending();
      Config.setAutoConnect(false);
      notify({ type: 'connection-status-changed' });
      return;
    }
    if (event.code === CloseCode.PIN_REJECTED) {
      Logger.info('[Connection] PIN no longer valid — reverting to previous pairing');
      State.setConnecting(false);
      State.setPairing(false);
      State.setPinRequired(false);
      State.setPinError(null);
      State.setLastError(null);
      ClearPending();
      notify({ type: 'connection-status-changed' });
      return;
    }

    // Everything else — a dropped socket, a navigator restart, a transient
    // handshake failure (HELLO_TIMEOUT / PROTOCOL_ERROR) — reconnects.
    State.setConnecting(false);
    scheduleBackoffReconnect();
  }

  function _handleMessage(data) {
    var text;
    if (data instanceof Blob) {
      data.text().then(function(t) {
        _dispatch(JSON.parse(t));
      }).catch(function(e) {
        Logger.error('[Connection] Failed to parse Blob:', e);
      });
      return;
    }
    _dispatch(JSON.parse(data));
  }

  function _dispatch(message) {
    Logger.info('[Connection] RECV:', JSON.stringify(message).substring(0, 200));

    switch (message.type) {
      case 'connected':
        State.setConnecting(false);
        State.setPairing(false);
        State.setPinRequired(false);
        State.setLastError(null);
        State.setPinError(null);
        State.setConnectedAt(Date.now());
        State.setConnected(true);
        Config.clearPendingConnecting();
        Backoff.reset();
        startHeartbeat();
        if (message.sessionToken) {
          State.setSessionToken(message.sessionToken);
          Config.saveSessionToken(message.sessionToken);
        }
        TabList.refresh();
        notify({ type: 'stateUpdate', connected: true });
        break;

      case 'pin_required':
        State.setConnecting(false);
        State.setPairing(true);
        State.setPinRequired(true);
        ClearPending();
        // A PIN typed while the socket was reconnecting can now be sent.
        var pendingPin = State.takePendingPin();
        if (pendingPin) {
          ConnectionManager.send({ type: 'pin', pin: pendingPin });
        }
        notify({ type: 'pin-required' });
        break;

      case 'pin_accepted':
        Logger.info('[Connection] PIN accepted');
        break;

      case 'ping':
        // navigator's heartbeat. Answering keeps its side of the liveness
        // check fed even when our own pings are delayed.
        send({ type: 'pong' });
        break;

      case 'pong':
        break;

      case 'client-connected':
        State.addCDPClient(message.clientId || 'navigator');
        notify({ type: 'stateUpdate', connected: true });
        break;

      case 'client-disconnected':
        State.removeCDPClient(message.clientId || 'navigator');
        notify({ type: 'stateUpdate' });
        break;

      case 'list_tabs_request':
        TabList.handleRequest();
        break;

      case 'detach_all':
        CDPSessionManager.detachAll().then(function() {
          ConnectionManager.send({ type: 'detach_all_result', success: true });
        });
        break;

      default:
        if (message.method) {
          routeCDPCommand(message);
        }
    }
  }

  return {
    connect: connect,
    disconnect: disconnect,
    send: send,
    updateDescription: updateDescription,
    notify: notify,
    addListener: addListener,
    keepalive: keepalive,
    isIdle: isIdle,
    CloseCode: CloseCode,
    get: get
  };
})();
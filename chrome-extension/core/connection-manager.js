var ConnectionManager = (function() {
  var _connection = null;
  var _listeners = [];
  var _intentionalDisconnect = false;

  // Identify which Chromium-based browser this extension is running in.
  // Edge/Opera/Vivaldi/Chromium mark their UA distinctly; Brave deliberately
  // mimics Chrome's UA, so it must be probed via navigator.brave.isBrave()
  // (async, resolves to true only inside Brave).
  function detectPlatform(done) {
    var ua = String(navigator.userAgent || '');
    var platform = 'chrome';
    if (/Edg\//.test(ua)) platform = 'edge';
    else if (/OPR\//.test(ua)) platform = 'opera';
    else if (/Vivaldi\//.test(ua)) platform = 'vivaldi';
    else if (/Chromium\//.test(ua)) platform = 'chromium';
    if (platform === 'chrome' && navigator.brave && typeof navigator.brave.isBrave === 'function') {
      try {
        Promise.resolve(navigator.brave.isBrave()).then(function (isBrave) {
          done(isBrave ? 'brave' : 'chrome');
        }, function () {
          done('chrome');
        });
        return;
      } catch (e) {}
    }
    done(platform);
  }

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
    // If user already gave a full URL with scheme, use it as-is (ensure /relay)
    if (input.indexOf('://') !== -1) {
      var url = input.replace(/\/+$/, '');
      if (url.indexOf('/relay') === -1) {
        url = url.replace(/\/$/, '') + '/relay';
      }
      // Also try the alternative scheme as fallback
      var alt = null;
      if (url.indexOf('wss://') === 0) alt = 'ws://' + url.substring(6);
      else if (url.indexOf('ws://') === 0) alt = 'wss://' + url.substring(5);
      else if (url.indexOf('https://') === 0) alt = 'http://' + url.substring(8);
      else if (url.indexOf('http://') === 0) alt = 'https://' + url.substring(7);
      return alt ? [url, alt] : [url];
    }
    // Bare host[:port] — strip any path the user pasted
    var hostPort = input.split('/')[0].trim();
    // Remove any trailing colon
    hostPort = hostPort.replace(/:+$/, '');
    if (!hostPort) return [];
    // Try secured first, then non-secured
    return ['wss://' + hostPort + '/relay', 'ws://' + hostPort + '/relay'];
  }

  function connect(options, callback) {
    options = options || {};

    _intentionalDisconnect = false;
    State.setConnecting(true);
    State.setConnected(false);

    Config.getServerUrl(function(serverUrl) {
      Config.getBrowserName(function(browserName) {
        Config.getSessionToken(function(sessionToken) {
          var rawUrl = options.serverUrl || serverUrl;
          if (!rawUrl) {
            Logger.error('[Connection] No relay URL configured');
            State.setLastError('No relay server URL configured — open the extension popup and set it');
            ClearPending();
            notify({ type: 'connection-status-changed' });
            if (callback) callback({ success: false, error: 'No relay server URL configured' });
            return;
          }

          var candidates = buildCandidateUrls(rawUrl);
          if (!candidates.length) {
            candidates = [String(rawUrl).trim()];
          }
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
              State.setLastError('Could not connect to ' + rawUrl + ' (tried ' + candidates.join(', ') + ')');
              State.setConnecting(false);
              ClearPending();
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
              // Try next immediately
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
                // onclose will trigger tryNext via _handleClose fallback
              }
            }, 4000);

            ws.onopen = function() {
              opened = true;
              clearTimeout(fallbackTimer);
              Logger.info('[Connection] WebSocket open via', wsUrl);
              State.setLastError(null);
              // Remember the successful URL (so next connect tries it first)
              Config.saveServerUrl(rawUrl);
              notify({ type: 'connection-status-changed' });

              detectPlatform(function(platform) {
                var msg = {
                  type: 'navigator-hello',
                  browserName: browserName,
                  platform: platform,
                  extensionVersion: chrome.runtime.getManifest().version
                };
                if (sessionToken) {
                  msg.sessionToken = sessionToken;
                  Logger.info('[Connection] Including session token');
                }
                ConnectionManager.send(msg);
                fireCallbackOnce({ success: true });
              });
            };

            ws.onclose = function(event) {
              clearTimeout(fallbackTimer);
              if (State.getWs() !== ws) {
                return;
              }
              Logger.info('[Connection] Closed for', wsUrl, ':', event.code, event.reason);
              State.setWs(null);
              State.clearHeartbeatTimer();
              State.setConnected(false);
              // If we never opened, try next candidate before giving up
              if (!opened && tried < candidates.length && !_intentionalDisconnect && event.code !== 4001 && event.code !== 4000) {
                Logger.info('[Connection] Falling back to next candidate');
                tryNext();
                return;
              }
              _handleClose(event);
              notify({ type: 'connection-status-changed' });
            };

            ws.onerror = function(error) {
              if (State.getWs() !== ws) return;
              Logger.error('[Connection] Error for', wsUrl, ':', error);
              // Let onclose handle fallback; just mark error
              State.setLastError('WebSocket error for ' + wsUrl);
              notify({ type: 'connection-status-changed' });
            };

            ws.onmessage = function(event) {
              _handleMessage(event.data);
            };
          }

          tryNext();
        });
      });
    });
  }

  function disconnect() {
    Logger.info('[Connection] Disconnecting');
    _intentionalDisconnect = true;
    State.clearReconnectTimer();
    State.clearHeartbeatTimer();
    State.setConnecting(false);
    State.setConnected(false);
    State.setPairing(false);
    State.setPinRequired(false);
    State.setLastError(null);
    State.setPinError(null);
    ClearPending();
    // The session token is deliberately KEPT: it is the one-time pairing
    // proof. A reconnect (manual or auto) presents it and the server
    // re-authenticates without a new PIN.
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
      Logger.info('[Connection] Reconnecting...');
      ConnectionManager.connect();
    }, delay);
    State.setReconnectTimer(timer);
  }

  function _handleClose(event) {
    if (_intentionalDisconnect) return;

    if (event.code === 4001) {
      // Stale/invalid session token — clear it and pair with a fresh PIN.
      Logger.warn('[Connection] Server rejected: bad session token');
      State.setConnecting(false);
      Config.clearSessionToken(function() {
        State.setSessionToken(null);
      });
      State.setPairing(true);
      State.setPinRequired(true);
      State.setPinError('Session invalid for this server — pairing with a new PIN');
      notify({ type: 'pin-required' });
      scheduleReconnect(300);
      return;
    }
    if (event.code === 4000) {
      // PIN no longer valid (wrong or expired) — don't show the
      // "expired — reconnect" UI. The previously paired browser (if any)
      // stays valid, so just revert to that state. No new PIN is issued
      // until the user explicitly tries to pair again.
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

    State.setConnecting(false);
    scheduleReconnect(Config.RECONNECT_DELAY);
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
        State.setConnected(true);
        State.setConnectedAt(Date.now());
        State.setPairing(false);
        State.setPinRequired(false);
        State.setLastError(null);
        State.setPinError(null);
        ClearPending();
        State.startHeartbeat();
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
        DebuggerManager.detachAll().then(function() {
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
    notify: notify,
    addListener: addListener,
    get: get
  };
})();

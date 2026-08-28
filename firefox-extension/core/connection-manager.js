var ConnectionManager = (function() {
  var _connection = null;
  var _listeners = [];
  var _intentionalDisconnect = false;

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
      var alt = null;
      if (url.indexOf('wss://') === 0) alt = 'ws://' + url.substring(6);
      else if (url.indexOf('ws://') === 0) alt = 'wss://' + url.substring(5);
      else if (url.indexOf('https://') === 0) alt = 'http://' + url.substring(8);
      else if (url.indexOf('http://') === 0) alt = 'https://' + url.substring(7);
      return alt ? [url, alt] : [url];
    }
    var hostPort = input.split('/')[0].trim().replace(/:+$/, '');
    if (!hostPort) return [];
    return ['wss://' + hostPort + '/relay', 'ws://' + hostPort + '/relay'];
  }

  function connect(options, callback) {
    options = options || {};
    _intentionalDisconnect = false;
    State.setConnecting(true);
    State.setLastError(null);
    notify({ type: 'connection-status-changed' });

    Config.getServerUrl(function(serverUrl) {
      Config.getBrowserName(function(browserName) {
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
                extensionVersion: chrome.runtime.getManifest().version
              };
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
              if (!opened && tried < candidates.length && !_intentionalDisconnect && event.code !== 4001 && event.code !== 4000) {
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

  function _handleClose(event) {
    if (_intentionalDisconnect) return;
    if (event.code === 4001) {
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
      var t1 = setTimeout(function() { ConnectionManager.connect(); }, 300);
      State.setReconnectTimer(t1);
      return;
    }
    if (event.code === 4000) {
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
    State.clearReconnectTimer();
    var timer = setTimeout(function() {
      Logger.info('[Connection] Reconnecting...');
      ConnectionManager.connect();
    }, Config.RECONNECT_DELAY);
    State.setReconnectTimer(timer);
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
        State.setLastError('PIN required from navigator console');
        ClearPending();
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
    notify: notify,
    addListener: addListener,
    get: get
  };
})();
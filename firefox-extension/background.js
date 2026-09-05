(function() {
  'use strict';

  var _initialized = false;

  // Firefox's chrome.* alias returns a Promise for some APIs and undefined for
  // others; never let a rejected broadcast break the message path.
  function broadcast(message) {
    try {
      var p = chrome.runtime.sendMessage(message);
      if (p && typeof p.catch === 'function') p.catch(function() {});
    } catch (e) {}
  }

  // The message listener is registered at module top-level (NOT gated on
  // init()) so it is always present on every event-page wake. Firefox MV3
  // suspends the background event page when idle; if the real listener is not
  // re-registered on wake, queued messages are dropped and the popup gets
  // "Could not establish connection. Receiving end does not exist." Keeping
  // this registration synchronous and unconditional avoids that race, even if
  // init() throws partway through (the listener would still exist).
  chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
      if (message && message.type === 'popup-query') {
        var state = State.getState();
        // The durable connection intent lives in storage (survives event-page
        // suspension); in-memory State is ephemeral and wipes on suspend.
        Config.getPendingConnecting(function(pending) {
          chrome.storage.local.get(['serverUrl', 'browserName', 'autoConnect', 'bidiUrl', 'sessionToken'], function(result) {
            if (pending.pending) {
              // A connect was in flight (or the popup closed during it).
              // Restore the attempted values + spinner from the durable flag.
              state.serverUrl = pending.serverUrl || result.serverUrl || '';
              state.browserName = pending.browserName || result.browserName || 'Firefox';
              if (!State.isConnecting() && !State.isConnected() && !State.isPairing()) {
                State.setConnecting(true);
              }
            } else {
              if (!state.serverUrl) state.serverUrl = result.serverUrl || '';
              if (!state.browserName) state.browserName = result.browserName || 'Firefox';
            }
            var allTabs = [];
            chrome.tabs.query({}, function(tabs) {
              allTabs = (tabs || []).map(function(tab) {
                var contextId = CDPSessionManager.contextIdForTab(tab.id);
                return {
                  tabId: tab.id,
                  id: tab.id,
                  title: tab.title || '',
                  url: tab.url || '',
                  active: tab.active,
                  attached: CDPSessionManager.isTabAttached(tab.id),
                  contextId: contextId || ''
                };
              });
              sendResponse({
                connected: State.isConnected(),
                connecting: pending.pending || State.isConnecting(),
                pairing: State.isPairing(),
                pinRequired: State.isPinRequired(),
                pinError: State.getPinError ? State.getPinError() : null,
                lastError: State.getLastError(),
                serverUrl: state.serverUrl || '',
                browserName: state.browserName || 'Firefox',
                autoConnect: result.autoConnect !== false,
                paired: !!result.sessionToken,
                hasToken: !!result.sessionToken,
                connectedAt: State.getConnectedAt(),
                cdpClients: State.getCDPClients(),
                tabs: allTabs,
                bidiConnected: BidiClient.isConnected(),
                bidiUrl: result.bidiUrl || Config.defaultBidiUrl,
                bidiError: State.getBidiError()
              });
            });
          });
        });
        return true;
      }

      // Ping/pong with popup to keep the event page alive
      if (message && message.type === 'ping') {
        sendResponse({ pong: true });
        return;
      }

      // Debug: test whether the target host:port is reachable at all.
      if (message && message.type === 'probe') {
        Probe.probe(message.hostPort || message.serverUrl || '').then(function(result) {
          var detail = result.ok
            ? ('Reached ' + (result.scheme || '?') + '://' + (result.hostPort || '') + ' — HTTP ' + result.status + (result.body ? ' · ' + result.body : ''))
            : (result.error || 'unreachable');
          Logger.info('[Probe] Result:', detail);
          sendResponse({ success: true, result: result, detail: detail });
        });
        return true;
      }

      if (message && message.type === 'connect') {
        // Optimistically update in-memory State so a popup that closes
        // and reopens during the async storage writes still sees the
        // attempted values and the connecting spinner.
        var st = State.getState();
        st.serverUrl = message.serverUrl || st.serverUrl || '';
        st.browserName = message.browserName || st.browserName || 'Firefox';
        State.setConnecting(true);
        State.setLastError(null);
        if (State.setPairing) State.setPairing(false);
        if (State.setPinRequired) State.setPinRequired(false);
        if (State.setPinError) State.setPinError(null);

        // Durable connection intent: persisted synchronously before the
        // async Config.save* chain starts, so an event-page suspend or a
        // popup close mid-connect still restores to Connecting… on reopen
        // (otherwise the popup comes back blank/Off — state was in-memory
        // only and got wiped).
        Config.setPendingConnecting(st.serverUrl, st.browserName);

        broadcast({ type: 'connection-status-changed' });
        Badge.update();
        Config.saveServerUrl(message.serverUrl || '', function() {
          Config.saveBrowserName(message.browserName || 'Firefox', function() {
            Config.setAutoConnect(true, function() {
              ConnectionManager.connect();
              Badge.update();
              sendResponse({ success: true });
            });
          });
        });
        return true;
      }

      if (message && message.type === 'disconnect') {
        Config.clearPendingConnecting();
        Config.setAutoConnect(false, function() {
          ConnectionManager.disconnect();
          Badge.update();
          sendResponse({ success: true });
        });
        return true;
      }

      if (message && message.type === 'send-pin') {
        var pin = String(message.pin || '');
        var sent = ConnectionManager.send({ type: 'pin', pin: pin });
        if (!sent) {
          // Socket is mid-reconnect (e.g. a previous PIN was rejected) —
          // stash the PIN and submit it once the fresh pin_required arrives.
          State.setPendingPin(pin);
          ConnectionManager.connect();
        }
        sendResponse({ success: true });
        return;
      }

      if (message && message.type === 'list-tabs') {
        TabList.handleRequest();
        sendResponse({ success: true });
        return;
      }

      // (Re)connect the BiDi WebSocket to Firefox's Remote Agent
      if (message && message.type === 'bidi-connect') {
        Config.saveBidiUrl(message.bidiUrl || '', function() {
          BidiClient.connect(message.bidiUrl || Config.defaultBidiUrl, function(res) {
            sendResponse({ success: !!res.success, error: res.error || null });
          });
        });
        return true;
      }

      if (message && message.type === 'bidi-disconnect') {
        BidiClient.disconnect();
        sendResponse({ success: true });
        return;
      }

      // Direct attach/detach to a user tab from the popup
      if (message && message.type === 'attach-tab') {
        CDPSessionManager.attachToTab(message.tabId).then(function() {
          sendResponse({ success: true });
        }).catch(function(e) {
          sendResponse({ success: false, error: String(e.message || e) });
        });
        return true;
      }

      if (message && message.type === 'detach-tab') {
        CDPSessionManager.detachForTab(message.tabId).then(function() {
          sendResponse({ success: true });
        });
        return true;
      }
    });

  // Connection + runtime listeners and durable-flag recovery (runs on every
  // wake once the message listener above is registered).
  function init() {
    // Only ever auto-connect when a pairing was actually completed before:
    // a saved URL AND a saved session token. Fresh installs / cleared server
    // URLs stay Off and wait for the user. Explicit disconnect disables
    // autoConnect until the next explicit Connect.
    function maybeAutoConnect() {
      Config.getAutoConnect(function(enabled) {
        if (enabled === false) return;
        Config.getServerUrl(function(url) {
          if (!url) {
            Logger.info('[Connection] No saved relay URL — waiting for user');
            return;
          }
          Config.getSessionToken(function(token) {
            if (!token) {
              Logger.info('[Connection] Never paired — waiting for user to connect');
              return;
            }
            ConnectionManager.connect();
          });
        });
      });
    }

    // If the background was suspended (or Firefox restarted) while a connect
    // was in flight, the durable pending-connecting flag survives in storage
    // where the in-memory WebSocket does not. Resume the attempt so the popup
    // doesn't sit at "Connecting…" forever with no live socket.
    function resumePendingConnect() {
      Config.getPendingConnecting(function(pending) {
        if (!pending.pending) return;
        Logger.info('[Connection] Resuming pending connect attempt for', pending.serverUrl);
        // Consume the flag immediately so a startup maybeAutoConnect (paired
        // path) and this don't both fire a connect in the same tick.
        Config.clearPendingConnecting();
        State.setConnecting(true);
        Config.getSessionToken(function(token) {
          // No token yet → this was a first-time pairing; pass the URL through
          // so connect() doesn't rely on saved serverUrl alone.
          if (!token && pending.serverUrl) {
            ConnectionManager.connect({ serverUrl: pending.serverUrl });
          } else {
            ConnectionManager.connect();
          }
        });
      });
    }

    // Auto connect on install
    chrome.runtime.onInstalled.addListener(function() {
      Logger.info('[Runtime] Installed/updated');
      maybeAutoConnect();
    });

    chrome.runtime.onStartup.addListener(function() {
      Logger.info('[Runtime] Browser started');
      maybeAutoConnect();
      resumePendingConnect();
    });

    chrome.alarms.onAlarm.addListener(function(alarm) {
      if (alarm.name === 'keepalive') {
        var ws = State.getWs();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ConnectionManager.send({ type: 'ping' });
        }
      }
    });

    chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });

    maybeAutoConnect();
    resumePendingConnect();

    // Try the BiDi connection on startup (Firefox must be launched with
    // --remote-debugging-port — see launch-firefox.sh). The popup has a
    // "Connect BiDi" button for retries when Firefox wasn't running yet.
    Config.getBidiUrl(function(bidiUrl) {
      BidiClient.connect(bidiUrl || Config.defaultBidiUrl);
    });
  }

  init();
})();
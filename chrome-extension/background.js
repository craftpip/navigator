importScripts('utils/config.js');
importScripts('utils/logger.js');
importScripts('utils/helpers.js');
importScripts('core/state.js');
importScripts('core/connection-manager.js');
importScripts('core/debugger.js');
importScripts('cdp/response.js');
importScripts('cdp/handler/local.js');
importScripts('cdp/handler/special.js');
importScripts('cdp/handler/forward.js');
importScripts('cdp/index.js');
importScripts('features/tab-list.js');
importScripts('features/tab-isolation.js');
importScripts('features/badge.js');

(function() {
  'use strict';

  var _initialized = false;

  function init() {
    if (_initialized) {
      Logger.info('[Init] Already initialized');
      return;
    }
    _initialized = true;
    Logger.info('[Init] Navigator Browser Relay starting...');

    // State broadcasts → badge + popup
    ConnectionManager.addListener(function(message) {
      Badge.update();
      chrome.runtime.sendMessage(message).catch(function() {});
    });

    // chrome.debugger event → forwarded to navigator
    chrome.debugger.onEvent.addListener(function(source, method, params) {
      DebuggerManager.handleDebuggerEvent(source, method, params);
    });

    // chrome.debugger detach → cleanup internal state
    chrome.debugger.onDetach.addListener(function(source, reason) {
      DebuggerManager.handleDetach(source, reason);
    });

    // Navigate browser to pin_required on connection status change
    chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
      if (message && message.type === 'popup-query') {
        var state = State.getState();
        // The durable connection intent lives in storage (survives
        // service-worker termination); in-memory State is ephemeral.
        Config.getPendingConnecting(function(pending) {
          chrome.storage.local.get(['serverUrl', 'browserName', 'autoConnect', 'sessionToken'], function(result) {
            if (pending.pending) {
              // A connect was in flight (or the popup closed during it).
              // Restore the attempted values + spinner from the durable flag.
              state.serverUrl = pending.serverUrl || result.serverUrl || '';
              state.browserName = pending.browserName || result.browserName || 'Chrome';
              if (!State.isConnecting() && !State.isConnected() && !State.isPairing()) {
                State.setConnecting(true);
              }
            } else {
              if (!state.serverUrl) state.serverUrl = result.serverUrl || '';
              if (!state.browserName) state.browserName = result.browserName || 'Chrome';
            }
            var attachedIds = State.getAttachedTabIds();
            var allTabs = [];
            var pendingAttached = attachedIds.length;

            // First assemble attached pages, then list all tabs
            var buildSnapshot = function() {
              chrome.tabs.query({}, function(tabs) {
                var all = (tabs || []).map(function(tab) {
                  return {
                    tabId: tab.id,
                    id: tab.id,
                    title: tab.title || '',
                    url: tab.url || '',
                    active: tab.active,
                    groupId: tab.groupId != null ? tab.groupId : -1,
                    attached: attachedIds.indexOf(tab.id) >= 0
                  };
                });
                sendResponse({
                  connected: State.isConnected(),
                  connecting: pending.pending || State.isConnecting(),
                  pairing: State.isPairing(),
                  pinRequired: State.isPinRequired(),
                  pinError: State.getPinError(),
                  lastError: State.getLastError(),
                  serverUrl: state.serverUrl || result.serverUrl || '',
                  browserName: state.browserName || result.browserName || 'Chrome',
                  autoConnect: result.autoConnect !== false,
                  paired: !!result.sessionToken,
                  hasToken: !!result.sessionToken,
                  connectedAt: State.getConnectedAt(),
                  cdpClients: State.getCDPClients(),
                  attachedPages: all.filter(function(t) { return t.attached; }),
                  tabs: all
                });
              });
            };

            if (pendingAttached === 0) {
              buildSnapshot();
              return;
            }
            // Just wait a tick to also read attached tab titles from chrome.tabs
            setTimeout(buildSnapshot, 0);
          });
        });
        return true;
      }

      // Ping/pong with popup to keep SW alive
      if (message && message.type === 'ping') {
        sendResponse({ pong: true });
        return;
      }

      if (message && message.type === 'connect') {
        // Optimistically update in-memory State so a popup that closes
        // and reopens during the async storage writes still sees the
        // attempted values and the connecting spinner.
        var st = State.getState();
        st.serverUrl = message.serverUrl || st.serverUrl || '';
        st.browserName = message.browserName || st.browserName || 'Chrome';
        State.setConnecting(true);
        State.setLastError(null);
        State.setConnected(false);
        State.setPairing(false);
        State.setPinRequired(false);
        State.setPinError(null);

        // Durable connection intent: persisted before the async Config.save*
        // chain starts, so a service-worker kill / popup close mid-connect
        // still restores to Connecting… on reopen (in-memory State alone
        // would be wiped and leave the popup blank).
        Config.setPendingConnecting(st.serverUrl, st.browserName);

        ConnectionManager.notify({ type: 'connection-status-changed' });
        Badge.update();
        Config.saveServerUrl(message.serverUrl || '', function() {
          Config.saveBrowserName(message.browserName || 'Chrome', function() {
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

      // Direct attach/detach to a user tab from the popup
      if (message && message.type === 'attach-tab') {
        DebuggerManager.attach(message.tabId).then(function(success) {
          sendResponse({ success: success });
        });
        return true;
      }

      if (message && message.type === 'detach-tab') {
        DebuggerManager.detach(message.tabId).then(function() {
          sendResponse({ success: true });
        });
        return true;
      }
    });

    // Auto connect on install
    chrome.runtime.onInstalled.addListener(function() {
      Logger.info('[Runtime] Installed/updated');
      maybeAutoConnect();
    });

    chrome.runtime.onStartup.addListener(function() {
      Logger.info('[Runtime] Browser started');
      Config.getAutoConnect(function(enabled) {
        if (enabled !== false) {
          maybeAutoConnect();
        }
      });
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

    // Keep the SW alive via periodic alarm + heartbeat
    chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });

    // Only ever auto-connect when a pairing was actually completed before:
    // a saved URL AND a saved session token. Fresh installs / cleared server
    // URLs stay Off and wait for the user.
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

    // If the service worker was terminated while a connect was in flight, the
    // durable pending-connecting flag survives in storage where the in-memory
    // WebSocket does not. Resume the attempt so the popup doesn't sit at
    // "Connecting…" forever with no live socket.
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

    maybeAutoConnect();
    resumePendingConnect();
  }

  init();
})();
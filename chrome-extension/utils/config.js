var Config = {
  RECONNECT_DELAY: 3000,
  HEARTBEAT_INTERVAL: 25000,
  BADGE_COLORS: {
    CONNECTED: '#4CAF50',
    PAIRING: '#FF9800',
    ERROR: '#F44336',
    OFF: '#9E9E9E'
  },
  PIN_EXPIRY_MS: 60000,
  DEBUG: true,

  getServerUrl: function(callback) {
    chrome.storage.local.get(['serverUrl'], function(result) {
      callback(result.serverUrl || '');
    });
  },

  saveServerUrl: function(url, callback) {
    chrome.storage.local.set({ serverUrl: url }, callback || function() {});
  },

  getBrowserName: function(callback) {
    chrome.storage.local.get(['browserName'], function(result) {
      callback(result.browserName || 'Chrome');
    });
  },

  saveBrowserName: function(name, callback) {
    chrome.storage.local.set({ browserName: name }, callback || function() {});
  },

  getSessionToken: function(callback) {
    chrome.storage.local.get(['sessionToken'], function(result) {
      callback(result.sessionToken || null);
    });
  },

  saveSessionToken: function(token, callback) {
    chrome.storage.local.set({ sessionToken: token }, callback || function() {});
  },

  clearSessionToken: function(callback) {
    chrome.storage.local.remove('sessionToken', callback || function() {});
  },

  getAutoConnect: function(callback) {
    chrome.storage.local.get(['autoConnect'], function(result) {
      callback(result.autoConnect !== false);
    });
  },

  setAutoConnect: function(enabled, callback) {
    chrome.storage.local.set({ autoConnect: enabled }, callback || function() {});
  },

  // A durable "connection intent" flag: survives service-worker termination.
  // Written synchronously-ish in the 'connect' handler BEFORE the async
  // Config.save* chain, so a popup that closes (or a background that is
  // killed) mid-connect still restores to Connecting… / the attempted
  // values on next open, instead of the blank Off state.
  setPendingConnecting: function(serverUrl, browserName, callback) {
    chrome.storage.local.set({
      _pendingServerUrl: serverUrl || '',
      _pendingBrowserName: browserName || '',
      _pendingConnecting: true
    }, callback || function() {});
  },

  clearPendingConnecting: function(callback) {
    chrome.storage.local.remove(
      ['_pendingConnecting', '_pendingServerUrl', '_pendingBrowserName'],
      callback || function() {}
    );
  },

  getPendingConnecting: function(callback) {
    chrome.storage.local.get(
      ['_pendingConnecting', '_pendingServerUrl', '_pendingBrowserName'],
      function(result) {
        callback({
          pending: !!result._pendingConnecting,
          serverUrl: result._pendingServerUrl || '',
          browserName: result._pendingBrowserName || ''
        });
      }
    );
  }
};

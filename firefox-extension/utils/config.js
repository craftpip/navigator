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
      callback(result.browserName || 'Firefox');
    });
  },

  saveBrowserName: function(name, callback) {
    chrome.storage.local.set({ browserName: name }, callback || function() {});
  },

  // The browser's own words to the AI. Authored here, in the popup that the
  // person who actually uses this browser sees, and read by the model in
  // list_browsers / Target.getTargets. Empty means "no description".
  getBrowserDescription: function(callback) {
    chrome.storage.local.get(['browserDescription'], function(result) {
      callback(result.browserDescription || '');
    });
  },

  saveBrowserDescription: function(description, callback) {
    chrome.storage.local.set({ browserDescription: description || '' }, callback || function() {});
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

  // A durable "connection intent" flag: survives event-page suspension.
  // Written synchronously-ish in the 'connect' handler BEFORE the async
  // Config.save* chain, so a popup that closes (or a background that
  // suspends) mid-connect still restores to Connecting… / the attempted
  // values on next open, instead of the blank Off state.
  setPendingConnecting: function(serverUrl, browserName, browserDescription, callback) {
    // 3-arg back-compat: older callers pass a callback as the 3rd argument.
    if (typeof browserDescription === 'function') {
      callback = browserDescription;
      browserDescription = '';
    }
    chrome.storage.local.set({
      _pendingServerUrl: serverUrl || '',
      _pendingBrowserName: browserName || '',
      _pendingBrowserDescription: browserDescription || '',
      _pendingConnecting: true
    }, callback || function() {});
  },

  clearPendingConnecting: function(callback) {
    chrome.storage.local.remove(
      ['_pendingConnecting', '_pendingServerUrl', '_pendingBrowserName', '_pendingBrowserDescription'],
      callback || function() {}
    );
  },

  getPendingConnecting: function(callback) {
    chrome.storage.local.get(
      ['_pendingConnecting', '_pendingServerUrl', '_pendingBrowserName', '_pendingBrowserDescription'],
      function(result) {
        callback({
          pending: !!result._pendingConnecting,
          serverUrl: result._pendingServerUrl || '',
          browserName: result._pendingBrowserName || '',
          browserDescription: result._pendingBrowserDescription || ''
        });
      }
    );
  },

  getBidiUrl: function(callback) {
    chrome.storage.local.get(['bidiUrl'], function(result) {
      callback(result.bidiUrl || '');
    });
  },

  saveBidiUrl: function(url, callback) {
    chrome.storage.local.set({ bidiUrl: url }, callback || function() {});
  },

  getOpenInWindow: function(callback) {
    chrome.storage.local.get(['openInWindow'], function(result) {
      callback(result.openInWindow === true);
    });
  },

  setOpenInWindow: function(enabled, callback) {
    chrome.storage.local.set({ openInWindow: !!enabled }, callback || function() {});
  },

  promisifiedGetOpenInWindow: function() {
    return new Promise(function(resolve) {
      Config.getOpenInWindow(resolve);
    });
  },

  defaultWsUrl: 'ws://localhost:1994/relay',
  defaultBidiUrl: 'ws://127.0.0.1:9222/session'
};
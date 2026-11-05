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

  // Random two-word default (e.g. "amber-falcon") instead of a fixed
  // "Chrome"/"Firefox": the name is this browser's identity on the navigator
  // server, so two browsers both left on the default would collide. Generated
  // once, saved, and reused — it only changes when the user types a new name.
  _NAME_ADJECTIVES: ['amber', 'bold', 'brisk', 'calm', 'clever', 'cosmic', 'crimson', 'dapper', 'eager', 'electric',
    'fancy', 'frosty', 'gentle', 'golden', 'happy', 'hidden', 'icy', 'jolly', 'keen', 'lively',
    'lucky', 'lunar', 'mellow', 'misty', 'nimble', 'noble', 'odd', 'olive', 'plucky', 'polar',
    'quick', 'quiet', 'rapid', 'royal', 'rusty', 'shiny', 'silent', 'silver', 'sly', 'snowy',
    'solar', 'spicy', 'steady', 'sunny', 'swift', 'teal', 'tidy', 'tiny', 'vivid', 'wild',
    'witty', 'zesty', 'azure', 'breezy', 'cheery', 'dusty', 'fuzzy', 'grand', 'hazy', 'jade',
    'mighty', 'proud', 'ruby', 'velvet'],
  _NAME_NOUNS: ['badger', 'beacon', 'bison', 'canyon', 'comet', 'condor', 'coral', 'cricket', 'dolphin', 'eagle',
    'falcon', 'ferret', 'fjord', 'fox', 'gecko', 'glacier', 'harbor', 'hawk', 'heron', 'jaguar',
    'koala', 'lagoon', 'lemur', 'lynx', 'maple', 'meadow', 'meteor', 'moose', 'nebula', 'newt',
    'oasis', 'orca', 'otter', 'owl', 'panda', 'pebble', 'pine', 'puffin', 'quokka', 'raven',
    'reef', 'river', 'robin', 'sparrow', 'summit', 'tiger', 'toucan', 'tundra', 'valley', 'walrus',
    'willow', 'wombat', 'yak', 'zebra', 'acorn', 'bramble', 'cedar', 'delta', 'ember', 'grove',
    'island', 'marten', 'pelican', 'thistle'],

  randomBrowserName: function() {
    function pick(list) {
      var n = 0;
      try {
        var buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        n = buf[0];
      } catch (e) {
        n = Math.floor(Math.random() * 4294967296);
      }
      return list[n % list.length];
    }
    return pick(Config._NAME_ADJECTIVES) + '-' + pick(Config._NAME_NOUNS);
  },

  getBrowserName: function(callback) {
    chrome.storage.local.get(['browserName'], function(result) {
      var name = String(result.browserName || '').trim();
      if (name) {
        callback(name);
        return;
      }
      name = Config.randomBrowserName();
      chrome.storage.local.set({ browserName: name }, function() { callback(name); });
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

  // A durable "connection intent" flag: survives service-worker termination.
  // Written synchronously-ish in the 'connect' handler BEFORE the async
  // Config.save* chain, so a popup that closes (or a background that is
  // killed) mid-connect still restores to Connecting… / the attempted
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
  }
};

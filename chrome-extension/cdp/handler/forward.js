var ForwardHandler = (function() {
  var SYNTHETIC_INPUT_METHODS = [
    'Input.dispatchKeyEvent',
    'Input.dispatchMouseEvent',
    'Input.dispatchTouchEvent'
  ];

  function execute(context) {
    var method = context.method;
    var params = context.params || {};
    var sessionId = context.sessionId;
    var state = context._state;
    var tabId = context.tabId || resolveTabIdFromState(sessionId, state);

    if (!tabId) {
      return Promise.reject({ code: -32000, message: 'No target found for command: ' + method });
    }

    if (state && state.isTabAttached && !state.isTabAttached(tabId)) {
      Logger.warn('[Forward] Tab not attached, skipping:', method, tabId);
      return Promise.reject({ code: -32000, message: 'Tab not attached: ' + tabId });
    }

    return ensureVisibleFor(method, tabId, params).then(function() {
      return chrome.debugger.sendCommand({ tabId: tabId }, method, params).then(function(result) {
        return result || {};
      });
    });
  }

  function ensureVisibleFor(method, tabId, params) {
    var needsVisible = SYNTHETIC_INPUT_METHODS.indexOf(method) >= 0 ||
      (method === 'Page.captureScreenshot' && params && params.clip);
    if (!needsVisible) return Promise.resolve();

    return new Promise(function(resolve) {
      chrome.tabs.get(tabId, function(tab) {
        if (chrome.runtime.lastError || !tab) { resolve(tabId); return; }
        if (!tab.active) {
          chrome.tabs.update(tabId, { active: true }, function() {
            resolve(tabId);
          });
        } else {
          resolve(tabId);
        }
      });
    });
  }

  function resolveTabIdFromSession(sessionId, state) {
    if (sessionId && state && state.sessionIdToTabId && state.sessionIdToTabId.has(sessionId)) {
      return state.sessionIdToTabId.get(sessionId);
    }
    return null;
  }

  function resolveTabIdFromState(sessionId, state) {
    if (sessionId && state && state.sessionIdToTabId && state.sessionIdToTabId.has(sessionId)) {
      return state.sessionIdToTabId.get(sessionId);
    }
    if (state && state.getCurrentTabId) {
      return state.getCurrentTabId();
    }
    return null;
  }

  return {
    execute: execute
  };
})();

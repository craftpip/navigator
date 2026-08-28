var ForwardHandler = (function() {
  var SYNTHETIC_INPUT_METHODS = [
    'Input.dispatchKeyEvent',
    'Input.dispatchMouseEvent',
    'Input.insertText'
  ];

  function execute(context) {
    var method = context.method;
    var params = context.params || {};
    var sessionId = context.sessionId;
    var state = context._state;

    return resolveMapping(sessionId, context.tabId, state).then(function(mapping) {
      if (!mapping || !mapping.contextId) {
        return Promise.reject({ code: -32000, message: 'No target found for command: ' + method });
      }

      if (!Mapper.isMapped(method)) {
        return Promise.reject(Mapper.unsupportedMethod(method));
      }

      var translated;
      try {
        translated = Mapper.translateCommand(method, params, mapping.contextId);
      } catch (e) {
        return Promise.reject({ code: e.code || -32601, message: e.message || String(e) });
      }

      // Local no-op routes (Network.enable, Runtime.enable, ...).
      if (translated === null) {
        return Mapper.transformCommandResult(method, {});
      }

      return ensureVisibleFor(method, mapping).then(function() {
        return BidiClient.send(translated.method, translated.params).then(function(result) {
          return Mapper.transformCommandResult(method, result);
        });
      });
    });
  }

  function resolveMapping(sessionId, tabId, state) {
    if (sessionId) {
      var m = CDPSessionManager.findBySession(sessionId);
      if (m) return Promise.resolve(m);
    }
    if (tabId) {
      return CDPSessionManager.attachToTab(tabId).catch(function() {
        return Promise.resolve(null);
      });
    }
    var currentTabId = state && state.getCurrentTabId && state.getCurrentTabId();
    if (currentTabId) {
      return CDPSessionManager.attachToTab(currentTabId).catch(function() {
        return Promise.resolve(null);
      });
    }
    return Promise.resolve(null);
  }

  /** Input and clipped screenshots need the tab active (hidden tabs can't receive input). */
  function ensureVisibleFor(method, mapping) {
    if (!mapping.tabId) return Promise.resolve();
    var needsVisible = SYNTHETIC_INPUT_METHODS.indexOf(method) >= 0;
    if (!needsVisible) return Promise.resolve();
    return new Promise(function(resolve) {
      chrome.tabs.update(mapping.tabId, { active: true }, function() {
        resolve();
      });
    });
  }

  return {
    execute: execute
  };
})();
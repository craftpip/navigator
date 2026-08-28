var TabIsolation = (function() {
  var NAVIGATOR_PREFIX = 'Navigator';

  /**
   * Firefox has no chrome.tabGroups — the closest to "don't clutter my tab
   * bar" is tabs.hide() (tabHide permission), which collapses automation tabs
   * out of the tab strip. Hidden tabs keep running and remain addressable via
   * BiDi (input activation handled in ForwardHandler.ensureVisibleFor).
   */
  function hasHideSupport() {
    return typeof chrome.tabs.hide === 'function';
  }

  function isolate(tabId) {
    if (!hasHideSupport()) return;
    chrome.tabs.hide([tabId], function() {
      if (chrome.runtime.lastError) {
        Logger.warn('[TabIsolation] hide failed:', tabId, chrome.runtime.lastError.message);
      }
    });
  }

  function unisolate(tabId) {
    if (!hasHideSupport()) return;
    chrome.tabs.show([tabId], function() {
      if (chrome.runtime.lastError) {
        Logger.warn('[TabIsolation] show failed:', tabId, chrome.runtime.lastError.message);
      }
    });
  }

  return {
    NAVIGATOR_PREFIX: NAVIGATOR_PREFIX,
    hasHideSupport: hasHideSupport,
    isolate: isolate,
    unisolate: unisolate
  };
})();
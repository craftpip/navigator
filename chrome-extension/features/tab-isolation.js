var TabIsolation = (function() {
  var NAVIGATOR_PREFIX = 'Navigator';

  function ensureGroup(windowId, callback) {
    Config.getBrowserName(function(browserName) {
      var expectedName = NAVIGATOR_PREFIX + ': ' + (browserName || 'Chrome');
      chrome.tabGroups.query({ windowId: windowId }, function(groups) {
        if (chrome.runtime.lastError || !groups) { callback(null); return; }
        var existing = CDPUtils.findGroupByName(groups, expectedName) ||
          CDPUtils.findGroupByName(groups, expectedName.replace(/:.*$/, ''));
        if (existing) { callback(existing.id); return; }
        chrome.tabs.group({ createProperties: { windowId: windowId } }, function(groupId) {
          if (chrome.runtime.lastError || !groupId) { callback(null); return; }
          chrome.tabGroups.update(groupId, {
            title: expectedName,
            color: CDPUtils.getGroupColor(),
            collapsed: true
          }, function() {
            if (chrome.runtime.lastError) {
              Logger.warn('[TabIsolation] Failed to set group title:', chrome.runtime.lastError.message);
            }
            callback(groupId);
          });
        });
      });
    });
  }

  function groupTab(tabId, callback) {
    if (!chrome.tabGroups) { callback && callback(); return; }
    chrome.tabs.get(tabId, function(tab) {
      if (chrome.runtime.lastError || !tab) { callback && callback(); return; }
      var windowId = tab.windowId;
      ensureGroup(windowId, function(groupId) {
        if (!groupId) { callback && callback(); return; }
        chrome.tabs.group({ tabIds: tabId, groupId: groupId }, function() {
          if (chrome.runtime.lastError) {
            Logger.warn('[TabIsolation] Failed to group tab:', tabId, chrome.runtime.lastError.message);
          }
          callback && callback();
        });
      });
    });
  }

  function isolate(tabId) {
    groupTab(tabId);
  }

  return {
    NAVIGATOR_PREFIX: NAVIGATOR_PREFIX,
    ensureGroup: ensureGroup,
    groupTab: groupTab,
    isolate: isolate
  };
})();
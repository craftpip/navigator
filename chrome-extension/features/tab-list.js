var TabList = (function() {
  /**
   * Get all open tabs as CDP-style targetInfos.
   * targetId = numeric tab.id for simplicity (matches cdp's tab-based routing).
   */
  function getAllAsTargets(callback) {
    chrome.debugger.getTargets(function(targets) {
      if (chrome.runtime.lastError) {
        callback(targets || []);
        return;
      }
      var pageTargets = (targets || []).filter(function(t) { return t.type === 'page' && t.tabId; });
      var nonPage = (targets || []).filter(function(t) { return t.type !== 'page'; });

      var targetInfos = nonPage.map(mapToTargetInfo);

      if (pageTargets.length === 0) {
        callback(targetInfos);
        return;
      }

      var checked = 0;
      pageTargets.forEach(function(target) {
        var tabId = target.tabId;
        chrome.tabs.get(tabId, function(tab) {
          checked++;
          if (!chrome.runtime.lastError && tab) {
            target.openerId = tab.openerTabId != null ? String(tab.openerTabId) : undefined;
            targetInfos.push(mapToTargetInfo(target));
          }
          if (checked === pageTargets.length) {
            callback(targetInfos);
          }
        });
      });
    });
  }

  function getTargetInfoById(targetId) {
    return new Promise(function(resolve) {
      chrome.debugger.getTargets(function(targets) {
        if (chrome.runtime.lastError) { resolve(null); return; }
        var match = (targets || []).find(function(t) {
          return t.id === targetId || String(t.tabId) === String(targetId);
        });
        if (!match) { resolve(null); return; }
        var tabId = match.tabId;
        if (!tabId) { resolve(mapToTargetInfo(match)); return; }
        chrome.tabs.get(tabId, function(tab) {
          if (chrome.runtime.lastError || !tab) { resolve(mapToTargetInfo(match)); return; }
          match.openerId = tab.openerTabId != null ? String(tab.openerTabId) : undefined;
          resolve(mapToTargetInfo(match));
        });
      });
    });
  }

  function mapToTargetInfo(target) {
    if (!target) return null;
    return {
      targetId: target.id || String(target.tabId),
      type: target.type || 'page',
      title: target.title || '',
      url: target.url || 'about:blank',
      attached: !!target.attached,
      canAccessOpener: false,
      openerId: target.openerId,
      browserContextId: 'default',
      tabId: target.tabId || null
    };
  }

  /**
   * Respond to navigator's list_tabs_request with the full tab list.
   */
  function handleRequest() {
    getAllAsTargets(function(targetInfos) {
      ConnectionManager.send({
        type: 'tab_list',
        tabs: targetInfos
      });
    });
  }

  function refresh() {
    if (!State.isConnected()) return;
    handleRequest();
  }

  return {
    getAllAsTargets: getAllAsTargets,
    getTargetInfoById: getTargetInfoById,
    mapToTargetInfo: mapToTargetInfo,
    handleRequest: handleRequest,
    refresh: refresh
  };
})();
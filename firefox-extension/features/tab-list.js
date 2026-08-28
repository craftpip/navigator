var TabList = (function() {
  /**
   * Get all open tabs as CDP-style targetInfos.
   * targetId = BiDi context id when known, else a 'tab-<n>' handle.
   * Unlike the Chrome extension there is no chrome.debugger.getTargets — the
   * tab list comes from the tabs API + the context/tab correlation in
   * CDPSessionManager.
   */
  function getAllAsTargets(callback) {
    chrome.tabs.query({}, function(tabs) {
      var list = (tabs || []).map(function(tab) {
        var contextId = CDPSessionManager.contextIdForTab(tab.id);
        return mapToTargetInfo({
          id: contextId || CDPUtils.tabTargetId(tab.id),
          tabId: tab.id,
          type: 'page',
          title: tab.title || '',
          url: tab.url || 'about:blank',
          attached: CDPSessionManager.isTabAttached(tab.id),
          openerId: tab.openerTabId != null ? String(tab.openerTabId) : undefined
        });
      });

      // BiDi contexts that don't map to a tab yet still appear as targets.
      CDPSessionManager.getUnpairedContexts().forEach(function(contextId) {
        list.push(mapToTargetInfo({
          id: contextId,
          tabId: null,
          type: 'page',
          title: '',
          url: 'about:blank',
          attached: CDPSessionManager.isContextAttached(contextId)
        }));
      });

      callback(list);
    });
  }

  function getTargetInfoById(targetId) {
    return new Promise(function(resolve) {
      getAllAsTargets(function(list) {
        var match = (list || []).find(function(t) {
          return String(t.targetId) === String(targetId) ||
            (t.tabId != null && String(t.tabId) === String(targetId));
        });
        resolve(match || null);
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
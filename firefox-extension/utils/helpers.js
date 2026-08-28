var CDPUtils = {
  generateSessionId: function() {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 10);
  },

  /**
   * CDP target id for a tab that has no known BiDi context yet.
   * Once the context is discovered, real target ids are BiDi context ids,
   * so this prefix form is only a temporary handle.
   */
  tabTargetId: function(tabId) {
    return 'tab-' + tabId;
  },

  parseTabTargetId: function(targetId) {
    if (typeof targetId === 'string' && /^tab-\d+$/.test(targetId)) {
      return parseInt(targetId.slice(4), 10);
    }
    if (typeof targetId === 'number') return targetId;
    if (typeof targetId === 'string' && /^\d+$/.test(targetId)) return parseInt(targetId, 10);
    return null;
  }
};
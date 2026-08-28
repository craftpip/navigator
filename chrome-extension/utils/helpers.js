var CDPUtils = {
  generateSessionId: function() {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 10);
  },

  getGroupBaseName: function(clientId, browserName) {
    return 'Navigator: ' + (browserName || 'Chrome');
  },

  getGroupColor: function() {
    return 'blue';
  },

  findGroupByName: function(groups, name) {
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].title === name) return groups[i];
    }
    return null;
  }
};

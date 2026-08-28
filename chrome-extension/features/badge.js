var Badge = (function() {
  var COLORS = Config.BADGE_COLORS;

  function update() {
    var status;
    if (State.isConnected()) {
      status = 'ON';
    } else if (State.isPairing()) {
      status = 'PAIR';
    } else if (State.getLastError()) {
      status = 'ERR';
    } else {
      status = 'OFF';
    }

    chrome.action.setBadgeText({ text: status });
    chrome.action.setBadgeBackgroundColor({ color: COLORS[status] || COLORS.OFF });
    return status;
  }

  function clear() {
    chrome.action.setBadgeText({ text: '' });
  }

  return {
    update: update,
    clear: clear
  };
})();
var State = (function() {
  var _state = {
    ws: null,
    connected: false,
    connecting: false,
    pairing: false,
    pinRequired: false,
    sessionToken: null,
    pendingPin: null,
    pinError: null,
    browserName: 'Chrome',
    serverUrl: '',
    reconnectTimer: null,
    heartbeatTimer: null,
    lastError: null,
    attachedTabIds: new Set(),
    cdpCreatedTabIds: new Set(),
    cdpClients: [],
    activeTargetId: null,
    currentTabId: null,
    connectedAt: null
  };

  function getState() {
    return _state;
  }

  function setWs(ws) {
    _state.ws = ws;
  }

  function getWs() {
    return _state.ws;
  }

  function isConnected() {
    return _state.connected;
  }

  function setConnected(val) {
    _state.connected = Boolean(val);
  }

  function isConnecting() {
    return _state.connecting;
  }

  function setConnecting(val) {
    _state.connecting = Boolean(val);
  }

  function isPairing() {
    return _state.pairing;
  }

  function setPairing(val) {
    _state.pairing = val;
  }

  function setPinRequired(val) {
    _state.pinRequired = val;
  }

  function isPinRequired() {
    return _state.pinRequired;
  }

  function setSessionToken(token) {
    _state.sessionToken = token;
  }

  function getSessionToken() {
    return _state.sessionToken;
  }

  function setPendingPin(pin) {
    _state.pendingPin = pin;
  }

  function takePendingPin() {
    var pin = _state.pendingPin;
    _state.pendingPin = null;
    return pin;
  }

  function setPinError(msg) {
    _state.pinError = msg ? String(msg) : null;
  }

  function getPinError() {
    return _state.pinError;
  }

  function setLastError(err) {
    _state.lastError = err ? String(err) : null;
  }

  function getLastError() {
    return _state.lastError;
  }

  function clearReconnectTimer() {
    if (_state.reconnectTimer) {
      clearTimeout(_state.reconnectTimer);
      _state.reconnectTimer = null;
    }
  }

  function setReconnectTimer(timer) {
    _state.reconnectTimer = timer;
  }

  function getReconnectTimer() {
    return _state.reconnectTimer;
  }

  function clearHeartbeatTimer() {
    if (_state.heartbeatTimer) {
      clearInterval(_state.heartbeatTimer);
      _state.heartbeatTimer = null;
    }
  }

  function startHeartbeat() {
    State.clearHeartbeatTimer();
    _state.heartbeatTimer = setInterval(function() {
      var ws = State.getWs();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ConnectionManager.send({ type: 'ping' });
      }
    }, Config.HEARTBEAT_INTERVAL);
  }

  function addAttachedTab(tabId) {
    _state.attachedTabIds.add(tabId);
  }

  function removeAttachedTab(tabId) {
    _state.attachedTabIds.delete(tabId);
  }

  function isTabAttached(tabId) {
    return _state.attachedTabIds.has(tabId);
  }

  function getAttachedTabIds() {
    return Array.from(_state.attachedTabIds);
  }

  function addCDPCreatedTab(tabId) {
    _state.cdpCreatedTabIds.add(tabId);
  }

  function removeCDPCreatedTab(tabId) {
    _state.cdpCreatedTabIds.delete(tabId);
  }

  function isCDPCreatedTab(tabId) {
    return _state.cdpCreatedTabIds.has(tabId);
  }

  function getCDPCreatedTabIds() {
    return Array.from(_state.cdpCreatedTabIds);
  }

  function setCurrentTabId(tabId) {
    _state.currentTabId = tabId;
  }

  function getCurrentTabId() {
    return _state.currentTabId;
  }

  function addCDPClient(clientId) {
    var exists = false;
    for (var i = 0; i < _state.cdpClients.length; i++) {
      if (_state.cdpClients[i].id === clientId) { exists = true; break; }
    }
    if (!exists) {
      _state.cdpClients.push({ id: clientId, connectedAt: Date.now() });
    }
  }

  function removeCDPClient(clientId) {
    _state.cdpClients = _state.cdpClients.filter(function(c) { return c.id !== clientId; });
  }

  function getCDPClients() {
    return _state.cdpClients;
  }

  function hasConnectedClient() {
    return _state.cdpClients.length > 0;
  }

  function setConnectedAt(ts) {
    _state.connectedAt = ts;
  }

  function getConnectedAt() {
    return _state.connectedAt;
  }

  function setActiveTargetId(id) {
    _state.activeTargetId = id;
  }

  function getActiveTargetId() {
    return _state.activeTargetId;
  }

  return {
    getState: getState,
    setWs: setWs,
    getWs: getWs,
    isConnected: isConnected,
    setConnected: setConnected,
    isConnecting: isConnecting,
    setConnecting: setConnecting,
    isPairing: isPairing,
    setPairing: setPairing,
    setPinRequired: setPinRequired,
    isPinRequired: isPinRequired,
    setSessionToken: setSessionToken,
    getSessionToken: getSessionToken,
    setPendingPin: setPendingPin,
    takePendingPin: takePendingPin,
    setPinError: setPinError,
    getPinError: getPinError,
    setLastError: setLastError,
    getLastError: getLastError,
    clearReconnectTimer: clearReconnectTimer,
    setReconnectTimer: setReconnectTimer,
    getReconnectTimer: getReconnectTimer,
    clearHeartbeatTimer: clearHeartbeatTimer,
    startHeartbeat: startHeartbeat,
    addAttachedTab: addAttachedTab,
    removeAttachedTab: removeAttachedTab,
    isTabAttached: isTabAttached,
    getAttachedTabIds: getAttachedTabIds,
    addCDPCreatedTab: addCDPCreatedTab,
    removeCDPCreatedTab: removeCDPCreatedTab,
    isCDPCreatedTab: isCDPCreatedTab,
    getCDPCreatedTabIds: getCDPCreatedTabIds,
    setCurrentTabId: setCurrentTabId,
    getCurrentTabId: getCurrentTabId,
    addCDPClient: addCDPClient,
    removeCDPClient: removeCDPClient,
    getCDPClients: getCDPClients,
    hasConnectedClient: hasConnectedClient,
    setConnectedAt: setConnectedAt,
    getConnectedAt: getConnectedAt,
    setActiveTargetId: setActiveTargetId,
    getActiveTargetId: getActiveTargetId
  };
})();

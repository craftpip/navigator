var State = (function() {
  var _state = {
    ws: null,
    connected: false,
    connecting: false,
    pairing: false,
    pinRequired: false,
    sessionToken: null,
    browserName: 'Firefox',
    serverUrl: '',
    reconnectTimer: null,
    heartbeatTimer: null,
    lastError: null,
    pinError: null,
    attachedTabIds: new Set(),
    cdpCreatedTabIds: new Set(),
    cdpClients: [],
    activeTargetId: null,
    currentTabId: null,
    connectedAt: null,
    bidiConnected: false,
    bidiUrl: '',
    bidiError: null
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
    return _state.ws && _state.ws.readyState === WebSocket.OPEN;
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

  function setLastError(err) {
    _state.lastError = err ? String(err) : null;
  }

  function getLastError() {
    return _state.lastError;
  }

  function setPinError(msg) {
    _state.pinError = msg ? String(msg) : null;
  }

  function getPinError() {
    return _state.pinError;
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

  function setConnected(val) {
    _state.connected = Boolean(val);
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

  function setBidiConnected(val) {
    _state.bidiConnected = val;
  }

  function isBidiConnected() {
    return _state.bidiConnected;
  }

  function setBidiUrl(url) {
    _state.bidiUrl = url || '';
  }

  function getBidiUrl() {
    return _state.bidiUrl;
  }

  function setBidiError(err) {
    _state.bidiError = err ? String(err) : null;
  }

  function clearBidiError() {
    _state.bidiError = null;
  }

  function getBidiError() {
    return _state.bidiError;
  }

  return {
    getState: getState,
    setWs: setWs,
    getWs: getWs,
    isConnected: isConnected,
    isConnecting: isConnecting,
    setConnecting: setConnecting,
    isPairing: isPairing,
    setPairing: setPairing,
    setPinRequired: setPinRequired,
    isPinRequired: isPinRequired,
    setSessionToken: setSessionToken,
    getSessionToken: getSessionToken,
    setLastError: setLastError,
    getLastError: getLastError,
    setPinError: setPinError,
    getPinError: getPinError,
    clearReconnectTimer: clearReconnectTimer,
    setReconnectTimer: setReconnectTimer,
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
    setConnected: setConnected,
    getConnectedAt: getConnectedAt,
    setActiveTargetId: setActiveTargetId,
    getActiveTargetId: getActiveTargetId,
    setBidiConnected: setBidiConnected,
    isBidiConnected: isBidiConnected,
    setBidiUrl: setBidiUrl,
    getBidiUrl: getBidiUrl,
    setBidiError: setBidiError,
    clearBidiError: clearBidiError,
    getBidiError: getBidiError
  };
})();
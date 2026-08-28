var ResponseBuilder = {
  send: function(id, result, sessionId, errorMessage, wsManager) {
    var response = { id: id, sessionId: sessionId || null };
    if (errorMessage) {
      response.error = { code: -32000, message: errorMessage };
    } else {
      response.result = result || {};
    }
    wsManager.send(response);
  },

  sendEvent: function(method, params, sessionId, wsManager) {
    if (!wsManager) return;
    wsManager.send({
      type: 'cdp_event',
      method: method,
      params: params,
      sessionId: sessionId || null
    });
  }
};

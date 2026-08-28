var ResponseBuilder = {
  send: function(id, result, sessionId, error, wsManager) {
    var response = { id: id, sessionId: sessionId || null };
    if (error) {
      var code = (typeof error === 'object' && error.code) ? error.code : -32000;
      var message = (typeof error === 'object' ? error.message : error) || String(error);
      response.error = { code: code, message: message };
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
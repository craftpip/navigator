var CDP_HANDLERS = {
  // Browser domain
  'Browser.getVersion': { type: 'LOCAL', handler: LocalHandler.browserGetVersion },
  'Browser.setDownloadBehavior': { type: 'LOCAL', handler: LocalHandler.emptyResult },
  'Browser.close': { type: 'LOCAL', handler: LocalHandler.browserClose },
  'Browser.crash': { type: 'LOCAL', handler: LocalHandler.emptyResult },
  'Browser.crashGpuProcess': { type: 'LOCAL', handler: LocalHandler.emptyResult },
  'Browser.getWindowForTarget': { type: 'LOCAL', handler: LocalHandler.getWindowForTarget },
  'Browser.setWindowBounds': { type: 'LOCAL', handler: LocalHandler.setWindowBounds },
  'Browser.getWindowBounds': { type: 'LOCAL', handler: LocalHandler.getWindowBounds },
  'Browser.getBrowserCommandLine': { type: 'LOCAL', handler: LocalHandler.emptyArray },
  'Browser.getHistograms': { type: 'LOCAL', handler: LocalHandler.emptyArray },
  'Browser.getHistogram': { type: 'LOCAL', handler: LocalHandler.emptyObject },
  'Browser.grantPermissions': { type: 'LOCAL', handler: LocalHandler.emptyResult },
  'Browser.resetPermissions': { type: 'LOCAL', handler: LocalHandler.emptyResult },
  'Browser.setPermission': { type: 'LOCAL', handler: LocalHandler.emptyResult },

  // Target domain (browser-level-lookalikes handled locally / specially)
  'Target.setDiscoverTargets': { type: 'LOCAL', handler: LocalHandler.targetSetDiscoverTargets },
  'Target.getTargets': { type: 'LOCAL', handler: LocalHandler.targetGetTargets },
  'Target.getTargetInfo': { type: 'LOCAL', handler: LocalHandler.targetGetTargetInfo },
  'Target.createBrowserContext': { type: 'LOCAL', handler: LocalHandler.targetCreateBrowserContext },
  'Target.disposeBrowserContext': { type: 'LOCAL', handler: LocalHandler.targetDisposeBrowserContext },
  'Target.getBrowserContexts': { type: 'LOCAL', handler: LocalHandler.targetGetBrowserContexts },
  'Target.attachToBrowserTarget': { type: 'LOCAL', handler: LocalHandler.targetAttachToBrowserTarget },

  'Target.setAutoAttach': { type: 'SPECIAL', handler: SpecialHandler.targetSetAutoAttach },
  'Target.attachToTarget': { type: 'SPECIAL', handler: SpecialHandler.targetAttachToTarget },
  'Target.detachFromTarget': { type: 'SPECIAL', handler: SpecialHandler.targetDetachFromTarget },
  'Target.createTarget': { type: 'SPECIAL', handler: SpecialHandler.targetCreateTarget },
  'Target.activateTarget': { type: 'SPECIAL', handler: SpecialHandler.targetActivateTarget },
  'Target.closeTarget': { type: 'SPECIAL', handler: SpecialHandler.targetCloseTarget },

  // SystemInfo / Tethering / IO / Schema
  'SystemInfo.getInfo': { type: 'LOCAL', handler: LocalHandler.systemInfoGetInfo },
  'SystemInfo.getProcessInfo': { type: 'LOCAL', handler: LocalHandler.systemInfoGetProcessInfo },
  'Tethering.bind': { type: 'LOCAL', handler: LocalHandler.tetheringBind },
  'Tethering.unbind': { type: 'LOCAL', handler: LocalHandler.emptyResult },
  'IO.close': { type: 'LOCAL', handler: LocalHandler.emptyResult },
  'IO.read': { type: 'LOCAL', handler: LocalHandler.ioRead },
  'IO.resolveBlob': { type: 'LOCAL', handler: LocalHandler.ioResolveBlob },
  'Schema.getDomains': { type: 'LOCAL', handler: LocalHandler.schemaGetDomains },

  // Tab domain is not CDP — it's navigator-specific (extension only)
  'Tab.getMuteStatus': { type: 'LOCAL', handler: LocalHandler.emptyObject },
  'Tab.getGroupInfo': { type: 'LOCAL', handler: LocalHandler.emptyObject },
  'Tab.ungroup': { type: 'LOCAL', handler: LocalHandler.emptyResult },
  'Tab.simulateUserOpen': { type: 'LOCAL', handler: LocalHandler.emptyResult },
  'Tab.getTabGroup': { type: 'LOCAL', handler: LocalHandler.emptyResult }
};

/**
 * Route a CDP command received over the WebSocket:
 *   { id, method, params, tabId, sessionId, clientId, mode }
 * Response: { id, result|error, sessionId }
 */
function routeCDPCommand(message) {
  var id = message.id;
  var method = message.method;
  var params = message.params || {};
  var sessionId = message.sessionId || null;
  var wsManager = ConnectionManager;

  var state = State.getState();
  if (!state.sessionIdToTabId) {
    state.sessionIdToTabId = new Map();
    state.sessionIdToTargetId = new Map();
  }
  var stateApi = Object.create(State);
  Object.keys(state).forEach(function(k) { stateApi[k] = state[k]; });

  var route = CDP_HANDLERS[method];
  var logType = route ? route.type : 'FORWARD';

  Logger.info('[CDP] RECV id=' + id + ' method=' + method + ' type=' + logType + ' sessionId=' + (sessionId || 'null'));

  var ctx = {
    id: id,
    method: method,
    params: params,
    sessionId: sessionId,
    tabId: message.tabId || null,
    clientId: message.clientId || null,
    mode: message.mode || 'create',
    _state: stateApi,
    _wsManager: wsManager
  };

  return new Promise(function(resolve) {
    var resultPromise;
    if (route) {
      resultPromise = Promise.resolve(route.handler(ctx));
    } else {
      resultPromise = ForwardHandler.execute(ctx);
    }

    resultPromise
      .then(function(result) {
        Logger.info('[CDP] SEND id=' + id + ' method=' + method + ' hasError=false');
        resolve({ result: result });
      })
      .catch(function(error) {
        Logger.error('[CDP] ERROR id=' + id + ' method=' + method + ' msg=' + (error.message || error));
        resolve({ error: { code: error.code || -32000, message: error.message || String(error) } });
      });
  }).then(function(response) {
    if (response.error) {
      ResponseBuilder.send(id, null, sessionId, response.error, wsManager);
    } else {
      ResponseBuilder.send(id, response.result, sessionId, null, wsManager);
    }
    return response;
  });
}
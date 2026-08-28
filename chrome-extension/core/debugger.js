var DebuggerManager = (function() {
  var lastAttachError = null;

  function getLastAttachError() { return lastAttachError; }

  function attach(tabId, targetId) {
    return new Promise(function(resolve) {
      if (State.isTabAttached(tabId)) {
        Logger.info('[Debugger] Already attached to tab:', tabId);
        resolve(true);
        return;
      }
      lastAttachError = null;
      var shapes = [{ tabId: tabId }];
      if (targetId) shapes.push({ targetId: targetId });
      var index = 0;
      var attempt = function() {
        var shape = shapes[index++];
        if (!shape) {
          Logger.error('[Debugger] Attach failed (all shapes):', lastAttachError);
          resolve(false);
          return;
        }
        chrome.debugger.attach(shape, Config.DEBUGGER_VERSION || '1.3', function() {
          if (chrome.runtime.lastError) {
            lastAttachError = JSON.stringify(chrome.runtime.lastError) || '(empty lastError)';
            Logger.error('[Debugger] Attach failed ' + JSON.stringify(shape) + ':', lastAttachError);
            attempt();
            return;
          }
          Logger.info('[Debugger] Attached to tab:', tabId, '(shape ' + JSON.stringify(shape) + ')');
          State.addAttachedTab(tabId);
          resolve(true);
        });
      };
      attempt();
    });
  }

  function detach(tabId) {
    return new Promise(function(resolve) {
      if (!State.isTabAttached(tabId)) {
        Logger.info('[Debugger] Not attached to tab:', tabId);
        resolve();
        return;
      }
      chrome.debugger.detach({ tabId: tabId }, function() {
        if (chrome.runtime.lastError) {
          Logger.warn('[Debugger] Detach error:', chrome.runtime.lastError.message);
        }
        State.removeAttachedTab(tabId);
        Logger.info('[Debugger] Detached from tab:', tabId);
        resolve();
      });
    });
  }

  function detachAll() {
    var attached = State.getAttachedTabIds();
    return Promise.all(attached.map(function(tabId) {
      return detach(tabId);
    }));
  }

  function sendCommand(tabId, method, params) {
    return chrome.debugger.sendCommand({ tabId: tabId }, method, params || {});
  }

  function handleDebuggerEvent(source, method, params) {
    var tabId = source.tabId;
    if (!tabId || !State.isTabAttached(tabId)) {
      return;
    }

    var sessionId = State.getState().sessionIdToTabId ? findSessionByTabId(tabId) : null;

    ConnectionManager.send({
      type: 'cdp_event',
      tabId: tabId,
      sessionId: sessionId,
      method: method,
      params: params
    });
  }

  function handleDetach(source, reason) {
    var tabId = source.tabId;
    Logger.warn('[Debugger] Detached:', tabId, reason);
    State.removeAttachedTab(tabId);
    // Tell the relay server so it can clear its stale sessionForTarget /
    // extSessionToTarget / client.sessionForTarget maps. Without this the
    // server keeps returning the dead sessionId via _ensureTargetSession and
    // every subsequent CDP command fails with "Tab not attached: <tabId>"
    // until a manual detach_all. This makes the banner close survivable —
    // the next command will auto-re-attach (banner reappears).
    try {
      ConnectionManager.send({ type: 'tab_detached', tabId: tabId, reason: reason || '' });
    } catch (e) {}
    ConnectionManager.notify({ type: 'stateUpdate' });
  }

  function findSessionByTabId(tabId) {
    return State.getState().sessionIdToTabId ? State.getState().sessionIdToTabId.get(tabId) : null;
  }

  function getActualAttachState(tabId) {
    return new Promise(function(resolve) {
      chrome.debugger.getTargets(function(targets) {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        var tabTarget = (targets || []).find(function(t) {
          return t.tabId === tabId;
        });
        resolve(!!(tabTarget && tabTarget.attached));
      });
    });
  }

  return {
    attach: attach,
    detach: detach,
    detachAll: detachAll,
    sendCommand: sendCommand,
    handleDebuggerEvent: handleDebuggerEvent,
    handleDetach: handleDetach,
    getActualAttachState: getActualAttachState,
    getLastAttachError: getLastAttachError
  };
})();

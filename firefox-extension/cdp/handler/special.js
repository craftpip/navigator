var SpecialHandler = (function() {
  function targetSetAutoAttach(context) {
    return {};
  }

  function targetAttachToTarget(context) {
    var params = context.params || {};
    var targetId = params.targetId;
    return CDPSessionManager.attachToTarget(targetId).then(function(m) {
      return { sessionId: m.sessionId };
    });
  }

  function targetDetachFromTarget(context) {
    var params = context.params || {};
    var sessionId = params.sessionId;
    return CDPSessionManager.detach(sessionId).then(function() {
      return {};
    });
  }

  /**
   * Target.createTarget -> browsingContext.create (+ navigate).
   * Returns the BiDi context id as the CDP targetId.
   */
  function targetCreateTarget(context) {
    var params = context.params || {};
    var url = params.url || 'about:blank';
    var needsNavigate = url !== 'about:blank' && url !== '';

    return BidiClient.send('browsingContext.create', {
      type: params.newWindow ? 'window' : 'tab'
    }).then(function(res) {
      var contextId = res.context;
      if (!contextId) throw new Error('Failed to create context');
      CDPSessionManager.noteContextCreated(contextId);
      if (needsNavigate) {
        return BidiClient.send('browsingContext.navigate', {
          context: contextId,
          url: url,
          wait: 'interactive'
        }).then(function() {
          return { targetId: contextId };
        });
      }
      return { targetId: contextId };
    });
  }

  function targetActivateTarget(context) {
    var params = context.params || {};
    var targetId = params.targetId;
    return CDPSessionManager.resolveContext(targetId).then(function(res) {
      if (!res || !res.contextId) return {};
      return BidiClient.send('browsingContext.activate', { context: res.contextId }).then(function() {
        return {};
      });
    }).catch(function() {
      return {};
    });
  }

  function targetCloseTarget(context) {
    var params = context.params || {};
    var targetId = params.targetId;
    if (!targetId) return { success: true };
    return CDPSessionManager.resolveContext(targetId).then(function(res) {
      if (!res || !res.contextId) return { success: true };
      return BidiClient.send('browsingContext.close', {
        context: res.contextId,
        promptUnload: false
      }).then(function() {
        CDPSessionManager.detachForTab(res.tabId);
        return { success: true };
      });
    }).catch(function() {
      return { success: true };
    });
  }

  // ---------------------------------------------------------------- windows

  function normalizeFirefoxWindow(win) {
    var state = String(win.state || 'normal');
    var C = ['normal', 'minimized', 'maximized', 'fullscreen'];
    return {
      left: typeof win.left === 'number' ? win.left : 0,
      top: typeof win.top === 'number' ? win.top : 0,
      width: typeof win.width === 'number' ? win.width : 0,
      height: typeof win.height === 'number' ? win.height : 0,
      windowState: C.indexOf(state) !== -1 ? state : 'normal'
    };
  }

  function getWindowByTabId(tabId) {
    return new Promise(function(resolve, reject) {
      chrome.tabs.get(tabId, function(tab) {
        if (chrome.runtime.lastError || !tab) {
          reject(new Error('Tab not found: ' + tabId + (chrome.runtime.lastError ? ' — ' + chrome.runtime.lastError.message : '')));
          return;
        }
        resolve(tab.windowId);
      });
    });
  }

  function getChromeWindowById(windowId) {
    return new Promise(function(resolve, reject) {
      chrome.windows.get(windowId, function(win) {
        if (chrome.runtime.lastError || !win) {
          reject(new Error('Window not found: ' + windowId + (chrome.runtime.lastError ? ' — ' + chrome.runtime.lastError.message : '')));
          return;
        }
        resolve(win);
      });
    });
  }

  function getCurrentWindowId() {
    return new Promise(function(resolve, reject) {
      chrome.windows.getCurrent(function(win) {
        if (chrome.runtime.lastError || !win || win.id === undefined) {
          reject(new Error('No current window'));
          return;
        }
        resolve(win.id);
      });
    });
  }

  function resolveWindowId(context) {
    var params = context.params || {};
    if (params.windowId !== undefined && params.windowId !== null) {
      return Promise.resolve(Number(params.windowId));
    }
    if (params.targetId) {
      return CDPSessionManager.resolveContext(params.targetId).then(function(res) {
        if (!res || !res.tabId) return Promise.reject(new Error('Target not resolvable to a tab: ' + params.targetId));
        return getWindowByTabId(res.tabId);
      });
    }
    return getCurrentWindowId();
  }

  function targetGetWindowForTarget(context) {
    var params = context.params || {};
    var targetId = params.targetId;
    if (!targetId) return Promise.reject(new Error('targetId is required'));
    return resolveWindowId(context).then(function(windowId) {
      return getChromeWindowById(windowId);
    }).then(function(win) {
      return { windowId: win.id, bounds: normalizeFirefoxWindow(win) };
    });
  }

  function targetGetWindowBounds(context) {
    return resolveWindowId(context).then(function(windowId) {
      return getChromeWindowById(windowId);
    }).then(function(win) {
      return { bounds: normalizeFirefoxWindow(win) };
    });
  }

  function targetSetWindowBounds(context) {
    var params = context.params || {};
    var raw = params.bounds || {};
    return resolveWindowId(context).then(function(windowId) {
      return new Promise(function(resolve, reject) {
        var updateInfo = {};
        if (raw.left !== undefined) updateInfo.left = Number(raw.left);
        if (raw.top !== undefined) updateInfo.top = Number(raw.top);
        if (raw.width !== undefined) updateInfo.width = Number(raw.width);
        if (raw.height !== undefined) updateInfo.height = Number(raw.height);
        if (raw.focused !== undefined) updateInfo.focused = !!raw.focused;
        if (raw.windowState !== undefined) {
          var st = String(raw.windowState).toLowerCase();
          if (['normal', 'minimized', 'maximized', 'fullscreen'].indexOf(st) === -1) {
            reject(new Error('Invalid windowState: ' + raw.windowState));
            return;
          }
          updateInfo.state = st;
        }
        var keys = Object.keys(updateInfo);
        if (keys.length === 0) {
          reject(new Error('bounds must specify at least one of left, top, width, height, focused, windowState'));
          return;
        }
        chrome.windows.update(windowId, updateInfo, function(win) {
          if (chrome.runtime.lastError || !win) {
            reject(new Error('Failed to update window ' + windowId + (chrome.runtime.lastError ? ' — ' + chrome.runtime.lastError.message : '')));
            return;
          }
          resolve({ bounds: normalizeFirefoxWindow(win) });
        });
      });
    });
  }

  return {
    targetSetAutoAttach: targetSetAutoAttach,
    targetAttachToTarget: targetAttachToTarget,
    targetDetachFromTarget: targetDetachFromTarget,
    targetCreateTarget: targetCreateTarget,
    targetActivateTarget: targetActivateTarget,
    targetCloseTarget: targetCloseTarget,
    targetGetWindowForTarget: targetGetWindowForTarget,
    targetGetWindowBounds: targetGetWindowBounds,
    targetSetWindowBounds: targetSetWindowBounds
  };
})();
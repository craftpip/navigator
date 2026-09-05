var SpecialHandler = (function() {
  function promisifyGetTargets() {
    return new Promise(function(resolve) {
      var resolved = false;
      var finish = function(targets) {
        if (!resolved) { resolved = true; resolve(targets || []); }
      };
      try {
        var res = chrome.debugger.getTargets(function(targets) {
          finish(targets);
        });
        // Chrome 116+ (MV3) may return a Promise instead of using the callback
        if (res && typeof res.then === 'function') {
          res.then(function(targets) { finish(targets); }).catch(function() { finish([]); });
        }
      } catch (e) {
        finish([]);
      }
    });
  }

  function targetAttachToTarget(context) {
    var state = context._state;
    var params = context.params || {};
    var targetId = params.targetId;
    var tabId = null;
    return Promise.resolve().then(function() {
      return resolveTabId(targetId);
    }).then(function(resolvedTabId) {
      tabId = resolvedTabId;
      if (!tabId) {
        throw new Error('Target not resolvable to a tab: ' + targetId + ' (id not in chrome.debugger.getTargets)');
      }
      if (!state.isTabAttached(tabId)) {
        return DebuggerManager.attach(tabId, targetId).then(function(attached) {
          if (!attached) throw new Error('Failed to attach to target ' + targetId + ' (tab ' + tabId + '): ' + DebuggerManager.getLastAttachError());
          state.addAttachedTab(tabId);
          state.isCDPCreatedTab(tabId) && SpecialHandler.addTabToAutomationGroup(tabId);
        });
      }
    }).then(function() {
      var sessionId = CDPUtils.generateSessionId();
      mapSession(state, sessionId, tabId, targetId);
      return { sessionId: sessionId };
    });
  }

  function targetDetachFromTarget(context) {
    var state = context._state;
    var params = context.params || {};
    var sessionId = params.sessionId;
    var targetId = params.targetId;

    return unmapSession(state, sessionId).then(function(tabId) {
      if (tabId && !state.isTabAttached(tabId)) {
        return DebuggerManager.detach(tabId);
      }
      { return {}; }
    });
  }

  function targetCreateTarget(context) {
    var params = context.params || {};
    var url = params.url || 'about:blank';
    var browserContextId = (params && params.browserContextId) || 'default';
    var needsNavigate = url !== 'about:blank' && url !== '';

    return new Promise(function(resolve, reject) {
      chrome.tabs.create({ url: 'about:blank', active: false }, function(tab) {
        if (!tab || !tab.id) {
          reject(new Error('Failed to create tab'));
          return;
        }
        var tabId = tab.id;
        var state = context._state;
        state.addCDPCreatedTab(tabId);
        state.isCDPCreatedTab(tabId);

        SpecialHandler.addTabToAutomationGroup(tabId, context._state);

        // Chrome registers the new tab in chrome.debugger.getTargets a beat
        // after tabs.create; resolve once it does so the targetId we hand back
        // is the REAL debuggable id (puppeteer attaches to it immediately).
        waitForTargetByTabId(tabId, 2000).then(function(target) {
          var targetId = target ? target.id : String(tabId);
          var realUrl = target && target.url ? target.url : url;
          if (needsNavigate) {
            chrome.tabs.update(tabId, { url: url }, function() {
              resolve({ targetId: targetId, tabId: tabId, url: realUrl, _sayGoodbye: true });
            });
          } else {
            resolve({ targetId: targetId, tabId: tabId, url: realUrl });
          }
        });
      });
    });
  }

  function targetActivateTarget(context) {
    var params = context.params || {};
    var targetId = params.targetId;
    if (!targetId) return {};
    return resolveTabId(targetId).then(function(tabId) {
      if (!tabId) return {};
      return new Promise(function(resolve) {
        chrome.tabs.update(tabId, { active: true }, function() {
          resolve({});
        });
      });
    }).catch(function() {
      return {};
    });
  }

  function targetCloseTarget(context) {
    var params = context.params || {};
    var targetId = params.targetId;
    if (!targetId) return { success: true };
    return resolveTabId(targetId).then(function(tabId) {
      if (!tabId) return { success: true };
      return new Promise(function(resolve) {
        chrome.tabs.remove(tabId, function() {
          if (context._state) context._state.removeAttachedTab(tabId);
          resolve({ success: true });
        });
      });
    }).catch(function() {
      return { success: true };
    });
  }

  // ---------------------------------------------------------------- windows

  function normalizeChromeWindow(win) {
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
      return resolveTabId(params.targetId).then(function(tabId) {
        if (!tabId) return Promise.reject(new Error('Target not resolvable to a tab: ' + params.targetId));
        return getWindowByTabId(tabId);
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
      return { windowId: win.id, bounds: normalizeChromeWindow(win) };
    });
  }

  function targetGetWindowBounds(context) {
    return resolveWindowId(context).then(function(windowId) {
      return getChromeWindowById(windowId);
    }).then(function(win) {
      return { bounds: normalizeChromeWindow(win) };
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
          resolve({ bounds: normalizeChromeWindow(win) });
        });
      });
    });
  }

  function targetSetAutoAttach(context) {
    return {};
  }

  /**
   * Add an automation-created tab to the navigator tab group.
   * Creates/finds the group named "Navigator" and puts the tab in it.
   */
  function addTabToAutomationGroup(tabId, state) {
    if (!chrome.tabGroups) return;
    Config.getBrowserName(function(browserName) {
      var groupName = 'Navigator: ' + (browserName || 'Chrome');
      SpecialHandler.getOrCreateGroup(groupName, function(groupId) {
        if (!groupId) return;
        chrome.tabs.group({ tabIds: tabId, groupId: groupId }, function() {
          if (chrome.runtime.lastError) {
            Logger.warn('[TabGroup] Failed to group tab:', tabId, chrome.runtime.lastError.message);
            return;
          }
          chrome.tabGroups.update(groupId, { collapsed: true }, function() {
            if (chrome.runtime.lastError) {
              Logger.warn('[TabGroup] Failed to collapse group:', chrome.runtime.lastError.message);
            }
          });
        });
      });
    });
  }

  function getOrCreateGroup(groupName, callback) {
    chrome.tabs.query({}, function(tabs) {
      if (!tabs || tabs.length === 0) { callback(null); return; }
      var windowId = tabs[0].windowId;
      chrome.tabGroups.query({ windowId: windowId }, function(groups) {
        if (chrome.runtime.lastError || !groups) { callback(null); return; }
        var existing = CDPUtils.findGroupByName(groups, groupName);
        if (existing) {
          callback(existing.id);
          return;
        }
        chrome.tabs.group({ createProperties: { windowId: windowId } }, function(groupId) {
          if (chrome.runtime.lastError || !groupId) { callback(null); return; }
          chrome.tabGroups.update(groupId, { title: groupName, color: CDPUtils.getGroupColor() }, function() {
            if (chrome.runtime.lastError) {
              Logger.warn('[TabGroup] Failed to title group:', chrome.runtime.lastError.message);
            }
            callback(groupId);
          });
        });
      });
    });
  }

  function mapSession(state, sessionId, tabId, targetId) {
    if (!state.sessionIdToTabId) {
      state.sessionIdToTabId = new Map();
      state.sessionIdToTargetId = new Map();
    }
    state.sessionIdToTabId.set(sessionId, tabId);
    state.sessionIdToTargetId.set(sessionId, targetId);
    state.addAttachedTab(tabId);
    state.setCurrentTabId && state.setCurrentTabId(tabId);
  }

  function unmapSession(state, sessionId) {
    if (!state.sessionIdToTabId || !state.sessionIdToTabId.has(sessionId)) {
      return Promise.resolve(null);
    }
    var tabId = state.sessionIdToTabId.get(sessionId);
    state.sessionIdToTabId.delete(sessionId);
    state.sessionIdToTargetId.delete(sessionId);
    return Promise.resolve(tabId);
  }

  function resolveTabId(targetId) {
    if (!targetId) return Promise.resolve(null);
    if (/^\d+$/.test(targetId)) {
      return Promise.resolve(parseInt(targetId, 10));
    }
    return promisifyGetTargets().then(function(targets) {
      var match = (targets || []).find(function(t) { return t.id === targetId; });
      return match && match.tabId ? match.tabId : null;
    });
  }

  function getTargetIdByTabId(tabId, state) {
    if (tabId && state && state.sessionIdToTargetId) {
      var found = null;
      state.sessionIdToTargetId.forEach(function(targetId, sessId) {
        if (state.sessionIdToTabId.get(sessId) === tabId) {
          found = targetId;
        }
      });
      if (found) return Promise.resolve(found);
    }
    return promisifyGetTargets().then(function(targets) {
      var match = (targets || []).find(function(t) { return t.tabId === tabId; });
      return match ? match.id : String(tabId);
    });
  }

  // Poll chrome.debugger.getTargets until a target with the given tabId
  // appears. Fresh tabs created via tabs.create take a moment to become
  // debuggable targets; returning early hands the client a fake id.
  function waitForTargetByTabId(tabId, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 1500);
    return new Promise(function(resolve) {
      (function poll() {
        promisifyGetTargets().then(function(targets) {
          var match = (targets || []).find(function(t) { return t.tabId === tabId; });
          if (match) { resolve(match); return; }
          if (Date.now() >= deadline) { resolve(null); return; }
          setTimeout(poll, 50);
        }).catch(function() { resolve(null); });
      })();
    });
  }

  return {
    targetAttachToTarget: targetAttachToTarget,
    targetDetachFromTarget: targetDetachFromTarget,
    targetCreateTarget: targetCreateTarget,
    targetActivateTarget: targetActivateTarget,
    targetCloseTarget: targetCloseTarget,
    targetGetWindowForTarget: targetGetWindowForTarget,
    targetGetWindowBounds: targetGetWindowBounds,
    targetSetWindowBounds: targetSetWindowBounds,
    targetSetAutoAttach: targetSetAutoAttach,
    addTabToAutomationGroup: addTabToAutomationGroup,
    getOrCreateGroup: getOrCreateGroup
  };
})();

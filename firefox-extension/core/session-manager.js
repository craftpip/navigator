/**
 * CDPSessionManager — maps the CDP session concept (what navigator's resource
 * model expects after Target.attachToTarget) onto WebDriver BiDi browsing
 * contexts (what Firefox's Remote Agent actually operates on), and correlates
 * contexts with real tabs.
 *
 * Maps maintained here (not on State):
 *   sessionId   -> { contextId, tabId }
 *   contextId   -> tabId        (_contextTabs)
 *   tabId       -> contextId    (_tabContexts)
 * plus FIFO pairing of `browsingContext.create` replies with `tabs.onCreated`
 * (the BiDi API exposes context ids, the tabs API exposes tab ids — the event
 * ordering is not guaranteed, so we bridge the two and pair in arrival order).
 */
var CDPSessionManager = (function() {
  'use strict';

  var _sessions = new Map();      // sessionId -> { contextId, tabId }
  var _contextTabs = new Map();   // contextId -> tabId
  var _tabContexts = new Map();   // tabId -> contextId
  var _knownContexts = new Set(); // every context id we've ever seen
  var _unpairedContexts = [];     // context ids awaiting a tabs.onCreated
  var _stashedTabIds = [];        // tab ids awaiting a browsingContext.create reply

  // ------------------------------------------------------------ mapping

  function addContextMapping(contextId, tabId) {
    if (!contextId) return;
    if (_contextTabs.has(contextId)) {
      var oldTab = _contextTabs.get(contextId);
      if (_tabContexts.get(oldTab) === contextId) _tabContexts.delete(oldTab);
    }
    _contextTabs.set(contextId, tabId);
    _tabContexts.set(tabId, contextId);
    _knownContexts.add(contextId);
  }

  function contextIdForTab(tabId) { return _tabContexts.get(tabId) || null; }
  function tabIdForContext(contextId) { return _contextTabs.get(contextId) || null; }

  /** Called when a browsingContext.create reply lands with a context id. */
  function noteContextCreated(contextId) {
    _knownContexts.add(contextId);
    if (_stashedTabIds.length) {
      addContextMapping(contextId, _stashedTabIds.shift());
    } else {
      _unpairedContexts.push(contextId);
    }
  }

  /** Called on tabs.onCreated — pairs the newest context (FIFO) with the tab. */
  function handleTabCreated(tab) {
    var tabId = tab && tab.id;
    if (!tabId) return;
    if (_unpairedContexts.length) {
      addContextMapping(_unpairedContexts.shift(), tabId);
      TabIsolation.isolate(tabId);
    } else {
      _stashedTabIds.push(tabId);
    }
  }

  // ------------------------------------------------------------ sessions

  function createSession(contextId, tabId) {
    if (!contextId) return null;
    var sid = CDPUtils.generateSessionId();
    if (tabId) {
      addContextMapping(contextId, tabId);
      State.addAttachedTab(tabId);
      State.setCurrentTabId(tabId);
    }
    _sessions.set(sid, { contextId: contextId, tabId: tabId || null });
    State.addCDPClient(sid);
    return sid;
  }

  function findBySession(sessionId) { return _sessions.get(sessionId) || null; }

  function sessionForContext(contextId) {
    for (var it = _sessions.entries(); ; ) {
      var e = it.next();
      if (e.done) return null;
      if (e.value[1].contextId === contextId) return e.value[0];
    }
  }

  function isContextAttached(contextId) { return sessionForContext(contextId) != null; }

  function isTabAttached(tabId) {
    if (!tabId) return false;
    for (var it = _sessions.entries(); ; ) {
      var e = it.next();
      if (e.done) return false;
      var m = e.value[1];
      if (m.tabId === tabId) return true;
      if (m.contextId && _contextTabs.get(m.contextId) === tabId) return true;
    }
  }

  function detach(sessionId) {
    var m = _sessions.get(sessionId);
    if (!m) return Promise.resolve(null);
    _sessions.delete(sessionId);
    State.removeCDPClient(sessionId);
    if (m.tabId && !isTabAttached(m.tabId)) {
      State.removeAttachedTab(m.tabId);
    }
    return Promise.resolve(m);
  }

  function detachForTab(tabId) {
    var dels = [];
    var sessions = Array.from(_sessions.entries());
    sessions.forEach(function(pair) {
      if (pair[1].tabId === tabId) dels.push(pair[0]);
    });
    return Promise.all(dels.map(detach));
  }

  function detachAll() {
    var sessions = Array.from(_sessions.entries());
    sessions.forEach(function(pair) {
      _sessions.delete(pair[0]);
      State.removeCDPClient(pair[0]);
    });
    State.getAttachedTabIds().forEach(function(t) { State.removeAttachedTab(t); });
    return Promise.resolve();
  }

  // ------------------------------------------------------------ attach / resolve

  /**
   * Target.attachToTarget targetId -> { contextId, tabId }.
   * Accepts: BiDi context ids, 'tab-<n>' tab handles, raw numeric tab ids.
   */
  function resolveContext(targetId) {
    var tabId = CDPUtils.parseTabTargetId(targetId);
    if (tabId != null) {
      return resolveTab(tabId);
    }
    var contextId = String(targetId);
    var known = _knownContexts.has(contextId) || _contextTabs.has(contextId) || sessionForContext(contextId);
    if (known) {
      State.setCurrentTabId(tabIdForContext(contextId));
      return Promise.resolve({ contextId: contextId, tabId: tabIdForContext(contextId) });
    }
    // Unknown string — accept optimistically; a bad context surfaces as a
    // clean BiDi error on the first mapped command, not a brittle guess.
    return Promise.resolve({ contextId: contextId, tabId: null });
  }

  /** Attach to a target, returning an existing or new CDP session id. */
  function attachToTarget(targetId) {
    return resolveContext(targetId).then(function(res) {
      if (!res || !res.contextId) {
        var e = new Error('Target not found');
        e.code = -32000;
        throw e;
      }
      var existing = sessionForContext(res.contextId);
      if (existing) return { sessionId: existing, contextId: res.contextId, tabId: res.tabId };
      var sid = createSession(res.contextId, res.tabId);
      return { sessionId: sid, contextId: res.contextId, tabId: res.tabId };
    });
  }

  /** Attach to a tab id directly (popup attach button). */
  function attachToTab(tabId) {
    return resolveTab(tabId).then(function(res) {
      if (!res || !res.contextId) {
        var e = new Error('Could not map tab ' + tabId + ' to a BiDi context');
        e.code = -32000;
        throw e;
      }
      var existing = sessionForContext(res.contextId);
      if (existing) return { sessionId: existing, contextId: res.contextId, tabId: tabId };
      var sid = createSession(res.contextId, tabId);
      return { sessionId: sid, contextId: res.contextId, tabId: tabId };
    });
  }

  function resolveTab(tabId) {
    return new Promise(function(resolve) {
      var known = contextIdForTab(tabId);
      if (known) {
        resolve({ contextId: known, tabId: tabId });
        return;
      }
      chrome.tabs.get(tabId, function(tab) {
        if (chrome.runtime.lastError || !tab) {
          resolve(null);
          return;
        }
        discoverContextForTab(tab).then(function(contextId) {
          resolve(contextId ? { contextId: contextId, tabId: tabId } : null);
        });
      });
    });
  }

  /**
   * Best-effort BiDi context lookup for a tab: getTree + URL match.
   * Refined in Phase 2 (index/window correlation verified on real Firefox).
   */
  function discoverContextForTab(tab) {
    return BidiClient.send('browsingContext.getTree', {}).then(function(tree) {
      var tops = (tree && tree.contexts) || [];
      var wantUrl = (tab.url || '').split('#')[0];
      var pool = tops.filter(function(c) {
        return wantUrl && (c.url || '').split('#')[0] === wantUrl;
      });
      if (pool.length === 0) pool = tops;
      // Prefer contexts not already mapping a tab.
      var free = pool.filter(function(c) { return !tabIdForContext(c.context); });
      var pick = (free.length ? free : pool)[0];
      if (!pick) return null;
      if (pick.context) {
        addContextMapping(pick.context, tab.id);
        _knownContexts.add(pick.context);
      }
      return pick.context || null;
    }).catch(function() { return null; });
  }

  // ------------------------------------------------------------ listing

  function getKnownContexts() {
    var out = Array.from(_knownContexts);
    _sessions.forEach(function(m) {
      if (out.indexOf(m.contextId) < 0) out.push(m.contextId);
    });
    return out;
  }

  /** BiDi contexts that don't (yet) map to a tab — surfaced in target lists. */
  function getUnpairedContexts() {
    return getKnownContexts().filter(function(c) { return !_contextTabs.has(c); });
  }

  /** Full teardown when the BiDi socket drops. */
  function handleBidiDisconnected() {
    _sessions.clear();
    _contextTabs.clear();
    _tabContexts.clear();
    _knownContexts.clear();
    _unpairedContexts = [];
    _stashedTabIds = [];
    State.getAttachedTabIds().forEach(function(t) { State.removeAttachedTab(t); });
    State.getCDPClients().forEach(function(c) { State.removeCDPClient(c.id); });
  }

  return {
    addContextMapping: addContextMapping,
    contextIdForTab: contextIdForTab,
    tabIdForContext: tabIdForContext,
    noteContextCreated: noteContextCreated,
    handleTabCreated: handleTabCreated,
    createSession: createSession,
    findBySession: findBySession,
    sessionForContext: sessionForContext,
    isContextAttached: isContextAttached,
    isTabAttached: isTabAttached,
    detach: detach,
    detachForTab: detachForTab,
    detachAll: detachAll,
    resolveContext: resolveContext,
    attachToTarget: attachToTarget,
    attachToTab: attachToTab,
    discoverContextForTab: discoverContextForTab,
    getKnownContexts: getKnownContexts,
    getUnpairedContexts: getUnpairedContexts,
    handleBidiDisconnected: handleBidiDisconnected
  };
})();
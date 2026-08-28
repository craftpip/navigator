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

  return {
    targetSetAutoAttach: targetSetAutoAttach,
    targetAttachToTarget: targetAttachToTarget,
    targetDetachFromTarget: targetDetachFromTarget,
    targetCreateTarget: targetCreateTarget,
    targetActivateTarget: targetActivateTarget,
    targetCloseTarget: targetCloseTarget
  };
})();
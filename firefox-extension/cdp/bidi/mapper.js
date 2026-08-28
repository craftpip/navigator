/**
 * The bidi-mapper — CDP <-> WebDriver BiDi transition layer.
 *
 * Pure translation tables + transformers. No browser.* dependency (except the
 * injected DOM-walk script strings, which run in the page, not here).
 *
 * Command path:  ForwardHandler gets {method, params, contextId} -> translateCommand
 *                -> {bidiMethod, bidiParams} -> BidiClient.send -> transformCommandResult
 * Event path:    BidiClient delivers {method, params} -> translateEvent -> 0..n CDP events
 *                -> ResponseBuilder.sendEvent with the CDP session of that context.
 */
var Mapper = (function() {
  'use strict';

  var UNSUPPORTED_CODE = -32601;

  /** Injected DOM-walk script (runs in the target context via script.evaluate). */
  var DOM_WALK_SCRIPT = ["(() => {",
    "  var MAX_DEPTH = 12, MAX_NODES = 2000, MAX_CHARS = 200;",
    "  var seq = 0, ids = new WeakMap();",
    "  function idFor(n){ if (!ids.has(n)) ids.set(n, ++seq); return ids.get(n); }",
    "  function walk(node, depth){",
    "    if (seq > MAX_NODES) return null;",
    "    var o = { nodeId: idFor(node), backendNodeId: idFor(node), nodeType: node.nodeType,",
    "              nodeName: node.nodeName, localName: node.localName || '',",
    "              childNodeCount: node.childNodes.length, attributes: [] };",
    "    if (node.nodeType === 1) {",
    "      for (var i = 0; i < node.attributes.length; i++) o.attributes.push(node.attributes[i].name, node.attributes[i].value);",
    "      if (node === document) { o.documentURL = location.href; o.baseURL = document.baseURI; }",
    "    }",
    "    if (node.nodeType === 3 && node.nodeValue != null) o.nodeValue = node.nodeValue.substring(0, MAX_CHARS);",
    "    if (node.nodeType !== 3 && depth < MAX_DEPTH) {",
    "      o.children = [];",
    "      for (var c = 0; c < node.childNodes.length; c++) {",
    "        var w = walk(node.childNodes[c], depth + 1);",
    "        if (w) o.children.push(w);",
    "      }",
    "    }",
    "    return o;",
    "  }",
    "  return JSON.stringify(walk(document, 0));",
    "})()"].join('\n');

  function domQueryScript(selector) {
    return ["(() => {",
      "  var el = document.querySelector(", JSON.stringify(selector), ");",
      "  if (!el) return JSON.stringify({ nodeId: 0 });",
      "  var seq = 0, ids = new WeakMap();",
      "  function idFor(n){ if (!ids.has(n)) ids.set(n, ++seq); return ids.get(n); }",
      "  var r = { nodeId: idFor(el), backendNodeId: idFor(el), nodeType: el.nodeType,",
      "            nodeName: el.nodeName, localName: el.localName || '',",
      "            childNodeCount: el.childNodes.length, attributes: [] };",
      "  for (var i = 0; i < el.attributes.length; i++) r.attributes.push(el.attributes[i].name, el.attributes[i].value);",
      "  if (el === document) { r.documentURL = location.href; r.baseURL = document.baseURI; }",
      "  return JSON.stringify(r);",
      "})()"].join('\n');
  }

  // ---------- input dispatch helpers ----------

  var MOUSE_BUTTONS = { none: 0, left: 0, middle: 1, right: 2 };

  function mouseToActions(params) {
    var btn = MOUSE_BUTTONS[params.button] != null ? MOUSE_BUTTONS[params.button] : 0;
    var actions = [];
    var move = { type: 'pointerMove', duration: 0, x: params.x, y: params.y, origin: { type: 'viewport' } };
    if (params.type === 'mouseMoved') {
      actions.push(move);
    } else if (params.type === 'mousePressed') {
      actions.push(move, { type: 'pointerDown', button: btn, clickCount: params.clickCount || 1 });
    } else if (params.type === 'mouseReleased') {
      actions.push(move, { type: 'pointerUp', button: btn, clickCount: params.clickCount || 1 });
    } else {
      return null;
    }
    return [{ type: 'pointer', id: 1, parameters: { pointerType: 'mouse' }, actions: actions }];
  }

  function keyToActions(params) {
    var type = params.type;
    if (type !== 'keyDown' && type !== 'keyUp' && type !== 'rawKeyDown' && type !== 'char') return null;
    var w3cType = type === 'keyUp' ? 'keyUp' : 'keyDown';
    var value = params.text || params.key || '';
    var a = { type: w3cType, value: value };
    if (params.code) a.code = params.code;
    return [{ type: 'key', id: 1, actions: [a] }];
  }

  // ---------- command table ----------

  var COMMAND_ROUTES = {
    'Page.navigate': {
      bidi: 'browsingContext.navigate',
      params: function(p, contextId) {
        return { context: contextId, url: p.url || 'about:blank', wait: p.waitLoad ? 'complete' : 'interactive' };
      },
      result: function(r) {
        return { frameId: r.navigation || null, loaderId: r.navigation || null, errorText: null };
      }
    },

    'Page.reload': {
      bidi: 'browsingContext.reload',
      params: function(p, contextId) {
        return { context: contextId, ignoreCache: !!p.ignoreCache };
      },
      result: function(r) {
        return { frameId: r.navigation || null, loaderId: r.navigation || null };
      }
    },

    'Page.captureScreenshot': {
      bidi: 'browsingContext.captureScreenshot',
      params: function(p, contextId) {
        var q = { context: contextId, format: 'image/png' };
        if (p.clip) {
          q.clip = { type: 'box', x: p.clip.x, y: p.clip.y, width: p.clip.width, height: p.clip.height };
        }
        return q;
      },
      result: function(r) {
        var d = r.data || '';
        if (d.indexOf('base64,') >= 0) d = d.slice(d.indexOf('base64,') + 7);
        return { data: d, format: 'png' };
      }
    },

    'Runtime.evaluate': {
      bidi: 'script.evaluate',
      params: function(p, contextId) {
        return {
          expression: p.expression,
          target: { context: contextId },
          awaitPromise: !!p.awaitPromise,
          returnByValue: true,
          userActivation: !!p.userGesture
        };
      },
      result: function(r) { return RuntimeResult.toCdpResult(r); }
    },

    'Runtime.callFunctionOn': {
      bidi: 'script.callFunction',
      params: function(p, contextId) {
        var args = (p.arguments || []).map(function(a) {
          return RuntimeResult.cdpArgToBidi(a);
        }).filter(function(a) { return a !== null; });
        return {
          functionDeclaration: p.functionDeclaration,
          target: { context: contextId },
          arguments: args,
          awaitPromise: !!p.awaitPromise,
          returnByValue: true,
          userActivation: !!p.userGesture
        };
      },
      result: function(r) { return RuntimeResult.toCdpResult(r); }
    },

    'Input.dispatchMouseEvent': {
      bidi: 'input.performActions',
      params: function(p) {
        var acts = mouseToActions(p);
        if (!acts) throw new Error('Unsupported mouse event type: ' + p.type);
        return { actions: acts };
      },
      result: function() { return {}; }
    },

    'Input.dispatchKeyEvent': {
      bidi: 'input.performActions',
      params: function(p) {
        var acts = keyToActions(p);
        if (!acts) throw new Error('Unsupported key event type: ' + p.type);
        return { actions: acts };
      },
      result: function() { return {}; }
    },

    'Input.insertText': {
      bidi: 'script.evaluate',
      params: function(p, contextId) {
        var text = String(p.text || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
        return {
          expression: "(() => { const t = document.activeElement; if (!t) return 'no-active-element'; " +
            "const proto = t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement ? 'value' : 'textContent'; " +
            "if (proto === 'value') { t.value += '" + text + "'; } else { t.textContent += '" + text + "'; } " +
            "return 'inserted'; })()",
          target: { context: contextId },
          returnByValue: true
        };
      },
      result: function() {
        return { result: { type: 'string', value: 'inserted' } };
      }
    },

    'DOM.getDocument': {
      bidi: 'script.evaluate',
      params: function(p, contextId) {
        return { expression: DOM_WALK_SCRIPT, target: { context: contextId }, returnByValue: true };
      },
      result: function(r) {
        return { root: RuntimeResult.plainValue(r) || { nodeId: 0, nodeName: '#document' } };
      }
    },

    'DOM.querySelector': {
      bidi: 'script.evaluate',
      params: function(p, contextId) {
        return { expression: domQueryScript(p.selector || ''), target: { context: contextId }, returnByValue: true };
      },
      result: function(r) {
        var v = RuntimeResult.plainValue(r);
        return { nodeId: (v && v.nodeId) || 0 };
      }
    },

    'Network.enable': { bidi: null, params: function() { return {}; }, result: function() { return {}; } },
    'Network.disable': { bidi: null, params: function() { return {}; }, result: function() { return {}; } },
    'Page.enable': { bidi: null, params: function() { return {}; }, result: function() { return {}; } },
    'Page.setLifecycleEventsEnabled': { bidi: null, params: function() { return {}; }, result: function() { return {}; } },
    'Runtime.enable': { bidi: null, params: function() { return {}; }, result: function() { return {}; } },
    'Runtime.disable': { bidi: null, params: function() { return {}; }, result: function() { return {}; } },
    'Runtime.runIfWaitingForDebugger': { bidi: null, params: function() { return {}; }, result: function() { return {}; } },
    'Target.setAutoAttach': { bidi: null, params: function() { return {}; }, result: function() { return {}; } },
    'Target.setDiscoverTargets': { bidi: null, params: function() { return {}; }, result: function() { return {}; } },
    'Page.setDownloadBehavior': { bidi: null, params: function() { return {}; }, result: function() { return {}; } }
  };

  // ---------- event table ----------

  var EVENT_ROUTES = {
    'browsingContext.contextCreated': function(p) {
      return [{
        method: 'Target.attachedToTarget',
        params: {
          sessionId: CDPSessionManager.sessionForContext(p.context) || '',
          targetInfo: {
            targetId: p.context,
            type: 'page',
            title: '',
            url: p.url || 'about:blank',
            attached: !!CDPSessionManager.sessionForContext(p.context),
            canAccessOpener: false,
            browserContextId: 'default'
          }
        },
        context: p.context
      }];
    },

    'browsingContext.contextDestroyed': function(p) {
      return [{
        method: 'Target.detachedFromTarget',
        params: { sessionId: CDPSessionManager.sessionForContext(p.context) || '', targetId: p.context },
        context: p.context
      }];
    },

    'browsingContext.navigationStarted': function(p) {
      var url = p.url || p.navigation ? (p.url || 'about:blank') : 'about:blank';
      return [{
        method: 'Page.frameNavigated',
        params: {
          frame: {
            id: p.context,
            url: p.url || 'about:blank',
            mimeType: '',
            securityOrigin: '',
            loaderId: p.navigation || null,
            parentId: p.parent || undefined
          }
        },
        context: p.context
      }, {
        method: 'Page.lifecycleEvent',
        params: { frameId: p.context, loaderId: p.navigation || null, name: 'init', timestamp: Date.now() / 1000 },
        context: p.context
      }];
    },

    'browsingContext.domContentLoaded': function(p) {
      return [{
        method: 'Page.domContentEventFired',
        params: { timestamp: Date.now() / 1000 },
        context: p.context
      }, {
        method: 'Page.lifecycleEvent',
        params: { frameId: p.context, loaderId: p.loaderId || null, name: 'DOMContentLoaded', timestamp: Date.now() / 1000 },
        context: p.context
      }];
    },

    'browsingContext.load': function(p) {
      return [{
        method: 'Page.loadEventFired',
        params: { timestamp: Date.now() / 1000 },
        context: p.context
      }, {
        method: 'Page.frameStoppedLoading',
        params: { frameId: p.context },
        context: p.context
      }, {
        method: 'Page.lifecycleEvent',
        params: { frameId: p.context, loaderId: p.loaderId || null, name: 'load', timestamp: Date.now() / 1000 },
        context: p.context
      }];
    },

    'browsingContext.userPromptOpened': function(p) {
      return [{
        method: 'Page.javascriptDialogOpening',
        params: { message: p.message || '', type: p.type || 'alert', defaultPrompt: '' },
        context: p.context
      }];
    },

    'script.realmCreated': function(p) {
      return [{
        method: 'Runtime.executionContextCreated',
        params: {
          context: {
            id: hashRealmId(p.realm),
            origin: p.origin || '',
            name: p.type || '',
            auxData: { frameId: p.context || '', isDefault: true }
          }
        },
        context: p.context
      }];
    },

    'script.realmDestroyed': function(p) {
      return [{
        method: 'Runtime.executionContextDestroyed',
        params: { executionContextId: hashRealmId(p.realm) },
        context: p.context
      }];
    },

    'log.entryAdded': function(p) {
      var levelMap = { error: 'error', warn: 'warning', info: 'log', debug: 'debug', trace: 'log' };
      return [{
        method: 'Runtime.consoleAPICalled',
        params: {
          type: p.level === 'error' ? 'error' : 'log',
          args: p.args ? p.args.map(RuntimeResult.toCdp) : [{ type: 'string', value: String(p.text || '') }],
          executionContextId: hashRealmId(p.source && p.source.realm),
          timestamp: Date.now(),
          level: levelMap[p.level] || 'log',
          stackTrace: undefined
        },
        context: p.context || (p.source && p.source.context)
      }];
    },

    'network.responseCompleted': function(p) {
      var requestId = p.request && p.request.request;
      return [{
        method: 'Network.loadingFinished',
        params: {
          requestId: requestId || 'req-0',
          timestamp: Date.now() / 1000,
          encodedDataLength: (p.response && p.response.body && p.response.body.size) || 0
        },
        context: p.context
      }, {
        method: 'Network.responseReceived',
        params: {
          requestId: requestId || 'req-0',
          type: 'Document',
          response: {
            url: (p.response && p.response.url) || '',
            status: (p.response && p.response.status) || 200,
            statusText: (p.response && p.response.statusText) || '',
            headers: {},
            mimeType: (p.response && p.response.mimeType) || ''
          }
        },
        context: p.context
      }];
    }
  };

  /** Deterministic numeric id for a realm id string (CDP execution ids are ints). */
  function hashRealmId(realm) {
    if (realm == null) return 0;
    if (typeof realm === 'number') return realm;
    var h = 0;
    for (var i = 0; i < realm.length; i++) h = ((h << 5) - h + realm.charCodeAt(i)) | 0;
    return Math.abs(h) || 1;
  }

  // ---------- public API ----------

  function isMapped(method) {
    return Object.prototype.hasOwnProperty.call(COMMAND_ROUTES, method);
  }

  /**
   * CDP command -> { method, params } BiDi command.
   * @throws {Error} for unmapped methods (code propagated by callers).
   */
  function translateCommand(method, params, contextId) {
    var route = COMMAND_ROUTES[method];
    if (!route) {
      var err = new Error('UnsupportedOperation: ' + method);
      err.code = UNSUPPORTED_CODE;
      throw err;
    }
    if (!route.bidi) {
      // Local-only no-op routes (Network.enable etc.) — handled without BiDi.
      return null;
    }
    if (!contextId) {
      var err2 = new Error('No target context for command: ' + method);
      err2.code = -32000;
      throw err2;
    }
    return { method: route.bidi, params: route.params(params, contextId) };
  }

  function transformCommandResult(method, bidiResult) {
    var route = COMMAND_ROUTES[method];
    if (!route) return {};
    try {
      return route.result(bidiResult);
    } catch (e) {
      return {};
    }
  }

  /**
   * BiDi event -> array of { method, params, context } CDP events.
   * The caller resolves the CDP session from `context` and drops events for
   * contexts with no attached CDP session.
   */
  function translateEvent(method, params) {
    var fn = EVENT_ROUTES[method];
    if (!fn) return [];
    try {
      return fn(params || {}) || [];
    } catch (e) {
      Logger.warn('[Mapper] Event translation failed:', method, e.message);
      return [];
    }
  }

  /** Dispatch a BiDi event through CDP event routing. */
  function handleBiDiEvent(ev) {
    var events = translateEvent(ev.method, ev.params);
    if (events.length === 0) return;
    events.forEach(function(cdpEvent) {
      var sessionId = CDPSessionManager.sessionForContext(cdpEvent.context);
      var send = cdpEvent.method === 'Target.detachedFromTarget';
      if (!send && sessionId == null) return;
      ResponseBuilder.sendEvent(cdpEvent.method, cdpEvent.params, sessionId, ConnectionManager);
    });
  }

  function unsupportedMethod(method) {
    var err = new Error('UnsupportedOperation: ' + method);
    err.code = UNSUPPORTED_CODE;
    return err;
  }

  return {
    COMMAND_ROUTES: COMMAND_ROUTES,
    EVENT_ROUTES: EVENT_ROUTES,
    DOM_WALK_SCRIPT: DOM_WALK_SCRIPT,
    unsupportedMethod: unsupportedMethod,
    isMapped: isMapped,
    translateCommand: translateCommand,
    transformCommandResult: transformCommandResult,
    translateEvent: translateEvent,
    handleBiDiEvent: handleBiDiEvent
  };
})();
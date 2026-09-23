var LocalHandler = (function() {
  // Lazy window-backed browser contexts (plan 56). Chrome has no pre-creatable
  // window handle to hold in a context id, so createBrowserContext returns a
  // lazy `window-<ts>-<rand>` id and the real window is created by the NEXT
  // createTarget carrying that id (which is what forces the window path).
  // This set keeps the ids listable/disposable. The rand suffix guarantees
  // parseInt on the id yields NaN, so window lookups never misfire on it.
  var _cdpWindowContextIds = new Set();

  function isWindowContextId(id) {
    return typeof id === 'string' && id.indexOf('window-') === 0;
  }

  function browserGetVersion() {
    var userAgent = navigator.userAgent || '';
    var match = userAgent.match(/Chrome\/([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/);
    var product = match ? 'Chrome/' + match[1] : 'Chrome';
    return {
      protocolVersion: '1.3',
      product: product,
      revision: 'navigator-relay-0.1.0',
      userAgent: userAgent,
      jsVersion: 'Chrome/' + (match ? match[1] : '')
    };
  }

  function browserClose(context) {
    var attachedTabIds = context._state.getAttachedTabIds();
    return Promise.all(attachedTabIds.map(function(tabId) {
      return chrome.debugger.detach({ tabId: tabId }).then(function() {
        context._state.removeAttachedTab(tabId);
      }).catch(function() {});
    })).then(function() {
      return chrome.windows.getCurrent().then(function(win) {
        if (win && win.id !== undefined) {
          chrome.windows.remove(win.id);
        }
        return {};
      });
    });
  }

  function targetSetDiscoverTargets() {
    return {};
  }

  function targetGetTargets() {
    return TabList.getAllAsTargets(function(targets) {
      return { targetInfos: targets };
    });
  }

  function targetGetTargetInfo(context) {
    return TabList.getTargetInfoById(context.params && context.params.targetId)
      .then(function(targetInfo) {
        if (!targetInfo) {
          throw new Error('Target not found');
        }
        return { targetInfo: targetInfo };
      });
  }

  function targetCreateBrowserContext() {
    return Config.promisifiedGetOpenInWindow().then(function(flag) {
      if (flag !== true) {
        // Legacy mock — all tabs share one context.
        var browserContextId = 'context-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
        return {
          browserContextId: browserContextId,
          _mock: true,
          _message: 'Navigator relay: all tabs share one context'
        };
      }
      // Lazy window-backed context id. The window itself is created by the
      // next createTarget carrying this id — eager window creation here meant
      // puppeteer's context.newPage() opened TWO windows (one from the
      // context, one from createTarget).
      var windowContextId = 'window-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
      _cdpWindowContextIds.add(windowContextId);
      return {
        browserContextId: windowContextId,
        _lazyWindow: true,
        _message: 'Navigator relay: window context — window opens on next createTarget with this id'
      };
    });
  }

  function targetGetBrowserContexts() {
    return Config.promisifiedGetOpenInWindow().then(function(flag) {
      var ids = ['default'];
      if (flag === true) {
        State.getCDPCreatedWindows().forEach(function(reg) {
          ids.push('window-' + reg.windowId);
        });
        _cdpWindowContextIds.forEach(function(id) { ids.push(id); });
      }
      return { browserContextIds: ids };
    });
  }

  function targetDisposeBrowserContext(context) {
    var params = context.params || {};
    var ctxId = params.browserContextId;
    if (isWindowContextId(ctxId)) {
      if (_cdpWindowContextIds.has(ctxId)) {
        // Lazy id — no window exists yet; dropping the id is the durable action.
        _cdpWindowContextIds.delete(ctxId);
      } else {
        var windowId = parseInt(ctxId.slice(7), 10);
        if (!isNaN(windowId) && State.isCDPCreatedWindow(windowId)) {
          chrome.windows.remove(windowId, function() {
            if (!chrome.runtime.lastError) State.removeCDPCreatedWindow(windowId);
          });
        }
      }
    }
    return {};
  }

  function targetAttachToBrowserTarget() {
    return { sessionId: 'browser-session' };
  }

  function systemInfoGetInfo() {
    return {
      gpu: { devices: [], drivers: [], auxAttributes: {}, featureStatus: {} },
      modelName: 'Navigator Relay',
      modelVersion: '0.1.0',
      commandLine: ''
    };
  }

  function systemInfoGetProcessInfo() {
    return { processInfo: [] };
  }

  function tetheringBind() {
    return { port: 0 };
  }

  function ioRead() {
    return { data: '', eof: true };
  }

  function ioResolveBlob() {
    return { uuid: 'mock-uuid' };
  }

  function schemaGetDomains() {
    return {
      domains: [
        { name: 'Browser', version: '1.3' },
        { name: 'Page', version: '1.3' },
        { name: 'Runtime', version: '1.3' },
        { name: 'Network', version: '1.3' },
        { name: 'DOM', version: '1.3' },
        { name: 'Target', version: '1.3' }
      ]
    };
  }

  function emptyResult() {
    return {};
  }

  function emptyArray() {
    return { items: [] };
  }

  function emptyObject() {
    return {};
  }

  return {
    browserGetVersion: browserGetVersion,
    browserClose: browserClose,
    targetSetDiscoverTargets: targetSetDiscoverTargets,
    targetGetTargets: targetGetTargets,
    targetGetTargetInfo: targetGetTargetInfo,
    targetCreateBrowserContext: targetCreateBrowserContext,
    targetGetBrowserContexts: targetGetBrowserContexts,
    targetDisposeBrowserContext: targetDisposeBrowserContext,
    targetAttachToBrowserTarget: targetAttachToBrowserTarget,
    systemInfoGetInfo: systemInfoGetInfo,
    systemInfoGetProcessInfo: systemInfoGetProcessInfo,
    tetheringBind: tetheringBind,
    ioRead: ioRead,
    ioResolveBlob: ioResolveBlob,
    schemaGetDomains: schemaGetDomains,
    emptyResult: emptyResult,
    emptyArray: emptyArray,
    emptyObject: emptyObject
  };
})();

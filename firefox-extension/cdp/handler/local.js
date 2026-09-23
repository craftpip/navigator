var LocalHandler = (function() {
  // Window-backed browser contexts (plan 56, "open new windows instead of
  // tabs"). Firefox has no pre-creatable window handle to hold in a context id,
  // so createBrowserContext returns a lazy `window-<ts>` id and the actual
  // window is created by the NEXT createTarget that carries it (that is what
  // forces type:'window'). This set keeps the ids listable/removable.
  var _windowContextIds = new Set();

  function isWindowContextId(id) {
    return typeof id === 'string' && id.indexOf('window-') === 0;
  }
  function browserGetVersion() {
    var userAgent = navigator.userAgent || '';
    var match = userAgent.match(/Firefox\/([0-9.]+)/);
    var product = 'Firefox' + (match ? '/' + match[1] : '');
    var bidiVersion = BidiClient.getBrowserVersion();
    var jsVersion = bidiVersion ? ('Firefox/' + bidiVersion) : product;
    return {
      protocolVersion: '1.3',
      product: product,
      revision: 'navigator-relay-firefox-0.1.0',
      userAgent: userAgent,
      jsVersion: jsVersion
    };
  }

  function browserClose(context) {
    return CDPSessionManager.detachAll().then(function() {
      return new Promise(function(resolve) {
        chrome.windows.getCurrent(function(win) {
          if (win && win.id !== undefined) {
            chrome.windows.remove(win.id);
          }
          resolve({});
        });
      });
    });
  }

  function targetSetDiscoverTargets() {
    return {};
  }

  function targetGetTargets() {
    return new Promise(function(resolve) {
      TabList.getAllAsTargets(function(targets) {
        resolve({ targetInfos: targets });
      });
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
      // Window-backed context id. The window itself is created lazily by the
      // next createTarget carrying this id (createTarget forces type:'window').
      var windowContextId = 'window-' + Date.now();
      _windowContextIds.add(windowContextId);
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
        _windowContextIds.forEach(function(id) { ids.push(id); });
      }
      return { browserContextIds: ids };
    });
  }

  function targetDisposeBrowserContext(context) {
    var params = context.params || {};
    var ctxId = params.browserContextId;
    if (isWindowContextId(ctxId)) {
      // Best-effort: the context's window is closed via closeTarget on its
      // tab; dropping the id from the registry is the durable action here.
      _windowContextIds.delete(ctxId);
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
var LocalHandler = (function() {
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

  function getWindowForTarget() {
    return {
      windowId: 1,
      bounds: { left: 0, top: 0, width: 1920, height: 1080, windowState: 'normal' }
    };
  }

  function getWindowBounds() {
    return {
      bounds: { left: 0, top: 0, width: 1920, height: 1080, windowState: 'normal' }
    };
  }

  function setWindowBounds(context) {
    var bounds = context.params ? context.params.bounds : null;
    if (bounds && bounds.focused) {
      chrome.windows.getCurrent(function(w) {
        if (w && w.id) {
          chrome.windows.update(w.id, { focused: true });
        }
      });
    }
    return {};
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
    var browserContextId = 'context-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
    return {
      browserContextId: browserContextId,
      _mock: true,
      _message: 'Navigator relay: all tabs share one context'
    };
  }

  function targetGetBrowserContexts() {
    return { browserContextIds: ['default'] };
  }

  function targetDisposeBrowserContext() {
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
    getWindowForTarget: getWindowForTarget,
    getWindowBounds: getWindowBounds,
    setWindowBounds: setWindowBounds,
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
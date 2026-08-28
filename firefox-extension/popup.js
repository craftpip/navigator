(function() {
  var $ = function(id) { return document.getElementById(id); };

  var statusDot = $('statusDot');
  var statusLabel = $('statusLabel');
  var errorBox = $('errorBox');
  var pinBox = $('pinBox');
  var pinInput = $('pinInput');
  var pinSubmitBtn = $('pinSubmitBtn');
  var pinCancelBtn = $('pinCancelBtn');
  var pinErrorEl = $('pinError');
  var browserNameInput = $('browserName');
  var serverUrlInput = $('serverUrl');
  var connectBtn = $('connectBtn');
  var connectSpinner = $('connectSpinner');
  var connectBtnText = $('connectBtnText');
  var pinSpinner = $('pinSpinner');
  var pinBtnText = $('pinBtnText');
  var progressBar = $('progressBar');
  var tabListEl = $('tabList');
  var connectedTimeEl = $('connectedTime');
  var serverHint = $('serverHint');
  var versionEl = $('version');

  var bidiDot = $('bidiDot');
  var bidiLabel = $('bidiLabel');
  var bidiUrlInput = $('bidiUrl');
  var bidiConnectBtn = $('bidiConnectBtn');
  var bidiDisconnectBtn = $('bidiDisconnectBtn');

  // New DOM refs for validation + connected summary
  var connectedSummary = $('connectedSummary');
  var connFields = $('connFields');
  var summaryBrowser = $('summaryBrowser');
  var summaryServer = $('summaryServer');
  var summaryStatus = $('summaryStatus');
  var fieldBrowserName = $('field-browserName');
  var fieldServerUrl = $('field-serverUrl');
  var browserNameError = $('browserNameError');
  var serverUrlError = $('serverUrlError');
  var probeBtn = $('probeBtn');
  var probeResult = $('probeResult');

  versionEl.textContent = chrome.runtime.getManifest().version;

  var _latestSnapshot = null;
  var _urlDirty = false;
  var _browserNameDirty = false;
  var _pinBusy = false;
  var _bidiBusy = false;

  function setProgress(active) {
    if (progressBar) progressBar.classList.toggle('active', !!active);
  }

  function setConnectBusy(busy) {
    if (!connectBtn || !connectSpinner || !connectBtnText) return;
    connectSpinner.style.display = busy ? '' : 'none';
    connectBtn.disabled = !!busy;
    if (busy) {
      connectBtnText.textContent = 'Connecting…';
      setProgress(true);
    }
  }

  function setPinBusy(busy) {
    _pinBusy = !!busy;
    if (pinSpinner) pinSpinner.style.display = busy ? '' : 'none';
    if (pinBtnText) pinBtnText.textContent = busy ? 'Verifying…' : 'Verify';
    if (pinSubmitBtn) pinSubmitBtn.disabled = !!busy;
    setProgress(busy || _bidiBusy || (_latestSnapshot && _latestSnapshot.connecting));
    if (busy) setPinError('');
  }

  function setBidiBusy(busy) {
    _bidiBusy = !!busy;
    if (bidiConnectBtn) {
      bidiConnectBtn.disabled = !!busy;
      if (busy) {
        bidiConnectBtn.innerHTML = '<span class="spinner spinner-sm" style="width:11px;height:11px;border-width:1.5px"></span> Connecting…';
      } else {
        bidiConnectBtn.textContent = 'Connect';
      }
    }
    setProgress(busy || _pinBusy || (_latestSnapshot && _latestSnapshot.connecting));
  }

  function autoDetectServerUrl() {
    if (!serverUrlInput.value) {
      if (serverHint) serverHint.textContent = 'No relay configured. Enter host:port (e.g. localhost:1994)';
    }
  }

  function setStatus(status, label) {
    statusDot.className = 'status-dot ' + status;
    statusLabel.textContent = label || status;
  }

  function setBidiStatus(connected, error) {
    if (connected) {
      bidiDot.className = 'status-dot connected';
      bidiLabel.textContent = 'Connected';
    } else if (error) {
      bidiDot.className = 'status-dot error';
      bidiLabel.textContent = 'Error';
    } else {
      bidiDot.className = 'status-dot off';
      bidiLabel.textContent = 'Off';
    }
  }

  function setError(msg) {
    if (msg) {
      errorBox.textContent = msg;
      errorBox.style.display = 'block';
    } else {
      errorBox.textContent = '';
      errorBox.style.display = 'none';
    }
  }

  function setPinVisibility(show) {
    pinBox.style.display = show ? 'block' : 'none';
    if (show) {
      pinInput.focus();
    }
  }

  function setPinError(msg) {
    if (!pinErrorEl) return;
    if (msg) {
      pinErrorEl.textContent = msg;
      pinErrorEl.classList.add('visible');
    } else {
      pinErrorEl.textContent = '';
      pinErrorEl.classList.remove('visible');
    }
  }

  function setFieldsDisabled(disabled) {
    browserNameInput.disabled = disabled;
    serverUrlInput.disabled = disabled;
    browserNameInput.style.opacity = disabled ? '0.6' : '';
    serverUrlInput.style.opacity = disabled ? '0.6' : '';
  }

  // ---- Validation helpers (professional copy) ----

  function validateBrowserName(value) {
    var v = String(value || '').trim();
    if (!v) return 'Browser name is required — please enter an identifier for this browser (e.g., “Firefox”).';
    if (v.length < 2) return 'Browser name must be at least 2 characters.';
    if (v.length > 48) return 'Browser name must be 48 characters or fewer.';
    if (/[\x00-\x1F\x7F]/.test(v)) return 'Browser name contains invalid characters — please use letters, numbers, spaces, hyphens or underscores.';
    if (!/^[A-Za-z0-9 _\-\.\(\)\u00C0-\u024F]+$/.test(v)) return 'Browser name may only include letters, numbers, spaces, hyphens, underscores, dots and parentheses.';
    return null;
  }

  function validateServerUrl(value) {
    var v = String(value || '').trim();
    if (!v) return 'Navigator server address is required — please enter host and port (e.g., localhost:1994).';
    if (/\s/.test(v)) return 'Server address must not contain spaces — expected host:port (e.g., 10.69.1.164:1994).';
    var lower = v.toLowerCase();
    var hasScheme = v.indexOf('://') !== -1;
    if (hasScheme) {
      if (!(lower.indexOf('ws://') === 0 || lower.indexOf('wss://') === 0 || lower.indexOf('http://') === 0 || lower.indexOf('https://') === 0)) {
        return 'Server address scheme must be ws://, wss://, http:// or https:// — or just enter host:port.';
      }
      var withoutScheme = v.replace(/^.*?:\/\//, '');
      var hostPort = withoutScheme.split('/')[0];
      if (!hostPort) return 'Please enter a valid server address — expected host:port (e.g., localhost:1994).';
      v = hostPort;
    } else {
      v = v.split('/')[0];
    }
    v = v.replace(/:+$/, '');
    if (!v) return 'Please enter a valid server address — expected host:port (e.g., localhost:1994).';
    var colonIdx = v.lastIndexOf(':');
    if (colonIdx !== -1) {
      var host = v.substring(0, colonIdx);
      var port = v.substring(colonIdx + 1);
      if (!host) return 'Please enter a valid server address — host is missing before the colon.';
      if (!/^\d+$/.test(port)) return 'Port must be a number — for example, localhost:1994.';
      var p = parseInt(port, 10);
      if (p < 1 || p > 65535) return 'Port must be between 1 and 65535.';
      if (host.length > 253) return 'Server hostname is too long.';
    } else {
      if (v.length < 2) return 'Please enter a valid server address — expected host:port (e.g., localhost:1994).';
    }
    var hostPart = v.indexOf(':') !== -1 ? v.substring(0, v.lastIndexOf(':')) : v;
    if (!/^[A-Za-z0-9\-\.\[\]:]+$/.test(hostPart) && !/^[A-Za-z0-9\-\.]+$/.test(hostPart)) {
      return 'Server address contains invalid characters — use host:port (e.g., 10.69.1.164:1994).';
    }
    return null;
  }

  function clearFieldErrors() {
    if (fieldBrowserName) fieldBrowserName.classList.remove('error');
    if (fieldServerUrl) fieldServerUrl.classList.remove('error');
    if (browserNameError) browserNameError.textContent = '';
    if (serverUrlError) serverUrlError.textContent = '';
  }

  function showFieldError(fieldEl, errorEl, msg) {
    if (fieldEl) fieldEl.classList.add('error');
    if (errorEl) errorEl.textContent = msg;
  }

  function validateForm() {
    clearFieldErrors();
    var bVal = browserNameInput.value;
    var sVal = serverUrlInput.value;
    var bErr = validateBrowserName(bVal);
    var sErr = validateServerUrl(sVal);
    var hasError = false;
    if (bErr) {
      showFieldError(fieldBrowserName, browserNameError, bErr);
      hasError = true;
    }
    if (sErr) {
      showFieldError(fieldServerUrl, serverUrlError, sErr);
      hasError = true;
    }
    if (hasError) {
      setError('Please correct the highlighted fields before connecting.');
      if (bErr) browserNameInput.focus();
      else if (sErr) serverUrlInput.focus();
      setStatus('error', 'Please check the form');
      return false;
    }
    setError(null);
    return true;
  }

  function setFormVisibility(connected) {
    if (connFields) {
      if (connected) connFields.classList.add('hidden');
      else connFields.classList.remove('hidden');
    }
    if (connectedSummary) {
      if (connected) connectedSummary.classList.add('visible');
      else connectedSummary.classList.remove('visible');
    }
  }

  function updateConnectedSummary(snapshot) {
    if (!connectedSummary) return;
    var bName = snapshot.browserName || browserNameInput.value.trim() || 'Firefox';
    var sUrl = snapshot.serverUrl || serverUrlInput.value.trim() || '—';
    if (summaryBrowser) summaryBrowser.textContent = bName;
    if (summaryServer) {
      var display = String(sUrl).replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '').replace(/\/relay\/?$/, '');
      summaryServer.textContent = display || sUrl;
      summaryServer.title = sUrl;
    }
    if (summaryStatus) {
      if (snapshot.connected) summaryStatus.textContent = 'Connected';
      else if (snapshot.connecting) summaryStatus.textContent = 'Connecting…';
      else summaryStatus.textContent = 'Not connected';
    }
  }

  function showTabs(snapshot) {
    _latestSnapshot = snapshot || _latestSnapshot;
    if (!_latestSnapshot) return;

    var attachedPages = (_latestSnapshot.tabs || []).filter(function(t) { return t.attached; });
    var tabs = _latestSnapshot.tabs || [];

    if (!tabs || tabs.length === 0) {
      tabListEl.innerHTML = '<div class="tab-empty">No tabs listed yet</div>';
      return;
    }

    var html = '';
    tabs.slice(0, 30).forEach(function(tab) {
      var tabId = tab.tabId || tab.id;
      var title = tab.title || 'Untitled';
      var url = tab.url || '';
      var attached = !!tab.attached;
      var btnClass = attached ? 'attached-btn' : '';
      var btnLabel = attached ? '✓' : 'Attach';

      html += '<div class="tab-item">' +
        '<div class="tab-info">' +
          '<div class="tab-title">' + escapeHtml(title) + '</div>' +
          '<div class="tab-url">' + escapeHtml(url) + '</div>' +
        '</div>' +
        '<div class="tab-action">' +
          '<button class="' + btnClass + '" data-tab-id="' + tabId + '" data-action="' + (attached ? 'detach' : 'attach') + '">' + btnLabel + '</button>' +
        '</div>' +
      '</div>';
    });
    tabListEl.innerHTML = html;

    var buttons = tabListEl.querySelectorAll('button[data-action]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function() {
        var btn = this;
        var tabId = parseInt(btn.getAttribute('data-tab-id'), 10);
        var action = btn.getAttribute('data-action');
        var origLabel = btn.textContent;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner spinner-sm" style="width:11px;height:11px;border-width:1.5px"></span>';
        setProgress(true);
        var done = function() {
          setTimeout(function() {
            if (!_pinBusy && !_bidiBusy && !(_latestSnapshot && _latestSnapshot.connecting)) setProgress(false);
            loadState();
          }, 300);
        };
        if (action === 'attach') {
          chrome.runtime.sendMessage({ type: 'attach-tab', tabId: tabId }, done);
        } else {
          chrome.runtime.sendMessage({ type: 'detach-tab', tabId: tabId }, done);
        }
        setTimeout(function() {
          if (btn.disabled) { btn.textContent = origLabel; btn.disabled = false; }
        }, 4000);
      });
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function loadState() {
    chrome.runtime.sendMessage({ type: 'popup-query' }, function(snapshot) {
      if (!snapshot) return;
      _latestSnapshot = snapshot;

      var isBusy = !!snapshot.connecting || _pinBusy || _bidiBusy;

      if (snapshot.connected) {
        setStatus('connected', 'Connected');
        connectBtnText.textContent = 'Disconnect';
        connectBtn.className = 'btn-full btn-off';
        connectSpinner.style.display = 'none';
        connectBtn.style.display = '';
        connectBtn.disabled = false;
        setPinVisibility(false);
        setFieldsDisabled(false);
        setPinError('');
        clearFieldErrors();
        setFormVisibility(true);
        updateConnectedSummary(snapshot);
        if (!_pinBusy && !_bidiBusy) setProgress(false); else setProgress(true);
      } else if (snapshot.pairing || snapshot.pinRequired) {
        setStatus('connecting', snapshot.pinRequired ? 'PIN Required' : 'Pairing');
        connectBtn.style.display = 'none';
        connectSpinner.style.display = 'none';
        setPinVisibility(true);
        setFieldsDisabled(true);
        setPinError(snapshot.pinError || null);
        setFormVisibility(false);
        if (!_pinBusy) {
          pinSpinner.style.display = 'none';
          if (pinBtnText) pinBtnText.textContent = 'Verify';
        }
        setProgress(_pinBusy || isBusy);
      } else if (snapshot.connecting) {
        setStatus('connecting', 'Connecting…');
        connectBtn.style.display = '';
        connectBtn.className = 'btn-full';
        connectBtnText.textContent = 'Connecting…';
        connectSpinner.style.display = '';
        connectBtn.disabled = true;
        setPinVisibility(false);
        setFieldsDisabled(true);
        setPinError('');
        clearFieldErrors();
        setFormVisibility(false);
        setProgress(true);
      } else if (snapshot.lastError) {
        setStatus('error', 'Error');
        connectBtn.style.display = '';
        connectBtn.className = 'btn-full';
        connectBtnText.textContent = 'Connect';
        connectSpinner.style.display = 'none';
        connectBtn.disabled = false;
        setPinVisibility(false);
        setFieldsDisabled(false);
        setPinError('');
        setFormVisibility(false);
        updateConnectedSummary(snapshot);
        setProgress(_pinBusy || _bidiBusy);
      } else if (snapshot.paired) {
        setStatus('off', 'Paired — disconnected');
        connectBtn.style.display = '';
        connectBtn.className = 'btn-full';
        connectBtnText.textContent = 'Connect';
        connectSpinner.style.display = 'none';
        connectBtn.disabled = false;
        setPinVisibility(false);
        setFieldsDisabled(false);
        setPinError('');
        setFormVisibility(false);
        updateConnectedSummary(snapshot);
        setProgress(_pinBusy || _bidiBusy);
      } else {
        setStatus('off', 'Off — not paired');
        connectBtn.style.display = '';
        connectBtn.className = 'btn-full';
        connectBtnText.textContent = 'Connect';
        connectSpinner.style.display = 'none';
        connectBtn.disabled = false;
        setPinVisibility(false);
        setFieldsDisabled(false);
        setPinError('');
        setFormVisibility(false);
        updateConnectedSummary(snapshot);
        setProgress(_pinBusy || _bidiBusy);
      }

      if (!snapshot.connecting && !_pinBusy) {
        if (snapshot.connected) connectBtn.disabled = false;
      }

      var hasValidationError = fieldBrowserName && fieldBrowserName.classList.contains('error') ||
                               fieldServerUrl && fieldServerUrl.classList.contains('error');
      if (!hasValidationError) {
        var showError = snapshot.lastError;
        if (snapshot.pairing || snapshot.pinRequired) showError = null;
        if (showError && showError.indexOf('PIN required') !== -1 && (snapshot.pairing || snapshot.pinRequired)) showError = null;
        setError(showError || null);
      }

      if (!_browserNameDirty) {
        browserNameInput.value = snapshot.browserName || 'Firefox';
      }
      if (!_urlDirty) {
        serverUrlInput.value = snapshot.serverUrl || '';
      }
      if (snapshot.connected) updateConnectedSummary(snapshot);

      setBidiStatus(snapshot.bidiConnected, snapshot.bidiError);
      if (document.activeElement !== bidiUrlInput) {
        bidiUrlInput.value = snapshot.bidiUrl || 'ws://127.0.0.1:9222/session';
      }

      if (snapshot.connected && snapshot.connectedAt) {
        var secs = Math.floor((Date.now() - snapshot.connectedAt) / 1000);
        connectedTimeEl.textContent = 'Connected ' + secs + 's ago';
      } else {
        connectedTimeEl.textContent = '';
      }

      showTabs(snapshot);
    });
  }

  function StateIsConnectedViaUI() {
    return connectBtnText && connectBtnText.textContent === 'Disconnect';
  }

  connectBtn.addEventListener('click', function() {
    if (StateIsConnectedViaUI()) {
      connectBtn.disabled = true;
      connectBtnText.textContent = 'Disconnecting…';
      connectSpinner.style.display = '';
      setProgress(true);
      chrome.runtime.sendMessage({ type: 'disconnect' }, function() { setTimeout(loadState, 150); });
    } else {
      if (!validateForm()) return;
      setStatus('connecting', 'Connecting…');
      setConnectBusy(true);
      setFieldsDisabled(true);
      chrome.runtime.sendMessage({
        type: 'connect',
        serverUrl: serverUrlInput.value.trim(),
        browserName: browserNameInput.value.trim() || 'Firefox'
      }, function() {
        _urlDirty = false;
        _browserNameDirty = false;
        loadState();
      });
    }
  });

  serverUrlInput.addEventListener('input', function() {
    _urlDirty = true;
    if (fieldServerUrl && fieldServerUrl.classList.contains('error')) {
      fieldServerUrl.classList.remove('error');
      if (serverUrlError) serverUrlError.textContent = '';
      var stillError = fieldBrowserName && fieldBrowserName.classList.contains('error');
      if (!stillError) setError(null);
    }
  });
  browserNameInput.addEventListener('input', function() {
    _browserNameDirty = true;
    if (fieldBrowserName && fieldBrowserName.classList.contains('error')) {
      fieldBrowserName.classList.remove('error');
      if (browserNameError) browserNameError.textContent = '';
      var stillError = fieldServerUrl && fieldServerUrl.classList.contains('error');
      if (!stillError) setError(null);
    }
  });

  probeBtn.addEventListener('click', function() {
    var target = (serverUrlInput.value || '').trim();
    if (!target) {
      probeResult.className = 'probe-result err';
      probeResult.textContent = 'Enter a host:port first (e.g. 10.69.1.164:1994)';
      return;
    }
    probeResult.className = 'probe-result running';
    probeResult.textContent = 'Probing ' + target + '…';
    probeBtn.disabled = true;
    chrome.runtime.sendMessage({ type: 'probe', hostPort: target }, function(res) {
      probeBtn.disabled = false;
      if (chrome.runtime.lastError) {
        probeResult.className = 'probe-result err';
        probeResult.textContent = 'Error: ' + chrome.runtime.lastError.message;
        return;
      }
      if (res && res.success && res.result) {
        var r = res.result;
        if (r.ok) {
          probeResult.className = 'probe-result ok';
          probeResult.textContent = (r.scheme || '?') + '://' + (r.hostPort || target) +
            ' is reachable — HTTP ' + r.status + (r.body ? ' · ' + r.body : '');
        } else {
          probeResult.className = 'probe-result err';
          probeResult.textContent = (r.error || 'not reachable') +
            (r.mode ? ' (' + r.mode + ')' : '');
        }
      } else {
        probeResult.className = 'probe-result err';
        probeResult.textContent = (res && res.detail) ? res.detail : 'Probe failed';
      }
    });
  });

  bidiConnectBtn.addEventListener('click', function() {
    setBidiBusy(true);
    setProgress(true);
    chrome.runtime.sendMessage({
      type: 'bidi-connect',
      bidiUrl: bidiUrlInput.value.trim()
    }, function(res) {
      setBidiBusy(false);
      if (res && res.error) {
        setError('BiDi: ' + res.error);
      } else {
        setError(null);
      }
      loadState();
    });
  });

  bidiDisconnectBtn.addEventListener('click', function() {
    chrome.runtime.sendMessage({ type: 'bidi-disconnect' }, function() { loadState(); });
  });

  pinSubmitBtn.addEventListener('click', function() {
    var pin = pinInput.value.trim();
    if (!pin) {
      setPinError('Please enter the 6-digit pairing PIN shown in the Navigator console (Browser drivers → PIN required).');
      pinInput.focus();
      return;
    }
    if (!/^\d{6}$/.test(pin)) {
      setPinError('PIN must be 6 digits — please check the PIN shown in the Navigator console and try again.');
      pinInput.focus();
      return;
    }
    setPinBusy(true);
    chrome.runtime.sendMessage({ type: 'send-pin', pin: pin }, function() {
      pinInput.value = '';
      setTimeout(function() { setPinBusy(false); loadState(); }, 900);
    });
  });

  pinInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      pinSubmitBtn.click();
    }
  });

  pinInput.addEventListener('input', function() {
    if (pinErrorEl && pinErrorEl.classList.contains('visible')) setPinError('');
  });

  if (pinCancelBtn) {
    pinCancelBtn.addEventListener('click', function() {
      setPinBusy(false);
      clearFieldErrors();
      setError(null);
      chrome.runtime.sendMessage({ type: 'disconnect' }, function() {
        _urlDirty = false;
        _browserNameDirty = false;
        loadState();
      });
    });
  }

  chrome.runtime.onMessage.addListener(function(message) {
    if (message && (message.type === 'stateUpdate' ||
        message.type === 'connection-status-changed' ||
        message.type === 'bidi-status-changed' ||
        message.type === 'pin-required')) {
      loadState();
    }
  });

  setInterval(function() {
    if (document.visibilityState === 'visible') {
      loadState();
    }
  }, 3000);

  autoDetectServerUrl();
  loadState();
})();

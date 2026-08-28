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

  versionEl.textContent = chrome.runtime.getManifest().version;

  var lastActiveTabIds = null;
  var _latestSnapshot = null;
  var _urlDirty = false;
  var _browserNameDirty = false;
  var _pinBusy = false;

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
    setProgress(busy || (connectBtn && connectBtn.disabled));
    if (busy) setPinError('');
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
    if (!v) return 'Browser name is required — please enter an identifier for this browser (e.g., “Chrome Dev”).';
    if (v.length < 2) return 'Browser name must be at least 2 characters.';
    if (v.length > 48) return 'Browser name must be 48 characters or fewer.';
    // Allow letters, numbers, spaces, hyphens, underscores, dots and parentheses
    // Use a permissive pattern — reject only clearly unsafe/control chars
    if (/[\x00-\x1F\x7F]/.test(v)) return 'Browser name contains invalid characters — please use letters, numbers, spaces, hyphens or underscores.';
    if (!/^[A-Za-z0-9 _\-\.\(\)\u00C0-\u024F]+$/.test(v)) return 'Browser name may only include letters, numbers, spaces, hyphens, underscores, dots and parentheses.';
    return null;
  }

  function validateServerUrl(value) {
    var v = String(value || '').trim();
    if (!v) return 'Navigator server address is required — please enter host and port (e.g., localhost:1994).';
    if (/\s/.test(v)) return 'Server address must not contain spaces — expected host:port (e.g., 10.69.1.164:1994).';
    // If scheme present, validate it and strip for host check
    var lower = v.toLowerCase();
    var hasScheme = v.indexOf('://') !== -1;
    if (hasScheme) {
      if (!(lower.indexOf('ws://') === 0 || lower.indexOf('wss://') === 0 || lower.indexOf('http://') === 0 || lower.indexOf('https://') === 0)) {
        return 'Server address scheme must be ws://, wss://, http:// or https:// — or just enter host:port.';
      }
      // Strip scheme and optional path
      var withoutScheme = v.replace(/^.*?:\/\//, '');
      var hostPort = withoutScheme.split('/')[0];
      if (!hostPort) return 'Please enter a valid server address — expected host:port (e.g., localhost:1994).';
      v = hostPort;
    } else {
      // Bare host:port — strip any trailing path
      v = v.split('/')[0];
    }
    v = v.replace(/:+$/, '');
    if (!v) return 'Please enter a valid server address — expected host:port (e.g., localhost:1994).';
    // Validate host:port shape
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
      // No port — warn but allow (common to omit port when default is implied)
      // However for Navigator the port is expected; show a gentle hint as error
      // to encourage correct input. Treat as missing port.
      // We keep this as a soft error only if value looks like bare host without port
      // — but still accept plain "localhost" as incomplete rather than wrong.
      if (v.length < 2) return 'Please enter a valid server address — expected host:port (e.g., localhost:1994).';
      if (v.indexOf('.') === -1 && v !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(v)) {
        // Single label without dot and not localhost/IP — likely incomplete
        // Still allow; do not error — user may have typed "mynavigator"
      }
    }
    // Host characters check
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
      // Focus first invalid field
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
    var bName = snapshot.browserName || browserNameInput.value.trim() || 'Chrome';
    var sUrl = snapshot.serverUrl || serverUrlInput.value.trim() || '—';
    if (summaryBrowser) summaryBrowser.textContent = bName;
    if (summaryServer) {
      // Show host:port compactly; title holds full
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

    var attachedPages = _latestSnapshot.attachedPages || [];

    // Refresh from a list-tabs request snapshot if available
    var tabs = _latestSnapshot.tabs && _latestSnapshot.tabs.length > 0
      ? _latestSnapshot.tabs
      : _latestSnapshot.attachedPages;

    if (attachedPages.length === 0 && (!tabs || tabs.length === 0)) {
      tabListEl.innerHTML = '<div class="tab-empty">No tabs listed yet</div>';
      return;
    }

    var html = '';
    (tabs || []).slice(0, 30).forEach(function(tab) {
      var tabId = tab.tabId || tab.id;
      var title = tab.title || 'Untitled';
      var url = tab.url || '';
      var attached = attachedPages.some(function(a) { return a.tabId === tabId; });
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

    // Wire up attach/detach buttons — show a spinner on the clicked row
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
          // loadState will fully re-render the list; just ensure progress
          // is cleared if no other busy is active
          setTimeout(function() {
            if (!_pinBusy && !(_latestSnapshot && _latestSnapshot.connecting)) setProgress(false);
            loadState();
          }, 300);
        };
        if (action === 'attach') {
          chrome.runtime.sendMessage({ type: 'attach-tab', tabId: tabId }, done);
        } else {
          chrome.runtime.sendMessage({ type: 'detach-tab', tabId: tabId }, done);
        }
        // Restore label quickly if sendMessage fails synchronously
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

      var isBusy = !!snapshot.connecting || _pinBusy;

      if (snapshot.connected) {
        setStatus('connected', 'Connected');
        connectBtn.style.display = '';
        connectBtnText.textContent = 'Disconnect';
        connectBtn.className = 'btn-full btn-off';
        connectSpinner.style.display = 'none';
        connectBtn.disabled = false;
        setPinVisibility(false);
        setFieldsDisabled(false);
        setPinError('');
        clearFieldErrors();
        setFormVisibility(true);
        updateConnectedSummary(snapshot);
        if (!_pinBusy) setProgress(false);
        else setProgress(true);
      } else if (snapshot.pairing || snapshot.pinRequired) {
        setStatus('connecting', snapshot.pinRequired ? 'PIN Required' : 'Pairing');
        connectBtn.style.display = 'none';
        connectSpinner.style.display = 'none';
        setPinVisibility(true);
        setFieldsDisabled(true);
        setPinError(snapshot.pinError || null);
        setFormVisibility(false);
        // keep pin spinner if we are verifying; otherwise hide
        if (!_pinBusy) {
          pinSpinner.style.display = 'none';
          pinBtnText.textContent = 'Verify';
        }
        setProgress(_pinBusy);
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
        setProgress(_pinBusy);
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
        setProgress(_pinBusy);
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
        setProgress(_pinBusy);
      }
      // If not connecting and not pin-busy, ensure spinner hidden & button enabled
      if (!snapshot.connecting && !_pinBusy) {
        // leave disconnect case enabled; already handled
        if (snapshot.connected) connectBtn.disabled = false;
      }

      /* Keep the top error box for connection-level errors only. PIN
         rejections render inline under the PIN field (pinError), so they
         never clutter the status strip and never vanish on a reconnect.
         Validation errors are shown inline + in errorBox with the
         "Please correct the highlighted fields" message — clear them
         when the snapshot shows a connection-level error override. */
      // Do not overwrite validation errorBox if fields are currently in error state
      var hasValidationError = fieldBrowserName && fieldBrowserName.classList.contains('error') ||
                               fieldServerUrl && fieldServerUrl.classList.contains('error');
      if (!hasValidationError) {
        setError((!snapshot.pairing && !snapshot.pinRequired) ? snapshot.lastError : null);
      }
      // Prefill only until the user starts typing — never clobber a field
      // they're editing on the 3s refresh. Also never overwrite when connected
      // (summary is shown instead) — but keep inputs in sync for next disconnect.
      if (!_browserNameDirty) {
        browserNameInput.value = snapshot.browserName || 'Chrome';
      }
      if (!_urlDirty) {
        serverUrlInput.value = snapshot.serverUrl || '';
      }
      if (snapshot.connected) updateConnectedSummary(snapshot);

      if (snapshot.connected && snapshot.connectedAt) {
        var secs = Math.floor((Date.now() - snapshot.connectedAt) / 1000);
        connectedTimeEl.textContent = 'Connected ' + secs + 's ago';
      } else {
        connectedTimeEl.textContent = '';
      }

      showTabs(snapshot);
    });
  }

  connectBtn.addEventListener('click', function() {
    if (StateIsConnectedViaUI()) {
      // Disconnect — brief busy feedback
      connectBtn.disabled = true;
      connectBtnText.textContent = 'Disconnecting…';
      connectSpinner.style.display = '';
      setProgress(true);
      chrome.runtime.sendMessage({ type: 'disconnect' }, function() {
        setTimeout(loadState, 150);
      });
    } else {
      // Validate before connecting
      if (!validateForm()) return;
      // Connect — give immediate feedback, the state broadcast will refine it
      setStatus('connecting', 'Connecting…');
      setConnectBusy(true);
      setFieldsDisabled(true);
      chrome.runtime.sendMessage({
        type: 'connect',
        serverUrl: serverUrlInput.value.trim(),
        browserName: browserNameInput.value.trim() || 'Chrome'
      }, function() {
        _urlDirty = false;
        _browserNameDirty = false;
        loadState();
      });
    }
  });

  serverUrlInput.addEventListener('input', function() {
    _urlDirty = true;
    // Clear validation error as user types
    if (fieldServerUrl && fieldServerUrl.classList.contains('error')) {
      fieldServerUrl.classList.remove('error');
      if (serverUrlError) serverUrlError.textContent = '';
      // Clear top error if no field remains in error
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
      // keep spinner until next state update clears it
      setTimeout(function() { setPinBusy(false); loadState(); }, 900);
    });
  });

  pinInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      pinSubmitBtn.click();
    }
  });

  // Clear PIN error as user types
  pinInput.addEventListener('input', function() {
    if (pinErrorEl && pinErrorEl.classList.contains('visible')) setPinError('');
  });

  pinCancelBtn.addEventListener('click', function() {
    // Abort the pending pairing: closing the socket makes the server drop
    // this browser's pending entry, and we return to the plain URL form.
    clearFieldErrors();
    setError(null);
    chrome.runtime.sendMessage({ type: 'disconnect' }, function() {
      _urlDirty = false;
      _browserNameDirty = false;
      loadState();
    });
  });

  function StateIsConnectedViaUI() {
    return connectBtnText && connectBtnText.textContent === 'Disconnect';
  }

  // Listen for state broadcasts from background to keep popup fresh
  chrome.runtime.onMessage.addListener(function(message) {
    if (message && (message.type === 'stateUpdate' ||
        message.type === 'connection-status-changed' ||
        message.type === 'pin-required')) {
      loadState();
    }
  });

  // Refresh tab list every 3s while popup open
  setInterval(function() {
    if (document.visibilityState === 'visible') {
      loadState();
    }
  }, 3000);

  autoDetectServerUrl();
  loadState();
})();

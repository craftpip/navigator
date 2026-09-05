#!/usr/bin/env bash
# Launch Firefox with the Navigator Browser Relay extension loaded,
# Remote Agent (WebDriver BiDi) enabled on :9222, wired to the navigator
# server (default http://10.69.1.164:1994 — override with NAVIGATOR_URL).
#
# Two load paths:
#   1. web-ext (developer/repeatable) — loads the unpacked extension
#      temporarily, watches for changes, auto-reloads. Needs:
#        npm i -g web-ext   (or npx web-ext)
#   2. Native (no deps) — starts Firefox with --remote-debugging-port and the
#      extension profile; load the extension once via about:debugging ->
#      "Load Temporary Add-on" -> select firefox-extension/manifest.json.
#      Firefox remembers temp add-ons for the session only, re-add after restart.
#
# Firefox will connect back to the navigator relay at $NAVIGATOR_URL.
# Verify:  curl -s http://10.69.1.164:1994/health
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$SCRIPT_DIR"
PROFILE_DIR="${FIREFOX_PROFILE:-$SCRIPT_DIR/firefox-profile}"
NAVIGATOR_URL="${NAVIGATOR_URL:-http://10.69.1.164:1994}"
BIDI_PORT="${BIDI_PORT:-9222}"
# CRITICAL: Firefox's Remote Agent rejects any WebSocket whose `Origin` header
# is not allow-listed (default: only accepts requests with NO Origin header).
# The extension's BidiClient opens `new WebSocket("ws://127.0.0.1:<port>/session")`
# from a moz-extension context, which Firefox sends an
# `Origin: moz-extension://<uuid>` header for — so it is 400'd at handshake and
# every CDP command that maps to BiDi fails with "BiDi not connected".
# Firefox does a STRICT scheme/host/port match (no `*` wildcard, unlike Chrome),
# so the allow-list MUST be the extension's exact origin. Set it:
#   ALLOWED_ORIGINS="moz-extension://<your-extension-uuid>"
# Find the UUID: about:debugging#/runtime/this-firefox -> the extension's ID, or
# from the extension itself: browser.runtime.getURL('') gives moz-extension://<uuid>/.
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-}"

if [ ! -f "$EXT_DIR/manifest.json" ]; then
  echo "Extension not found at $EXT_DIR" >&2
  exit 1
fi

FIREFOX_BIN="$(command -v firefox || command -v firefox-esr || true)"
if [ -z "$FIREFOX_BIN" ]; then
  if command -v flatpak >/dev/null 2>&1 && flatpak info org.mozilla.firefox >/dev/null 2>&1; then
    FIREFOX_BIN="flatpak run org.mozilla.firefox"
  else
    echo "Firefox not found (looked for firefox / firefox-esr / flatpak). Install it first." >&2
    exit 1
  fi
fi

mkdir -p "$PROFILE_DIR"

echo "Navigator Browser Relay — Firefox"
echo "  navigator relay : $NAVIGATOR_URL"
echo "  BiDi endpoint   : ws://127.0.0.1:$BIDI_PORT/session"
echo "  profile         : $PROFILE_DIR"

# Tell the extension (via the popup) where the server lives. The popup also
# has input fields for both URLs; this just makes the defaults correct.
export NAVIGATOR_URL

if [ -z "$ALLOWED_ORIGINS" ]; then
  echo "ERROR: ALLOWED_ORIGINS is required." >&2
  echo "  Firefox's Remote Agent rejects the extension's WebSocket (it sends" >&2
  echo "  'Origin: moz-extension://<uuid>') unless that exact origin is allowed." >&2
  echo "  Firefox does a strict scheme/host/port match — NO '*' wildcard." >&2
  echo "  Set it to your extension's origin, e.g.:" >&2
  echo "    ALLOWED_ORIGINS='moz-extension://<your-uuid>' ./launch-firefox.sh" >&2
  echo "  Get the UUID: about:debugging#/runtime/this-firefox (the extension's" >&2
  echo "  internal ID) — or the popup's bidiUrl default: ws://127.0.0.1:9222/session." >&2
  exit 2
fi

if command -v web-ext >/dev/null 2>&1 || npx --no-install web-ext --version >/dev/null 2>&1; then
  echo "  loader          : web-ext (temporary add-on, auto-reload)"
  # web-ext can't forward --remote-allow-origins, but it prefers prefs over
  # the CLI flag. Set remote.origins.allowed (the pref the Remote Agent reads
  # when the CLI flag is absent) to the same value.
  npx --no-install web-ext run \
    --source-dir "$EXT_DIR" \
    --firefox "$FIREFOX_BIN" \
    --firefox-profile "$PROFILE_DIR" \
    --remote-debugging-port "$BIDI_PORT" \
    --no-input \
    --keep-profile-changes \
    --start-url "about:blank" \
    --pref "remote.origins.allowed=$ALLOWED_ORIGINS"
  # ^ Ctrl+C to stop; web-ext reloads the extension on file edits.
else
  echo "  loader          : native --remote-debugging-port (add-on via about:debugging)"
  echo "  Once Firefox opens: Ctrl+Shift+A(mac) / about:debugging#/runtime/this-firefox"
  echo "  -> Load Temporary Add-on -> choose $EXT_DIR"
  if [ "$FIREFOX_BIN" = "flatpak run org.mozilla.firefox" ]; then
    # flatpak: forward the CLI args to the app
    flatpak run --command=firefox org.mozilla.firefox \
      --remote-debugging-port "$BIDI_PORT" \
      --remote-allow-origins "$ALLOWED_ORIGINS" \
      -profile "$PROFILE_DIR" \
      --new-window "about:blank"
  else
    "$FIREFOX_BIN" \
      --remote-debugging-port "$BIDI_PORT" \
      --remote-allow-origins "$ALLOWED_ORIGINS" \
      -profile "$PROFILE_DIR" \
      --new-window "about:blank"
  fi
fi

echo ""
echo "Next: 1) open the relay popup (extension toolbar icon), set the server URL"
echo "        if it isn't $NAVIGATOR_URL, connect (PIN once), Connect BiDi."
echo "       2) navigator side: add Firefox as a BROWSERS entry, e.g.:"
echo '          BROWSERS=[{"name":"chromium","role":[]},{"name":"firefox","role":["default","search","fetch","screenshot","devtools"],"cdpUrl":"http://127.0.0.1:9222"}]'
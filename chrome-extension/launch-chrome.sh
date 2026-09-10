#!/usr/bin/env bash
# Launch the Navigator Browser Relay Chrome extension in a dedicated dev
# Chromium for development + full-cycle testing (pair -> drive -> verify).
#
# This runs in the DEV environment (this container), using a Chromium that is
# SEPARATE from the one inside the navigator container — so it never interferes
# with navigator's own chromium. See ../README.md (project) + this folder's
# README for the complete dev/test cycle.
#
#   ./chrome-extension/launch-chrome.sh            # default
#   NAVIGATOR_URL=http://10.69.1.164:1994 ./launch-chrome.sh
#   CDP_PORT=9333 BROWSER_NAME="dev-chrome" ./launch-chrome.sh
#
# What it does:
#   * starts a headed Chromium under Xvfb (this container has no real display)
#     with --load-extension=<this folder>, so the unpacked extension is loaded
#     exactly as in a developer's real Chrome
#   * --remote-debugging-port=9222 → the dev Chrome becomes a CDP endpoint
#     navigator can drive (add it as a navigator-cdp / cdp BROWSERS entry)
#   * uses a dedicated --user-data-dir so it never touches other profiles
#   * connects the extension to navigator's relay at $NAVIGATOR_URL/relay
#
# The PIN flow is manual in the popup (or use the helper in test/e2e):
#   fetch  http://10.69.1.164:1994/stats  → relay.pending[0].pin
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$SCRIPT_DIR"
PROFILE_DIR="${CHROME_PROFILE:-$SCRIPT_DIR/dev-profile}"
NAVIGATOR_URL="${NAVIGATOR_URL:-http://10.69.1.164:1994}"
CDP_PORT="${CDP_PORT:-9222}"

# This container's own Chromium — deliberately NOT navigator's /app chromium.
CHROME_BIN="${CHROME_BIN:-$(command -v chromium || command -v chromium-browser || true)}"
if [ -z "$CHROME_BIN" ]; then
  echo "Chromium not found. Install it in THIS dev container (separate from navigator):" >&2
  echo "  apt-get install -y chromium xvfb" >&2
  exit 1
fi

if [ ! -f "$EXT_DIR/manifest.json" ]; then
  echo "Extension not found at $EXT_DIR" >&2
  exit 1
fi

mkdir -p "$PROFILE_DIR"

XBIN="$(command -v Xvfb || true)"
if [ -z "$DISPLAY" ] && [ -n "$XBIN" ]; then
  echo ">> No DISPLAY set — launching Chromium headed under Xvfb"
  echo ">> (extension loads/runs exactly as a real Chrome; this is the dev path)"
  RUN=(xvfb-run -a --server-args="-screen 0 1600x1000x24")
else
  RUN=()
fi

echo "Navigator Browser Relay — Chromium dev environment"
echo "  extension       : $EXT_DIR (loaded unpacked, --load-extension)"
echo "  navigator relay : $NAVIGATOR_URL  (ws://…/relay)"
echo "  CDP endpoint    : http://127.0.0.1:$CDP_PORT   (drive via navigator)"
echo "  profile         : $PROFILE_DIR"
echo "  chromium        : $CHROME_BIN"

# Make the default server URL correct for the extension popup.
export NAVIGATOR_URL

"${RUN[@]}" "$CHROME_BIN" \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --load-extension="$EXT_DIR" \
  --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --new-window "about:blank"

echo ""
echo "Next:"
echo "  1) Open the extension popup (puzzle/toolbar icon -> Navigator Browser Relay),"
echo "     set Browser name + server URL  -> Connect."
echo "  2) A PIN is required. Fetch it from navigator (60s expiry):"
echo "       curl -s $NAVIGATOR_URL/stats | python3 -c \"import sys,json;print(json.load(sys.stdin)['relay']['pending'][0]['pin'])\""
echo "     Or read it from the navigator container logs:  docker logs navigator 2>&1 | grep -A2 PIN"
echo "  3) Type the PIN in the popup -> Verify. Status becomes Connected."
echo "  4) navigator side: add this dev Chrome as a relay/CDP add-on, e.g."
echo "     BROWSERS=[{\"name\":\"chromium\",\"role\":[]},{\"name\":\"dev-chrome\",\"role\":[\"default\",\"search\",\"fetch\",\"screenshot\",\"devtools\"],\"cdpUrl\":\"http://127.0.0.1:$CDP_PORT\"}]"

#!/usr/bin/env bash
# Entrypoint for the dev Chromium container.
# Starts a virtual display, then a headed Chromium with the Navigator Browser
# Relay extension loaded, exposing CDP on :9222 (container) and VNC on :5900.
#
# The extension lives at /app/extension (bind-mounted from chrome-extension/).
set -u
export DISPLAY="${DISPLAY:-:99}"
NAVIGATOR_URL="${NAVIGATOR_URL:-http://10.69.1.164:1994}"
BROWSER_NAME="${BROWSER_NAME:-dev-chrome}"
EXT_DIR="${EXT_DIR:-/app/extension}"
CDP_INNER_PORT=9223   # Chromium's own DevTools port (loopback-only)
CDP_PORT=9222         # what we expose to navigator (0.0.0.0)

echo "Navigator Browser Relay — dev Chromium"
echo "  extension       : $EXT_DIR"
echo "  navigator relay : $NAVIGATOR_URL"
echo "  CDP endpoint    : http://0.0.0.0:$CDP_PORT"

# 1. Virtual display
Xvfb "$DISPLAY" -screen 0 1600x1000x24 -nolisten tcp &
XVFB_PID=$!
sleep 1
echo "  Xvfb            : $DISPLAY (pid $XVFB_PID)"

# 2. Optional VNC so the headed Chromium can be SEEN remotely.
if command -v x11vnc >/dev/null 2>&1; then
  x11vnc -display "$DISPLAY" -forever -shared -nopw -q &
  echo "  VNC             : :5900"
fi

# 3. Heated Chromium with the extension loaded.
#    NOTE: modern Chromium (152) forces the CDP HTTP server onto 127.0.0.1 even
#    with --remote-debugging-address=0.0.0.0. So Chromium runs on loopback
#    ($CDP_INNER_PORT) and a tiny TCP forwarder exposes it on 0.0.0.0:$CDP_PORT
#    for navigator (which is on the shared navigator_default network).
/usr/bin/chromium \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --load-extension="$EXT_DIR" \
  --remote-debugging-port="$CDP_INNER_PORT" \
  --user-data-dir=/tmp/chrome-profile \
  --new-window "about:blank" &
CHROME_PID=$!

# Wait for the loopback CDP port, then expose it on 0.0.0.0:$CDP_PORT.
for i in $(seq 1 30); do
  python3 -c "import socket;socket.create_connection(('127.0.0.1',$CDP_INNER_PORT),1)" 2>/dev/null && break
  sleep 1
done

python3 -u - "$CDP_INNER_PORT" "$CDP_PORT" <<'PY' &
import socket, threading, sys
inner, outer = int(sys.argv[1]), int(sys.argv[2])

def pipe(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d: break
            b.sendall(d)
    except Exception:
        pass
    finally:
        try: b.shutdown(socket.SHUT_WR)
        except Exception: pass

def handle(c):
    try:
        u = socket.create_connection(('127.0.0.1', inner))
        threading.Thread(target=pipe, args=(c, u), daemon=True).start()
        pipe(u, c)
    except Exception:
        pass
    finally:
        try: c.close()
        except Exception: pass

s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('0.0.0.0', outer))
s.listen(50)
print(f'cdp-forwarder: 0.0.0.0:{outer} -> 127.0.0.1:{inner}', flush=True)
while True:
    c, _ = s.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
PY
FORWARDER_PID=$!
echo "  chromium pid    : $CHROME_PID"
echo "  cdp-forwarder   : 0.0.0.0:$CDP_PORT -> 127.0.0.1:$CDP_INNER_PORT (pid $FORWARDER_PID)"

wait $CHROME_PID
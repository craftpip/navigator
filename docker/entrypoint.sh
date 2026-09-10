#!/usr/bin/env bash
set -euo pipefail

# .env is the single source of configuration (bind-mounted at /app/.env).
# Compose no longer injects environment variables, so load what the container
# needs before node runs. Values are parsed and exported directly — never
# evaluated — so unquoted parentheses (BROWSER_USER_AGENT) and quoted JSON
# (BROWSERS) are safe.
load_dotenv() {
  local env_file="${1:-/app/.env}"
  local line key value stripped
  [ -f "$env_file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    stripped="${line#"${line%%[![:space:]]*}"}"
    stripped="${stripped#export }"
    if [[ "$stripped" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      case "$value" in *" #"*) value="${value%% \#*}" ;; esac
      value="${value#"${value%%[![:space:]]*}"}"
      value="${value%"${value##*[![:space:]]}"}"
      if [[ "$value" == \"*\" && ${#value} -ge 2 ]]; then
        value="${value:1:${#value}-2}"
        value="${value//\\\"/\"}"
        value="${value//\\\\/\\}"
      elif [[ "$value" == \'*\' && ${#value} -ge 2 ]]; then
        value="${value:1:${#value}-2}"
      fi
      export "$key=$value"
    fi
  done < "$env_file"
}
load_dotenv

if [ "${ENABLE_VNC:-0}" = "1" ]; then
  export DISPLAY="${DISPLAY:-:99}"

  display_num="${DISPLAY#:}"
  lock_file="/tmp/.X${display_num}-lock"
  socket_file="/tmp/.X11-unix/X${display_num}"

  if [ -f "$lock_file" ]; then
    lock_pid="$(cat "$lock_file" 2>/dev/null || true)"
    if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
      echo "Xvfb already running on display $DISPLAY (pid $lock_pid), reusing it"
    else
      rm -f "$lock_file" "$socket_file"
    fi
  fi

  if ! pgrep -f "Xvfb $DISPLAY" >/dev/null 2>&1; then
    Xvfb "$DISPLAY" -screen 0 "${XVFB_WHD:-1920x1080x24}" -ac +extension RANDR &
  fi
  for i in $(seq 1 50); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
  fluxbox >/tmp/fluxbox.log 2>&1 &
  x11vnc -display "$DISPLAY" -rfbport "${VNC_PORT:-1995}" -forever -shared -nopw >/tmp/x11vnc.log 2>&1 &
  websockify --web=/usr/share/novnc/ "${NOVNC_PORT:-1996}" "localhost:${VNC_PORT:-1995}" >/tmp/novnc.log 2>&1 &
fi

# Ensure node_modules matches package.json (handles branch switches, stale volumes)
if [ -f "package.json" ]; then
  npm install --silent --omit=dev --no-audit --no-fund 2>/dev/null
fi

exec "$@"

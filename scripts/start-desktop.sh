#!/usr/bin/env bash
set -euo pipefail

# Render can run the same image without a desktop. Fly explicitly enables it.
if [[ "${INTERACTIVE_LOGIN_ENABLED:-false}" != "true" ]]; then
  exec node server.js
fi

export DISPLAY="${DISPLAY:-:99}"
if [[ ! "$DISPLAY" =~ ^:[0-9]+$ ]]; then
  echo "DISPLAY must name a local virtual display, for example :99" >&2
  exit 1
fi
export XAUTHORITY=/run/x-login-desktop/Xauthority
SERVICE_PATH=/usr/local/bin:/usr/bin:/bin
DATA_DIR="${DATA_DIR:-/var/lib/x-engine}"
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"
install -d -m 750 -o root -g xbrowser /run/x-login-desktop
install -d -m 700 -o xdesktop -g xbrowser /run/x-login-desktop/wm
install -d -m 711 -o root -g root /run/x-login-browser
touch "$XAUTHORITY"
chown root:xbrowser "$XAUTHORITY"
chmod 640 "$XAUTHORITY"
cookie="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
xauth -f "$XAUTHORITY" add "$DISPLAY" . "$cookie"
unset cookie

pids=()
cleanup() {
  trap - EXIT INT TERM
  set +e
  for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null; done
  for ((attempt = 0; attempt < 100; attempt++)); do
    alive=false
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then alive=true; fi
    done
    if [[ "$alive" == false ]]; then break; fi
    sleep 0.1
  done
  for pid in "${pids[@]}"; do kill -KILL "$pid" 2>/dev/null; done
  wait
}
trap cleanup EXIT
trap 'exit 143' INT TERM

env -i PATH="$SERVICE_PATH" Xvfb "$DISPLAY" -screen 0 1366x768x24 -nolisten tcp -auth "$XAUTHORITY" &
pids+=("$!")
display_ready=false
for ((attempt = 0; attempt < 100; attempt++)); do
  if env -i PATH="$SERVICE_PATH" DISPLAY="$DISPLAY" XAUTHORITY="$XAUTHORITY" xdpyinfo >/dev/null 2>&1; then
    display_ready=true
    break
  fi
  kill -0 "${pids[0]}"
  sleep 0.1
done
if [[ "$display_ready" != true ]]; then
  echo "Virtual display did not become ready" >&2
  exit 1
fi

# No terminal launcher, root menu, shell shortcuts, or privileged desktop apps.
runuser -u xdesktop -- env -i PATH="$SERVICE_PATH" HOME=/run/x-login-desktop/wm \
  DISPLAY="$DISPLAY" XAUTHORITY="$XAUTHORITY" \
  openbox --config-file /etc/x-login-desktop/openbox.xml &
pids+=("$!")
env -i PATH="$SERVICE_PATH" DISPLAY="$DISPLAY" XAUTHORITY="$XAUTHORITY" xsetroot -solid '#101722'

# Authentication is enforced by Node before a connection reaches these ports.
# Disable clipboard, file-transfer inputs, X-property remote control and IPv6.
runuser -u xdesktop -- env -i PATH="$SERVICE_PATH" HOME=/run/x-login-desktop/wm \
  DISPLAY="$DISPLAY" XAUTHORITY="$XAUTHORITY" \
  x11vnc -display "$DISPLAY" -auth "$XAUTHORITY" -listen 127.0.0.1 -no6 \
  -rfbport 5900 -forever -shared -nopw -norc -noxdamage -nosel \
  -input KMB -noremote -novncconnect -quiet &
pids+=("$!")

runuser -u xdesktop -- env -i PATH="$SERVICE_PATH" HOME=/run/x-login-desktop/wm \
  websockify --web=/usr/share/novnc --heartbeat=30 127.0.0.1:6080 127.0.0.1:5900 &
pids+=("$!")

for port in 5900 6080; do
  ready=false
  for ((attempt = 0; attempt < 100; attempt++)); do
    if (echo >/dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1; then ready=true; break; fi
    sleep 0.1
  done
  if [[ "$ready" != true ]]; then
    echo "Desktop transport on loopback port $port did not become ready" >&2
    exit 1
  fi
done

node server.js &
pids+=("$!")
echo "[desktop] Xvfb, Openbox, x11vnc and noVNC ready; public access is gated by Node."
# A service failure tears down the entire stack instead of leaving a stale screen.
set +e
wait -n "${pids[@]}"
status=$?
if [[ "$status" == 0 ]]; then status=1; fi
exit "$status"

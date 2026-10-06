#!/usr/bin/env bash
# Container entrypoint: FROST relay + escrow engine, each restarted if it stops.
set -uo pipefail
mkdir -p "$AEGIS_DEALS" "$AEGIS_SHARED_DIR" "$HOME"
export AEGIS_WORK="$AEGIS_SHARED_DIR"

relay_up() { pgrep -x frostd >/dev/null; }
start_relay() {
  [[ -f "$AEGIS_SHARED_DIR/ca.pem" ]] || /app/poc/escrow.sh certs
  rm -f "$AEGIS_SHARED_DIR/frostd.pid"
  /app/poc/escrow.sh relay
}

start_relay
(
  while true; do
    sleep 30
    relay_up || { echo "relay stopped, restarting"; start_relay; }
  done
) &

# The engine is the container's main process; if it exits, the host restarts the container.
exec node /app/apps/engine/server.mjs

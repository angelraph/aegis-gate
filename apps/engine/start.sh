#!/usr/bin/env bash
# Bring Aegis Gate online from this PC and keep it online.
#
#   ./apps/engine/start.sh          start relay, engine, tunnel; point the site; then supervise
#   ./apps/engine/start.sh stop     stop everything
#
# The supervisor checks every 30 seconds. It restarts the relay, engine or tunnel if one
# dies, and redeploys the site's engine pointer whenever the tunnel address changes.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export AEGIS_BIN="${AEGIS_BIN:-$ROOT/tools/bin}"
RUN="$ROOT/poc/.work"
SITE_ALIAS="${AEGIS_SITE_ALIAS:-aegis-gate-zec.vercel.app}"
LOG="$RUN/supervisor.log"
mkdir -p "$RUN"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }
pid_alive() { [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null; }
kill_port() { for p in $(netstat -ano | awk -v port=":$1" '$2 ~ port"$" && $4 == "LISTENING" {print $5}' | sort -u); do taskkill //PID "$p" //F >/dev/null 2>&1 || true; done; }
engine_ok() { curl -s -m 5 http://127.0.0.1:8787/api/health | grep -q '"ok":true'; }
tunnel_url() { grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$RUN/tunnel.log" 2>/dev/null | head -1; }
tunnel_ok() { local u; u="$(tunnel_url)"; [[ -n "$u" ]] && curl -s -m 12 "$u/api/health" | grep -q '"ok":true'; }

start_relay() { "$ROOT/poc/escrow.sh" certs >/dev/null && "$ROOT/poc/escrow.sh" relay >/dev/null && log "relay up"; }

start_engine() {
  kill_port 8787
  (cd "$ROOT" && nohup node apps/engine/server.mjs >> "$RUN/engine.log" 2>&1 </dev/null &)
  for _ in $(seq 1 30); do engine_ok && { log "engine up"; return 0; }; sleep 0.5; done
  log "engine failed to start (see $RUN/engine.log)"; return 1
}

start_tunnel() {
  taskkill //IM cloudflared.exe //F >/dev/null 2>&1 || true
  : > "$RUN/tunnel.log"
  (nohup "$ROOT/tools/cloudflared.exe" tunnel --no-autoupdate --url http://127.0.0.1:8787 >> "$RUN/tunnel.log" 2>&1 </dev/null &)
  for _ in $(seq 1 60); do [[ -n "$(tunnel_url)" ]] && break; sleep 1; done
  for _ in $(seq 1 30); do tunnel_ok && { log "tunnel up at $(tunnel_url)"; return 0; }; sleep 2; done
  log "tunnel failed to come up (see $RUN/tunnel.log)"; return 1
}

point_site() {
  local url="$1" live
  live="$(curl -s -m 10 "https://$SITE_ALIAS/engine.json?ts=$(date +%s)" | grep -oE 'https://[a-z0-9.-]+' | head -1)"
  [[ "$live" == "$url" ]] && return 0
  printf '{ "url": "%s" }\n' "$url" > "$ROOT/apps/web/engine.json"
  local deploy
  local out
  out="$(cd "$ROOT/apps/web" && vercel deploy --prod --yes 2>&1)"
  deploy="$(printf '%s' "$out" | grep -oE 'aegis-gate-[a-z0-9]+-[a-z0-9-]+-projects\.vercel\.app' | tail -1)"
  [[ -n "$deploy" ]] || { log "vercel deploy failed: $(printf '%s' "$out" | tail -3 | tr '
' ' ')"; return 1; }
  (cd "$ROOT/apps/web" && vercel alias set "$deploy" "$SITE_ALIAS" >/dev/null 2>&1) && log "site now points to $url"
}

keep_awake() {
  pid_alive "$RUN/awake.pid" && return 0
  # Holds off sleep only while this process lives; no power settings are changed.
  powershell -NoProfile -WindowStyle Hidden -Command '
    Add-Type -Namespace W -Name P -MemberDefinition "[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);"
    [W.P]::SetThreadExecutionState([uint32]"0x80000001") | Out-Null
    while ($true) { Start-Sleep -Seconds 60 }' </dev/null >/dev/null 2>&1 &
  echo $! > "$RUN/awake.pid"
}

supervise() {
  echo $$ > "$RUN/supervisor.pid"
  log "supervisor watching (every 30s)"
  while true; do
    pid_alive "$RUN/frostd.pid" || start_relay
    engine_ok || { log "engine down, restarting"; start_engine; }
    if ! tunnel_ok; then
      sleep 5
      tunnel_ok || { log "tunnel down, restarting"; start_tunnel; }
    fi
    # Always make sure the site points at the live tunnel; retries a failed redeploy.
    tunnel_ok && point_site "$(tunnel_url)"
    sleep 30
  done
}

if [[ "${1:-}" == "stop" ]]; then
  pid_alive "$RUN/supervisor.pid" && kill "$(cat "$RUN/supervisor.pid")" 2>/dev/null
  kill_port 8787
  taskkill //IM cloudflared.exe //F >/dev/null 2>&1 || true
  pid_alive "$RUN/awake.pid" && kill "$(cat "$RUN/awake.pid")" 2>/dev/null
  "$ROOT/poc/escrow.sh" stop
  log "stopped"
  exit 0
fi

if [[ "${1:-}" == "supervise" ]]; then supervise; exit; fi

# Bring everything up once, then hand off to a detached supervisor.
start_relay
engine_ok || start_engine || exit 1
keep_awake
tunnel_ok || start_tunnel || exit 1
point_site "$(tunnel_url)" || exit 1
pid_alive "$RUN/supervisor.pid" || (nohup "$0" supervise >> "$LOG" 2>&1 </dev/null &)
echo
echo "Aegis Gate is live: https://$SITE_ALIAS"
echo "Engine: $(tunnel_url)   Supervisor log: $LOG"
echo "Arbiter desk: https://$SITE_ALIAS/app.html?admin=<key in poc/.deals/.admin-key>"

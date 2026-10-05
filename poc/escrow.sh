#!/usr/bin/env bash
# Aegis Gate — Week 1 proof of concept: a 2-of-3 FROST escrow on the Ironwood pool.
#
# Three parties (buyer, seller, arbiter) run DKG through a local frostd relay. The group
# key becomes an escrow address that each party recomputes with `aegis escrow`. After
# the buyer funds it, any two parties co-sign a release (or refund) PCZT.
#
# Steps (run in order; each is idempotent where it can be):
#   ./escrow.sh certs                  local CA + TLS cert for frostd (no system changes)
#   ./escrow.sh relay                  start frostd on 127.0.0.1:2744
#   ./escrow.sh parties                create buyer/seller/arbiter FROST identities
#   ./escrow.sh dkg                    2-of-3 DKG -> group key
#   ./escrow.sh escrow                 derive escrow address + UFVK (all three must match)
#   ./escrow.sh wallet                 import UFVK view-only into zcash-devtool, sync
#   ./escrow.sh status                 sync and show the escrow balance
#   ./escrow.sh payout <ua> <zats> <signer1> <signer2> [memo]
#                                      build, prove, FROST-sign and broadcast a spend
#   ./escrow.sh stop                   stop frostd
#
# Binaries are looked up in $AEGIS_BIN, then PATH: frostd, frost-client, zcash-devtool,
# aegis (this repo: `cargo build --release -p aegis-core`).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORK="${AEGIS_WORK:-$HERE/.work}"
WORK="$(cygpath -u "$WORK" 2>/dev/null || echo "$WORK")"   # engine passes Windows paths
SHARED="${AEGIS_SHARED:-$HERE/.work}"   # relay + its TLS cert, shared by all deals
SHARED="$(cygpath -u "$SHARED" 2>/dev/null || echo "$SHARED")"
NETWORK="${AEGIS_NETWORK:-test}"
DEAL="${AEGIS_DEAL:-poc-deal-1}"
RELAY="127.0.0.1:2744"
PARTIES=(buyer seller arbiter)

mkdir -p "$WORK" "$SHARED"
# Trusted by frost-client's rustls-native-certs only. Native path form for Windows builds.
SSL_CERT_FILE="$(cygpath -w "$SHARED/ca.pem" 2>/dev/null || echo "$SHARED/ca.pem")"
export SSL_CERT_FILE

bin() {
  local name="$1"
  for dir in "${AEGIS_BIN:-}" "$ROOT/target/release"; do
    [[ -n "$dir" ]] || continue
    for cand in "$dir/$name" "$dir/$name.exe"; do
      [[ -x "$cand" ]] && { echo "$cand"; return; }
    done
  done
  command -v "$name" || { echo "missing binary: $name (set AEGIS_BIN)" >&2; exit 1; }
}

cfg() { echo "$WORK/$1.toml"; }
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# Read a value out of a frost-client TOML config.
toml() {
  python - "$1" "$2" <<'PY'
import sys, tomllib
cfg = tomllib.load(open(sys.argv[1], "rb"))
q = sys.argv[2]
if q == "pubkey":
    print(cfg["communication_key"]["pubkey"])
elif q == "group":
    groups = list(cfg.get("group", {}))
    if len(groups) != 1:
        sys.exit(f"expected exactly one group, found {len(groups)}")
    print(groups[0])
PY
}

# Git Bash rewrites arguments that look like POSIX paths ("/CN=..." becomes
# "C:/Program Files/Git/CN=..."). Disable that for openssl only: the other tools are
# native Windows binaries that need their path arguments converted.
ossl() { MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' openssl "$@"; }

cmd_certs() {
  [[ -f "$SHARED/ca.pem" && -f "$SHARED/relay.pem" ]] && { echo "certs already exist"; return; }
  say "Generating a throwaway local CA and frostd certificate"
  # With path conversion off, hand openssl native paths ourselves.
  local w; w="$(cygpath -m "$SHARED" 2>/dev/null || echo "$SHARED")"
  ossl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 \
    -subj "/CN=Aegis Gate PoC CA" -keyout "$w/ca.key" -out "$w/ca.pem" 2>/dev/null
  ossl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -subj "/CN=localhost" -keyout "$w/relay.key" -out "$w/relay.csr" 2>/dev/null
  printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' > "$SHARED/san.ext"
  ossl x509 -req -in "$w/relay.csr" -CA "$w/ca.pem" -CAkey "$w/ca.key" \
    -CAcreateserial -days 30 -extfile "$w/san.ext" -out "$w/relay.pem" 2>/dev/null
  ossl verify -CAfile "$w/ca.pem" "$w/relay.pem"
}

cmd_relay() {
  if [[ -f "$SHARED/frostd.pid" ]] && kill -0 "$(cat "$SHARED/frostd.pid")" 2>/dev/null; then
    echo "frostd already running"; return
  fi
  say "Starting frostd on $RELAY"
  "$(bin frostd)" --ip 127.0.0.1 --port 2744 \
    --tls-cert "$SHARED/relay.pem" --tls-key "$SHARED/relay.key" > "$SHARED/frostd.log" 2>&1 &
  echo $! > "$SHARED/frostd.pid"
  sleep 1
  kill -0 "$(cat "$SHARED/frostd.pid")" || { cat "$SHARED/frostd.log"; exit 1; }
}

cmd_stop() {
  [[ -f "$SHARED/frostd.pid" ]] && kill "$(cat "$SHARED/frostd.pid")" 2>/dev/null || true
  rm -f "$SHARED/frostd.pid"
}

cmd_parties() {
  local fc; fc="$(bin frost-client)"
  say "Creating FROST identities"
  for p in "${PARTIES[@]}"; do
    "$fc" init -c "$(cfg "$p")" 2>/dev/null
    "$fc" export -n "$p" -c "$(cfg "$p")" 2>&1 | grep -o 'zffrost1[0-9a-z]*' > "$WORK/$p.contact"
  done
  for p in "${PARTIES[@]}"; do
    for q in "${PARTIES[@]}"; do
      [[ "$p" == "$q" ]] && continue
      "$fc" import -c "$(cfg "$p")" "$(cat "$WORK/$q.contact")" 2>/dev/null || true
    done
  done
  for p in "${PARTIES[@]}"; do echo "$p: $(toml "$(cfg "$p")" pubkey)"; done
}

cmd_dkg() {
  local fc; fc="$(bin frost-client)"
  say "Running 2-of-3 RedPallas DKG through frostd"
  local seller arbiter
  seller="$(toml "$(cfg seller)" pubkey)"
  arbiter="$(toml "$(cfg arbiter)" pubkey)"
  # The buyer opens the session; the others join it.
  "$fc" dkg -c "$(cfg buyer)" -d "Aegis escrow $DEAL" -s "$RELAY" -C redpallas -t 2 \
    -S "$seller,$arbiter" > "$WORK/dkg-buyer.log" 2>&1 &
  local b=$!
  sleep 2
  "$fc" dkg -c "$(cfg seller)" -d "Aegis escrow $DEAL" -s "$RELAY" -C redpallas -t 2 \
    > "$WORK/dkg-seller.log" 2>&1 &
  local s=$!
  "$fc" dkg -c "$(cfg arbiter)" -d "Aegis escrow $DEAL" -s "$RELAY" -C redpallas -t 2 \
    > "$WORK/dkg-arbiter.log" 2>&1 &
  local a=$!
  wait $b $s $a || { tail -n 20 "$WORK"/dkg-*.log; exit 1; }

  local gb gs ga
  gb="$(toml "$(cfg buyer)" group)"; gs="$(toml "$(cfg seller)" group)"; ga="$(toml "$(cfg arbiter)" group)"
  [[ "$gb" == "$gs" && "$gs" == "$ga" ]] || { echo "group keys differ: $gb $gs $ga"; exit 1; }
  echo "$gb" > "$WORK/group.hex"
  echo "group key (ak): $gb"
}

cmd_escrow() {
  local ak; ak="$(cat "$WORK/group.hex")"
  say "Each party derives the escrow independently"
  for p in "${PARTIES[@]}"; do
    "$(bin aegis)" escrow --ak "$ak" --deal "$DEAL" --network "$NETWORK" > "$WORK/escrow-$p.json"
  done
  cmp -s "$WORK/escrow-buyer.json" "$WORK/escrow-seller.json" &&
    cmp -s "$WORK/escrow-seller.json" "$WORK/escrow-arbiter.json" ||
    { echo "escrow derivations disagree"; exit 1; }
  cp "$WORK/escrow-buyer.json" "$WORK/escrow.json"
  cat "$WORK/escrow.json"
}

json() { python -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }

cmd_wallet() {
  local dt; dt="$(bin zcash-devtool)"
  say "Importing the escrow UFVK view-only"
  if [[ ! -d "$WORK/wallet" ]]; then
    # The birthday must precede the funding transaction or the scan will miss it.
    # Default is the chain tip, which is only safe before anyone has paid in.
    "$dt" wallet -w "$WORK/wallet" init-fvk --name "escrow-$DEAL" \
      --fvk "$(json "$WORK/escrow.json" ufvk)" ${AEGIS_BIRTHDAY:+--birthday "$AEGIS_BIRTHDAY"}
  fi
  "$dt" wallet -w "$WORK/wallet" sync
}

cmd_status() {
  local dt; dt="$(bin zcash-devtool)"
  "$dt" wallet -w "$WORK/wallet" sync >/dev/null
  echo "escrow address: $(json "$WORK/escrow.json" address)"
  "$dt" wallet -w "$WORK/wallet" balance
}

cmd_payout() {
  local to="$1" zats="$2" s1="$3" s2="$4" memo="${5:-Aegis Gate escrow $DEAL}"
  local dt fc ak tx="$WORK/payout-$(date +%s)"
  dt="$(bin zcash-devtool)"; fc="$(bin frost-client)"; ak="$(cat "$WORK/group.hex")"
  mkdir -p "$tx"

  say "Building and proving the payout PCZT"
  if [[ "$zats" == "max" ]]; then
    # Sweep the escrow: everything spendable goes to the recipient, fee deducted.
    "$dt" pczt -w "$WORK/wallet" create-max --address "$to" --memo "$memo" \
      --output "$tx/created.pczt"
  else
    "$dt" pczt -w "$WORK/wallet" create --address "$to" --value "$zats" --memo "$memo" \
      --output "$tx/created.pczt"
  fi
  "$dt" pczt -w "$WORK/wallet" prove "$tx/created.pczt" --output "$tx/proven.pczt"
  "$dt" pczt -w "$WORK/wallet" inspect < "$tx/proven.pczt" | tee "$tx/inspect.txt" || true

  say "What the FROST group must sign"
  "$(bin aegis)" inspect "$tx/proven.pczt" | tee "$tx/request.json"
  local n; n="$(python -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["spends"]))' "$tx/request.json")"

  python - "$tx" <<'PY'
import json, sys, pathlib
tx = pathlib.Path(sys.argv[1])
req = json.loads((tx / "request.json").read_text())
(tx / "sighash.bin").write_bytes(bytes.fromhex(req["sighash"]))
for i, s in enumerate(req["spends"]):
    (tx / f"alpha-{i}.bin").write_bytes(bytes.fromhex(s["alpha"]))
PY

  local signers="$(toml "$(cfg "$s1")" pubkey),$(toml "$(cfg "$s2")" pubkey)"
  local sigs=()
  for ((i = 0; i < n; i++)); do
    say "FROST signing spend $i with $s1 + $s2"
    "$fc" coordinator -c "$(cfg "$s1")" -s "$RELAY" -g "$ak" -S "$signers" \
      -m "$tx/sighash.bin" -r "$tx/alpha-$i.bin" -o "$tx/sig-$i.bin" > "$tx/coord-$i.log" 2>&1 &
    local c=$!
    sleep 2
    # Each signer is shown the sighash and must approve it.
    for p in "$s1" "$s2"; do
      echo y | "$fc" participant -c "$(cfg "$p")" -s "$RELAY" -g "$ak" > "$tx/part-$p-$i.log" 2>&1 &
      sigs+=($!)
    done
    wait $c "${sigs[@]}" || { tail -n 20 "$tx"/*.log; exit 1; }
    sigs=()
  done

  python - "$tx" <<'PY'
import json, sys, pathlib
tx = pathlib.Path(sys.argv[1])
req = json.loads((tx / "request.json").read_text())
out = [{"pool": s["pool"], "index": s["index"],
        "signature": (tx / f"sig-{i}.bin").read_bytes().hex()}
       for i, s in enumerate(req["spends"])]
(tx / "signatures.json").write_text(json.dumps(out, indent=2))
PY

  say "Applying FROST signatures (each is verified against its rk)"
  "$(bin aegis)" apply "$tx/proven.pczt" --signatures "$tx/signatures.json" --out "$tx/signed.pczt"

  say "Broadcasting"
  "$dt" pczt -w "$WORK/wallet" send "$tx/signed.pczt" | tee "$tx/send.txt"
}

# Browser-signer flow, step 1: build and prove the payout, and write what the FROST
# group must sign. Signing happens elsewhere (in the signers' browsers).
cmd_prepare() {
  local to="$1" zats="$2" memo="${3:-Aegis Gate escrow $DEAL}"
  local dt tx="$WORK/payout-$(date +%s)"
  dt="$(bin zcash-devtool)"
  mkdir -p "$tx"
  say "Building and proving the payout PCZT"
  if [[ "$zats" == "max" ]]; then
    "$dt" pczt -w "$WORK/wallet" create-max --address "$to" --memo "$memo" --output "$tx/created.pczt"
  else
    "$dt" pczt -w "$WORK/wallet" create --address "$to" --value "$zats" --memo "$memo" --output "$tx/created.pczt"
  fi
  "$dt" pczt -w "$WORK/wallet" prove "$tx/created.pczt" --output "$tx/proven.pczt"
  "$dt" pczt -w "$WORK/wallet" inspect < "$tx/proven.pczt" > "$tx/inspect.txt" 2>&1 || true
  "$(bin aegis)" inspect "$tx/proven.pczt" > "$tx/request.json"
  echo "TXDIR=$tx"
}

# Browser-signer flow, step 2: apply the aggregated FROST signatures (each checked
# against its rk) and broadcast.
cmd_finish() {
  local tx="$1" dt
  dt="$(bin zcash-devtool)"
  [[ -f "$tx/signatures.json" ]] || { echo "missing $tx/signatures.json"; exit 1; }
  say "Applying FROST signatures (each is verified against its rk)"
  "$(bin aegis)" apply "$tx/proven.pczt" --signatures "$tx/signatures.json" --out "$tx/signed.pczt"
  say "Broadcasting"
  "$dt" pczt -w "$WORK/wallet" send "$tx/signed.pczt" | tee "$tx/send.txt"
}

case "${1:-}" in
  certs|relay|stop|parties|dkg|escrow|wallet|status) "cmd_$1" ;;
  payout) shift; [[ $# -ge 4 ]] || { echo "usage: payout <ua> <zats> <signer1> <signer2> [memo]"; exit 2; }; cmd_payout "$@" ;;
  prepare) shift; [[ $# -ge 2 ]] || { echo "usage: prepare <ua> <zats|max> [memo]"; exit 2; }; cmd_prepare "$@" ;;
  finish) shift; [[ $# -ge 1 ]] || { echo "usage: finish <txdir>"; exit 2; }; cmd_finish "$@" ;;
  all) cmd_certs; cmd_relay; cmd_parties; cmd_dkg; cmd_escrow; cmd_wallet; cmd_status ;;
  *) sed -n '2,25p' "$0"; exit 2 ;;
esac

#!/usr/bin/env bash
# GBX Announce — keyless periodic re-announce of NODE/LP/HTLC presence on-chain.
# Endogenous: re-announces when (tip - last) > WINDOW/2 (block-based). Per-entry state.
# Config (local, NOT in repo): announce.json next to this script:
#   { "node":"https://h/api", "lp":"https://h/lp", "wallet":"lp_hot",
#     "htlcs":["base:0x..:from","solana:..","arbitrum:0x..:from"] }
# Any field may be omitted. Zero balance => logs and exits 0 (never crashes the node).
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="${GBX_ANNOUNCE_CFG:-$DIR/announce.json}"
STATE="${GBX_ANNOUNCE_STATE:-$DIR/announce-state.json}"
CLI="${GBX_CLI:-goldbrix-cli}"
DATADIR="${GBX_DATADIR:-}"
WINDOW="${GBX_NODEREG_WINDOW:-200000}"
HALF=$(( WINDOW / 2 ))
log(){ echo "$(date -u +%FT%TZ) gbx-announce: $*"; }
[ -f "$CFG" ] || { log "no config $CFG — nothing to announce"; exit 0; }
cli(){ if [ -n "$DATADIR" ]; then "$CLI" -datadir="$DATADIR" "$@"; else "$CLI" "$@"; fi; }
TIP=$(cli getblockcount 2>/dev/null) || { log "node not reachable — skip"; exit 0; }
[ -n "$TIP" ] || { log "empty tip — skip"; exit 0; }
WALLET=$(python3 -c "import json,sys;print(json.load(open('$CFG')).get('wallet',''))" 2>/dev/null)
[ -f "$STATE" ] || echo '{}' > "$STATE"

have_balance(){
  local bal
  bal=$(cli -rpcwallet="$WALLET" getbalance 2>/dev/null || echo 0)
  python3 -c "import sys;sys.exit(0 if float('$bal')>0 else 1)" 2>/dev/null
}
node_healthy(){
  local info bad
  info=$(cli getblockchaininfo 2>/dev/null) || { echo "node RPC unreachable"; return 1; }
  bad=$(python3 - "$info" <<'PY'
import json,sys
try: d=json.loads(sys.argv[1])
except Exception: print("bad getblockchaininfo"); raise SystemExit
if d.get("pruned"): print("pruned node cannot serve history")
elif d.get("initialblockdownload"): print("still syncing (initial block download)")
elif d.get("blocks") != d.get("headers"): print("behind tip: blocks %s of %s"%(d.get("blocks"),d.get("headers")))
PY
)
  [ -n "$bad" ] && { echo "$bad"; return 1; }
  local api code body r
  api="${GBX_READAPI:-http://127.0.0.1:8088}"
  for r in /api/curves /api/gbx/stats; do
    code=$(curl -s -m 8 -o /tmp/gbx-heal.$$ -w '%{http_code}' "$api$r" 2>/dev/null || echo 000)
    code="${code: -3}"
    body=$(wc -c < /tmp/gbx-heal.$$ 2>/dev/null || echo 0)
    rm -f /tmp/gbx-heal.$$
    [ "$code" = "200" ] || { echo "read-api $r returned $code"; return 1; }
    [ "$body" -gt 2 ] || { echo "read-api $r returned empty body"; return 1; }
  done
  return 0
}

emit(){
  local key="$1" script="$2" arg="$3" label="$4"
  local last
  last=$(python3 -c "import json;print(json.load(open('$STATE')).get('$key',0))" 2>/dev/null || echo 0)
  if [ $(( TIP - last )) -le $HALF ] && [ "$last" -gt 0 ]; then
    log "$label fresh (last=$last tip=$TIP, half=$HALF) — skip"; return 0
  fi
  if ! have_balance; then
    log "$label wallet '$WALLET' zero balance — cannot pay fee, retry next cycle"; return 0
  fi
  log "$label re-announcing $arg (last=$last tip=$TIP)"
  if GBX_CLI="$CLI" GBX_DATADIR="$DATADIR" GBX_WALLET="$WALLET" node "$DIR/$script" "$arg"; then
    python3 - "$STATE" "$key" "$TIP" <<'PY'
import json,sys
f,key,tip=sys.argv[1],sys.argv[2],int(sys.argv[3])
s=json.load(open(f)); s[key]=tip
json.dump(s,open(f,'w'))
PY
    log "$label announced @ $TIP"
  else
    log "$label announce failed — retry next cycle"
  fi
}

NODE_URL=$(python3 -c "import json;print(json.load(open('$CFG')).get('node',''))" 2>/dev/null)
LP_URL=$(python3 -c "import json;print(json.load(open('$CFG')).get('lp',''))" 2>/dev/null)
if [ -n "$NODE_URL" ]; then
  HEAL=$(node_healthy) && emit node announce-node.js "$NODE_URL" node \
    || log "node NOT announced — $HEAL (will announce itself once healthy)"
fi
[ -n "$LP_URL" ]   && emit lp   announce-lp.js   "$LP_URL"   lp
python3 -c "import json;print('\n'.join(json.load(open('$CFG')).get('htlcs',[])))" 2>/dev/null | while IFS= read -r H; do
  [ -n "$H" ] || continue
  emit "htlc:$H" announce-htlc.js "$H" "htlc[$H]"
done
exit 0

#!/usr/bin/env bash
# GBX Announce — keyless periodic re-announce of NODE/LP presence on-chain.
# Endogenous: re-announces when (tip - last_announced_height) > WINDOW/2 (block-based, not time).
# Config (local, NOT in repo): announce.json next to this script:
#   { "node": "https://host/api", "lp": "https://host/lp", "wallet": "lp_hot" }
# Any role may be omitted. Zero balance => logs and exits 0 (never crashes the node).
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

announce_role(){
  local role="$1" url="$2"
  local script="announce-$role.js"
  [ -n "$url" ] || return 0
  local last
  last=$(python3 -c "import json;print(json.load(open('$STATE')).get('$role',0))" 2>/dev/null || echo 0)
  if [ $(( TIP - last )) -le $HALF ] && [ "$last" -gt 0 ]; then
    log "$role fresh (last=$last tip=$TIP, half=$HALF) — skip"; return 0
  fi
  local bal
  bal=$(cli -rpcwallet="$WALLET" getbalance 2>/dev/null || echo 0)
  if python3 -c "import sys;sys.exit(0 if float('$bal')>0 else 1)" 2>/dev/null; then :; else
    log "$role wallet '$WALLET' balance $bal — cannot pay fee, will retry next cycle"; return 0
  fi
  log "$role re-announcing $url (last=$last tip=$TIP)"
  if GBX_CLI="$CLI" GBX_DATADIR="$DATADIR" GBX_WALLET="$WALLET" node "$DIR/$script" "$url"; then
    python3 - "$STATE" "$role" "$TIP" <<'PY'
import json,sys
f,role,tip=sys.argv[1],sys.argv[2],int(sys.argv[3])
s=json.load(open(f)); s[role]=tip
json.dump(s,open(f,'w'))
PY
    log "$role announced @ $TIP"
  else
    log "$role announce failed — will retry next cycle"
  fi
}

NODE_URL=$(python3 -c "import json;print(json.load(open('$CFG')).get('node',''))" 2>/dev/null)
LP_URL=$(python3 -c "import json;print(json.load(open('$CFG')).get('lp',''))" 2>/dev/null)
announce_role node "$NODE_URL"
announce_role lp   "$LP_URL"
exit 0

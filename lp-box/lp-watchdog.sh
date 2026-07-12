#!/bin/bash
# GoldBrix LP watchdog — application-level health, complements Restart=always.
# Catches "alive but stuck": process up, but quote dead or heartbeat stale.
# Local-only (localhost + own log). No external calls. Targeted restarts.
D="${GBX_LP_DIR:-/opt/gbx-lp}"
PORT="${GBX_LP_PORT:-18099}"
ST="$D/state/watchdog_state"
LOG="$D/state/lp_watchdog.log"
mkdir -p "$D/state"
log(){ echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
fails(){ grep -c . "$ST.$1" 2>/dev/null || echo 0; }
mark(){ echo x >> "$ST.$1"; }
clear_m(){ rm -f "$ST.$1"; }

# 1) gateway health: /height answers with a number
H=$(curl -s -m 10 "http://127.0.0.1:$PORT/height" | python3 -c "import json,sys;print(json.load(sys.stdin)['height'])" 2>/dev/null)
if [ -z "$H" ]; then mark gw; log "gateway /height FAIL ($(fails gw)/2)"; else clear_m gw; fi

# 2) quote health: /quote returns valid JSON with price_usd
Q=$(curl -s -m 10 "http://127.0.0.1:$PORT/quote?usdc=1" | python3 -c "import json,sys;print(json.load(sys.stdin)['price_usd'])" 2>/dev/null)
if [ -z "$Q" ]; then mark quote; log "quote FAIL ($(fails quote)/2)"; else clear_m quote; fi

# 3) daemon heartbeat: [hb] line newer than 2h in daemon log
DLOG=$(ls -t "$D"/state/lp_daemon*.log 2>/dev/null | head -1)
HB_OK=0
if [ -n "$DLOG" ]; then
  # find last [hb]; if file modified within 2h AND contains hb, accept.
  if [ -n "$(find "$DLOG" -mmin -120 2>/dev/null)" ] && grep -q "\[hb\]" "$DLOG"; then HB_OK=1; fi
fi
if [ "$HB_OK" = "0" ]; then mark hb; log "daemon heartbeat STALE ($(fails hb)/2)"; else clear_m hb; fi

# targeted restarts after 2 consecutive fails
if [ "$(fails gw)" -ge 2 ] || [ "$(fails quote)" -ge 2 ]; then
  log "RESTART gbx-lp-gateway (gw=$(fails gw) quote=$(fails quote))"
  systemctl restart gbx-lp-gateway; clear_m gw; clear_m quote
fi
if [ "$(fails hb)" -ge 2 ]; then
  log "RESTART gbx-lp-daemon (heartbeat stale x2)"
  systemctl restart gbx-lp-daemon; clear_m hb
fi

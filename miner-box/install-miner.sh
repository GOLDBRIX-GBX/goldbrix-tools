#!/usr/bin/env bash
# install-miner.sh - GoldBrix miner-box: wallet + payout address + automatic UTXO consolidation.
# Usage:  ./install-miner.sh new       (generate wallet on this node)
#         ./install-miner.sh import    (import an existing 12/24-word phrase, e.g. from the GoldBrix app)
set -euo pipefail
MODE="${1:?usage: install-miner.sh new|import}"
CLI="${GBX_CLI:-goldbrix-cli}"
DATADIR="${GBX_DATADIR:-/root/.bitcoin}"
WALLET="${GBX_WALLET:-miner_wallet}"
BOX="$(cd "$(dirname "$0")" && pwd)"
C(){ "$CLI" -datadir="$DATADIR" -rpcwallet="$WALLET" "$@"; }
CN(){ "$CLI" -datadir="$DATADIR" "$@"; }
echo "[1/5] pre-flight"
for b in "$CLI" jq python3 systemctl; do command -v "$b" >/dev/null || { echo "[FATAL] missing: $b"; exit 1; }; done
CN getblockcount >/dev/null || { echo "[FATAL] node not reachable at $DATADIR"; exit 1; }
CONF="$DATADIR/goldbrix.conf"
grep -q "^fallbackfee=" "$CONF" 2>/dev/null || echo "[WARN] no fallbackfee in $CONF (consolidation uses explicit fees, OK; sendtoaddress will need it)"
echo "[2/5] wallet"
CN listwallets | jq -e --arg w "$WALLET" 'index($w)' >/dev/null 2>&1 || CN createwallet "$WALLET" >/dev/null
if [ "$MODE" = "new" ]; then
  ADDR=$(C getnewaddress mining bech32)
  echo "[NEW] payout address: $ADDR"
  echo "[NEW] BACK UP NOW: $CLI -datadir=$DATADIR -rpcwallet=$WALLET backupwallet /path/off-this-machine"
elif [ "$MODE" = "import" ]; then
  read -rsp "12/24-word phrase: " PH; echo
  ADDR=$(PH="$PH" python3 "$BOX/derive-import.py")
  unset PH
  echo "[IMPORT] derived address (m/84'/0'/0'/0/0): $ADDR"
  read -rp "Does it match your app? [y/N] " OK
  [ "$OK" = "y" ] || { echo "[ABORT] phrase mismatch - run again"; exit 1; }
  [ "$(C getaddressinfo "$ADDR" | jq -r .ismine)" = "true" ] || { echo "[FATAL] import failed (not ismine)"; exit 1; }
  read -rp "Rescan chain for past payouts? [y/N] " RS
  [ "$RS" = "y" ] && C rescanblockchain 2200000 >/dev/null
else
  echo "[FATAL] mode must be new|import"; exit 1
fi
echo "[3/5] consolidation service + timer"
install -m755 "$BOX/gbx-consolidate.sh" /usr/local/bin/gbx-consolidate.sh
cat > /etc/systemd/system/gbx-consolidate.service << EOF
[Unit]
Description=GoldBrix UTXO consolidation (miner wallet, non-custodial)
After=goldbrixd.service
[Service]
Type=oneshot
Environment=GBX_DEST=$ADDR
Environment=GBX_DATADIR=$DATADIR
Environment=GBX_WALLET=$WALLET
ExecStart=/usr/local/bin/gbx-consolidate.sh
EOF
cat > /etc/systemd/system/gbx-consolidate.timer << 'EOF'
[Unit]
Description=Daily GoldBrix UTXO consolidation
[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload && systemctl enable --now gbx-consolidate.timer
echo "[4/5] miner unit (optional)"
if [ -n "${GBX_CPUMINER:-}" ]; then
  POOL="${GBX_POOL:-stratum+tcp://goldbrix.app:3333}"
  WK="${GBX_WORKER:-w1}"
  cat > /etc/systemd/system/gbx-miner.service << EOF
[Unit]
Description=GoldBrix miner (payout direct to your address)
After=network-online.target
[Service]
ExecStart=$GBX_CPUMINER -a sha256d -o $POOL -u $ADDR.$WK -p x
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload && systemctl enable --now gbx-miner
  echo "[MINER] running -> $ADDR.$WK @ $POOL"
else
  echo "[SKIP] set GBX_CPUMINER=/path/to/minerd to also install the miner unit"
fi
echo "[5/5] self-test"
systemctl start gbx-consolidate.service && systemctl is-active gbx-consolidate.timer
echo "[DONE] payout: $ADDR | consolidation: daily, threshold ${GBX_THRESHOLD:-200} UTXOs"

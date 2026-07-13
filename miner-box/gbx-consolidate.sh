#!/usr/bin/env bash
# gbx-consolidate.sh - consolidate mature coinbase UTXOs into one output.
# Non-custodial: runs on the miner's own node, signs with the miner's own wallet.
set -euo pipefail
CLI="${GBX_CLI:-goldbrix-cli}"
DATADIR="${GBX_DATADIR:-/root/.bitcoin}"
WALLET="${GBX_WALLET:-miner_wallet}"
DEST="${GBX_DEST:?set GBX_DEST to your payout address}"
MAX_IN="${GBX_MAX_INPUTS:-500}"
MINCONF="${GBX_MINCONF:-100}"
THRESH="${GBX_THRESHOLD:-200}"
MAXTX="${GBX_MAX_TX_PER_RUN:-30}"
FEERATE="${GBX_FEERATE_SATVB:-1}"
C(){ "$CLI" -datadir="$DATADIR" -rpcwallet="$WALLET" "$@"; }
[ "$(C getaddressinfo "$DEST" | jq -r .ismine)" = "true" ] || { echo "[FATAL] DEST is not ismine in wallet $WALLET"; exit 1; }
for ((t=1;t<=MAXTX;t++)); do
  U=$(C listunspent "$MINCONF" 9999999 | jq '[ .[] | select(.spendable==true) ]')
  N=$(echo "$U" | jq 'length')
  if [ "$N" -le "$THRESH" ]; then echo "[OK] $N utxo <= threshold $THRESH - nothing to do"; exit 0; fi
  TAKE=$(( N < MAX_IN ? N : MAX_IN ))
  SEL=$(echo "$U" | jq ".[0:$TAKE]")
  INS=$(echo "$SEL" | jq -c '[.[] | {txid,vout}]')
  SUM_SAT=$(echo "$SEL" | jq '[.[].amount*100000000 | round] | add')
  VB=$(( TAKE*68 + 43 ))
  FEE_SAT=$(( VB*FEERATE ))
  OUT=$(python3 -c "print('%.8f'%(($SUM_SAT-$FEE_SAT)/1e8))")
  RAW=$(C createrawtransaction "$INS" "{\"$DEST\":$OUT}")
  SIG=$(C -stdin signrawtransactionwithwallet <<< "$RAW")
  [ "$(echo "$SIG"|jq -r .complete)" = "true" ] || { echo "[FATAL] incomplete signature"; echo "$SIG"|jq .errors; exit 1; }
  TXID=$("$CLI" -datadir="$DATADIR" -stdin sendrawtransaction <<< "$(echo "$SIG"|jq -r .hex)")
  echo "[TX $t] inputs=$TAKE sum_sat=$SUM_SAT fee_sat=$FEE_SAT txid=$TXID"
  sleep 2
done
echo "[INFO] per-run limit $MAXTX reached; run again for the rest"

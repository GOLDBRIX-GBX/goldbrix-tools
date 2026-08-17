#!/usr/bin/env bash
# gbx-consolidate.sh — merge mature UTXOs into one output.
#
# Mining pays one small output per block. A wallet that has mined for a while
# holds its balance in hundreds of thousands of pieces, and no single
# transaction can carry enough of them to move a large amount. This merges
# them, in batches, using only the owner's own key through the local wallet.
#
# Non-custodial: the coins never leave the wallet that signs. DEST must be an
# address of that same wallet; the script refuses otherwise.
#
#   GBX_DEST=<your own address> ./gbx-consolidate.sh
#
# Env: GBX_CLI GBX_DATADIR GBX_WALLET GBX_DEST GBX_MAX_INPUTS GBX_MINCONF
#      GBX_THRESHOLD GBX_MAX_TX_PER_RUN GBX_FEERATE_SATVB
set -euo pipefail
CLI="${GBX_CLI:-goldbrix-cli}"
DATADIR="${GBX_DATADIR:-/root/.bitcoin}"
WALLET="${GBX_WALLET:-miner_wallet}"
DEST="${GBX_DEST:?set GBX_DEST to an address of this wallet}"
MAX_IN="${GBX_MAX_INPUTS:-500}"
MINCONF="${GBX_MINCONF:-100}"
THRESH="${GBX_THRESHOLD:-200}"
MAXTX="${GBX_MAX_TX_PER_RUN:-5}"
FEERATE="${GBX_FEERATE_SATVB:-1}"
C(){ "$CLI" -datadir="$DATADIR" -rpcwallet="$WALLET" "$@"; }
# Sending to an address this wallet does not own would be a transfer, not a
# merge. Refuse before anything is signed.
[ "$(C getaddressinfo "$DEST" | jq -r .ismine)" = "true" ] || { echo "[FATAL] DEST is not ismine in $WALLET"; exit 1; }
for ((t=1;t<=MAXTX;t++)); do
  U=$(C listunspent "$MINCONF" 9999999 | jq '[ .[] | select(.spendable==true) ]')
  N=$(echo "$U" | jq 'length')
  if [ "$N" -le "$THRESH" ]; then echo "[OK] $N utxo <= threshold $THRESH — nothing to do"; exit 0; fi
  TAKE=$(( N < MAX_IN ? N : MAX_IN ))
  SEL=$(echo "$U" | jq ".[0:$TAKE]")
  INS=$(echo "$SEL" | jq -c '[.[] | {txid,vout}]')
  SUM_SAT=$(echo "$SEL" | jq '[.[].amount*100000000 | round] | add')
  VB=$(( TAKE*68 + 43 ))
  FEE_SAT=$(( VB*FEERATE ))
  OUT=$(python3 -c "print('%.8f'%(($SUM_SAT-$FEE_SAT)/1e8))")
  RAW=$(C createrawtransaction "$INS" "{\"$DEST\":$OUT}")
  SIG=$(C -stdin signrawtransactionwithwallet <<< "$RAW")
  [ "$(echo "$SIG"|jq -r .complete)" = "true" ] || { echo "[FATAL] incomplete signing"; echo "$SIG"|jq .errors; exit 1; }
  TXID=$(C -stdin sendrawtransaction <<< "$(echo "$SIG"|jq -r .hex)")
  echo "[TX $t] inputs=$TAKE sum_sat=$SUM_SAT fee_sat=$FEE_SAT txid=$TXID"
  sleep 2
done
echo "[INFO] reached $MAXTX tx per run; run again for the rest"

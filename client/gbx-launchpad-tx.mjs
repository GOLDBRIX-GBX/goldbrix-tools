// GOLDBRIX — launchpad transactions, built and signed ON DEVICE.
// Uses the same vendor stack as the wallet (bitcoinjs + secp256k1 from /vendor).
// The server is never in the path: this module builds the exact bytes the
// consensus accepts, verifies them against the indexer's own parser, and hands
// the raw tx to the existing broadcast fallback.
import * as C from '/gbx-curve.mjs';
import { setWitness } from '/gbx-wtx.mjs';

const V = '/vendor/';
let _bjs, _secp, _Buf;
async function lib(){
  if(!_bjs){
    _bjs = (await import(V+'bitcoinjs-lib.mjs')).default;
    _secp = (await import(V+'secp256k1.mjs')).default;
    const b = await import(V+'buffer.bundle.mjs');
    _Buf = b.Buffer || b.default?.Buffer || b.default;
  }
  return { bjs:_bjs, secp:_secp, Buf:_Buf };
}

// Sign a token UTXO (BIP143). scriptCode = the canonical token witness script.
export async function signTokenInput(txHex, inputIndex, tokenWsHex, amountSat, privkey){
  const { bjs, secp, Buf } = await lib();
  const tx = bjs.Transaction.fromHex(txHex);
  const hash = tx.hashForWitnessV0(inputIndex, Buf.from(tokenWsHex,'hex'),
                                   Number(amountSat), bjs.Transaction.SIGHASH_ALL);
  const sig = secp.sign(new Uint8Array(hash), privkey);
  const der = bjs.script.signature.encode(Buf.from(sig), bjs.Transaction.SIGHASH_ALL);
  return Buf.from(der).toString('hex');
}

// MANDATORY guard: re-parse our own transaction exactly like the indexer does.
// A client must never broadcast a launchpad tx that fails this — a malformed
// intent means the node sees an ordinary spend and the curve reserve is orphaned.
export function verifyOwnTx(decodedVout, expect){
  const or = decodedVout.find(o => o.scriptPubKey.hex.startsWith('6a'));
  if(!or) return 'no OP_RETURN';
  const back = C.parseIntentFromScriptHex(or.scriptPubKey.hex);
  if(!back) return 'intent not parseable';
  if(back.op !== expect.op) return 'op mismatch';
  if(back.cid !== expect.cid) return 'coin_id mismatch';
  if(back.amount !== expect.amount) return 'amount mismatch';
  if(back.tokensOut !== expect.tokensOut) return 'tokens_out mismatch';
  if(back.pk !== expect.pk) return 'pubkey mismatch';
  return null;   // null = OK
}
export { setWitness };

// MANDATORY guard: re-derive the (M, h_M) transition with the indexer's
// own arithmetic before broadcast. State is READ FROM CHAIN (the spent UTXO's
// revealed witness script), never from client variables. Null = OK.
export function verifyOwnCurveState(spentWsBytes, cidHex, trade, spendHeight, gradWindow, outMs){
  const st = C.parseCurveWitnessScript(spentWsBytes, cidHex);
  if(!st) return 'spent curve witness not parseable';
  const nx = C.nextMarketMemory(st.m, st.hM, trade, spendHeight, gradWindow, outMs.hM);
  if(nx.m !== BigInt(outMs.m)) return 'M transition mismatch (client would be the accidental liar)';
  if(nx.updated){
    if(outMs.hM > spendHeight) return 'h_M stamp in the future';
    if(spendHeight - outMs.hM > C.HM_MAX_AGE) return 'h_M stamp stale';
  } else if(Number(outMs.hM)!==st.hM) return 'h_M must be carried unchanged on a non-record trade';
  return null; }

// MANDATORY guard for CREATE: never broadcast a proof the consensus
// would reject. Re-checks the client's own 80 bytes exactly like CheckCreatePoW.
export { verifyPow as verifyOwnPow, minePow, CREATE_POW_LEN } from '/gbx-pow.mjs';

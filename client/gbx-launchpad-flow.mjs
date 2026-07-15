// GOLDBRIX — launchpad on-device flow (rule X, W+X LOCKED).
// Builds a CREATE (the birth of a curve) and its GBX:M metadata tx entirely on
// the device, with the user's own key. No custodial API, no server-side state.
// The 80-byte proof of work is mined by gbx-pow-worker.mjs and passed in here.
// Nothing is broadcast unless every self-verify passes:
//   verifyOwnPow  — the proof really clears the target and carries our coin id
//   verifyOwnTx   — our own intent parses back exactly like the indexer will
//   curve script  — the declared (M, h_M) script round-trips byte-identically
import { curveFee, curveBuy, curveWitnessScript, parseCurveWitnessScript,
         tokenWitnessScript, intentPayload, parseIntentFromScriptHex,
         metaPayload, parseMetaFromScriptHex, burnScript, p2wsh, hex, unhex }
  from './gbx-curve.mjs';
import { verifyPow, POWLIMIT_MAIN } from './gbx-pow.mjs';
import { coinIdFromOutpoint } from './gbx-curve.mjs';

export const DUST_SAT = 546n;
export const CREATE_FEE_SAT = 50000n;   // flat, generous network fee for the create tx
export const META_FEE_SAT   = 20000n;   // flat network fee for the metadata tx

// Honest local preview — pure math, zero server. Amounts in satoshi (BigInt).
export function previewCreate(devBuySat){
  const gross = BigInt(devBuySat);
  if (gross < 1n) throw new Error('dev buy must be at least 1');
  const fee = curveFee(gross);
  const rc = curveBuy(0n, gross - fee);
  return { gross, burnFee: fee, liquidity: rc.newReserve, tokensOut: rc.tokensOut };
}

function selectUtxos(utxos, needSat){
  const ins = []; let sum = 0n;
  for (const u of utxos){
    ins.push(u); sum += BigInt(u.value8);
    if (sum >= needSat) return { ins, sum };
  }
  throw new Error('NO_UTXO');
}

function opReturn(raw){
  if (raw.length <= 75) { const o = new Uint8Array(2 + raw.length); o[0]=0x6a; o[1]=raw.length; o.set(raw,2); return o; }
  if (raw.length <= 255){ const o = new Uint8Array(3 + raw.length); o[0]=0x6a; o[1]=0x4c; o[2]=raw.length; o.set(raw,3); return o; }
  throw new Error('op_return payload too large');
}

// Step 1: choose funding inputs; the coin id is born from the FIRST outpoint.
export async function planCreate({ utxos, devBuySat }){
  const p = previewCreate(devBuySat);
  const need = p.gross + DUST_SAT + CREATE_FEE_SAT;
  const { ins, sum } = selectUtxos(utxos, need);
  const cidHex = hex(new Uint8Array(await coinIdFromOutpoint(ins[0].txid, ins[0].vout)));
  return { ...p, ins, sum, cidHex };
}

// Step 2: with the mined pow80 and the live tip, build and self-verify the tx.
export async function buildCreateTx({ plan, pkU, tipHeight, pow80Hex, nBits,
                                      powLimit = POWLIMIT_MAIN,
                                      buildFundTx, sign, p2wpkhSpkOf }){
  const cid = unhex(plan.cidHex);
  const pow80 = unhex(pow80Hex);
  const powErr = verifyPow(pow80, cid, nBits, powLimit);
  if (powErr !== null) throw new Error('verifyOwnPow: ' + powErr);

  const hM = tipHeight + 1;                          // declared stamp: next block
  const curveWs = curveWitnessScript(cid, plan.liquidity, hM);
  const st = parseCurveWitnessScript(curveWs, plan.cidHex);
  if (st === null || st.m !== plan.liquidity || st.hM !== hM)
    throw new Error('verifyOwnCurveScript: round-trip failed');

  const tokenWs = tokenWitnessScript(cid, plan.tokensOut, pkU);
  const it = intentPayload('C', cid, plan.gross, plan.tokensOut, pkU);
  const raw = new Uint8Array(it.raw.length + 80);
  raw.set(it.raw, 0); raw.set(pow80, it.raw.length);
  const spkIntent = opReturn(raw);

  const back = parseIntentFromScriptHex(hex(spkIntent));
  if (back === null || back.op !== 'C' || back.cid !== plan.cidHex
      || back.amount !== plan.gross || back.tokensOut !== plan.tokensOut)
    throw new Error('verifyOwnTx: intent round-trip failed');

  const change = plan.sum - plan.gross - DUST_SAT - CREATE_FEE_SAT;
  const outputs = [];
  if (change > DUST_SAT) outputs.push({ spk: p2wpkhSpkOf(pkU), value8: Number(change) });
  outputs.push({ spk: await p2wsh(curveWs), value8: Number(plan.liquidity) });
  outputs.push({ spk: await p2wsh(tokenWs), value8: Number(DUST_SAT) });
  outputs.push({ spk: burnScript(),         value8: Number(plan.burnFee) });
  outputs.push({ spk: spkIntent,            value8: 0 });

  const txBytes = buildFundTx({ utxos: plan.ins, userPubkey: pkU, outputs, nLockTime: 0 }, sign);
  return { txHex: hex(txBytes), hM, curveWsHex: hex(curveWs) };
}

// Step 3: the GBX:M metadata tx — signed by the SAME key. The chain remembers
// the name for as long as it exists; the first tx on chain wins the ticker.
export function buildMetaTx({ cidHex, ticker, name, utxos, pkU,
                              buildFundTx, sign, p2wpkhSpkOf }){
  const m = metaPayload(unhex(cidHex), ticker, name);
  const spkMeta = opReturn(m.raw);
  const back = parseMetaFromScriptHex(hex(spkMeta));
  if (back === null || back.cid !== cidHex || back.ticker !== ticker || back.name !== name)
    throw new Error('verifyOwnMeta: round-trip failed');
  const { ins, sum } = selectUtxos(utxos, META_FEE_SAT + DUST_SAT);
  const change = sum - META_FEE_SAT;
  const outputs = [
    { spk: p2wpkhSpkOf(pkU), value8: Number(change) },
    { spk: spkMeta,          value8: 0 },
  ];
  const txBytes = buildFundTx({ utxos: ins, userPubkey: pkU, outputs, nLockTime: 0 }, sign);
  return { txHex: hex(txBytes) };
}

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

// ── on-device BUY / SELL / REFUND (mirror of consensus + x_lib proven layouts) ──
import { quoteBuy, quoteSell, curveSell, parseCurveWitnessScript as _pcws,
         curveWitnessScript as _cws } from './gbx-curve.mjs';

export const TRADE_FEE_SAT = 50000n; // flat network fee, paid from user funds

// Consensus M-transition (mirror): REFUND never touches (M,h_M).
export function nextM(state, tradeSat, spendHeight, K = 201600){
  const expired = state.hM !== 0 && (spendHeight - state.hM) > K;
  const up = expired || tradeSat > state.m;
  return { m: up ? tradeSat : state.m, hM: up ? spendHeight : state.hM };
}

// BUY: inputs [curve, user funds...] -> [change?, curve', token(tokensOut,pk), burn(fee), intent B]
export async function buildBuyTx({ curve, gbxInSat, utxos, pkU, K,
                                   buildFundLikeTx, signP2wpkh, setCurveWitness, p2wpkhSpkOf }){
  const q = quoteBuy(curve.reserve, gbxInSat);
  if (q.ok === false) throw new Error('quote: ' + q.reason);
  const spendH = curve.tipHeight + 1;
  const t = nextM({ m: BigInt(curve.m), hM: curve.hM }, q.netSat, spendH, K);
  const oldWs = _cws(curve.cid, BigInt(curve.m), curve.hM);
  const newWs = _cws(curve.cid, t.m, t.hM);
  const st = _pcws(newWs, curve.cidHex);
  if (st === null) throw new Error('verifyOwnCurveScript failed');
  const tokenWs = tokenWitnessScript(curve.cid, q.tokensOut, pkU);
  const it = intentPayload('B', curve.cid, BigInt(gbxInSat), q.tokensOut, pkU);
  const need = BigInt(gbxInSat) + DUST_SAT + TRADE_FEE_SAT;
  const { ins, sum } = selectUtxos(utxos, need);
  const change = sum - need;
  const outs = [];
  if (change > DUST_SAT) outs.push({ spk: p2wpkhSpkOf(pkU), value8: Number(change) });
  outs.push({ spk: await p2wsh(newWs),  value8: Number(q.newReserve) });
  outs.push({ spk: await p2wsh(tokenWs), value8: Number(DUST_SAT) });
  outs.push({ spk: burnScript(),         value8: Number(q.feeSat) });
  outs.push({ spk: opReturn(it.raw),     value8: 0 });
  return { quote: q, next: t, oldWsHex: hex(oldWs),
           inputsCurveFirst: [{txid: curve.txid, vout: curve.vout, value8: Number(curve.reserve)}, ...ins],
           outs };
}

// SELL: inputs [curve, token, user fee funds] ->
//       [curve'(reserve-gross), user net(gross-fee), token change?, burn(fee), intent S]
export async function buildSellTx({ curve, holding, tokensInSat, utxos, pkU, K,
                                    p2wpkhSpkOf }){
  const q = quoteSell(curve.reserve, tokensInSat);
  if (q.ok === false) throw new Error('quote: ' + q.reason);
  const spendH = curve.tipHeight + 1;
  const t = nextM({ m: BigInt(curve.m), hM: curve.hM }, q.gbxOut, spendH, K);
  const newWs = _cws(curve.cid, t.m, t.hM);
  const it = intentPayload('S', curve.cid, q.gbxOut, BigInt(tokensInSat), pkU);
  const tokenRest = BigInt(holding.amount) - BigInt(tokensInSat);
  if (tokenRest < 0n) throw new Error('not enough tokens');
  const { ins, sum } = selectUtxos(utxos, TRADE_FEE_SAT);
  const change = sum - TRADE_FEE_SAT;
  const outs = [];
  if (change > DUST_SAT) outs.push({ spk: p2wpkhSpkOf(pkU), value8: Number(change) });
  outs.push({ spk: await p2wsh(newWs), value8: Number(q.newReserve) });
  outs.push({ spk: p2wpkhSpkOf(pkU),   value8: Number(q.netOut) });
  if (tokenRest > 0n)
    outs.push({ spk: await p2wsh(tokenWitnessScript(curve.cid, tokenRest, pkU)), value8: Number(DUST_SAT) });
  outs.push({ spk: burnScript(),     value8: Number(q.feeSat) });
  outs.push({ spk: opReturn(it.raw), value8: 0 });
  return { quote: q, next: t,
           oldWsHex: hex(_cws(curve.cid, BigInt(curve.m), curve.hM)),
           tokenWsHex: hex(tokenWitnessScript(curve.cid, BigInt(holding.amount), pkU)),
           inputs: [{txid: curve.txid, vout: curve.vout, value8: Number(curve.reserve)},
                    {txid: holding.txid, vout: holding.vout, value8: Number(DUST_SAT)}, ...ins],
           outs };
}

// REFUND: THE LAW — the user's own money comes home, NO fee burned, (M,h_M) untouched.
export async function buildRefundTx({ curve, holding, utxos, pkU, p2wpkhSpkOf }){
  const rc = curveSell(curve.reserve, BigInt(holding.amount));
  if (rc === null) throw new Error('refund math failed');
  const sameWs = _cws(curve.cid, BigInt(curve.m), curve.hM); // UNCHANGED
  const it = intentPayload('R', curve.cid, rc.gbxOut, BigInt(holding.amount), pkU);
  const { ins, sum } = selectUtxos(utxos, TRADE_FEE_SAT);
  const change = sum - TRADE_FEE_SAT;
  const outs = [];
  if (change > DUST_SAT) outs.push({ spk: p2wpkhSpkOf(pkU), value8: Number(change) });
  outs.push({ spk: await p2wsh(sameWs), value8: Number(rc.newReserve) });
  outs.push({ spk: p2wpkhSpkOf(pkU),    value8: Number(rc.gbxOut) }); // full, no fee
  outs.push({ spk: opReturn(it.raw),    value8: 0 });
  return { gbxOut: rc.gbxOut,
           oldWsHex: hex(sameWs),
           tokenWsHex: hex(tokenWitnessScript(curve.cid, BigInt(holding.amount), pkU)),
           inputs: [{txid: curve.txid, vout: curve.vout, value8: Number(curve.reserve)},
                    {txid: holding.txid, vout: holding.vout, value8: Number(DUST_SAT)}, ...ins],
           outs };
}

// ── mixed-input tx builder (BIP143): curve (anyone-can-spend) + token P2WSH + user P2WPKH ──
import { dsha256, u32le, u64le, varint, serStr, concatBytes, hash160 } from './gbx-htlc.mjs';
import { unhex as _uh } from './gbx-curve.mjs';
// inputs: [{txid, vout, value8, kind:'curve'|'token'|'p2wpkh', ws?:Uint8Array}]
// outs:   [{spk, value8}] ; signDigest: 32B digest -> DER sig (no hashtype byte)
export function buildCurveTx(inputs, outs, pkU, signDigest, nLockTime = 0){
  const nSeq = 0xffffffff;
  const prevouts = dsha256(concatBytes(inputs.map(u=>concatBytes([_uh(u.txid).reverse(), u32le(u.vout)]))));
  const seqs  = dsha256(concatBytes(inputs.map(()=>u32le(nSeq))));
  const houts = dsha256(concatBytes(outs.map(o=>concatBytes([u64le(o.value8), serStr(o.spk)]))));
  const wit = [];
  for (const u of inputs){
    if (u.kind === 'curve'){ wit.push([u.ws]); continue; }           // witness = [script]
    let scriptCode;
    if (u.kind === 'token') scriptCode = serStr(u.ws);               // the token witness script
    else scriptCode = concatBytes([Uint8Array.of(0x19,0x76,0xa9,0x14), hash160(pkU), Uint8Array.of(0x88,0xac)]);
    const outpoint = concatBytes([_uh(u.txid).reverse(), u32le(u.vout)]);
    const pre = concatBytes([u32le(1), prevouts, seqs, outpoint, scriptCode,
                             u64le(u.value8), u32le(nSeq), houts, u32le(nLockTime), u32le(1)]);
    const sig = concatBytes([signDigest(dsha256(pre)), Uint8Array.of(0x01)]);
    wit.push(u.kind === 'token' ? [sig, u.ws] : [sig, pkU]);
  }
  let tx = concatBytes([u32le(2), Uint8Array.of(0x00,0x01), varint(inputs.length)]);
  for (const u of inputs) tx = concatBytes([tx, _uh(u.txid).reverse(), u32le(u.vout), Uint8Array.of(0x00), u32le(nSeq)]);
  tx = concatBytes([tx, varint(outs.length)]);
  for (const o of outs) tx = concatBytes([tx, u64le(o.value8), serStr(o.spk)]);
  for (const w of wit){
    tx = concatBytes([tx, varint(w.length)]);
    for (const item of w) tx = concatBytes([tx, serStr(item)]);
  }
  return concatBytes([tx, u32le(nLockTime)]);
}

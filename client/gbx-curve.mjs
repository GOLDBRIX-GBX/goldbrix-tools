// GBX LAUNCHPAD — client-side port of src/consensus/gbx_curve.h +
// gbx_launchpad.h + gbx_token.h. Pure functions, BigInt-only arithmetic:
// must be bit-identical to the C++ consensus or the node rejects the tx.
// No network, no keys — build & verify only.

export const COIN = 100000000n;
export const V_GBX_SAT   = 30000n * COIN;
export const V_TOKENS    = 1073000000n;
export const CURVE_TOKENS= 800000000n;
export const LP_TOKENS   = 200000000n;
export const CURVE_FEE_BPS = 50n;
export const POOL_FEE_BPS  = 30n;
export const MIN_DEV_BUY_SAT = 1n; // no minimum in money — the barrier is WORK
// ── graduation by the coin's OWN activity — no absolute money value ──
export const GRAD_DEPTH_N   = 20n;              // pool >= N x largest recent trade -> slippage <= 1/N
export const GRAD_MIN_SAT   = 2000n * COIN;     // absolute floor, anti-degenerate only
export const GRAD_WINDOW_MAIN = 201600;         // ~7 days @3s (regtest: 30) — Consensus::Params mirror
export const HM_MAX_AGE = 100;                  // stamp freshness slack = CREATE_POW_MAX_AGE
export const DUST_SAT = 546n;
export const REFUND_IDLE_BLOCKS = 864000;
export const MAX_MONEY = 15000000n * COIN;
const K = V_GBX_SAT * V_TOKENS;

export function curveFee(gross){ gross=BigInt(gross); return gross<=0n?0n:(gross*CURVE_FEE_BPS)/10000n; }
export function curveTokensSold(reserve){ reserve=BigInt(reserve);
  if (reserve<0n) return 0n;
  return V_TOKENS - K/(V_GBX_SAT+reserve); }
export function curveBuy(reserve, gbxIn){ reserve=BigInt(reserve); gbxIn=BigInt(gbxIn);
  if (gbxIn<=0n||reserve<0n||gbxIn>MAX_MONEY||reserve>MAX_MONEY) return null;
  const cur=V_GBX_SAT+reserve, next=cur+gbxIn;
  const tokensOut = K/cur - K/next;
  if (tokensOut<=0n) return null;
  if ((V_TOKENS-K/cur)+tokensOut > CURVE_TOKENS) return null; // exhausted -> graduation
  return { tokensOut, newReserve: reserve+gbxIn }; }
export function curveSell(reserve, tokensIn){ reserve=BigInt(reserve); tokensIn=BigInt(tokensIn);
  if (tokensIn<=0n||reserve<=0n||tokensIn>V_TOKENS) return null;
  const cur=V_GBX_SAT+reserve, curTok=K/cur;
  if (tokensIn > V_TOKENS-curTok) return null;
  let gbxOut = cur - K/(curTok+tokensIn);
  if (gbxOut<0n) return null;
  if (gbxOut>reserve) gbxOut=reserve;
  return { gbxOut, newReserve: reserve-gbxOut }; }

// ── honest quote with REAL price impact (pure curve math, no server) ──────────
// Spot price of 1 token in GBX-sat = dGBX/dTokens = K/(V_GBX_SAT+R)^2 (x*y=k).
// All BigInt in sats; ratios returned as JS numbers only for display.
export function spotPriceSat(reserve){
  // marginal GBX-sat paid for the next token = dGBX/dTokens.
  // tokens(R) = V_TOKENS - K/(V_GBX_SAT+R)  =>  dTokens/dR = K/cur^2
  // so price-per-token in GBX = dR/dTokens = cur^2/K. Rises as R grows (buy).
  const cur = V_GBX_SAT + BigInt(reserve);
  return Number(cur*cur) / Number(K);
}
// BUY quote for gbxInSat (gross, before fee). Returns tokensOut, avg & impact.
export function quoteBuy(reserve, gbxInSat){
  reserve = BigInt(reserve); gbxInSat = BigInt(gbxInSat);
  const fee = curveFee(gbxInSat);
  const net = gbxInSat - fee;
  const rc = curveBuy(reserve, net);
  if (rc === null) return { ok:false, reason:'exhausted_or_invalid' };
  const pBefore = spotPriceSat(reserve);
  const pAfter  = spotPriceSat(rc.newReserve);
  const avg = Number(net) / Number(rc.tokensOut); // GBX-sat paid per token (net)
  return { ok:true, side:'buy',
    tokensOut: rc.tokensOut, newReserve: rc.newReserve, feeSat: fee, netSat: net,
    priceBefore: pBefore, priceAfter: pAfter, avgPrice: avg,
    impactPct: pBefore>0 ? (pAfter - pBefore)/pBefore*100 : 0 };
}
// SELL quote for tokensIn. Returns gbxOut (before fee), avg & impact.
export function quoteSell(reserve, tokensIn){
  reserve = BigInt(reserve); tokensIn = BigInt(tokensIn);
  const rc = curveSell(reserve, tokensIn);
  if (rc === null) return { ok:false, reason:'invalid' };
  const fee = curveFee(rc.gbxOut);
  const pBefore = spotPriceSat(reserve);
  const pAfter  = spotPriceSat(rc.newReserve);
  const avg = Number(rc.gbxOut) / Number(tokensIn);
  return { ok:true, side:'sell',
    gbxOut: rc.gbxOut, netOut: rc.gbxOut - fee, feeSat: fee, newReserve: rc.newReserve,
    priceBefore: pBefore, priceAfter: pAfter, avgPrice: avg,
    impactPct: pBefore>0 ? (pAfter - pBefore)/pBefore*100 : 0 };
}
// ── scripts (byte-identical to consensus) ──────────────────────────────────
const sha256 = async b => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
const OP={DROP:0x75,TRUE:0x51,DROP2:0x6d,CHECKSIG:0xac,RETURN:0x6a,ZERO:0x00};
function push(data){ const n=data.length;
  if (n<0x4c) return Uint8Array.of(n, ...data);
  if (n<=0xff) return Uint8Array.of(0x4c, n, ...data);
  throw new Error('push too large'); }
const cat=(...a)=>{ const t=new Uint8Array(a.reduce((s,x)=>s+x.length,0));
  let o=0; for(const x of a){t.set(x,o);o+=x.length;} return t; };
export const be4 = v => { const b=new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(v)); return b; };
export const be8 = v => { const b=new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v)); return b; };
export const hex = b => Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
export const unhex = s => Uint8Array.from(s.match(/../g)??[], x=>parseInt(x,16));

// Curve script format: <cid:32> <M:8> <h_M:4> OP_2DROP OP_DROP OP_TRUE — byte-identical
// to consensus CurveWitnessScript. The curve address MOVES with (M, h_M).
export function curveWitnessScript(cid, m, hM){
  if (m===undefined || hM===undefined) throw new Error('curveWitnessScript(cid, M, h_M) — old single-arg format is gone');
  return cat(push(cid), push(be8(m)), push(be4(hM)), Uint8Array.of(OP.DROP2, OP.DROP, OP.TRUE)); }
// Mirror of consensus ParseCurveWitnessScript: read (M, h_M) out of a revealed script.
export function parseCurveWitnessScript(wsBytes, cidHex){
  const b=wsBytes; let i=0;
  const rd=n=>{ if(b[i]!==n) return null; const d=b.subarray(i+1,i+1+n); i+=1+n; return d; };
  const id=rd(32); if(!id) return null;
  const m=rd(8);  if(!m)  return null;
  const h=rd(4);  if(!h)  return null;
  if(b[i++]!==OP.DROP2||b[i++]!==OP.DROP||b[i++]!==OP.TRUE||i!==b.length) return null;
  if(cidHex && hex(id)!==cidHex) return null;
  return { m:new DataView(m.buffer,m.byteOffset).getBigUint64(0),
           hM:new DataView(h.buffer,h.byteOffset).getUint32(0), cid:hex(id) }; }
// The market-memory transition, mirror of consensus (gbx_launchpad.cpp).
// trade: net GBX into the curve (CREATE/BUY: gross - fee; SELL: gross out; REFUND: 0n).
// When M updates, h_M is the stamp the client DECLARES (its best tip height);
// consensus demands only freshness <= HM_MAX_AGE.
export function nextMarketMemory(mIn, hmIn, trade, spendHeight, gradWindow, declareHeight){
  mIn=BigInt(mIn); trade=BigInt(trade);
  let m=mIn, hM=Number(hmIn), updated=false;
  if (trade>0n){
    const expired = hM!==0 && (spendHeight - hM) > gradWindow;
    if (expired || trade>m){ m=trade; hM=declareHeight??spendHeight; updated=true; }
  }
  return { m, hM, updated }; }
// Graduation legality, mirror of consensus: full curve OR R >= max(N*M_live, R_MIN).
export function canGraduate(reserve, mIn, hmIn, spendHeight, gradWindow){
  reserve=BigInt(reserve); mIn=BigInt(mIn);
  const full = curveTokensSold(reserve) >= CURVE_TOKENS;
  const mLive = Number(hmIn)!==0 && (spendHeight-Number(hmIn)) <= gradWindow;
  const mEff = mLive ? mIn : 0n;
  const deep = reserve >= GRAD_MIN_SAT && reserve >= mEff*GRAD_DEPTH_N;
  return full || deep; }
export function tokenWitnessScript(cid, amount, pk){
  return cat(push(cid), push(be8(amount)), Uint8Array.of(OP.DROP2), push(pk), Uint8Array.of(OP.CHECKSIG)); }
export function poolWitnessScript(cid, tokens){
  return cat(push(cid), push(be8(tokens)), Uint8Array.of(OP.DROP2, OP.TRUE)); }
export async function p2wsh(ws){ return cat(Uint8Array.of(OP.ZERO, 32), await sha256(ws)); }
export function burnScript(){ return cat(Uint8Array.of(OP.ZERO, 20), new Uint8Array(20)); }

// coin_id = SHA256(txid_internal_LE(32) || vout_BE(4)) of the tx's FIRST input.
export async function coinIdFromOutpoint(txidHexDisplay, vout){
  const le = unhex(txidHexDisplay).reverse();           // display hex = reversed internal
  const b = new Uint8Array(36); b.set(le,0);
  new DataView(b.buffer).setUint32(32, vout);            // big-endian
  return sha256(b); }

// OP_RETURN payload: "GBX:C:" op(1) cid(32) amount(8BE) tokens_out(8BE) pk(33) = 88 bytes
// Returns { raw, script }: raw = the 88-byte payload (for createrawtransaction {data});
// script = full OP_RETURN scriptPubKey (6a + pushdata + payload) for local verification.
export function intentPayload(op, cid, amount, tokensOut, pk){
  const tag = new TextEncoder().encode('GBX:C:');
  const raw = cat(tag, Uint8Array.of(op.charCodeAt(0)), cid, be8(amount), be8(tokensOut), pk);
  if (raw.length!==88) throw new Error('payload size');
  const script = cat(Uint8Array.of(OP.RETURN), push(raw));
  return { raw, script }; }

// Self-verify: parse an OP_RETURN scriptPubKey hex exactly like the indexer/consensus.
// A client MUST call this on its own tx before broadcast. Returns intent or null.
// ── coin metadata on chain: 'GBX:M:'+ver(1)+cid(32)+tLen(1)+ticker+nLen(1)+name.
// Indexers accept it ONLY when the tx is signed by the creator pk from the
// CREATE intent (P2WPKH witness reveals it). First on chain wins the ticker.
export const META_VER = 1;
export const META_TICKER_MAX = 10;
export const META_NAME_MAX = 50;
export function metaPayload(cid, ticker, name){
  const t = new TextEncoder().encode(ticker);
  const n = new TextEncoder().encode(name);
  if (cid.length !== 32) throw new Error('cid must be 32 bytes');
  if (t.length < 1 || t.length > META_TICKER_MAX) throw new Error('ticker 1-10 bytes');
  if (/[^A-Z0-9]/.test(ticker)) throw new Error('ticker A-Z 0-9 only');
  if (n.length < 1 || n.length > META_NAME_MAX) throw new Error('name 1-50 bytes');
  const tag = new TextEncoder().encode('GBX:M:');
  const raw = cat(tag, Uint8Array.of(META_VER), cid, Uint8Array.of(t.length), t, Uint8Array.of(n.length), n);
  const script = cat(Uint8Array.of(OP.RETURN), push(raw));
  return { raw, script };
}
// Self-verify mirror: parse an OP_RETURN spk exactly like the indexer. null = not meta.
export function parseMetaFromScriptHex(spkHex){
  const b = unhex(spkHex);
  if (b.length < 2 || b[0] !== OP.RETURN) return null;
  let d;
  if (b[1] <= 75) d = b.subarray(2);
  else if (b[1] === 0x4c) d = b.subarray(3);
  else return null;
  const tag = new TextEncoder().encode('GBX:M:');
  if (d.length < 42) return null;
  for (let i = 0; i < 6; i++) if (d[i] !== tag[i]) return null;
  if (d[6] !== META_VER) return null;
  const cid = d.subarray(7, 39);
  const tLen = d[39];
  if (tLen < 1 || tLen > META_TICKER_MAX || d.length < 41 + tLen) return null;
  const ticker = new TextDecoder().decode(d.subarray(40, 40 + tLen));
  if (/[^A-Z0-9]/.test(ticker)) return null;
  const nLen = d[40 + tLen];
  if (nLen < 1 || nLen > META_NAME_MAX || d.length !== 41 + tLen + nLen) return null;
  const name = new TextDecoder().decode(d.subarray(41 + tLen));
  return { cid: hex(cid), ticker, name };
}
export function parseIntentFromScriptHex(spkHex){
  const b=unhex(spkHex);
  if(b[0]!==OP.RETURN) return null;
  let i=1,len;
  if(b[1]<0x4c){ len=b[1]; i=2; }
  else if(b[1]===0x4c){ len=b[2]; i=3; }
  else return null;
  const data=b.subarray(i,i+len);
  if(hex(data.subarray(0,6))!==hex(new TextEncoder().encode('GBX:C:'))) return null;
  // mirror of the indexer/consensus: a CREATE carries its 80-byte proof right
  // after the 88-byte intent (168 total); every other op is exactly 88.
  const isCreate = data.length>=7 && data[6]===0x43;
  if(!(data.length===88 || (isCreate && data.length===168))) return null;
  const dv=new DataView(data.buffer,data.byteOffset);
  return { op:String.fromCharCode(data[6]), cid:hex(data.subarray(7,39)),
           amount:dv.getBigUint64(39), tokensOut:dv.getBigUint64(47), pk:hex(data.subarray(55,88)) }; }

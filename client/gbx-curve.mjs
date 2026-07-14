// GBX LAUNCHPAD (IDEE V) — client-side port of src/consensus/gbx_curve.h +
// gbx_launchpad.h + gbx_token.h. Pure functions, BigInt-only arithmetic:
// must be bit-identical to the C++ consensus or the node rejects the tx.
// No network, no keys — build & verify only.

export const COIN = 100000000n;
export const V_GBX_SAT   = 30000n * COIN;
export const V_TOKENS    = 1073000000n;
export const CURVE_TOKENS= 800000000n;
export const LP_TOKENS   = 200000000n;
export const GRADUATION_SAT = 80000n * COIN;
export const CURVE_FEE_BPS = 50n;
export const POOL_FEE_BPS  = 30n;
export const MIN_DEV_BUY_SAT = 1n; // IDEE W: no minimum in money — the barrier is WORK
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

// ── scripts (byte-identical to consensus) ──────────────────────────────────
const sha256 = async b => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
const OP={DROP:0x75,TRUE:0x51,DROP2:0x6d,CHECKSIG:0xac,RETURN:0x6a,ZERO:0x00};
function push(data){ const n=data.length;
  if (n<0x4c) return Uint8Array.of(n, ...data);
  if (n<=0xff) return Uint8Array.of(0x4c, n, ...data);
  throw new Error('push too large'); }
const cat=(...a)=>{ const t=new Uint8Array(a.reduce((s,x)=>s+x.length,0));
  let o=0; for(const x of a){t.set(x,o);o+=x.length;} return t; };
export const be8 = v => { const b=new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v)); return b; };
export const hex = b => Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
export const unhex = s => Uint8Array.from(s.match(/../g)??[], x=>parseInt(x,16));

export function curveWitnessScript(cid){ return cat(push(cid), Uint8Array.of(OP.DROP, OP.TRUE)); }
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
export function parseIntentFromScriptHex(spkHex){
  const b=unhex(spkHex);
  if(b[0]!==OP.RETURN) return null;
  let i=1,len;
  if(b[1]<0x4c){ len=b[1]; i=2; }
  else if(b[1]===0x4c){ len=b[2]; i=3; }
  else return null;
  const data=b.subarray(i,i+len);
  if(data.length!==88) return null;
  if(hex(data.subarray(0,6))!==hex(new TextEncoder().encode('GBX:C:'))) return null;
  const dv=new DataView(data.buffer,data.byteOffset);
  return { op:String.fromCharCode(data[6]), cid:hex(data.subarray(7,39)),
           amount:dv.getBigUint64(39), tokensOut:dv.getBigUint64(47), pk:hex(data.subarray(55,88)) }; }

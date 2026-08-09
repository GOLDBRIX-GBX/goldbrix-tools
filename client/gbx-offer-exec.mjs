// GBX:O direct-market execution helpers - the seller's side of "someone locked
// USDC against my offer". Everything here READS chains through caller-supplied
// rpc functions (no fixed host, no gateway): the declaration is never trusted,
// the lock itself is the proof. Buyer's GBX pubkey travels with the lock:
// on EVM as 33 trailing calldata bytes of lock(), on Solana as a Memo
// instruction in the same transaction.
import { keccak_256 } from '/vendor/evm-secp.mjs';

const hex = (u)=>Array.from(u).map(x=>x.toString(16).padStart(2,'0')).join('');
export const LOCKED_SIG='Locked(bytes32,address,address,address,uint256,bytes32,uint256)';
export function lockedTopic(){ return '0x'+hex(keccak_256(new TextEncoder().encode(LOCKED_SIG))); }

// All Locked events for one receiver (the offer's usdc_addr), newest first.
export async function evmFindLocksForReceiver({ rpc, htlcAddr, receiverHex20, scanBack=200000, win=9000 }){
  const rcv='0x'+String(receiverHex20).replace(/^0x/,'').toLowerCase().padStart(64,'0');
  const t0=lockedTopic();
  const latest=parseInt(await rpc('eth_blockNumber',[]),16);
  const out=[];
  for(let hi=latest; hi>Math.max(0,latest-scanBack); hi-=win){
    const lo=Math.max(0,hi-win+1);
    let logs; try{ logs=await rpc('eth_getLogs',[{address:htlcAddr,fromBlock:'0x'+lo.toString(16),toBlock:'0x'+hi.toString(16),topics:[t0,null,null,rcv]}]); }catch(_e){ continue; }
    for(const l of logs){
      const d=String(l.data).replace(/^0x/,''); const sl=i=>'0x'+d.slice(i*64,(i+1)*64);
      out.push({ id:l.topics[1], sender:'0x'+String(l.topics[2]).slice(-40), txHash:l.transactionHash,
                 token:'0x'+sl(0).slice(-40), amount:BigInt(sl(1)), hashlock:sl(2),
                 timelock:Number(BigInt(sl(3))), blockNumber:parseInt(l.blockNumber,16) });
    }
  }
  out.sort((a,b)=>b.blockNumber-a.blockNumber);
  return out;
}

// The buyer's GBX pubkey = the last 33 bytes of the lock call's calldata
// (the EVM ignores trailing bytes; the chain still carries them forever).
export async function evmBuyerPkFromTx({ rpc, txHash }){
  const tx=await rpc('eth_getTransactionByHash',[txHash]);
  if(!tx || !tx.input) return null;
  const inp=String(tx.input).replace(/^0x/,'');
  if(inp.length < 8+66) return null;
  const pk=inp.slice(-66).toLowerCase();
  if(!/^(02|03)[0-9a-f]{64}$/.test(pk)) return null;
  return pk;
}

// --- Solana: swap accounts of the HTLC program whose receiver == usdc_addr ---
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58enc(bytes){
  let n=0n; for(const b of bytes) n=(n<<8n)|BigInt(b);
  let s=''; while(n>0n){ s=B58[Number(n%58n)]+s; n/=58n; }
  for(const b of bytes){ if(b===0) s='1'+s; else break; }
  return s||'1';
}
function b64b(s){ const bin=atob(s); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i); return u; }
function u64le(u,off){ let v=0n; for(let i=7;i>=0;i--) v=(v<<8n)|BigInt(u[off+i]); return v; }

export async function solFindLocksForReceiver({ solRpc, program, receiverBytes32 }){
  const res=await solRpc('getProgramAccounts',[program,{encoding:'base64',commitment:'confirmed',
    filters:[{memcmp:{offset:40,bytes:b58enc(receiverBytes32)}}]}]);
  const out=[];
  for(const a of (res||[])){
    // Some public RPCs answer without the account key. A row we cannot name is a
    // row we cannot read further: skipping it beats calling the chain with
    // "undefined" and waiting forever.
    if(!a || !a.pubkey) continue;
    const u=b64b(a.account.data[0]);
    if(u.length<154) continue;
    // Settled swaps are history, not candidates. Dropping them here keeps every
    // later call - signatures, transactions - off a list that can be years long.
    if(u[152]===1 || u[153]===1) continue;
    out.push({ pda:a.pubkey, sender:u.slice(8,40), receiver:u.slice(40,72), mint:b58enc(u.slice(72,104)),
               amount:u64le(u,104), hashlock:'0x'+hex(u.slice(112,144)),
               timelock:Number(u64le(u,144)), claimed:u[152]===1, refunded:u[153]===1 });
  }
  return out;
}

const MEMO_PROGRAM='MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
// The buyer's GBX pubkey = the Memo carried by the transaction that created the
// swap account (same tx as the lock). Read, validated, never trusted further:
// a wrong pk only hurts the party who chose it.
export async function solBuyerPkFromPda({ solRpc, pda }){
  const sigs=await solRpc('getSignaturesForAddress',[pda,{limit:8}]);
  if(!sigs || !sigs.length) return null;
  for(let i=sigs.length-1;i>=0;i--){ // oldest first: the creating tx
    const tx=await solRpc('getTransaction',[sigs[i].signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'confirmed'}]);
    if(!tx) continue;
    const ins=((tx.transaction||{}).message||{}).instructions||[];
    for(const it of ins){
      if(it.program==='spl-memo' || it.programId===MEMO_PROGRAM){
        const m=String(it.parsed!=null?it.parsed:(it.data||'')).trim().toLowerCase();
        if(/^(02|03)[0-9a-f]{64}$/.test(m)) return m;
      }
    }
  }
  return null;
}

// One judgement for both chains: is this lock an acceptable execution of this
// offer? Nothing is assumed - amount, token, time and state are all checked.
// Is this lock still holding money? The Locked event alone cannot say: settlement
// lives in Claimed/Refunded. Anything that reasons about "already reserved" must
// ask the chain for those, or it will keep rejecting on ghosts of old trades.
export async function evmLockSettled({ rpc, htlcAddr, lockId, fromBlock, scanBack=60000, win=9000 }){
  const kec=(x)=>'0x'+Array.from(keccak_256(new TextEncoder().encode(x))).map(b=>b.toString(16).padStart(2,'0')).join('');
  const topics=[[kec('Claimed(bytes32,bytes)'), kec('Refunded(bytes32)')], lockId];
  const latest=parseInt(await rpc('eth_blockNumber',[]),16);
  const floor=Math.max(0, fromBlock!=null ? Number(fromBlock) : latest-scanBack);
  for(let hi=latest; hi>floor; hi-=win){
    const lo=Math.max(floor, hi-win+1);
    let lg; try{ lg=await rpc('eth_getLogs',[{address:htlcAddr,fromBlock:'0x'+lo.toString(16),toBlock:'0x'+hi.toString(16),topics}]); }catch(_e){ continue; }
    if(lg && lg.length) return true;
  }
  return false;
}

export function checkLockAgainstOffer({ offer, lock, usdcTokenExpected, nowSec, minMarginSec=43200 }){
  if(lock.claimed || lock.refunded) return { ok:false, reason:'settled' };
  if(usdcTokenExpected!=null){
    const a=String(lock.token!=null?lock.token:lock.mint).toLowerCase();
    if(a!==String(usdcTokenExpected).toLowerCase()) return { ok:false, reason:'wrong_token' };
  }
  const needMicro = (BigInt(offer.value_sat) * BigInt(offer.price_micro)) / 100000000n; // sat*price/1e8
  const floor = needMicro - needMicro/100n; // -1%: dust rounding tolerance, never more
  if(BigInt(lock.amount) < floor) return { ok:false, reason:'amount_low', need:String(needMicro) };
  if(!(Number(lock.timelock) >= Number(nowSec)+minMarginSec)) return { ok:false, reason:'timelock_short' };
  return { ok:true, need:String(needMicro) };
}

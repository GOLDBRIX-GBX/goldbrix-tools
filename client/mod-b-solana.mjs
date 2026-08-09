// GOLDBRIX · mod-b-solana.mjs · client browser lock USDC gasless pe Solana (DESIGN 1 co-semnare)
import { Keypair, Transaction } from "/vendor/solana.mjs";
const _hex = b => [...b].map(x => x.toString(16).padStart(2, "0")).join("");
function _randomSecret() { return globalThis.crypto.getRandomValues(new Uint8Array(32)); }
async function _sha256(bytes){ const d=await globalThis.crypto.subtle.digest("SHA-256",bytes); return new Uint8Array(d); }
export function solKeypairFromDerive(d){ const seed=Uint8Array.from(Buffer.from(d.secretKey,"hex")); return Keypair.fromSeed(seed); }
export async function lockUsdcSolana(ctx){
  const { gatewayBase, solKeypair, usdcAmount, gbxAmount, pkUHex, t2Blocks, onStatus } = ctx;
  const post=async(p,b)=>{ const r=await fetch(gatewayBase+p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}); return r.json(); };
  const secret=ctx.secret||_randomSecret();
  const H=await _sha256(secret); const hashlock="0x"+_hex(H);
  const swapId="0x"+_hex(_randomSecret());
  onStatus&&onStatus("prepared",{hashlock});
  const prep=await post("/sol-prepare",{user_pubkey:solKeypair.publicKey.toBase58(),amount:String(usdcAmount),hashlock,swap_id:swapId});
  if(prep.error||!prep.tx_b64) throw new Error("sol-prepare: "+JSON.stringify(prep));
  const tx=Transaction.from(Uint8Array.from(atob(prep.tx_b64),c=>c.charCodeAt(0)));
  tx.partialSign(solKeypair);
  const signedB64=btoa(String.fromCharCode(...tx.serialize({requireAllSignatures:false})));
  onStatus&&onStatus("user_signed",{swap_id:prep.swap_id});
  try{ if(typeof localStorage!=="undefined") localStorage.setItem("gbx_pending_"+hashlock,JSON.stringify({dir:"buy_solana",owner_pk:(pkUHex||""),hashlock,secret:_hex(secret),swap_id:prep.swap_id,vault:prep.vault,usdcAmount:String(usdcAmount),ts:Date.now()})); }catch(_e){}
  const sub=await post("/sol-submit",{tx_signed_b64:signedB64,swap_id:prep.swap_id,hashlock,pkU:pkUHex,gbx_amount:gbxAmount,t2_blocks:t2Blocks});
  if(sub.error==='price_moved'){
    // A refusal on price is final and nothing was broadcast: no point asking the
    // chain about a lock that was never sent, and no reason to make the user wait.
    try{ if(typeof localStorage!=="undefined") localStorage.removeItem("gbx_pending_"+hashlock); }catch(_e){}
    throw new Error('price_moved: '+(sub.msg||''));
  }
  if(sub.error||!sub.ok){
    /* The lock may already be on chain: the LP broadcasts first and only then
       confirms, so a slow confirmation must not be reported as a failure. A user
       told "it failed" locks a second time and pays twice. The chain decides. */
    let _live=null;
    for(let i=0;i<6 && !_live;i++){
      _live=await fetchSolSwap(ctx.program||"", H).catch(()=>null);
      if(!_live) await new Promise(r=>setTimeout(r,2000));
    }
    if(!_live) throw new Error("sol-submit: "+JSON.stringify(sub));
    onStatus&&onStatus("usdc_locked",{sig:null,recovered:true});
    return { hashlock, secret:_hex(secret), swap_id:prep.swap_id, sig:null };
  }
  onStatus&&onStatus("usdc_locked",{sig:sub.sig,vault:sub.vault});
  return { hashlock, secret:_hex(secret), swap_id:prep.swap_id, sig:sub.sig };
}


// ================= SELL GBX -> USDC pe Solana =================
/* Order matters for getProgramAccounts: some endpoints answer without the
   account key, and one refuses the call outright. The endpoint that returns a
   complete answer is asked first; the others stay as fallbacks. */
/* Browser rules, not server rules: api.mainnet-beta answers 403 to any request
   carrying an Origin, so it is useless here even though a node may use it.
   These endpoints all answer a browser; a node keeps its own list. */
const SOL_RPCS=["https://solana-rpc.publicnode.com","https://solana.leorpc.com/?api_key=FREE"];
async function _solRpc(method,params,timeoutMs=12000){ let le=null;
  /* A node that never answers must not hold a page forever: every attempt has its
     own deadline, and the next endpoint gets the question. */
  for(const u of SOL_RPCS){
    const ac=(typeof AbortController!=="undefined")?new AbortController():null;
    const t=ac?setTimeout(()=>ac.abort(),timeoutMs):null;
    try{ const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),signal:ac?ac.signal:undefined}); const j=await r.json(); if(j.error){le=new Error(j.error.message);continue;} return j.result; }
    catch(e){le=e;}
    finally{ if(t) clearTimeout(t); }
  }
  throw le||new Error("sol rpc fail"); }
async function _swapPda(programStr,swapIdBytes){ const { PublicKey }=await import("/vendor/solana.mjs");
  const pid=new PublicKey(programStr); const seeds=[new TextEncoder().encode("swap"),swapIdBytes];
  if(PublicKey.findProgramAddressSync) return PublicKey.findProgramAddressSync(seeds,pid)[0];
  return (await PublicKey.findProgramAddress(seeds,pid))[0]; }
function _b64b(s){ const bin=atob(s); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i); return u; }
function _u64le(u,off){ let v=0n; for(let i=7;i>=0;i--) v=(v<<8n)|BigInt(u[off+i]); return v; }
export async function fetchSolSwap(programStr,swapIdBytes){
  const pda=await _swapPda(programStr,swapIdBytes);
  const r=await _solRpc("getAccountInfo",[pda.toBase58(),{encoding:"base64",commitment:"confirmed"}]);
  if(!r||!r.value) return null;
  const u=_b64b(r.value.data[0]);
  return { pda, sender:u.slice(8,40), receiver:u.slice(40,72), mint:u.slice(72,104),
    amount:_u64le(u,104), hashlock:_hex(u.slice(112,144)),
    timelock:Number(_u64le(u,144)), claimed:u[152]===1, refunded:u[153]===1 };
}
export async function sellGbxSolana(ctx){
  const { gatewayBase, program, mint, solKeypair, gbxLock, usdcAmount, onStatus, pollMs=1500, maxPolls=80 } = ctx;
  const { PublicKey, Transaction }=await import("/vendor/solana.mjs");
  const post=async(p,b)=>{ const r=await fetch(gatewayBase+p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}); return r.json(); };
  const secret=_randomSecret(); const H=await _sha256(secret); const Hhex="0x"+_hex(H);
  onStatus&&onStatus("prepared",{hashlock:Hhex});
  const lock=await gbxLock({H,Hhex});                       // lock GBX L1 (injectat, cod dovedit sell EVM)
  onStatus&&onStatus("gbx_locked",{gbx_txid:lock.gbx_txid});
  try{ localStorage.setItem("gbx_pending_"+Hhex,JSON.stringify({dir:"sell",chain:"solana",owner_pk:(lock.refund_pubkey||""),hashlock:Hhex,secret:_hex(secret),usdcAmount:String(usdcAmount),gbx_txid:lock.gbx_txid,gbx_vout:lock.gbx_vout,ts:Date.now()})); }catch(_e){}
  await post("/intent",{hashlock:Hhex,direction:"sell",chain:"solana",sol_user_pubkey:solKeypair.publicKey.toBase58(),
    usdc_amount:String(usdcAmount),gbx_txid:lock.gbx_txid,gbx_vout:lock.gbx_vout,gbx_script:lock.script,gbx_val:lock.gbx_val,t2_evm:3600,refund_pubkey:lock.refund_pubkey||""});
  // asteapta lock-ul USDC al LP-ului si VERIFICA on-chain INAINTE de a dezvalui preimage-ul (funds-safe)
  const _cl=await claimUsdcSolana({gatewayBase,program,mint,solKeypair,secretHex:_hex(secret),usdcAmount,onStatus,pollMs,maxPolls});
  return { hashlock:Hhex, sig:_cl.sig, secret:_hex(secret) };
}


/* Claim the USDC side of a Solana sell. Used by sellGbxSolana at settle time and by the
   pending-recovery card (the claim survives a closed tab: secret+hashlock live in the pending). */
/* Getting a stuck buy back must not depend on holding SOL. The program pays a
   refund only to the account that funded the lock (sender_ata is checked against
   swap.sender on chain), so the LP can relay it and pay the gas without being able
   to divert anything. Signing it ourselves stays the fallback. */
/* DIRECT MARKET: the buyer builds and signs the USDC lock on this device, against
   public RPCs. No gateway, no LP, no server of anyone's: that is the whole point of
   the direct market, and the honest consequence is that the buyer pays their own
   fee and rent on Solana. The rent comes back at claim or refund.
   swap_id == hashlock, exactly as fetchSolSwap/claim/refund already read it.
   The seller's token account is created idempotently in the SAME transaction:
   claim requires receiver_ata to exist, and a button that cannot succeed is not
   offered. The buyer's GBX pubkey travels as a Memo in the same transaction. */
/* The same public-RPC path the module already uses, exposed so a page can read a
   chain without inventing its own host list. */
export async function solRpc(method,params){ return _solRpc(method,params); }
/* The swap account of a hashlock, read at the address the hashlock itself
   derives. Cheap, allowed by every public endpoint, and the only proof the
   client accepts before moving coins. */
export async function fetchSolSwapByHashlock(programStr, hashlockHex){
  const h=String(hashlockHex||"").replace(/^0x/,"").toLowerCase();
  if(h.length!==64) return null;
  const H=new Uint8Array(32); for(let i=0;i<32;i++) H[i]=parseInt(h.substr(i*2,2),16);
  const sw=await fetchSolSwap(programStr,H).catch(()=>null);
  if(!sw) return null;
  /* The raw account gives 32-byte keys; everything downstream - the offer guard,
     the UI, the API - speaks base58. Converting here keeps one shape in one place
     instead of every caller guessing which one it got. */
  const _b58=(b)=>{ const A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n=0n; for(const x of b) n=(n<<8n)|BigInt(x);
    let o=''; while(n>0n){ o=A[Number(n%58n)]+o; n/=58n; }
    for(const x of b){ if(x===0) o='1'+o; else break; } return o||'1'; };
  return { pda:sw.pda.toBase58?sw.pda.toBase58():String(sw.pda), sender:_b58(sw.sender),
           receiver:_b58(sw.receiver), mint:_b58(sw.mint), amount:sw.amount, hashlock:sw.hashlock,
           timelock:sw.timelock, claimed:sw.claimed, refunded:sw.refunded };
}
export async function solPreflight(program){
  const r=await _solRpc("getAccountInfo",[program,{encoding:"base64",commitment:"confirmed"}]);
  const v=r&&r.value;
  return !!(v && v.executable===true);
}
export async function solBuildLockTx(ctx){
  const { program, mint, solKeypair, receiverB58, usdcAmount, hashlockHex, timelockSec, buyerPkHex }=ctx;
  const { PublicKey, Transaction, TransactionInstruction, getAssociatedTokenAddress,
          createAssociatedTokenAccountIdempotentInstruction }=await import("/vendor/solana.mjs");
  if(!(await solPreflight(program))) throw new Error("E_SOLDOWN");
  const _h=String(hashlockHex||"").replace(/^0x/,"").toLowerCase();
  if(_h.length!==64) throw new Error("E_HASHLOCK");
  const H=new Uint8Array(32); for(let i=0;i<32;i++) H[i]=parseInt(_h.substr(i*2,2),16);
  const pkHex=String(buyerPkHex||"").toLowerCase();
  if(!/^(02|03)[0-9a-f]{64}$/.test(pkHex)) throw new Error("E_BUYERPK");
  const amt=BigInt(usdcAmount); if(!(amt>0n)) throw new Error("E_AMOUNT");
  const tl=BigInt(Math.floor(Number(timelockSec)));
  if(!(tl>BigInt(Math.floor(Date.now()/1000)))) throw new Error("E_TIMELOCK");
  const PID=new PublicKey(program), MINT=new PublicKey(mint);
  const RCV=new PublicKey(receiverB58);
  const userPk=solKeypair.publicKey;
  const enc=new TextEncoder();
  const pda=(PublicKey.findProgramAddressSync?PublicKey.findProgramAddressSync([enc.encode("swap"),H],PID)[0]
    :(await PublicKey.findProgramAddress([enc.encode("swap"),H],PID))[0]);
  const vault=(PublicKey.findProgramAddressSync?PublicKey.findProgramAddressSync([enc.encode("vault"),H],PID)[0]
    :(await PublicKey.findProgramAddress([enc.encode("vault"),H],PID))[0]);
  const senderAta=await getAssociatedTokenAddress(MINT,userPk);
  const rcvAta=await getAssociatedTokenAddress(MINT,RCV);
  // Anchor: discriminator = sha256("global:lock")[:8], then Borsh args in order.
  const disc=(await _sha256(enc.encode("global:lock"))).slice(0,8);
  const data=new Uint8Array(8+32+8+32+8);
  data.set(disc,0); data.set(H,8);
  const dv=new DataView(data.buffer);
  dv.setBigUint64(40,amt,true);
  data.set(H,48);
  dv.setBigInt64(80,tl,true);
  const ixAta=createAssociatedTokenAccountIdempotentInstruction(userPk,rcvAta,RCV,MINT);
  const ixLock=new TransactionInstruction({programId:PID,keys:[
    {pubkey:userPk,isSigner:true,isWritable:true},
    {pubkey:userPk,isSigner:true,isWritable:true},
    {pubkey:RCV,isSigner:false,isWritable:false},
    {pubkey:MINT,isSigner:false,isWritable:false},
    {pubkey:pda,isSigner:false,isWritable:true},
    {pubkey:vault,isSigner:false,isWritable:true},
    {pubkey:senderAta,isSigner:false,isWritable:true},
    {pubkey:new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),isSigner:false,isWritable:false},
    {pubkey:new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),isSigner:false,isWritable:false},
    {pubkey:new PublicKey("11111111111111111111111111111111"),isSigner:false,isWritable:false},
    {pubkey:new PublicKey("SysvarRent111111111111111111111111111111111"),isSigner:false,isWritable:false}],data});
  const ixMemo=new TransactionInstruction({programId:new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    keys:[],data:enc.encode(pkHex)});
  const bh=await _solRpc("getLatestBlockhash",[{commitment:"confirmed"}]);
  const tx=new Transaction({recentBlockhash:((bh&&bh.value)||bh).blockhash,feePayer:userPk});
  tx.add(ixAta); tx.add(ixLock); tx.add(ixMemo);
  return { tx, pda:pda.toBase58(), vault:vault.toBase58(), rcvAta:rcvAta.toBase58() };
}
export async function solDirectLock(ctx){
  const built=await solBuildLockTx(ctx);
  built.tx.sign(ctx.solKeypair);
  const raw=btoa(String.fromCharCode(...built.tx.serialize()));
  const sig=await _solRpc("sendTransaction",[raw,{encoding:"base64",skipPreflight:false,preflightCommitment:"confirmed"}]);
  return { sig:(sig&&sig.value)||sig, pda:built.pda, vault:built.vault };
}
export async function refundUsdcSolana(ctx){
  const { gatewayBase, program, mint, solKeypair, swapId }=ctx;
  const { PublicKey, Transaction, TransactionInstruction, getAssociatedTokenAddress }=await import("/vendor/solana.mjs");
  const _s=String(swapId||"").replace(/^0x/,"");
  if(_s.length!==64) throw new Error("refund: bad swap id");
  const idB=new Uint8Array(32); for(let i=0;i<32;i++) idB[i]=parseInt(_s.substr(i*2,2),16);
  const sw=await fetchSolSwap(program,idB).catch(()=>null);
  if(!sw) throw new Error("lock not found on Solana");
  if(sw.claimed||sw.refunded) throw new Error("lock already settled");
  const now=Math.floor(Date.now()/1000);
  if(sw.timelock>now) throw new Error("too early: "+(sw.timelock-now)+"s left");
  const userPk=solKeypair.publicKey;
  const sAta=await getAssociatedTokenAddress(new PublicKey(mint),userPk);
  /* PATH 1: the LP relays and pays the gas. */
  try{
    const r=await fetch(gatewayBase+"/sol-relay-refund",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({swap_id:"0x"+_s,sender_ata:sAta.toBase58()})});
    const j=await r.json();
    if(j&&j.sig) return { sig:j.sig, relayed:true };
  }catch(_e){}
  /* PATH 2: sign it ourselves, which needs SOL for the fee. */
  const bal=await _solRpc("getBalance",[userPk.toBase58(),{commitment:"confirmed"}]).then(r=>r.value||r).catch(()=>0);
  if(!(bal>=1000000)) throw new Error("no relay available and no SOL for the fee");
  const disc=(await _sha256(new TextEncoder().encode("global:refund"))).slice(0,8);
  const data=new Uint8Array(8+32); data.set(disc,0); data.set(idB,8);
  const enc=new TextEncoder();
  const pda=sw.pda;
  const vault=(PublicKey.findProgramAddressSync?PublicKey.findProgramAddressSync([enc.encode("vault"),idB],new PublicKey(program))[0]
    :(await PublicKey.findProgramAddress([enc.encode("vault"),idB],new PublicKey(program)))[0]);
  const ix=new TransactionInstruction({programId:new PublicKey(program),keys:[
    {pubkey:userPk,isSigner:true,isWritable:true},
    {pubkey:pda,isSigner:false,isWritable:true},
    {pubkey:vault,isSigner:false,isWritable:true},
    {pubkey:sAta,isSigner:false,isWritable:true},
    {pubkey:new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),isSigner:false,isWritable:false}],data});
  const bh=await _solRpc("getLatestBlockhash",[{commitment:"confirmed"}]);
  const tx=new Transaction({recentBlockhash:(bh.value||bh).blockhash,feePayer:userPk}).add(ix);
  tx.sign(solKeypair);
  const raw=btoa(String.fromCharCode(...tx.serialize()));
  const sig=await _solRpc("sendTransaction",[raw,{encoding:"base64",skipPreflight:false,preflightCommitment:"confirmed"}]);
  return { sig:(sig&&sig.value)||sig, relayed:false };
}

export async function claimUsdcSolana(ctx){
  const { gatewayBase, program, mint, solKeypair, secretHex, usdcAmount=0, onStatus, pollMs=1500, maxPolls=20 }=ctx;
  const { PublicKey, Transaction }=await import("/vendor/solana.mjs");
  const post=async(p,b)=>{ const r=await fetch(gatewayBase+p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}); return r.json(); };
  const _h=String(secretHex||"").replace(/^0x/,"");
  const secret=new Uint8Array(_h.length/2); for(let i=0;i<secret.length;i++) secret[i]=parseInt(_h.substr(i*2,2),16);
  const H=await _sha256(secret); const Hhex="0x"+_hex(H);
  let sw=null;
  for(let i=0;i<maxPolls;i++){ sw=await fetchSolSwap(program,H).catch(()=>null); if(sw) break; await new Promise(r=>setTimeout(r,pollMs)); }
  if(!sw) throw new Error("USDC lock not found on Solana yet - try again shortly");
  const userPk=solKeypair.publicKey;
  if(_hex(sw.receiver)!==_hex(userPk.toBytes())) throw new Error("USDC lock invalid (receiver) -> not claiming");
  const PK=PublicKey;
  if(_hex(sw.mint)!==_hex(new PK(mint).toBytes())) throw new Error("USDC lock invalid (mint) -> not claiming");
  if(usdcAmount && sw.amount < BigInt(usdcAmount)) throw new Error("USDC lock invalid (amount) -> not claiming");
  if(sw.hashlock.toLowerCase()!==_hex(H)) throw new Error("USDC lock invalid (hashlock) -> not claiming");
  if(sw.claimed||sw.refunded) throw new Error("USDC lock already settled");
  if(sw.timelock < Math.floor(Date.now()/1000)+300) throw new Error("timelock too short -> not claiming");
  onStatus&&onStatus("usdc_verified",{amount:sw.amount.toString()});
  const preHex="0x"+_hex(secret); let sig=null;
  // CALEA 1 (default): claim gasless via gateway (feePayer=LP), user semneaza
  try{
    const prep=await post("/sol-prepare-claim",{user_pubkey:userPk.toBase58(),swap_id:Hhex,preimage:preHex});
    if(prep.error||!prep.tx_b64) throw new Error("prepare-claim: "+JSON.stringify(prep));
    const tx=Transaction.from(_b64b(prep.tx_b64)); tx.partialSign(solKeypair);
    const sub=await post("/sol-submit-claim",{tx_signed_b64:btoa(String.fromCharCode(...tx.serialize({requireAllSignatures:false}))),swap_id:Hhex});
    if(sub.error||!sub.sig) throw new Error("submit-claim: "+JSON.stringify(sub));
    sig=sub.sig;
  }catch(e1){
    // PATH 2 (trustless): direct claim if the user has SOL
    const bal=await _solRpc("getBalance",[userPk.toBase58(),{commitment:"confirmed"}]).then(r=>r.value||r).catch(()=>0);
    if(!(bal>=1000000)) throw e1;
    const { TransactionInstruction, getAssociatedTokenAddress }=await import("/vendor/solana.mjs");
    const disc=(await _sha256(new TextEncoder().encode("global:claim"))).slice(0,8);
    const data=new Uint8Array(8+32+4+secret.length); data.set(disc,0); data.set(H,8);
    new DataView(data.buffer).setUint32(40,secret.length,true); data.set(secret,44);
    const pda=sw.pda; const vault=(PublicKey.findProgramAddressSync?PublicKey.findProgramAddressSync([new TextEncoder().encode("vault"),H],new PK(program))[0]:(await PublicKey.findProgramAddress([new TextEncoder().encode("vault"),H],new PK(program)))[0]);
    const rAta=await getAssociatedTokenAddress(new PK(mint),userPk);
    const ix=new TransactionInstruction({programId:new PK(program),keys:[
      {pubkey:userPk,isSigner:true,isWritable:true},
      {pubkey:pda,isSigner:false,isWritable:true},
      {pubkey:vault,isSigner:false,isWritable:true},
      {pubkey:rAta,isSigner:false,isWritable:true},
      {pubkey:new PK("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),isSigner:false,isWritable:false}],data});
    /* Same broadcast shape the refund path has proven on chain: some public
       endpoints refuse or drop a submission that asks them to run preflight,
       and the response envelope differs between them. */
    const bh=await _solRpc("getLatestBlockhash",[{commitment:"confirmed"}]);
    const tx2=new Transaction({recentBlockhash:((bh&&bh.value)||bh).blockhash,feePayer:userPk}).add(ix);
    tx2.sign(solKeypair);
    const _raw=btoa(String.fromCharCode(...tx2.serialize()));
    const _s=await _solRpc("sendTransaction",[_raw,{encoding:"base64",skipPreflight:false,preflightCommitment:"confirmed"}]);
    sig=(_s&&_s.value)||_s;
  }
  onStatus&&onStatus("usdc_claimed",{sig});
  try{ localStorage.removeItem("gbx_pending_"+Hhex); }catch(_e){}
  return { hashlock:Hhex, sig, secret:_hex(secret) };
}
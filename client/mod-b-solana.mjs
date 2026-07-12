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
  try{ if(typeof localStorage!=="undefined") localStorage.setItem("gbx_pending_"+hashlock,JSON.stringify({dir:"buy_solana",hashlock,secret:_hex(secret),swap_id:prep.swap_id,vault:prep.vault,usdcAmount:String(usdcAmount),ts:Date.now()})); }catch(_e){}
  const sub=await post("/sol-submit",{tx_signed_b64:signedB64,swap_id:prep.swap_id,hashlock,pkU:pkUHex,gbx_amount:gbxAmount,t2_blocks:t2Blocks});
  if(sub.error||!sub.ok) throw new Error("sol-submit: "+JSON.stringify(sub));
  onStatus&&onStatus("usdc_locked",{sig:sub.sig,vault:sub.vault});
  return { hashlock, secret:_hex(secret), swap_id:prep.swap_id, sig:sub.sig };
}


// ================= SELL GBX -> USDC pe Solana =================
const SOL_RPCS=["https://solana-rpc.publicnode.com","https://solana.leorpc.com/?api_key=FREE","https://api.mainnet-beta.solana.com"];
async function _solRpc(method,params){ let le=null;
  for(const u of SOL_RPCS){ try{ const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})}); const j=await r.json(); if(j.error){le=new Error(j.error.message);continue;} return j.result; }catch(e){le=e;} }
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
  try{ localStorage.setItem("gbx_pending_"+Hhex,JSON.stringify({dir:"sell",chain:"solana",hashlock:Hhex,secret:_hex(secret),usdcAmount:String(usdcAmount),gbx_txid:lock.gbx_txid,gbx_vout:lock.gbx_vout,ts:Date.now()})); }catch(_e){}
  await post("/intent",{hashlock:Hhex,direction:"sell",chain:"solana",sol_user_pubkey:solKeypair.publicKey.toBase58(),
    usdc_amount:String(usdcAmount),gbx_txid:lock.gbx_txid,gbx_vout:lock.gbx_vout,gbx_script:lock.script,gbx_val:lock.gbx_val,t2_evm:3600,refund_pubkey:lock.refund_pubkey||""});
  // asteapta lock-ul USDC al LP-ului si VERIFICA on-chain INAINTE de a dezvalui preimage-ul (funds-safe)
  let sw=null;
  for(let i=0;i<maxPolls;i++){ sw=await fetchSolSwap(program,H).catch(()=>null); if(sw) break; await new Promise(r=>setTimeout(r,pollMs)); }
  if(!sw) throw new Error("timeout: LP nu a blocat USDC pe Solana -> refund GBX dupa T1");
  const userPk=solKeypair.publicKey;
  if(_hex(sw.receiver)!==_hex(userPk.toBytes())) throw new Error("USDC lock invalid (receiver) -> NU revendic");
  const { PublicKey:PK }=await import("/vendor/solana.mjs");
  if(_hex(sw.mint)!==_hex(new PK(mint).toBytes())) throw new Error("USDC lock invalid (mint) -> NU revendic");
  if(sw.amount < BigInt(usdcAmount)) throw new Error("USDC lock invalid (amount) -> NU revendic");
  if(sw.hashlock.toLowerCase()!==_hex(H)) throw new Error("USDC lock invalid (hashlock) -> NU revendic");
  if(sw.claimed||sw.refunded) throw new Error("USDC lock deja consumat");
  if(sw.timelock < Math.floor(Date.now()/1000)+300) throw new Error("timelock prea scurt -> NU revendic");
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
    // CALEA 2 (trustless): claim direct daca userul are SOL
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
    const bh=await _solRpc("getLatestBlockhash",[{commitment:"confirmed"}]);
    const tx2=new Transaction(); tx2.add(ix); tx2.feePayer=userPk; tx2.recentBlockhash=bh.value.blockhash; tx2.sign(solKeypair);
    sig=await _solRpc("sendTransaction",[btoa(String.fromCharCode(...tx2.serialize())),{encoding:"base64"}]);
  }
  onStatus&&onStatus("usdc_claimed",{sig});
  try{ localStorage.removeItem("gbx_pending_"+Hhex); }catch(_e){}
  return { hashlock:Hhex, sig, secret:_hex(secret) };
}

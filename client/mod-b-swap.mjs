// mod-b-swap.mjs — GoldBrix Mod B atomic swap orchestration (USER side, browser, non-custodial).
// Branding: GBX only. Deps injectate (browser le leaga la crypto-utils/evm-tx/relay/daemon).
import { buildClaimTx, p2wshSpk, p2wshAddress, hex, unhex } from './gbx-htlc.mjs';
import { sha256 } from '/vendor/gbx-hash.mjs';
const _eq=(a,b)=>{ if(a.length!==b.length) return false; for(let i=0;i<a.length;i++) if(a[i]!==b[i]) return false; return true; };
const _sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
function _randomSecret(){ return globalThis.crypto.getRandomValues(new Uint8Array(32)); }

// Verifica HTLC-ul GBX finantat de LP: ramura de claim TREBUIE sa fie (H-ul nostru, pubkey-ul nostru).
// Layout: 63 a8 [20 H(32)] 88 [21 pkClaim(33)] ac 67 [push T2] b1 75 [21 pkRefund(33)] ac 68
export function verifyGbxLock({ H, pkU, scriptHex, onchainSpkHex, gbxVal8, minVal8 }){
  const scr = unhex(scriptHex);
  if(scr[0]!==0x63 || scr[1]!==0xa8) return {ok:false, reason:'not_htlc'};
  if(scr[2]!==0x20) return {ok:false, reason:'bad_hashlock_push'};
  if(!_eq(scr.slice(3,35), H)) return {ok:false, reason:'hashlock_mismatch'};
  if(scr[35]!==0x88 || scr[36]!==0x21) return {ok:false, reason:'bad_claim_push'};
  if(!_eq(scr.slice(37,70), pkU)) return {ok:false, reason:'claim_pubkey_not_ours'};
  if(scr[70]!==0xac || scr[71]!==0x67) return {ok:false, reason:'bad_structure'};
  if(onchainSpkHex && hex(p2wshSpk(scr)).toLowerCase()!==onchainSpkHex.toLowerCase()) return {ok:false, reason:'spk_mismatch'};
  if(minVal8 && gbxVal8 < minVal8) return {ok:false, reason:'amount_too_low'};
  return {ok:true, addr:p2wshAddress(scr)};
}

// BUY GBX cu USDC (atomic, non-custodial). ctx.evm/gbx/submitIntent injectate.
export async function buyGbx(ctx){
  const { amountUsdc, gbxAmount, lpEvmAddr, timelockT1, evm, gbx, submitIntent, onStatus, pollMs=1000, maxPolls=120, fee8=10000 } = ctx;
  const s = ctx.secret || _randomSecret();
  const H = sha256(s), Hhex = '0x'+hex(H), pkU = gbx.userPubkey;
  onStatus && onStatus('prepared', { hashlock: Hhex });
  if (ctx.gasless) {
    // GASLESS: userul semneaza autorizatia EIP-3009 (zero gaz), relayer-ul (daemon) submite lockAuth.
    const g = ctx.gasless;
    const auth = await g.sign3009({ value: amountUsdc, toHtlc: g.htlcAddr });
    await submitIntent({ hashlock: Hhex, pkU: hex(pkU), gbx_amount: gbxAmount,
      gasless: true, evm_user: g.userAddr, usdc_amount: amountUsdc, chain: ctx.chain||'base',
      auth3009: { v: auth.v, r: auth.r, s: auth.s, validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce } });
    onStatus && onStatus('usdc_authorized', { gasless: true });
  } else {
    // Calea clasica: userul plateste gazul (approve + lock).
    await submitIntent({ hashlock: Hhex, pkU: hex(pkU), gbx_amount: gbxAmount });
    await evm.approve(amountUsdc);
    const lockId = await evm.lock({ receiver: lpEvmAddr, amount: amountUsdc, hashlock: Hhex, timelock: timelockT1 });
    onStatus && onStatus('usdc_locked', { lockId });
  }
  try{ if(typeof localStorage!=='undefined') localStorage.setItem('gbx_pending_'+Hhex, JSON.stringify({dir:'buy',chain:(ctx&&ctx.chain)||'',hashlock:Hhex,secret:hex(s),lockId:lockId||null,gasless:!!ctx.gasless,timelock:String(timelockT1),amountUsdc:String(amountUsdc),ts:Date.now()})); }catch(_e){}
  let swap=null;
  for(let i=0;i<maxPolls;i++){ swap = await gbx.fetchSwap(Hhex); if(swap) break; await _sleep(pollMs); }
  if(!swap) throw new Error('timeout: LP nu a blocat GBX -> refund USDC dupa T1');
  const v = verifyGbxLock({ H, pkU, scriptHex: swap.script, onchainSpkHex: swap.spk, gbxVal8: swap.gbx_val, minVal8: Math.round(gbxAmount*1e8*0.99) });
  if(!v.ok) throw new Error('GBX HTLC invalid ('+v.reason+') -> NU revendic, refund USDC dupa T1');
  onStatus && onStatus('gbx_verified', { addr: v.addr });
  const txhex = hex(buildClaimTx({ prevTxid: swap.gbx_txid, vout: swap.gbx_vout, inValue8: swap.gbx_val, htlcScript: unhex(swap.script), outScriptPubKey: gbx.destSpk, outValue8: swap.gbx_val-fee8, nLockTime:0, preimage: s }, gbx.sign));
  const txid = await gbx.broadcast(txhex);
  onStatus && onStatus('gbx_claimed', { txid });
  try{ if(typeof localStorage!=='undefined') localStorage.removeItem('gbx_pending_'+Hhex); }catch(_e){}
  return { txid, hashlock: Hhex, secret: hex(s) };
}

// ===== SELL (GBX -> USDC), simetric cu buyGbx. USER lock GBX, LP lock USDC, USER claim USDC (reveal secret). =====
export function verifyUsdcLock({ ev, userEvmAddr, Hhex, usdcAddr, minAmount }){
  if(!ev) return {ok:false,reason:'no_lock'};
  if(ev.receiver.toLowerCase()!==userEvmAddr.toLowerCase()) return {ok:false,reason:'receiver_not_us'};
  if(ev.hashlock.toLowerCase()!==Hhex.toLowerCase()) return {ok:false,reason:'hashlock_mismatch'};
  if(ev.token.toLowerCase()!==usdcAddr.toLowerCase()) return {ok:false,reason:'token_mismatch'};
  if(BigInt(ev.amount) < BigInt(minAmount)) return {ok:false,reason:'amount_too_low'};
  return {ok:true, lockId:ev.id};
}
export async function sellGbx(ctx){
  const { gbxAmount, usdcAmount, lpGbxPub, userEvmAddr, usdcAddr, timelockT1Gbx, t2EvmSeconds, gbx, evm, submitIntent, onStatus, pollMs=1000, maxPolls=120 } = ctx;
  const s = ctx.secret || _randomSecret();
  const H = sha256(s), Hhex='0x'+hex(H), pkU=gbx.userPubkey;
  onStatus && onStatus('prepared', { hashlock: Hhex });
  const lock = await gbx.lockGbx({ H, lpGbxPub, pkU, T1: timelockT1Gbx, gbxAmount });
  onStatus && onStatus('gbx_locked', { gbx_txid: lock.gbx_txid });
  try{ if(typeof localStorage!=='undefined') localStorage.setItem('gbx_pending_'+Hhex, JSON.stringify({dir:'sell',chain:(typeof ctx!=='undefined'&&ctx&&ctx.chain)||'',owner:(userEvmAddr||'').toLowerCase(),hashlock:Hhex,secret:hex(s),userEvmAddr,usdcAmount:String(usdcAmount),gbx_txid:lock.gbx_txid,gbx_vout:lock.gbx_vout,ts:Date.now()})); }catch(_e){}
  await submitIntent({ hashlock: Hhex, direction:'sell', chain: (ctx.chain||''), refund_pubkey: hex(pkU), evm_receiver: userEvmAddr, usdc_amount: usdcAmount, gbx_txid: lock.gbx_txid, gbx_vout: lock.gbx_vout, gbx_script: lock.script, gbx_val: lock.gbx_val, t2_evm: t2EvmSeconds });
  let usdcLock=null;
  for(let i=0;i<maxPolls;i++){ usdcLock = await evm.findLock({ hashlock: Hhex, receiver: userEvmAddr }); if(usdcLock) break; await _sleep(pollMs); }
  if(!usdcLock) throw new Error('timeout: LP nu a blocat USDC -> refund GBX dupa T1');
  const v = verifyUsdcLock({ ev: usdcLock, userEvmAddr, Hhex, usdcAddr, minAmount: usdcAmount });
  if(!v.ok) throw new Error('USDC lock invalid ('+v.reason+') -> NU revendic, refund GBX dupa T1');
  onStatus && onStatus('usdc_verified', { lockId: v.lockId });
  const claimHash = await evm.claim({ id: v.lockId, preimage: '0x'+hex(s) });
  onStatus && onStatus('usdc_claimed', { hash: claimHash });
  try{ if(typeof localStorage!=='undefined') localStorage.removeItem('gbx_pending_'+Hhex); }catch(_e){}
  return { lockId: v.lockId, hashlock: Hhex, secret: hex(s) };
}

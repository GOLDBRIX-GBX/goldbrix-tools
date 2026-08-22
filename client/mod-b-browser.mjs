// GoldBrix Mod B — in-app browser adapter (BUY + SELL). DI: crypto/multichain/GoldbrixEVM from window.* (browser) or a shim (test).
import { buyGbx, sellGbx, verifyGbxLock } from './mod-b-swap.mjs';
import { signReceiveAuth } from "/sign3009.mjs";
import { secp256k1, keccak_256 } from '/vendor/evm-secp.mjs';
import { sha256, ripemd160 } from '/vendor/gbx-h160.mjs';
import { makeEVMHTLC } from './evm-htlc.mjs';
import { buildHtlcScript, p2wshSpk, p2wpkhAddress, p2wpkhSpkFromPub, buildFundTx, hex, buildClaimTx, buildRefundTx, unhex } from './gbx-htlc.mjs';

/* GBX:H lock anchor - a second, zero-value OP_RETURN output in every fund tx:
   'GBX:H:' + ver(1) + hashlock(32) + refund_pk(33) = 72 bytes. With it, any
   lock is findable from the chain alone, forever - no server, no local
   memory. The index trusts nothing: it only records outpoints of the same
   transaction, and the client proves the script before acting. */
function gbxHAnchorSpk(Hhex, pkU){
  /* H arrives as raw bytes on the sell path and as a hex string on the buy
     path; both are welcome, neither is guessed. */
  const hl=(Hhex instanceof Uint8Array)?Hhex:unhex(String(Hhex).replace(/^0x/,''));
  if(hl.length!==32) throw new Error('ANCHOR_BAD_HASHLOCK');
  const d=new Uint8Array(72);
  d.set([0x47,0x42,0x58,0x3a,0x48,0x3a],0); d[6]=1; d.set(hl,7); d.set(pkU,39);
  const spk=new Uint8Array(74); spk[0]=0x6a; spk[1]=72; spk.set(d,2);
  return spk;
}
function p2wpkhSpk2(pub){ const h=ripemd160(sha256(pub)); const o=new Uint8Array(22); o[0]=0; o[1]=0x14; o.set(h,2); return o; }
const LOCKED_SIG='Locked(bytes32,address,address,address,uint256,bytes32,uint256)';
async function crypto_subtle_sha256(preHex){
  const h=String(preHex||'').replace(/^0x/,'');
  const b=new Uint8Array(h.length/2); for(let i=0;i<b.length;i++) b[i]=parseInt(h.substr(i*2,2),16);
  return await globalThis.crypto.subtle.digest('SHA-256', b);
}
export function makeInAppClient({ crypto, multichain, GoldbrixEVM, gatewayBase, evmRpc, rpcList, chainId, chainName, htlcAddr, usdcAddr, lpEvmAddr, fetchUtxos, t1Blocks }){
  /* AUTONOMOUS FALLBACK, PER CHAIN: several endpoints, because each is good at
     something different (one serves eth_call reliably, another archive getLogs).
     The fallbacks must belong to the SAME chain: a signed transaction sent to a
     different network is rejected ("tx for different chain"), which silently broke
     every chain except the one whose endpoints were listed here. Callers may pass
     rpcList to add their own; nothing is chain-crossed. */
  const _CHAIN_RPCS={
    8453:['https://mainnet.base.org','https://base-rpc.publicnode.com','https://base-mainnet.public.blastapi.io','https://base.drpc.org'],
    42161:['https://arb1.arbitrum.io/rpc','https://arbitrum-one-rpc.publicnode.com','https://arbitrum.drpc.org']
  };
  const RPC_LIST=[evmRpc].concat(rpcList||[]).concat(_CHAIN_RPCS[Number(chainId)]||[]).filter((v,i,a)=>v&&a.indexOf(v)===i);
  const rpc=async(method,params)=>{
    let lastErr=null;
    for(const url of RPC_LIST){
      try{
        const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
        const j=await r.json();
        if(j.error){ lastErr=new Error(j.error.message||JSON.stringify(j.error)); continue; }
        return j.result;
      }catch(e){ lastErr=e; continue; }
    }
    throw new Error('all '+RPC_LIST.length+' RPC endpoints failed for '+method+' on chain '+chainId+((lastErr&&lastErr.message)?(': '+lastErr.message):''));
  };
  const htlc=makeEVMHTLC({ rpc, evm:GoldbrixEVM, chainId });
  const post=async(p,b)=>{ const r=await fetch(gatewayBase+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}); return r.json(); };
  // Broadcast fallback: the LP is only the first attempt; on failure the tx goes out
  // to EVERY public node from discovery (/api/broadcast = keyless sendrawtransaction).
  // The write survives even if the LP (or any single operator's servers) is dead.
  // txid = dsha256 over the serialization WITHOUT witness (BIP144). Segwit: marker 0x00 flag 0x01
  // after the version; the witness is skipped after the outputs. Structural parsing, zero guessing.
  const _txidOf=(rawtxHex)=>{
    const b=unhex(rawtxHex); let o=4; const parts=[b.slice(0,4)];
    const segwit = b[4]===0x00 && b[5]===0x01;
    if(segwit) o=6;
    const vi=()=>{ const f=b[o];
      if(f<0xfd){o+=1; return f;}
      if(f===0xfd){const v=b[o+1]|(b[o+2]<<8); o+=3; return v;}
      if(f===0xfe){const v=b[o+1]|(b[o+2]<<8)|(b[o+3]<<16)|(b[o+4]*16777216); o+=5; return v;}
      let v=0; for(let i=7;i>=0;i--) v=v*256+b[o+1+i]; o+=9; return v; };
    const start=o;
    const nIn=vi();
    for(let i=0;i<nIn;i++){ o+=36; const sl=vi(); o+=sl; o+=4; }
    const nOut=vi();
    for(let i=0;i<nOut;i++){ o+=8; const sl=vi(); o+=sl; }
    parts.push(b.slice(start,o));
    if(segwit){ for(let i=0;i<nIn;i++){ const items=vi(); for(let k=0;k<items;k++){ const l=vi(); o+=l; } } }
    parts.push(b.slice(o,o+4)); // nLockTime
    let tot=0; parts.forEach(x=>tot+=x.length);
    const flat=new Uint8Array(tot); let q=0; parts.forEach(x=>{flat.set(x,q); q+=x.length;});
    const h=sha256(sha256(flat)); return hex(h.slice().reverse());
  };
  const _mk=(tx)=>{try{if(typeof window!=='undefined'&&window.GoldbrixCrypto&&window.GoldbrixCrypto.spent)window.GoldbrixCrypto.spent.mark(tx);}catch(_e){}};
  const gbxBroadcast=async(tx)=>{
    let firstErr=null;
    try{ const j=await post('/broadcast',{rawtx:tx}); if(j&&j.txid){ _mk(tx); return j.txid; } firstErr=new Error('lp: '+JSON.stringify(j)); }
    catch(e){ firstErr=e; }
    /* No fixed fallback host: without a federated node list the honest
       answer is the first error, not a guess at a hostname. */
    const nodes=(typeof window!=='undefined' && window.GBX_NODES) ? window.GBX_NODES.slice() : [];
    for(const base of nodes){
      try{
        const c=new AbortController(); const t=setTimeout(()=>c.abort(),8000);
        const r=await fetch(base.replace(/\/+$/,'')+'/broadcast',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({rawtx:tx}),signal:c.signal});
        clearTimeout(t);
        const j=await r.json();
        if(j&&j.txid){ _mk(tx); return j.txid; }
        // already in the mempool/chain (response lost on a previous attempt) = SUCCESS:
        // the txid is computed locally from the rawtx (dsha256, little-endian), never guessed.
        if(j&&j.error&&/already in block chain|txn-already|already known|already-in-mempool/i.test(JSON.stringify(j.error))) { _mk(tx); return _txidOf(tx); }
      }catch(_e){}
    }
    throw firstErr||new Error('broadcast: all endpoints failed');
  };
  const submitIntent=async(o)=>{ const j=await post('/intent',o); if(!j.ok) throw new Error('intent: '+JSON.stringify(j)); };
  async function buyGbxInApp({ mnemonic, usdcAmount, onStatus }){
    const gk=await crypto.deriveKeypairFromMnemonic(mnemonic), ek=await multichain.deriveEVM(mnemonic);
    const skU=Uint8Array.from(gk.privateKey), pkU=Uint8Array.from(gk.publicKey);
    const q=await (await fetch(gatewayBase+'/quote?usd='+(Number(usdcAmount)/1e6))).json();
    const gbx={ userPubkey:pkU, destSpk:p2wpkhSpk2(pkU), sign:(d)=>secp256k1.sign(d,skU).toDERRawBytes(), broadcast:gbxBroadcast,
      fetchSwap:async(Hhex)=>{ const sw=await (await fetch(gatewayBase+'/swap/'+Hhex.toLowerCase())).json(); if(!sw||sw.status!=='gbx_locked'||!sw.spk) return null; return {script:sw.script,spk:sw.spk,gbx_txid:sw.gbx_txid,gbx_vout:sw.gbx_vout,gbx_val:sw.gbx_val}; } };
    const evm={ approve:async(a)=>{ await htlc.approve(ek.privateKey,usdcAddr,htlcAddr,BigInt(a)); }, lock:async({receiver,amount,hashlock,timelock})=>{ const r=await htlc.lock(ek.privateKey,htlcAddr,receiver,usdcAddr,BigInt(amount),hashlock,BigInt(timelock)); const lg=((r.receipt&&r.receipt.logs)||[]).find(l=>l.address&&l.address.toLowerCase()===htlcAddr.toLowerCase()); return (lg&&lg.topics&&lg.topics[1])||r.hash; } };
    const gasless = {
      htlcAddr, usdcAddr, userAddr: ek.address,
      sign3009: async ({ value, toHtlc }) => await signReceiveAuth({
        rpc, usdcAddr, fromAddr: ek.address, toHtlc, value: String(value),
        validBefore: Math.floor(Date.now()/1000)+3600, privHex: ek.privateKey })
    };
    const _chain = chainName || (chainId===42161?'arbitrum':chainId===8453?'base':'base');
    return await buyGbx({ amountUsdc:String(usdcAmount), gbxAmount:Number(q.gbx_out), lpEvmAddr, timelockT1:t1Blocks||(Math.floor(Date.now()/1000)+7200), evm, gbx, submitIntent, onStatus, pollMs:1000, maxPolls:40, fee8:10000, gasless, chain:_chain });
  }
  async function sellGbxInApp({ mnemonic, gbxAmount, usdcAmount, onStatus }){
    const _chain = chainName || (chainId===42161?'arbitrum':chainId===8453?'base':'base');
    const gk=await crypto.deriveKeypairFromMnemonic(mnemonic), ek=await multichain.deriveEVM(mnemonic);
    const skU=Uint8Array.from(gk.privateKey), pkU=Uint8Array.from(gk.publicKey);
    const userGbxAddr=p2wpkhAddress(pkU);
    const info=await (await fetch(gatewayBase+'/lp-info')).json();
    const lpGbxPub=Uint8Array.from(info.lp_gbx_pubkey.match(/.{2}/g).map(h=>parseInt(h,16)));
    const t0='0x'+hex(keccak_256(new TextEncoder().encode(LOCKED_SIG)));
    const gbx={ userPubkey:pkU,
      lockGbx:async({H,T1,gbxAmount})=>{
        const utxos=(await fetchUtxos(userGbxAddr, gbxAmount+0.001)).filter(u=>u.spendable!==false).map(u=>({...u, value8: Math.round(u.amount*1e8)}));
        if(!utxos.length) throw new Error('NO_UTXO');
        const script=buildHtlcScript(H, lpGbxPub, pkU, T1), htlcSpk=p2wshSpk(script);
        const fundValue=Math.round(gbxAmount*1e8), fee=2000;
        let ins=[],sum=0; for(const u of utxos){ ins.push(u); sum+=u.value8; if(sum>=fundValue+fee) break; }
        const change=sum-fundValue-fee, outs=[{spk:htlcSpk,value8:fundValue}];
        outs.push({spk:gbxHAnchorSpk(H,pkU),value8:0});
        if(change>546) outs.push({spk:p2wpkhSpkFromPub(pkU),value8:change});
        const tx=buildFundTx({utxos:ins,userPubkey:pkU,outputs:outs,nLockTime:0},(d)=>secp256k1.sign(d,skU).toDERRawBytes());
        return { gbx_txid:await gbxBroadcast(hex(tx)), gbx_vout:0, script:hex(script), gbx_val:fundValue };
      } };
    const evm={
      findLock:async({hashlock,receiver})=>{ const rcv='0x'+receiver.replace(/^0x/,'').toLowerCase().padStart(64,'0'); const latestHex=await rpc('eth_blockNumber',[]); const latest=parseInt(latestHex,16); const WIN=9000; const SCAN_BACK=200000; for(let hi=latest; hi>Math.max(0,latest-SCAN_BACK); hi-=WIN){ const lo=Math.max(0,hi-WIN+1); let logs; try{ logs=await rpc('eth_getLogs',[{address:htlcAddr,fromBlock:'0x'+lo.toString(16),toBlock:'0x'+hi.toString(16),topics:[t0,null,null,rcv]}]); }catch(_e){ continue; } for(const l of logs){ const d=l.data.replace(/^0x/,''); const sl=i=>'0x'+d.slice(i*64,(i+1)*64); if(sl(2).toLowerCase()===hashlock.toLowerCase()) return {id:l.topics[1],receiver,token:'0x'+sl(0).slice(-40),amount:BigInt(sl(1)).toString(),hashlock:sl(2)}; } } return null; },
      /* Settling a sale must not require holding the chain's gas token: ask the LP to
         relay the claim (it only ever releases the locked USDC to the receiver named in
         the lock, which is us). Signing it ourselves stays the fallback. */
      claim:async({id,preimage,hashlock})=>{
        try{
          const _hl=hashlock||('0x'+Array.from(new Uint8Array(await crypto_subtle_sha256(preimage))).map(b=>b.toString(16).padStart(2,'0')).join(''));
          const _rr=await (await fetch(gatewayBase+'/evm-relay-claim',{method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({hashlock:String(_hl).toLowerCase(),preimage:preimage})})).json();
          if(_rr&&_rr.hash) return _rr.hash;
        }catch(_e){}
        const r=await htlc.claim(ek.privateKey,htlcAddr,id,preimage); return r.hash; } };
    let _h=0; try{ _h=(await (await fetch(gatewayBase+'/height')).json()).height||0; }catch(_e){}
    const _T1 = _h>0 ? _h+28800 : 9999999;
    return await sellGbx({ gbxAmount, usdcAmount:String(usdcAmount), lpGbxPub, userEvmAddr:ek.address, usdcAddr, timelockT1Gbx:_T1, t2EvmSeconds:3600, gbx, evm, submitIntent, onStatus, pollMs:1000, maxPolls:60, chain:_chain });
  }
  async function refundUsdc({ mnemonic, lockId }){
    const ek=await multichain.deriveEVM(mnemonic);
    const r=await htlc.refund(ek.privateKey, htlcAddr, lockId);
    return (r&&r.hash)||r;
  }
  async function claimUsdcForSell({ mnemonic, hashlock, secret, userEvmAddr }){
    const ek=await multichain.deriveEVM(mnemonic);
    /* Getting paid must not depend on holding the chain's gas token. Ask the LP to relay
       the claim first (it already does this on Solana): revealing the preimage can only
       release the locked USDC to the receiver written into the lock, which is us.
       If no LP relays, fall back to signing and paying for it ourselves. */
    try{
      const _rr=await (await fetch(gatewayBase+'/evm-relay-claim',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({hashlock:String(hashlock).toLowerCase(),preimage:'0x'+secret})})).json();
      if(_rr&&_rr.hash) return { hash:_rr.hash, relayed:true };
    }catch(_e){}
    /* The LP that locked the USDC knows the lock id: one request instead of scanning
       200k blocks on a public RPC, which fails on busy chains. The scan stays as fallback. */
    try{
      const _sw=await (await fetch(gatewayBase+'/swap/'+String(hashlock).toLowerCase(),{cache:'no-store'})).json();
      const _id=_sw&&_sw.usdc_lock_id;
      if(_id){ const _r=await htlc.claim(ek.privateKey, htlcAddr, (String(_id).startsWith('0x')?_id:'0x'+_id), '0x'+secret);
               return { hash:(_r&&_r.hash)||_r, lockId:_id }; }
    }catch(_e){}
    const t0='0x'+hex(keccak_256(new TextEncoder().encode(LOCKED_SIG)));
    const rcv='0x'+userEvmAddr.replace(/^0x/,'').toLowerCase().padStart(64,'0');
    const latest=parseInt(await rpc('eth_blockNumber',[]),16);
    let lockId=null;
    for(let hi=latest; hi>Math.max(0,latest-200000) && !lockId; hi-=9000){
      const lo=Math.max(0,hi-8999);
      let logs; try{ logs=await rpc('eth_getLogs',[{address:htlcAddr,fromBlock:'0x'+lo.toString(16),toBlock:'0x'+hi.toString(16),topics:[t0,null,null,rcv]}]); }catch(_e){ continue; }
      for(const l of logs){ const d=l.data.replace(/^0x/,''); const sl=i=>'0x'+d.slice(i*64,(i+1)*64); if(sl(2).toLowerCase()===hashlock.toLowerCase()){ lockId=l.topics[1]; break; } }
    }
    if(!lockId) throw new Error('USDC lock not found (LP may not have locked yet)');
    const r=await htlc.claim(ek.privateKey, htlcAddr, lockId, '0x'+secret);
    return { hash:(r&&r.hash)||r, lockId };
  }
  async function lockGbxForSell({ mnemonic, gbxAmount, H }){
    // lock GBX on L1 for the sell (identical to the sellGbxInApp path, without the EVM part)
    const gk=await crypto.deriveKeypairFromMnemonic(mnemonic);
    const skU=Uint8Array.from(gk.privateKey), pkU=Uint8Array.from(gk.publicKey);
    const userGbxAddr=p2wpkhAddress(pkU);
    const info=await (await fetch(gatewayBase+'/lp-info')).json();
    const lpGbxPub=Uint8Array.from(info.lp_gbx_pubkey.match(/.{2}/g).map(h=>parseInt(h,16)));
    let _h=0; try{ _h=(await (await fetch(gatewayBase+'/height')).json()).height||0; }catch(_e){}
    const T1=_h>0?_h+28800:9999999;
    const utxos=(await fetchUtxos(userGbxAddr, gbxAmount+0.001)).filter(u=>u.spendable!==false).map(u=>({...u, value8: Math.round(u.amount*1e8)}));
    if(!utxos.length) throw new Error('NO_UTXO');
    const script=buildHtlcScript(H, lpGbxPub, pkU, T1), htlcSpk=p2wshSpk(script);
    const fundValue=Math.round(gbxAmount*1e8), fee=2000;
    let ins=[],sum=0; for(const u of utxos){ ins.push(u); sum+=u.value8; if(sum>=fundValue+fee) break; }
    const change=sum-fundValue-fee, outs=[{spk:htlcSpk,value8:fundValue}];
    outs.push({spk:gbxHAnchorSpk(H,pkU),value8:0});
    if(change>546) outs.push({spk:p2wpkhSpkFromPub(pkU),value8:change});
    const tx=buildFundTx({utxos:ins,userPubkey:pkU,outputs:outs,nLockTime:0},(d)=>secp256k1.sign(d,skU).toDERRawBytes());
    return { gbx_txid:await gbxBroadcast(hex(tx)), gbx_vout:0, script:hex(script), gbx_val:fundValue, refund_pubkey:hex(pkU), t1:T1 };
  }
  async function refundGbxForSell({ mnemonic, gbxTxid, gbxVout, gbxVal8, scriptHex, t1 }){
    // L1 refund on the timelock branch (after T1): the user takes their GBX back from the HTLC of an abandoned/rejected sell
    const gk=await crypto.deriveKeypairFromMnemonic(mnemonic);
    const skU=Uint8Array.from(gk.privateKey), pkU=Uint8Array.from(gk.publicKey);
    let sc = scriptHex ? unhex(String(scriptHex).replace(/^0x/,'')) : null;
    let T1 = Number(t1||0);
    // script present but t1 missing (pending completed from the LP) -> T1 is IN the script, structural parse (fixed HTLC layout)
    if(sc && !T1 && sc.length>75 && sc[0]===0x63 && sc[71]===0x67){
      const n=sc[72];
      if(n>=1 && n<=5){ let v=0; for(let j=0;j<n;j++) v+=sc[73+j]*Math.pow(256,j); T1=v; }
    }
    if(!sc || !T1){
      // DETERMINISTIC RECONSTRUCTION (old pendings without script/t1):
      // H from arguments.hashlock, lpGbxPub from /lp-info, T1 iterated over [h_fund+28800±30] and legacy [h_fund+100000±30]
      // until sha256(buildHtlcScript(H,lpGbxPub,pkU,T1)) == the REAL witness program of the UTXO. Zero guessing.
      const hl=(arguments[0]&&arguments[0].hashlock)||'';
      if(!hl) throw new Error('REFUND_NEEDS_SCRIPT');
      const H=unhex(String(hl).replace(/^0x/,''));
      if(H.length!==32) throw new Error('REFUND_NEEDS_SCRIPT');
      const us=await (await fetch(gatewayBase+'/utxo-status?txid='+gbxTxid+'&vout='+Number(gbxVout))).json();
      if(us.spent!==false || !us.spk || !us.confirmations) throw new Error('REFUND_UTXO_GONE');
      const wantSpk=String(us.spk).toLowerCase();
      if(!wantSpk.startsWith('0020')) throw new Error('REFUND_NEEDS_SCRIPT');
      const hNow=(await (await fetch(gatewayBase+'/height')).json()).height||0;
      if(!hNow) throw new Error('REFUND_NEEDS_SCRIPT');
      const hFund=hNow-Number(us.confirmations)+1;
      const lpPubs=[];
      try{ const li=await (await fetch(gatewayBase+'/lp-info')).json(); const p1=unhex(String(li.lp_gbx_pubkey||'').replace(/^0x/,'')); if(p1.length===33) lpPubs.push(p1); }catch(_e){}
      // The lock may have been made by any federated LP, not the current gateway: try them all.
      try{ const lps=await window.GBXLp.list(); for(const lp of (lps||[])){ try{ const li2=await (await fetch(String(lp.base_url).replace(/\/$/,'')+'/lp-info',{cache:'no-store'})).json(); const p2=unhex(String(li2.lp_gbx_pubkey||'').replace(/^0x/,'')); if(p2.length===33 && !lpPubs.some(x=>hex(x)===hex(p2))) lpPubs.push(p2); }catch(_e){} } }catch(_e){}
      if(!lpPubs.length) throw new Error('REFUND_NEEDS_SCRIPT');
      for(const lpPub of lpPubs){
        for(const base of [28800,100000]) for(let t=hFund+base-30; t<=hFund+base+30 && !sc; t++){
          const cand=buildHtlcScript(H, lpPub, pkU, t);
          if(hex(p2wshSpk(cand)).toLowerCase()===wantSpk){ sc=cand; T1=t; }
        }
        if(sc) break;
      }
      if(!sc) throw new Error('REFUND_NEEDS_SCRIPT');
      if(!gbxVal8) gbxVal8=us.value_sat;
    }
    // guard: T1 must have passed (nLockTime by height)
    let _h=0; try{ _h=(await (await fetch(gatewayBase+'/height')).json()).height||0; }catch(_e){}
    if(_h>0 && _h<T1) throw new Error('REFUND_NOT_YET:'+(T1-_h));
    const fee=10000, outV=Number(gbxVal8)-fee;
    if(!(outV>546)) throw new Error('REFUND_DUST');
    const txhex=hex(buildRefundTx({ prevTxid:gbxTxid, vout:Number(gbxVout), inValue8:Number(gbxVal8), htlcScript:sc, outScriptPubKey:p2wpkhSpk2(pkU), outValue8:outV, T2:T1 }, (d)=>secp256k1.sign(d,skU).toDERRawBytes()));
    const txid=await gbxBroadcast(txhex);
    return { txid, gbx: outV/1e8 };
  }
  async function claimGbxForBuy({ mnemonic, hashlock, secret, minGbx8, onStatus, pollMs=1500, maxPolls=120 }){
    // Claim GBX on L1 after the USDC lock (used by BUY Solana; same mechanism as buyGbx post-lock)
    const gk=await crypto.deriveKeypairFromMnemonic(mnemonic);
    const skU=Uint8Array.from(gk.privateKey), pkU=Uint8Array.from(gk.publicKey);
    const Hhex=hashlock.toLowerCase(); const H=unhex(Hhex.replace(/^0x/,'')); const s=unhex(String(secret).replace(/^0x/,''));
    let swap=null;
    for(let i=0;i<maxPolls;i++){
      try{ const sw=await (await fetch(gatewayBase+'/swap/'+Hhex)).json();
        if(sw && sw.spk && sw.script){ swap={script:sw.script,spk:sw.spk,gbx_txid:sw.gbx_txid,gbx_vout:sw.gbx_vout,gbx_val:sw.gbx_val}; break; } }catch(_e){}
      await new Promise(r=>setTimeout(r,pollMs));
    }
    if(!swap) throw new Error('timeout: LP did not lock GBX -> USDC auto-refunds after T2 (funds are safe)');
    const v=verifyGbxLock({ H, pkU, scriptHex:swap.script, onchainSpkHex:swap.spk, gbxVal8:swap.gbx_val, minVal8:minGbx8||1 });
    if(!v.ok) throw new Error('GBX HTLC invalid ('+v.reason+') -> not claiming');
    onStatus&&onStatus('gbx_verified',{});
    const txhex=hex(buildClaimTx({ prevTxid:swap.gbx_txid, vout:swap.gbx_vout, inValue8:swap.gbx_val, htlcScript:unhex(swap.script), outScriptPubKey:p2wpkhSpk2(pkU), outValue8:swap.gbx_val-10000, nLockTime:0, preimage:s }, (d)=>secp256k1.sign(d,skU).toDERRawBytes()));
    const txid=await gbxBroadcast(txhex);
    onStatus&&onStatus('gbx_claimed',{txid});
    return { txid };
  }
  return { buyGbxInApp, sellGbxInApp, refundUsdc, claimUsdcForSell, lockGbxForSell, claimGbxForBuy, refundGbxForSell };
}
if(typeof window!=='undefined') window.GoldbrixModB={ makeInAppClient };

// GoldBrix Mod B — adaptor browser in-app (BUY + SELL). DI: crypto/multichain/GoldbrixEVM din window.* (browser) sau shim (test).
import { buyGbx, sellGbx, verifyGbxLock } from './mod-b-swap.mjs';
import { signReceiveAuth } from "/sign3009.mjs";
import { secp256k1, keccak_256 } from '/vendor/evm-secp.mjs';
import { sha256, ripemd160 } from '/vendor/gbx-h160.mjs';
import { makeEVMHTLC } from './evm-htlc.mjs';
import { buildHtlcScript, p2wshSpk, p2wpkhAddress, p2wpkhSpkFromPub, buildFundTx, hex, buildClaimTx, buildRefundTx, unhex } from './gbx-htlc.mjs';
function p2wpkhSpk2(pub){ const h=ripemd160(sha256(pub)); const o=new Uint8Array(22); o[0]=0; o[1]=0x14; o.set(h,2); return o; }
const LOCKED_SIG='Locked(bytes32,address,address,address,uint256,bytes32,uint256)';
export function makeInAppClient({ crypto, multichain, GoldbrixEVM, gatewayBase, evmRpc, chainId, chainName, htlcAddr, usdcAddr, lpEvmAddr, fetchUtxos, t1Blocks }){
  // FALLBACK AUTONOM: incearca mai multe RPC-uri; fiecare e bun la altceva
  // (publicnode: eth_call OK, getLogs archive NU | mainnet.base.org: getLogs OK, eth_call intermitent)
  const RPC_LIST=[evmRpc,'https://mainnet.base.org','https://base-rpc.publicnode.com','https://base-mainnet.public.blastapi.io','https://1rpc.io/base'].filter((v,i,a)=>v&&a.indexOf(v)===i);
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
    throw lastErr||new Error('all RPC failed for '+method);
  };
  const htlc=makeEVMHTLC({ rpc, evm:GoldbrixEVM, chainId });
  const post=async(p,b)=>{ const r=await fetch(gatewayBase+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}); return r.json(); };
  // IDEE S: broadcast-fallback. LP-ul e doar prima incercare; la esec, tx-ul pleaca
  // spre TOATE nodurile publice din discovery (/api/broadcast = keyless sendrawtransaction).
  // Scrierea supravietuieste chiar daca LP-ul (sau serverele fondatorului) sunt moarte.
  // txid = dsha256 pe serializarea FARA witness (BIP144). Segwit: marker 0x00 flag 0x01
  // dupa version; witness-ul se sare dupa outputs. Parsare structurala, zero ghicit.
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
  const gbxBroadcast=async(tx)=>{
    let firstErr=null;
    try{ const j=await post('/broadcast',{rawtx:tx}); if(j&&j.txid) return j.txid; firstErr=new Error('lp: '+JSON.stringify(j)); }
    catch(e){ firstErr=e; }
    const nodes=(typeof window!=='undefined' && window.GBX_NODES) ? window.GBX_NODES.slice() : ['https://goldbrix.app/api'];
    for(const base of nodes){
      try{
        const c=new AbortController(); const t=setTimeout(()=>c.abort(),8000);
        const r=await fetch(base.replace(/\/+$/,'')+'/broadcast',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({rawtx:tx}),signal:c.signal});
        clearTimeout(t);
        const j=await r.json();
        if(j&&j.txid) return j.txid;
        // deja in mempool/lant (raspuns pierdut la o incercare anterioara) = SUCCES:
        // txid-ul se calculeaza local din rawtx (dsha256, little-endian), nu se ghiceste.
        if(j&&j.error&&/already in block chain|txn-already|already known|already-in-mempool/i.test(JSON.stringify(j.error))) return _txidOf(tx);
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
        if(change>546) outs.push({spk:p2wpkhSpkFromPub(pkU),value8:change});
        const tx=buildFundTx({utxos:ins,userPubkey:pkU,outputs:outs,nLockTime:0},(d)=>secp256k1.sign(d,skU).toDERRawBytes());
        return { gbx_txid:await gbxBroadcast(hex(tx)), gbx_vout:0, script:hex(script), gbx_val:fundValue };
      } };
    const evm={
      findLock:async({hashlock,receiver})=>{ const rcv='0x'+receiver.replace(/^0x/,'').toLowerCase().padStart(64,'0'); const latestHex=await rpc('eth_blockNumber',[]); const latest=parseInt(latestHex,16); const WIN=9000; const SCAN_BACK=200000; for(let hi=latest; hi>Math.max(0,latest-SCAN_BACK); hi-=WIN){ const lo=Math.max(0,hi-WIN+1); let logs; try{ logs=await rpc('eth_getLogs',[{address:htlcAddr,fromBlock:'0x'+lo.toString(16),toBlock:'0x'+hi.toString(16),topics:[t0,null,null,rcv]}]); }catch(_e){ continue; } for(const l of logs){ const d=l.data.replace(/^0x/,''); const sl=i=>'0x'+d.slice(i*64,(i+1)*64); if(sl(2).toLowerCase()===hashlock.toLowerCase()) return {id:l.topics[1],receiver,token:'0x'+sl(0).slice(-40),amount:BigInt(sl(1)).toString(),hashlock:sl(2)}; } } return null; },
      claim:async({id,preimage})=>{ const r=await htlc.claim(ek.privateKey,htlcAddr,id,preimage); return r.hash; } };
    let _h=0; try{ _h=(await (await fetch(gatewayBase+'/height')).json()).height||0; }catch(_e){}
    const _T1 = _h>0 ? _h+100000 : 9999999;
    return await sellGbx({ gbxAmount, usdcAmount:String(usdcAmount), lpGbxPub, userEvmAddr:ek.address, usdcAddr, timelockT1Gbx:_T1, t2EvmSeconds:3600, gbx, evm, submitIntent, onStatus, pollMs:1000, maxPolls:60, chain:_chain });
  }
  async function refundUsdc({ mnemonic, lockId }){
    const ek=await multichain.deriveEVM(mnemonic);
    const r=await htlc.refund(ek.privateKey, htlcAddr, lockId);
    return (r&&r.hash)||r;
  }
  async function claimUsdcForSell({ mnemonic, hashlock, secret, userEvmAddr }){
    const ek=await multichain.deriveEVM(mnemonic);
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
    // lock GBX L1 pentru sell (identic cu calea din sellGbxInApp, fara partea EVM)
    const gk=await crypto.deriveKeypairFromMnemonic(mnemonic);
    const skU=Uint8Array.from(gk.privateKey), pkU=Uint8Array.from(gk.publicKey);
    const userGbxAddr=p2wpkhAddress(pkU);
    const info=await (await fetch(gatewayBase+'/lp-info')).json();
    const lpGbxPub=Uint8Array.from(info.lp_gbx_pubkey.match(/.{2}/g).map(h=>parseInt(h,16)));
    let _h=0; try{ _h=(await (await fetch(gatewayBase+'/height')).json()).height||0; }catch(_e){}
    const T1=_h>0?_h+100000:9999999;
    const utxos=(await fetchUtxos(userGbxAddr, gbxAmount+0.001)).filter(u=>u.spendable!==false).map(u=>({...u, value8: Math.round(u.amount*1e8)}));
    if(!utxos.length) throw new Error('NO_UTXO');
    const script=buildHtlcScript(H, lpGbxPub, pkU, T1), htlcSpk=p2wshSpk(script);
    const fundValue=Math.round(gbxAmount*1e8), fee=2000;
    let ins=[],sum=0; for(const u of utxos){ ins.push(u); sum+=u.value8; if(sum>=fundValue+fee) break; }
    const change=sum-fundValue-fee, outs=[{spk:htlcSpk,value8:fundValue}];
    if(change>546) outs.push({spk:p2wpkhSpkFromPub(pkU),value8:change});
    const tx=buildFundTx({utxos:ins,userPubkey:pkU,outputs:outs,nLockTime:0},(d)=>secp256k1.sign(d,skU).toDERRawBytes());
    return { gbx_txid:await gbxBroadcast(hex(tx)), gbx_vout:0, script:hex(script), gbx_val:fundValue, refund_pubkey:hex(pkU), t1:T1 };
  }
  async function refundGbxForSell({ mnemonic, gbxTxid, gbxVout, gbxVal8, scriptHex, t1 }){
    // Refund L1 pe ramura timelock (dupa T1): userul isi ia GBX-ul inapoi din HTLC-ul de sell abandonat/respins
    const gk=await crypto.deriveKeypairFromMnemonic(mnemonic);
    const skU=Uint8Array.from(gk.privateKey), pkU=Uint8Array.from(gk.publicKey);
    let sc = scriptHex ? unhex(String(scriptHex).replace(/^0x/,'')) : null;
    let T1 = Number(t1||0);
    // s35: script prezent dar t1 lipsa (pending completat de la LP) -> T1 e IN script, parse structural (layout fix HTLC)
    if(sc && !T1 && sc.length>75 && sc[0]===0x63 && sc[71]===0x67){
      const n=sc[72];
      if(n>=1 && n<=5){ let v=0; for(let j=0;j<n;j++) v+=sc[73+j]*Math.pow(256,j); T1=v; }
    }
    if(!sc || !T1){
      // RECONSTRUCTIE DETERMINISTA (pendinguri vechi fara script/t1):
      // H din arguments.hashlock, lpGbxPub din /lp-info, T1 iterat in [h_fund+100000±30]
      // pana sha256(buildHtlcScript(H,lpGbxPub,pkU,T1)) == witness program-ul REAL al UTXO-ului. Zero ghicit.
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
      const li=await (await fetch(gatewayBase+'/lp-info')).json();
      const lpPub=unhex(String(li.lp_gbx_pubkey||'').replace(/^0x/,''));
      if(lpPub.length!==33) throw new Error('REFUND_NEEDS_SCRIPT');
      for(let t=hFund+100000-30; t<=hFund+100000+30 && !sc; t++){
        const cand=buildHtlcScript(H, lpPub, pkU, t);
        if(hex(p2wshSpk(cand)).toLowerCase()===wantSpk){ sc=cand; T1=t; }
      }
      if(!sc) throw new Error('REFUND_NEEDS_SCRIPT');
      if(!gbxVal8) gbxVal8=us.value_sat;
    }
    // gard: T1 trebuie sa fi trecut (nLockTime pe height)
    let _h=0; try{ _h=(await (await fetch(gatewayBase+'/height')).json()).height||0; }catch(_e){}
    if(_h>0 && _h<T1) throw new Error('REFUND_NOT_YET:'+(T1-_h));
    const fee=10000, outV=Number(gbxVal8)-fee;
    if(!(outV>546)) throw new Error('REFUND_DUST');
    const txhex=hex(buildRefundTx({ prevTxid:gbxTxid, vout:Number(gbxVout), inValue8:Number(gbxVal8), htlcScript:sc, outScriptPubKey:p2wpkhSpk2(pkU), outValue8:outV, T2:T1 }, (d)=>secp256k1.sign(d,skU).toDERRawBytes()));
    const txid=await gbxBroadcast(txhex);
    return { txid, gbx: outV/1e8 };
  }
  async function claimGbxForBuy({ mnemonic, hashlock, secret, minGbx8, onStatus, pollMs=1500, maxPolls=120 }){
    // Claim GBX L1 dupa lock USDC (folosit de BUY Solana; mecanism identic buyGbx post-lock)
    const gk=await crypto.deriveKeypairFromMnemonic(mnemonic);
    const skU=Uint8Array.from(gk.privateKey), pkU=Uint8Array.from(gk.publicKey);
    const Hhex=hashlock.toLowerCase(); const H=unhex(Hhex.replace(/^0x/,'')); const s=unhex(String(secret).replace(/^0x/,''));
    let swap=null;
    for(let i=0;i<maxPolls;i++){
      try{ const sw=await (await fetch(gatewayBase+'/swap/'+Hhex)).json();
        if(sw && sw.spk && sw.script){ swap={script:sw.script,spk:sw.spk,gbx_txid:sw.gbx_txid,gbx_vout:sw.gbx_vout,gbx_val:sw.gbx_val}; break; } }catch(_e){}
      await new Promise(r=>setTimeout(r,pollMs));
    }
    if(!swap) throw new Error('timeout: LP nu a blocat GBX -> USDC auto-refund dupa T2 (banii sunt in siguranta)');
    const v=verifyGbxLock({ H, pkU, scriptHex:swap.script, onchainSpkHex:swap.spk, gbxVal8:swap.gbx_val, minVal8:minGbx8||1 });
    if(!v.ok) throw new Error('GBX HTLC invalid ('+v.reason+') -> NU revendic');
    onStatus&&onStatus('gbx_verified',{});
    const txhex=hex(buildClaimTx({ prevTxid:swap.gbx_txid, vout:swap.gbx_vout, inValue8:swap.gbx_val, htlcScript:unhex(swap.script), outScriptPubKey:p2wpkhSpk2(pkU), outValue8:swap.gbx_val-10000, nLockTime:0, preimage:s }, (d)=>secp256k1.sign(d,skU).toDERRawBytes()));
    const txid=await gbxBroadcast(txhex);
    onStatus&&onStatus('gbx_claimed',{txid});
    return { txid };
  }
  return { buyGbxInApp, sellGbxInApp, refundUsdc, claimUsdcForSell, lockGbxForSell, claimGbxForBuy, refundGbxForSell };
}
if(typeof window!=='undefined') window.GoldbrixModB={ makeInAppClient };

// GoldBrix EVM SEND — USDC/ETH transfers + balance reads. Non-custodial: the key stays local.
// Refoloseste primitivele DOVEDITE (evm-tx-core: dataTransfer, signTx, addressFromPriv).
// Model identic cu evm-htlc.mjs send() dar cu VALUE parametrizat (pt ETH nativ).
export function makeEVMSend({ rpc, evm, chainId }){
  const hx = n => '0x'+BigInt(n).toString(16);
  const nonce = async a => parseInt(await rpc('eth_getTransactionCount',[a,'pending']),16);
  const estimate = async (from,to,data,value) => {
    try{ const g=await rpc('eth_estimateGas',[{from,to,data,value:hx(value||0)}]);
      return BigInt(Math.ceil(parseInt(g,16)*1.5)); }
    catch(e){ return data && data!=='0x' ? 120000n : 21000n; }
  };
  const feeData = async () => {
    const b=await rpc('eth_getBlockByNumber',['latest',false]);
    const base=BigInt(b.baseFeePerGas||'0x0');
    let prio; try{ prio=BigInt(await rpc('eth_maxPriorityFeePerGas',[])); }catch(e){ prio=1000000n; }
    if(prio<1000000n)prio=1000000n; if(prio>100000000n)prio=100000000n;
    return { maxPriorityFeePerGas:prio, maxFeePerGas: base*2n+prio };
  };
  async function _sendRaw(pk,to,data,value){
    const from=evm.addressFromPriv(pk);
    const gl=await estimate(from,to,data,value);
    let h, bump=1n;
    for(let attempt=0;;attempt++){
      const f=await feeData();
      const tx={ chainId, nonce:await nonce(from),
        maxPriorityFeePerGas:f.maxPriorityFeePerGas*bump, maxFeePerGas:f.maxFeePerGas*bump,
        gasLimit:gl, to, value:value||0n, data:data||'0x' };
      const {raw}=evm.signTx(tx,pk);
      try{ h=await rpc('eth_sendRawTransaction',[raw]); break; }
      catch(e){ const m=((e&&e.message)||String(e)).toLowerCase();
        if(attempt<3 && /replacement|underpriced|already known|nonce too low|fee too low/.test(m)){
          bump=bump+1n; await new Promise(r=>setTimeout(r,1500)); continue; }
        throw e; }
    }
    let rc=null; for(let i=0;i<120;i++){ rc=await rpc('eth_getTransactionReceipt',[h]); if(rc)break; await new Promise(r=>setTimeout(r,250)); }
    return { hash:h, receipt:rc };
  }
  async function sendToken(pk, tokenAddr, to, amountInt){ return _sendRaw(pk, tokenAddr, evm.dataTransfer(to, amountInt), 0n); }
  async function sendNative(pk, to, amountWei){ return _sendRaw(pk, to, '0x', BigInt(amountWei)); }
  async function balanceToken(tokenAddr, addr){
    const data='0x70a08231'+'000000000000000000000000'+addr.replace(/^0x/,'').toLowerCase();
    const r=await rpc('eth_call',[{to:tokenAddr,data},'latest']); return BigInt(r||'0x0');
  }
  async function balanceNative(addr){ const r=await rpc('eth_getBalance',[addr,'latest']); return BigInt(r||'0x0'); }
  return { sendToken, sendNative, balanceToken, balanceNative, _sendRaw };
}
export function makeRPC(evmRpcUrl){
  let id=1;
  return async (method,params)=>{
    const res=await fetch(evmRpcUrl,{ method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:id++,method,params:params||[]}) });
    const j=await res.json(); if(j.error) throw new Error(j.error.message||JSON.stringify(j.error)); return j.result;
  };
}
if(typeof window!=='undefined'){ window.GoldbrixEVMSend = { makeEVMSend, makeRPC }; }

// GoldBrix EVM HTLC — interfata reutilizabila peste evm-tx-core. Injecteaza { rpc, evm, chainId }.
// rpc(method,params)->result ; evm=createEVM(...) ; pur (browser + daemon).
export function makeEVMHTLC({ rpc, evm, chainId }){
  const nonce = async a => parseInt(await rpc('eth_getTransactionCount',[a,'pending']),16);
  const estimate = async (from,to,data) => { try{ const g=await rpc('eth_estimateGas',[{from,to,data}]); return BigInt(Math.ceil(parseInt(g,16)*1.5)); }catch(e){ return 400000n; } };
  const feeData = async () => { const b=await rpc('eth_getBlockByNumber',['latest',false]); const base=BigInt(b.baseFeePerGas||'0x0'); let prio; try{ prio=BigInt(await rpc('eth_maxPriorityFeePerGas',[])); }catch(e){ prio=1000000n; } if(prio<1000000n)prio=1000000n; if(prio>100000000n)prio=100000000n; return { maxPriorityFeePerGas:prio, maxFeePerGas: base*2n+prio }; };
  async function send(pk,to,data){
    const from=evm.addressFromPriv(pk); const gl=await estimate(from,to,data);
    let h, bump=1n;
    for(let attempt=0;;attempt++){
      const f=await feeData();
      const tx={chainId, nonce:await nonce(from), maxPriorityFeePerGas:f.maxPriorityFeePerGas*bump, maxFeePerGas:f.maxFeePerGas*bump, gasLimit:gl, to, value:0n, data};
      const {raw}=evm.signTx(tx,pk);
      try{ h=await rpc('eth_sendRawTransaction',[raw]); break; }
      catch(e){ const m=((e&&e.message)||String(e)).toLowerCase();
        if(attempt<3 && /replacement|underpriced|already known|nonce too low|fee too low/.test(m)){ bump=bump+1n; await new Promise(r=>setTimeout(r,1500)); continue; }
        throw e; }
    }
    let rc=null; for(let i=0;i<120;i++){ rc=await rpc('eth_getTransactionReceipt',[h]); if(rc) break; await new Promise(r=>setTimeout(r,250)); }
    return { hash:h, receipt:rc };
  }
  return {
    send,
    approve:(pk,token,spender,amt)=>send(pk,token,evm.dataApprove(spender,amt)),
    lock:(pk,htlc,receiver,token,amt,hlHex,tl)=>send(pk,htlc,evm.dataLock(receiver,token,amt,hlHex,tl)),
    claim:(pk,htlc,id,preHex)=>send(pk,htlc,evm.dataClaim(id,preHex)),
    refund:(pk,htlc,id)=>send(pk,htlc,evm.dataRefund(id)),
    lockAuth:(pk,htlc,user,receiver,hl,tl,token,amount,va,vb,an,v,r,s)=>send(pk,htlc,evm.dataLockAuth(user,receiver,hl,tl,token,amount,va,vb,an,v,r,s)),
  };
}

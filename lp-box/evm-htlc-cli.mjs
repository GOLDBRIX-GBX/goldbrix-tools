import { secp256k1, keccak_256 } from './vendor/evm-secp.mjs';
import { createEVM } from './vendor/evm-tx-core.mjs';
import { makeEVMHTLC } from './vendor/evm-htlc.mjs';
const a=JSON.parse(process.argv[2]);
const RPC_LIST=(Array.isArray(a.rpcs)&&a.rpcs.length?a.rpcs:[a.rpc]).filter((v,i,arr)=>v&&arr.indexOf(v)===i);
async function rpc(m,p){
  let lastErr=null;
  for(const url of RPC_LIST){
    try{
      const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});
      const j=await r.json();
      if(j.error){ lastErr=new Error(m+': '+JSON.stringify(j.error)); continue; }
      return j.result;
    }catch(e){ lastErr=e; continue; }
  }
  throw lastErr||new Error('all RPC failed for '+m);
}
const sign=(h,p)=>{const s=secp256k1.sign(h,p,{lowS:true});const c=s.toCompactRawBytes();return {r:c.slice(0,32),s:c.slice(32,64),recovery:s.recovery};};
const evm=createEVM({keccak256:keccak_256,sign,getPublicKey:p=>secp256k1.getPublicKey(p,false)});
const htlc=makeEVMHTLC({rpc,evm,chainId:a.chainId});
const pad=x=>x.replace(/^0x/,'').toLowerCase().padStart(64,'0');
async function getLogsChunked(address,topics,fromHex){
  const latest=parseInt(await rpc('eth_blockNumber',[]),16);
  // B.2: bounded lookback (new BUY locks are recent; old ones live in st.swaps).
  // ADAPTIVE window: if the RPC limits the range, shrink automatically and retry.
  const LOOKBACK=120000;                       // ~ cateva zile pe Base (2s/bloc) — generos
  let from=parseInt(fromHex||'0x0',16);
  const floor=Math.max(from, latest-LOOKBACK);
  from=floor; let logs=[]; let win=9000;
  while(from<=latest){
    const to=Math.min(from+win-1,latest);
    try{
      const part=await rpc('eth_getLogs',[{address,fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16),topics}]);
      logs=logs.concat(part); from=to+1;
      if(win<9000) win=Math.min(9000,win*2);   // return to the large window when the RPC allows it
    }catch(e){
      const msg=String((e&&e.message)||e);
      const m=msg.match(/up to (?:a )?(\d+)\s*block/i) || msg.match(/(\d+)\s*-\s*(\d+)\s*blocks?\s*range/i) || msg.match(/limited to[^\d]*(\d+)/i);
      let lim=0;
      if(m){ lim = m[2]?parseInt(m[2],10):parseInt(m[1],10); }
      if(lim>0 && lim<win){ win=Math.max(1,lim); continue; }   // RPC a spus limita -> respect-o, reincearca acelasi from
      if(win>10){ win=10; continue; }                          // necunoscut -> coboara agresiv si reincearca
      throw e;                                                  // deja la minim -> propaga (fallback RPC prinde)
    }
  }
  return logs;
}
let out={};
try{
  if(a.cmd==='addr') out={address:evm.addressFromPriv(a.pk)};
  else if(a.cmd==='approve'){const r=await htlc.approve(a.pk,a.token,a.spender,BigInt(a.amount)); out={status:r.receipt.status,hash:r.hash};}
  else if(a.cmd==='lock'){const r=await htlc.lock(a.pk,a.htlc,a.receiver,a.token,BigInt(a.amount),a.hashlock,BigInt(a.timelock)); const lg=r.receipt.logs.find(l=>l.address.toLowerCase()===a.htlc.toLowerCase()); out={status:r.receipt.status,hash:r.hash,id:lg?lg.topics[1]:null};}
  else if(a.cmd==='claim'){const r=await htlc.claim(a.pk,a.htlc,a.id,a.preimage); out={status:r.receipt.status,hash:r.hash};}
  else if(a.cmd==='refund'){const r=await htlc.refund(a.pk,a.htlc,a.id); out={status:r.receipt.status,hash:r.hash};}
  else if(a.cmd==='lockAuth'){const r=await htlc.lockAuth(a.pk,a.htlc,a.user,a.receiver,a.hashlock,BigInt(a.timelock),a.token,BigInt(a.amount),BigInt(a.validAfter),BigInt(a.validBefore),a.authNonce,a.v,a.r,a.s); const lg=(r.receipt.logs||[]).find(l=>l.address.toLowerCase()===a.htlc.toLowerCase()); out={status:r.receipt.status,hash:r.hash,id:lg?lg.topics[1]:null};}
  else if(a.cmd==='balanceOf'){const b=await rpc('eth_call',[{to:a.token,data:'0x70a08231'+pad(a.who)},'latest']); out={balance:BigInt(b).toString()};}
  else if(a.cmd==='events'){
    const sig='Locked(bytes32,address,address,address,uint256,bytes32,uint256)';
    const t0='0x'+Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString('hex');
    const logs=await getLogsChunked(a.htlc,[t0],a.fromBlock);
    const addr=h=>'0x'+h.slice(-40);
    out={events: logs.map(l=>{const d=l.data.replace(/^0x/,''); const sl=i=>'0x'+d.slice(i*64,(i+1)*64);
      return {id:l.topics[1],sender:addr(l.topics[2]),receiver:addr(l.topics[3]),token:addr(sl(0)),amount:BigInt(sl(1)).toString(),hashlock:sl(2),timelock:BigInt(sl(3)).toString(),block:parseInt(l.blockNumber,16)};})};
  }
  else if(a.cmd==='claimed'){
    const sig='Claimed(bytes32,bytes)';
    const t0='0x'+Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString('hex');
    const logs=await getLogsChunked(a.htlc,[t0],a.fromBlock);
    out={claimed: logs.map(l=>{const d=l.data.replace(/^0x/,''); const L=parseInt(d.slice(64,128),16); return {id:l.topics[1], preimage:'0x'+d.slice(128,128+2*L), block:parseInt(l.blockNumber,16)};})};
  }
  else out={error:'unknown cmd '+a.cmd};
}catch(e){ out={error:String(e.message||e)}; }
console.log(JSON.stringify(out));

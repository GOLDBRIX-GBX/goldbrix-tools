// GOLDBRIX · mod-b-onramp-evm.mjs · ON-RAMP NON-CUSTODIAL EVM: ETH<->USDC (Base + Arbitrum)
// Agregatoare KEYLESS cu fallback (supravietuieste R - fara chei API). User semneaza, agregator executa.
// Lista extensibila: adauga un agregator = un obiect in AGG[]. Primar -> rezerva automat.
// RPC configurabil (scalabil: la volum schimbi endpoint, nu cod).

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"; // ETH nativ (conventie agregatoare)
const CHAINS = {
  base:     { id: 8453,  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", weth: "0x4200000000000000000000000000000000000006", rpc: "https://mainnet.base.org",     kyber: "base" },
  arbitrum: { id: 42161, usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", rpc: "https://arb1.arbitrum.io/rpc", kyber: "arbitrum" }
};

// ---- AGREGATOR 1: ParaSwap (keyless, 1-pas quote->tx) ----
async function paraswapQuote(chain, srcTok, dstTok, amountWei, userAddr){
  const C = CHAINS[chain];
  const sdec = srcTok===NATIVE?18:6, ddec = dstTok===NATIVE?18:6;
  const src = srcTok, dst = dstTok; // nativ 0xEeee.. acceptat de ParaSwap/Kyber; NU converti la WETH (altfel router cere WETH inexistent -> revert)
  const u = "https://api.paraswap.io/prices?srcToken="+src+"&destToken="+dst+
            "&amount="+amountWei+"&srcDecimals="+sdec+"&destDecimals="+ddec+
            "&side=SELL&network="+C.id+"&userAddress="+userAddr;
  const r = await fetch(u); const j = await r.json();
  if(!j.priceRoute) throw new Error("paraswap-quote");
  return { agg:"paraswap", priceRoute:j.priceRoute, outWei:j.priceRoute.destAmount, outDec:ddec };
}
async function paraswapTx(chain, q, userAddr){
  const C = CHAINS[chain]; const pr = q.priceRoute;
  const body = JSON.stringify({ srcToken:pr.srcToken, destToken:pr.destToken, srcAmount:pr.srcAmount,
    destAmount:String(Math.floor(Number(pr.destAmount)*0.99)), priceRoute:pr, userAddress:userAddr,
    srcDecimals:pr.srcDecimals, destDecimals:pr.destDecimals });
  const r = await fetch("https://api.paraswap.io/transactions/"+C.id+"?ignoreChecks=true",
    {method:"POST",headers:{"content-type":"application/json"},body});
  const tx = await r.json();
  if(!tx.to||!tx.data) throw new Error("paraswap-tx");
  return { to:tx.to, data:tx.data, value:tx.value||"0", gas:tx.gas };
}

// ---- AGREGATOR 2: KyberSwap (keyless, 2-pasi routes->build) ----
async function kyberQuote(chain, srcTok, dstTok, amountWei){
  const C = CHAINS[chain];
  const u = "https://aggregator-api.kyberswap.com/"+C.kyber+"/api/v1/routes?tokenIn="+srcTok+
            "&tokenOut="+dstTok+"&amountIn="+amountWei;
  const r = await fetch(u); const j = await r.json();
  if(!j.data||!j.data.routeSummary) throw new Error("kyber-quote");
  return { agg:"kyber", routeSummary:j.data.routeSummary, routerAddress:j.data.routerAddress,
           outWei:j.data.routeSummary.amountOut, outDec: dstTok===NATIVE?18:6 };
}
async function kyberTx(chain, q, userAddr){
  const C = CHAINS[chain];
  const body = JSON.stringify({ routeSummary:q.routeSummary, sender:userAddr, recipient:userAddr,
    slippageTolerance:50 });
  const r = await fetch("https://aggregator-api.kyberswap.com/"+C.kyber+"/api/v1/route/build",
    {method:"POST",headers:{"content-type":"application/json"},body});
  const j = await r.json();
  if(!j.data||!j.data.data) throw new Error("kyber-build");
  return { to:q.routerAddress, data:j.data.data, value:j.data.transactionValue||"0" };
}

// ---- LISTA FALLBACK (ordine: primar -> rezerva). Extensibil: adauga aici. ----
const AGG = [
  { name:"ParaSwap", quote:paraswapQuote, tx:paraswapTx, evmOnly:false },
  { name:"KyberSwap", quote:kyberQuote,   tx:kyberTx,    evmOnly:true  }
];

// QUOTE cu fallback: incearca fiecare agregator pana unul raspunde
export async function quoteEvm(chain, srcTok, dstTok, amountWei, userAddr){
  let lastErr;
  for(const a of AGG){
    try{
      const q = (a.name==="ParaSwap") ? await a.quote(chain,srcTok,dstTok,amountWei,userAddr)
                                      : await a.quote(chain,srcTok,dstTok,amountWei);
      return { ...q, _agg:a, outAmount: Number(q.outWei)/Math.pow(10,q.outDec) };
    }catch(e){ lastErr=e; continue; } // agregator mort -> incearca urmatorul
  }
  throw new Error("toate agregatoarele EVM indisponibile: "+(lastErr&&lastErr.message||""));
}

// ---- allowance ERC20: sursa USDC cere aprobare catre router INAINTE de swap (altfel revert 0x0) ----
async function _rpcCall(chain, method, params){
  const r = await fetch(CHAINS[chain].rpc, {method:"POST",headers:{"content-type":"application/json"},
    body: JSON.stringify({jsonrpc:"2.0",id:1,method:method,params:params})});
  const j = await r.json(); return j.result;
}
function _pad32(a){ return a.replace(/^0x/,'').toLowerCase().padStart(64,'0'); }
async function _waitEvmReceipt(chain, hash){
  for(let i=0;i<40;i++){
    try{ const rc = await _rpcCall(chain,"eth_getTransactionReceipt",[hash]);
      if(rc && rc.status!=null) return rc.status; }catch(e){}
    await new Promise(function(r){ setTimeout(r,3000); });
  }
  return null;
}
async function _ensureAllowance(chain, token, owner, spender, amountWei, signer){
  const dataAllow = "0xdd62ed3e" + _pad32(owner) + _pad32(spender);
  let cur;
  try{ cur = await _rpcCall(chain, "eth_call", [{to:token, data:dataAllow}, "latest"]); }catch(e){}
  if(!cur || cur==="0x") cur = "0x0";
  if(BigInt(cur) >= BigInt(amountWei)) return; // deja aprobat, nu cheltui gaz
  const dataApprove = "0x095ea7b3" + _pad32(spender) + "f".repeat(64);
  const h = await signer.signAndSend({ to:token, data:dataApprove, value:"0", chainId:CHAINS[chain].id });
  if(!h) throw new Error("approve-no-hash");
  const st = await _waitEvmReceipt(chain, h);
  if(st!=="0x1") throw new Error("approve-reverted");
}

// SWAP: construieste tx cu agregatorul care a dat quote-ul, user semneaza, submite on-chain
export async function swapEvm(ctx){
  const { chain, srcTok, dstTok, amountWei, signer, onStatus } = ctx;
  // signer = { address, signAndSend(txObj) } furnizat de clientul EVM existent (mod-b-browser)
  onStatus && onStatus("quoting");
  const q = await quoteEvm(chain, srcTok, dstTok, amountWei, signer.address);
  onStatus && onStatus("building", { agg:q._agg.name });
  const tx = (q._agg.name==="ParaSwap") ? await q._agg.tx(chain,q,signer.address)
                                        : await q._agg.tx(chain,q,signer.address);
  if(srcTok!==NATIVE){
    const spender = (q._agg.name==="KyberSwap") ? q.routerAddress
                  : (q.priceRoute && q.priceRoute.tokenTransferProxy) ? q.priceRoute.tokenTransferProxy
                  : null;
    if(!spender) throw new Error("no-spender-"+q._agg.name);
    onStatus && onStatus("approving", { spender:spender });
    await _ensureAllowance(chain, srcTok, signer.address, spender, amountWei, signer);
  }
  onStatus && onStatus("user_signed", { agg:q._agg.name });
  const sig = await signer.signAndSend({ to:tx.to, data:tx.data, value:tx.value, chainId:CHAINS[chain].id });
  onStatus && onStatus("done", { sig, outAmount:q.outAmount, agg:q._agg.name });
  return { sig, outAmount:q.outAmount, agg:q._agg.name };
}

export { CHAINS as EVM_ONRAMP_CHAINS, NATIVE as EVM_NATIVE };

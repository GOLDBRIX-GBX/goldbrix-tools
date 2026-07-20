// GOLDBRIX · mod-b-onramp-sol.mjs · NON-CUSTODIAL ON-RAMP: SOL -> USDC via Jupiter (public aggregator)
// Model: app = fereastra, Jupiter = executie on-chain peer-to-pool. Fondatorul NU atinge banii.
// The user signs with the BIP39-derived key. Zero GoldBrix spread. Legacy tx (the vendor lacks VersionedTransaction).
import { Connection, Keypair, Transaction, PublicKey, getAssociatedTokenAddress } from "/vendor/solana.mjs";

const SOL_MINT  = "So11111111111111111111111111111111111111112";   // wrapped SOL (nativ)
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";   // USDC Solana (Circle native)
const JUP_BASE  = "https://lite-api.jup.ag/swap/v1";                 // free endpoint, no API key
const RPCS = [
  "https://solana-rpc.publicnode.com",          // primar: keyless, CORS browser OK
  "https://solana.leorpc.com/?api_key=FREE",    // rezerva 1: keyless public
  "https://api.mainnet-beta.solana.com"         // rezerva 2: oficial (ultima sansa)
];
const RPC = RPCS[0];

// submit with fallback: try each RPC until one accepts the tx (resilient, keyless)
async function _sendRawWithFallback(rawTx){
  const errs=[];
  for(const url of RPCS){
    try{
      const conn = new Connection(url, "confirmed");
      const sig = await conn.sendRawTransaction(rawTx, { skipPreflight:false, maxRetries:3 });
      try { await conn.confirmTransaction(sig, "confirmed"); } catch(_c){}
      return sig;
    }catch(e){ errs.push(url.split("/")[2]+": "+String((e&&e.message)||e).slice(0,100)); continue; }
  }
  throw new Error("toate RPC-urile Solana au picat: " + errs.join(" | "));
}

// Keypair Solana din cheia derivata (acelasi ca mod-b-solana.mjs)
export function solKeypairFromDerive(d){
  const seed = Uint8Array.from(Buffer.from(d.secretKey, "hex"));
  return Keypair.fromSeed(seed);
}

// QUOTE: cat USDC primesc pe X SOL (afiseaza userului INAINTE de confirm)
export async function quoteSolToUsdc(solAmountLamports, slippageBps){
  const bps = slippageBps || 50;
  const url = JUP_BASE + "/quote?inputMint=" + SOL_MINT + "&outputMint=" + USDC_MINT +
              "&amount=" + String(solAmountLamports) + "&slippageBps=" + bps +
              "&asLegacyTransaction=true&onlyDirectRoutes=true";
  const r = await fetch(url);
  const q = await r.json();
  if(!q || !q.outAmount) throw new Error("jup-quote: " + JSON.stringify(q).slice(0,160));
  return {
    inLamports: Number(solAmountLamports),
    outUsdc6:   Number(q.outAmount),                 // USDC with 6 decimals
    outUsdc:    Number(q.outAmount) / 1e6,
    minOutUsdc: Number(q.otherAmountThreshold) / 1e6, // guaranteed minimum after slippage
    priceImpactPct: Number(q.priceImpactPct || 0),
    _raw: q
  };
}

// SWAP: run the conversion. The user signs, Jupiter executes on-chain. No operator touches anything.
export async function swapSolToUsdc(ctx){
  const { solKeypair, solAmountLamports, slippageBps, onStatus } = ctx;
  const bps = slippageBps || 50;
  onStatus && onStatus("quoting");

  // 1. fresh quote
  const q = await quoteSolToUsdc(solAmountLamports, bps);

  // 2. cere tranzactia LEGACY de la Jupiter (semnatar = userul)
  onStatus && onStatus("building");
  const swapResp = await fetch(JUP_BASE + "/swap", {
    method:"POST", headers:{"content-type":"application/json"},
    body: JSON.stringify({
      quoteResponse: q._raw,
      userPublicKey: solKeypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      asLegacyTransaction: true,
      dynamicComputeUnitLimit: true
    })
  });
  const sw = await swapResp.json();
  if(!sw || !sw.swapTransaction) throw new Error("jup-swap: " + JSON.stringify(sw).slice(0,160));

  // 3. deserialize (legacy) + the user signs with their own key
  const tx = Transaction.from(Uint8Array.from(atob(sw.swapTransaction), c=>c.charCodeAt(0)));
  tx.sign(solKeypair);
  onStatus && onStatus("user_signed");

  // 4. submit on-chain via a public RPC (no operator in the flow)
  const raw = tx.serialize();
  const sig = await _sendRawWithFallback(raw);
  onStatus && onStatus("submitted", { sig });
  onStatus && onStatus("done", { sig, outUsdc: q.outUsdc });

  return { sig, outUsdc: q.outUsdc, minOutUsdc: q.minOutUsdc, inLamports: q.inLamports };
}

// ---- INVERS: USDC -> SOL (acelasi Jupiter, mint-uri inversate) ----
export async function quoteUsdcToSol(usdcAmount6, slippageBps){
  const bps = slippageBps || 50;
  const url = JUP_BASE + "/quote?inputMint=" + USDC_MINT + "&outputMint=" + SOL_MINT +
              "&amount=" + String(usdcAmount6) + "&slippageBps=" + bps + "&asLegacyTransaction=true&onlyDirectRoutes=true";
  const r = await fetch(url); const q = await r.json();
  if(!q || !q.outAmount) throw new Error("jup-quote-u2s");
  return { inUsdc6:Number(usdcAmount6), outSol:Number(q.outAmount)/1e9,
           minOutSol:Number(q.otherAmountThreshold)/1e9, priceImpactPct:Number(q.priceImpactPct||0), _raw:q };
}
export async function swapUsdcToSol(ctx){
  const { solKeypair, usdcAmount, slippageBps, onStatus } = ctx;
  const bps = slippageBps || 50;
  onStatus && onStatus("quoting");
  const q = await quoteUsdcToSol(usdcAmount, bps);
  onStatus && onStatus("building");
  const swapResp = await fetch(JUP_BASE + "/swap", {
    method:"POST", headers:{"content-type":"application/json"},
    body: JSON.stringify({ quoteResponse:q._raw, userPublicKey:solKeypair.publicKey.toBase58(),
      wrapAndUnwrapSol:true, asLegacyTransaction:true, dynamicComputeUnitLimit:true })
  });
  const sw = await swapResp.json();
  if(!sw || !sw.swapTransaction) throw new Error("jup-swap-u2s");
  const tx = Transaction.from(Uint8Array.from(atob(sw.swapTransaction), c=>c.charCodeAt(0)));
  tx.sign(solKeypair);
  onStatus && onStatus("user_signed");
  const sig = await _sendRawWithFallback(tx.serialize());
  onStatus && onStatus("submitted", { sig });
  onStatus && onStatus("done", { sig, outSol:q.outSol });
  return { sig, outSol:q.outSol, minOutSol:q.minOutSol };
}

// ==== AGREGATOR RAYDIUM (keyless) — alternativa la Jupiter, selectabil de user in UI ====
const RAY_BASE = "https://transaction-v1.raydium.io";

// Raydium QUOTE (SOL->USDC or USDC->SOL, by mints)
export async function quoteRaydium(inMint, outMint, amount, slippageBps){
  const url = RAY_BASE + "/compute/swap-base-in?inputMint=" + inMint + "&outputMint=" + outMint +
              "&amount=" + String(amount) + "&slippageBps=" + (slippageBps||50) + "&txVersion=LEGACY";
  const comp = await (await fetch(url)).json();
  if(!comp || !comp.success || !comp.data) throw new Error("raydium-quote");
  const outDec = (outMint===USDC_MINT) ? 6 : 9;
  return {
    _comp: comp,
    outAmount: Number(comp.data.outputAmount) / Math.pow(10,outDec),
    minOut:    Number(comp.data.otherAmountThreshold) / Math.pow(10,outDec),
    priceImpactPct: Number(comp.data.priceImpactPct||0)
  };
}

// Raydium SWAP: fresh quote -> build LEGACY tx -> user signs -> submit (RPC fallback)
export async function swapRaydium(ctx){
  const { solKeypair, inMint, outMint, amount, slippageBps, onStatus } = ctx;
  const bps = slippageBps || 50;
  onStatus && onStatus("quoting");
  const q = await quoteRaydium(inMint, outMint, amount, bps);
  onStatus && onStatus("building");
  const wrapSol   = (inMint===SOL_MINT);   // intra SOL nativ -> wrap
  const unwrapSol = (outMint===SOL_MINT);  // iese SOL nativ -> unwrap
  // Raydium requires the ATAs explicitly (REQ_INPUT_ACCOUT_ERROR without them)
  const owner = solKeypair.publicKey;
  let inputAccount, outputAccount;
  try{
    // pt SOL nativ (wrap/unwrap) Raydium gestioneaza singur; pt USDC trimitem ATA userului
    if(inMint!==SOL_MINT){ inputAccount = (await getAssociatedTokenAddress(new PublicKey(inMint), owner)).toBase58(); }
    if(outMint!==SOL_MINT){ outputAccount = (await getAssociatedTokenAddress(new PublicKey(outMint), owner)).toBase58(); }
  }catch(_a){}
  const _body = { computeUnitPriceMicroLamports:"2000", swapResponse:q._comp,
      txVersion:"LEGACY", wallet:owner.toBase58(), wrapSol:wrapSol, unwrapSol:unwrapSol };
  if(inputAccount) _body.inputAccount = inputAccount;
  if(outputAccount) _body.outputAccount = outputAccount;
  const bj = await (await fetch(RAY_BASE + "/transaction/swap-base-in", {
    method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(_body)
  })).json();
  if(!bj || !bj.success || !bj.data || !bj.data[0] || !bj.data[0].transaction) throw new Error("raydium-build");
  const tx = Transaction.from(Uint8Array.from(atob(bj.data[0].transaction), c=>c.charCodeAt(0)));
  tx.sign(solKeypair);
  onStatus && onStatus("user_signed");
  const sig = await _sendRawWithFallback(tx.serialize());  // refoloseste RPC fallback existent
  onStatus && onStatus("done", { sig, outAmount:q.outAmount });
  return { sig, outAmount:q.outAmount, minOut:q.minOut };
}

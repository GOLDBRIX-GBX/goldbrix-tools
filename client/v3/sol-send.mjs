// GBX · Solana send (SOL + USDC-SPL) — non-custodial, semnat LOCAL. Vendor-only, zero deps externe.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction,
         createTransferCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction,
         getAssociatedTokenAddress } from '/vendor/solana.mjs';

const RPCS = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DEC = 6;

function hexToBytes(h){ const a=new Uint8Array(h.length/2); for(let i=0;i<a.length;i++) a[i]=parseInt(h.substr(i*2,2),16); return a; }
function kpFromHexSeed(hex){ return Keypair.fromSeed(hexToBytes(hex)); }
async function conn(){
  for (const u of RPCS){ try{ const c=new Connection(u,'confirmed'); await c.getLatestBlockhash(); return c; }catch(e){} }
  throw new Error('Solana RPC unreachable');
}
async function sendAndConfirm(c, tx, kp){
  const sig = await c.sendTransaction(tx, [kp]);
  // confirmare REALA: poll pana confirmed/finalized, altfel eroare onesta
  for (let i=0;i<30;i++){
    await new Promise(r=>setTimeout(r,2000));
    try{
      const st = await c.getSignatureStatuses([sig], { searchTransactionHistory: true });
      const v = st && st.value && st.value[0];
      if (v){
        if (v.err) throw new Error('Solana tx failed on-chain: '+JSON.stringify(v.err));
        if (v.confirmationStatus==='confirmed' || v.confirmationStatus==='finalized') return sig;
      }
    }catch(e){ if(String(e).includes('failed on-chain')) throw e; }
  }
  const e=new Error('ERR_SOL_DROPPED'); e.code='ERR_SOL_DROPPED'; throw e;
}

export function isValidSolAddress(s){ try{ new PublicKey(s); return true; }catch(e){ return false; } }

export async function getSolBalances(address){
  const c = await conn(); const owner = new PublicKey(address);
  const lam = await c.getBalance(owner);
  let usdc = 0;
  try{
    const ata = await getAssociatedTokenAddress(USDC_MINT, owner);
    const tb = await c.getTokenAccountBalance(ata);
    if (tb && tb.value && tb.value.uiAmount != null) usdc = tb.value.uiAmount;
  }catch(e){}
  return { sol: lam/1e9, usdc };
}

const FEE_LAMPORTS = 10000n;          // ~2x fee tipic, marja
const ATA_RENT_LAMPORTS = 2100000n;   // ~0.0021 SOL rent-exempt ATA

export async function sendSOL(secretHex, toAddr, amountSol){
  const c = await conn(); const kp = kpFromHexSeed(secretHex);
  const bal = BigInt(await c.getBalance(kp.publicKey));
  const need = BigInt(Math.round(Number(amountSol)*1e9)) + FEE_LAMPORTS;
  if (bal < need){ const e=new Error('ERR_SOL_NO_GAS'); e.code='ERR_SOL_NO_GAS'; e.needSol=Number(need-bal)/1e9; throw e; }
  const lamports = BigInt(Math.round(Number(amountSol)*1e9));
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: kp.publicKey, toPubkey: new PublicKey(toAddr), lamports: Number(lamports) }));
  tx.feePayer = kp.publicKey;
  const sig = await sendAndConfirm(c, tx, kp);
  return { hash: sig };
}

export async function sendUSDC(secretHex, toAddr, amountUsdc){
  const c = await conn(); const kp = kpFromHexSeed(secretHex);
  const dest = new PublicKey(toAddr);
  const srcAta = await getAssociatedTokenAddress(USDC_MINT, kp.publicKey);
  const dstAta = await getAssociatedTokenAddress(USDC_MINT, dest);
  // gas pre-check: fee + (ATA rent if the destination has no USDC account)
  let needL = FEE_LAMPORTS;
  try{ await c.getTokenAccountBalance(dstAta); }catch(e){ needL += ATA_RENT_LAMPORTS; }
  const balL = BigInt(await c.getBalance(kp.publicKey));
  if (balL < needL){ const e=new Error('ERR_SOL_NO_GAS'); e.code='ERR_SOL_NO_GAS'; e.needSol=Number(needL-balL)/1e9; throw e; }
  const units = BigInt(Math.round(Number(amountUsdc)*1e6));
  const tx = new Transaction()
    .add(createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, dstAta, dest, USDC_MINT))
    .add(createTransferCheckedInstruction(srcAta, USDC_MINT, dstAta, kp.publicKey, units, USDC_DEC));
  tx.feePayer = kp.publicKey;
  const sig = await sendAndConfirm(c, tx, kp);
  return { hash: sig };
}

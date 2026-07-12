// GoldBrix EVM signer — browser entry (route A: noble + RLP, fara ethers in calea critica)
import { secp256k1, keccak_256 } from '/vendor/evm-secp.mjs';
import { createEVM } from '/evm-tx-core.mjs';
const sign=(h,p)=>{const s=secp256k1.sign(h,p,{lowS:true}); const c=s.toCompactRawBytes(); return {r:c.slice(0,32),s:c.slice(32,64),recovery:s.recovery};};
const getPublicKey=p=>secp256k1.getPublicKey(p,false);
export const GoldbrixEVM=createEVM({keccak256:keccak_256,sign,getPublicKey});
if(typeof window!=='undefined') window.GoldbrixEVM=GoldbrixEVM;

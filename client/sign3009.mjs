// GoldBrix — EIP-3009 receiveWithAuthorization signer (browser + daemon, no ethers).
// Userul semneaza OFF-CHAIN autorizarea ca USDC-ul lui sa fie mutat in HTLC. Zero gaz.
import { secp256k1, keccak_256 } from '/vendor/evm-secp.mjs';

const te = new TextEncoder();
function hexToBytes(h){ if(h.startsWith('0x'))h=h.slice(2); if(h.length%2)h='0'+h; const b=new Uint8Array(h.length/2); for(let i=0;i<b.length;i++)b[i]=parseInt(h.substr(i*2,2),16); return b; }
function bytesToHex(b){ let s='0x'; for(const x of b)s+=x.toString(16).padStart(2,'0'); return s; }
function concat(arr){ let n=0; for(const x of arr)n+=x.length; const o=new Uint8Array(n); let i=0; for(const x of arr){o.set(x,i);i+=x.length;} return o; }
function pad32(b){ const o=new Uint8Array(32); o.set(b,32-b.length); return o; }
function uintTo32(v){ let x=BigInt(v),h=x.toString(16); if(h.length%2)h='0'+h; return pad32(hexToBytes(h)); }
function addrTo32(a){ return pad32(hexToBytes(a)); }

// ReceiveWithAuthorization typehash (standard EIP-3009)
const RECEIVE_TYPEHASH = keccak_256(te.encode(
  "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"));

// Citeste DOMAIN_SEPARATOR-ul USDC-ului on-chain (sursa de adevar, nu reconstruim noi domeniul)
export async function usdcDomainSeparator(rpc, usdcAddr){
  // selector DOMAIN_SEPARATOR() = 0x3644e515
  const r = await rpc('eth_call',[{to:usdcAddr,data:'0x3644e515'},'latest']);
  if(!r || r==='0x') throw new Error('USDC without DOMAIN_SEPARATOR (no 3009 support?)');
  return r; // 0x + 64 hex
}

// Genereaza un nonce 3009 aleator (bytes32) — anti-replay la nivel de token
export function randomAuthNonce(){
  const b = new Uint8Array(32);
  (globalThis.crypto||require('crypto').webcrypto).getRandomValues(b);
  return bytesToHex(b);
}

// Semneaza autorizatia 3009. Returneaza {v,r,s,validAfter,validBefore,nonce} pt lockAuth.
// privHex = the user's EVM key (never leaves the device; local signing).
export async function signReceiveAuth({ rpc, usdcAddr, fromAddr, toHtlc, value, validAfter=0, validBefore, nonce, privHex }){
  const domainSep = await usdcDomainSeparator(rpc, usdcAddr);
  if(!nonce) nonce = randomAuthNonce();
  const structHash = keccak_256(concat([
    RECEIVE_TYPEHASH,
    addrTo32(fromAddr), addrTo32(toHtlc), uintTo32(value),
    uintTo32(validAfter), uintTo32(validBefore), hexToBytes(nonce)
  ]));
  const digest = keccak_256(concat([ new Uint8Array([0x19,0x01]), hexToBytes(domainSep), structHash ]));
  const sig = secp256k1.sign(digest, hexToBytes(privHex), {lowS:true});
  const c = sig.toCompactRawBytes();
  const v = 27 + sig.recovery;
  return {
    v, r: bytesToHex(c.slice(0,32)), s: bytesToHex(c.slice(32,64)),
    validAfter: String(validAfter), validBefore: String(validBefore), nonce,
    digest: bytesToHex(digest)
  };
}

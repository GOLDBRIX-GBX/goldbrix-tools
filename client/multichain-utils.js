import { Buffer } from '/vendor/buffer.mjs';
window.Buffer = Buffer; globalThis.Buffer = Buffer;
const [bip39Module, bip32Module, eccModule, keccakModule, solModule, b58Module] = await Promise.all([
  import('/vendor/bip39.mjs?v=1780567102'),
  import('/vendor/bip32.mjs?v=1780567102'),
  import('/vendor/secp256k1.mjs?v=1780567102'),
  import('/vendor/keccak256.mjs?v=1'),
  import('/vendor/sol-crypto.mjs?v=1'),
  import('/vendor/base58.mjs?v=1')
]);
const bip39 = bip39Module.default || bip39Module;
const ecc = eccModule.default || eccModule;
const { BIP32Factory } = (bip32Module.default || bip32Module);
const { keccak256 } = keccakModule;
const { ed25519, sha512, hmac } = solModule;
const { base58encode } = b58Module;
const bip32 = BIP32Factory(ecc);
const EVM_PATH = "m/44'/60'/0'/0/0";
const SOL_PATH = "m/44'/501'/0'/0'";
const SOL_HARDENED = [44, 501, 0, 0];
function _toChecksum(hex40){
  const ascii=new TextEncoder().encode(hex40);
  const h=Array.from(keccak256(ascii)).map(b=>b.toString(16).padStart(2,'0')).join('');
  let out='0x'; for(let i=0;i<40;i++) out+=(parseInt(h[i],16)>=8)?hex40[i].toUpperCase():hex40[i];
  return out;
}
function _evmAddressFromCompressedPub(pub){
  const un=ecc.pointCompress(pub,false); const body=un.slice(1);
  const h=keccak256(body); const last20=h.slice(12);
  const hex=Array.from(last20).map(b=>b.toString(16).padStart(2,'0')).join('');
  return _toChecksum(hex);
}
async function deriveEVM(mnemonic){
  if(!bip39.validateMnemonic(mnemonic)) throw new Error('Invalid mnemonic phrase');
  const seed=await bip39.mnemonicToSeed(mnemonic);
  const root=bip32.fromSeed(seed);
  const child=root.derivePath(EVM_PATH);
  const address=_evmAddressFromCompressedPub(child.publicKey);
  return { address, privateKey:'0x'+Buffer.from(child.privateKey).toString('hex'), path:EVM_PATH };
}
function _cat(...arrs){let n=0;for(const a of arrs)n+=a.length;const o=new Uint8Array(n);let p=0;for(const a of arrs){o.set(a,p);p+=a.length;}return o;}
function _hmac512(key,data){return hmac(sha512,key,data);}
function _slip10ed25519(seed,path){
  let I=_hmac512(new TextEncoder().encode('ed25519 seed'),seed);
  let k=I.slice(0,32),c=I.slice(32);
  for(const idx of path){const h=0x80000000+idx;
    const data=_cat(Uint8Array.from([0]),k,Uint8Array.from([(h>>>24)&255,(h>>>16)&255,(h>>>8)&255,h&255]));
    I=_hmac512(c,data);k=I.slice(0,32);c=I.slice(32);}
  return k;
}
async function deriveSOL(mnemonic){
  if(!bip39.validateMnemonic(mnemonic)) throw new Error('Invalid mnemonic phrase');
  const seed=new Uint8Array(await bip39.mnemonicToSeed(mnemonic));
  const k=_slip10ed25519(seed,SOL_HARDENED);
  const pub=ed25519.getPublicKey(k);
  return { address: base58encode(pub), secretKey: Buffer.from(k).toString('hex'), path: SOL_PATH };
}
window.GoldbrixMultichain = Object.assign(window.GoldbrixMultichain||{}, { deriveEVM, deriveSOL, EVM_PATH, SOL_PATH });
console.log('[GoldbrixMultichain] EVM + SOL ready.');

// gbx-htlc.mjs — GoldBrix HTLC primitives (client-side, non-custodial). Branding: GBX only.
import { sha256 } from '/vendor/gbx-hash.mjs';
import { ripemd160 } from '/vendor/gbx-h160.mjs';
export function concatBytes(arr){ let n=0; for(const a of arr)n+=a.length; const o=new Uint8Array(n); let i=0; for(const a of arr){o.set(a,i); i+=a.length;} return o; }
export function pushdata(b){ const n=b.length; if(n<0x4c) return concatBytes([Uint8Array.of(n), b]); if(n<=0xff) return concatBytes([Uint8Array.of(0x4c,n), b]); throw new Error('push too big'); }
export function scriptNum(n){ if(n===0) return Uint8Array.of(0x00); const out=[]; let x=n; while(x>0){ out.push(x&0xff); x=Math.floor(x/256);} if(out[out.length-1]&0x80) out.push(0x00); return Uint8Array.from(out); }
export function buildHtlcScript(H, pubClaim, pubRefund, T2){ return concatBytes([ Uint8Array.of(0x63,0xa8), pushdata(H), Uint8Array.of(0x88), pushdata(pubClaim), Uint8Array.of(0xac), Uint8Array.of(0x67), pushdata(scriptNum(T2)), Uint8Array.of(0xb1,0x75), pushdata(pubRefund), Uint8Array.of(0xac), Uint8Array.of(0x68) ]); }
const _CH='qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const _GEN=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];
function _polymod(v){let c=1;for(const d of v){const b=c>>25;c=((c&0x1ffffff)<<5)^d;for(let i=0;i<5;i++)if((b>>i)&1)c^=_GEN[i];}return c;}
function _hrpExpand(h){const o=[];for(let i=0;i<h.length;i++)o.push(h.charCodeAt(i)>>5);o.push(0);for(let i=0;i<h.length;i++)o.push(h.charCodeAt(i)&31);return o;}
function _checksum(hrp,d){const v=_hrpExpand(hrp).concat(d).concat([0,0,0,0,0,0]);const m=_polymod(v)^1;const o=[];for(let i=0;i<6;i++)o.push((m>>(5*(5-i)))&31);return o;}
function _bech32(hrp,d){const c=d.concat(_checksum(hrp,d));let s=hrp+'1';for(const x of c)s+=_CH[x];return s;}
function _conv(data,from,to,pad){let acc=0,bits=0;const out=[];const maxv=(1<<to)-1;for(const v of data){acc=(acc<<from)|v;bits+=from;while(bits>=to){bits-=to;out.push((acc>>bits)&maxv);}}if(pad&&bits>0)out.push((acc<<(to-bits))&maxv);return out;}
export function p2wshSpk(script){ return concatBytes([Uint8Array.of(0x00,0x20), sha256(script)]); }
export function p2wshAddress(script, hrp){ hrp=hrp||'bn'; const prog=sha256(script); return _bech32(hrp,[0].concat(_conv(Array.from(prog),8,5,true))); }
export function dsha256(b){ return sha256(sha256(b)); }
function u32le(n){ const o=new Uint8Array(4); o[0]=n&0xff;o[1]=(n>>>8)&0xff;o[2]=(n>>>16)&0xff;o[3]=(n>>>24)&0xff; return o; }
function u64le(n){ const o=new Uint8Array(8); let x=BigInt(n); for(let i=0;i<8;i++){o[i]=Number(x&0xffn); x>>=8n;} return o; }
export function varint(n){ if(n<0xfd) return Uint8Array.of(n); if(n<=0xffff) return concatBytes([Uint8Array.of(0xfd), u32le(n).slice(0,2)]); if(n<=0xffffffff) return concatBytes([Uint8Array.of(0xfe), u32le(n)]); return concatBytes([Uint8Array.of(0xff), u64le(n)]); }
export function serStr(b){ return concatBytes([varint(b.length), b]); }
export function bip143Sighash(prevTxidLE, vout, scriptCode, amount8, nSequence, outSpk, outValue8, nLockTime){
  const op = concatBytes([prevTxidLE, u32le(vout)]);
  const pre = concatBytes([ u32le(2), dsha256(op), dsha256(u32le(nSequence)), op, serStr(scriptCode), u64le(amount8), u32le(nSequence), dsha256(concatBytes([u64le(outValue8), serStr(outSpk)])), u32le(nLockTime), u32le(1) ]);
  return dsha256(pre);
}
export function serClaimTx(prevTxidLE, vout, nSequence, outSpk, outValue8, witness, nLockTime){
  const head = concatBytes([ u32le(2), Uint8Array.of(0x00,0x01), varint(1), prevTxidLE, u32le(vout), serStr(new Uint8Array(0)), u32le(nSequence), varint(1), u64le(outValue8), serStr(outSpk) ]);
  const wit = concatBytes([varint(witness.length), ...witness.map(w=>serStr(w))]);
  return concatBytes([head, wit, u32le(nLockTime)]);
}
export function buildClaimTx(p, signDigest){
  const prevTxidLE = unhex(p.prevTxid).reverse();
  const nSequence = 0xffffffff, nLockTime = p.nLockTime||0;
  const sighash = bip143Sighash(prevTxidLE, p.vout, p.htlcScript, p.inValue8, nSequence, p.outScriptPubKey, p.outValue8, nLockTime);
  const der = signDigest(sighash);
  const sig = concatBytes([der, Uint8Array.of(0x01)]);
  const witness = [sig, p.preimage, Uint8Array.of(0x01), p.htlcScript];
  return serClaimTx(prevTxidLE, p.vout, nSequence, p.outScriptPubKey, p.outValue8, witness, nLockTime);
}
export const hex = (u)=>Array.from(u).map(x=>x.toString(16).padStart(2,'0')).join('');
export const unhex = (s)=>Uint8Array.from(s.match(/.{2}/g).map(h=>parseInt(h,16)));
export function buildRefundTx(p, signDigest){
  const prevTxidLE = unhex(p.prevTxid).reverse();
  const nSequence = 0xfffffffe, nLockTime = p.T2;
  const sighash = bip143Sighash(prevTxidLE, p.vout, p.htlcScript, p.inValue8, nSequence, p.outScriptPubKey, p.outValue8, nLockTime);
  const der = signDigest(sighash);
  const sig = concatBytes([der, Uint8Array.of(0x01)]);
  const witness = [sig, new Uint8Array(0), p.htlcScript];
  return serClaimTx(prevTxidLE, p.vout, nSequence, p.outScriptPubKey, p.outValue8, witness, nLockTime);
}

export function hash160(pub){ return ripemd160(sha256(pub)); }
export function p2wpkhSpkFromPub(pub){ return concatBytes([Uint8Array.of(0x00,0x14), hash160(pub)]); }
export function p2wpkhAddress(pub, hrp){ hrp=hrp||'bn'; return _bech32(hrp,[0].concat(_conv(Array.from(hash160(pub)),8,5,true))); }
export function buildFundTx(p, signDigest){
  const { utxos, userPubkey, outputs, nLockTime=0 } = p;
  const scriptCode = concatBytes([Uint8Array.of(0x19,0x76,0xa9,0x14), hash160(userPubkey), Uint8Array.of(0x88,0xac)]);
  const nSeq=0xffffffff;
  const prevouts = dsha256(concatBytes(utxos.map(u=>concatBytes([unhex(u.txid).reverse(), u32le(u.vout)]))));
  const seqs = dsha256(concatBytes(utxos.map(()=>u32le(nSeq))));
  const houts = dsha256(concatBytes(outputs.map(o=>concatBytes([u64le(o.value8), serStr(o.spk)]))));
  const wit=[];
  for(const u of utxos){
    const outpoint = concatBytes([unhex(u.txid).reverse(), u32le(u.vout)]);
    const pre = concatBytes([ u32le(1), prevouts, seqs, outpoint, scriptCode, u64le(u.value8), u32le(nSeq), houts, u32le(nLockTime), u32le(1) ]);
    wit.push(concatBytes([ signDigest(dsha256(pre)), Uint8Array.of(0x01) ]));
  }
  let tx = concatBytes([ u32le(1), Uint8Array.of(0x00,0x01), varint(utxos.length) ]);
  for(const u of utxos) tx = concatBytes([tx, unhex(u.txid).reverse(), u32le(u.vout), Uint8Array.of(0x00), u32le(nSeq)]);
  tx = concatBytes([tx, varint(outputs.length)]);
  for(const o of outputs) tx = concatBytes([tx, u64le(o.value8), serStr(o.spk)]);
  for(let i=0;i<utxos.length;i++) tx = concatBytes([tx, varint(2), serStr(wit[i]), serStr(userPubkey)]);
  return concatBytes([tx, u32le(nLockTime)]);
}

// re-exported primitives for the mixed-input curve tx builder (flow)
export { u32le, u64le };

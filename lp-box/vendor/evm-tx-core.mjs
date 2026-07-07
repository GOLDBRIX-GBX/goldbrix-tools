// GoldBrix EVM tx core — logica pura (EIP-1559 type-2 + RLP + ABI). Zero importuri.
// Injecteaza: keccak256(bytes)->32, sign(hash32,priv32)->{r,s,recovery}, getPublicKey(priv32)->65
const te=new TextEncoder();
function hexToBytes(h){ if(typeof h!=='string')return h; if(h.startsWith('0x'))h=h.slice(2); if(h.length%2)h='0'+h;
  const o=new Uint8Array(h.length/2); for(let i=0;i<o.length;i++)o[i]=parseInt(h.substr(i*2,2),16); return o; }
function bytesToHex(b){ let s=''; for(const x of b)s+=x.toString(16).padStart(2,'0'); return s; }
function concat(a){ let n=0; for(const x of a)n+=x.length; const o=new Uint8Array(n); let i=0; for(const x of a){o.set(x,i);i+=x.length;} return o; }
function stripZeros(b){ let i=0; while(i<b.length&&b[i]===0)i++; return b.slice(i); }
function toBytes(v){ let x=BigInt(v); if(x<0n)throw new Error('neg'); if(x===0n)return new Uint8Array(0);
  let h=x.toString(16); if(h.length%2)h='0'+h; return hexToBytes(h); }
function pad32(b){ if(b.length>32)throw new Error('of'); const o=new Uint8Array(32); o.set(b,32-b.length); return o; }
function rlpLen(l,off){ if(l<56)return new Uint8Array([off+l]); let h=l.toString(16); if(h.length%2)h='0'+h;
  const lb=hexToBytes(h); return concat([new Uint8Array([off+55+lb.length]),lb]); }
function rlpBytes(b){ if(b.length===1&&b[0]<0x80)return b; return concat([rlpLen(b.length,0x80),b]); }
function rlpList(items){ const p=concat(items); return concat([rlpLen(p.length,0xc0),p]); }
function fields(tx){ return [ rlpBytes(toBytes(tx.chainId)),rlpBytes(toBytes(tx.nonce)),
  rlpBytes(toBytes(tx.maxPriorityFeePerGas)),rlpBytes(toBytes(tx.maxFeePerGas)),rlpBytes(toBytes(tx.gasLimit)),
  rlpBytes(hexToBytes(tx.to)),rlpBytes(toBytes(tx.value||0)),rlpBytes(hexToBytes(tx.data||'0x')),rlpList([]) ]; }
export function createEVM({keccak256,sign,getPublicKey}){
  const sel=s=>keccak256(te.encode(s)).slice(0,4);
  const encA=a=>pad32(hexToBytes(a)); const encU=v=>pad32(toBytes(v));
  const encB=h=>{const b=hexToBytes(h); if(b.length!==32)throw new Error('b32'); return b;};
  const dataTransfer=(to,a)=>'0x'+bytesToHex(concat([sel('transfer(address,uint256)'),encA(to),encU(a)]));
  const dataApprove =(sp,a)=>'0x'+bytesToHex(concat([sel('approve(address,uint256)'),encA(sp),encU(a)]));
  const dataLock=(r,t,a,hl,tl)=>'0x'+bytesToHex(concat([sel('lock(address,address,uint256,bytes32,uint256)'),encA(r),encA(t),encU(a),encB(hl),encU(tl)]));
  const dataClaim=(id,pi)=>{const p=hexToBytes(pi); const pad=new Uint8Array(Math.ceil(p.length/32)*32||0); pad.set(p,0);
    return '0x'+bytesToHex(concat([sel('claim(bytes32,bytes)'),encB(id),encU(64),encU(p.length),pad]));};
  const dataRefund=id=>'0x'+bytesToHex(concat([sel('refund(bytes32)'),encB(id)]));
  const dataLockAuth=(user,receiver,hl,tl,token,amount,va,vb,an,v,r,sg)=>'0x'+bytesToHex(concat([
    sel('lockAuth(address,address,bytes32,uint256,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)'),
    encA(user),encA(receiver),encB(hl),encU(tl),encA(token),encU(amount),encU(va),encU(vb),encB(an),encU(v),encB(r),encB(sg)]));
  function signTx(tx,priv){ const pv=hexToBytes(priv);
    const unsigned=concat([new Uint8Array([0x02]),rlpList(fields(tx))]);
    const {r,s,recovery}=sign(keccak256(unsigned),pv);
    const f=fields(tx); f.push(rlpBytes(toBytes(recovery))); f.push(rlpBytes(stripZeros(r))); f.push(rlpBytes(stripZeros(s)));
    const raw=concat([new Uint8Array([0x02]),rlpList(f)]);
    return { raw:'0x'+bytesToHex(raw), hash:'0x'+bytesToHex(keccak256(raw)) }; }
  function checksum(a20){ const lo=bytesToHex(a20); const hh=bytesToHex(keccak256(te.encode(lo)));
    let o='0x'; for(let i=0;i<40;i++)o+=(parseInt(hh[i],16)>=8)?lo[i].toUpperCase():lo[i]; return o; }
  const addressFromPriv=priv=>checksum(keccak256(getPublicKey(hexToBytes(priv)).slice(1)).slice(12));
  return { dataTransfer,dataApprove,dataLock,dataLockAuth,dataClaim,dataRefund,signTx,addressFromPriv };
}

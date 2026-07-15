// Minimal segwit tx surgery: set the witness stack of one input.
// The curve/pool inputs are anyone-can-spend: witness = [witnessScript] only.
import { unhex, hex } from './gbx-curve.mjs';
function rdVarint(b,i){ const n=b[i];
  if(n<0xfd) return [BigInt(n),i+1];
  if(n===0xfd) return [BigInt(b[i+1]|(b[i+2]<<8)),i+3];
  if(n===0xfe) return [BigInt(new DataView(b.buffer,b.byteOffset+i+1,4).getUint32(0,true)),i+5];
  return [new DataView(b.buffer,b.byteOffset+i+1,8).getBigUint64(0,true),i+9]; }
function wrVarint(n){ n=Number(n);
  if(n<0xfd) return Uint8Array.of(n);
  if(n<=0xffff) return Uint8Array.of(0xfd,n&0xff,n>>8);
  throw new Error('varint'); }
const cat=(...a)=>{const t=new Uint8Array(a.reduce((s,x)=>s+x.length,0));let o=0;for(const x of a){t.set(x,o);o+=x.length;}return t;};

// If the tx has no witness marker (all inputs unsigned), add marker+flag and
// empty stacks, so a witness can be injected before the wallet signs its inputs.
export function ensureSegwit(txHex){
  const b=unhex(txHex);
  if(b[4]===0x00&&b[5]===0x01) return txHex;
  let i=4;
  const [nin,i1]=rdVarint(b,i); i=i1;
  for(let k=0;k<Number(nin);k++){ i+=36; const [sl,i2]=rdVarint(b,i); i=i2+Number(sl); i+=4; }
  const [nout,i3]=rdVarint(b,i); i=i3;
  for(let k=0;k<Number(nout);k++){ i+=8; const [sl,i4]=rdVarint(b,i); i=i4+Number(sl); }
  const body=b.subarray(4,i), locktime=b.subarray(i);
  const empty=new Uint8Array(Number(nin)); // one 0x00 (empty stack) per input
  return hex(cat(b.subarray(0,4), Uint8Array.of(0x00,0x01), body, empty, locktime));
}

export function setWitness(txHex, inputIndex, stackItems){
  const b=unhex(ensureSegwit(txHex));
  if(b[4]!==0x00||b[5]!==0x01) throw new Error('not segwit');
  let i=6;
  const [nin,i1]=rdVarint(b,i); i=i1;
  const starts=[];
  for(let k=0;k<Number(nin);k++){ i+=36; const [sl,i2]=rdVarint(b,i); i=i2+Number(sl); i+=4; }
  const [nout,i3]=rdVarint(b,i); i=i3;
  for(let k=0;k<Number(nout);k++){ i+=8; const [sl,i4]=rdVarint(b,i); i=i4+Number(sl); }
  // i = start of witness section; one stack per input
  let w=i;
  const spans=[];
  for(let k=0;k<Number(nin);k++){
    const s0=w; const [items,w1]=rdVarint(b,w); w=w1;
    for(let j=0;j<Number(items);j++){ const [L,w2]=rdVarint(b,w); w=w2+Number(L); }
    spans.push([s0,w]);
  }
  const locktime=b.subarray(b.length-4);
  if(w!==b.length-4) throw new Error('parse mismatch');
  const newStack=cat(wrVarint(stackItems.length),
    ...stackItems.map(it=>cat(wrVarint(it.length),it)));
  const [s0,s1]=spans[inputIndex];
  return hex(cat(b.subarray(0,s0), newStack, b.subarray(s1)));
}

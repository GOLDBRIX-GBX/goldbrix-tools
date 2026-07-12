// keccak256 — compact, dependency-free, Uint8Array -> Uint8Array(32).
const RC=[[0,1],[0,0x8082],[0x80000000,0x808a],[0x80000000,0x80008000],[0,0x808b],[0,0x80000001],
[0x80000000,0x80008081],[0x80000000,0x8009],[0,0x8a],[0,0x88],[0,0x80008009],[0,0x8000000a],
[0,0x8000808b],[0x80000000,0x8b],[0x80000000,0x8089],[0x80000000,0x8003],[0x80000000,0x8002],
[0x80000000,0x80],[0,0x800a],[0x80000000,0x8000000a],[0x80000000,0x80008081],[0x80000000,0x8080],
[0,0x80000001],[0x80000000,0x80008008]];
const r=[0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14];
function keccakF(s){
  for(let round=0;round<24;round++){
    const C=new Array(10);
    for(let x=0;x<5;x++){const i=x*2;C[i]=s[i]^s[i+10]^s[i+20]^s[i+30]^s[i+40];C[i+1]=s[i+1]^s[i+11]^s[i+21]^s[i+31]^s[i+41];}
    const D=new Array(10);
    for(let x=0;x<5;x++){const x1=((x+1)%5)*2,x4=((x+4)%5)*2;
      D[x*2]=C[x4]^((C[x1]<<1)|(C[x1+1]>>>31));D[x*2+1]=C[x4+1]^((C[x1+1]<<1)|(C[x1]>>>31));}
    for(let x=0;x<5;x++)for(let y=0;y<5;y++){const idx=(x+y*5)*2;s[idx]^=D[x*2];s[idx+1]^=D[x*2+1];}
    const B=new Array(50);
    for(let x=0;x<5;x++)for(let y=0;y<5;y++){
      const idx=(x+y*5)*2,nx=y,ny=(2*x+3*y)%5,nidx=(nx+ny*5)*2,rot=r[x+y*5];let hi=s[idx],lo=s[idx+1];
      if(rot===0){B[nidx]=hi;B[nidx+1]=lo;}
      else if(rot<32){B[nidx]=(hi<<rot)|(lo>>>(32-rot));B[nidx+1]=(lo<<rot)|(hi>>>(32-rot));}
      else if(rot===32){B[nidx]=lo;B[nidx+1]=hi;}
      else{const rr=rot-32;B[nidx]=(lo<<rr)|(hi>>>(32-rr));B[nidx+1]=(hi<<rr)|(lo>>>(32-rr));}
    }
    for(let x=0;x<5;x++)for(let y=0;y<5;y++){
      const idx=(x+y*5)*2,x1=(((x+1)%5)+y*5)*2,x2=(((x+2)%5)+y*5)*2;
      s[idx]=B[idx]^((~B[x1])&B[x2]);s[idx+1]=B[idx+1]^((~B[x1+1])&B[x2+1]);
    }
    s[0]^=RC[round][1];s[1]^=RC[round][0];
  }
}
export function keccak256(msg){
  const rate=136,s=new Array(50).fill(0),buf=new Uint8Array(rate);
  let len=msg.length,off=0;
  const absorb=(data,o)=>{for(let i=0;i<rate;i+=8){const wi=(i>>3)*2;
    s[wi]^=((data[o+i])|(data[o+i+1]<<8)|(data[o+i+2]<<16)|(data[o+i+3]<<24))>>>0;
    s[wi+1]^=((data[o+i+4])|(data[o+i+5]<<8)|(data[o+i+6]<<16)|(data[o+i+7]<<24))>>>0;}};
  while(len>=rate){absorb(msg,off);keccakF(s);off+=rate;len-=rate;}
  buf.fill(0);for(let i=0;i<len;i++)buf[i]=msg[off+i];
  buf[len]^=0x01;buf[rate-1]^=0x80;
  absorb(buf,0);keccakF(s);
  const out=new Uint8Array(32);
  for(let i=0;i<4;i++){const lo=s[i*2]>>>0,hi=s[i*2+1]>>>0;
    out[i*8]=lo&255;out[i*8+1]=(lo>>>8)&255;out[i*8+2]=(lo>>>16)&255;out[i*8+3]=(lo>>>24)&255;
    out[i*8+4]=hi&255;out[i*8+5]=(hi>>>8)&255;out[i*8+6]=(hi>>>16)&255;out[i*8+7]=(hi>>>24)&255;}
  return out;
}

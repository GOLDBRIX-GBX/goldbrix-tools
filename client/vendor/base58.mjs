const A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58encode(bytes){
  let zeros=0; while(zeros<bytes.length && bytes[zeros]===0) zeros++;
  const digits=[];
  for(let i=zeros;i<bytes.length;i++){let carry=bytes[i];
    for(let j=0;j<digits.length;j++){carry+=digits[j]<<8;digits[j]=carry%58;carry=(carry/58)|0;}
    while(carry){digits.push(carry%58);carry=(carry/58)|0;}}
  let str=''; for(let i=0;i<zeros;i++) str+='1';
  for(let i=digits.length-1;i>=0;i--) str+=A[digits[i]];
  return str;
}

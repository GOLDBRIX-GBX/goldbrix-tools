#!/usr/bin/env python3
# derive-import.py - derive m/84'/0'/0'/0/0 from a BIP39 phrase (env PH), import
# private descriptors into the wallet, print the derived address. Phrase never touches disk.
import os,sys,json,hashlib,hmac,struct,subprocess,unicodedata
P=2**256-2**32-977
N=0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G=(0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
   0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)
def inv(a,m):return pow(a,m-2,m)
def padd(a,b):
    if a is None:return b
    if b is None:return a
    if a[0]==b[0] and (a[1]+b[1])%P==0:return None
    l=((b[1]-a[1])*inv(b[0]-a[0],P))%P if a!=b else ((3*a[0]*a[0])*inv(2*a[1],P))%P
    x=(l*l-a[0]-b[0])%P
    return (x,(l*(a[0]-x)-a[1])%P)
def pmul(k):
    r,pt=None,G
    while k:
        if k&1:r=padd(r,pt)
        pt=padd(pt,pt);k>>=1
    return r
def ser_pub(k):
    x,y=pmul(k);return bytes([2+(y&1)])+x.to_bytes(32,"big")
def ckd(k,c,i):
    d=(b"\0"+k.to_bytes(32,"big") if i>=0x80000000 else ser_pub(k))+struct.pack(">I",i)
    I=hmac.new(c,d,hashlib.sha512).digest()
    return (int.from_bytes(I[:32],"big")+k)%N,I[32:]
CS="qpzry9x8gf2tvdw0s3jn54khce6mua7l"
def bech32(hrp,prog):
    def pm(v):
        gen=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];chk=1
        for x in v:
            b=chk>>25;chk=(chk&0x1ffffff)<<5^x
            for i in range(5):chk^=gen[i] if (b>>i)&1 else 0
        return chk
    hx=[ord(c)>>5 for c in hrp]+[0]+[ord(c)&31 for c in hrp]
    acc=bits=0;data=[0]
    for b in prog:
        acc=acc<<8|b;bits+=8
        while bits>=5:bits-=5;data.append(acc>>bits&31)
    pol=pm(hx+data+[0]*6)^1
    return hrp+"1"+"".join(CS[d] for d in data)+"".join(CS[pol>>5*(5-i)&31] for i in range(6))
def b58c(b):
    b+=hashlib.sha256(hashlib.sha256(b).digest()).digest()[:4]
    A="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n=int.from_bytes(b,"big");s=""
    while n:
        n,r=divmod(n,58);s=A[r]+s
    return s
CLI=os.environ.get("GBX_CLI","goldbrix-cli")
DATADIR=os.environ.get("GBX_DATADIR","/root/.bitcoin")
WALLET=os.environ.get("GBX_WALLET","miner_wallet")
def cli(method,*args):
    r=subprocess.run([CLI,"-datadir="+DATADIR,"-rpcwallet="+WALLET,"-stdin",method],
                     input="\n".join(args),capture_output=True,text=True)
    if r.returncode:
        sys.stderr.write("ERR: "+r.stderr.strip()+"\n");sys.exit(1)
    return json.loads(r.stdout) if r.stdout.strip() else None
m=" ".join(os.environ["PH"].split())
seed=hashlib.pbkdf2_hmac("sha512",unicodedata.normalize("NFKD",m).encode(),b"mnemonic",2048)
I=hmac.new(b"Bitcoin seed",seed,hashlib.sha512).digest()
k,c=int.from_bytes(I[:32],"big"),I[32:]
xprv=b58c(bytes.fromhex("0488ade4")+b"\0"*9+c+b"\0"+k.to_bytes(32,"big"))
for chg in (0,1):
    d="wpkh("+xprv+"/84h/0h/0h/"+str(chg)+"/*)"
    cs=cli("getdescriptorinfo",d)["checksum"]
    res=cli("importdescriptors",json.dumps([{"desc":d+"#"+cs,"timestamp":"now","range":[0,100],"active":False}]))
    assert res[0]["success"] is True,res[0].get("error")
kk,cc=k,c
for i in (0x80000054,0x80000000,0x80000000,0,0):kk,cc=ckd(kk,cc,i)
h=hashlib.new("ripemd160",hashlib.sha256(ser_pub(kk)).digest()).digest()
print(bech32("bn",h))

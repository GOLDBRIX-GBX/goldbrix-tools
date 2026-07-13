#!/usr/bin/env python3
# IDEE V token-index: holdings derived from GBX:C OP_RETURNs (declare beneficiary+amount),
# minus holdings consumed when their token UTXO is spent. Keyless, reconstructible.
import subprocess, json, hashlib
B="/root/idee-v/build/bin"; D="/root/idee-v/rt"
def cli(*a):
    r=subprocess.run([f"{B}/goldbrix-cli",f"-datadir={D}","-regtest","-rpcport=19332",*map(str,a)],
                     capture_output=True,text=True)
    if r.returncode: raise RuntimeError(r.stderr.strip()[:200])
    o=r.stdout.strip()
    try: return json.loads(o)
    except: return o
def sha(b): return hashlib.sha256(b).digest()
def rd(b,i):
    n=b[i]; i+=1
    if n<0x4c: return b[i:i+n],i+n
    if n==0x4c: L=b[i]; return b[i+1:i+1+L],i+1+L
    raise ValueError
def token_ws(cid,amt,pk):  # rebuild canonical script
    def push(x): return (bytes([len(x)]) if len(x)<0x4c else b'\x4c'+bytes([len(x)]))+x
    return push(cid)+push(amt.to_bytes(8,'big'))+b'\x6d'+push(pk)+b'\xac'
def p2wsh(ws): return "0020"+sha(ws).hex()

def parse_intent(tx):
    for o in tx["vout"]:
        spk=o.get("scriptPubKey",{}).get("hex","")
        if not spk.startswith("6a"): continue
        try:
            b=bytes.fromhex(spk); data,_=rd(b,1)
        except: continue
        if len(data)!=88 or data[:6]!=b"GBX:C:": continue
        op=chr(data[6]); cid=data[7:39]; amount=int.from_bytes(data[39:47],'big')
        tokens_out=int.from_bytes(data[47:55],'big'); pk=data[55:88]
        return op,cid,amount,tokens_out,pk
    return None

tip=cli("getblockcount")
# 1) collect token UTXOs created (from intents) and which outpoints are spent
created={}   # outpoint -> (coin_hex, pk_hex, amount)
spent=set()
for h in range(tip+1):
    blk=cli("getblock",cli("getblockhash",h),2)
    for tx in blk["tx"]:
        for vin in tx.get("vin",[]):
            if "txid" in vin: spent.add((vin["txid"],vin["vout"]))
        it=parse_intent(tx)
        if not it: continue
        op,cid,amount,tok,pk=it
        if op in ("C","B","P") and tok>0:      # mints tokens to pk
            spkh=p2wsh(token_ws(cid,tok,pk))
            for o in tx["vout"]:
                if o["scriptPubKey"]["hex"]==spkh:
                    created[(tx["txid"],o["n"])]=(cid.hex(),pk.hex(),tok)
# 2) holdings = created and unspent
hold={}
for op,(c,pk,amt) in created.items():
    if op in spent: continue
    hold[(c,pk)]=hold.get((c,pk),0)+amt
print(f"tip={tip} token_utxos_created={len(created)} live_holdings={len(hold)}")
for (c,pk),amt in hold.items():
    print(f"  coin={c[:16]}.. holder={pk[:16]}.. amount={amt:,}")

#!/usr/bin/env python3
# GoldBrix LP daemon (MAINNET) — reactiv, non-custodial, cu refund-pe-abandon + auto-halt + bucla.
import subprocess, json, hashlib, os, time, ecdsa
from ecdsa.util import sigencode_der_canonize
from ecdsa import SECP256k1
from lp_env import E
A=json.load(open(E["ADDRS_F"])); USDC=A["USDC"]; HTLC=A["HTLC"]
FROM_BLOCK=hex(A.get("from_block",0))
RPC="https://mainnet.base.org"; CHAIN=8453
RPCS=A.get("rpcs",[RPC])  # B.2 multi-RPC fallback
def _load_treasury_key():
    """Decripteaza cheia treasury 0x3b5B din keystore criptat (PBKDF2 200k + AES-256-CBC).
    The key stays encrypted on disk, decrypted ONLY in memory. Same model as lib/evm.js.
    LP and treasury unified (single warm identity)."""
    import re as _re, hashlib as _hl
    from cryptography.hazmat.primitives.ciphers import Cipher as _C, algorithms as _alg, modes as _md
    _env=open(E["ENV_F"]).read()
    def _g(k):
        m=_re.search(rf'^{k}=(.*)$', _env, _re.M)
        return m.group(1).strip().strip('"').strip("'") if m else None
    _pw=_g("EVM_KEY_PASSPHRASE"); _kp=_g("EVM_KEYSTORE_PATH")
    if not _pw or not _kp: raise RuntimeError("EVM_KEY_PASSPHRASE/EVM_KEYSTORE_PATH lipsa in .env")
    _buf=open(_kp,"rb").read()
    if _buf[:8]!=b"Salted__": raise RuntimeError("keystore: format openssl invalid")
    _salt=_buf[8:16]; _ct=_buf[16:]
    _ki=_hl.pbkdf2_hmac("sha256", _pw.encode(), _salt, 200000, dklen=48)
    _d=_C(_alg.AES(_ki[:32]), _md.CBC(_ki[32:48])).decryptor()
    _pt=_d.update(_ct)+_d.finalize(); _pt=_pt[:-_pt[-1]]
    _ks=json.loads(_pt.decode())
    _pk=_ks["privateKey"]
    return (_pk if _pk.startswith("0x") else "0x"+_pk), _ks["address"]

LP_PK_EVM, LP_EVM = _load_treasury_key()
STATE_F=E["STATE_F"]; INTENTS_F=E["INTENTS_F"]
import os as _os,sys as _sys; _sys.path.insert(0,_os.path.dirname(_os.path.abspath(__file__)))
from lp_pricing import quote, quote_sell
import lp_solana
from _sol_key import load_solana_secret
try: SOL_SECRET = load_solana_secret()
except Exception as _e: SOL_SECRET = None; print(f"[SOL] cheie indisponibila: {_e}")
GCLI=[E["GCLI_BIN"],"-datadir="+E["GBX_DATADIR"]]; WALLET=E["GBX_WALLET"]
def _enc(x): return "true" if x is True else ("false" if x is False else str(x))
# === FAZA 5 · multi-chain context (build-once, R1) ===
def load_chains():
    try: return json.load(open(E["CHAINS_F"])).get("chains",{})
    except Exception: return {}
def chain_ctx(name):
    c=load_chains().get(name) or {}
    return {"name":name,"chainId":c.get("chainId",CHAIN),"usdc":c.get("USDC",USDC),
            "htlc":c.get("HTLC",HTLC),"lp_evm":c.get("lp_evm",LP_EVM),
            "rpcs":c.get("rpcs",RPCS),"from_block":c.get("from_block",A.get("from_block",0))}
def enabled_chains():
    # B-fix: doar lanturi EVM in bucla EVM. Solana (kind=solana) procesata DOAR de lp_solana.sol_run.
    return [n for n,c in load_chains().items() if c.get("enabled") and c.get("kind","evm")=="evm"]
def gcli(*a,wallet=None):
    c=list(GCLI)+([f"-rpcwallet={wallet}"] if wallet else [])+[_enc(x) for x in a]
    # REZILIENT: nodul poate fi temporar in "Loading" (-28) la restart/reindex -> asteapta + reincearca
    for _attempt in range(40):   # B-fix: acopera restart nod ~90s real + margine = ~160s
        try: r=subprocess.run(c,capture_output=True,text=True,timeout=90)
        except subprocess.TimeoutExpired:
            print(f"  [WAIT] gcli {a[0]}: TIMEOUT 90s, retry {_attempt+1}/40"); continue
        if r.returncode==0: return r.stdout.strip()
        err=r.stderr.strip()
        # transient errors: node loading / still starting -> retry
        if ("-28" in err) or ("Loading" in err) or ("warming up" in err) or ("Could not connect" in err) or ("couldn't connect" in err.lower()):
            print(f"  [WAIT] gcli {a[0]}: nod ocupat ({err[:50]}), retry {_attempt+1}/40 in 4s")
            time.sleep(4); continue
        raise RuntimeError(f"gcli {a[0]}: {err}")
    raise RuntimeError(f"gcli {a[0]}: nod indisponibil dupa 40 incercari (~160s)")
def gclij(*a,wallet=None):
    o=gcli(*a,wallet=wallet); return json.loads(o) if o else None
def gtry(*a,wallet=None):
    c=list(GCLI)+([f"-rpcwallet={wallet}"] if wallet else [])+[_enc(x) for x in a]
    try: return subprocess.run(c,capture_output=True,text=True,timeout=90).returncode==0
    except subprocess.TimeoutExpired: return False
def evmcli(ctx=None,**d):
    if ctx is not None:
        d.update(rpc=ctx["rpcs"][0],rpcs=ctx["rpcs"],chainId=ctx["chainId"])
        if "fromBlock" not in d: d["fromBlock"]=hex(ctx.get("from_block",0))
    else:
        d.update(rpc=RPC,rpcs=RPCS,chainId=CHAIN)
        if "fromBlock" not in d: d["fromBlock"]=FROM_BLOCK
    r=subprocess.run(["node",E["EVM_CLI"],json.dumps(d)],capture_output=True,text=True,timeout=120)
    if r.returncode!=0: raise RuntimeError("evmcli rc: "+r.stderr.strip())
    o=json.loads(r.stdout.strip())
    if o.get("error"): raise RuntimeError("evmcli: "+o["error"])
    return o
def sha256(b): return hashlib.sha256(b).digest()
def dsha256(b): return sha256(sha256(b))
def varint(n):
    if n<0xfd: return bytes([n])
    if n<=0xffff: return b'\xfd'+n.to_bytes(2,'little')
    if n<=0xffffffff: return b'\xfe'+n.to_bytes(4,'little')
    return b'\xff'+n.to_bytes(8,'little')
def ser_str(b): return varint(len(b))+b
def pushdata(b):
    n=len(b); return (bytes([n]) if n<0x4c else b'\x4c'+bytes([n]))+b
def script_num(n):
    if n==0: return b'\x00'
    out=bytearray()
    while n: out.append(n&0xff); n>>=8
    if out[-1]&0x80: out.append(0x00)
    return bytes(out)
def build_htlc(H,pU,pLP,T2):
    s=bytes([0x63,0xa8])+pushdata(H)+bytes([0x88])+pushdata(pU)+bytes([0xac])
    s+=bytes([0x67])+pushdata(script_num(T2))+bytes([0xb1,0x75])+pushdata(pLP)+bytes([0xac]); return s+bytes([0x68])
def p2wsh_spk(scr): return b'\x00\x20'+sha256(scr)
def pk_of(sk):
    p=sk.verifying_key.pubkey.point; return bytes([2+(p.y()&1)])+p.x().to_bytes(32,'big')
def gen_key():
    sk=ecdsa.SigningKey.generate(curve=SECP256k1); return sk, pk_of(sk)
def sk_from_hex(h): return ecdsa.SigningKey.from_string(bytes.fromhex(h),curve=SECP256k1)
def sgn(sk,d): return sk.sign_digest_deterministic(d,hashfunc=hashlib.sha256,sigencode=sigencode_der_canonize)+b'\x01'
def bip143(le,vout,scr,amt,nSeq,ospk,oval,lock):
    op=le+vout.to_bytes(4,'little')
    pre=(2).to_bytes(4,'little')+dsha256(op)+dsha256(nSeq.to_bytes(4,'little'))+op
    pre+=ser_str(scr)+amt.to_bytes(8,'little')+nSeq.to_bytes(4,'little')
    pre+=dsha256(oval.to_bytes(8,'little')+ser_str(ospk))+lock.to_bytes(4,'little')+(1).to_bytes(4,'little')
    return dsha256(pre)
def ser_tx(le,vout,nSeq,ospk,oval,wit,lock):
    tx=(2).to_bytes(4,'little')+b'\x00\x01'+varint(1)+le+vout.to_bytes(4,'little')+ser_str(b'')+nSeq.to_bytes(4,'little')
    tx+=varint(1)+oval.to_bytes(8,'little')+ser_str(ospk)+varint(len(wit))+b''.join(ser_str(w) for w in wit)+lock.to_bytes(4,'little')
    return tx.hex()
def gheight(): return int(gcli("getblockcount"))
def gmine(n,a):
    if n>0: gcli("generatetoaddress",n,a)
def load_state():
    if os.path.exists(STATE_F): return json.load(open(STATE_F))
    return {"swaps":{},"lp_gbx_sk":None,"halt":False}
def save_state(st): json.dump(st,open(STATE_F,"w"),indent=1)
def load_intents():
    return json.load(open(INTENTS_F)) if os.path.exists(INTENTS_F) else {}
def refund_sell_guard(pk,val_sats):
    # give back the volume consumed by _sell_guard at /intent when the daemon rejects (a reject is not a sale)
    try:
        sgf=E.get("SELL_GUARD_F")
        if not sgf or not pk: return
        sg=json.load(open(sgf)) if os.path.exists(sgf) else {}
        e=sg.get(pk)
        if not e: return
        e['vol']=max(0,int(e.get('vol',0))-int(val_sats or 0))
        e['last']=0   # reject-ul nu porneste cooldown: userul poate reincerca imediat cu pret corect
        sg[pk]=e; json.dump(sg,open(sgf,'w'))
        print(f"  [GUARD] cap restituit pentru {str(pk)[:12]} ({int(val_sats or 0)/1e8} GBX)")
    except Exception as _e:
        print(f"  [GUARD] restituire esuata: {_e}")
def intent_refund_key(intent):
    return intent.get("refund_pubkey") or intent.get("sol_user_pubkey")
def ensure_setup(st):
    gtry("createwallet",WALLET); gtry("loadwallet",WALLET)
    fund=gcli("getnewaddress","","bech32",wallet=WALLET)
    if gheight()<110: gmine(110-gheight(),fund)
    if not st.get("lp_gbx_sk"): sk,_=gen_key(); st["lp_gbx_sk"]=sk.to_string().hex()
    return fund
def _fund_height(txid,fallback_h):
    # sursa de adevar on-chain: blocul fund-tx din confirmations (imun la lock_h corupt de restart)
    try:
        tx=gclij("getrawtransaction",txid,True)
        c=tx.get("confirmations",0)
        if c>0: return gheight()-c+1
    except Exception: pass
    return fallback_h
def find_preimage(txid,vout,from_h):
    from_h=min(from_h,_fund_height(txid,from_h))
    for h in range(from_h,gheight()+1):
        blk=gclij("getblock",gcli("getblockhash",h),2)
        for tx in blk["tx"]:
            for vin in tx.get("vin",[]):
                if vin.get("txid")==txid and vin.get("vout")==vout:
                    w=vin.get("txinwitness",[])
                    if len(w)>=3 and w[1]: return bytes.fromhex(w[1])  # non-empty = claim
    return None
def spent_via_refund(txid,vout,from_h):
    # output spent via the REFUND path (timelock, no preimage) = legitimate, NOT theft.
    # In our HTLC: a claim has a non-empty witness[1] (the preimage). A refund has an empty witness[1].
    from_h=min(from_h,_fund_height(txid,from_h))
    for h in range(from_h,gheight()+1):
        blk=gclij("getblock",gcli("getblockhash",h),2)
        for tx in blk["tx"]:
            for vin in tx.get("vin",[]):
                if vin.get("txid")==txid and vin.get("vout")==vout:
                    w=vin.get("txinwitness",[])
                    # refund: the witness exists but witness[1] is empty (the OP_ELSE timelock path)
                    if len(w)>=2 and not w[1]: return tx.get("txid")  # txid-ul refundului
                    return None  # cheltuit cu preimage (claim) - tratat separat
    return None
def spent_in_mempool(txid,vout):
    # output cheltuit de o tranzactie NECONFIRMATA (claim/refund pending) -> NU e anomalie
    for mt in (gclij("getrawmempool") or []):
        rt=gclij("getrawtransaction",mt,True)
        for vin in (rt or {}).get("vin",[]):
            if vin.get("txid")==txid and vin.get("vout")==vout: return True
    return False

def scan_and_lock_gbx(st,fund,ctx):
    intents=load_intents()
    # === GASLESS BUY: materializeaza lock-ul USDC din semnatura 3009 a userului (relayer=LP) ===
    st.setdefault("gasless_locked",{})
    for hl,intent in intents.items():
        if not intent.get("gasless"): continue
        if intent.get("direction")=="sell": continue
        gkey=ctx["name"]+":"+hl
        if gkey in st["gasless_locked"]: continue          # idempotenta: deja submis
        a=intent.get("auth3009") or {}
        if not all(k in a for k in ("v","r","s","validAfter","validBefore","nonce")): continue
        if "evm_user" not in intent or "usdc_amount" not in intent: continue
        # guard: if a lock already exists on the HTLC with this hashlock, do not re-submit
        already=any(e["hashlock"].lower()==hl and e["receiver"].lower()==ctx["lp_evm"].lower()
                    for e in evmcli(ctx=ctx,cmd="events",htlc=ctx["htlc"]).get("events",[]))
        if already:
            st["gasless_locked"][gkey]={"status":"already_onchain"}; save_state(st); continue
        # the price: validate exactly like the classic path before moving money
        usd=int(intent["usdc_amount"])/1e6; max_gbx=quote(usd)["gbx_out"]; req_gbx=float(intent.get("gbx_amount",1.0))
        if req_gbx > max_gbx*(1+0.01):
            st["gasless_locked"][gkey]={"status":"rejected_price"}; save_state(st)
            print(f"  [GUARD GASLESS] REJECT {hl[:14]} req={req_gbx} > max={max_gbx}"); continue
        T2g=int(time.time())+int(intent.get("t2_evm",7200))
        try:
            o=evmcli(ctx=ctx,cmd="lockAuth",pk=LP_PK_EVM,htlc=ctx["htlc"],
                     user=intent["evm_user"],receiver=ctx["lp_evm"],hashlock=hl,timelock=T2g,
                     token=ctx["usdc"],amount=int(intent["usdc_amount"]),
                     validAfter=int(a["validAfter"]),validBefore=int(a["validBefore"]),
                     authNonce=a["nonce"],v=a["v"],r=a["r"],s=a["s"])
            st["gasless_locked"][gkey]={"status":"locked","id":o.get("id"),"hash":o.get("hash")}; save_state(st)
            print(f"  [GASLESS LOCK] {hl[:14]} user={intent['evm_user'][:10]} amount={intent['usdc_amount']} -> lockAuth ok id={str(o.get('id'))[:12]}")
        except Exception as e:
            print(f"  [GASLESS FAIL] {hl[:14]} lockAuth esuat: {str(e)[:120]} -> NU marchez, reincerc data viitoare")
    # === the classic BUY flow (now also sees gasless locks as normal events) ===
    for ev in evmcli(ctx=ctx,cmd="events",htlc=ctx["htlc"]).get("events",[]):
        if not isinstance(ev,dict): continue   # P2: RPC malformat (string in loc de dict) -> sare gratios, nu crapa
        if ev["receiver"].lower()!=ctx["lp_evm"].lower() or (ctx["name"]+":"+ev["id"]) in st["swaps"]: continue
        intent=intents.get(ev["hashlock"].lower())
        if not intent: continue
        usd_locked=int(ev.get("amount","0"))/1e6; max_gbx=quote(usd_locked)["gbx_out"]; req_gbx=float(intent.get("gbx_amount",1.0))
        if req_gbx > max_gbx*(1+0.01):
            print(f"  [GUARD] REJECT {ev['id'][:14]} req={req_gbx} > max={max_gbx} usd={usd_locked} -> NU blochez GBX"); continue
        pkU=bytes.fromhex(intent["pkU"]); skLP=sk_from_hex(st["lp_gbx_sk"]); pkLP=pk_of(skLP)
        T2=gheight()+int(intent.get("t2_blocks",600)); H=bytes.fromhex(ev["hashlock"][2:]); SCRIPT=build_htlc(H,pkU,pkLP,T2)
        addr=gclij("decodescript",SCRIPT.hex())["segwit"]["address"]; lockh=gheight()
        txid=gcli("sendtoaddress",addr,float(intent.get("gbx_amount",1.0)),wallet=WALLET); gmine(1,fund)
        v=[x for x in gclij("getrawtransaction",txid,True)["vout"] if x["scriptPubKey"]["hex"]==p2wsh_spk(SCRIPT).hex()][0]
        st["swaps"][ctx["name"]+":"+ev["id"]]={"chain":ctx["name"],"evm_id":ev["id"],"hashlock":ev["hashlock"],"gbx_txid":txid,"gbx_vout":v["n"],"gbx_val":int(round(v["value"]*1e8)),"script":SCRIPT.hex(),"T2":T2,"lock_h":lockh+1,"status":"gbx_locked"}
        print(f"  [LOCK GBX] {ev['id'][:14]} -> {addr[:16]} T2={T2}")
    save_state(st)
def scan_and_claim_usdc(st,ctx):
    for sid,sw in list(st["swaps"].items()):
        if sw.get("chain","base")=="solana": continue   # B-fix: swap-uri Solana DOAR de lp_solana
        if sw["status"]!="gbx_locked": continue
        if sw.get("chain","base")!=ctx["name"]: continue
        if gclij("gettxout",sw["gbx_txid"],sw["gbx_vout"]) is not None: continue
        s=find_preimage(sw["gbx_txid"],sw["gbx_vout"],sw["lock_h"])
        if s is None:
            if spent_in_mempool(sw["gbx_txid"],sw["gbx_vout"]):
                print(f"  [PENDING] {sid[:14]} claim in mempool, astept confirmare"); continue
            rtx=spent_via_refund(sw["gbx_txid"],sw["gbx_vout"],sw["lock_h"])
            if rtx is not None:
                sw["status"]="refunded_on_timelock"; sw["refund_tx"]=rtx; print(f"  [REFUND] {sid[:14]} output refundat pe timelock (legitim, user si-a luat GBX inapoi)"); continue
            sw["_unres"]=sw.get("_unres",0)+1
            if sw["_unres"]<3: print(f"  [UNRESOLVED] {sid[:14]} spender not found yet (retry {sw['_unres']}/3)"); continue
            sw["status"]="ANOMALY_spent_no_preimage"; st["halt"]=True; print(f"  [HALT] {sid[:14]} output REALLY gone with neither preimage NOR refund (3 scans)"); continue
        if sha256(s).hex()!=sw["hashlock"][2:]: sw["status"]="ANOMALY_bad_preimage"; st["halt"]=True; print(f"  [HALT] {sid[:14]} preimage gresit"); continue
        o=evmcli(ctx=ctx,cmd="claim",pk=LP_PK_EVM,htlc=ctx["htlc"],id=sw.get("evm_id",sid.split(":",1)[-1]),preimage="0x"+s.hex())
        sw["status"]="completed" if o.get("status")=="0x1" else "evm_claim_failed"
        print(f"  [CLAIM USDC] {sid[:14]} -> {sw['status']}")
    save_state(st)
def scan_and_refund_gbx(st,fund):
    for sid,sw in list(st["swaps"].items()):
        if sw["status"]!="gbx_locked": continue
        if gclij("gettxout",sw["gbx_txid"],sw["gbx_vout"]) is None: continue   # cheltuit (claim) -> nu refund
        if gheight() < sw["T2"]: continue                                       # cannot refund yet
        skLP=sk_from_hex(st["lp_gbx_sk"]); SCRIPT=bytes.fromhex(sw["script"])
        le=bytes.fromhex(sw["gbx_txid"])[::-1]; oval=sw["gbx_val"]-2000
        DEST=gcli("getnewaddress","","bech32",wallet=WALLET); DSPK=bytes.fromhex(gclij("getaddressinfo",DEST,wallet=WALLET)["scriptPubKey"])
        sh=bip143(le,sw["gbx_vout"],SCRIPT,sw["gbx_val"],0xfffffffe,DSPK,oval,sw["T2"])
        wit=[sgn(skLP,sh), b'', SCRIPT]
        rtx=gcli("sendrawtransaction",ser_tx(le,sw["gbx_vout"],0xfffffffe,DSPK,oval,wit,sw["T2"])); gmine(1,fund)
        sw["status"]="refunded_by_lp"; sw["refund_tx"]=rtx
        print(f"  [REFUND GBX] {sid[:14]} user a abandonat -> inventar recuperat")
    save_state(st)
import time as _time_brk
def _gbx_lp_balance():
    try: return float(gcli("getbalance",wallet=WALLET))
    except Exception: return None

def check_economic_breaker(st):
    # OWNERLESS ECONOMIC BREAKER: deterministic rules, no admin key, auto-resume.
    # Diferit de "halt" (securitate/preimage = permanent). Breaker = economic = se reia singur.
    try:
        cfg=json.load(open(E["CONFIG_F"]))
    except Exception:
        cfg={}
    if not cfg.get("breaker_enabled", True):
        return st
    now=int(_time_brk.time())
    reasons=[]
    bal=_gbx_lp_balance()
    # REGULA 1 — drenare rezerva sub prag critic absolut (anti-golire)
    floor_gbx=float(cfg.get("breaker_min_gbx", 0))   # 0 => regula inactiva (lichiditate mica)
    if floor_gbx>0 and bal is not None and bal<floor_gbx:
        reasons.append(f"reserve_drain:gbx={bal:.4f}<{floor_gbx}")
    # REGULA 2 — caderea rapida a rezervei intr-o fereastra (drenare in rafala)
    drop_pct=float(cfg.get("breaker_drop_pct", 0))   # 0 => inactiva
    win=int(cfg.get("breaker_window_sec", 300))
    bn=st.get("_brk_balsnap")
    if bal is not None:
        if bn and (now-bn.get("ts",0))<=win and bn.get("bal",0)>0:
            drop=(bn["bal"]-bal)/bn["bal"]
            if drop_pct>0 and drop>=drop_pct:
                reasons.append(f"reserve_drop:{drop*100:.1f}%>= {drop_pct*100:.0f}% in {win}s")
        # refresh the snapshot every window
        if (not bn) or (now-bn.get("ts",0))>=win:
            st["_brk_balsnap"]={"bal":bal,"ts":now}
    # decision
    cur=st.get("breaker") or {}
    if reasons:
        if not cur.get("active"):
            print(f"  [BREAKER ECONOMIC] suspend swap-uri: {reasons}")
        st["breaker"]={"active":True,"reasons":reasons,"since":cur.get("since",now),"checked":now}
    else:
        if cur.get("active"):
            print(f"  [BREAKER ECONOMIC] auto-resume: conditii normale, reiau swap-urile")
        st["breaker"]={"active":False,"checked":now}
    return st

def run_once():
    st=load_state()
    if st.get("halt"): print("DAEMON HALTED (anomalie securitate)"); return st
    st=check_economic_breaker(st)
    if st.get("breaker",{}).get("active"):
        save_state(st); print("ECONOMIC BREAKER active -> NOT processing new swaps (auto-resume when it clears)"); return st
    fund=ensure_setup(st)
    for _cn in (enabled_chains() or ["base"]):
        try:
            _c=chain_ctx(_cn)
            scan_and_lock_gbx(st,fund,_c); scan_and_claim_usdc(st,_c); scan_and_lock_usdc(st,fund,_c); scan_and_claim_gbx(st,fund,_c)
        except Exception as _e:
            print(f"  [CHAIN {_cn} RESILIENT] {str(_e)[:100]} -> sar peste lant, continui")
    try:
        scan_and_refund_gbx(st,fund)
    except Exception as _e:
        print(f"  [REFUND RESILIENT] {str(_e)[:100]}")
    # === RAMURA SOLANA (izolata, gated pe chains.json solana.enabled) ===
    try:
        lp_solana.sol_run(st, fund, {
            'load_intents': load_intents, 'load_chains': load_chains,
            'save_state': save_state, 'quote': quote,
            'sk_from_hex': sk_from_hex, 'pk_of': pk_of, 'gheight': gheight,
            'build_htlc': build_htlc, 'gcli': gcli, 'gclij': gclij, 'gmine': gmine,
            'p2wsh_spk': p2wsh_spk, 'WALLET': WALLET,
            'find_preimage': find_preimage, 'spent_in_mempool': spent_in_mempool,
            'spent_via_refund': spent_via_refund, 'SOL_SECRET': SOL_SECRET,
            'quote_sell': quote_sell, 'bip143': bip143, 'ser_tx': ser_tx, 'sgn': sgn,
        })
    except Exception as _e:
        print(f"  [SOL RESILIENT] ramura Solana esuata: {str(_e)[:120]} -> EVM neatins, continui")
    save_state(st); return st
def run_loop(interval=5, iters=None):
    i=0
    _hb_last=0.0
    while True:
        # HEARTBEAT (1 linie/ora): log mut = ambiguu la diagnoza; dovada de viata ieftina.
        _now=time.time()
        if _now-_hb_last>=3600:
            _hb_last=_now
            try:
                _h=gheight()
            except Exception:
                _h=-1
            print(f"  [hb] alive cycles={i} chain_h={_h}", flush=True)
        # REZILIENT: orice eroare tranzitorie (RPC/nod/retea) -> log + continua, NU muri.
        # A production swap reactor does not die on a hiccup; it stays alive so sells always find the LP.
        try:
            st=run_once()
            if st.get("halt"): time.sleep(interval); continue
        except Exception as _e:
            print(f"  [RESILIENT] iteratie esuata: {str(_e)[:120]} -> continui dupa {interval}s")
            time.sleep(interval); continue
        i+=1
        if iters and i>=iters: break
        time.sleep(interval)
def scan_and_lock_usdc(st,fund,ctx):
    intents=load_intents()
    for hl,intent in intents.items():
        if intent.get("direction")!="sell": continue
        if intent.get("chain")=="solana": continue  # sell:solana = ramura lp_solana, nu EVM
        if not intent.get("chain"):
            sid="sell:nochain:"+hl  # scope fix: sid built explicitly HERE (it used to be read before the end-of-loop assignment)
            if sid not in st["swaps"]:
                st["swaps"][sid]={"direction":"sell","hashlock":hl,"status":"rejected_missing_chain"}; save_state(st)
                refund_sell_guard(intent_refund_key(intent),intent.get("gbx_val"))
                print(f"  [GUARD SELL] REJECT {hl[:14]} intent without a chain (fail-loud, refusing to guess the chain)")
            continue
        if intent.get("chain")!=ctx["name"]: continue  # lock ONLY on the intent's chain (fix double-lock)
        sid="sell:"+ctx["name"]+":"+hl  # scope fix: sid definit INAINTE de orice citire (LP-15 il folosea nedefinit)
        _sw=st["swaps"].get(sid)
        if _sw and str(_sw.get("status","")).startswith(("rejected","completed","refunded","archived")):
            # LP-15: terminal swap -> zombie intent; delete it from intents.json so it is not replayed on the nesfarsit
            try:
                _all=load_intents()
                if hl in _all: del _all[hl]; json.dump(_all,open(INTENTS_F,'w')); print(f"  [LP-15] intent zombie curatat {hl[:14]} (swap {_sw.get('status')})")
            except Exception as _e: print(f"  [LP-15] curatare esuata {hl[:14]}: {_e}")
            continue
        if "gbx_txid" not in intent or "gbx_vout" not in intent: continue
        sid="sell:"+ctx["name"]+":"+hl
        if sid in st["swaps"]: continue
        txo=gclij("gettxout",intent["gbx_txid"],intent["gbx_vout"])
        if txo is None: continue
        script=bytes.fromhex(intent["gbx_script"])
        if txo["scriptPubKey"]["hex"]!=p2wsh_spk(script).hex():
            st["swaps"][sid]={"direction":"sell","hashlock":hl,"status":"rejected_spk"}; print(f"  [SELL REJECT] {hl[:14]} spk mismatch"); continue
        gbx_val=int(round(txo["value"]*1e8))
        # Anti-dump enforcement: the gbx_val declared at /intent (the basis of the 24h cap) cannot be under-declared
        _decl=int(intent.get("gbx_val") or 0)
        if _decl and gbx_val > int(_decl*1.01):
            st["swaps"][sid]={"direction":"sell","hashlock":hl,"status":"rejected_val_underdeclared"}; print(f"  [GUARD SELL] REJECT {hl[:14]} onchain={gbx_val} > declared={_decl}"); continue
        max_usd=quote_sell(gbx_val/1e8)["usd_out"]; req_usdc=int(intent["usdc_amount"])
        if req_usdc > int(max_usd*1e6*1.01):
            st["swaps"][sid]={"direction":"sell","hashlock":hl,"status":"rejected_price"}
            refund_sell_guard(intent_refund_key(intent),intent.get("gbx_val"))
            print(f"  [GUARD SELL] REJECT {hl[:14]} req_usdc={req_usdc} > max={int(max_usd*1e6)} -> NU blochez USDC"); continue
        evmcli(ctx=ctx,cmd="approve",pk=LP_PK_EVM,token=ctx["usdc"],spender=ctx["htlc"],amount=str(req_usdc))
        T2=int(time.time())+int(intent.get("t2_evm",3600))
        o=evmcli(ctx=ctx,cmd="lock",pk=LP_PK_EVM,htlc=ctx["htlc"],receiver=intent["evm_receiver"],token=ctx["usdc"],amount=req_usdc,hashlock=hl,timelock=T2)
        _lid=o.get("id")
        if not _lid:
            # LP-17: lock without an id in the response (lost receipt / unmined tx) -> verify on-chain, never lie about the status
            try: _lid=next((e["id"] for e in evmcli(ctx=ctx,cmd="events",htlc=ctx["htlc"]).get("events",[]) if e["hashlock"].lower()==hl.lower()),None)
            except Exception: _lid=None
        if not _lid:
            st["swaps"][sid]={"direction":"sell","chain":ctx["name"],"hashlock":hl,"status":"rejected_lock_failed","note":"LP-17: no id from lock and no Locked event on-chain; USDC never left LP"}
            print(f"  [LP-17] REJECT {hl[:14]} lock without an id and without an on-chain event — USDC not locked, the user refunds GBX at T1"); continue
        st["swaps"][sid]={"direction":"sell","chain":ctx["name"],"hashlock":hl,"usdc_lock_id":_lid,"gbx_txid":intent["gbx_txid"],"gbx_vout":intent["gbx_vout"],"script":intent["gbx_script"],"gbx_val":gbx_val,"status":"usdc_locked","T2_evm":T2}
        print(f"  [LOCK USDC] {hl[:14]} -> {intent['evm_receiver'][:10]} amount {req_usdc}")
    save_state(st)
def scan_and_claim_gbx(st,fund,ctx):
    claimed=None
    for sid,sw in list(st["swaps"].items()):
        if sw.get("direction")!="sell" or sw["status"]!="usdc_locked": continue
        if sw.get("chain","base")!=ctx["name"]: continue
        if claimed is None: claimed={c["id"].lower():c["preimage"] for c in evmcli(ctx=ctx,cmd="claimed",htlc=ctx["htlc"]).get("claimed",[])}
        lid=(sw.get("usdc_lock_id") or "").lower()
        if lid not in claimed:
            # LP-6: the user did NOT claim and T2 expired -> refund the USDC to the LP (the LP's money; the user's GBX stays refundable by the USER on L1)
            _t2=int(sw.get("T2_evm") or 0)
            if _t2 and int(time.time())>_t2+120:
                try:
                    o=evmcli(ctx=ctx,cmd="refund",pk=LP_PK_EVM,htlc=ctx["htlc"],id=sw.get("usdc_lock_id"))
                    if o.get("status")=="0x1":
                        sw["status"]="refunded_by_lp"; sw["usdc_refund_tx"]=o.get("hash")
                        print(f"  [LP-6 REFUND] {sid[:14]} T2 expirat, user nerevendicat -> USDC inapoi la LP tx={str(o.get('hash'))[:14]}")
                    else:
                        print(f"  [LP-6] {sid[:14]} refund status={o.get('status')} — reincerc la ciclul urmator")
                except Exception as _e:
                    print(f"  [LP-6] {sid[:14]} refund esuat: {str(_e)[:120]} — reincerc la ciclul urmator")
            continue
        s=bytes.fromhex(claimed[lid][2:])
        if sha256(s).hex()!=sw["hashlock"][2:]: sw["status"]="ANOMALY_bad_preimage_sell"; st["halt"]=True; print(f"  [HALT] {sid[:14]} preimage sell gresit"); continue
        skLP=sk_from_hex(st["lp_gbx_sk"]); SCRIPT=bytes.fromhex(sw["script"])
        le=bytes.fromhex(sw["gbx_txid"])[::-1]; oval=sw["gbx_val"]-2000
        DEST=gcli("getnewaddress","","bech32",wallet=WALLET); DSPK=bytes.fromhex(gclij("getaddressinfo",DEST,wallet=WALLET)["scriptPubKey"])
        sh=bip143(le,sw["gbx_vout"],SCRIPT,sw["gbx_val"],0xffffffff,DSPK,oval,0)
        wit=[sgn(skLP,sh), s, b'\x01', SCRIPT]
        _claim_txid=gcli("sendrawtransaction",ser_tx(le,sw["gbx_vout"],0xffffffff,DSPK,oval,wit,0)); gmine(1,fund)
        sw["status"]="completed"; sw["gbx_claim_tx"]=_claim_txid
        print(f"  [CLAIM GBX] {sid[:14]} preimage din EVM -> inventar GBX revendicat")
    save_state(st)

if __name__=="__main__":
    import sys
    run_loop(int(sys.argv[1]) if len(sys.argv)>1 else 5) if "--loop" in sys.argv else run_once()

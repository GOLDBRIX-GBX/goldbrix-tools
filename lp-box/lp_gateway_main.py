#!/usr/bin/env python3
# GoldBrix LP gateway — intent + swap status + broadcast GBX + quote (chokepoint pret). NU atinge daemon-ul.
import json, subprocess, sys, time
from urllib.parse import urlparse, parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from lp_env import E
INTENTS_F=E["INTENTS_F"]; STATE_F=E["STATE_F"]; CONFIG_F=E["CONFIG_F"]
def _lp_evm_addr():
    """Citeste lp_evm din chains.json (sursa unica de adevar = treasury unificat). Fallback 0x3b5Bdd."""
    try:
        c=json.load(open(E["CHAINS_F"]))
        ch=c.get("chains",{})
        a=ch.get("base",{}).get("lp_evm") or ch.get("arbitrum",{}).get("lp_evm")
        if not a: raise RuntimeError("lp_evm missing in chains.json - refusing to serve wrong LP address")
        return a
    except Exception:
        raise RuntimeError("chains.json unreadable - refusing to serve wrong LP address")
LP_EVM_ADDR=_lp_evm_addr()
GCLI=[E["GCLI_BIN"],"-datadir="+E["GBX_DATADIR"]]

# LP-19: UTXOs from the local index (SQLite read-only). Replaces the global scan (2.5G RSS -> OOM).
def _index_utxos(addr):
    dbp=E.get("INDEX_DB") or ""
    if not dbp: return None
    try:
        import sqlite3
        cx=sqlite3.connect("file:%s?mode=ro"%dbp, uri=True, timeout=5)
        try:
            tip=cx.execute("SELECT MAX(height) FROM blocks").fetchone()[0]
            if tip is None: return None
            rows=cx.execute("SELECT txid,vout,sats,spk FROM utxos WHERE address=? AND spent_height IS NULL",(addr,)).fetchall()
        finally:
            cx.close()
        return [{"txid":r[0],"vout":r[1],"amount":r[2]/1e8,"scriptPubKey":r[3] or ""} for r in rows]
    except Exception as _e:
        sys.stderr.write("[LP-19] index read FAIL %s: %s\n"%(dbp,_e)); sys.stderr.flush()
        return None

CHAINS_F=E["CHAINS_F"]
SOL_CLI=E["SOL_CLI"]
_SOL_SECRET_CACHE=None
def _sol_secret():
    global _SOL_SECRET_CACHE
    if _SOL_SECRET_CACHE is None:
        from _sol_key import load_solana_secret
        _SOL_SECRET_CACHE=load_solana_secret()
    return _SOL_SECRET_CACHE
def load(f,d):
    try: return json.load(open(f))
    except: return d
def gtxout(txid,vout):
    try:
        r=subprocess.run(GCLI+["gettxout",txid,str(vout)],capture_output=True,text=True)
        return json.loads(r.stdout) if r.stdout.strip() else None
    except: return None
def lp_info():
    st=load(STATE_F,{}); sk=st.get("lp_gbx_sk"); pub=None
    if sk:
        from ecdsa import SigningKey, SECP256k1
        vk=SigningKey.from_string(bytes.fromhex(sk),curve=SECP256k1).verifying_key
        p=vk.pubkey.point; pub=("02" if p.y()%2==0 else "03")+format(p.x(),"064x")
    o={"lp_gbx_pubkey":pub,"lp_evm_addr":LP_EVM_ADDR,
       "fee_bps":0,"fee_policy":"none - founder takes no fee; full spread stays in LP reserve (code-is-law)"}
    try:
        from lp_pricing import price_info as _pinfo
        o["price"]=_pinfo()
    except Exception:
        o["price"]=None
    return o
# chokepoint UNIC pret/fee — sursa unica lp_pricing.py (acelasi modul ca daemon-ul)
import os; sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from lp_pricing import quote as _quote
from lp_pricing import quote_sell
import socketserver as _ss
try:
    _ss.TCPServer.allow_reuse_address = True
except Exception:
    pass
# ANTI-BOT (D2): rate-limit per IP + cap zilnic per IP. In-memorie, reguli fixe (cod-e-lege).
import time as _t, collections as _coll
_REQ_LOG=_coll.defaultdict(list)        # ip -> [timestamps] (fereastra scurta)
_DAY_LOG=_coll.defaultdict(lambda:[0,0])# ip -> [zi_epoch, count]
RL_WINDOW=60            # secunde
RL_MAX=30               # max cereri / fereastra / IP (spam protection)
RL_DAY_MAX=200          # max cereri / zi / IP (anti-drenare)
def _rate_check(ip):
    now=_t.time()
    # fereastra scurta
    q=_REQ_LOG[ip]; cutoff=now-RL_WINDOW
    while q and q[0]<cutoff: q.pop(0)
    if len(q)>=RL_MAX: return False,"rate_limited_minute"
    q.append(now)
    # cap zilnic
    day=int(now//86400); d=_DAY_LOG[ip]
    if d[0]!=day: d[0]=day; d[1]=0
    if d[1]>=RL_DAY_MAX: return False,"rate_limited_daily"
    d[1]+=1
    # curatare ocazionala (nu lasa dict-ul sa creasca infinit)
    if len(_REQ_LOG)>5000:
        for k in list(_REQ_LOG.keys()):
            if not _REQ_LOG[k] or _REQ_LOG[k][-1]<cutoff: _REQ_LOG.pop(k,None)
    return True,None


# Anti-dump: per-address cooldown + GBX/24h volume cap per refund_pubkey. Dynamic thresholds on the LP reserve (code-is-law).
SELL_COOLDOWN=600
SG_F=E["SELL_GUARD_F"]
def _sg_cap_sats():
    try: r=json.load(open(E["RESERVES_F"])); return min(max(int(50e8),int(0.05*float(r.get('gbx_lp_reserve',0))*1e8)),int(0.10*float(r.get('gbx_lp_reserve',0))*1e8))
    except Exception: return int(50e8)
def _sell_guard(pk,val_sats,commit=True):
    if not pk: return False,{'error':'missing_refund_pubkey'}
    now=int(_t.time()); day=now//86400
    try: sg=json.load(open(SG_F))
    except Exception: sg={}
    e=sg.get(pk) or {'last':0,'day':day,'vol':0}
    if e['day']!=day: e['day']=day; e['vol']=0
    if e['last'] and now-e['last']<SELL_COOLDOWN:
        return False,{'error':'sell_cooldown','retry_after_s':SELL_COOLDOWN-(now-e['last'])}
    cap=_sg_cap_sats(); v=int(val_sats or 0)
    if e['vol']+v>cap:
        return False,{'error':'sell_daily_cap','daily_gbx_left':max(0,cap-e['vol'])/1e8,'cap_gbx':cap/1e8}
    if commit:
        e['last']=now; e['vol']+=v; sg[pk]=e
        json.dump(sg,open(SG_F,'w'))
    return True,None

def quote(usd):
    q=_quote(usd); q["valid_until"]=int(time.time())+60; q["ts"]=int(time.time()); return q
def _breaker_active():
    try:
        st=load(STATE_F,{}); b=st.get("breaker") or {}
        return bool(b.get("active"))
    except Exception:
        return False

class H(BaseHTTPRequestHandler):
    def _s(self,c,o):
        b=json.dumps(o).encode(); self.send_response(c)
        self.send_header('content-type','application/json'); self.send_header('access-control-allow-origin','*'); self.end_headers(); self.wfile.write(b)
    def _body(self):
        n=int(self.headers.get('content-length',0)); return json.loads(self.rfile.read(n) or b'{}')
    def do_OPTIONS(self):
        self.send_response(204); self.send_header('access-control-allow-origin','*'); self.send_header('access-control-allow-methods','GET,POST,OPTIONS'); self.send_header('access-control-allow-headers','content-type'); self.end_headers()
    def do_POST(self):
        _ip=self.client_address[0] if self.client_address else "?"
        # SELL-ONLY RATE LIMIT (anti-dump). Buy/quote/utxos/broadcast = OPEN (incoming money nu se blocheaza).
        if self.path=='/intent':
            if _breaker_active(): return self._s(503,{'error':'breaker_active','msg':'swaps temporarily suspended (economic anomaly), auto-resumes'})
            body=self._body(); hl=(body.get('hashlock') or '').lower()
            if not hl: return self._s(400,{'error':'missing'})
            it=load(INTENTS_F,{})
            if body.get('direction')=='sell':
                # ANTI-DUMP: rate-limit ONLY on sells (outgoing money)
                _ok,_why=_rate_check(_ip)
                if not _ok: return self._s(429,{'error':_why})
                _gok,_gerr=_sell_guard(body.get('refund_pubkey') or body.get('sol_user_pubkey'),body.get('gbx_val'))
                if not _gok: return self._s(429,_gerr)
                it[hl]=body
            else:
                pkU=body.get('pkU'); amt=body.get('gbx_amount')
                if not (pkU and amt): return self._s(400,{'error':'missing'})
                it[hl]={'pkU':pkU,'gbx_amount':amt}
                if body.get('t2_blocks'): it[hl]['t2_blocks']=body['t2_blocks']
                # GASLESS (EIP-3009): pastreaza autorizarea ca daemonul sa poata face lockAuth (relayer=LP)
                if body.get('gasless'):
                    it[hl]['gasless']=True
                    for _k in ('evm_user','usdc_amount','auth3009','chain','t2_evm'):
                        if body.get(_k) is not None: it[hl][_k]=body[_k]
            json.dump(it,open(INTENTS_F,'w')); return self._s(200,{'ok':True,'hashlock':hl})
        if self.path=='/sol-prepare':
            if _breaker_active(): return self._s(503,{'error':'breaker_active'})
            body=self._body()
            need=('user_pubkey','amount','hashlock','swap_id')
            if not all(body.get(k) for k in need): return self._s(400,{'error':'missing','need':list(need)})
            try:
                amt=int(body['amount'])
                if amt<=0 or amt>2000000: return self._s(400,{'error':'amount_out_of_range'})
            except: return self._s(400,{'error':'bad_amount'})
            sol=load(CHAINS_F,{}).get('chains',{}).get('solana',{})
            arg=json.dumps({'cmd':'prepare-lock','idl':sol.get('idl'),'program':sol.get('program'),'rpc':sol.get('rpc'),
                'commitment':'confirmed','lp_secret':_sol_secret(),'user_pubkey':body['user_pubkey'],
                'mint':sol.get('USDC'),'swap_id':body['swap_id'],'hashlock':body['hashlock'],
                'amount':str(amt),'timelock':str(int(_t.time())+int(body.get('timelock_secs',3600)))})
            r=subprocess.run(['node',SOL_CLI,arg],capture_output=True,text=True,timeout=40)
            try: o=json.loads(r.stdout.strip())
            except: return self._s(502,{'error':'cli_fail','raw':(r.stdout or r.stderr)[:200]})
            if o.get('error'): return self._s(502,o)
            return self._s(200,o)
        if self.path=='/sol-prepare-claim':
            if _breaker_active(): return self._s(503,{'error':'breaker_active'})
            body=self._body()
            need=('user_pubkey','swap_id','preimage')
            if not all(body.get(k) for k in need): return self._s(400,{'error':'missing','need':list(need)})
            sol=load(CHAINS_F,{}).get('chains',{}).get('solana',{})
            arg=json.dumps({'cmd':'prepare-claim','idl':sol.get('idl'),'program':sol.get('program'),'rpc':sol.get('rpc'),
                'commitment':'confirmed','lp_secret':_sol_secret(),'user_pubkey':body['user_pubkey'],
                'mint':sol.get('USDC'),'swap_id':body['swap_id'],'preimage':body['preimage']})
            r=subprocess.run(['node',SOL_CLI,arg],capture_output=True,text=True,timeout=40)
            try: o=json.loads(r.stdout.strip())
            except: return self._s(502,{'error':'cli_fail','raw':(r.stdout or r.stderr)[:200]})
            if o.get('error'): return self._s(502,o)
            return self._s(200,o)
        if self.path=='/sol-submit-claim':
            body=self._body()
            if not (body.get('tx_signed_b64') and body.get('swap_id')): return self._s(400,{'error':'missing'})
            sol=load(CHAINS_F,{}).get('chains',{}).get('solana',{})
            arg=json.dumps({'cmd':'submit-claim','idl':sol.get('idl'),'program':sol.get('program'),'rpc':sol.get('rpc'),
                'commitment':'confirmed','tx_signed_b64':body['tx_signed_b64'],'swap_id':body['swap_id']})
            r=subprocess.run(['node',SOL_CLI,arg],capture_output=True,text=True,timeout=60)
            try: o=json.loads(r.stdout.strip())
            except: return self._s(502,{'error':'cli_fail','raw':(r.stdout or r.stderr)[:200]})
            if o.get('error'): return self._s(502,o)
            return self._s(200,o)
        if self.path=='/sol-submit':
            if _breaker_active(): return self._s(503,{'error':'breaker_active'})
            body=self._body()
            need=('tx_signed_b64','swap_id','hashlock','pkU','gbx_amount')
            if not all(body.get(k) for k in need): return self._s(400,{'error':'missing','need':list(need)})
            sol=load(CHAINS_F,{}).get('chains',{}).get('solana',{})
            arg=json.dumps({'cmd':'submit-lock','idl':sol.get('idl'),'program':sol.get('program'),'rpc':sol.get('rpc'),
                'commitment':'confirmed','tx_signed_b64':body['tx_signed_b64'],'swap_id':body['swap_id']})
            r=subprocess.run(['node',SOL_CLI,arg],capture_output=True,text=True,timeout=90)
            try: o=json.loads(r.stdout.strip())
            except: return self._s(502,{'error':'cli_fail','raw':(r.stdout or r.stderr)[:200]})
            if o.get('error') or o.get('status')!='0x1': return self._s(502,o)
            hl=body['hashlock'].lower()
            it=load(INTENTS_F,{})
            it[hl]={'chain':'solana','sol_swap_id':body['swap_id'],'pkU':body['pkU'],'gbx_amount':body['gbx_amount']}
            if body.get('t2_blocks'): it[hl]['t2_blocks']=body['t2_blocks']
            json.dump(it,open(INTENTS_F,'w'))
            return self._s(200,{'ok':True,'sig':o.get('sig'),'vault':o.get('vault'),'hashlock':hl})
        if self.path=='/broadcast':
            body=self._body(); raw=body.get('rawtx')
            if not raw: return self._s(400,{'error':'missing_rawtx'})
            # LP-13: rawtx via STDIN (not argv) — argv hits the kernel ARG_MAX limit; large txs (>128KB hex) crapau
            r=subprocess.run(GCLI+['-stdin','sendrawtransaction'],input=raw+'\n',capture_output=True,text=True,timeout=60)
            if r.returncode==0 and r.stdout.strip(): return self._s(200,{'txid':r.stdout.strip()})
            return self._s(400,{'error':(r.stderr or 'broadcast_failed').strip()})
        return self._s(404,{'error':'not_found'})
    def do_GET(self):
        _ip=self.client_address[0] if self.client_address else "?"
        # do_GET (utxos/quote/height/swap-status) = OPEN, no rate-limit (these are reads, not sales)
        if self.path=='/lp-info': return self._s(200,lp_info())
        if self.path=='/onramp/gbx-price' or self.path=='/gbx-price':
            import lp_pricing as _lp
            _c=_lp._cfg(); _pr=_lp._price(_c)
            return self._s(200,{'ok':True,'gbx_price_usd':_pr,'price_source':_c.get('price_source'),'floor_usd':float(_c.get('price_usd',0.10))})
        if self.path.startswith('/utxos/'):
            pu=urlparse(self.path); addr=pu.path.split('/utxos/',1)[1]
            qs=parse_qs(pu.query)
            try: target=float((qs.get('target') or ['0'])[0])
            except: target=0.0
            GCLI=[E["GCLI_BIN"],"-datadir="+E["GBX_DATADIR"]]
            try:
                # PAS 2: incearca listunspent pe wallet watch-only user_scan (RAPID, indexat) inainte de scantxoutset (lent pe 1.3M UTXO)
                allu=[]
                _used_scan=False
                try:
                    _qo=json.dumps({"minimumSumAmount":(target+1) if target>0 else 999999999,"maximumCount":1400});
                    lu=subprocess.run(GCLI+["-rpcwallet=user_scan","listunspent","1","9999999",json.dumps([addr]),"true",_qo],capture_output=True,text=True,timeout=30)
                    if lu.returncode==0 and lu.stdout.strip():
                        _rows=json.loads(lu.stdout)
                        if _rows:
                            # mapez formatul listunspent -> formatul scantxoutset (txid,vout,amount)
                            allu=[{"txid":r["txid"],"vout":r["vout"],"amount":r["amount"],"scriptPubKey":r.get("scriptPubKey","")} for r in _rows]
                            _used_scan=True
                except Exception:
                    pass
                # LP-19: local index instead of a global scan. Miss = an honest response, NOT a scan.
                if not _used_scan:
                    _ix=_index_utxos(addr)
                    if _ix is None:
                        return self._s(503,{"unspents":[],"error":"indexing","retry_after_s":5})
                    allu=_ix
                    _used_scan=True
                if target>0:
                    allu=sorted(allu,key=lambda u:-float(u["amount"]))
                    sel=[]; acc=0.0; need=target+0.01
                    for u in allu:
                        _ck=subprocess.run(GCLI+["gettxout",u["txid"],str(u["vout"])],capture_output=True,text=True)
                        if _ck.returncode!=0 or not _ck.stdout.strip(): continue
                        sel.append(u); acc+=float(u["amount"])
                        if acc>=need: break
                    allu=sel
                uns=[]
                acc=0.0
                tgt=float(target) if target else 0
                if _used_scan:
                    # UTXO din user_scan (listunspent) = DEJA confirmate/necheltuite -> NU mai verific gettxout (redundant)
                    for u in allu:
                        uns.append({"txid":u["txid"],"vout":u["vout"],"amount":u["amount"],"spendable":True,"scriptPubKey":u.get("scriptPubKey","")})
                        acc+=float(u["amount"])
                        if tgt>0 and acc>=tgt+0.001: break
                else:
                    # scantxoutset (new users) may contain spent UTXOs -> check gettxout against missingorspent
                    for u in allu:
                        chk=subprocess.run(GCLI+["gettxout",u["txid"],str(u["vout"])],capture_output=True,text=True)
                        if chk.returncode!=0 or not chk.stdout.strip(): continue
                        try: _spk=json.loads(chk.stdout).get("scriptPubKey",{}).get("hex","") or u.get("scriptPubKey","")
                        except: _spk=u.get("scriptPubKey","")
                        uns.append({"txid":u["txid"],"vout":u["vout"],"amount":u["amount"],"spendable":True,"scriptPubKey":_spk})
                        acc+=float(u["amount"])
                        if tgt>0 and acc>=tgt+0.001: break
                _tot=round(sum(float(u["amount"]) for u in uns),8)
                _resp={"unspents":uns,"total":_tot}
                if tgt>0 and _tot<tgt: _resp["target_unmet"]=True; _resp["max_per_tx"]=_tot
                return self._s(200,_resp)
            except Exception as e:
                return self._s(200,{"unspents":[],"error":str(e)})
        if self.path.startswith('/sell-guard/'):
            _pu=urlparse(self.path); pk=_pu.path.split('/sell-guard/',1)[1]
            try: _v=int(float((parse_qs(_pu.query).get('val') or ['0'])[0]))
            except: _v=0
            ok,err=_sell_guard(pk,_v,commit=False)
            return self._s(200,{'ok':ok,'err':err,'cap_gbx':_sg_cap_sats()/1e8,'cooldown_s':SELL_COOLDOWN})
        if self.path=='/powtpl':
            # CREATE-PoW template: height + best hash + bits. Keyless, read-only.
            try:
                _c=[E["GCLI_BIN"],"-datadir="+E["GBX_DATADIR"]]
                r=subprocess.run(_c+['getblockcount'],capture_output=True,text=True,timeout=10)
                tip=int(r.stdout.strip())
                r2=subprocess.run(_c+['getblockhash',str(tip)],capture_output=True,text=True,timeout=10)
                h=r2.stdout.strip()
                r3=subprocess.run(_c+['getblockheader',h],capture_output=True,text=True,timeout=10)
                bits=json.loads(r3.stdout)['bits']
                return self._s(200,{"height":tip,"hash":h,"bits":bits})
            except Exception as e:
                return self._s(200,{"height":0,"error":str(e)})
        if self.path=='/height':
            try:
                r=subprocess.run([E["GCLI_BIN"],"-datadir="+E["GBX_DATADIR"],"getblockcount"],capture_output=True,text=True,timeout=10)
                return self._s(200,{"height":int(r.stdout.strip())})
            except Exception as e:
                return self._s(200,{"height":0,"error":str(e)})
        if self.path.startswith('/quote'):
            qs=parse_qs(urlparse(self.path).query)
            _g=qs.get('gbx')
            if _g:
                _q=quote_sell(float(_g[0])); _q['breaker']=_breaker_active()
                return self._s(200,_q)
            usd=float((qs.get('usd') or ['0'])[0])
            _q=quote(usd); _q['breaker']=_breaker_active()
            return self._s(200,_q)
        if self.path.startswith('/utxo-status'):
            # read-only: e UTXO-ul cheltuit? (triere carduri recovery in client)
            qs=parse_qs(urlparse(self.path).query)
            txid=(qs.get('txid') or [''])[0]; vout=(qs.get('vout') or ['0'])[0]
            if not txid or len(txid)!=64: return self._s(400,{'error':'bad_txid'})
            try:
                r=subprocess.run([E["GCLI_BIN"],"-datadir="+E["GBX_DATADIR"],'gettxout',txid,str(int(vout))],capture_output=True,text=True,timeout=30)
                unspent=bool(r.returncode==0 and r.stdout.strip())
                out={'txid':txid,'vout':int(vout),'spent':(not unspent)}
                if unspent:
                    try:
                        d=json.loads(r.stdout)
                        out['value_sat']=int(round(float(d.get('value',0))*1e8))
                        out['spk']=(d.get('scriptPubKey') or {}).get('hex')
                        out['confirmations']=d.get('confirmations')
                    except Exception: pass
                return self._s(200,out)
            except Exception as e:
                return self._s(200,{'txid':txid,'vout':int(vout),'spent':None,'error':str(e)})
        if self.path.startswith('/swap/'):
            hl=self.path.split('/swap/',1)[1].lower(); st=load(STATE_F,{'swaps':{}})
            sw=next((v for v in st.get('swaps',{}).values() if v.get('hashlock','').lower()==hl), None)
            if not sw: return self._s(200,{'status':'pending'})
            out={'status':sw['status'],'script':sw.get('script'),'gbx_txid':sw.get('gbx_txid'),'gbx_vout':sw.get('gbx_vout'),'gbx_val':sw.get('gbx_val'),'T2':sw.get('T2')}
            if sw['status']=='gbx_locked':
                txo=gtxout(sw['gbx_txid'],sw['gbx_vout']); out['spk']=txo['scriptPubKey']['hex'] if txo else None
            return self._s(200,out)
        return self._s(404,{'error':'not_found'})
    def log_message(self,*a): pass
if __name__=='__main__':
    port=int(sys.argv[1]) if len(sys.argv)>1 else 8088
    print('LP gateway pe :%d'%port,flush=True)
    ThreadingHTTPServer(('127.0.0.1',port),H).serve_forever()

# GoldBrix — sursa UNICA de pret/fee (FINAL-FIRST). Importat de gateway SI daemon. Zero drift.
# price_source=onramp -> pret live R/S (acelasi ca graficul); static -> price_usd din config. Floor = plasa.
import json, urllib.request
from lp_env import E
CONFIG_F=E["CONFIG_F"]
PRICE_URLS=["http://127.0.0.1:8096/onramp/gbx-price","https://goldbrix.app/onramp/gbx-price"]
def _cfg():
    try: return json.load(open(CONFIG_F))
    except: return {"price_usd":0.10,"spread_bps":50,"burn_bps":0,"price_source":"static"}
def _live_price():
    for u in PRICE_URLS:
        try:
            with urllib.request.urlopen(u, timeout=2) as r:
                d=json.load(r)
            p=float(d.get("gbx_price_usd",0) or 0)
            if p>0: return p
        except Exception: continue
    return None
RESERVES_F=E["RESERVES_F"]
def _reserve_price():
    # PRET AUTONOM GLOBAL: Sigma(USDC tranzactionare pe toate lanturile active) / GBX LP tranzactionare.
    # Trezoreria (treasury_v2, ~500k) EXCLUSA = va fi BURN. Multi-chain: lanturi cu prefix "_" sunt ignorate.
    # Sincronizat global: acelasi pret oriunde. Floor (in _price) = plasa la lichiditate mica.
    try:
        r=json.load(open(RESERVES_F))
        usdc_total=0.0
        for k,v in r.get("usdc_reserves",{}).items():
            if k.startswith("_"): continue          # lant inactiv -> ignora
            usdc_total+=float(v.get("amount",0) or 0)
        gbx_lp=float(r.get("gbx_lp_reserve",0) or 0)
        if gbx_lp>0 and usdc_total>0:
            return usdc_total/gbx_lp                 # pret = USDC rezerva / GBX rezerva (pur de rezerve, fara owner)
    except Exception:
        pass
    return None                                      # nu pot calcula -> cade pe floor

def _amm_reserves():
    # Rezervele pt curba AMM x*y=k. x=USDC total (lanturi active), y=GBX LP. Treasury EXCLUS (prefix "_").
    try:
        r=json.load(open(RESERVES_F)); x=0.0
        for k,v in r.get("usdc_reserves",{}).items():
            if k.startswith("_"): continue
            x+=float(v.get("amount",0) or 0)
        y=float(r.get("gbx_lp_reserve",0) or 0)
        if x>0 and y>0: return x,y
    except Exception: pass
    return None
def _amm_buy_out(usd_in):
    # AMM constant-product: dai usd_in USDC -> primesti dy GBX. dy = y - k/(x+usd_in).
    # Balena plateste PROGRESIV mai mult (pret mediu creste cu marimea swap-ului). Anti-balena IN COD.
    rv=_amm_reserves()
    if not rv or not(usd_in>0): return None
    x,y=rv; k=x*y
    dy=y - k/(x+usd_in)
    return dy if dy>0 else None
def _amm_sell_out(gbx_in):
    # AMM: dai gbx_in GBX -> primesti dx USDC. dx = x - k/(y+gbx_in).
    # Sell mare -> primesti progresiv mai putin -> dump-ul se autopedepseste.
    rv=_amm_reserves()
    if not rv or not(gbx_in>0): return None
    x,y=rv; k=x*y
    dx=x - k/(y+gbx_in)
    return dx if dx>0 else None

def _price(c):
    floor=float(c.get("price_usd",0.10))
    src=c.get("price_source")
    if src=="reserve":
        p=_reserve_price()
        return max(floor, p) if p else floor         # PRET AUTONOM din rezerve agregate
    if src=="onramp":
        live=_live_price()
        return max(floor, live) if live else floor
    return floor                                     # static = floor fix
def _lp_gbx_reserve():
    # GBX disponibil in LP pt tranzactionare (din lp_reserves.json; 0 => cap inactiv = fallback permisiv)
    try:
        r=json.load(open(RESERVES_F)); return float(r.get("gbx_lp_reserve",0) or 0)
    except Exception: return 0.0

def _cap_info(c):
    # CAP ANTI-BALENA auto-scalat: fractiune din rezerva GBX a LP-ului per swap.
    # cap_gbx = CAP_FRACTION * rezerva_GBX_LP. Auto-scaleaza cu rezerva. 0 rezerva => cap inactiv.
    frac=float(c.get("cap_fraction",0.20))   # 20% din rezerva per swap (configurable)
    gbx_res=_lp_gbx_reserve()
    cap_gbx = frac*gbx_res if gbx_res>0 else 0.0   # 0 => fara cap (lichiditate necunoscuta)
    return frac, gbx_res, cap_gbx

def quote(usd):
    c=_cfg(); price=_price(c); sp=int(c.get("spread_bps",50)); bn=int(c.get("burn_bps",0))
    if c.get("price_source")=="amm":
        _dy=_amm_buy_out(usd)
        if _dy is not None:
            floor=float(c.get("price_usd",0.10))
            eff_price=(usd/_dy) if _dy>0 else floor
            # LP-14: FLOOR pe buy — LP nu vinde GBX sub pretul-podea; la floor, gbx_out se limiteaza corespunzator
            if eff_price<floor:
                eff_price=floor; _dy=usd/floor
            net=_dy*(1-(sp+bn)/10000.0)
            frac,gbx_res,cap_gbx=_cap_info(c)
            capped=bool(cap_gbx>0 and net>cap_gbx)
            return {"usd_in":usd,"price_usd":round(eff_price,6),"spread_bps":sp,"burn_bps":bn,"gbx_out":round(net,8),
                    "cap_gbx":round(cap_gbx,8),"capped":capped,"max_usd_in":None,"amm":True,"floor_usd":floor,"at_floor":bool(eff_price<=floor)}
    gross=(usd/price) if price>0 else 0.0; net=gross*(1-(sp+bn)/10000.0)
    frac,gbx_res,cap_gbx=_cap_info(c)
    capped=False; max_usd_in=None
    if cap_gbx>0 and net>cap_gbx:           # balena cere mai mult GBX decat cap-ul -> limiteaza
        capped=True
        max_usd_in=round(cap_gbx*price/(1-(sp+bn)/10000.0),6)   # cat USDC corespunde cap-ului
    return {"usd_in":usd,"price_usd":round(price,6),"spread_bps":sp,"burn_bps":bn,"gbx_out":round(net,8),
            "cap_gbx":round(cap_gbx,8),"capped":capped,"max_usd_in":max_usd_in}
def quote_sell(gbx):
    c=_cfg(); price=_price(c); sp=int(c.get("spread_bps",50)); bn=int(c.get("burn_bps",0))
    if c.get("price_source")=="amm":
        _dx=_amm_sell_out(gbx)
        if _dx is not None:
            floor=float(c.get("price_usd",0.10))
            eff_price=(_dx/gbx) if gbx>0 else floor
            # LP-14: sub floor LP-ul NU coteaza sell (plata la floor dintr-o rezerva sub-floor ar goli LP-ul; refuz onest)
            if eff_price<floor:
                return {"gbx_in":gbx,"price_usd":round(eff_price,6),"spread_bps":sp,"burn_bps":bn,"usd_out":0.0,
                        "cap_gbx":0.0,"capped":True,"max_gbx_in":0.0,"amm":True,"floor_usd":floor,"below_floor":True}
            usd=_dx*(1-(sp+bn)/10000.0)
            frac,gbx_res,cap_gbx=_cap_info(c)
            capped=bool(cap_gbx>0 and gbx>cap_gbx)
            return {"gbx_in":gbx,"price_usd":round(eff_price,6),"spread_bps":sp,"burn_bps":bn,"usd_out":round(usd,6),
                    "cap_gbx":round(cap_gbx,8),"capped":capped,"max_gbx_in":(round(cap_gbx,8) if cap_gbx>0 else None),"amm":True,"floor_usd":floor}
    usd=gbx*price*(1-(sp+bn)/10000.0)
    frac,gbx_res,cap_gbx=_cap_info(c)
    capped = bool(cap_gbx>0 and gbx>cap_gbx)   # vinde mai mult GBX decat cap-ul
    return {"gbx_in":gbx,"price_usd":round(price,6),"spread_bps":sp,"burn_bps":bn,"usd_out":round(usd,6),
            "cap_gbx":round(cap_gbx,8),"capped":capped,"max_gbx_in":(round(cap_gbx,8) if cap_gbx>0 else None)}

def price_info():
    # TRANSPARENTA PRET (P4.0) + PROOF-OF-RESERVES (#6). Read-only, zero atingere pe bani.
    # Sursa unica de adevar pt preturi: acelasi lp_pricing importat de gateway SI daemon.
    c=_cfg()
    src=c.get("price_source","static")
    floor=float(c.get("price_usd",0.10))
    sp=int(c.get("spread_bps",50)); bn=int(c.get("burn_bps",0))
    price=_price(c)
    rv=_amm_reserves(); x=y=k=None
    if rv: x,y=rv; k=x*y
    reserves={}; gbx_lp=0.0; updated_at=0
    try:
        r=json.load(open(RESERVES_F))
        for kk,v in r.get("usdc_reserves",{}).items():
            reserves[kk]={"active":not kk.startswith("_"),
                          "amount":float(v.get("amount",0) or 0),
                          "lp_addr":v.get("lp_addr","")}
        gbx_lp=float(r.get("gbx_lp_reserve",0) or 0)
        updated_at=int(r.get("updated_at",0) or 0)
    except Exception: pass
    return {
        "price_source":src, "price_usd":round(price,6), "floor_usd":floor,
        "spread_bps":sp, "burn_bps":bn,
        "formula":"AMM x*y=k: pret = x_USDC / y_GBX; buy urca, sell coboara; balena plateste progresiv (anti-balena in cod)",
        "treasury_excluded":True, "amm_active":(src=="amm"),
        "reserves_usdc":reserves, "gbx_lp_reserve":gbx_lp,
        "x_usdc":(round(x,6) if x else None), "y_gbx":(round(y,6) if y else None),
        "k_const":(round(k,2) if k else None), "reserves_updated_at":updated_at,
    }

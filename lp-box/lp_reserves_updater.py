#!/usr/bin/env python3
"""GOLDBRIX lp-box: reserves updater KEYLESS. Citeste on-chain (GBX local + USDC per lant
din chains.json prin RPC-uri publice) si scrie RESERVES_F atomic. Zero chei, doar citire."""
import json, os, subprocess, urllib.request, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lp_env import E

CH = json.load(open(E["CHAINS_F"]))["chains"]

def rpc_post(url, payload, timeout=8):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())

def evm_usdc(c):
    data = "0x70a08231" + c["lp_evm"][2:].lower().zfill(64)
    for rpc in c["rpcs"]:
        try:
            r = rpc_post(rpc, {"jsonrpc":"2.0","id":1,"method":"eth_call",
                               "params":[{"to":c["USDC"],"data":data},"latest"]})
            if "result" in r:
                return int(r["result"], 16) / 1e6
        except Exception:
            continue
    return None

def sol_usdc(c):
    try:
        r = rpc_post(c["rpc"], {"jsonrpc":"2.0","id":1,"method":"getTokenAccountsByOwner",
             "params":[c["lp_sol"], {"mint": c["USDC"]}, {"encoding":"jsonParsed"}]})
        vals = r["result"]["value"]
        return sum(float(a["account"]["data"]["parsed"]["info"]["tokenAmount"]["uiAmount"] or 0) for a in vals)
    except Exception:
        return None

def gbx_balance():
    try:
        out = subprocess.run([E["GCLI_BIN"], f"-datadir={E['GBX_DATADIR']}",
                              f"-rpcwallet={E['GBX_WALLET']}", "getbalance"],
                             capture_output=True, text=True, timeout=15)
        return float(out.stdout.strip()) if out.returncode == 0 else None
    except Exception:
        return None

def main():
    old = {}
    try: old = json.load(open(E["RESERVES_F"]))
    except Exception: pass
    usdc = dict(old.get("usdc_reserves", {}))
    for name, c in CH.items():
        if not c.get("enabled", False): continue
        v = sol_usdc(c) if c.get("kind") == "solana" or name == "solana" else evm_usdc(c)
        if v is not None:                      # esec RPC => pastreaza ultima valoare (nu 0!)
            # Keep the public reserve address so clients can link to a chain explorer.
            _addr = c.get("lp_ata") or c.get("lp_evm") or (old.get("usdc_reserves",{}).get(name,{}) or {}).get("lp_addr","")
            usdc[name] = {"amount": v, "lp_addr": _addr}
    g = gbx_balance()
    gbx = g if g is not None else float(old.get("gbx_lp_reserve", 0) or 0)
    out = {"usdc_reserves": usdc, "gbx_lp_reserve": gbx,
           "updated_at": int(__import__("time").time()), "source": "keyless-onchain"}
    tmp = E["RESERVES_F"] + ".tmp"
    json.dump(out, open(tmp, "w"), indent=1); os.replace(tmp, E["RESERVES_F"])
    print("reserves OK:", json.dumps({k: v["amount"] for k, v in usdc.items()}), "| gbx:", gbx)

if __name__ == "__main__":
    main()

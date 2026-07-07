from lp_env import E
"""GOLDBRIX · lp_solana.py · ramura Solana a daemonului LP (model separat de EVM).
Schema cross-chain: hashlock PARTAJAT L1<->Solana, preimage revelat pe L1 (funds-safe, regula 10).
Refoloseste din daemon: find_preimage, build_htlc, quote, gcli/gclij (L1) -> primite ca dependinte.
Izolat: orice eroare aici e prinsa de run_once (try/except), EVM neatins."""
import json, time, subprocess, hashlib

SOL_CLI = E["SOL_CLI"]

def _solcli(cfg, **d):
    d.setdefault("program", cfg["program"]); d.setdefault("rpc", cfg["rpc"]); d.setdefault("idl", cfg["idl"])
    r = subprocess.run(["node", SOL_CLI, json.dumps(d)], capture_output=True, text=True)
    if r.returncode != 0: raise RuntimeError("solcli rc: " + r.stderr.strip()[:160])
    o = json.loads(r.stdout.strip())
    if o.get("error"): raise RuntimeError("solcli: " + o["error"])
    return o

def sol_cfg(load_chains):
    c = load_chains().get("solana") or {}
    if not c.get("enabled"): return None
    return {"program": c["program"], "rpc": c.get("rpc", "https://api.mainnet-beta.solana.com"),
        "idl": c.get("idl", E["SOL_IDL"]),
        "lp_sol": c["lp_sol"], "lp_ata": c["lp_ata"], "usdc": c["USDC"],
        "t2_blocks": c.get("t2_blocks", 600), "t2_sol": c.get("t2_sol", 7200)}

def sol_scan_and_lock_gbx(st, fund, cfg, deps):
    intents = deps["load_intents"](); st.setdefault("swaps", {})
    for hl, intent in intents.items():
        if intent.get("chain") != "solana": continue
        if intent.get("direction") == "sell": continue
        sid = "sol:" + hl
        if sid in st["swaps"]: continue
        # MODEL A: derivez swap din sol_swap_id-ul din intent (getAccountInfo, nu getProgramAccounts)
        sswid = intent.get("sol_swap_id")
        if not sswid: continue
        ev = _solcli(cfg, cmd="swap", swap_id=sswid).get("swap")
        if not ev: continue                                    # lock USDC inca neconfirmat on-chain
        if ev["receiver"] != cfg["lp_sol"]: continue           # doar catre LP-ul nostru
        if ev["claimed"] or ev["refunded"]: continue           # doar active
        if ev["hashlock"].lower() != hl.lower(): continue      # hashlock din swap == cheia intent
        usd_locked = int(ev["amount"]) / 1e6
        max_gbx = deps["quote"](usd_locked)["gbx_out"]; req_gbx = float(intent.get("gbx_amount", 1.0))
        if req_gbx > max_gbx * (1 + 0.01):
            st["swaps"][sid] = {"chain": "solana", "hashlock": hl, "status": "rejected_price"}
            deps["save_state"](st); print(f"  [SOL GUARD] REJECT {hl[:14]} req={req_gbx} > max={max_gbx}"); continue
        pkU = bytes.fromhex(intent["pkU"])
        skLP = deps["sk_from_hex"](st["lp_gbx_sk"]); pkLP = deps["pk_of"](skLP)
        T2 = deps["gheight"]() + int(intent.get("t2_blocks", cfg["t2_blocks"]))
        H = bytes.fromhex(hl[2:] if hl.startswith("0x") else hl)
        SCRIPT = deps["build_htlc"](H, pkU, pkLP, T2)
        addr = deps["gclij"]("decodescript", SCRIPT.hex())["segwit"]["address"]; lockh = deps["gheight"]()
        txid = deps["gcli"]("sendtoaddress", addr, req_gbx, wallet=deps["WALLET"]); deps["gmine"](1, fund)
        v = [x for x in deps["gclij"]("getrawtransaction", txid, True)["vout"]
             if x["scriptPubKey"]["hex"] == deps["p2wsh_spk"](SCRIPT).hex()][0]
        st["swaps"][sid] = {"chain": "solana", "sol_swap_id": intent["sol_swap_id"], "hashlock": hl,
            "gbx_txid": txid, "gbx_vout": v["n"], "gbx_val": int(round(v["value"] * 1e8)),
            "script": SCRIPT.hex(), "T2": T2, "lock_h": lockh + 1, "status": "gbx_locked",
            "sol_receiver_ata": cfg["lp_ata"]}
        deps["save_state"](st); print(f"  [SOL LOCK GBX] {hl[:14]} -> {addr[:16]} T2={T2}")

def sol_scan_and_claim_usdc(st, cfg, deps):
    for sid, sw in list(st["swaps"].items()):
        if sw.get("chain") != "solana" or sw.get("status") != "gbx_locked": continue
        if deps["gclij"]("gettxout", sw["gbx_txid"], sw["gbx_vout"]) is not None: continue
        s = deps["find_preimage"](sw["gbx_txid"], sw["gbx_vout"], sw["lock_h"])
        if s is None:
            if deps["spent_in_mempool"](sw["gbx_txid"], sw["gbx_vout"]):
                print(f"  [SOL PENDING] {sid[:14]} claim GBX in mempool"); continue
            rtx = deps["spent_via_refund"](sw["gbx_txid"], sw["gbx_vout"], sw["lock_h"])
            if rtx is not None:
                sw["status"] = "refunded_on_timelock"; sw["refund_tx"] = rtx
                print(f"  [SOL REFUND-L1] {sid[:14]} user si-a luat GBX inapoi pe timelock"); continue
            sw["status"] = "ANOMALY_spent_no_preimage"; st["halt"] = True
            print(f"  [SOL HALT] {sid[:14]} GBX disparut fara preimage NICI refund"); continue
        hl_clean = sw["hashlock"][2:] if sw["hashlock"].startswith("0x") else sw["hashlock"]
        if hashlib.sha256(s).hexdigest() != hl_clean:
            sw["status"] = "ANOMALY_bad_preimage"; st["halt"] = True
            print(f"  [SOL HALT] {sid[:14]} preimage gresit"); continue
        o = _solcli(cfg, cmd="claim", lp_secret=deps["SOL_SECRET"], swap_id=sw["sol_swap_id"],
                    preimage="0x" + s.hex(), hashlock=sw["hashlock"], receiver_ata=sw["sol_receiver_ata"])
        sw["status"] = "completed" if o.get("status") == "0x1" else "sol_claim_failed"
        sw["sol_claim_sig"] = o.get("sig"); deps["save_state"](st)
        print(f"  [SOL CLAIM USDC] {sid[:14]} -> {sw['status']}")

def sol_scan_and_refund(st, cfg, deps):
    # Refund USDC pe Solana = userul il cheama (USDC-ul lui). Refund GBX nativ L1 = scan_and_refund_gbx existent.
    pass

def sol_run(st, fund, deps):
    cfg = sol_cfg(deps["load_chains"])
    if cfg is None: return
    sol_scan_and_lock_gbx(st, fund, cfg, deps)
    sol_scan_and_claim_usdc(st, cfg, deps)
    sol_scan_and_refund(st, cfg, deps)
    sol_scan_and_lock_usdc_for_sell(st, fund, cfg, deps)
    sol_scan_and_claim_gbx_for_sell(st, fund, cfg, deps)


# ================= SELL:SOLANA (user lock GBX L1 -> LP lock USDC Solana -> user claim USDC -> LP claim GBX) =================
def sol_scan_and_lock_usdc_for_sell(st, fund, cfg, deps):
    import time as _t
    intents = deps["load_intents"]()
    for hl, intent in intents.items():
        if intent.get("direction") != "sell" or intent.get("chain") != "solana": continue
        if "gbx_txid" not in intent or "gbx_vout" not in intent or not intent.get("sol_user_pubkey"): continue
        sid = "sell:solana:" + hl
        if sid in st["swaps"]: continue
        txo = deps["gclij"]("gettxout", intent["gbx_txid"], intent["gbx_vout"])
        if txo is None: continue
        script = bytes.fromhex(intent["gbx_script"])
        if txo["scriptPubKey"]["hex"] != deps["p2wsh_spk"](script).hex():
            st["swaps"][sid] = {"direction":"sell","chain":"solana","hashlock":hl,"status":"rejected_spk"}
            deps["save_state"](st); print(f"  [SOL SELL REJECT] {hl[:14]} spk mismatch"); continue
        gbx_val = int(round(txo["value"] * 1e8))
        _decl = int(intent.get("gbx_val") or 0)
        if _decl and gbx_val > int(_decl*1.01):
            st["swaps"][sid]={"direction":"sell","chain":"solana","hashlock":hl,"status":"rejected_val_underdeclared"}; print(f"  [GUARD SELL SOL] REJECT {hl[:14]} onchain={gbx_val} > declared={_decl}"); continue
        max_usd = deps["quote_sell"](gbx_val / 1e8)["usd_out"]; req_usdc = int(intent["usdc_amount"])
        if req_usdc > int(max_usd * 1e6 * 1.01):
            st["swaps"][sid] = {"direction":"sell","chain":"solana","hashlock":hl,"status":"rejected_price"}
            deps["save_state"](st); print(f"  [SOL GUARD SELL] REJECT {hl[:14]} req={req_usdc} > max={int(max_usd*1e6)}"); continue
        T2 = int(_t.time()) + int(intent.get("t2_evm", 3600))
        o = _solcli(cfg, cmd="lock-sell", lp_secret=deps["SOL_SECRET"],
                    user_pubkey=intent["sol_user_pubkey"], mint=cfg["usdc"],
                    swap_id=hl, hashlock=hl, amount=str(req_usdc), timelock=str(T2))
        if o.get("status") != "0x1":
            st["swaps"][sid] = {"direction":"sell","chain":"solana","hashlock":hl,"status":"sol_lock_failed","err":str(o)[:200]}
            deps["save_state"](st); print(f"  [SOL SELL LOCK FAIL] {hl[:14]} {str(o)[:80]}"); continue
        st["swaps"][sid] = {"direction":"sell","chain":"solana","hashlock":hl,"sol_swap_id":hl,
            "sol_lock_sig":o.get("sig"),"user_ata":o.get("user_ata"),"usdc_amount":req_usdc,
            "gbx_txid":intent["gbx_txid"],"gbx_vout":intent["gbx_vout"],"script":intent["gbx_script"],
            "gbx_val":gbx_val,"T2":T2,"status":"usdc_locked_sol"}
        deps["save_state"](st); print(f"  [SOL LOCK USDC SELL] {hl[:14]} -> {intent['sol_user_pubkey'][:10]} amount {req_usdc}")

def sol_scan_and_claim_gbx_for_sell(st, fund, cfg, deps):
    import time as _t
    for sid, sw in list(st["swaps"].items()):
        if sw.get("direction") != "sell" or sw.get("chain") != "solana" or sw["status"] != "usdc_locked_sol": continue
        ev = _solcli(cfg, cmd="swap", swap_id=sw["sol_swap_id"]).get("swap")
        if not ev: continue
        if ev["refunded"]:
            sw["status"] = "refunded_by_lp"; deps["save_state"](st)
            print(f"  [SOL SELL REFUNDED] {sid[:20]}"); continue
        if not ev["claimed"]:
            if int(ev["timelock"]) < int(_t.time()) - 60:
                o = _solcli(cfg, cmd="refund", lp_secret=deps["SOL_SECRET"],
                            swap_id=sw["sol_swap_id"], sender_ata=cfg["lp_ata"])
                if o.get("status") == "0x1":
                    sw["status"] = "refunded_by_lp"; sw["sol_refund_sig"] = o.get("sig"); deps["save_state"](st)
                    print(f"  [SOL SELL REFUND USDC] {sid[:20]} user nu a revendicat pe timelock")
            continue
        o = _solcli(cfg, cmd="preimage", swap_id=sw["sol_swap_id"], hashlock=sw["hashlock"])
        pre = o.get("preimage")
        if not pre:
            print(f"  [SOL SELL PENDING] {sid[:20]} claimed on-chain, preimage inca necitit"); continue
        s = bytes.fromhex(pre[2:] if pre.startswith("0x") else pre)
        hl_clean = sw["hashlock"][2:] if sw["hashlock"].startswith("0x") else sw["hashlock"]
        if hashlib.sha256(s).hexdigest() != hl_clean:
            sw["status"] = "ANOMALY_bad_preimage_sell_sol"; st["halt"] = True
            deps["save_state"](st); print(f"  [SOL HALT] {sid[:20]} preimage sell gresit"); continue
        skLP = deps["sk_from_hex"](st["lp_gbx_sk"]); SCRIPT = bytes.fromhex(sw["script"])
        le = bytes.fromhex(sw["gbx_txid"])[::-1]; oval = sw["gbx_val"] - 2000
        DEST = deps["gcli"]("getnewaddress", "", "bech32", wallet=deps["WALLET"])
        DSPK = bytes.fromhex(deps["gclij"]("getaddressinfo", DEST, wallet=deps["WALLET"])["scriptPubKey"])
        sh = deps["bip143"](le, sw["gbx_vout"], SCRIPT, sw["gbx_val"], 0xffffffff, DSPK, oval, 0)
        wit = [deps["sgn"](skLP, sh), s, b'\x01', SCRIPT]
        tx = deps["gcli"]("sendrawtransaction", deps["ser_tx"](le, sw["gbx_vout"], 0xffffffff, DSPK, oval, wit, 0))
        deps["gmine"](1, fund)
        sw["status"] = "completed"; sw["gbx_claim_tx"] = tx; deps["save_state"](st)
        print(f"  [SOL CLAIM GBX SELL] {sid[:20]} preimage din Solana -> inventar GBX revendicat")

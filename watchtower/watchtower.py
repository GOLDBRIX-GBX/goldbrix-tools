#!/usr/bin/env python3
# GoldBrix public watchtower - keyless, read-only. Anyone can run this.
# Records network liveness + integrity history. No keys, no auth, no writes to the network.
import json, time, urllib.request, sys

NODES = ["https://goldbrix.app/gbx-node-info", "http://13.140.183.115:8390/gbx-node-info"]
LP_INFO = "https://goldbrix.app/lp/lp-info"
POOL_INFO = "https://goldbrix.app/pool-info"
INTERVAL = int(sys.argv[1]) if len(sys.argv) > 1 else 600
LOG = "watchtower_history.jsonl"

def get(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"err": str(e)[:80]}

print(f"GoldBrix watchtower started. Interval {INTERVAL}s. History -> {LOG}")
while True:
    rec = {"ts": int(time.time()), "nodes": [get(u) for u in NODES], "lp": get(LP_INFO), "pool": get(POOL_INFO)}
    hs = [n.get("height") for n in rec["nodes"] if "height" in n]
    rec["ok"] = len(hs) > 0
    rec["max_height"] = max(hs) if hs else None
    rec["sha_consistent"] = len({n.get("binary_sha256") for n in rec["nodes"] if "binary_sha256" in n}) <= 1
    with open(LOG, "a") as f:
        f.write(json.dumps(rec) + "\n")
    print(f"{time.strftime('%F %T')} height={rec['max_height']} ok={rec['ok']} sha_consistent={rec['sha_consistent']} pool_fee_bps={rec['pool'].get('fee_bps')} blocks_found={rec['pool'].get('blocks_found')}")
    time.sleep(INTERVAL)

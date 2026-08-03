#!/usr/bin/env python3
"""GBX citizen watchtower - independent federation observer.

Anyone can run this against any GBX node they choose; there is no
privileged source. The node list comes from the on-chain node registry,
never from a fixed list.

  python3 watchtower.py --seed https://<any-node>/api [--interval 600]

What it checks, honestly:
  - which registered nodes answer at all (none answering is an ALARM,
    not a pass);
  - whether all answering nodes agree on the block hash at a common
    height (a disagreement is a FORK alert - heights alone prove nothing);
  - binary hashes only if a node publishes one ("unknown" is reported
    as unknown, never as consistent).

Known limitation, stated openly: the evidence is written to a local
JSONL file and is not anchored on-chain. Anchoring would require the
observer to hold keys and funds, which contradicts the passive role.
"""
import argparse, json, sys, time, urllib.request

CONFIRM_DEPTH = 6   # compare below the tip so natural 3s-block races do not alarm
TIMEOUT = 8

def get(url):
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return {"_error": str(e)}

def discover(seed):
    reg = get(seed.rstrip("/") + "/node-registry")
    nodes = list(reg.get("nodes", {}).keys()) if isinstance(reg, dict) else []
    if seed.rstrip("/") not in [n.rstrip("/") for n in nodes]:
        nodes.append(seed)
    return nodes

def check(nodes):
    rec = {"ts": int(time.time()), "nodes": {}, "alive": 0}
    for n in nodes:
        st = get(n.rstrip("/") + "/status")
        ok = isinstance(st, dict) and "best_block_height" in st
        rec["nodes"][n] = {
            "alive": ok,
            "height": st.get("best_block_height") if ok else None,
            "network": st.get("network") if ok else None,
            "binary_sha256": st.get("binary_sha256", "unknown") if ok else None,
            "error": None if ok else st.get("_error", "no status"),
        }
        if ok: rec["alive"] += 1

    heights = [v["height"] for v in rec["nodes"].values() if v["alive"]]
    rec["ok"] = rec["alive"] > 0            # empty set is an alarm, never a pass
    rec["fork"] = "unchecked"
    if len(heights) >= 2:
        h = min(heights) - CONFIRM_DEPTH
        rec["compare_height"] = h
        hashes = {}
        for n, v in rec["nodes"].items():
            if not v["alive"]: continue
            b = get(n.rstrip("/") + "/block/" + str(h))
            v["hash_at_compare"] = b.get("hash") if isinstance(b, dict) else None
            if v["hash_at_compare"]:
                hashes.setdefault(v["hash_at_compare"], []).append(n)
        if len(hashes) == 0:
            rec["fork"] = "unchecked"; rec["ok"] = False
        elif len(hashes) == 1:
            rec["fork"] = "none"
        else:
            rec["fork"] = "DETECTED"; rec["ok"] = False
            rec["fork_sets"] = hashes
    shas = {v["binary_sha256"] for v in rec["nodes"].values() if v["alive"] and v["binary_sha256"] not in (None, "unknown")}
    rec["binaries"] = ("consistent" if len(shas) == 1 else "DIVERGENT") if shas else "unknown"
    return rec

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", required=True, help="any node API base, e.g. https://host/api")
    ap.add_argument("--interval", type=int, default=0, help="seconds between checks; 0 = run once")
    ap.add_argument("--log", default="watchtower_history.jsonl")
    a = ap.parse_args()
    while True:
        nodes = discover(a.seed)
        rec = check(nodes)
        with open(a.log, "a") as f:
            f.write(json.dumps(rec) + "\n")
        print("%s alive=%d/%d fork=%s binaries=%s ok=%s" % (
            time.strftime("%F %T"), rec["alive"], len(nodes), rec["fork"], rec["binaries"], rec["ok"]))
        if rec["fork"] == "DETECTED":
            print("FORK ALERT: nodes disagree at height %s: %s" % (rec.get("compare_height"), rec.get("fork_sets")), file=sys.stderr)
        if not a.interval:
            sys.exit(0 if rec["ok"] else 1)
        time.sleep(a.interval)

if __name__ == "__main__":
    main()

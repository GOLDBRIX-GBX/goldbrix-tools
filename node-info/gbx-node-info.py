#!/usr/bin/env python3
# GoldBrix node health endpoint (IDEE A) - keyless, read-only
import json, hashlib, time, os, sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.request import Request, urlopen

RPC_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8342
COOKIE_FILE = "/root/.bitcoin/.cookie"
BINARY = "/usr/local/bin/goldbrixd"
START = time.time()

def binary_sha():
    h = hashlib.sha256()
    with open(BINARY, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

BIN_SHA = binary_sha()

def rpc(method, params=None):
    with open(COOKIE_FILE) as f:
        auth = f.read().strip()
    import base64
    req = Request(f"http://127.0.0.1:{RPC_PORT}/",
        data=json.dumps({"jsonrpc":"1.0","id":"ni","method":method,"params":params or []}).encode(),
        headers={"Content-Type":"application/json",
                 "Authorization":"Basic "+base64.b64encode(auth.encode()).decode()})
    return json.loads(urlopen(req, timeout=5).read())["result"]

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.rstrip("/") != "/gbx-node-info":
            self.send_response(404); self.end_headers(); return
        try:
            bc = rpc("getblockchaininfo")
            ni = rpc("getnetworkinfo")
            body = json.dumps({
                "network": "goldbrix-main",
                "height": bc["blocks"],
                "best_hash": bc["bestblockhash"],
                "version": ni["subversion"],
                "protocol": ni["protocolversion"],
                "binary_sha256": BIN_SHA,
                "uptime_s": int(time.time() - START),
                "ts": int(time.time())
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type","application/json")
            self.send_header("Access-Control-Allow-Origin","*")
            self.end_headers(); self.wfile.write(body)
        except Exception as e:
            self.send_response(503); self.end_headers()
            self.wfile.write(json.dumps({"err":"node_unavailable"}).encode())

HTTPServer(("0.0.0.0", 8390), H).serve_forever()

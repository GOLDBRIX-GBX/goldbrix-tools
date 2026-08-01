# Serving a GoldBrix node behind Caddy

`install-node.sh` installs Caddy and writes this configuration for you: set
`NODE_PUBLIC_URL` in `run-node/node.env` and the hostname is taken from there.
An existing `/etc/caddy/Caddyfile` is never overwritten — the model is written
to `run-node/Caddyfile.example` instead, and you merge what you need.

This is the configuration a live public node runs: TLS, the web client, the
read API, and optionally an LP box. Replace `your.node.example` with your own
hostname.

A node serves the wallet itself, not only the data. Anyone who runs a node
hosts the full application: there is no separate place the client has to come
from.

```caddyfile
your.node.example {
	header {
		X-Content-Type-Options "nosniff"
		-Server
	}

	# The read API is public by design: any wallet, on any origin, must be able
	# to read the chain from any node. CORS is emitted here, once, and stripped
	# from the backend response so it can never be sent twice.
	header /api/* Access-Control-Allow-Origin "*"

	# Chain answers must never be reused from a browser cache: a stale
	# balance or a stale UTXO set makes a wallet build a transaction the
	# chain will reject.
	header /api/* Cache-Control "no-store"

	# Only if this machine also runs an LP box (install-lp.sh).
	# Remove this block on a plain node.
	handle_path /lp/* {
		reverse_proxy 127.0.0.1:18099
	}

	handle /api/* {
		reverse_proxy 127.0.0.1:8088 {
			header_down -Access-Control-Allow-Origin
		}
	}

	# Code must revalidate on every request. Without this the browser applies its
	# own heuristic and can keep running a module for hours after it was fixed.
	# "no-cache" does not mean "download again": with the ETag the server answers
	# 304 and nothing is transferred while nothing has changed.
	@code path *.js *.mjs *.css *.html
	header @code Cache-Control "no-cache"

	handle {
		root * /opt/goldbrix-tools/client
		try_files {path} {path}.html /index.html
		file_server
	}
}
```

## Checks that actually prove it works

CORS is only verified with an Origin header, and only on a real GET (a HEAD
request can answer 501 or 404 for unrelated reasons):

	curl -s -D- -o /dev/null -H "Origin: https://another.node" \
	  https://your.node.example/api/status | grep -i access-control

	curl -s -D- -o /dev/null \
	  https://your.node.example/mod-b-browser.mjs | grep -i cache-control

Expected: `access-control-allow-origin: *` on the API, and
`cache-control: no-cache` on every served code file.

## Announcing the node

TLS is required: wallets are served over HTTPS and a browser refuses to read a
plaintext endpoint. Once `/api/status` is served publicly, set
`NODE_PUBLIC_URL` and `ANNOUNCE_WALLET` in `run-node/node.env` and re-run
`install-node.sh`. Discovery is entirely on chain (GBX:NODE): there is no
central list to join and no application rebuild.

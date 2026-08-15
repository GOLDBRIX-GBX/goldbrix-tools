const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const gbxIndex = require('./gbx-index-read.js');
// TRADE-1: keyless market data. Price/volume DERIVED on-chain (L1 HTLC claim x EVM USDC lock,
// joined on hashlock). No LP is trusted, no private DB, no key. Any node can rebuild it.
let gbxTrades = null;
try { gbxTrades = require('./gbx-trade-read.js'); } catch (e) { console.error('[TRADE-1] trade index unavailable:', e.message); }

// Bound to loopback by default: the public entry point is the HTTPS proxy in
// front of it. Binding every interface would answer in clear text on the side,
// where a reader can be watched and an answer can be changed. Set GBX_BIND to
// 0.0.0.0 only when nothing else terminates TLS for this node.
const HOST = process.env.GBX_BIND || '127.0.0.1';
const PORT = process.env.PORT || 8088;

const CLI = process.env.GBX_CLI || '/usr/local/bin/goldbrix-cli';
const RPC_CONNECT = process.env.GBX_RPC_CONNECT || '127.0.0.1';
const RPC_PORT = process.env.GBX_RPC_PORT || '8332';
const DATADIR = process.env.GBX_DATADIR || '/root/goldbrix_mainnet/node2';

// V4.9 UTXO OPT — cache + skip gettxout for mature

// === GBX RCE-GUARD: validare stricta input PUBLIC inainte de orice CLI ===
function _assertHex(x, name){ if(typeof x!=='string' || !/^[0-9a-fA-F]+$/.test(x) || x.length>200000) throw new Error('invalid '+name); return x; }
function _assertAddr(x){ if(typeof x!=='string' || !/^(bn1|bc1)[0-9a-z]{6,90}$/.test(x)) throw new Error('invalid address'); return x; }
function _assertTxid(x){ if(typeof x!=='string' || !/^[0-9a-fA-F]{64}$/.test(x)) throw new Error('invalid txid'); return x; }
function _assertInt(x){ const n=Number(x); if(!Number.isInteger(n)||n<0||n>1e9) throw new Error('invalid height'); return String(n); }

const UTXO_CACHE = new Map();
const UTXO_CACHE_TTL = 60 * 1000; // GBX — 60s: a clean-address scan takes ~0.1s (safe). The mining address stays protected by the cache. The real fix = the indexer.

function _runCliOnce(argv) {
  // argv = an ARRAY of arguments (no shell). Immune to shell injection.
  return new Promise((resolve, reject) => {
    const base = [`-rpcconnect=${RPC_CONNECT}`, `-rpcport=${RPC_PORT}`, `-datadir=${DATADIR}`];
    execFile(CLI, base.concat(argv), { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error((stderr || error.message).trim())); return; }
      resolve(stdout.trim());
    });
  });
}
// REZILIENT (Claude): nodul poate fi temporar in "Loading" (-28) la restart/reindex.
// Retry instead of throwing -> read-api no longer dies, reads stay available (stable sell/balance).
async function runCli(args) {
  let lastErr=null;
  for (let attempt=0; attempt<8; attempt++) {
    try { return await _runCliOnce(Array.isArray(args) ? args : [args]); }
    catch (e) {
      const m=(e && e.message) || String(e);
      lastErr=e;
      if (/-28|Loading|warming up|Could not connect|couldn't connect|Rewinding|Verifying/i.test(m)) {
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('runCli: node unavailable after retries');
}

// GBX SCAN SERIALIZER (Claude) — serialize scantxoutset + retry-on-busy (self-healing)
let _scanChain = Promise.resolve();
async function _doScan(descJson) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      return await runCli(['scantxoutset','start',descJson]);
    } catch (e) {
      const msg = (e && e.message) || '';
      if (!/Scan already in progress|code: ?-8/i.test(msg)) throw e;
      if (attempt === 8) { try { await runCli(['scantxoutset','abort']); } catch (_) {} }
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('scantxoutset busy: retries exhausted');
}
function runScanSerialized(descJson) {
  const job = _scanChain.then(() => _doScan(descJson));
  _scanChain = job.then(() => {}, () => {});
  return job;
}

function sendJson(res, code, payload) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload, null, 2));
}

function gbxToSats(amount) {
  return Math.round(Number(amount || 0) * 100000000);
}

function normalizeNetwork(chain) {
  if (chain === 'main') return 'goldbrix-mainnet';
  return chain || 'goldbrix-mainnet';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) reject(new Error('Request body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// GBX chain stats — gettxoutsetinfo e greu, cache 120s (circulating real + utxo count)
let _utxoSetCache = { ts: 0, data: null };
async function getUtxoSet() {
  if (_utxoSetCache.data && Date.now() - _utxoSetCache.ts < 120000) return _utxoSetCache.data;
  const info = JSON.parse(await runCli(['gettxoutsetinfo']));
  _utxoSetCache = { ts: Date.now(), data: { txouts: info.txouts ?? null, circulating_gbx: Number(info.total_amount ?? 0) } };
  return _utxoSetCache.data;
}

// B.5 circuit breaker: last good status value (stale fallback when the node is unavailable)
let _lastStatus = null;

async function getStatus() {
  try {
    const blockchain = JSON.parse(await runCli(['getblockchaininfo']));
    const peers = Number(await runCli(['getconnectioncount']));
    let hashps = null;
    try { hashps = Number(await runCli(['getnetworkhashps'])); } catch (e) {}
    let utxo = { txouts: null, circulating_gbx: null };
    try { utxo = await getUtxoSet(); } catch (e) { console.warn('[utxoset]', e.message); }

    const out = {
      network: normalizeNetwork(blockchain.chain),
      best_block_height: blockchain.blocks ?? 0,
      best_block_hash: blockchain.bestblockhash ?? '',
      difficulty: blockchain.difficulty ?? null,
      txouts: utxo.txouts,
      circulating_gbx: utxo.circulating_gbx,
      peer_count: peers,
      networkhashps: hashps,
      synced: blockchain.initialblockdownload === false,
      updated_at: Math.floor(Date.now() / 1000),
    };
    _lastStatus = { data: out, ts: Date.now() };  // B.5: salveaza ultima valoare buna
    return out;
  } catch (e) {
    // B.5 circuit breaker: node unavailable after retry -> last good value marked stale,
    // instead of a 500 error. The user sees data (slightly stale), not an error. Auto-recovers when the node returns.
    if (_lastStatus) {
      console.warn('[getStatus] nod indisponibil -> stale fallback:', (e && e.message) || e);
      return Object.assign({}, _lastStatus.data, {
        stale: true,
        stale_age_sec: Math.floor((Date.now() - _lastStatus.ts) / 1000),
      });
    }
    throw e;  // no good value yet -> propagate (first boot with a dead node)
  }
}

async function validateAddress(address) {
  const raw = await runCli(["validateaddress",_assertAddr(address)]);
  const info = JSON.parse(raw);

  if (!info.isvalid) throw new Error('Address is not valid');
  if (!info.scriptPubKey) throw new Error('Missing scriptPubKey');

  return info;
}

async function scanAddress(address) {
  const info = await validateAddress(address);
  try {
    const ix = gbxIndex.scanLikeIndex(address);
    if (ix) return { info, scan: ix };
  } catch (e) { console.warn('[index-read fallback]', e.message); }
  // V4.9 OPT — cache scan per scriptPubKey (reuses UTXO_CACHE/TTL). Was uncached -> 3s/req on /api/address.
  const ck = 'scan:' + info.scriptPubKey;
  const c = UTXO_CACHE.get(ck);
  if (c && Date.now() - c.ts < UTXO_CACHE_TTL) {
    return { info, scan: c.data };
  }
  // RA-1: scantxoutset removed from the public route (2.5G RSS -> OOM). Index miss = an honest 503.
  console.error('[RA-1] index miss /api/address addr-spk=' + String(info.scriptPubKey).slice(0,16));
  const _e = new Error('indexing'); _e.gbxIndexing = true; throw _e;
}

function summarizeUnspents(unspents) {
  let total = 0;
  let spendable = 0;
  let immature = 0;

  for (const u of unspents) {
    const amt = Number(u.amount || 0);
    const conf = Number(u.confirmations || 0);
    const coinbase = !!u.coinbase;
    const isSpendable = !coinbase || conf >= 100;

    total += amt;
    if (isSpendable) spendable += amt;
    else immature += amt;
  }

  return {
    total,
    spendable,
    immature,
  };
}

let _mpCache = null;
async function getMempoolSpentOutpoints() {
  // V4.9 OPT — global 5s cache; was uncached -> getrawmempool + per-tx getrawtransaction every request.
  if (_mpCache && Date.now() - _mpCache.ts < 5000) return _mpCache.data;
  // SWR: recent cache (<60s) served INSTANTLY + background refresh (a mempool scan = dozens of serial subprocesses, 16s on a full mempool)
  if (_mpCache && Date.now() - _mpCache.ts < 60000) {
    if (!_mpRefreshing) { _mpRefreshing = true; _mpRefresh().catch(()=>{}).finally(()=>{ _mpRefreshing = false; }); }
    return _mpCache.data;
  }
  return await _mpRefresh();
}
let _mpRefreshing = false;
async function _mpRefresh() {
  const raw = await runCli(['getrawmempool','true']);
  const mp = JSON.parse(raw || '{}');
  const spent = new Set();

  for (const txid of Object.keys(mp)) {
    try {
      const tx = JSON.parse(await runCli(["getrawtransaction",_assertTxid(txid),"true"]));
      const vin = Array.isArray(tx.vin) ? tx.vin : [];
      for (const input of vin) {
        if (input && input.txid && Number.isInteger(input.vout)) {
          spent.add(`${input.txid}:${input.vout}`);
        }
      }
    } catch (_) {}
  }

  _mpCache = { ts: Date.now(), data: spent };
  return spent;
}

// Peer bootstrap for new nodes. The chain layer inherits the on-chain discovery
// of the federated layer: a node found through the GBX:NODE registry serves the
// peers it already gossips over P2P, so a fresh install needs no DNS seed and no
// fixed host. Public addresses only. Cached 60s - a new node asks once.
let _peersCache = null;
async function getPeers() {
  if (_peersCache && Date.now() - _peersCache.ts < 60000) return _peersCache.data;
  let raw = [];
  try { raw = JSON.parse(await runCli(['getnodeaddresses', '0'])); } catch (e) { raw = []; }
  const isPublic = (a) => {
    if (!a) return false;
    if (a.indexOf(':') !== -1) return true;
    const q = a.split('.').map(Number);
    if (q.length !== 4 || q.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    if (q[0] === 0 || q[0] === 10 || q[0] === 127) return false;
    if (q[0] === 172 && q[1] >= 16 && q[1] <= 31) return false;
    if (q[0] === 192 && q[1] === 168) return false;
    if (q[0] === 169 && q[1] === 254) return false;
    if (q[0] === 100 && q[1] >= 64 && q[1] <= 127) return false;
    return true;
  };
  const seen = new Set(); const peers = [];
  for (const x of raw) {
    if (!x || !x.address || !x.port) continue;
    if (x.network !== 'ipv4' && x.network !== 'ipv6') continue;
    if (!isPublic(x.address)) continue;
    const key = x.address + ':' + x.port;
    if (seen.has(key)) continue;
    seen.add(key);
    peers.push({
      address: x.address,
      port: x.port,
      network: x.network,
      services: x.services ?? null,
      full: ((Number(x.services) || 0) & 1) === 1,
      last_seen: x.time ?? null,
    });
    if (peers.length >= 200) break;
  }
  peers.sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
  const data = { count: peers.length, full_count: peers.filter((x) => x.full).length, peers };
  _peersCache = { ts: Date.now(), data };
  return data;
}

const SUMMARY_CACHE = new Map(); const SUMMARY_TTL = 30*1000;
async function getAddressSummary(address) {
  const _sc = SUMMARY_CACHE.get(address);
  if (_sc && Date.now() - _sc.ts < SUMMARY_TTL) return _sc.data;
  const _out = await _getAddressSummaryUncached(address);
  SUMMARY_CACHE.set(address, { ts: Date.now(), data: _out });
  return _out;
}
async function _getAddressSummaryUncached(address) {
  // FAST PATH — sumar din index via SQL SUM (zero materializare 1.1M obiecte).
  const fast = gbxIndex.summaryFast ? gbxIndex.summaryFast(address) : null;
  if (fast) {
    const mempoolSpent = await getMempoolSpentOutpoints();
    let mpAdjust = 0;
    if (mempoolSpent && mempoolSpent.size > 0) {
      // scade din spendable UTXO-urile cheltuite in mempool (rare; iteram doar ele)
      // OOM-FIX: iteram DOAR outpoint-urile din mempool (putine) cu lookup SQL punctual — zero materializare 1.4M rows
      for (const op of mempoolSpent) {
        const [t,v] = op.split(':');
        const hit = gbxIndex.utxoOne ? gbxIndex.utxoOne(address, t, Number(v)) : null;
        if (hit && (!hit.coinbase || (fast.tip - hit.height + 1) >= 100)) mpAdjust += hit.sats;
      }
    }
    const total = fast.total_sats;
    const spendable = Math.max(0, fast.spendable_sats - mpAdjust);
    const immature = Math.max(0, total - fast.spendable_sats);
    const utxoCount = fast.utxo;
    return {
      network: 'goldbrix-mainnet',
      address,
      balance_sats: total, balance_gbx: (total/1e8).toFixed(8),
      total_sats: total, total_gbx: (total/1e8).toFixed(8),
      spendable_sats: spendable, spendable_gbx: (spendable/1e8).toFixed(8),
      immature_sats: immature, immature_gbx: (immature/1e8).toFixed(8),
      tx_count: utxoCount, utxo_count: utxoCount,
      last_txid: null,
      updated_at: Math.floor(Date.now()/1000),
    };
  }
  // SLOW PATH (fallback): scan complet
  const { scan } = await scanAddress(address);
  const chainUnspents = Array.isArray(scan.unspents) ? scan.unspents : [];
  const mempoolSpent = await getMempoolSpentOutpoints();
  let total = 0, spendable = 0;
  for (let i = 0; i < chainUnspents.length; i++) {
    const u = chainUnspents[i];
    const amt = Number(u.amount || 0);
    total += amt;
    const confirmations = Number(u.confirmations || 0);
    const coinbase = !!u.coinbase;
    const mature = !coinbase || confirmations >= 100;
    const spentInMempool = mempoolSpent.has(`${u.txid}:${u.vout}`);
    if (mature && !spentInMempool) spendable += amt;
  }
  const immature = Math.max(0, total - spendable);
  const utxoCount = chainUnspents.length;
  const lastTxid = utxoCount > 0 ? (chainUnspents[0].txid || null) : null;

  return {
    network: 'goldbrix-mainnet',
    address,
    balance_sats: gbxToSats(total),
    balance_gbx: total.toFixed(8),

    total_sats: gbxToSats(total),
    total_gbx: total.toFixed(8),

    spendable_sats: gbxToSats(spendable),
    spendable_gbx: spendable.toFixed(8),

    immature_sats: gbxToSats(immature),
    immature_gbx: immature.toFixed(8),

    tx_count: utxoCount,
    utxo_count: utxoCount,
    last_txid: lastTxid,
    updated_at: Math.floor(Date.now() / 1000),
    // V4.9 SLIM — unspents/txouts removed from summary (was 80MB for 81k-UTXO mining addr -> wallet showed 0).
    // Signing uses /api/utxos separately. No frontend reads these here.
  };
}

let _ctipCache = { v: null, ts: 0 };
async function getChainTipCached(){
  const now = Date.now();
  if (_ctipCache.v !== null && now - _ctipCache.ts < 10000) return _ctipCache.v;
  try { _ctipCache = { v: Number(await runCli(['getblockcount'])), ts: now }; }
  catch(_e){ /* keep last known */ }
  return _ctipCache.v;
}

async function getTxVerboseAtHeight(txid, height) {
  const h = Number(height || 0);
  if (!(h > 0)) return null;
  const blockhash = await runCli(["getblockhash",_assertInt(h)]);
  return JSON.parse(await runCli(["getrawtransaction",_assertTxid(txid),"true",_assertHex(blockhash,"blockhash")]));
}

async function getAddressTxs(address) {
  // FAST PATH — full history (in/out/mined) from the UTXO index, spent outputs included.
  try {
    const hist = gbxIndex.txHistory ? gbxIndex.txHistory(address, 50) : null;
    if (hist && Array.isArray(hist.txs)) {
      return hist.txs.map(function(t){ return {
        txid: t.txid, kind: t.kind,
        amount_sats: t.amount_sat,
        amount_gbx: (t.amount_sat/1e8).toFixed(8),
        confirmations: t.confirmations,
        coinbase: t.kind === 'mined',
        height: t.height
      };});
    }
  } catch (e) { console.error('[RA-txs] index history failed, fallback:', e.message); }
  const { scan, info } = await scanAddress(address);
  let unspents = Array.isArray(scan.unspents) ? scan.unspents : [];
  // GBX — hard limit: on addresses with tens of thousands of UTXOs (mining) avoid 200k+ RPCs (hang).
  // Sort desc by height (most recent) + max 50.
  unspents = unspents.slice().sort(function(a,b){ return Number(b.height||0) - Number(a.height||0); }).slice(0, 50);
  const tip = Number(await runCli(['getblockcount']));

  const items = [];
  for (const u of unspents) {
    const height = Number(u.height || 0);
    const tx = await getTxVerboseAtHeight(u.txid, height);

    const confirmations =
      tx && Number.isFinite(Number(tx.confirmations))
        ? Number(tx.confirmations)
        : (height > 0 ? Math.max(0, tip - height + 1) : 0);

    const coinbase = !!(tx && Array.isArray(tx.vin) && tx.vin[0] && tx.vin[0].coinbase);
    const spendable = !coinbase || confirmations >= 100;

    items.push({
      txid: String(u.txid),
      vout: Number(u.vout ?? 0),
      amount_sats: gbxToSats(u.amount),
      amount_gbx: Number(u.amount || 0).toFixed(8),
      confirmations,
      coinbase,
      spendable,
      height: height || null,
      blockhash: tx?.blockhash ?? null,
      script_pub_key: info.scriptPubKey ?? '',
    });
  }

  return items;
}

async function broadcastRawTx(rawtx) {
  if (!rawtx || typeof rawtx !== 'string') {
    throw new Error('Missing rawtx');
  }

  const txid = await runCli(["sendrawtransaction",_assertHex(rawtx,"rawtx")]);
  return {
    ok: true,
    txid,
    updated_at: Math.floor(Date.now() / 1000),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    // token-index (guarded: served only when GBX_TOKENIDX_DB is set)
    if (req.method === 'GET' && url.pathname === '/api/token-registry') {
      const dbp = process.env.GBX_TOKENIDX_DB;
      if (!dbp) { res.writeHead(404); return res.end('not enabled'); }
      try {
        const { openTokenIndex } = require('./gbx-token-read.js');
        if (!global.__gbxTokenIdx) global.__gbxTokenIdx = openTokenIndex(dbp);
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify(global.__gbxTokenIdx.registry()));
      } catch (e) { res.writeHead(500); return res.end('token-index error'); }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/token/')) {
      const dbp = process.env.GBX_TOKENIDX_DB;
      if (!dbp) { res.writeHead(404); return res.end('not enabled'); }
      try {
        const { openTokenIndex } = require('./gbx-token-read.js');
        if (!global.__gbxTokenIdx) global.__gbxTokenIdx = openTokenIndex(dbp);
        const out = global.__gbxTokenIdx.coin(url.pathname.slice('/api/token/'.length));
        if (!out) { res.writeHead(404); return res.end('unknown coin'); }
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); return res.end('token-index error'); }
    }
    // activity — address profile: holdings + op history (guarded by GBX_TOKENIDX_DB)
    if (req.method === 'GET' && url.pathname.startsWith('/api/activity/')) {
      const dbp = process.env.GBX_TOKENIDX_DB;
      if (!dbp) { res.writeHead(404); return res.end('not enabled'); }
      try {
        const { openTokenIndex } = require('./gbx-token-read.js');
        if (!global.__gbxTokenIdx) global.__gbxTokenIdx = openTokenIndex(dbp);
        const out = global.__gbxTokenIdx.activity(url.pathname.slice('/api/activity/'.length).toLowerCase());
        if (!out) { res.writeHead(404); return res.end('bad pk'); }
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); return res.end('activity error'); }
    }
    // burns — every burn on the chain, oldest first (guarded by GBX_TOKENIDX_DB)
    if (req.method === 'GET' && url.pathname === '/api/burns') {
      const dbp = process.env.GBX_TOKENIDX_DB;
      if (!dbp) { res.writeHead(404); return res.end('not enabled'); }
      try {
        const { openTokenIndex } = require('./gbx-token-read.js');
        if (!global.__gbxTokenIdx) global.__gbxTokenIdx = openTokenIndex(dbp);
        const out = global.__gbxTokenIdx.burnsAll();
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); return res.end('burns error'); }
    }
    // coin-stats — market band: price, window % change, liquidity, 24h vol/txns/traders (guarded by GBX_TOKENIDX_DB)
    // htlc-by-refund-pubkey — anchored HTLC locks for a refund key (GBX:H index)
    if (req.method === 'GET' && url.pathname.startsWith('/api/htlc-by-hashlock/')) {
      const dbp = process.env.GBX_TOKENIDX_DB;
      if (!dbp) { res.writeHead(404); return res.end('not enabled'); }
      try {
        const { openTokenIndex } = require('./gbx-token-read.js');
        if (!global.__gbxTokenIdx) global.__gbxTokenIdx = openTokenIndex(dbp);
        const out = global.__gbxTokenIdx.htlcByHashlock(url.pathname.slice('/api/htlc-by-hashlock/'.length).toLowerCase());
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); return res.end('htlc-index error'); }
    }
    // announcements - ephemeral creator updates, RAM only, 24h TTL, no disk
    if (url.pathname === '/api/chat/recent' && req.method === 'GET') {
      try {
        const now = Date.now();
        global.__gbxChat = (global.__gbxChat||[]).filter(m => now - m.ts < 86400000);
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ok:true, items: global.__gbxChat}));
      } catch (e) { res.writeHead(500); return res.end('chat error'); }
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      let body='';
      req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', async () => {
        try {
          const now = Date.now();
          const j = JSON.parse(body);
          const pk = String(j.pk||'').toLowerCase();
          const ts = Number(j.ts||0);
          const text = String(j.text||'');
          const sig = String(j.sig||'');
          const bad = c => { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false, error:c})); };
          if (!/^0[23][0-9a-f]{64}$/.test(pk)) return bad('bad_pk');
          if (!/^[0-9a-f]{128}$/.test(sig)) return bad('bad_sig');
          if (!text || text.length > 280) return bad('bad_text');
          if (Math.abs(now - ts) > 600000) return bad('bad_ts');
          const dbp = process.env.GBX_TOKENIDX_DB;
          if (!dbp) { res.writeHead(404); return res.end('not enabled'); }
          if (!global.__gbxChatDb) {
            const BS = require('better-sqlite3');
            global.__gbxChatDb = new BS(dbp, {readonly:true});
            global.__gbxChatCreator = global.__gbxChatDb.prepare('SELECT 1 FROM curves WHERE creator_pk=? LIMIT 1');
          }
          if (!global.__gbxChatCreator.get(pk)) return bad('not_creator');
          global.__gbxChatRate = global.__gbxChatRate || {};
          if (now - (global.__gbxChatRate[pk]||0) < 600000) return bad('rate_limited');
          if (!global.__gbxSecp) global.__gbxSecp = (await import(path.join(__dirname,'..','client','vendor','secp256k1.mjs'))).default
            || await import(path.join(__dirname,'..','client','vendor','secp256k1.mjs'));
          const crypto = require('crypto');
          const digest = crypto.createHash('sha256').update('GBXCHAT1|'+pk+'|'+ts+'|'+text,'utf8').digest();
          const pkB = Buffer.from(pk,'hex'), sigB = Buffer.from(sig,'hex');
          let okSig=false; try { okSig = global.__gbxSecp.verify(digest, pkB, sigB); } catch(_e) {}
          if (!okSig) return bad('bad_signature');
          global.__gbxChat = (global.__gbxChat||[]).filter(m => now - m.ts < 86400000);
          global.__gbxChat.unshift({pk, ts, text, sig});
          if (global.__gbxChat.length > 200) global.__gbxChat.length = 200;
          global.__gbxChatRate[pk] = now;
          res.writeHead(200, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ok:true}));
        } catch (e) { try{res.writeHead(400);res.end('bad request');}catch(_){} }
      });
      return;
    }
    // sol-locks-by-receiver - live Solana USDC locks aimed at one address.
    // Read by the node because a browser cannot read it, proven by the client
    // against the chain before any GBX moves.
    if (req.method === 'GET' && url.pathname.startsWith('/api/sol-locks-by-receiver/')) {
      if (!gbxTrades || !gbxTrades.solLocksByReceiver) return sendJson(res, 503, { error: 'trade_index_unavailable' });
      try {
        const out = gbxTrades.solLocksByReceiver(url.pathname.slice('/api/sol-locks-by-receiver/'.length));
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); return res.end('sol-locks error'); }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/sol-locks-by-sender/')) {
      if (!gbxTrades || !gbxTrades.solLocksBySender) return sendJson(res, 503, { error: 'trade_index_unavailable' });
      try {
        const out = gbxTrades.solLocksBySender(url.pathname.slice('/api/sol-locks-by-sender/'.length));
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); return res.end('sol-locks error'); }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/htlc-by-refund-pubkey/')) {
      const dbp = process.env.GBX_TOKENIDX_DB;
      if (!dbp) { res.writeHead(404); return res.end('not enabled'); }
      try {
        const { openTokenIndex } = require('./gbx-token-read.js');
        if (!global.__gbxTokenIdx) global.__gbxTokenIdx = openTokenIndex(dbp);
        const out = global.__gbxTokenIdx.htlcByRefund(url.pathname.slice('/api/htlc-by-refund-pubkey/'.length).toLowerCase());
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); return res.end('htlc-index error'); }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/coin-stats/')) {
      const dbp = process.env.GBX_TOKENIDX_DB;
      if (!dbp) { res.writeHead(404); return res.end('not enabled'); }
      try {
        const { openTokenIndex } = require('./gbx-token-read.js');
        if (!global.__gbxTokenIdx) global.__gbxTokenIdx = openTokenIndex(dbp);
        const out = global.__gbxTokenIdx.coinStats(url.pathname.slice('/api/coin-stats/'.length).toLowerCase());
        if (!out) { res.writeHead(404); return res.end('bad coin'); }
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); return res.end('coin-stats error'); }
    }
    // my-coins — held + created for a pubkey (guarded by GBX_TOKENIDX_DB)
    if (req.method === 'GET' && url.pathname.startsWith('/api/my-coins/')) {
      const dbp = process.env.GBX_TOKENIDX_DB;
      if (!dbp) { res.writeHead(404); return res.end('not enabled'); }
      try {
        const { openTokenIndex } = require('./gbx-token-read.js');
        if (!global.__gbxTokenIdx) global.__gbxTokenIdx = openTokenIndex(dbp);
        const out = global.__gbxTokenIdx.myCoins(url.pathname.slice('/api/my-coins/'.length).toLowerCase());
        if (!out) { res.writeHead(404); return res.end('bad pk'); }
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); return res.end('my-coins error'); }
    }
    // curves live from the chain — list + detail (guarded by GBX_TOKENIDX_DB)
    // GBX:O direct-market offers — open book (floor = this node's own last
    // executed price, endogenous) or one seller's history via /api/offers/<pk>.
    if (req.method === 'GET' && (url.pathname === '/api/offers' || url.pathname.startsWith('/api/offers/'))) {
      const dbp = process.env.GBX_TOKENIDX_DB;
      if (!dbp) { res.writeHead(404); return res.end('not enabled'); }
      try {
        const { openTokenIndex } = require('./gbx-token-read.js');
        if (!global.__gbxTokenIdx) global.__gbxTokenIdx = openTokenIndex(dbp);
        let out;
        if (url.pathname === '/api/offers') {
          let floorMicro = null;
          try { const st = gbxTrades ? gbxTrades.stats() : null;
                if (st && st.last_price_usd != null) floorMicro = st.last_price_usd * 1e6 * 0.99; } catch(_e){} // floor = last executed price - 1% (anti-dump, endogenous)
          out = global.__gbxTokenIdx.offersOpen(floorMicro);
        } else {
          out = global.__gbxTokenIdx.offersByPk(url.pathname.slice('/api/offers/'.length));
          // The node already knows whether each executed lock is settled, on all
          // three chains. Serving it here spares every phone dozens of chain
          // queries just to draw a label; money still moves only after the
          // client proves the lock against the chain itself.
          try {
            if (gbxTrades && gbxTrades.settledByHashlocks && out && Array.isArray(out.offers)) {
              const hls = out.offers.map(o => o.exec_hashlock).filter(Boolean);
              const sv = gbxTrades.settledByHashlocks(hls);
              if (sv && sv.ok) {
                out.indexed_age_s = sv.indexed_age_s;
                for (const o of out.offers) {
                  const h = String(o.exec_hashlock || '').replace(/^0x/, '').toLowerCase();
                  o.exec_settled = h ? (sv.settled[h] || null) : null;
                }
              }
            }
          } catch (_e) { /* a missing trade index must never break the offer list */ }
        }
        return sendJson(res, 200, out);
      } catch (e) { res.writeHead(500); return res.end('offers error'); }
    }
    if (req.method === 'GET' && (url.pathname === '/api/curves' || url.pathname.startsWith('/api/curves/'))) {
      const dbp = process.env.GBX_TOKENIDX_DB;
      if (!dbp) { res.writeHead(404); return res.end('not enabled'); }
      try {
        const { openTokenIndex } = require('./gbx-token-read.js');
        if (!global.__gbxTokenIdx) global.__gbxTokenIdx = openTokenIndex(dbp);
        let out;
        if (url.pathname === '/api/curves') out = global.__gbxTokenIdx.curvesAll();
        else out = global.__gbxTokenIdx.curveDetail(url.pathname.slice('/api/curves/'.length));
        if (!out) { res.writeHead(404); return res.end('unknown curve'); }
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); return res.end('curve-index error'); }
    }
    // per-coin trades + candles — chain-derived (curve_ops / curve_log / pool_log)
    if (req.method === 'GET' && (url.pathname.startsWith('/api/trades/') || url.pathname.startsWith('/api/candles/'))) {
      const dbp = process.env.GBX_TOKENIDX_DB;
      if (!dbp) { res.writeHead(404); return res.end('not enabled'); }
      try {
        const { openTokenIndex } = require('./gbx-token-read.js');
        if (!global.__gbxTokenIdx) global.__gbxTokenIdx = openTokenIndex(dbp);
        let out;
        if (url.pathname.startsWith('/api/trades/'))
          out = global.__gbxTokenIdx.coinTrades(url.pathname.slice('/api/trades/'.length));
        else {
          const iv = url.searchParams.get('interval')||'1200';
          if (/^(1m|5m|15m|1h|4h|1d)$/.test(iv))
            out = global.__gbxTokenIdx.coinCandlesPro(url.pathname.slice('/api/candles/'.length), iv,
                    url.searchParams.get('phase')||null);
          else
            out = global.__gbxTokenIdx.coinCandles(url.pathname.slice('/api/candles/'.length),
                    parseInt(iv,10)||1200);
        }
        if (!out) { res.writeHead(404); return res.end('unknown coin'); }
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); return res.end('trades error'); }
    }
    // federated leaderboard — burners/traders from curve_ops
    if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
      const dbp = process.env.GBX_TOKENIDX_DB;
      if (!dbp) { res.writeHead(404); return res.end('not enabled'); }
      try {
        const { openTokenIndex } = require('./gbx-token-read.js');
        if (!global.__gbxTokenIdx) global.__gbxTokenIdx = openTokenIndex(dbp);
        const kind = url.searchParams.get('kind') || 'burners';
        const period = url.searchParams.get('period') || '24h';
        const blocks = period === 'all' ? 0 : (period === '7d' ? 201600 : 28800);
        const out = global.__gbxTokenIdx.leaderboard(kind, blocks);
        if (!out) { res.writeHead(404); return res.end('unknown kind'); }
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); return res.end('leaderboard error'); }
    }
    // 24h dashboard stats — chain-derived, keyless, per-node
    if (req.method === 'GET' && url.pathname === '/api/stats24') {
      const dbp = process.env.GBX_TOKENIDX_DB;
      if (!dbp) { res.writeHead(404); return res.end('not enabled'); }
      try {
        const { openTokenIndex } = require('./gbx-token-read.js');
        if (!global.__gbxTokenIdx) global.__gbxTokenIdx = openTokenIndex(dbp);
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify(global.__gbxTokenIdx.stats24()));
      } catch (e) { res.writeHead(500); return res.end('stats error'); }
    }
    // AMM pools after graduation — list + detail (same guard as curves)
    if (req.method === 'GET' && (url.pathname === '/api/pools' || url.pathname.startsWith('/api/pools/'))) {
      const dbp = process.env.GBX_TOKENIDX_DB;
      if (!dbp) { res.writeHead(404); return res.end('not enabled'); }
      try {
        const { openTokenIndex } = require('./gbx-token-read.js');
        if (!global.__gbxTokenIdx) global.__gbxTokenIdx = openTokenIndex(dbp);
        let out;
        if (url.pathname === '/api/pools') out = global.__gbxTokenIdx.poolsAll();
        else out = global.__gbxTokenIdx.poolDetail(url.pathname.slice('/api/pools/'.length));
        if (!out) { res.writeHead(404); return res.end('unknown pool'); }
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(500); return res.end('pool-index error'); }
    }
    if (req.method === 'GET' && url.pathname === '/api/htlc-registry') {
      // GBX on-chain HTLC contract registry (GBX:HTLC: OP_RETURN). Read-only, keyless.
      try {
        const regPath = process.env.GBX_NODEREG_STATE || require('path').join(process.env.GBX_STATE_DIR || require('path').join(__dirname,'..','node-registry'),'node-registry.json');
        const reg = JSON.parse(fs.readFileSync(regPath,'utf8'));
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({updated_height: reg.scanned_height, htlcs: reg.htlcs||{}}));
      } catch(e){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end('{"updated_height":0,"htlcs":{}}'); }
    }
    if (req.method === 'GET' && url.pathname === '/api/release-anchors') {
      // On-chain release anchors (GBX:R:), lineage-verified by release-check.
      // Read-only, keyless, federated: any node serves its own verified view.
      try {
        const rcPath = process.env.GBX_RELCHK_STATE || require('path').join(__dirname,'..','release-check','release-check.json');
        const rc = JSON.parse(fs.readFileSync(rcPath,'utf8'));
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({checked_at:(rc.report&&rc.report.checked_at)||null, anchors: rc.anchors||{}, app_anchors: rc.app_anchors||{}}));
      } catch(e){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end('{"checked_at":null,"anchors":{},"app_anchors":{}}'); }
    }
    if (req.method === 'GET' && url.pathname === '/api/lp-registry') {
      // GBX on-chain LP registry (GBX:LP: OP_RETURN). Read-only, keyless.
      try {
        const regPath = process.env.GBX_NODEREG_STATE || require('path').join(process.env.GBX_STATE_DIR || require('path').join(__dirname,'..','node-registry'),'node-registry.json');
        const reg = JSON.parse(fs.readFileSync(regPath,'utf8'));
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({updated_height: reg.scanned_height, lps: reg.lps||{}}));
      } catch(e){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end('{"updated_height":0,"lps":{}}'); }
    }
    if (req.method === 'GET' && url.pathname === '/api/node-registry') {
      // GBX on-chain node registry (GBX:NODE: OP_RETURN). Read-only, keyless.
      try {
        const regPath = process.env.GBX_NODEREG_STATE || require('path').join(process.env.GBX_STATE_DIR || require('path').join(__dirname,'..','node-registry'),'node-registry.json');
        const reg = JSON.parse(fs.readFileSync(regPath,'utf8'));
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({updated_height: reg.scanned_height, nodes: reg.nodes}));
      } catch(e){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end('{"updated_height":0,"nodes":{}}'); }
    }
    if (req.method === 'GET' && url.pathname === '/api/peers') {
      return sendJson(res, 200, await getPeers());
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      return sendJson(res, 200, await getStatus());
    }

    if (req.method === 'GET' && url.pathname === '/api/emission') {
      // Real emission, read from the chain itself (no hardcoded subsidy):
      // coinbase total of the tip block + average block spacing over the last
      // 1440 blocks. 60s cache. Keyless, federated: any node serves it.
      try {
        if (!global.__gbxEmission || (Date.now()-global.__gbxEmission.ts) > 60000) {
          const tip = Number(await runCli(['getblockcount']));
          const hash = (await runCli(['getblockhash', _assertInt(tip)])).trim();
          const blk = JSON.parse(await runCli(['getblock', _assertHex(hash,'blockhash'), '2']));
          const cb = blk.tx && blk.tx[0];
          const reward = cb ? cb.vout.reduce((a,v)=>a+Number(v.value||0),0) : null;
          const span = 1440;
          const h1 = Math.max(1, tip - span);
          const hash1 = (await runCli(['getblockhash', _assertInt(h1)])).trim();
          const hd1 = JSON.parse(await runCli(['getblockheader', _assertHex(hash1,'blockhash')]));
          const spacing = (blk.time - hd1.time) / (tip - h1);
          global.__gbxEmission = { ts: Date.now(), out: { height: tip, block_reward_gbx: reward, avg_block_seconds: Math.round(spacing*100)/100, sampled_blocks: tip - h1 } };
        }
        return sendJson(res, 200, global.__gbxEmission.out);
      } catch (e) {
        return sendJson(res, 200, { height: 0, error: String(e && e.message ? e.message : e) });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/powtpl') {
      // CREATE-PoW template: height + best hash + bits. Keyless, read-only.
      // Same semantics as the LP gateway /powtpl, served federated by any node.
      try {
        const tip = Number(await runCli(['getblockcount']));
        const hash = (await runCli(['getblockhash', _assertInt(tip)])).trim();
        const header = JSON.parse(await runCli(['getblockheader', _assertHex(hash, 'blockhash')]));
        return sendJson(res, 200, { height: tip, hash: hash, bits: header.bits });
      } catch (e) {
        return sendJson(res, 200, { height: 0, error: String(e && e.message ? e.message : e) });
      }
    }

    const blockMatch = url.pathname.match(/^\/api\/block\/(\d+)$/);
    if (req.method === 'GET' && blockMatch) {
      const h = Number(blockMatch[1]);
      const hash = (await runCli(["getblockhash",_assertInt(h)])).trim();
      const header = JSON.parse(await runCli(["getblockheader",_assertHex(hash,"blockhash")]));
      return sendJson(res, 200, {
        height: header.height,
        hash: header.hash,
        time: header.time,
        nTx: header.nTx ?? null,
        difficulty: header.difficulty ?? null,
        previousblockhash: header.previousblockhash ?? null,
      });
    }

    const addressMatch = url.pathname.match(/^\/api\/address\/([^/]+)$/);
    if (req.method === 'GET' && addressMatch) {
      const address = decodeURIComponent(addressMatch[1]);
      return sendJson(res, 200, await getAddressSummary(address));
    }

    const txidMatch = url.pathname.match(/^\/api\/tx\/([0-9a-fA-F]{64})$/);
    if (req.method === 'GET' && txidMatch) {
      try {
        const txid = txidMatch[1].toLowerCase();
        const h = gbxIndex.txHeight ? gbxIndex.txHeight(txid) : null;
        if (!h) { res.writeHead(404); return res.end(JSON.stringify({error:'tx not found'})); }
        const tx = await getTxVerboseAtHeight(txid, h);
        const tip = Number(await runCli(['getblockcount']));
        return sendJson(res, 200, {
          txid, height: h, blockhash: tx?.blockhash ?? null,
          confirmations: tx && Number.isFinite(Number(tx.confirmations)) ? Number(tx.confirmations) : Math.max(0, tip - h + 1),
          time: tx?.blocktime ?? tx?.time ?? null,
          size: tx?.size ?? null,
          vin: (tx?.vin||[]).length, vout: (tx?.vout||[]).length,
          outputs: (tx?.vout||[]).map(function(o){ return { n:o.n, value_gbx:Number(o.value||0).toFixed(8), address:(o.scriptPubKey&&(o.scriptPubKey.address||(o.scriptPubKey.addresses&&o.scriptPubKey.addresses[0])))||null }; })
        });
      } catch (e) { res.writeHead(500); return res.end(JSON.stringify({error:'tx error'})); }
    }
    const txMatch = url.pathname.match(/^\/api\/address\/([^/]+)\/txs$/);
    if (req.method === 'GET' && txMatch) {
      const address = decodeURIComponent(txMatch[1]);
      return sendJson(res, 200, await getAddressTxs(address));
    }

    if (req.method === 'POST' && url.pathname === '/api/broadcast') {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody || '{}');
      return sendJson(res, 200, await broadcastRawTx(body.rawtx));
    }

    
  
    // TRADE-1: /api/gbx/stats · /api/gbx/candles · /api/gbx/trades — on-chain derived, keyless.
    if (req.method === 'GET' && url.pathname.startsWith('/api/gbx/')) {
      if (!gbxTrades) return sendJson(res, 503, { error: 'trade_index_unavailable' });
      const IV = {'1m':60000,'5m':300000,'15m':900000,'1h':3600000,'4h':14400000,'1d':86400000};
      try {
        if (url.pathname === '/api/gbx/stats')  return sendJson(res, 200, gbxTrades.stats());
        if (url.pathname === '/api/gbx/trades') {
          const lim = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 500);
          return sendJson(res, 200, { trades: gbxTrades.trades(lim).reverse(), source: 'onchain-derived' });
        }
        if (url.pathname === '/api/gbx/candles') {
          const iv = url.searchParams.get('interval') || '1d';
          const ms = IV[iv]; if (!ms) return sendJson(res, 400, { error: 'bad_interval', allowed: Object.keys(IV) });
          const lim = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);
          return sendJson(res, 200, { candles: gbxTrades.candles(ms, lim), interval: iv, source: 'onchain-derived' });
        }
      } catch (e) {
        console.error('[TRADE-1] route error:', e.message);
        return sendJson(res, 503, { error: 'trade_index_error' });
      }
    }

    // STEP46_UTXOS_ENDPOINT — direct scantxoutset with addr() descriptor
    {
      const utxosMatch = url.pathname.match(/^\/api\/utxos\/([^/]+)$/);
      if (req.method === 'GET' && utxosMatch) {
        const address = utxosMatch[1];
        // GBX — optional limit: return the largest N UTXOs (signing selects from the large ones).
        const limitParam = parseInt(url.searchParams.get('limit') || '0', 10);
        const cacheKey = limitParam > 0 ? address + ':' + limitParam : address;
        const cached = UTXO_CACHE.get(cacheKey);
        if (cached && Date.now() - cached.ts < UTXO_CACHE_TTL) {
          return sendJson(res, 200, cached.data);
        }
        try {
          // An index behind the chain lies about spendability: a stale "unspent"
          // builds a transaction the chain must reject (-25). Refusing honestly
          // makes the federated client fail over to a healthy node instead.
          const idxTip = gbxIndex.tipHeight ? gbxIndex.tipHeight() : null;
          const chainTip = await getChainTipCached();
          if (idxTip !== null && chainTip !== null && (chainTip - idxTip) > 30) {
            console.error('[RA-1] index lag /api/utxos idx=' + idxTip + ' chain=' + chainTip);
            return sendJson(res, 503, { error: 'indexing', tip: idxTip, chain_tip: chainTip, retry_after_s: 15 });
          }
          const ixU = (limitParam > 0 && gbxIndex.scanTopN) ? gbxIndex.scanTopN(address, limitParam) : gbxIndex.scanLikeIndex(address);
          if (!ixU) {
            console.error('[RA-1] index miss /api/utxos ' + String(address).slice(0,24));
            return sendJson(res, 503, { error: 'indexing', tip: idxTip, retry_after_s: 5 });
          }
          const scan = ixU;
          let rawUnspents = scan.unspents || [];
          const totalCount = (scan.total_count !== undefined) ? scan.total_count : rawUnspents.length;
          // GBX — if a limit is requested: sort desc by amount + take the first N (fast BUY/SELL on addresses cu multe UTXO)
          if (limitParam > 0 && rawUnspents.length > limitParam) {
            rawUnspents = rawUnspents.slice().sort((a,b) => Number(b.amount||0) - Number(a.amount||0)).slice(0, limitParam);
          }
          // V4.9 OPT — Skip gettxout for mature UTXOs (>=100 conf always spendable)
          const unspents = await Promise.all(rawUnspents.map(async (u) => {
            const confirmations = u.confirmations || 0;
            if (confirmations >= 100) {
              return {
                txid: u.txid, vout: u.vout, scriptPubKey: u.scriptPubKey,
                amount: u.amount, confirmations, height: u.height,
                coinbase: false, spendable: true
              };
            }
            let coinbase = false;
            try {
              const txoutRaw = await runCli(["gettxout",_assertTxid(u.txid),_assertInt(u.vout)]);
              const txout = JSON.parse(txoutRaw || 'null');
              coinbase = !!(txout && txout.coinbase);
            } catch (_) { /* default coinbase=false */ }
            return {
              txid: u.txid, vout: u.vout, scriptPubKey: u.scriptPubKey,
              amount: u.amount, confirmations, height: u.height,
              coinbase, spendable: !coinbase
            };
          }));
          const responseData = {
            address,
            success: scan.success || false,
            height: scan.height,
            utxo_count: unspents.length,
            total_count: totalCount,
            total_amount: scan.total_amount || 0,
            unspents
          };
          UTXO_CACHE.set(cacheKey, { ts: Date.now(), data: responseData });
          return sendJson(res, 200, responseData);
        } catch (err) {
          return sendJson(res, 500, { error: err.message });
        }
      }
    }

    // STEP45_ANNOUNCEMENT_ENDPOINT
      {
        const __gbxAnnouncementPath = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
        if (req.method === 'GET' && (__gbxAnnouncementPath === '/api/announcement' || __gbxAnnouncementPath === '/announcement')) {
          const announcementFile = process.env.GBX_ANNOUNCEMENT_FILE || './announcement.json';
          let payload = {
            ok: true,
            enabled: true,
            badge: 'LIVE UPDATE',
            title: 'GOLDBRIX ONE',
            message: 'Wallet, receive QR and mining are live.',
            level: 'info'
          };

          try {
            if (fs.existsSync(announcementFile)) {
              payload = { ...payload, ...JSON.parse(fs.readFileSync(announcementFile, 'utf8')) };
            }
          } catch (err) {
            payload = { ...payload, ok: false, error: err.message };
          }

          payload.updated_at = Math.floor(Date.now() / 1000);

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Cache-Control': 'no-store'
          });
          return res.end(JSON.stringify(payload, null, 2));
        }
      }

      return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('READ_API_ERROR', {
      method: req.method,
      url: req.url,
      message: err?.message,
      stack: err?.stack,
    });
    return sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`GOLDBRIX API listening on http://${HOST}:${PORT}`);
});

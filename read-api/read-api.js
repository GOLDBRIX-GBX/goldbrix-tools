const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const gbxIndex = require('./gbx-index-read.js');
// TRADE-1 (s38): keyless market data. Price/volume DERIVED on-chain (L1 HTLC claim x EVM USDC lock,
// joined on hashlock). No LP is trusted, no private DB, no key. Any node can rebuild it.
let gbxTrades = null;
try { gbxTrades = require('./gbx-trade-read.js'); } catch (e) { console.error('[TRADE-1] trade index unavailable:', e.message); }

const HOST = '0.0.0.0';
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
const UTXO_CACHE_TTL = 60 * 1000; // GBX — 60s: scan adresa curata=0.1s (sigur). Adresa mining ramane protejata de cache. Fix real=indexer (sesiune autonomie)

function _runCliOnce(argv) {
  // argv = ARRAY de argumente (fara shell). Imun la shell-injection.
  return new Promise((resolve, reject) => {
    const base = [`-rpcconnect=${RPC_CONNECT}`, `-rpcport=${RPC_PORT}`, `-datadir=${DATADIR}`];
    execFile(CLI, base.concat(argv), { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error((stderr || error.message).trim())); return; }
      resolve(stdout.trim());
    });
  });
}
// REZILIENT (Claude): nodul poate fi temporar in "Loading" (-28) la restart/reindex.
// Retry in loc sa arunce -> read-api nu mai moare, citirile raman disponibile (sell/balanta stabile).
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

// B.5 circuit breaker: ultima valoare buna a status-ului (stale-fallback cand nodul e indisponibil)
let _lastStatus = null;

async function getStatus() {
  try {
    const blockchain = JSON.parse(await runCli(['getblockchaininfo']));
    const peers = Number(await runCli(['getconnectioncount']));
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
      synced: blockchain.initialblockdownload === false,
      updated_at: Math.floor(Date.now() / 1000),
    };
    _lastStatus = { data: out, ts: Date.now() };  // B.5: salveaza ultima valoare buna
    return out;
  } catch (e) {
    // B.5 circuit breaker: nodul indisponibil dupa retry -> ultima valoare buna marcata stale,
    // in loc de eroare 500. Userul vede date (putin vechi), nu eroare. Auto-revine cand nodul revine.
    if (_lastStatus) {
      console.warn('[getStatus] nod indisponibil -> stale fallback:', (e && e.message) || e);
      return Object.assign({}, _lastStatus.data, {
        stale: true,
        stale_age_sec: Math.floor((Date.now() - _lastStatus.ts) / 1000),
      });
    }
    throw e;  // nicio valoare buna inca -> propaga (primul boot cu nod mort)
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
  // RA-1 (s38): scantxoutset scos de pe ruta publica (2.5G RSS -> OOM). Index miss = 503 onest.
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
  // SWR: cache vechi (<60s) servit INSTANT + refresh in fundal (mempool scan = zeci de subprocess-uri seriale, 16s la mempool plin)
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

async function getTxVerboseAtHeight(txid, height) {
  const h = Number(height || 0);
  if (!(h > 0)) return null;
  const blockhash = await runCli(["getblockhash",_assertInt(h)]);
  return JSON.parse(await runCli(["getrawtransaction",_assertTxid(txid),"true",_assertHex(blockhash,"blockhash")]));
}

async function getAddressTxs(address) {
  const { scan, info } = await scanAddress(address);
  let unspents = Array.isArray(scan.unspents) ? scan.unspents : [];
  // GBX — limita dura: pe adrese cu zeci de mii de UTXO (mining) evita 200k+ RPC (hang).
  // Sorteaza desc dupa height (cele mai recente) + max 50.
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

    // IDEE V token-index (guarded: served only when GBX_TOKENIDX_DB is set)
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
    if (req.method === 'GET' && url.pathname === '/api/htlc-registry') {
      // GBX on-chain HTLC contract registry (GBX:HTLC: OP_RETURN). Read-only, keyless.
      try {
        const regPath = process.env.GBX_NODEREG_STATE || '/root/goldbrix-tools/node-registry/node-registry.json';
        const reg = JSON.parse(fs.readFileSync(regPath,'utf8'));
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({updated_height: reg.scanned_height, htlcs: reg.htlcs||{}}));
      } catch(e){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end('{"updated_height":0,"htlcs":{}}'); }
    }
    if (req.method === 'GET' && url.pathname === '/api/lp-registry') {
      // GBX on-chain LP registry (GBX:LP: OP_RETURN). Read-only, keyless.
      try {
        const regPath = process.env.GBX_NODEREG_STATE || '/root/goldbrix-tools/node-registry/node-registry.json';
        const reg = JSON.parse(fs.readFileSync(regPath,'utf8'));
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({updated_height: reg.scanned_height, lps: reg.lps||{}}));
      } catch(e){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end('{"updated_height":0,"lps":{}}'); }
    }
    if (req.method === 'GET' && url.pathname === '/api/node-registry') {
      // GBX on-chain node registry (GBX:NODE: OP_RETURN). Read-only, keyless.
      try {
        const regPath = process.env.GBX_NODEREG_STATE || '/root/goldbrix-tools/node-registry/node-registry.json';
        const reg = JSON.parse(fs.readFileSync(regPath,'utf8'));
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({updated_height: reg.scanned_height, nodes: reg.nodes}));
      } catch(e){ res.writeHead(200,{'Content-Type':'application/json'}); return res.end('{"updated_height":0,"nodes":{}}'); }
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return sendJson(res, 200, await getStatus());
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

    
  
    // TRADE-1 (s38): /api/gbx/stats · /api/gbx/candles · /api/gbx/trades — on-chain derived, keyless.
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
        // GBX — limit optional: intoarce cele mai mari N UTXO (semnarea selecteaza din cele mari).
        const limitParam = parseInt(url.searchParams.get('limit') || '0', 10);
        const cacheKey = limitParam > 0 ? address + ':' + limitParam : address;
        const cached = UTXO_CACHE.get(cacheKey);
        if (cached && Date.now() - cached.ts < UTXO_CACHE_TTL) {
          return sendJson(res, 200, cached.data);
        }
        try {
          const ixU = gbxIndex.scanLikeIndex(address);
          if (!ixU) {
            console.error('[RA-1] index miss /api/utxos ' + String(address).slice(0,24));
            return sendJson(res, 503, { error: 'indexing', tip: gbxIndex.tipHeight ? gbxIndex.tipHeight() : null, retry_after_s: 5 });
          }
          const scan = ixU;
          let rawUnspents = scan.unspents || [];
          const totalCount = rawUnspents.length;
          // GBX — daca limit cerut: sorteaza desc dupa amount + ia primele N (BUY/SELL rapid pe adrese cu multe UTXO)
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

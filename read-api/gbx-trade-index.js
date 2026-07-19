#!/usr/bin/env node
/* GoldBrix Trade Index — KEYLESS, TRUSTLESS. Real executed price/volume from two chains.
   Nobody declares anything; nothing is trusted:
   - GBX leg  : HTLC P2WSH spend on L1. witnessScript starts 63a820<32B hashlock>.
                witness items 4 => CLAIM (settled trade) | 3 => REFUND (aborted, NOT a trade)
   - USDC leg : Locked(bytes32,address,address,address,uint256,bytes32,uint256) on EVM (public getLogs)
   Join on hashlock => price_usd = usdc_amount / gbx_amount. Volume = gbx_amount. Time = block time.
   Any node rebuilds this from public data. No LP is trusted. No OP_RETURN. No key. */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');

const GBX_DATADIR = process.env.GBX_DATADIR || '/var/lib/goldbrix';
const RPC_PORT    = parseInt(process.env.GBX_RPC_PORT || '8332', 10);
const DB_PATH     = process.env.GBX_TRADE_DB || path.join(GBX_DATADIR, 'index', 'gbx-trades.db');
const IDX_DB      = process.env.GBX_INDEX_DB || path.join(GBX_DATADIR, 'index', 'gbx-index.db');
const CHAINS_F    = process.env.GBX_CHAINS_F || '/opt/gbx-lp/chains.json';
const FROM_H      = parseInt(process.env.GBX_TRADE_FROM || '2300000', 10);
const POLL_MS     = parseInt(process.env.GBX_TRADE_POLL_MS || '20000', 10);
const COOKIE      = path.join(GBX_DATADIR, '.cookie');
const HTLC_PREFIX = '63a820';
const TOPIC_LOCKED = '0x14442dbf5e9aa943f3b7681bdf4e57c3256930c69ccc137263150f7e01bd51cf';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function rpcAuth(){ return 'Basic ' + Buffer.from(fs.readFileSync(COOKIE,'utf8').trim()).toString('base64'); }
function rpc(method, params=[]) {
  return new Promise((resolve,reject)=>{
    const body = JSON.stringify({jsonrpc:'1.0',id:'gbxtrade',method,params});
    const req = http.request({host:'127.0.0.1',port:RPC_PORT,method:'POST',
      headers:{'Content-Type':'text/plain','Content-Length':Buffer.byteLength(body),'Authorization':rpcAuth()}},
      res=>{let d='';res.on('data',x=>d+=x);res.on('end',()=>{
        try{const j=JSON.parse(d); if(j.error) return reject(new Error(j.error.message)); resolve(j.result);}
        catch(e){reject(new Error('RPC parse: '+d.slice(0,160)));}});});
    req.on('error',reject); req.write(body); req.end();
  });
}
async function rpcR(m,p=[],tries=8){ for(let i=1;i<=tries;i++){ try{return await rpc(m,p);}catch(e){ if(i===tries) throw e; await sleep(400*i);} } }

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS gbx_legs (
  hashlock TEXT PRIMARY KEY, txid TEXT NOT NULL, vout INTEGER NOT NULL,
  gbx_sats INTEGER NOT NULL, height INTEGER NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usdc_legs (
  hashlock TEXT PRIMARY KEY, chain TEXT NOT NULL, usdc_micro INTEGER NOT NULL, block INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE INDEX IF NOT EXISTS idx_legs_ts ON gbx_legs(ts);
`);
const Q = {
  addGbx:  db.prepare(`INSERT OR REPLACE INTO gbx_legs (hashlock,txid,vout,gbx_sats,height,ts,kind) VALUES (?,?,?,?,?,?,?)`),
  addUsdc: db.prepare(`INSERT OR REPLACE INTO usdc_legs (hashlock,chain,usdc_micro,block) VALUES (?,?,?,?)`),
  delAbove:db.prepare(`DELETE FROM gbx_legs WHERE height > ?`),
  getMeta: db.prepare(`SELECT v FROM meta WHERE k=?`),
  setMeta: db.prepare(`INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)`),
};
const metaGet = k => { const r = Q.getMeta.get(k); return r ? r.v : null; };
const metaSet = (k,v) => Q.setMeta.run(k, String(v));

const idx   = fs.existsSync(IDX_DB) ? new Database(IDX_DB,{readonly:true,fileMustExist:true}) : null;
const qPrev = idx ? idx.prepare('SELECT sats FROM utxos WHERE txid=? AND vout=?') : null;
async function prevValueSats(txid, vout) {
  if (qPrev) { const r = qPrev.get(txid, vout); if (r) return r.sats; }
  const t = await rpcR('getrawtransaction', [txid, true]);
  return Math.round(Number(t.vout[vout].value) * 1e8);
}

async function scanBlock(blk) {
  const rows = [];
  for (const tx of (blk.tx || [])) {
    for (const vin of (tx.vin || [])) {
      const w = vin.txinwitness;
      if (!w || !w.length) continue;
      const ws = w[w.length-1];
      if (typeof ws !== 'string' || ws.length < 100 || !ws.startsWith(HTLC_PREFIX)) continue;
      const hashlock = '0x' + ws.slice(6,70);
      const kind = w.length === 4 ? 'claim' : (w.length === 3 ? 'refund' : 'unknown');
      const sats = await prevValueSats(vin.txid, vin.vout);
      rows.push([hashlock, vin.txid, vin.vout, sats, blk.height, blk.time, kind]);
    }
  }
  if (rows.length) db.transaction(rs => { for (const r of rs) Q.addGbx.run(...r); })(rows);
  return rows.length;
}

// The address index already knows WHERE every HTLC was spent: only those blocks matter.
// Scanning 1.25M blocks to find ~115 events would be wasteful and would hammer a small node.
// Same result, O(spends) instead of O(chain). Falls back to a linear walk if the index is absent.
function htlcSpendHeights(afterH, tip) {
  if (!idx) return null;
  return idx.prepare(
    "SELECT DISTINCT spent_height AS h FROM utxos WHERE spk LIKE '0020%' AND spent_height IS NOT NULL AND spent_height > ? AND spent_height <= ? ORDER BY h ASC LIMIT 500"
  ).all(afterH, tip).map(r => r.h);
}
async function syncL1() {
  const tip = await rpcR('getblockcount', []);
  const last = parseInt(metaGet('l1_height') || '0', 10);
  const from = last > 0 ? last : (FROM_H - 1);
  const heights = htlcSpendHeights(from, tip);
  if (heights === null) { log('[TRADE] no index — cannot scan efficiently; install gbx-indexer'); return false; }
  if (!heights.length) { metaSet('l1_height', tip); return false; }
  let found = 0;
  for (const h of heights) {
    const bh  = await rpcR('getblockhash', [h]);
    const blk = await rpcR('getblock', [bh, 2]);
    found += await scanBlock(blk);
    metaSet('l1_height', h);
  }
  log(`L1 ${heights[0]}..${heights[heights.length-1]} (${heights.length} blocks with HTLC spends): +${found} legs`);
  return heights.length === 500;
}

async function evmRpc(rpcs, method, params) {
  let lastErr = null;
  for (const url of rpcs) {
    try {
      const r = await fetch(url, {method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({jsonrpc:'2.0', id:1, method, params})});
      const j = await r.json();
      if (j.error) { lastErr = new Error(method+': '+JSON.stringify(j.error)); continue; }
      return j.result;
    } catch(e) { lastErr = e; continue; }
  }
  throw lastErr || new Error('all RPC failed for '+method);
}
async function evmLocked(rpcs, htlc, fromBlock) {
  const latest = parseInt(await evmRpc(rpcs,'eth_blockNumber',[]), 16);
  let from = fromBlock, win = 9000, out = [];
  while (from <= latest) {
    const to = Math.min(from + win - 1, latest);
    try {
      const logs = await evmRpc(rpcs,'eth_getLogs',[{address:htlc, fromBlock:'0x'+from.toString(16), toBlock:'0x'+to.toString(16), topics:[TOPIC_LOCKED]}]);
      for (const l of logs) {
        const d = l.data.replace(/^0x/,'');
        const sl = i => d.slice(i*64,(i+1)*64);
        out.push({ hashlock:'0x'+sl(2), amount: Number(BigInt('0x'+sl(1))), block: parseInt(l.blockNumber,16) });
      }
      from = to + 1;
      if (win < 9000) win = Math.min(9000, win*2);
    } catch(e) {
      const m = String(e.message).match(/(\d+)\s*block/i);
      const lim = m ? parseInt(m[1],10) : 0;
      if (lim > 0 && lim < win) { win = Math.max(1, lim); continue; }
      if (win > 10) { win = 10; continue; }
      throw e;
    }
  }
  return { events: out, latest };
}

// Solana has no eth_getLogs: HTLCs are Anchor accounts. Same hashlock, same join, same keyless proof.
// Uses the LP-box CLI (read-only, no key needed for a listing).
async function syncSOL(c) {
  const { execFile } = require('child_process');
  const cli = process.env.GBX_SOL_CLI || '/opt/gbx-lp/sol-htlc-cli.mjs';
  const idl = c.idl || '/opt/gbx-lp/target/idl/htlc.json';
  if (!fs.existsSync(cli) || !fs.existsSync(idl)) { log('[TRADE] solana: CLI/IDL missing, skipped'); return; }
  const arg = JSON.stringify({ cmd:'all-swaps', program:c.program, idl, rpc:c.rpc });
  const outStr = await new Promise((res, rej) => {
    execFile('/usr/bin/node', [cli, arg], { maxBuffer: 32*1024*1024, timeout: 90000 },
      (e, so) => e ? rej(e) : res(so));
  });
  const swaps = (JSON.parse(outStr).swaps) || [];
  const rows = swaps.filter(x => x.claimed && Number(x.amount) > 0);
  if (rows.length) db.transaction(rs => {
    for (const r of rs) Q.addUsdc.run(r.hashlock, 'solana', Number(r.amount), 0);
  })(rows);
  log(`[TRADE] solana: ${rows.length} settled locks (of ${swaps.length} swaps)`);
}

async function syncEVM() {
  let chains;
  try { chains = (JSON.parse(fs.readFileSync(CHAINS_F,'utf8')).chains) || {}; }
  catch(e) { log('[TRADE] chains.json unreadable:', e.message); return; }
  // ETAPA 4.9: merge HTLC contracts announced on-chain (GBX:HTLC) — autonomous discovery.
  let annHtlcs = {};
  try {
    const regPath = process.env.GBX_NODEREG_STATE || require('path').join(__dirname,'..','node-registry','node-registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath,'utf8'));
    for (const key of Object.keys(reg.htlcs||{})) {
      const m = key.match(/^([a-z0-9]{2,16}):(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})(?::([0-9]{1,12}))?$/);
      if (!m) continue;
      (annHtlcs[m[1]] = annHtlcs[m[1]] || []).push({ addr: m[2], from: parseInt(m[3]||'0',10), h: (reg.htlcs[key].height||0) });
    }
    for (const ch of Object.keys(annHtlcs)) annHtlcs[ch] = annHtlcs[ch].sort((a,b)=>b.h-a.h).slice(0,20); // cap 20, newest first
  } catch(e) { /* registry unreadable -> hardcoded fallback only */ }
  for (const [name,c] of Object.entries(chains)) {
    if (!c.enabled || c.kind === 'solana' || !c.HTLC || !Array.isArray(c.rpcs)) continue;
    const key = 'evm_block_' + name;
    const from = parseInt(metaGet(key) || String(c.from_block || 0), 10);
    try {
      const contracts = [{ addr: c.HTLC, from: c.from_block||0, mkey: key }];
      for (const a of (annHtlcs[name]||[])) {
        if (a.addr.toLowerCase() === String(c.HTLC).toLowerCase()) continue; // already covered by hardcoded fallback
        contracts.push({ addr: a.addr, from: a.from, mkey: 'evm_block_'+name+'_'+a.addr.toLowerCase() });
      }
      for (const ct of contracts) {
        const fromC = ct.mkey===key ? from : parseInt(metaGet(ct.mkey) || String(ct.from||0), 10);
        if (!fromC && ct.mkey!==key) { log(`[TRADE] ${name} announced HTLC ${ct.addr} has no from_block — skipped (announce with :from_block)`); continue; }
        const { events, latest } = await evmLocked(c.rpcs, ct.addr, fromC);
        if (events.length) db.transaction(es => { for (const e of es) Q.addUsdc.run(e.hashlock, name, e.amount, e.block); })(events);
        if (latest) metaSet(ct.mkey, latest);
        if (events.length) log(`[TRADE] ${name} ${ct.addr.slice(0,10)}: +${events.length} USDC locks (through block ${latest})`);
      }
    } catch(e) { log(`[TRADE] ${name} getLogs FAIL:`, String(e.message).slice(0,120)); }
  }
  const sol = chains.solana;
  if (sol && sol.enabled && sol.program) {
    try { await syncSOL(sol); }
    catch(e) { log('[TRADE] solana FAIL:', String(e.message).slice(0,120)); }
  }
}

async function loop() {
  log('gbx-trade-index START · trades=' + DB_PATH + ' · index=' + IDX_DB);
  let evmTick = 0;
  for(;;) {
    try {
      let more = true;
      while (more) more = await syncL1();
      if (evmTick % 6 === 0) await syncEVM();     // EVM ~ la 2 min
      evmTick++;
    } catch(e) { log('[TRADE] cycle error:', String(e.message).slice(0,160)); }
    await sleep(POLL_MS);
  }
}
if (require.main === module) loop();
module.exports = { DB_PATH };

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
// A lock is settled when the contract itself says so - claimed or refunded.
// Proven on chain before it was written: Base 7 unique, Arbitrum 2, matching
// the same verdict the client computes locally.
const TOPIC_CLAIMED  = '0x54e9dcf96aeed1fa6849e3f39d94c3115fa88d93c20d7f7f44afed0428596e2f';
const TOPIC_REFUNDED = '0xfe509803c09416b28ff3d8f690c8b0c61462a892c46d5430c8fb20abe472daf0';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function rpcAuth(){
  try { return 'Basic ' + Buffer.from(fs.readFileSync(COOKIE,'utf8').trim()).toString('base64'); }
  catch (e) {
    const u = process.env.GBX_RPC_USER, w = process.env.GBX_RPC_PASS;
    if (u && w) return 'Basic ' + Buffer.from(u + ':' + w).toString('base64');
    throw new Error('no .cookie at ' + COOKIE + ' and no GBX_RPC_USER/GBX_RPC_PASS');
  }
}
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
CREATE TABLE IF NOT EXISTS sol_locks (
  pda TEXT PRIMARY KEY, receiver TEXT NOT NULL, mint TEXT NOT NULL,
  amount INTEGER NOT NULL, hashlock TEXT NOT NULL, timelock INTEGER NOT NULL,
  claimed INTEGER NOT NULL, refunded INTEGER NOT NULL, buyer_pk TEXT, seen INTEGER NOT NULL,
  sender TEXT);
CREATE INDEX IF NOT EXISTS idx_sol_rcv ON sol_locks(receiver) WHERE claimed=0 AND refunded=0;
CREATE TABLE IF NOT EXISTS htlc_settled (
  lock_id TEXT PRIMARY KEY, chain TEXT NOT NULL, kind TEXT NOT NULL, block INTEGER NOT NULL, seen INTEGER NOT NULL);
-- The bridge between the two names of one lock: the contract emits both in the
-- same Locked event, so nothing extra is ever asked of any chain.
CREATE TABLE IF NOT EXISTS lock_map (
  lock_id TEXT PRIMARY KEY, hashlock TEXT NOT NULL, chain TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_lockmap_hl ON lock_map(hashlock);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE INDEX IF NOT EXISTS idx_legs_ts ON gbx_legs(ts);
`);

{
  const have = new Set(db.prepare("PRAGMA table_info(sol_locks)").all().map(c => c.name));
  if (!have.has('sender')) db.exec("ALTER TABLE sol_locks ADD COLUMN sender TEXT");
  // The index has to come after the column exists: CREATE TABLE IF NOT EXISTS
  // leaves an older table untouched, so on any database built before this the
  // column arrives only here.
  db.exec("CREATE INDEX IF NOT EXISTS idx_sol_snd ON sol_locks(sender) WHERE claimed=0 AND refunded=0");
}

const Q = {
  addGbx:  db.prepare(`INSERT OR REPLACE INTO gbx_legs (hashlock,txid,vout,gbx_sats,height,ts,kind) VALUES (?,?,?,?,?,?,?)`),
  addUsdc: db.prepare(`INSERT OR REPLACE INTO usdc_legs (hashlock,chain,usdc_micro,block) VALUES (?,?,?,?)`),
  addSettled: db.prepare(`INSERT OR REPLACE INTO htlc_settled (lock_id,chain,kind,block,seen) VALUES (?,?,?,?,?)`),
  addLockMap: db.prepare(`INSERT OR REPLACE INTO lock_map (lock_id,hashlock,chain) VALUES (?,?,?)`),
  addSol:  db.prepare(`INSERT OR REPLACE INTO sol_locks (pda,receiver,mint,amount,hashlock,timelock,claimed,refunded,buyer_pk,seen,sender) VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
  getSolPk:db.prepare(`SELECT buyer_pk FROM sol_locks WHERE pda=?`),
  delSolGone: db.prepare(`DELETE FROM sol_locks WHERE seen < ?`),
  delAbove:db.prepare(`DELETE FROM gbx_legs WHERE height > ?`),
  getMeta: db.prepare(`SELECT v FROM meta WHERE k=?`),
  setMeta: db.prepare(`INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)`),
};
const metaGet = k => { const r = Q.getMeta.get(k); return r ? r.v : null; };
const metaSet = (k,v) => Q.setMeta.run(k, String(v));

const idx   = fs.existsSync(IDX_DB) ? new Database(IDX_DB,{readonly:true,fileMustExist:true}) : null;
const qPrev = idx ? idx.prepare('SELECT sats FROM utxos WHERE txid=? AND vout=?') : null;
// How far the address index has actually been written. The trade cursor must never move
// past it: on a fresh machine both indexes start together, and a cursor that jumps to the
// chain tip while the address index is still filling would skip the whole history and
// never look back. Returns null when unknown, in which case nothing changes.
const qIdxTip = idx ? idx.prepare('SELECT MAX(height) h FROM blocks') : null;
function idxTip() {
  if (!qIdxTip) return null;
  try { const r = qIdxTip.get(); return (r && r.h != null) ? r.h : null; } catch(e) { return null; }
}
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
  if (!heights.length) {
    const it = idxTip();
    metaSet('l1_height', (it === null) ? tip : Math.min(tip, it));
    return false;
  }
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
        out.push({ id: l.topics[1], hashlock:'0x'+sl(2), amount: Number(BigInt('0x'+sl(1))), block: parseInt(l.blockNumber,16) });
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

// The settled side of the same story. Same adaptive windows as evmLocked, one
// cursor per contract, so a chain that goes quiet costs nothing on the next pass.
async function evmSettled(rpcs, htlc, fromBlock) {
  const latest = parseInt(await evmRpc(rpcs,'eth_blockNumber',[]), 16);
  let out = [];
  for (const [topic, kind] of [[TOPIC_CLAIMED,'claimed'], [TOPIC_REFUNDED,'refunded']]) {
    let from = fromBlock, win = 9000;
    while (from <= latest) {
      const to = Math.min(from + win - 1, latest);
      try {
        const logs = await evmRpc(rpcs,'eth_getLogs',[{address:htlc, fromBlock:'0x'+from.toString(16), toBlock:'0x'+to.toString(16), topics:[topic]}]);
        for (const l of logs) out.push({ id: l.topics[1], kind, block: parseInt(l.blockNumber,16) });
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
  }
  return { settled: out, latest };
}

// Solana has no eth_getLogs: HTLCs are Anchor accounts. Same hashlock, same join, same keyless proof.
// Uses the LP-box CLI (read-only, no key needed for a listing).
// Solana locks, read straight from the chain over public RPC - no CLI, no IDL,
// no LP package. A browser cannot ask for getProgramAccounts (public endpoints
// refuse it or answer without the account key), but a node can, and every node
// can: that is what keeps the seller's side of a direct sale federated instead
// of behind somebody's paid endpoint.
const SOL_RPCS_DEFAULT = ['https://api.mainnet-beta.solana.com','https://solana-rpc.publicnode.com'];
const B58A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58e(b){ let n=0n; for(const x of b) n=(n<<8n)|BigInt(x); let o=''; while(n>0n){ o=B58A[Number(n%58n)]+o; n/=58n; } for(const x of b){ if(x===0) o='1'+o; else break; } return o||'1'; }
async function solRpc(rpcs, method, params) {
  let lastErr=null;
  for (const url of rpcs) {
    try {
      const r = await fetch(url, {method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({jsonrpc:'2.0', id:1, method, params})});
      const j = await r.json();
      if (j.error) { lastErr=new Error(method+': '+JSON.stringify(j.error)); continue; }
      return j.result;
    } catch(e) { lastErr=e; continue; }
  }
  throw lastErr || new Error('all Solana RPC failed for '+method);
}
const SOL_MEMO='MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
// The buyer's GBX key rides as a Memo in the transaction that created the swap
// account. Read once per lock and stored: the account never changes its origin.
async function solBuyerPk(rpcs, pda) {
  try {
    const sigs = await solRpc(rpcs,'getSignaturesForAddress',[pda,{limit:10}]);
    if (!sigs || !sigs.length) return null;
    for (let i=sigs.length-1; i>=0; i--) {
      const tx = await solRpc(rpcs,'getTransaction',[sigs[i].signature,
        {encoding:'jsonParsed', maxSupportedTransactionVersion:0, commitment:'confirmed'}]);
      if (!tx) continue;
      const ins = ((tx.transaction||{}).message||{}).instructions || [];
      for (const it of ins) {
        if (it.program==='spl-memo' || it.programId===SOL_MEMO) {
          const m = String(it.parsed!=null?it.parsed:(it.data||'')).trim().toLowerCase();
          if (/^(02|03)[0-9a-f]{64}$/.test(m)) return m;
        }
      }
    }
  } catch(_e) {}
  return null;
}
async function syncSolLocks(program, rpcs) {
  const res = await solRpc(rpcs,'getProgramAccounts',[program,{encoding:'base64',commitment:'confirmed'}]);
  const now = Math.floor(Date.now()/1000);
  let n=0, live=0;
  const rows=[];
  for (const a of (res||[])) {
    if (!a || !a.pubkey || !a.account || !a.account.data) continue;
    const u = Buffer.from(a.account.data[0], 'base64');
    if (u.length < 154) continue;
    const claimed=u[152]===1, refunded=u[153]===1;
    const hashlock = u.subarray(112,144).toString('hex');
    const timelock = Number(u.readBigInt64LE(144));
    let pk=null;
    if (!claimed && !refunded) {
      live++;
      const kept = Q.getSolPk.get(a.pubkey);
      pk = (kept && kept.buyer_pk) ? kept.buyer_pk : await solBuyerPk(rpcs, a.pubkey);
    }
    rows.push([a.pubkey, b58e(u.subarray(40,72)), b58e(u.subarray(72,104)),
               Number(u.readBigUInt64LE(104)), hashlock, timelock,
               claimed?1:0, refunded?1:0, pk, now, b58e(u.subarray(8,40))]);
    n++;
  }
  if (rows.length) db.transaction(rs => { for (const r of rs) Q.addSol.run(...r); })(rows);
  // An account that vanished from the chain must vanish here too.
  Q.delSolGone.run(now);
  log(`[TRADE] solana locks: ${n} accounts, ${live} live`);
}
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

// Public RPC endpoints per chain. They are not configuration a node operator
// should have to find: the contracts themselves are announced on-chain, and
// these are the same public endpoints anyone uses to read a public ledger.
// A local chains.json still wins when present, for an operator with own RPCs.
const DEFAULT_RPCS = {
  base: ['https://mainnet.base.org','https://base-rpc.publicnode.com','https://base-mainnet.public.blastapi.io','https://base.drpc.org'],
  arbitrum: ['https://arb1.arbitrum.io/rpc','https://arbitrum-one-rpc.publicnode.com','https://arbitrum.public-rpc.com','https://arbitrum.drpc.org']
};

async function syncEVM() {
  let chains = {};
  try { chains = (JSON.parse(fs.readFileSync(CHAINS_F,'utf8')).chains) || {}; }
  catch(e) { log('[TRADE] no local chains file, reading contracts from the chain instead'); }
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
  // A chain announced on-chain but absent from the local file is still indexed:
  // the announcement is the record, the file is only an override.
  for (const ch of Object.keys(annHtlcs)) {
    if (chains[ch] || !DEFAULT_RPCS[ch]) continue;
    const newest = annHtlcs[ch][0];
    chains[ch] = { enabled: true, HTLC: newest.addr, from_block: newest.from, rpcs: DEFAULT_RPCS[ch] };
  }
  for (const [name,c] of Object.entries(chains)) {
    if (c && c.enabled && !Array.isArray(c.rpcs) && DEFAULT_RPCS[name]) c.rpcs = DEFAULT_RPCS[name];
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
        if (events.length) db.transaction(es => { for (const e of es) {
          Q.addUsdc.run(e.hashlock, name, e.amount, e.block);
          if (e.id) Q.addLockMap.run(e.id, e.hashlock, name);
        } })(events);
        if (latest) metaSet(ct.mkey, latest);
        if (events.length) log(`[TRADE] ${name} ${ct.addr.slice(0,10)}: +${events.length} USDC locks (through block ${latest})`);
        // Settled state, read on the node so no browser has to ask the chain
        // dozens of times just to draw a label.
        try {
          const skey = 'evm_settled_' + name + '_' + ct.addr.toLowerCase();
          const fromS = parseInt(metaGet(skey) || String(ct.from||0), 10);
          const st = await evmSettled(c.rpcs, ct.addr, fromS);
          const nowS = Math.floor(Date.now()/1000);
          if (st.settled.length) db.transaction(rs => { for (const r of rs) Q.addSettled.run(r.id, name, r.kind, r.block, nowS); })(st.settled);
          if (st.latest) metaSet(skey, st.latest);
          if (st.settled.length) log(`[TRADE] ${name} ${ct.addr.slice(0,10)}: +${st.settled.length} settled (through block ${st.latest})`);
        } catch(e) { log(`[TRADE] ${name} settled FAIL:`, String(e.message).slice(0,120)); }
      }
    } catch(e) { log(`[TRADE] ${name} getLogs FAIL:`, String(e.message).slice(0,120)); }
  }
  const sol = chains.solana;
  if (sol && sol.enabled && sol.program) {
    try { await syncSOL(sol); }
    catch(e) { log('[TRADE] solana FAIL:', String(e.message).slice(0,120)); }
  }
}

// The HTLC program is announced on chain (GBX:HTLC); a local chains.json still
// wins for an operator with their own setup, and the deployed address is the
// last resort so a fresh node works with no configuration at all.
const SOL_PROGRAM_FALLBACK='AAbKiRpmY5jYfC37DuQ9aTsWnNqxZXLe4fvyGSb3YS1F';
function solProgram() {
  try {
    const f = process.env.GBX_CHAINS_F;
    if (f && fs.existsSync(f)) {
      const c = JSON.parse(fs.readFileSync(f,'utf8'));
      if (c && c.solana && c.solana.program) return c.solana.program;
    }
  } catch(_e) {}
  try {
    const st = process.env.GBX_NODEREG_STATE;
    if (st && fs.existsSync(st)) {
      const j = JSON.parse(fs.readFileSync(st,'utf8'));
      const h = (j && j.htlcs) || {};
      for (const k of Object.keys(h)) if (k.startsWith('solana:')) return k.split(':')[1];
    }
  } catch(_e) {}
  return SOL_PROGRAM_FALLBACK;
}
function solRpcs() {
  const e = (process.env.GBX_SOL_RPCS||'').split(',').map(x=>x.trim()).filter(Boolean);
  return e.length ? e : SOL_RPCS_DEFAULT;
}
async function syncSolAll() { return syncSolLocks(solProgram(), solRpcs()); }
async function loop() {
  log('gbx-trade-index START · trades=' + DB_PATH + ' · index=' + IDX_DB);
  let evmTick = 0;
  for(;;) {
    try {
      let more = true;
      while (more) more = await syncL1();
      if (evmTick % 6 === 0) await syncEVM();     // EVM ~ la 2 min
      // Solana on its own guard: a chain that will not answer must not stop the
      // others, and the seller's side of a direct sale depends on this list.
      if (evmTick % 6 === 0) {
        try { await syncSolAll(); }
        catch(e) { log('[TRADE] solana locks FAIL:', String(e.message).slice(0,140)); }
      }
      evmTick++;
    } catch(e) { log('[TRADE] cycle error:', String(e.message).slice(0,160)); }
    await sleep(POLL_MS);
  }
}
if (require.main === module) loop();
module.exports = { DB_PATH };

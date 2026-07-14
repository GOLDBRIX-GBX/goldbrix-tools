#!/usr/bin/env node
// IDEE V token-index (production): token holdings derived purely on-chain from
// GBX:C intents (mint at C/B/P) minus spent token UTXOs. Keyless, reconstructible,
// reorg-safe (per-block hash checkpoint + rollback). SQLite state.
'use strict';
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const Database = require(process.env.GBX_SQLITE_MOD || '/root/goldbrix-tools/read-api/node_modules/better-sqlite3');

const BIN     = process.env.GBX_BIN     || '/usr/local/bin/goldbrix-cli';
const DATADIR = process.env.GBX_DATADIR || '/root/.bitcoin';
const CHAIN   = process.env.GBX_CHAIN   || 'main';      // 'regtest' | 'main'
const RPCPORT = process.env.GBX_RPC_PORT|| '8332';
const DB_PATH = process.env.GBX_TOKENIDX_DB || '/root/goldbrix-tools/token-index/token-index.db';
const START   = parseInt(process.env.GBX_TOKENIDX_START || '0', 10);
const POLL_MS = parseInt(process.env.GBX_POLL_MS || '3000', 10);
const KEEP    = 220;                                        // > reorg finality (100)
const MODE    = process.argv[2] || '--loop';                // --oneshot | --dump | --loop

function cli(...args){
  const base = [`-datadir=${DATADIR}`, `-rpcport=${RPCPORT}`];
  if (CHAIN === 'main') base.unshift('-regtest');
  const out = execFileSync(BIN, [...base, ...args.map(String)],
                           { encoding:'utf8', maxBuffer: 64*1024*1024 });
  const s = out.trim();
  try { return JSON.parse(s); } catch { return s; }
}
const sha256 = b => crypto.createHash('sha256').update(b).digest();

// -- payload: "GBX:C:" + op(1) + cid(32) + amount(8 BE) + tokens_out(8 BE) + pk(33) = 88 bytes
function readPush(b, i){
  const n = b[i]; i += 1;
  if (n < 0x4c) return [b.subarray(i, i+n), i+n];
  if (n === 0x4c){ const L = b[i]; return [b.subarray(i+1, i+1+L), i+1+L]; }
  throw new Error('push');
}
function parseIntent(tx){
  for (const o of tx.vout){
    const hex = (o.scriptPubKey && o.scriptPubKey.hex) || '';
    if (!hex.startsWith('6a')) continue;
    let data;
    try { [data] = readPush(Buffer.from(hex,'hex'), 1); } catch { continue; }
    if (data.length !== 88 || !data.subarray(0,6).equals(Buffer.from('GBX:C:'))) continue;
    return {
      op: String.fromCharCode(data[6]),
      cid: data.subarray(7,39),
      tokensOut: data.readBigUInt64BE(47),
      pk: data.subarray(55,88),
    };
  }
  return null;
}
function push(x){ return Buffer.concat([ x.length < 0x4c ? Buffer.from([x.length]) : Buffer.from([0x4c, x.length]), x ]); }
function tokenWS(cid, amt, pk){
  const a = Buffer.alloc(8); a.writeBigUInt64BE(amt);
  return Buffer.concat([push(cid), push(a), Buffer.from([0x6d]), push(pk), Buffer.from([0xac])]);
}
const p2wsh = ws => '0020' + sha256(ws).toString('hex');

// -- state
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS blocks(height INTEGER PRIMARY KEY, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS token_utxos(
  txid TEXT NOT NULL, vout INTEGER NOT NULL,
  coin_id TEXT NOT NULL, pk TEXT NOT NULL, amount TEXT NOT NULL,
  height INTEGER NOT NULL, spent_height INTEGER,
  PRIMARY KEY(txid, vout));
CREATE INDEX IF NOT EXISTS tu_live ON token_utxos(coin_id, pk) WHERE spent_height IS NULL;
`);
const q = {
  getMeta:  db.prepare('SELECT v FROM meta WHERE k=?'),
  setMeta:  db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
  blkHash:  db.prepare('SELECT hash FROM blocks WHERE height=?'),
  putBlk:   db.prepare('INSERT OR REPLACE INTO blocks(height,hash) VALUES(?,?)'),
  pruneBlk: db.prepare('DELETE FROM blocks WHERE height < ?'),
  spend:    db.prepare('UPDATE token_utxos SET spent_height=? WHERE txid=? AND vout=? AND spent_height IS NULL'),
  insert:   db.prepare('INSERT OR IGNORE INTO token_utxos(txid,vout,coin_id,pk,amount,height) VALUES(?,?,?,?,?,?)'),
  rbNew:    db.prepare('DELETE FROM token_utxos WHERE height > ?'),
  rbSpent:  db.prepare('UPDATE token_utxos SET spent_height=NULL WHERE spent_height > ?'),
  rbBlk:    db.prepare('DELETE FROM blocks WHERE height > ?'),
  holdings: db.prepare(`SELECT coin_id, pk, SUM(CAST(amount AS INTEGER)) amt
                        FROM token_utxos WHERE spent_height IS NULL GROUP BY coin_id, pk`),
};
const scanned = () => parseInt(q.getMeta.get('scanned')?.v ?? String(START - 1), 10);

const rollbackTo = db.transaction(h => {
  q.rbNew.run(h); q.rbSpent.run(h); q.rbBlk.run(h);
  q.setMeta.run('scanned', String(h));
});
const applyBlock = db.transaction((h, blk) => {
  for (const tx of blk.tx){
    for (const vin of (tx.vin || []))
      if (vin.txid !== undefined) q.spend.run(h, vin.txid, vin.vout);
    const it = parseIntent(tx);
    if (!it || !'CBPSR'.includes(it.op) || it.tokensOut <= 0n) continue;  // C,B,P mint tokens; S,R return change — every one of them creates a token UTXO
    const spk = p2wsh(tokenWS(it.cid, it.tokensOut, it.pk));
    for (const o of tx.vout)
      if (o.scriptPubKey.hex === spk)
        q.insert.run(tx.txid, o.n, it.cid.toString('hex'), it.pk.toString('hex'),
                     it.tokensOut.toString(), h);
  }
  q.putBlk.run(h, blk.hash);
  q.pruneBlk.run(h - KEEP);
  q.setMeta.run('scanned', String(h));
});

function findCommonAncestor(fromH){
  for (let h = fromH; h >= Math.max(START, fromH - KEEP); h--){
    const stored = q.blkHash.get(h);
    if (stored && stored.hash === cli('getblockhash', h)) return h;
  }
  return START - 1; // beyond kept window: full rescan from START
}
function syncOnce(){
  let tip = cli('getblockcount');
  let s = scanned();
  if (s > tip){ const a = findCommonAncestor(tip); rollbackTo(a); s = a; console.log(`[tokenidx] tip shrank, rolled back to ${a}`); }
  while (s < tip){
    const h = s + 1;
    const blk = cli('getblock', cli('getblockhash', h), 2);
    const prev = q.blkHash.get(h - 1);
    if (h > START && prev && prev.hash !== blk.previousblockhash){
      const a = findCommonAncestor(h - 1);
      rollbackTo(a); s = a;
      console.log(`[tokenidx] reorg detected at ${h}, rolled back to ${a}`);
      continue;
    }
    applyBlock(h, blk);
    s = h;
    if (s % 10000 === 0) console.log(`[tokenidx] scanned ${s}/${tip}`);
    tip = cli('getblockcount');
  }
  return s;
}
function dump(){
  const rows = q.holdings.all();
  console.log(`tip=${scanned()} live_holdings=${rows.length}`);
  for (const r of rows)
    console.log(`  coin=${r.coin_id.slice(0,16)}.. holder=${r.pk.slice(0,16)}.. amount=${Number(r.amt).toLocaleString('en-US')}`);
}
if (MODE === '--oneshot'){ console.log(`[tokenidx] synced to ${syncOnce()}`); }
else if (MODE === '--dump'){ dump(); }
else { (async () => { for(;;){ try { syncOnce(); } catch(e){ console.error('[tokenidx]', e.message); } await new Promise(r=>setTimeout(r, POLL_MS)); } })(); }

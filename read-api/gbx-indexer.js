#!/usr/bin/env node
/* GoldBrix Address Indexer (gbx-indexer)
   address -> UTXO, reorg-safe (spent_height), polling feed. Production, build-once.
   Citeste GoldBrix RPC via cookie. Proces SEPARAT de nod. */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');

const GBX_DATADIR = process.env.GBX_DATADIR || require('os').homedir() + '/.bitcoin';
const RPC_HOST = '127.0.0.1';
const RPC_PORT = parseInt(process.env.GBX_RPC_PORT || '8332', 10);
const DB_PATH  = process.env.GBX_INDEX_DB || './gbx-index.db';
const POLL_MS  = 1000;
const COOKIE   = path.join(GBX_DATADIR, '.cookie');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const toSats = v => Math.round(Number(v) * 1e8);
const log = (...a) => console.log(new Date().toISOString(), ...a);

function rpcAuth() {
  const c = fs.readFileSync(COOKIE, 'utf8').trim();   // __cookie__:hex
  return 'Basic ' + Buffer.from(c).toString('base64');
}
function rpc(method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc:'1.0', id:'gbxidx', method, params });
    const req = http.request({ host:RPC_HOST, port:RPC_PORT, method:'POST',
      headers:{ 'Content-Type':'text/plain', 'Content-Length':Buffer.byteLength(body), 'Authorization': rpcAuth() }
    }, res => { let d=''; res.on('data',x=>d+=x); res.on('end',()=>{
      try { const j=JSON.parse(d); if(j.error) return reject(new Error(j.error.message||JSON.stringify(j.error))); resolve(j.result); }
      catch(e){ reject(new Error('RPC parse: '+d.slice(0,180))); }});
    });
    req.on('error', reject); req.write(body); req.end();
  });
}
async function rpcR(method, params=[], tries=8) {
  for (let i=1;i<=tries;i++){
    try { return await rpc(method, params); }
    catch(e){ const m=e.message||''; if(i<tries && /-28|Loading|Rewinding|Verifying|warming|connect|ECONNREFUSED|busy|socket hang/i.test(m)){ await sleep(2000); continue; } throw e; }
  }
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.exec(`
CREATE TABLE IF NOT EXISTS utxos (
  txid TEXT NOT NULL, vout INTEGER NOT NULL,
  address TEXT NOT NULL, sats INTEGER NOT NULL,
  height INTEGER NOT NULL, spent_height INTEGER,
  PRIMARY KEY (txid, vout));
CREATE INDEX IF NOT EXISTS idx_addr_uns ON utxos(address) WHERE spent_height IS NULL;
CREATE INDEX IF NOT EXISTS idx_h ON utxos(height);
CREATE INDEX IF NOT EXISTS idx_sh ON utxos(spent_height);
CREATE TABLE IF NOT EXISTS blocks (height INTEGER PRIMARY KEY, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`);
const Q = {
  add: db.prepare(`INSERT OR REPLACE INTO utxos (txid,vout,address,sats,height,spent_height,spk,coinbase) VALUES (?,?,?,?,?,NULL,?,?)`),
  spend: db.prepare(`UPDATE utxos SET spent_height=? WHERE txid=? AND vout=?`),
  setBlk: db.prepare(`INSERT OR REPLACE INTO blocks (height,hash) VALUES (?,?)`),
  blkHash: db.prepare(`SELECT hash FROM blocks WHERE height=?`),
  tip: db.prepare(`SELECT MAX(height) h FROM blocks`),
  unspendAbove: db.prepare(`UPDATE utxos SET spent_height=NULL WHERE spent_height>?`),
  delUtxoAbove: db.prepare(`DELETE FROM utxos WHERE height>?`),
  delBlkAbove: db.prepare(`DELETE FROM blocks WHERE height>?`),
};
const processBlock = db.transaction((blk) => {
  const h = blk.height;
  for (let ti = 0; ti < blk.tx.length; ti++) { const tx = blk.tx[ti]; const isCoinbase = (ti === 0);
    for (const vin of tx.vin) {
      if (vin.coinbase) continue;
      if (vin.txid && vin.vout !== undefined) Q.spend.run(h, vin.txid, vin.vout);
    }
    for (const o of tx.vout) {
      const spk = o.scriptPubKey || {};
      const addr = spk.address || (Array.isArray(spk.addresses) ? spk.addresses[0] : null);
      if (!addr) continue;
      Q.add.run(tx.txid, o.n, addr, toSats(o.value), h, (spk.hex||null), isCoinbase?1:0);
    }
  }
  Q.setBlk.run(h, blk.hash);
});
const rollbackTx = db.transaction((toH) => { Q.unspendAbove.run(toH); Q.delUtxoAbove.run(toH); Q.delBlkAbove.run(toH); });

async function syncTo(target) {
  let next = (Q.tip.get().h === null) ? 0 : Q.tip.get().h + 1;
  while (next <= target) {
    const hash = await rpcR('getblockhash', [next]);
    const blk  = await rpcR('getblock', [hash, 2]);
    if (next > 0) {
      const prev = Q.blkHash.get(next - 1);
      if (prev && prev.hash !== blk.previousblockhash) {   // reorg: blocul nostru (next-1) a iesit din lant activ
        log(`REORG detectat la h=${next-1} -> rollback la ${next-2}`);
        rollbackTx(next - 2); next = next - 1; continue;
      }
    }
    processBlock(blk);
    if (next % 10000 === 0) log(`backfill h=${next}/${target}`);
    next++;
  }
}
async function main() {
  log('gbx-indexer START · db=' + DB_PATH);
  for (;;) {
    try {
      const count = await rpcR('getblockcount');
      const tip = Q.tip.get().h;
      if (tip === null || count > tip) { await syncTo(count); log(`sync OK tip=${count}`); }
    } catch (e) { log('loop err: ' + (e.message||e)); }
    await sleep(POLL_MS);
  }
}
process.on('SIGTERM', () => { try{db.close();}catch(_){} process.exit(0); });
main();

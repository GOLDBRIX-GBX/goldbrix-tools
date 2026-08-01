#!/usr/bin/env node
// token-index (production): token holdings derived purely on-chain from
// GBX:C intents (mint at C/B/P) minus spent token UTXOs. Keyless, reconstructible,
// reorg-safe (per-block hash checkpoint + rollback). SQLite state.
'use strict';
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const Database = require(process.env.GBX_SQLITE_MOD || path.join(__dirname,'..','read-api','node_modules','better-sqlite3'));

const BIN     = process.env.GBX_BIN     || '/usr/local/bin/goldbrix-cli';
const DATADIR = process.env.GBX_DATADIR || '/var/lib/goldbrix';
const CHAIN   = process.env.GBX_CHAIN   || 'main';      // 'regtest' | 'main'
const RPCPORT = process.env.GBX_RPC_PORT|| '8332';
const DB_PATH = process.env.GBX_TOKENIDX_DB || path.join(__dirname,'token-index.db');
// Coins cannot exist before the launchpad activates, so the blocks before it
// hold nothing this index can store. Starting there costs a new node hours of
// reading blocks it will discard, and that cost grows with the chain. The
// launchpad height is the natural floor; an explicit start still wins.
const START   = parseInt(process.env.GBX_TOKENIDX_START || process.env.GBX_LAUNCHPAD_HEIGHT || '0', 10);
const POLL_MS = parseInt(process.env.GBX_POLL_MS || '3000', 10);
const LAUNCH_H= parseInt(process.env.GBX_LAUNCHPAD_HEIGHT || '0', 10); // consensus nLaunchpadHeight mirror; 0 = index everything (pre-activation / regtest)
const KEEP    = 220;                                        // > reorg finality (100)
const MODE    = process.argv[2] || '--loop';                // --oneshot | --dump | --loop

function cli(...args){
  const base = [`-datadir=${DATADIR}`, `-rpcport=${RPCPORT}`];
  if (CHAIN !== 'main') base.unshift('-regtest');
  const out = execFileSync(BIN, [...base, ...args.map(String)],
                           { encoding:'utf8', maxBuffer: 64*1024*1024 });
  const s = out.trim();
  try { return JSON.parse(s); } catch { return s; }
}
const sha256 = b => crypto.createHash('sha256').update(b).digest();
// ── total burned, measured from this node's own chain (autonomous, no third party):
// sum of all UTXOs on the canonical burn script (P2WPKH all-zero program).
let _lastBurnScan = 0;
function scanBurnTotal(q){
  const now = Date.now();
  if (now - _lastBurnScan < 5*60*1000) return;   // at most every 5 min
  _lastBurnScan = now;
  try{
    const r = cli('scantxoutset','start','["addr(bn1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3kc3g2)"]');
    if (r && r.success){
      const sat = Math.round(Number(r.total_amount) * 1e8);
      q.setMeta.run('burn_total_sat', String(sat));
      q.setMeta.run('burn_utxos', String((r.unspents||[]).length));
      q.setMeta.run('burn_scan_height', String(r.height||0));
    }
  }catch(_e){ /* node busy; retry next cycle */ }
}


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
    if (!data.subarray(0,6).equals(Buffer.from('GBX:C:'))) continue;
    // a CREATE carries its 80-byte proof of work right after the 88-byte
    // intent (168 total). Every other op is exactly 88. The proof itself is
    // consensus's job; the intent bytes we read are the same either way.
    const isCreate = data.length >= 7 && data[6] === 0x43;
    if (!(data.length === 88 || (isCreate && data.length === 168))) continue;
    return {
      op: String.fromCharCode(data[6]),
      cid: data.subarray(7,39),
      amount: data.readBigUInt64BE(39),
      tokensOut: data.readBigUInt64BE(47),
      pk: data.subarray(55,88),
    };
  }
  return null;
}
// -- transfer declaration: 'GBX:T:'+ver(1)+cid(32)+amount(8 BE)+pk_recipient(33).
// A token output is a P2WSH commitment that cannot be reversed, so a plain
// transfer is invisible here: the sender's holding is spent and nobody's rises.
// The declaration names the movement. It is NOT trusted: the token script is
// rebuilt from (cid, amount, recipient) and must match a real output of the
// same transaction. A false declaration therefore mints nothing.
function parseTransfer(tx){
  for (const o of tx.vout){
    const hex = (o.scriptPubKey && o.scriptPubKey.hex) || '';
    if (!hex.startsWith('6a')) continue;
    let data;
    try { [data] = readPush(Buffer.from(hex,'hex'), 1); } catch { continue; }
    if (data.length !== 80) continue;
    if (!data.subarray(0,6).equals(Buffer.from('GBX:T:'))) continue;
    if (data[6] !== 1) continue;
    const amount = data.readBigUInt64BE(39);
    if (amount <= 0n) continue;
    return { cid: data.subarray(7,39), amount, pk: data.subarray(47,80) };
  }
  return null;
}

// ── coin metadata (name/ticker) from the chain alone: 'GBX:M:'+ver(1)+cid(32)+
// tLen(1)+ticker+nLen(1)+name. Valid ONLY if the tx is signed by the creator pk
// from the CREATE intent (P2WPKH witness reveals it). First on chain wins.
function parseMeta(tx){
  for (const o of tx.vout){
    const hex = (o.scriptPubKey && o.scriptPubKey.hex) || '';
    if (!hex.startsWith('6a')) continue;
    let data;
    try { [data] = readPush(Buffer.from(hex,'hex'), 1); } catch { continue; }
    if (!data.subarray(0,6).equals(Buffer.from('GBX:M:'))) continue;
    if (data.length < 42 || data[6] !== 0x01) continue;
    const cid = data.subarray(7,39);
    const tLen = data[39];
    if (tLen < 1 || tLen > 10 || data.length < 41+tLen) continue;
    const ticker = data.subarray(40, 40+tLen).toString('utf8');
    if (/[^A-Z0-9]/.test(ticker)) continue;
    const nLen = data[40+tLen];
    if (nLen < 1 || nLen > 50 || data.length !== 41+tLen+nLen) continue;
    const name = data.subarray(41+tLen).toString('utf8');
    return { cid: cid.toString('hex'), ticker, name };
  }
  return null;
}
// ── coin description + links: 'GBX:M:'+ver=2+cid(32)+dLen(1)+desc+lLen(1)+links.
// Valid ONLY if the tx is signed by the creator pk. First on chain wins.
function parseMeta2(tx){
  for (const o of tx.vout){
    const hex = (o.scriptPubKey && o.scriptPubKey.hex) || '';
    if (!hex.startsWith('6a')) continue;
    let data;
    try { [data] = readPush(Buffer.from(hex,'hex'), 1); } catch { continue; }
    if (!data.subarray(0,6).equals(Buffer.from('GBX:M:'))) continue;
    if (data.length < 41 || data[6] !== 0x02) continue;
    const cid = data.subarray(7,39);
    const dLen = data[39];
    if (dLen > 150 || data.length < 41+dLen) continue;
    const desc = data.subarray(40, 40+dLen).toString('utf8');
    const lLen = data[40+dLen];
    if (lLen > 64 || data.length !== 41+dLen+lLen) continue;
    if (dLen + lLen === 0) continue;
    const links = data.subarray(41+dLen).toString('utf8');
    return { cid: cid.toString('hex'), desc, links };
  }
  return null;
}
// ── coin logo chunk: 'GBX:L:'+ver=1+cid(32)+idx(1)+total(1)+hash16(16)+dLen(1)+data.
// Valid ONLY if the tx is signed by the creator pk. First complete set wins.
function parseLogoChunk(tx){
  for (const o of tx.vout){
    const hex = (o.scriptPubKey && o.scriptPubKey.hex) || '';
    if (!hex.startsWith('6a')) continue;
    let data;
    try { [data] = readPush(Buffer.from(hex,'hex'), 1); } catch { continue; }
    if (!data.subarray(0,6).equals(Buffer.from('GBX:L:'))) continue;
    if (data.length < 59 || data[6] !== 0x01) continue;
    const cid = data.subarray(7,39);
    const idx = data[39], total = data[40];
    if (!(total>=1 && total<=21) || idx>=total) continue;
    const hash16 = data.subarray(41,57);
    const dLen = data[57];
    if (!(dLen>=1 && dLen<=197) || data.length !== 58+dLen) continue;
    return { cid: cid.toString('hex'), idx, total, hash16: hash16.toString('hex'), data: Buffer.from(data.subarray(58)) };
  }
  return null;
}
function witnessPks(tx){
  const out = new Set();
  for (const vin of (tx.vin||[])){
    const w = vin.txinwitness;
    if (w && w.length === 2 && (w[1].length === 66)) out.add(w[1]); // P2WPKH: [sig, pk33]
  }
  return out;
}
// ── curve state (reserve, M, h_M) tracked from the chain alone ──────
const COIN=100000000n, V_GBX=30000n*COIN, V_TOK=1073000000n, CURVE_TOKENS=800000000n;
const KCURVE=V_GBX*V_TOK, FEE_BPS=50n;
const GRAD_N=20n, GRAD_MIN=2000n*COIN;
const GRAD_WINDOW = parseInt(process.env.GBX_GRAD_WINDOW || (CHAIN==='regtest' ? '30' : '201600'), 10);
const tokensSold = r => r<0n ? 0n : V_TOK - KCURVE/(V_GBX+r);
function curveBuy0(net){ // first buy on an empty curve (CREATE), consensus formula
  if (net<=0n) return null;
  const cur=V_GBX, nxt=cur+net;
  const out=KCURVE/cur - KCURVE/nxt;
  if (out<=0n || out>CURVE_TOKENS) return null;
  return { tokensOut: out, reserve: net };
}
function curveWS(cid, m, hM){
  const mb=Buffer.alloc(8); mb.writeBigUInt64BE(m);
  const hb=Buffer.alloc(4); hb.writeUInt32BE(hM);
  return Buffer.concat([push(cid), push(mb), push(hb), Buffer.from([0x6d,0x75,0x51])]);
}
// Mirror of consensus ParseCurveWitnessScript: <cid:32> <M:8> <hM:4> 6d 75 51
function parseCurveWS(buf){
  try{
    let i=0; const rd=n=>{ if(buf[i]!==n) throw 0; const d=buf.subarray(i+1,i+1+n); i+=1+n; return d; };
    const id=rd(32), m=rd(8), h=rd(4);
    if (buf[i++]!==0x6d||buf[i++]!==0x75||buf[i++]!==0x51||i!==buf.length) return null;
    return { cid:id.toString('hex'), m:m.readBigUInt64BE(), hM:h.readUInt32BE() };
  }catch{ return null; }
}
function push(x){ return Buffer.concat([ x.length < 0x4c ? Buffer.from([x.length]) : Buffer.from([0x4c, x.length]), x ]); }
function tokenWS(cid, amt, pk){
  const a = Buffer.alloc(8); a.writeBigUInt64BE(amt);
  return Buffer.concat([push(cid), push(a), Buffer.from([0x6d]), push(pk), Buffer.from([0xac])]);
}
const p2wsh = ws => '0020' + sha256(ws).toString('hex');
const BURN_SPK = '0014' + '00'.repeat(20); // mirror of consensus CurveBurnScript
function burnedAmount(tx){
  let t=0n;
  for (const o of tx.vout) if (((o.scriptPubKey||{}).hex||'')===BURN_SPK) t+=BigInt(Math.round(o.value*1e8));
  return t;
}

// -- pool state (AMM after graduation) -- mirror of consensus PoolWitnessScript /
// ParsePoolWitnessScript: <cid:32> <tokens:8 BE> OP_2DROP(6d) OP_TRUE(51).
const POOL_LP = 200000000n, POOL_FEE_BPS = 30n;
function poolWS(cid, tokens){
  const t = Buffer.alloc(8); t.writeBigUInt64BE(tokens);
  return Buffer.concat([push(cid), push(t), Buffer.from([0x6d, 0x51])]);
}
function parsePoolWS(buf){
  try{
    let i=0; const rd=n=>{ if(buf[i]!==n) throw 0; const d=buf.subarray(i+1,i+1+n); i+=1+n; return d; };
    const id=rd(32), t=rd(8);
    if (buf[i++]!==0x6d || buf[i++]!==0x51 || i!==buf.length) return null;
    return { cid:id.toString('hex'), tokens:t.readBigUInt64BE() };
  }catch{ return null; }
}
const ceilDiv = (a,b) => (a + b - 1n) / b;
// consensus PoolBuy/PoolSell -- rounding always favours the pool (k monotone)
function poolBuyCalc(g, t, gbxIn){
  if (g<=0n||t<=0n||gbxIn<=0n) return null;
  const k=g*t, ng=g+gbxIn, nt=ceilDiv(k, ng);
  const out=t-nt; if (out<=0n) return null;
  return { tokensOut: out, newGbx: ng, newTok: nt };
}
function poolSellCalc(g, t, tokIn){
  if (g<=0n||t<=0n||tokIn<=0n) return null;
  const k=g*t, nt=t+tokIn, ng=ceilDiv(k, nt);
  const out=g-ng; if (out<=0n||out>g) return null;
  return { gbxOut: out, newGbx: ng, newTok: nt };
}
const poolFee = gross => (gross*POOL_FEE_BPS)/10000n;
// GRADUATE: find the newborn pool output. Every unit follows: pool value ==
// curve reserve, so tokens = LP + (800M - sold(value)) derives from the output alone.
function poolFromTx(h, tx, cidHex){
  const cid = Buffer.from(cidHex,'hex');
  for (const o of tx.vout){
    const hex = (o.scriptPubKey && o.scriptPubKey.hex) || '';
    if (!hex.startsWith('0020')) continue;
    const v = BigInt(Math.round(o.value * 1e8));
    if (v <= 0n) continue;
    const sold = tokensSold(v);
    if (sold < 0n || sold > CURVE_TOKENS) continue;
    const t = POOL_LP + (CURVE_TOKENS - sold);
    if (p2wsh(poolWS(cid, t)) !== hex) continue;
    q.pPut.run(cidHex, tx.txid, o.n, v.toString(), t.toString(), h);
    q.pLog.run(h, cidHex, tx.txid, o.n, v.toString(), t.toString());
    return true;
  }
  return false;
}
// POOL_BUY(P) / POOL_SELL(Q): prev pool = DB row for the spent outpoint (gbx side)
// + revealed witness (token side); recompute the consensus transition, record output.
function applyPoolOp(h, tx, it){
  const cidHex = it.cid.toString('hex');
  for (const vin of (tx.vin||[])){
    const wit = vin.txinwitness; if (!wit || !wit.length) continue;
    const pw = parsePoolWS(Buffer.from(wit[wit.length-1],'hex'));
    if (!pw || pw.cid !== cidHex) continue;
    const prev = q.pByOut.get(vin.txid, vin.vout);
    if (!prev){ console.error('[tokenidx] pool op without known pool state', cidHex.slice(0,16)); return; }
    const g = BigInt(prev.gbx_sat);
    let next = null;
    if (it.op === 'P'){
      const net = it.amount - poolFee(it.amount);
      next = poolBuyCalc(g, pw.tokens, net);
    } else {
      next = poolSellCalc(g, pw.tokens, it.amount);
    }
    if (!next) return;
    const spk = p2wsh(poolWS(it.cid, next.newTok));
    for (const o of tx.vout){
      if ((((o.scriptPubKey||{}).hex)||'') !== spk) continue;
      const v = BigInt(Math.round(o.value * 1e8));
      q.pPut.run(cidHex, tx.txid, o.n, v.toString(), next.newTok.toString(), h);
      q.pLog.run(h, cidHex, tx.txid, o.n, v.toString(), next.newTok.toString());
      return;
    }
    return;
  }
}

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
CREATE TABLE IF NOT EXISTS coin_meta(
  coin_id TEXT PRIMARY KEY, ticker TEXT NOT NULL, name TEXT NOT NULL,
  txid TEXT NOT NULL, height INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS coin_logo(
  coin_id TEXT NOT NULL, idx INTEGER NOT NULL, total INTEGER NOT NULL,
  hash16 TEXT NOT NULL, data BLOB NOT NULL, txid TEXT, height INTEGER,
  PRIMARY KEY(coin_id, idx));
CREATE TABLE IF NOT EXISTS coin_logo_full(
  coin_id TEXT PRIMARY KEY, data BLOB NOT NULL, txid TEXT, height INTEGER);
CREATE TABLE IF NOT EXISTS coin_meta2(
  coin_id TEXT PRIMARY KEY, desc TEXT NOT NULL DEFAULT '',
  links TEXT NOT NULL DEFAULT '', txid TEXT NOT NULL, height INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS curves(
  coin_id TEXT PRIMARY KEY, creator_pk TEXT NOT NULL DEFAULT '',
  txid TEXT NOT NULL, vout INTEGER NOT NULL,
  reserve TEXT NOT NULL, m TEXT NOT NULL, h_m INTEGER NOT NULL,
  height INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'live');
CREATE TABLE IF NOT EXISTS curve_log(
  height INTEGER NOT NULL, coin_id TEXT NOT NULL,
  txid TEXT NOT NULL, vout INTEGER NOT NULL,
  reserve TEXT NOT NULL, m TEXT NOT NULL, h_m INTEGER NOT NULL, status TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS cl_h ON curve_log(height);
CREATE TABLE IF NOT EXISTS pools(
  coin_id TEXT PRIMARY KEY, txid TEXT NOT NULL, vout INTEGER NOT NULL,
  gbx_sat TEXT NOT NULL, tokens TEXT NOT NULL, height INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pool_log(
  height INTEGER NOT NULL, coin_id TEXT NOT NULL,
  txid TEXT NOT NULL, vout INTEGER NOT NULL,
  gbx_sat TEXT NOT NULL, tokens TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS pl_h ON pool_log(height);
CREATE TABLE IF NOT EXISTS curve_ops(
  height INTEGER NOT NULL, txid TEXT NOT NULL, coin_id TEXT NOT NULL,
  op TEXT NOT NULL, pk TEXT NOT NULL, amount TEXT NOT NULL,
  tokens_out TEXT NOT NULL, burn_sat TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS co_h ON curve_ops(height);
CREATE INDEX IF NOT EXISTS co_pk ON curve_ops(pk);
`);
try{ db.exec("ALTER TABLE curves ADD COLUMN creator_pk TEXT NOT NULL DEFAULT ''"); }catch(_e){}
const q = {
  getMeta:  db.prepare('SELECT v FROM meta WHERE k=?'),
  setMeta:  db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
  blkHash:  db.prepare('SELECT hash FROM blocks WHERE height=?'),
  putBlk:   db.prepare('INSERT OR REPLACE INTO blocks(height,hash) VALUES(?,?)'),
  pruneBlk: db.prepare('DELETE FROM blocks WHERE height < ?'),
  spend:    db.prepare('UPDATE token_utxos SET spent_height=? WHERE txid=? AND vout=? AND spent_height IS NULL'),
  insert:   db.prepare('INSERT OR IGNORE INTO token_utxos(txid,vout,coin_id,pk,amount,height) VALUES(?,?,?,?,?,?)'),
  // Spend is recorded before a transfer is read, so the holding being moved is
  // already marked spent: the lookup must not filter on that.
  tuGet:    db.prepare('SELECT coin_id, amount FROM token_utxos WHERE txid=? AND vout=?'),
  rbNew:    db.prepare('DELETE FROM token_utxos WHERE height > ?'),
  rbSpent:  db.prepare('UPDATE token_utxos SET spent_height=NULL WHERE spent_height > ?'),
  rbBlk:    db.prepare('DELETE FROM blocks WHERE height > ?'),
  holdings: db.prepare(`SELECT coin_id, pk, SUM(CAST(amount AS INTEGER)) amt
                        FROM token_utxos WHERE spent_height IS NULL GROUP BY coin_id, pk`),
  cGet:     db.prepare('SELECT * FROM curves WHERE coin_id=?'),
  cByOut:   db.prepare('SELECT * FROM curves WHERE txid=? AND vout=?'),
  mGet:     db.prepare('SELECT ticker,name FROM coin_meta WHERE coin_id=?'),
  mTicker:  db.prepare('SELECT coin_id FROM coin_meta WHERE ticker=?'),
  mPut:     db.prepare('INSERT OR IGNORE INTO coin_meta(coin_id,ticker,name,txid,height) VALUES(?,?,?,?,?)'),
  mRb:      db.prepare('DELETE FROM coin_meta WHERE height>?'),
  m2Get:    db.prepare('SELECT desc,links FROM coin_meta2 WHERE coin_id=?'),
  m2Put:    db.prepare('INSERT OR IGNORE INTO coin_meta2(coin_id,desc,links,txid,height) VALUES(?,?,?,?,?)'),
  m2Rb:     db.prepare('DELETE FROM coin_meta2 WHERE height>?'),
  lgPut:    db.prepare('INSERT OR IGNORE INTO coin_logo(coin_id,idx,total,hash16,data,txid,height) VALUES(?,?,?,?,?,?,?)'),
  lgAll:    db.prepare('SELECT idx,total,hash16,data FROM coin_logo WHERE coin_id=? ORDER BY idx'),
  lgFull:   db.prepare('SELECT coin_id FROM coin_logo_full WHERE coin_id=?'),
  lgFullPut:db.prepare('INSERT OR IGNORE INTO coin_logo_full(coin_id,data,txid,height) VALUES(?,?,?,?)'),
  lgRb:     db.prepare('DELETE FROM coin_logo WHERE height>?'),
  lgFullRb: db.prepare('DELETE FROM coin_logo_full WHERE height>?'),
  cPk:      db.prepare('SELECT creator_pk FROM curves WHERE coin_id=?'),
  cSetPk:   db.prepare('UPDATE curves SET creator_pk=? WHERE coin_id=?'),
  cPut:     db.prepare(`INSERT INTO curves(coin_id,txid,vout,reserve,m,h_m,height,status)
                        VALUES(?,?,?,?,?,?,?,?)
                        ON CONFLICT(coin_id) DO UPDATE SET txid=excluded.txid, vout=excluded.vout,
                        reserve=excluded.reserve, m=excluded.m, h_m=excluded.h_m,
                        height=excluded.height, status=excluded.status`),
  cLog:     db.prepare('INSERT INTO curve_log(height,coin_id,txid,vout,reserve,m,h_m,status) VALUES(?,?,?,?,?,?,?,?)'),
  cRb:      db.prepare('DELETE FROM curve_log WHERE height > ?'),
  pGet:     db.prepare('SELECT * FROM pools WHERE coin_id=?'),
  pByOut:   db.prepare('SELECT * FROM pools WHERE txid=? AND vout=?'),
  pPut:     db.prepare('INSERT INTO pools(coin_id,txid,vout,gbx_sat,tokens,height) VALUES(?,?,?,?,?,?) ON CONFLICT(coin_id) DO UPDATE SET txid=excluded.txid, vout=excluded.vout, gbx_sat=excluded.gbx_sat, tokens=excluded.tokens, height=excluded.height'),
  pLog:     db.prepare('INSERT INTO pool_log(height,coin_id,txid,vout,gbx_sat,tokens) VALUES(?,?,?,?,?,?)'),
  pRb:      db.prepare('DELETE FROM pool_log WHERE height > ?'),
  pLast:    db.prepare('SELECT * FROM pool_log WHERE coin_id=? ORDER BY height DESC, rowid DESC LIMIT 1'),
  pAllIds:  db.prepare('SELECT DISTINCT coin_id FROM pool_log'),
  pDel:     db.prepare('DELETE FROM pools WHERE coin_id=?'),
  opPut:    db.prepare('INSERT INTO curve_ops(height,txid,coin_id,op,pk,amount,tokens_out,burn_sat) VALUES(?,?,?,?,?,?,?,?)'),
  opRb:     db.prepare('DELETE FROM curve_ops WHERE height > ?'),
  cLast:    db.prepare(`SELECT * FROM curve_log WHERE coin_id=? ORDER BY height DESC, rowid DESC LIMIT 1`),
  cAllIds:  db.prepare('SELECT DISTINCT coin_id FROM curve_log'),
  cAll:     db.prepare(`SELECT * FROM curves ORDER BY height`),
};
function curveApply(h, tx, cid, m, hM, status){
  // find the recreated curve output exactly like consensus CurveOutputValue
  const spk = p2wsh(curveWS(Buffer.from(cid,'hex'), m, hM));
  let found=null;
  for (const o of tx.vout) if (o.scriptPubKey.hex === spk){ if(found) return; found=o; }
  if (found){
    const res = BigInt(Math.round(found.value * 1e8));
    q.cPut.run(cid, tx.txid, found.n, res.toString(), m.toString(), hM, h, status);
    q.cLog.run(h, cid, tx.txid, found.n, res.toString(), m.toString(), hM, status);
  } else {
    q.cPut.run(cid, tx.txid, -1, '0', m.toString(), hM, h, status==='live' ? 'closed' : status);
    q.cLog.run(h, cid, tx.txid, -1, '0', m.toString(), hM, status==='live' ? 'closed' : status);
  }
}
const scanned = () => parseInt(q.getMeta.get('scanned')?.v ?? String(START - 1), 10);

const rollbackTo = db.transaction(h => {
  q.rbNew.run(h); q.rbSpent.run(h); q.rbBlk.run(h);
  q.cRb.run(h);
  q.mRb.run(h);
  q.m2Rb.run(h);
  q.lgRb.run(h);
  q.lgFullRb.run(h);
  q.opRb.run(h);
  q.pRb.run(h);
  for (const {coin_id} of q.pAllIds.all()){
    const last = q.pLast.get(coin_id);
    if (last) q.pPut.run(coin_id, last.txid, last.vout, last.gbx_sat, last.tokens, last.height);
    else q.pDel.run(coin_id);
  }
  for (const {coin_id} of q.cAllIds.all()){
    const last = q.cLast.get(coin_id);
    if (last) q.cPut.run(coin_id, last.txid, last.vout, last.reserve, last.m, last.h_m, last.height, last.status);
    else db.prepare('DELETE FROM curves WHERE coin_id=?').run(coin_id);
  }
  q.setMeta.run('scanned', String(h));
});
const applyBlock = db.transaction((h, blk) => {
  for (const tx of blk.tx){
    for (const vin of (tx.vin || []))
      if (vin.txid !== undefined) q.spend.run(h, vin.txid, vin.vout);
    const it = parseIntent(tx);
    // ── curve tracking — runs for EVERY curve op, tokensOut or not ──
    if (it && 'CBSRG'.includes(it.op) && !(LAUNCH_H > 0 && h < LAUNCH_H)){ // pre-activation X ops are NOT consensus-guarded -> never indexed
      const cidHex = it.cid.toString('hex');
      if (it.op === 'C'){
        const net = it.amount - (it.amount*FEE_BPS)/10000n;
        const born = curveBuy0(net);
        // the client declares (M=net, hM) in the new script; read it back from the outputs
        if (born){
          for (const o of tx.vout){
            const hexs = o.scriptPubKey.hex || '';
            if (!hexs.startsWith('0020')) continue;
            // try the two possible stamps cheaply: scan curve_log is empty for a birth,
            // so rebuild with M=net and every fresh stamp until it matches
            for (let d=0; d<=100 && h-d>=0; d++){
              if (hexs === p2wsh(curveWS(it.cid, net, h-d))){
                q.cPut.run(cidHex, tx.txid, o.n, born.reserve.toString(), net.toString(), h-d, h, 'live');
                q.cSetPk.run(it.pk.toString('hex'), cidHex);
                q.cLog.run(h, cidHex, tx.txid, o.n, born.reserve.toString(), net.toString(), h-d, 'live');
                d=101; break;
              }
            }
          }
        }
      } else {
        // spend path: the revealed witness of the curve input carries (M, h_M)
        for (const vin of (tx.vin||[])){
          const wit = vin.txinwitness; if(!wit || !wit.length) continue;
          const st = parseCurveWS(Buffer.from(wit[wit.length-1],'hex'));
          if (!st || st.cid !== cidHex) continue;
          if (it.op === 'G'){ curveApply(h, tx, cidHex, st.m, st.hM, 'graduated'); poolFromTx(h, tx, cidHex); break; }
          // B/S/R: consensus M-transition (REFUND never updates M)
          let m=st.m, hM=st.hM;
          if (it.op !== 'R'){
            let trade=0n;
            if (it.op==='B') trade = it.amount - (it.amount*FEE_BPS)/10000n;
            else { // SELL: gross out = trade; recompute from the spent reserve
              const prev = q.cByOut.get(vin.txid, vin.vout);
              if (prev){
                const r0=BigInt(prev.reserve), cur=V_GBX+r0, curTok=KCURVE/cur;
                const g = cur - KCURVE/(curTok+it.amount);
                if (g>0n) trade = g>r0 ? r0 : g;
              }
            }
            if (trade>0n){
              const expired = hM!==0 && (h - hM) > GRAD_WINDOW;
              if (expired || trade>m){
                m=trade;
                // stamp declared by the client: recover it from the outputs (fresh window)
                let hit=-1;
                for (let d=0; d<=100 && h-d>=0; d++){
                  const spk=p2wsh(curveWS(it.cid, m, h-d));
                  if (tx.vout.some(o=>o.scriptPubKey.hex===spk)){ hit=h-d; break; }
                }
                hM = hit>=0 ? hit : h;
              }
            }
          }
          curveApply(h, tx, cidHex, m, hM, 'live');
          break;
        }
      }
    }
    if (it && 'PQ'.includes(it.op) && !(LAUNCH_H > 0 && h < LAUNCH_H)){
      applyPoolOp(h, tx, it);
    }
    if (it && 'CBSRGPQ'.includes(it.op) && !(LAUNCH_H > 0 && h < LAUNCH_H)){
      q.opPut.run(h, tx.txid, it.cid.toString('hex'), it.op, it.pk.toString('hex'),
                  it.amount.toString(), it.tokensOut.toString(), burnedAmount(tx).toString());
    }
    const meta = parseMeta(tx);
    if (meta){
      const row = q.cPk.get(meta.cid);
      if (row && row.creator_pk && witnessPks(tx).has(row.creator_pk)
          && !q.mGet.get(meta.cid) && !q.mTicker.get(meta.ticker))
        q.mPut.run(meta.cid, meta.ticker, meta.name, tx.txid, h);
    }
    const meta2 = parseMeta2(tx);
    if (meta2){
      const row2 = q.cPk.get(meta2.cid);
      if (row2 && row2.creator_pk && witnessPks(tx).has(row2.creator_pk)
          && !q.m2Get.get(meta2.cid))
        q.m2Put.run(meta2.cid, meta2.desc, meta2.links, tx.txid, h);
    }
    const lg = parseLogoChunk(tx);
    if (lg && !q.lgFull.get(lg.cid)){
      const rowL = q.cPk.get(lg.cid);
      if (rowL && rowL.creator_pk && witnessPks(tx).has(rowL.creator_pk)){
        q.lgPut.run(lg.cid, lg.idx, lg.total, lg.hash16, lg.data, tx.txid, h);
        const rows = q.lgAll.all(lg.cid);
        if (rows.length && rows.length === rows[0].total
            && rows.every(r => r.total === rows[0].total && r.hash16 === rows[0].hash16)){
          const full = Buffer.concat(rows.map(r => r.data));
          const want = rows[0].hash16;
          const got = sha256(full).subarray(0,16).toString('hex');
          if (got === want) q.lgFullPut.run(lg.cid, full, tx.txid, h);
        }
      }
    }
    // A declared transfer credits the recipient only when the output proves it.
    if (!it){
      const tr = parseTransfer(tx);
      if (tr && !(LAUNCH_H > 0 && h < LAUNCH_H)){
        const credit = (pkHex, amt) => {
          const spk = p2wsh(tokenWS(tr.cid, amt, Buffer.from(pkHex,'hex')));
          for (const o of tx.vout)
            if (o.scriptPubKey.hex === spk)
              q.insert.run(tx.txid, o.n, tr.cid.toString('hex'), pkHex, amt.toString(), h);
        };
        credit(tr.pk.toString('hex'), tr.amount);
        // The move itself enters the history: one row for the recipient (T),
        // one for the sender (U). Same source of truth as every curve op.
        q.opPut.run(h, tx.txid, tr.cid.toString('hex'), 'T', tr.pk.toString('hex'), '0', tr.amount.toString(), '0');
        for (const senderPk of witnessPks(tx)){
          if (senderPk === tr.pk.toString('hex')) continue;
          q.opPut.run(h, tx.txid, tr.cid.toString('hex'), 'U', senderPk, tr.amount.toString(), '0', '0');
          break;
        }
        // What the sender keeps is part of the same move. The spent holdings are
        // known, so the remainder is arithmetic, not a claim -- and it still has
        // to match an output before it counts.
        let spentIn = 0n;
        for (const vin of (tx.vin || [])){
          const prev = q.tuGet.get(vin.txid, vin.vout);
          if (prev && prev.coin_id === tr.cid.toString('hex')) spentIn += BigInt(prev.amount);
        }
        const back = spentIn - tr.amount;
        if (back > 0n) for (const pkHex of witnessPks(tx)) credit(pkHex, back);
      }
    }
    if (!it || !'CBPSRQ'.includes(it.op) || it.tokensOut <= 0n) continue;  // C,B,P mint; S,R,Q return change  // C,B,P mint tokens; S,R return change — every one of them creates a token UTXO
    if (LAUNCH_H > 0 && h < LAUNCH_H) continue; // pre-activation X ops are NOT consensus-guarded -> never minted
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
  scanBurnTotal(q);
  return s;
}
function dump(){
  const rows = q.holdings.all();
  console.log(`tip=${scanned()} live_holdings=${rows.length}`);
  for (const r of rows)
    console.log(`  coin=${r.coin_id.slice(0,16)}.. holder=${r.pk.slice(0,16)}.. amount=${Number(r.amt).toLocaleString('en-US')}`);
  // HONEST graduation progress — R vs max(N*M_live, R_MIN), plus tokens/800M.
  const tip = scanned();
  for (const c of q.cAll.all()){
    const R=BigInt(c.reserve), m=BigInt(c.m);
    const mLive = c.h_m!==0 && (tip - c.h_m) <= GRAD_WINDOW;
    const bar = (mLive ? (m*GRAD_N > GRAD_MIN ? m*GRAD_N : GRAD_MIN) : GRAD_MIN);
    const sold = tokensSold(R);
    const pctR = bar>0n ? Number(R*10000n/bar)/100 : 0;
    const pctT = Number(sold*10000n/CURVE_TOKENS)/100;
    const md = q.mGet.get(c.coin_id);
    const lbl = md ? ` $${md.ticker} "${md.name}"` : '';
    console.log(`  curve=${c.coin_id.slice(0,16)}..${lbl} status=${c.status} R=${(Number(R)/1e8).toFixed(2)} GBX`+
      ` M=${(Number(m)/1e8).toFixed(2)}${mLive?'(live)':'(expired)'} bar=${(Number(bar)/1e8).toFixed(2)}`+
      ` progress=${Math.min(pctR,100).toFixed(1)}% sold=${pctT.toFixed(2)}%`);
  }
}
// One-time recovery: a pool graduated before this index existed is rebuilt
// deterministically from its graduate block. No extra state, no server.
function bootstrapPools(){
  for (const c of q.cAll.all()){
    if (c.status !== 'graduated' || q.pGet.get(c.coin_id)) continue;
    try{
      const blk = cli('getblock', cli('getblockhash', c.height), 2);
      const tx = (blk.tx||[]).find(t => t.txid === c.txid);
      if (tx && poolFromTx(c.height, tx, c.coin_id))
        console.log('[tokenidx] pool bootstrapped for', c.coin_id.slice(0,16));
    }catch(e){ console.error('[tokenidx] pool bootstrap', e.message); }
  }
}
bootstrapPools();
if (MODE === '--oneshot'){ console.log(`[tokenidx] synced to ${syncOnce()}`); }
else if (MODE === '--dump'){ dump(); }
else { (async () => { for(;;){ try { syncOnce(); } catch(e){ console.error('[tokenidx]', e.message); } await new Promise(r=>setTimeout(r, POLL_MS)); } })(); }

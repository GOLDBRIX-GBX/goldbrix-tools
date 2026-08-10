'use strict';
// Read-only view over the keyless trade index. Price/volume are DERIVED from two chains
// (L1 HTLC claim + EVM USDC lock, joined on hashlock). Refunds are NOT trades and are excluded.
const Database = require('better-sqlite3');
const DB_PATH = process.env.GBX_TRADE_DB || '/var/lib/goldbrix/index/gbx-trades.db';
let _db = null;
function db(){ if(!_db){ _db = new Database(DB_PATH, {readonly:true, fileMustExist:true}); } return _db; }

const SQL_TRADES = `
  SELECT g.ts AS ts, g.gbx_sats AS gbx_sats, u.usdc_micro AS usdc_micro, u.chain AS chain, g.txid AS txid
  FROM gbx_legs g JOIN usdc_legs u ON g.hashlock = u.hashlock
  WHERE g.kind = 'claim' AND g.gbx_sats > 0 AND u.usdc_micro > 0
  ORDER BY g.ts ASC`;

function trades(limit) {
  const rows = db().prepare(SQL_TRADES).all();
  const out = rows.map(r => ({
    ts: r.ts * 1000,
    price_usd: (r.usdc_micro / 1e6) / (r.gbx_sats / 1e8),
    volume_gbx: r.gbx_sats / 1e8,
    usdc: r.usdc_micro / 1e6,
    chain: r.chain,
    txid: r.txid,
  }));
  return limit > 0 ? out.slice(-limit) : out;
}

function candles(intervalMs, limit) {
  const t = trades(0);
  const cm = {};
  for (const x of t) {
    const b = Math.floor(x.ts / intervalMs) * intervalMs;
    const c = cm[b];
    if (!c) cm[b] = { time: b, open: x.price_usd, high: x.price_usd, low: x.price_usd, close: x.price_usd, volume_gbx: x.volume_gbx, trades: 1 };
    else { c.high = Math.max(c.high, x.price_usd); c.low = Math.min(c.low, x.price_usd); c.close = x.price_usd; c.volume_gbx += x.volume_gbx; c.trades++; }
  }
  const arr = Object.values(cm).sort((a,b) => a.time - b.time);
  return limit > 0 ? arr.slice(-limit) : arr;
}

function stats() {
  const t = trades(0);
  if (!t.length) return { trades: 0, last_price_usd: null, source: 'onchain-derived' };
  const now = Date.now(), day = 86400000;
  const last24 = t.filter(x => x.ts >= now - day);
  const prev = t.filter(x => x.ts < now - day);
  const last = t[t.length-1].price_usd;
  const ref = prev.length ? prev[prev.length-1].price_usd : t[0].price_usd;
  return {
    trades: t.length,
    last_price_usd: last,
    change_24h_pct: ref > 0 ? ((last - ref) / ref) * 100 : 0,
    volume_24h_gbx: last24.reduce((s,x) => s + x.volume_gbx, 0),
    volume_24h_usd: last24.reduce((s,x) => s + x.usdc, 0),
    trades_24h: last24.length,
    high_24h: last24.length ? Math.max(...last24.map(x=>x.price_usd)) : last,
    low_24h:  last24.length ? Math.min(...last24.map(x=>x.price_usd)) : last,
    first_ts: t[0].ts, last_ts: t[t.length-1].ts,
    source: 'onchain-derived',
    method: 'L1 HTLC claim (witness=4) joined to EVM USDC Locked event on the same hashlock. Keyless, no LP is trusted.',
  };
}
// Live USDC locks on Solana for one receiver address. A browser cannot ask the
// chain this question - public endpoints refuse getProgramAccounts or answer
// without the account key - so every node answers it instead, and the client
// still proves each row against the chain before signing anything.
function solLocksByReceiver(receiverB58) {
  const r = String(receiverB58 || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r)) return { ok:false, error:'bad_receiver', locks:[] };
  let rows = [];
  try {
    rows = db().prepare(
      `SELECT pda,receiver,mint,amount,hashlock,timelock,buyer_pk,seen
         FROM sol_locks WHERE receiver=? AND claimed=0 AND refunded=0
         ORDER BY timelock DESC`).all(r);
  } catch (e) { return { ok:false, error:'not_indexed', locks:[] }; }
  const now = Math.floor(Date.now() / 1000);
  let seen = 0;
  try { const m = db().prepare(`SELECT MAX(seen) s FROM sol_locks`).get(); seen = (m && m.s) || 0; } catch (_e) {}
  return {
    ok: true,
    // How stale this answer may be. A client that cares can refuse an old one.
    indexed_age_s: seen ? (now - seen) : null,
    locks: rows.map(x => ({
      pda: x.pda, receiver: x.receiver, mint: x.mint,
      amount: String(x.amount), hashlock: '0x' + x.hashlock,
      timelock: x.timelock, buyer_pk: x.buyer_pk || null,
      claimed: false, refunded: false
    }))
  };
}

// Settled state per hashlock, answered from the node's own tables. The contract
// itself said it (Claimed / Refunded on EVM, the swap account on Solana); the
// node only remembers, so a phone does not have to ask a chain dozens of times
// just to draw a label. Money still moves only after the client proves the lock
// against the chain.
function settledByHashlocks(list) {
  const hls = (Array.isArray(list) ? list : [])
    .map(x => String(x || '').replace(/^0x/, '').toLowerCase())
    .filter(x => /^[0-9a-f]{64}$/.test(x)).slice(0, 200);
  const out = {};
  if (!hls.length) return { ok: true, indexed_age_s: null, settled: out };
  let age = null;
  try {
    const d = db();
    const evm = d.prepare(
      `SELECT m.hashlock h, s.kind k FROM lock_map m
         JOIN htlc_settled s ON s.lock_id = m.lock_id`).all();
    for (const r of evm) {
      const h = String(r.h).replace(/^0x/, '').toLowerCase();
      if (hls.includes(h)) out[h] = r.k;
    }
    const sol = d.prepare(
      `SELECT hashlock h, claimed c, refunded r FROM sol_locks`).all();
    for (const r of sol) {
      const h = String(r.h).replace(/^0x/, '').toLowerCase();
      if (hls.includes(h) && (r.c || r.r)) out[h] = r.c ? 'claimed' : 'refunded';
    }
    const now = Math.floor(Date.now() / 1000);
    const m = d.prepare(`SELECT MAX(seen) s FROM htlc_settled`).get();
    age = (m && m.s) ? (now - m.s) : null;
  } catch (e) { return { ok: false, error: 'not_indexed', settled: {} }; }
  return { ok: true, indexed_age_s: age, settled: out };
}

// The mirror of the query above, for the other side of the same lock: the
// buyer knows only their own address, and no public Solana endpoint will
// enumerate accounts for a browser.
function solLocksBySender(senderB58) {
  const r = String(senderB58 || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r)) return { ok:false, error:'bad_sender', locks:[] };
  let rows = [];
  try {
    rows = db().prepare(
      `SELECT pda,receiver,mint,amount,hashlock,timelock,buyer_pk,seen
         FROM sol_locks WHERE sender=? AND claimed=0 AND refunded=0
         ORDER BY timelock DESC`).all(r);
  } catch (e) { return { ok:false, error:'not_indexed', locks:[] }; }
  const now = Math.floor(Date.now() / 1000);
  let seen = 0;
  try { const m = db().prepare(`SELECT MAX(seen) s FROM sol_locks`).get(); seen = (m && m.s) || 0; } catch (_e) {}
  return {
    ok: true,
    // How stale this answer may be. A client that cares can refuse an old one.
    indexed_age_s: seen ? (now - seen) : null,
    locks: rows.map(x => ({
      pda: x.pda, receiver: x.receiver, mint: x.mint,
      amount: String(x.amount), hashlock: '0x' + x.hashlock,
      timelock: x.timelock, buyer_pk: x.buyer_pk || null,
      claimed: false, refunded: false
    }))
  };
}

module.exports = { trades, candles, stats, solLocksByReceiver, solLocksBySender, settledByHashlocks, DB_PATH };

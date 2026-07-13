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
module.exports = { trades, candles, stats, DB_PATH };

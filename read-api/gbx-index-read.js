'use strict';
const Database = require('better-sqlite3');
const DB_PATH = process.env.GBX_INDEX_DB || '/root/goldbrix-one/server/gbx-index.db';
let _db = null;
function db(){ if(!_db){ _db = new Database(DB_PATH, {readonly:true, fileMustExist:true}); } return _db; }
function tipHeight(){ try { const r = db().prepare('SELECT MAX(height) h FROM blocks').get(); return r ? r.h : null; } catch(_){ return null; } }
// intoarce obiect compatibil scantxoutset: {success,height,total_amount,unspents[]}
function scanLikeIndex(address){
  const tip = tipHeight();
  if (tip == null) return null; // semnaleaza fallback
  const rows = db().prepare('SELECT txid,vout,sats,height,spk,coinbase FROM utxos WHERE address=? AND spent_height IS NULL').all(address);
  let total = 0;
  const unspents = rows.map(r=>{ total += r.sats; return {
    txid: r.txid, vout: r.vout, scriptPubKey: r.spk,
    amount: r.sats/1e8, height: r.height,
    confirmations: tip - r.height + 1,
    coinbase: r.coinbase === 1,
  }; });
  return { success:true, height:tip, total_amount: total/1e8, unspents };
}
module.exports = { scanLikeIndex, tipHeight };

// Sumar rapid: total/spendable/utxo direct in SQL, fara materializare.
// spendable = exclude coinbase imatur (<100 conf). NU stie de mempool (ajustat in caller).
function summaryFast(address){
  const tip = tipHeight();
  if (tip == null) return null;
  const row = db().prepare(`
    SELECT
      COUNT(*) utxo,
      COALESCE(SUM(sats),0) total,
      COALESCE(SUM(CASE WHEN coinbase=0 OR (?-height+1)>=100 THEN sats ELSE 0 END),0) spendable
    FROM utxos WHERE address=? AND spent_height IS NULL
  `).get(tip, address);
  return { tip, utxo: row.utxo, total_sats: row.total, spendable_sats: row.spendable };
}
module.exports.summaryFast = summaryFast;

function utxoOne(address, txid, vout){
  try { const r = db().prepare('SELECT sats,height,coinbase FROM utxos WHERE address=? AND txid=? AND vout=? AND spent_height IS NULL').get(address,txid,vout);
    return r ? { sats:r.sats, height:r.height, coinbase:r.coinbase===1 } : null; } catch(_){ return null; }
}
module.exports.utxoOne = utxoOne;

// Address history derived from the existing UTXO index. Net movement per block:
// credit = outputs created for the address at height h; debit = outputs spent at h.
// net>0 = received, net<0 = sent (change already netted out). Spender txid is not
// stored by the indexer -> txid only on credits; honest null on debits.
function txHistory(address, limit){
  const tip = tipHeight(); if (tip == null) return null;
  const lim = Math.min(Math.max(parseInt(limit||50,10)||50,1),200);
  // Streaming on (address,height)/(address,spent_height) indexes with LIMIT — stops early
  // on huge addresses (mining: 1.6M rows) instead of aggregating the full set.
  const credits = db().prepare('SELECT height h, SUM(sats) s, MAX(coinbase) cb, MIN(txid) tx FROM utxos WHERE address=? GROUP BY height ORDER BY height DESC LIMIT ?').all(address, lim*3);
  const debits  = db().prepare('SELECT spent_height h, SUM(sats) s FROM utxos WHERE address=? AND spent_height IS NOT NULL GROUP BY spent_height ORDER BY spent_height DESC LIMIT ?').all(address, lim*3);
  const m = new Map();
  for (const r of credits) m.set(r.h, {height:r.h, credit:r.s, debit:0, coinbase:r.cb===1, txid:r.tx});
  for (const r of debits){ const e=m.get(r.h)||{height:r.h,credit:0,debit:0,coinbase:false,txid:null}; e.debit=r.s; m.set(r.h,e); }
  const rows=[...m.values()].map(e=>{
    const net=e.credit-e.debit;
    return { height:e.height, confirmations:tip-e.height+1,
      kind: e.coinbase?'mined':(net>=0?'in':'out'),
      amount_sat: Math.abs(net), txid: net>=0?e.txid:null };
  }).filter(e=>e.amount_sat>0).sort((a,b)=>b.height-a.height).slice(0,lim);
  return { success:true, height:tip, txs:rows };
}
module.exports.txHistory = txHistory;


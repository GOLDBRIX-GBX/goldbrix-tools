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

// Top-N UTXOs straight from SQL: SUM for the totals, ORDER BY sats DESC LIMIT for
// the rows. Keeps miner-scale addresses (1M+ UTXOs) at index speed instead of
// materializing every row in JS.
function scanTopN(address, limit){
  const tip = tipHeight();
  if (tip == null) return null;
  const agg = db().prepare('SELECT COUNT(*) c, COALESCE(SUM(sats),0) t FROM utxos WHERE address=? AND spent_height IS NULL').get(address);
  const rows = db().prepare('SELECT txid,vout,sats,height,spk,coinbase FROM utxos WHERE address=? AND spent_height IS NULL ORDER BY sats DESC LIMIT ?').all(address, limit);
  const unspents = rows.map(r=>({
    txid: r.txid, vout: r.vout, scriptPubKey: r.spk,
    amount: r.sats/1e8, height: r.height,
    confirmations: tip - r.height + 1,
    coinbase: r.coinbase === 1,
  }));
  return { success:true, height:tip, total_amount: agg.t/1e8, total_count: agg.c, unspents };
}
module.exports.scanTopN = scanTopN;

// Burns sent straight to the canonical burn address, newest first.
function directBurns(address, limit){
  try{
    const rows = db().prepare('SELECT txid,vout,sats,height FROM utxos WHERE address=? ORDER BY height DESC LIMIT ?').all(address, limit||100);
    return rows.map(r=>({height:r.height, txid:r.txid, vout:r.vout, sats:String(r.sats)}));
  }catch(_e){ return []; }
}
module.exports.directBurns = directBurns;

// Quick summary: total/spendable/utxo straight from SQL, no materialization.
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
      /* A block can hold both a reward and a spend of ours. Calling that block
         'mined' hides the spend and shows only the net, so the label follows the
         reward only when nothing was spent at that height. */
      kind: (e.coinbase && !e.debit)?'mined':(net>=0?'in':'out'),
      amount_sat: Math.abs(net), txid: net>=0?e.txid:null };
  }).filter(e=>e.amount_sat>0).sort((a,b)=>b.height-a.height).slice(0,lim);
  return { success:true, height:tip, txs:rows };
}
module.exports.txHistory = txHistory;

// txid -> block height, from the UTXO index (every tx creates at least one output;
// spent rows are kept, so history lookups keep working after outputs are spent).
function txHeight(txid){
  const r = db().prepare('SELECT height FROM utxos WHERE txid=? LIMIT 1').get(txid);
  return r ? r.height : null;
}
module.exports.txHeight = txHeight;



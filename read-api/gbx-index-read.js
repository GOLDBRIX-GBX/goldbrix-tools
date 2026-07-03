'use strict';
const Database = require('better-sqlite3');
const DB_PATH = '/root/goldbrix-one/server/gbx-index.db';
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

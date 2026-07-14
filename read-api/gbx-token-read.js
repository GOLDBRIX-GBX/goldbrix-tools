#!/usr/bin/env node
// IDEE V token-index reader: read-only queries over token-index.db for read-api.
// Keyless. No writes. Returns plain objects ready for JSON.
'use strict';
const Database = require(process.env.GBX_SQLITE_MOD || '/root/goldbrix-tools/read-api/node_modules/better-sqlite3');

function openTokenIndex(dbPath){
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const q = {
    meta: db.prepare('SELECT v FROM meta WHERE k=?'),
    coins: db.prepare(`SELECT coin_id,
                              COUNT(DISTINCT pk) holders,
                              SUM(CAST(amount AS INTEGER)) supply_live,
                              MIN(height) first_height, MAX(height) last_height
                       FROM token_utxos WHERE spent_height IS NULL
                       GROUP BY coin_id ORDER BY last_height DESC`),
    holders: db.prepare(`SELECT pk, SUM(CAST(amount AS INTEGER)) amount, COUNT(*) utxos
                         FROM token_utxos WHERE coin_id=? AND spent_height IS NULL
                         GROUP BY pk ORDER BY amount DESC LIMIT ?`),
    holderCount: db.prepare(`SELECT COUNT(DISTINCT pk) n FROM token_utxos
                             WHERE coin_id=? AND spent_height IS NULL`),
  };
  return {
    registry(){
      return { scanned: parseInt(q.meta.get('scanned')?.v ?? '-1', 10),
               coins: q.coins.all() };
    },
    coin(coinId, limit = 100){
      if (!/^[0-9a-f]{64}$/.test(coinId)) return null;
      const holders = q.holders.all(coinId, Math.min(limit, 1000));
      if (!holders.length) return null;
      return { coin_id: coinId,
               scanned: parseInt(q.meta.get('scanned')?.v ?? '-1', 10),
               holder_count: q.holderCount.get(coinId).n,
               holders };
    },
  };
}
module.exports = { openTokenIndex };

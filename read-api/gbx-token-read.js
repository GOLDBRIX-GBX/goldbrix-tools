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
    // IDEE X: curves live from the chain (rule X scanner tables)
    curves: db.prepare(`SELECT c.coin_id, c.txid, c.vout, c.reserve, c.m, c.h_m, c.height, c.status,
                               m.ticker, m.name,
                               (SELECT COUNT(DISTINCT pk) FROM token_utxos t
                                 WHERE t.coin_id=c.coin_id AND t.spent_height IS NULL) holders
                        FROM curves c LEFT JOIN coin_meta m ON m.coin_id=c.coin_id
                        ORDER BY c.height DESC`),
    curveOne: db.prepare(`SELECT c.coin_id, c.txid, c.vout, c.reserve, c.m, c.h_m, c.height, c.status,
                                 m.ticker, m.name
                          FROM curves c LEFT JOIN coin_meta m ON m.coin_id=c.coin_id
                          WHERE c.coin_id=?`),
    // IDEE X my-coins: what a pubkey holds / created — straight from the chain
    heldBy: db.prepare(`SELECT t.coin_id, SUM(CAST(t.amount AS INTEGER)) amount, COUNT(*) utxos,
                               m.ticker, m.name
                        FROM token_utxos t LEFT JOIN coin_meta m ON m.coin_id=t.coin_id
                        WHERE t.pk=? AND t.spent_height IS NULL
                        GROUP BY t.coin_id ORDER BY amount DESC LIMIT 500`),
    createdBy: db.prepare(`SELECT c.coin_id, c.reserve, c.m, c.h_m, c.height, c.status,
                                  m.ticker, m.name
                           FROM curves c LEFT JOIN coin_meta m ON m.coin_id=c.coin_id
                           WHERE c.creator_pk=? ORDER BY c.height DESC LIMIT 500`),
    curveLog: db.prepare(`SELECT height, reserve, m, h_m, status FROM curve_log
                          WHERE coin_id=? ORDER BY height ASC LIMIT ?`),
  };
  // honest graduation math — mirror of the scanner/consensus (BigInt, sats)
  const N=20n, R_MIN=200000000000n, K=201600, V_GBX=3000000000000n, V_TOKENS=1073000000n, KCURVE=V_GBX*V_TOKENS, CURVE_TOKENS=800000000n;
  function curveView(r, tip){
    const R=BigInt(r.reserve), M=BigInt(r.m);
    const mLive = r.h_m!==0 && (tip - r.h_m) <= K;
    const bar = mLive ? (M*N > R_MIN ? M*N : R_MIN) : R_MIN;
    const soldTok = V_TOKENS - (KCURVE/(V_GBX+R));
    return { coin_id:r.coin_id, ticker:r.ticker||null, name:r.name||null, status:r.status,
             curve_txid:r.txid, curve_vout:r.vout, height:r.height,
             reserve_sat:R.toString(), m_sat:M.toString(), h_m:r.h_m, m_live:mLive,
             bar_sat:bar.toString(),
             progress_pct: bar>0n ? Number(R*10000n/bar)/100 : 0,
             sold_tokens: soldTok.toString(),
             sold_pct: Number(soldTok*10000n/CURVE_TOKENS)/100,
             holders: r.holders };
  }
  return {
    registry(){
      return { scanned: parseInt(q.meta.get('scanned')?.v ?? '-1', 10),
               coins: q.coins.all() };
    },
    curvesAll(){
      const tip = parseInt(q.meta.get('scanned')?.v ?? '0', 10);
      return { scanned: tip, curves: q.curves.all().map(r => curveView(r, tip)) };
    },
    curveDetail(coinId, logLimit = 2000){
      if (!/^[0-9a-f]{64}$/.test(coinId)) return null;
      const r = q.curveOne.get(coinId);
      if (!r) return null;
      const tip = parseInt(q.meta.get('scanned')?.v ?? '0', 10);
      const out = curveView({...r, holders: q.holderCount.get(coinId).n}, tip);
      out.scanned = tip;
      out.log = q.curveLog.all(coinId, Math.min(logLimit, 5000))
                 .map(l => ({height:l.height, reserve_sat:l.reserve, m_sat:l.m, h_m:l.h_m, status:l.status}));
      out.holders_list = q.holders.all(coinId, 100);
      return out;
    },
    myCoins(pkHex){
      if (!/^[0-9a-f]{66}$/.test(pkHex)) return null;
      const tip = parseInt(q.meta.get('scanned')?.v ?? '0', 10);
      const held = q.heldBy.all(pkHex).map(r => ({
        coin_id:r.coin_id, ticker:r.ticker||null, name:r.name||null,
        amount:String(r.amount), utxos:r.utxos }));
      const created = q.createdBy.all(pkHex).map(r => curveView({...r, txid:null, vout:null, holders:undefined}, tip));
      return { scanned: tip, pk: pkHex, held, created };
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

#!/usr/bin/env node
// token-index reader: read-only queries over token-index.db for read-api.
// Keyless. No writes. Returns plain objects ready for JSON.
'use strict';
const Database = require(process.env.GBX_SQLITE_MOD || require('path').join(__dirname,'node_modules','better-sqlite3'));

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
    // curves live from the chain (launchpad scanner tables)
    curves: db.prepare(`SELECT c.coin_id, c.txid, c.vout, c.reserve, c.m, c.h_m, c.height, c.status,
                               m.ticker, m.name, m2.desc descr, m2.links,
                               (SELECT 1 FROM coin_logo_full lf WHERE lf.coin_id=c.coin_id) has_logo,
                               (SELECT COUNT(DISTINCT pk) FROM token_utxos t
                                 WHERE t.coin_id=c.coin_id AND t.spent_height IS NULL) holders
                        FROM curves c LEFT JOIN coin_meta m ON m.coin_id=c.coin_id
                                       LEFT JOIN coin_meta2 m2 ON m2.coin_id=c.coin_id
                        ORDER BY c.height DESC`),
    curveOne: db.prepare(`SELECT c.coin_id, c.creator_pk, c.txid, c.vout, c.reserve, c.m, c.h_m, c.height, c.status,
                                 m.ticker, m.name, m2.desc descr, m2.links,
                                 (SELECT 1 FROM coin_logo_full lf WHERE lf.coin_id=c.coin_id) has_logo
                          FROM curves c LEFT JOIN coin_meta m ON m.coin_id=c.coin_id
                                        LEFT JOIN coin_meta2 m2 ON m2.coin_id=c.coin_id
                          WHERE c.coin_id=?`),
    // my-coins: what a pubkey holds / created — straight from the chain
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
    holderUtxos: db.prepare(`SELECT txid, vout, amount FROM token_utxos
                             WHERE coin_id=? AND pk=? AND spent_height IS NULL
                             ORDER BY CAST(amount AS INTEGER) DESC LIMIT 50`),
    logoFull: db.prepare('SELECT data FROM coin_logo_full WHERE coin_id=?'),
  };
  // AMM pools after graduation (pool-index tables); absent on older DBs -> null.
  let pq = null;
  try {
    pq = {
      all: db.prepare(`SELECT p.coin_id, p.txid, p.vout, p.gbx_sat, p.tokens, p.height,
                              m.ticker, m.name
                       FROM pools p LEFT JOIN coin_meta m ON m.coin_id=p.coin_id
                       ORDER BY p.height DESC`),
      one: db.prepare('SELECT * FROM pools WHERE coin_id=?'),
      log: db.prepare(`SELECT height, txid, vout, gbx_sat, tokens FROM pool_log
                       WHERE coin_id=? ORDER BY height ASC LIMIT ?`),
    };
  } catch (_e) { pq = null; }
  // honest graduation math — mirror of the scanner/consensus (BigInt, base units)
  const N=20n, R_MIN=200000000000n, K=201600, V_GBX=3000000000000n, V_TOKENS=1073000000n, KCURVE=V_GBX*V_TOKENS, CURVE_TOKENS=800000000n;
  function curveView(r, tip){
    const R=BigInt(r.reserve), M=BigInt(r.m);
    const mLive = r.h_m!==0 && (tip - r.h_m) <= K;
    const bar = mLive ? (M*N > R_MIN ? M*N : R_MIN) : R_MIN;
    const soldTok = V_TOKENS - (KCURVE/(V_GBX+R));
    return { coin_id:r.coin_id, ticker:r.ticker||null, name:r.name||null, status:r.status,
             desc:r.descr||null, links:r.links||null, creator_pk:r.creator_pk||null,
             curve_txid:r.txid, curve_vout:r.vout, height:r.height,
             reserve_sat:R.toString(), m_sat:M.toString(), h_m:r.h_m, m_live:mLive,
             bar_sat:bar.toString(),
             progress_pct: bar>0n ? Number(R*10000n/bar)/100 : 0,
             sold_tokens: soldTok.toString(),
             sold_pct: Number(soldTok*10000n/CURVE_TOKENS)/100,
             holders: r.holders, has_logo: r.has_logo ? true : false };
  }
  function poolView(r){
    return { coin_id:r.coin_id, ticker:r.ticker||null, name:r.name||null,
             pool_txid:r.txid, pool_vout:r.vout, height:r.height,
             gbx_sat:String(r.gbx_sat), tokens:String(r.tokens),
             // spot price in base units per token (integer floor; quoting uses x*y=k)
             price_sat: BigInt(r.tokens) > 0n ? (BigInt(r.gbx_sat)/BigInt(r.tokens)).toString() : '0' };
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
      out.holders_list = q.holders.all(coinId, 100)
        .map(h => ({...h, utxo_list: q.holderUtxos.all(coinId, h.pk)}));
      if (pq){
        const p = pq.one.get(coinId);
        if (p) out.pool = poolView({...p, ticker:r.ticker, name:r.name});
      }
      try {
        const lf = q.logoFull.get(coinId);
        out.logo = lf ? ('data:image/webp;base64,' + Buffer.from(lf.data).toString('base64')) : null;
      } catch(_e){ out.logo = null; }
      return out;
    },
    coinTrades(coinId, limit = 100){
      // every consensus-guarded op on this coin, newest first — who bought/sold, from the chain
      if (!/^[0-9a-f]{64}$/.test(coinId)) return null;
      let rows=[];
      try{ rows = db.prepare('SELECT height, txid, op, pk, amount, tokens_out, burn_sat FROM curve_ops WHERE coin_id=? AND op<>char(84) AND op<>char(85) ORDER BY height DESC, rowid DESC LIMIT ?').all(coinId, Math.min(limit,500)); }catch(_e){ return { ok:true, trades: [] }; }
      return { ok:true, scanned: parseInt(q.meta.get('scanned')?.v ?? '0', 10),
        trades: rows.map(r=>({height:r.height, txid:r.txid, op:r.op, pk:r.pk,
          amount:String(r.amount), tokens:String(r.tokens_out), burn_sat:String(r.burn_sat)})) };
    },
    coinCandles(coinId, interval = 1200, limit = 96){
      // OHLC in base units per token from the coin's own life: curve_log (spot from reserve)
      // + pool_log (spot = gbx/tokens). interval in blocks (1200 blocks ~ 1h at 3s).
      if (!/^[0-9a-f]{64}$/.test(coinId)) return null;
      const pts=[];
      const V=3000000000000n, VT=1073000000n, KC=V*VT;
      try{
        for (const l of db.prepare('SELECT height, reserve, status FROM curve_log WHERE coin_id=? ORDER BY height').all(coinId)){
          if (l.status==='graduated'||l.status==='closed') continue;
          const R=BigInt(l.reserve); const cur=V+R;
          pts.push({h:l.height, p:Number(cur*cur)/Number(KC), s:'c'});
        }
      }catch(_e){}
      try{
        for (const l of db.prepare('SELECT height, gbx_sat, tokens FROM pool_log WHERE coin_id=? ORDER BY height').all(coinId)){
          if (BigInt(l.tokens)>0n) pts.push({h:l.height, p:Number(l.gbx_sat)/Number(l.tokens), s:'p'});
        }
      }catch(_e){}
      pts.sort((a,b)=>a.h-b.h);
      if (!pts.length) return { ok:true, candles: [] };
      const out=[]; let cur=null;
      for (const pt of pts){
        const bucket = Math.floor(pt.h/interval)*interval;
        if (!cur || cur.t!==bucket || cur.ph!==pt.s){
          if (cur) out.push(cur);
          const prev=(out.length&&out[out.length-1].ph===pt.s)?out[out.length-1].c:pt.p;
          cur={t:bucket, o:prev, h:pt.p, l:pt.p, c:pt.p, ph:pt.s};
        }
        cur.h=Math.max(cur.h,pt.p); cur.l=Math.min(cur.l,pt.p); cur.c=pt.p;
      }
      out.push(cur);
      return { ok:true, scanned: parseInt(q.meta.get('scanned')?.v ?? '0', 10), candles: out.slice(-limit) };
    },
    coinCandlesPro(coinId, tf = '1h', phaseOnly = null, limit = 200){
      // pro candles for the PriceChart component: {time(ms),open,high,low,close,volume_gbx}
      // time derived honestly from height (3s/block vs scanned tip); volume = abs reserve/pool deltas
      // within the bucket, phase transitions excluded. phaseOnly='p' -> pool-phase only (graduated view).
      if (!/^[0-9a-f]{64}$/.test(coinId)) return null;
      const TFB={'1m':20,'5m':100,'15m':300,'1h':1200,'4h':4800,'1d':28800};
      const ib=TFB[tf]||1200;
      const tip=parseInt(q.meta.get('scanned')?.v ?? '0', 10);
      const now=Date.now();
      const pts=[];
      const V=3000000000000n, VT=1073000000n, KC=V*VT;
      try{
        let prevR=null;
        for (const l of db.prepare('SELECT height, reserve, status FROM curve_log WHERE coin_id=? ORDER BY height').all(coinId)){
          if (l.status==='graduated'||l.status==='closed'){ prevR=null; continue; }
          const R=BigInt(l.reserve); const cur=V+R;
          const dv=prevR===null?0:Math.abs(Number(R-prevR));
          pts.push({h:l.height, p:Number(cur*cur)/Number(KC), v:dv, s:'c'});
          prevR=R;
        }
      }catch(_e){}
      try{
        let prevG=null;
        for (const l of db.prepare('SELECT height, gbx_sat, tokens FROM pool_log WHERE coin_id=? ORDER BY height').all(coinId)){
          if (BigInt(l.tokens)<=0n) continue;
          const G=BigInt(l.gbx_sat);
          const dv=prevG===null?0:Math.abs(Number(G-prevG));
          pts.push({h:l.height, p:Number(l.gbx_sat)/Number(l.tokens), v:dv, s:'p'});
          prevG=G;
        }
      }catch(_e){}
      let use=pts.sort((a,b)=>a.h-b.h);
      if (phaseOnly) use=use.filter(x=>x.s===phaseOnly);
      if (!use.length) return { ok:true, candles: [] };
      const out=[]; let cur=null;
      for (const pt of use){
        const bucket=Math.floor(pt.h/ib)*ib;
        if (!cur || cur.b!==bucket || cur.ph!==pt.s){
          if (cur) out.push(cur);
          const prev=(out.length&&out[out.length-1].ph===pt.s)?out[out.length-1].close:pt.p;
          cur={b:bucket, time:now-(tip-bucket)*3000, open:prev, high:pt.p, low:pt.p, close:pt.p, volume_gbx:0, ph:pt.s};
        }
        cur.high=Math.max(cur.high,pt.p); cur.low=Math.min(cur.low,pt.p); cur.close=pt.p;
        cur.volume_gbx+=pt.v/1e8;
      }
      out.push(cur);
      return { ok:true, scanned: tip, candles: out.slice(-limit).map(c=>({time:c.time,open:c.open,high:c.high,low:c.low,close:c.close,volume_gbx:c.volume_gbx,ph:c.ph})) };
    },
    leaderboard(kind, blocks = 28800){
      // federated leaderboard, straight from curve_ops (chain-derived, reorg-safe).
      const tip = parseInt(q.meta.get('scanned')?.v ?? '0', 10);
      const since = (blocks > 0) ? tip - blocks : -1;
      let ops = [];
      try{ ops = db.prepare('SELECT * FROM curve_ops WHERE height > ? AND op<>char(84) AND op<>char(85)').all(since); }catch(_e){ return { ok:true, scanned:tip, items:[] }; }
      if (kind === 'burners'){
        const by={};
        for (const o of ops){ const b=BigInt(o.burn_sat); if(b<=0n) continue;
          by[o.pk]=(by[o.pk]||0n)+b; }
        const items=Object.keys(by).map(pk=>({pk, burned_sat: by[pk].toString()}))
          .sort((a,b)=> (BigInt(b.burned_sat)>BigInt(a.burned_sat)?1:-1)).slice(0,50);
        return { ok:true, scanned:tip, items };
      }
      if (kind === 'traders'){
        const by={};
        for (const o of ops){
          if(!'BSPQ'.includes(o.op)) continue;
          const r=by[o.pk]||(by[o.pk]={pk:o.pk, trades:0, gbx_sat:0n});
          r.trades++;
          if (o.op==='B'||o.op==='P') r.gbx_sat+=BigInt(o.amount);
        }
        const items=Object.values(by).map(r=>({pk:r.pk, trades:r.trades, gbx_sat:r.gbx_sat.toString()}))
          .sort((a,b)=>b.trades-a.trades).slice(0,50);
        return { ok:true, scanned:tip, items };
      }
      return null;
    },
    stats24(blocks24 = 28800){
      // honest 24h dashboard numbers, straight from the index (chain-derived).
      // TVL = live curve reserves + AMM pool reserves. Volume = sum of absolute
      // reserve deltas over the last ~24h of blocks (3s blocks -> 28800).
      const tip = parseInt(q.meta.get('scanned')?.v ?? '0', 10);
      const since = tip - blocks24;
      const db2 = db;
      const liveTvl = db2.prepare("SELECT COALESCE(SUM(CAST(reserve AS INTEGER)),0) s, COUNT(*) n FROM curves WHERE status='live'").get();
      const gradN  = db2.prepare("SELECT COUNT(*) n FROM curves WHERE status='graduated'").get();
      let poolTvl = 0n, poolVol = 0n;
      if (pq){
        for (const p of pq.all.all()) poolTvl += BigInt(p.gbx_sat);
        try{
          const pl = db2.prepare('SELECT coin_id, height, gbx_sat FROM pool_log WHERE height > ? ORDER BY coin_id, height, rowid').all(since);
          const prevP = {};
          for (const r of pl){
            if (prevP[r.coin_id] !== undefined) { const d = BigInt(r.gbx_sat) - prevP[r.coin_id]; poolVol += d < 0n ? -d : d; }
            prevP[r.coin_id] = BigInt(r.gbx_sat);
          }
        }catch(_e){}
      }
      let curveVol = 0n;
      const cl = db2.prepare('SELECT coin_id, height, reserve, status FROM curve_log WHERE height > ? ORDER BY coin_id, height, rowid').all(since);
      const prevC = {};
      for (const r of cl){
        // graduation moves liquidity into the pool — a transfer, not trading volume
        const isTransfer = r.status === 'graduated' || r.status === 'closed';
        if (prevC[r.coin_id] !== undefined && !isTransfer){ const d = BigInt(r.reserve) - prevC[r.coin_id]; curveVol += d < 0n ? -d : d; }
        prevC[r.coin_id] = BigInt(r.reserve);
      }
      return { scanned: tip,
               tvl_sat: (BigInt(liveTvl.s||0) + poolTvl).toString(),
               vol24_sat: (curveVol + poolVol).toString(),
               live_coins: liveTvl.n, graduated_coins: gradN.n };
    },
    poolsAll(){
      const tip = parseInt(q.meta.get('scanned')?.v ?? '0', 10);
      if (!pq) return { scanned: tip, pools: [] };
      return { scanned: tip, pools: pq.all.all().map(poolView) };
    },
    poolDetail(coinId, logLimit = 2000){
      if (!pq || !/^[0-9a-f]{64}$/.test(coinId)) return null;
      const p = pq.one.get(coinId);
      if (!p) return null;
      const r = q.curveOne.get(coinId);
      const out = poolView({...p, ticker:r&&r.ticker, name:r&&r.name});
      out.scanned = parseInt(q.meta.get('scanned')?.v ?? '0', 10);
      out.log = pq.log.all(coinId, Math.min(logLimit, 5000))
        .map(l => ({height:l.height, txid:l.txid, vout:l.vout, gbx_sat:String(l.gbx_sat), tokens:String(l.tokens)}));
      return out;
    },
    activity(pkHex, limit = 200){
      // address profile: holdings (token_utxos) + full op history (curve_ops) for one pubkey.
      if (!/^[0-9a-f]{66}$/.test(pkHex)) return null;
      const tip = parseInt(q.meta.get('scanned')?.v ?? '0', 10);
      const held = q.heldBy.all(pkHex).map(r => ({
        coin_id:r.coin_id, ticker:r.ticker||null, name:r.name||null,
        amount:String(r.amount), utxos:r.utxos }));
      let ops=[];
      try{ ops = db.prepare(`SELECT o.height, o.txid, o.coin_id, o.op, o.amount, o.tokens_out, o.burn_sat, m.ticker
                             FROM curve_ops o LEFT JOIN coin_meta m ON m.coin_id=o.coin_id
                             WHERE o.pk=? ORDER BY o.height DESC, o.rowid DESC LIMIT ?`).all(pkHex, Math.min(limit,500))
                 .map(r=>({height:r.height, txid:r.txid, coin_id:r.coin_id, ticker:r.ticker||null, op:r.op,
                           amount:String(r.amount), tokens:String(r.tokens_out), burn_sat:String(r.burn_sat)})); }catch(_e){}
      return { scanned: tip, pk: pkHex, held, ops };
    },
    burnsAll(limit = 500){
      // every burn on the chain, oldest first: op, coin, exact sat, txid, height.
      const tip = parseInt(q.meta.get('scanned')?.v ?? '0', 10);
      let rows=[];
      try{ rows = db.prepare(`SELECT o.height,o.txid,o.coin_id,o.op,o.burn_sat,m.ticker
                              FROM curve_ops o LEFT JOIN coin_meta m ON m.coin_id=o.coin_id
                              WHERE CAST(o.burn_sat AS INTEGER)>0 ORDER BY o.height ASC, o.rowid ASC LIMIT ?`).all(Math.min(limit,2000))
              .map(r=>({height:r.height,txid:r.txid,coin_id:r.coin_id,op:r.op,ticker:r.ticker||null,burn_sat:String(r.burn_sat)})); }catch(_e){}
      let tot={n:0,s:'0'};
      try{ const x=db.prepare("SELECT COUNT(*) n, SUM(CAST(burn_sat AS INTEGER)) s FROM curve_ops WHERE CAST(burn_sat AS INTEGER)>0").get();
           tot={n:x.n, s:String(x.s||0)}; }catch(_e){}
      const chainTot = q.meta.get('burn_total_sat')?.v ?? null;
      const chainUtxos = q.meta.get('burn_utxos')?.v ?? null;
      // Direct chain burns: coins sent straight to the canonical burn address,
      // read from the UTXO index (newest first). Launchpad fees live in curve_ops;
      // everything else that reaches the burn address shows up here.
      let direct=[];
      try{
        const BURN_ADDR='bn1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3kc3g2';
        const gi=require('./gbx-index-read.js');
        if (gi.directBurns) direct = gi.directBurns(BURN_ADDR, 100);
      }catch(_e){}
      return { scanned:tip, chain_total_sat:chainTot, chain_burn_utxos:chainUtxos?parseInt(chainUtxos,10):null,
               launchpad_burn_sat:tot.s, launchpad_ops:tot.n, burns:rows, direct_burns:direct };
    },
    coinStats(coinId){
      // market stats band: price, window % change, liquidity, 24h volume/txns/traders — all on-chain.
      if (!/^[0-9a-f]{64}$/.test(coinId)) return null;
      const tip = parseInt(q.meta.get('scanned')?.v ?? '0', 10);
      const W = { m30:600, h1:1200, h4:4800, d1:28800 };
      const rows = db.prepare('SELECT height, gbx_sat, tokens FROM pool_log WHERE coin_id=? ORDER BY height ASC, rowid ASC').all(coinId);
      let price=null, liq=null, chg={m30:null,h1:null,h4:null,d1:null}, vol24=0n, phase='curve';
      // curve phase: spot price from the same virtual reserves the consensus uses
      try{
        const cr = db.prepare('SELECT reserve, status FROM curves WHERE coin_id=?').get(coinId);
        if (cr && cr.status !== 'graduated') {
          const R = BigInt(cr.reserve||0);
          const gbxRes = V_GBX + R, tokRes = KCURVE/(V_GBX+R);
          if (tokRes > 0n) price = Number(gbxRes)/Number(tokRes);
          liq = String(R);
        }
      }catch(_e){}
      if (rows.length){
        phase='pool';
        const last=rows[rows.length-1];
        price = Number(last.gbx_sat)/Number(last.tokens);
        liq = String(last.gbx_sat);
        const priceAt=(h,maxAge)=>{ let r=null; for(const x of rows){ if(x.height<=h) r=x; else break; } if(!r) return null; if(maxAge && (h-r.height)>maxAge) return null; return Number(r.gbx_sat)/Number(r.tokens); };
        for (const k of Object.keys(W)){ const p0=priceAt(tip-W[k], W[k]); if(p0!==null&&p0>0) chg[k]=(price/p0-1)*100; }
        for (let i=1;i<rows.length;i++){ if(rows[i].height>tip-W.d1){ const d=BigInt(rows[i].gbx_sat)-BigInt(rows[i-1].gbx_sat); vol24 += d<0n?-d:d; } }
      }
      let t24={n:0,t:0};
      try{ t24 = db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT pk) t FROM curve_ops WHERE coin_id=? AND height>=? AND op<>char(84) AND op<>char(85)').get(coinId, tip-W.d1); }catch(_e){}
      return { scanned:tip, coin_id:coinId, phase, price_sat:price, liquidity_sat:liq, chg, vol24_sat:String(vol24), txns24:t24.n, traders24:t24.t };
    },
    myCoins(pkHex){
      if (!/^[0-9a-f]{66}$/.test(pkHex)) return null;
      const tip = parseInt(q.meta.get('scanned')?.v ?? '0', 10);
      const held = q.heldBy.all(pkHex).map(r => ({
        coin_id:r.coin_id, ticker:r.ticker||null, name:r.name||null,
        amount:String(r.amount), utxos:r.utxos }));
      const created = q.createdBy.all(pkHex).map(r => curveView({...r, txid:null, vout:null, holders:undefined}, tip));
      let ops=[];
      try{ ops = db.prepare(`SELECT o.height, o.txid, o.coin_id, o.op, o.amount, o.tokens_out, o.burn_sat, m.ticker
                             FROM curve_ops o LEFT JOIN coin_meta m ON m.coin_id=o.coin_id
                             WHERE o.pk=? ORDER BY o.height DESC, o.rowid DESC LIMIT 200`).all(pkHex)
                 .map(r=>({height:r.height, txid:r.txid, coin_id:r.coin_id, ticker:r.ticker||null, op:r.op,
                           amount:String(r.amount), tokens:String(r.tokens_out), burn_sat:String(r.burn_sat)})); }catch(_e){}
      return { scanned: tip, pk: pkHex, held, created, ops };
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

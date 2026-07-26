/* GBX LP LAYER — federated liquidity-provider routing for the client.
   One implementation shared by every page: discovery, health, quotes.
   No fixed provider: the list is built from the registry announced on chain
   (read through the node router, which has its own failover) plus the
   bootstrap file shipped with the client. Providers that answered are
   remembered on this device; one that fails is skipped immediately.
   API: window.GBXLp.list() .fetch(path,opts) .quoteAll(path) .priceUsd() */
(function(){
  'use strict';
  if (window.GBXLp) return;

  var LS_KEY = 'gbx_lps_v1';
  var TIMEOUT_MS = 6000;
  var CACHE_MS = 60000;
  var MAX_LPS = 12;

  var SCORE = {}, LPS = [], cachedAt = 0, inflight = null;

  function trim(u){ return String(u||'').replace(/\/+$/,''); }
  function isUrl(u){ return typeof u === 'string' && u.indexOf('https://') === 0; }

  try {
    var raw = localStorage.getItem(LS_KEY);
    if (raw) {
      var p = JSON.parse(raw);
      if (p && Array.isArray(p.lps)) LPS = p.lps.filter(function(x){ return x && isUrl(x.base_url); });
      if (p && p.score) SCORE = p.score;
    }
  } catch(e){}

  function save(){
    try { localStorage.setItem(LS_KEY, JSON.stringify({lps:LPS, score:SCORE, ts:Date.now()})); } catch(e){}
  }
  function add(e){
    if (!e || !isUrl(e.base_url)) return;
    e.base_url = trim(e.base_url);
    for (var i=0;i<LPS.length;i++) if (LPS[i].base_url === e.base_url) return;
    if (LPS.length >= MAX_LPS) return;
    LPS.push(e);
  }
  function _fail(b){ SCORE[b] = (SCORE[b]||0) + 1; save(); }
  function _ok(b){ SCORE[b] = Math.max(0,(SCORE[b]||0) - 1); save(); }
  function ordered(){
    return LPS.map(function(x,i){ return {x:x, s:(SCORE[x.base_url]||0), i:i}; })
      .sort(function(a,b){ return (a.s-b.s)||(a.i-b.i); })
      .map(function(o){ return o.x; });
  }

  function req(url, ms){
    return new Promise(function(resolve, reject){
      var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var to = setTimeout(function(){ if(ctl) ctl.abort(); reject(new Error('timeout')); }, ms||TIMEOUT_MS);
      fetch(url, ctl ? {signal:ctl.signal, cache:'no-store'} : {cache:'no-store'})
        .then(function(r){ clearTimeout(to); if(!r.ok){ reject(new Error('http '+r.status)); return; } resolve(r); })
        .catch(function(e){ clearTimeout(to); reject(e); });
    });
  }

  // Bootstrap list shipped with the client; an installed app resolves it locally.
  function fromFile(){
    return req('/lps.json', 3000).then(function(r){ return r.json(); }).then(function(j){
      (j.lps||[]).forEach(function(l){
        add({ name:l.name||'lp', base_url:l.base_url, chains:l.chains||null,
              fee_bps:(l.fee_bps==null?null:l.fee_bps), onchain:false });
      });
    }).catch(function(){});
  }

  // Authoritative source: announced on chain, reached through the node router.
  function fromChain(){
    if (!window.GBXRead) return Promise.resolve();
    return window.GBXRead.json('/api/lp-registry').then(function(j){
      Object.keys((j && j.lps) || {}).forEach(function(u){
        add({ name:'onchain-lp', base_url:u, chains:null, fee_bps:null, onchain:true });
      });
    }).catch(function(){});
  }

  function list(){
    if (LPS.length && (Date.now()-cachedAt) < CACHE_MS) return Promise.resolve(ordered());
    if (inflight) return inflight;
    inflight = Promise.all([fromFile(), fromChain()]).then(function(){
      cachedAt = Date.now(); inflight = null; save(); return ordered();
    }).catch(function(){ inflight = null; return ordered(); });
    return inflight;
  }

  // Per-request failover: the first provider that answers wins.
  async function lpFetch(pathq, opts){
    opts = opts || {};
    var lps = await list();
    if (opts.chain) lps = lps.filter(function(l){ return !l.chains || l.chains.indexOf(opts.chain) >= 0; });
    var lastErr = null;
    for (var i=0;i<lps.length;i++){
      var b = lps[i].base_url;
      try { var r = await req(b + pathq, opts.timeout); _ok(b); window.GBX_LP_LAST = b; return r; }
      catch(e){ _fail(b); lastErr = e; }
    }
    throw (lastErr || new Error('no liquidity provider reachable'));
  }

  // Every provider is asked in parallel; one outlier cannot move the result.
  async function quoteAll(pathq){
    var lps = await list(), out = [];
    await Promise.all(lps.map(function(l){
      return req(l.base_url + pathq).then(function(r){ return r.json(); })
        .then(function(j){ _ok(l.base_url); out.push({ lp:l.base_url, q:j }); })
        .catch(function(){ _fail(l.base_url); });
    }));
    return out;
  }

  function median(a){
    if (!a.length) return 0;
    var s = a.slice().sort(function(x,y){ return x-y; }), m = s.length >> 1;
    return (s.length % 2) ? s[m] : (s[m-1] + s[m]) / 2;
  }

  // A USD figure is produced only when live providers give one; the caller
  // shows nothing rather than an invented number.
  async function priceUsd(){
    try {
      var qs = await quoteAll('/quote?usd=1');
      var px = qs.map(function(o){ return Number((o.q && (o.q.price_usd || o.q.gbx_price_usd)) || 0); })
                 .filter(function(v){ return v > 0; });
      return median(px);
    } catch(e){ return 0; }
  }

  window.GBXLp = { list:list, fetch:lpFetch, quoteAll:quoteAll, priceUsd:priceUsd,
                   median:median, score:function(){ return SCORE; } };
})();

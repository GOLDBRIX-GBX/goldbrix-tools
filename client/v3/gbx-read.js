/* GBX READ-ROUTER v2 — federated multi-node read with persistent failover.
   Keyless by construction. Works with OR without any specific server.
   Discovery: the nodes.json shipped with this client + the on-chain node registry.
   Nodes that answered are remembered on the device; dead nodes are demoted.
   API unchanged: window.gbxRead(path,{quorum,field}) · window.GBXRead.json(path)
   Added: window.GBXReady (promise) · window.GBX_LAST_NODE */
(function(){
  'use strict';
  if (window.gbxRead) return; // one-shot

  var LS_KEY       = 'gbx_nodes_v1';
  var MAX_NODES    = 12;
  var TIMEOUT_MS   = 4500;
  var READY_CAP_MS = 2500;
  var REFRESH_MS   = 300000;

  // Last-resort bootstrap only, and no entry here is privileged: one reachable
  // node is enough, the list then grows from the chain itself and is remembered
  // on this device. Independent operators first, so that losing any single host
  // - including the one the project started on - changes nothing.
  var SEED = [
    'https://155-117-232-248.sslip.io/api',
    'https://node1.noderuner.com/api',
    'https://169-58-61-71.sslip.io/api',
    'https://goldbrix.app/api'
  ];

  var SCORE = {};

  function isUrl(n){ return typeof n === 'string' && n.indexOf('https://') === 0; }
  function trim(n){ return n.replace(/\/+$/,''); }

  window.GBX_NODES = window.GBX_NODES || [];

  /* The node that served this very page is proven alive: it is always a
     candidate, and first in line (index 0). In the installed app the origin
     is not https:// and is skipped. */
  function _isLocal(n){ return /^https?:\/\/(localhost|127\.|10\.0\.2\.2)/.test(n); }
  try { if (location && location.protocol === 'https:' && !_isLocal(location.origin)) {
    var _o = trim(location.origin) + '/api';
    if (window.GBX_NODES.indexOf(_o) === -1) window.GBX_NODES.unshift(_o);
  } } catch(e){}

  function add(n){
    if (!isUrl(n) || _isLocal(n)) return false;
    n = trim(n);
    if (window.GBX_NODES.indexOf(n) !== -1) return false;
    if (window.GBX_NODES.length >= MAX_NODES) return false;
    window.GBX_NODES.push(n);
    return true;
  }

  // Device memory first (proven nodes), bootstrap seed after.
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (raw) {
      var p = JSON.parse(raw);
      if (p && Array.isArray(p.nodes)) p.nodes.forEach(add);
      if (p && p.score) SCORE = p.score;
    }
  } catch(e){}
  SEED.forEach(add);

  function save(){
    try {
      var keep = window.GBX_NODES.filter(function(n){ return (SCORE[n]||0) < 3; });
      localStorage.setItem(LS_KEY, JSON.stringify({ nodes: keep, score: SCORE, ts: Date.now() }));
    } catch(e){}
  }

  function _fail(n){ SCORE[n] = (SCORE[n]||0) + 1; save(); }
  function _ok(n){ SCORE[n] = Math.max(0,(SCORE[n]||0) - 1); window.GBX_LAST_NODE = n; save(); }

  // Proven nodes first. A node that just failed drops behind the healthy ones
  // immediately (no fixed threshold), but is never dropped from the list.
  function _ordered(){
    var out = window.GBX_NODES.map(function(n,i){ return {n:n, s:(SCORE[n]||0), i:i}; })
      .sort(function(a,b){ return (a.s - b.s) || (a.i - b.i); })
      .map(function(x){ return x.n; });
    return out.length ? out : SEED.slice();
  }

  function _fetch(url, ms, opts){
    return new Promise(function(resolve, reject){
      var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var to = setTimeout(function(){ if (ctl) ctl.abort(); reject(new Error('timeout')); }, ms || TIMEOUT_MS);
      /* a caller may need to write as well as read (publishing a signed
         transaction), so its own options are carried through */
      var init = {cache:'no-store'};
      if (opts) for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts,k)) init[k]=opts[k];
      if (ctl) init.signal = ctl.signal;
      fetch(url, init)
        .then(function(r){ clearTimeout(to); if(!r.ok){ reject(new Error('http '+r.status)); return; } resolve(r); })
        .catch(function(e){ clearTimeout(to); reject(e); });
    });
  }
  function _fetchNode(base, path, ms, opts){ return _fetch(trim(base)+path, ms, opts); }

  // '/nodes.json' is the copy shipped with the client (installed app or any
  // mirror): resolvable without depending on a remote host. Failure = silent.
  window.GBX_NODES_URLS = window.GBX_NODES_URLS || [
    '/nodes.json'
  ];

  function discoverFiles(){
    return Promise.all(window.GBX_NODES_URLS.map(function(u){
      return _fetch(u, 3000).then(function(r){ return r.json(); }).then(function(j){
        if (j && Array.isArray(j.nodes)) j.nodes.forEach(add);
      }).catch(function(){});
    }));
  }

  // On-chain discovery through whichever node answers (no fixed host).
  function discoverChain(){
    return _rotateRaw('/node-registry').then(function(r){ return r.json(); }).then(function(j){
      if (j && j.nodes) Object.keys(j.nodes).forEach(add);
      save();
    }).catch(function(){});
  }

  var READY = Promise.race([
    discoverFiles(),
    new Promise(function(r){ setTimeout(r, READY_CAP_MS); })
  ]);
  window.GBXReady = READY;

  var _bootP = null;
  function ensure(){
    if (!_bootP) _bootP = READY.then(function(){
      discoverChain();
      setInterval(discoverChain, REFRESH_MS);
    }).catch(function(){});
    return _bootP;
  }

  async function _rotateRaw(path, opts, ms){
    var nodes = _ordered(), errs = [];
    for (var i=0; i<nodes.length; i++){
      try {
        var r = await _fetchNode(nodes[i], path, ms, opts);
        var ct = (r.headers.get('content-type')||'');
        if (ct.indexOf('text/html') !== -1) throw new Error('html response (not an API)');
        _ok(nodes[i]); return r;
      }
      catch(e){ _fail(nodes[i]); errs.push(nodes[i]+' -> '+(e && e.message ? e.message : e)); }
    }
    throw new Error('all nodes failed for '+path+': '+errs.join(' | '));
  }

  async function _rotate(path, opts, ms){
    await ensure();
    return await _rotateRaw(path, opts, ms);
  }

  async function _quorum(path, field, strict){
    await ensure();
    function _refuse(reason){
      window.GBX_QUORUM_DEGRADED = true;
      if (strict){ var e=new Error('QUORUM_UNAVAILABLE'); e.code='QUORUM_UNAVAILABLE'; e.reason=reason; throw e; }
      console.warn('[gbxRead] quorum degraded ('+reason+') on', field);
    }
    var nodes = _ordered();
    if (nodes.length < 2){
      _refuse('single node');
      return await _rotateRaw(path);
    }
    var results = [];
    var want = Math.min(3, nodes.length);
    /* The first `want` nodes are asked in PARALLEL: one slow node no longer
       delays the answer. Failures are refilled sequentially from the rest. */
    async function _one(n){
      var r = await _fetchNode(n, path);
      var j = await r.clone().json();
      return {r:r, j:j, n:n};
    }
    var settled = await Promise.allSettled(nodes.slice(0, want).map(_one));
    for (var si=0; si<settled.length; si++){
      if (settled[si].status === 'fulfilled'){ _ok(settled[si].value.n); results.push(settled[si].value); }
      else _fail(nodes[si]);
    }
    for (var i=want; i<nodes.length && results.length<want; i++){
      try {
        var r = await _fetchNode(nodes[i], path);
        var j = await r.clone().json();
        _ok(nodes[i]); results.push({r:r, j:j});
      } catch(e){ _fail(nodes[i]); }
    }
    if (results.length === 0) throw new Error('all nodes down');
    if (results.length === 1){
      _refuse('one answer');
      return results[0].r;
    }
    /* Majority among the answers we have: 2-of-2 or 2-of-3. */
    var tally = {};
    for (var t=0; t<results.length; t++){
      var v = String(results[t].j[field]);
      tally[v] = (tally[v]||0) + 1;
      if (tally[v] >= 2){ window.GBX_QUORUM_DEGRADED = false; return results[t].r; }
    }
    /* No two answers agree at 3s blocks: retry once, then either refuse
       (strict) or degrade to the first answer like a single-node client. */
    await new Promise(function(r){ setTimeout(r, 1200); });
    try {
      var r2 = await _fetchNode(nodes[0], path); var j2 = await r2.clone().json();
      var r3 = await _fetchNode(nodes[1], path); var j3 = await r3.clone().json();
      if (String(j2[field]) === String(j3[field])) { window.GBX_QUORUM_DEGRADED = false; return r2; }
    } catch(e){}
    _refuse('persistent mismatch');
    return results[0].r;
  }

  window.gbxRead = function(path, opts){
    opts = opts || {};
    if (opts.quorum && opts.field) return _quorum(path, opts.field, opts.strict === true);
    /* routing options stay here; everything else belongs to the request itself */
    var req = null, ms = null;
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts,k)){
      if (k === 'quorum' || k === 'field' || k === 'strict') continue;
      /* a few reads are genuinely slow on a busy address and deserve their
         own patience rather than the default one */
      if (k === 'timeout'){ ms = opts[k]; continue; }
      (req = req || {})[k] = opts[k];
    }
    return _rotate(path, req, ms);
  };
})();

/* GBXRead alias for consumers using absolute paths ('/api/...').
   Nodes in GBX_NODES already end in /api -> strip the duplicate prefix. */
(function(){
  'use strict';
  if (window.GBXRead) return;
  function norm(p){ return (p.indexOf('/api/')===0) ? p.slice(4) : p; }
  window.GBXRead = {
    fetch: function(p,o){ return window.gbxRead(norm(p), o); },
    json:  function(p,o){ return window.gbxRead(norm(p), o).then(function(r){ return r.json(); }); },
    /* Ask every live node in parallel and keep the answer scoreFn ranks
       highest. For market data the node with the deepest trade history wins:
       an endogenous criterion, no privileged host. Nodes that fail or score
       null are ignored; no node answering resolves to null. */
    best: function(p, scoreFn, ms){
      var path = norm(p);
      var nodes = (window.GBX_NODES||[]).slice();
      if (!nodes.length) return window.GBXRead.json(p);
      var t = ms || 6000;
      return Promise.all(nodes.map(function(n){
        var c = (typeof AbortController!=='undefined') ? new AbortController() : null;
        var to = c ? setTimeout(function(){ c.abort(); }, t) : null;
        return fetch(String(n).replace(/\/+$/,'')+path, {cache:'no-store', signal:(c&&c.signal)||undefined})
          .then(function(r){ return r.json(); })
          .then(function(j){ var sc = scoreFn(j); return (sc==null||isNaN(sc)) ? null : {j:j, sc:sc, n:n}; })
          .catch(function(){ return null; })
          .finally(function(){ if(to) clearTimeout(to); });
      })).then(function(rs){
        var b = null;
        for (var i=0;i<rs.length;i++) if (rs[i] && (!b || rs[i].sc > b.sc)) b = rs[i];
        return b;
      });
    },
    /* Same race, but the caller wants the winning node base (for widgets
       that build their own URLs, like the chart), not the payload. */
    bestNode: function(p, scoreFn, ms){
      return this._bestRaw(p, scoreFn, ms).then(function(b){ return b ? b.n : null; });
    }
  };
  /* best() keeps returning the payload; both share one implementation. */
  window.GBXRead._bestRaw = window.GBXRead.best;
  window.GBXRead.best = function(p, scoreFn, ms){
    return this._bestRaw(p, scoreFn, ms).then(function(b){ return b ? b.j : null; });
  };
})();

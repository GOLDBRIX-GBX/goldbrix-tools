/* GBX READ-ROUTER v2 — federated multi-node read with persistent failover.
   Keyless by construction. Works with OR without any specific server.
   Discovery: locally shipped nodes.json + peer nodes.json + on-chain node registry.
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

  // Last-resort bootstrap only. One reachable entry is enough: the list then
  // grows from the chain itself and is remembered on this device.
  var SEED = ['https://goldbrix.app/api'];

  var SCORE = {};

  function isUrl(n){ return typeof n === 'string' && n.indexOf('https://') === 0; }
  function trim(n){ return n.replace(/\/+$/,''); }

  window.GBX_NODES = window.GBX_NODES || [];

  function add(n){
    if (!isUrl(n)) return false;
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

  function _fetch(url, ms){
    return new Promise(function(resolve, reject){
      var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var to = setTimeout(function(){ if (ctl) ctl.abort(); reject(new Error('timeout')); }, ms || TIMEOUT_MS);
      fetch(url, ctl ? {signal:ctl.signal, cache:'no-store'} : {cache:'no-store'})
        .then(function(r){ clearTimeout(to); if(!r.ok){ reject(new Error('http '+r.status)); return; } resolve(r); })
        .catch(function(e){ clearTimeout(to); reject(e); });
    });
  }
  function _fetchNode(base, path, ms){ return _fetch(trim(base)+path, ms); }

  // '/nodes.json' is the copy shipped with the client (installed app or any
  // mirror): resolvable without depending on a remote host. Failure = silent.
  window.GBX_NODES_URLS = window.GBX_NODES_URLS || [
    '/nodes.json',
    'https://goldbrix.app/nodes.json',
    'https://raw.githubusercontent.com/GOLDBRIX-GBX/goldbrix-tools/main/nodes.json'
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

  async function _rotateRaw(path){
    var nodes = _ordered(), lastErr = null;
    for (var i=0; i<nodes.length; i++){
      try { var r = await _fetchNode(nodes[i], path); _ok(nodes[i]); return r; }
      catch(e){ _fail(nodes[i]); lastErr = e; }
    }
    throw (lastErr || new Error('all nodes down'));
  }

  async function _rotate(path){
    await ensure();
    return await _rotateRaw(path);
  }

  async function _quorum(path, field){
    await ensure();
    var nodes = _ordered();
    if (nodes.length < 2) return await _rotateRaw(path);
    var results = [];
    for (var i=0; i<nodes.length && results.length<2; i++){
      try {
        var r = await _fetchNode(nodes[i], path);
        var j = await r.clone().json();
        _ok(nodes[i]); results.push({r:r, j:j});
      } catch(e){ _fail(nodes[i]); }
    }
    if (results.length === 0) throw new Error('all nodes down');
    if (results.length === 1) return results[0].r;
    var a = String(results[0].j[field]), b = String(results[1].j[field]);
    if (a !== b) {
      // Transient divergence at 3s blocks: retry once, then degrade to the
      // first answer (same behaviour as a single-node client).
      await new Promise(function(r){ setTimeout(r, 1200); });
      try {
        var r2 = await _fetchNode(nodes[0], path); var j2 = await r2.clone().json();
        var r3 = await _fetchNode(nodes[1], path); var j3 = await r3.clone().json();
        if (String(j2[field]) === String(j3[field])) return r2;
      } catch(e){}
      console.warn('[gbxRead] persistent quorum mismatch on', field, '- using first node');
      return results[0].r;
    }
    return results[0].r;
  }

  window.gbxRead = function(path, opts){
    opts = opts || {};
    if (opts.quorum && opts.field) return _quorum(path, opts.field);
    return _rotate(path);
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
    json:  function(p,o){ return window.gbxRead(norm(p), o).then(function(r){ return r.json(); }); }
  };
})();

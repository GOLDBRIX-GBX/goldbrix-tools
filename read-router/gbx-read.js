/* GBX READ-ROUTER — multi-node read with failover + quorum on critical fields.
   Keyless by construction. Works with OR without founder servers.
   s26: multi-source discovery (site + GitHub raw; Arweave slot ready) +
   client-side node scoring (dead nodes demoted at the edge — no server watchdog).
   API unchanged: window.gbxRead(path, {quorum, field}) */
(function(){
  'use strict';
  if (window.gbxRead) return; // one-shot

  window.GBX_NODES = window.GBX_NODES || ['https://goldbrix.app/api'];
  var TIMEOUT_MS = 4500;

  // Multi-source discovery: any ONE source alive is enough. Failure = silent.
  window.GBX_NODES_URLS = window.GBX_NODES_URLS || [
    'https://goldbrix.app/nodes.json',
    'https://raw.githubusercontent.com/GOLDBRIX-GBX/goldbrix-tools/main/nodes.json'
    // FAZA 8: + Arweave permanent URL
  ];
  window.GBX_NODES_URLS.forEach(function(u){
    fetch(u, {cache:'no-store'}).then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){
        if(!j || !Array.isArray(j.nodes)) return;
        j.nodes.forEach(function(n){
          if(typeof n==='string' && n.indexOf('https://')===0 && window.GBX_NODES.indexOf(n)===-1)
            window.GBX_NODES.push(n);
        });
      }).catch(function(){});
  });

  // Node scoring: self-healing at the edge. fails-successes; >=3 -> demote to tail.
  var SCORE = {};
  function _fail(n){ SCORE[n]=(SCORE[n]||0)+1; }
  function _ok(n){ SCORE[n]=Math.max(0,(SCORE[n]||0)-1); }
  function _ordered(){
    var ns = window.GBX_NODES.slice();
    return ns.filter(function(n){return (SCORE[n]||0)<3;})
      .concat(ns.filter(function(n){return (SCORE[n]||0)>=3;}));
  }

  function _fetchNode(base, path){
    return new Promise(function(resolve, reject){
      var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var to = setTimeout(function(){ if(ctl) ctl.abort(); reject(new Error('timeout')); }, TIMEOUT_MS);
      var url = base.replace(/\/+$/,'') + path;
      fetch(url, ctl ? {signal:ctl.signal, cache:'no-store'} : {cache:'no-store'})
        .then(function(r){ clearTimeout(to); if(!r.ok){ reject(new Error('http '+r.status)); return; } resolve(r); })
        .catch(function(e){ clearTimeout(to); reject(e); });
    });
  }

  async function _rotate(path){
    var nodes = _ordered(), lastErr = null;
    for (var i=0; i<nodes.length; i++){
      try { var r = await _fetchNode(nodes[i], path); _ok(nodes[i]); return r; }
      catch(e){ _fail(nodes[i]); lastErr = e; }
    }
    throw (lastErr || new Error('all nodes down'));
  }

  async function _quorum(path, field){
    var nodes = _ordered();
    if (nodes.length < 2) return await _rotate(path);
    var results = [];
    for (var i=0; i<nodes.length && results.length<2; i++){
      try { var r = await _fetchNode(nodes[i], path); var j = await r.clone().json();
            _ok(nodes[i]); results.push({r:r, j:j}); }
      catch(e){ _fail(nodes[i]); }
    }
    if (results.length === 0) throw new Error('all nodes down');
    if (results.length === 1) return results[0].r;
    var a = String(results[0].j[field]), b = String(results[1].j[field]);
    if (a !== b) throw new Error('QUORUM_MISMATCH');
    return results[0].r;
  }

  window.gbxRead = function(path, opts){
    opts = opts || {};
    if (opts.quorum && opts.field) return _quorum(path, opts.field);
    return _rotate(path);
  };
})();

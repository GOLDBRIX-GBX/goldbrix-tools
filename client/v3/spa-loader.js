/* GBX SPA loader v2 — cache de view-uri. Fiecare view trait intr-un container
   propriu; navigare = ascunde/arata (display), NU distruge. Revenire instant.
   Old pages stay alive (direct /v3/X.html access still works). */
(function(){
  'use strict';
  // ── Navigation SHIM: location.href=/replace/assign toward SPA routes -> hash (no reload) ──
  (function installNavShim(){
    function toRoute(url){
      if(!url) return null;
      var u=String(url);
      if(u.charAt(0)==='#') return null;          // deja hash
      if(/^https?:\/\//i.test(u) && u.indexOf(location.host)<0) return null; // extern
      var path=u.replace(/^https?:\/\/[^/]+/i,''); // strip the origin
      var q=''; var qi=path.indexOf('?'); if(qi>=0){ q=path.slice(qi+1); path=path.slice(0,qi); }
      var r=window.__SPA_PATH2ROUTE&&window.__SPA_PATH2ROUTE[path];
      if(!r) return null;
      return '#'+r+(q?('?'+q):'');
    }
    var orig={ assign:location.assign.bind(location), replace:location.replace.bind(location) };
    try{
      location.assign=function(u){ var h=toRoute(u); if(h){ location.hash=h; } else { orig.assign(u); } };
      location.replace=function(u){ var h=toRoute(u); if(h){ location.hash=h; } else { orig.replace(u); } };
    }catch(e){}
    // href= setter: via defineProperty on a wrapper (best-effort, falls back to the original if it fails)
    window.__spaNavTo=function(u){ var h=toRoute(u); if(h){ location.hash=h; return true; } return false; };
  })();
  var SHELL = document.getElementById('spa-view');
  var views = {};           // route -> {el, built, cssNodes}
  var loadedModules = {};   // module ES o singura data
  var curRoute = null;

  var MAP = {
    home:'/home.html', wallet:'/v3/wallet.html', explorer:'/v3/explorer.html',
    trade:'/v3/coins-x.html', launch:'/v3/launch-x.html', /* consensus launchpad X pages; on-page guard until height 2720000 */ burns:'/v3/burns.html',
    settings:'/v3/settings.html', gbx:'/v3/gbx.html',
    receive:'/v3/receive-usdc.html', favorites:'/v3/favorites.html',
    leaderboard:'/v3/leaderboard.html',
    'my-coins':'/v3/my-coins.html', chat:'/v3/chat.html', 'wallet-view':'/v3/wallet-view.html',
    transparency:'/v3/transparency.html', whitepaper:'/v3/whitepaper.html',
    unlock:'/v3/unlock.html', welcome:'/v3/welcome.html', disclaimer:'/v3/disclaimer.html',
    'create-wallet':'/v3/create-wallet.html', 'import-wallet':'/v3/import-wallet.html', swap:'/v3/swap.html', 'buy-gbx':'/v3/buy-gbx.html', 'sell-gbx':'/v3/swap.html', 'run-node':'/v3/run-node.html', join:'/v3/join.html', protocol:'/v3/protocol.html', send:'/v3/send.html', 'wallet-detail':'/v3/wallet-detail.html'
  };
  var PATH2ROUTE = {};
  Object.keys(MAP).forEach(function(k){ PATH2ROUTE[MAP[k]]=k; });
  PATH2ROUTE['/']='home';
  PATH2ROUTE['/index.html']='home';
  window.__SPA_PATH2ROUTE=PATH2ROUTE;

  function parseHash(){
    var raw=(location.hash||'').replace(/^#\/?/,'')||'home';
    var q=''; var qi=raw.indexOf('?'); if(qi>=0){ q=raw.slice(qi+1); raw=raw.slice(0,qi); }
    return { route:raw, query:q, path:MAP[raw]||('/v3/'+raw+'.html') };
  }

  function runScript(old, target){
    return new Promise(function(resolve){
      var s=document.createElement('script');
      for(var i=0;i<old.attributes.length;i++){ var a=old.attributes[i];
        if(a.name==='defer'||a.name==='async') continue;  // FIX — la injectare dinamica strica ordinea; vrem onload sincronizat
        s.setAttribute(a.name,a.value); }
      if(old.src){
        // ES modules have their own scope (no top-level globals) -> safe to re-inject on every visit.
        // Doar scripturile CLASICE externe (i18n.js: const I18N global) raman one-shot.
        var isModule=(old.type==='module');
        var srcKey=old.src.split('?')[0];
        if(!isModule && loadedModules[srcKey]){ resolve(); return; }
        if(!isModule){ loadedModules[srcKey]=1; }
        s.onload=function(){resolve();}; s.onerror=function(){resolve();};
        document.body.appendChild(s);
      } else {
        // FIX — top-level const/let (column 0) -> var, so a re-visit does not crash with 'already declared'
        var code=old.textContent;
        // FIX — top-level 'const/let/var NUME =' -> 'window.NUME =' (asignare, nu declarare; zero conflict cu i18n.js global)
        if(old.type!=='module'){ /* modulele ES au scope propriu — rescrierea le-ar sparge in strict mode */
        code=code.replace(/^(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/gm, 'window.$1 =');
        }
        // FIX — location.href='/v3/X' (setter, neinterceptat de shim) -> navigare SPA daca ruta mapata
        // window.__spaNavTo returns true if it navigated inside the SPA; otherwise a real href (fallback)
        code=code.replace(/(?:window\.)?location\.href\s*=\s*(['"])([^'"]+)\1/g,
          function(m,q,url){ return '(window.__spaNavTo&&window.__spaNavTo('+q+url+q+'))||(location.href='+q+url+q+')'; });
        s.textContent=code;
        window.__SPA_BOX=target||document.body;
        (target||document.body).appendChild(s);
        resolve();
      }
    });
  }

  async function buildView(info){
    var box=document.createElement('div');
    box.className='spa-viewbox'; box.setAttribute('data-route',info.route);
    box.innerHTML='<div style="padding:40px;text-align:center;color:#9a8c6f;font-family:monospace;">…</div>';
    SHELL.appendChild(box);
    var rec={ el:box, built:false, cssNodes:[] };
    views[info.route]=rec;
    try{
      var resp=await fetch(info.path+(info.query?('?'+info.query):''), {cache:'no-cache'});
      var html=await resp.text();
      var doc=new DOMParser().parseFromString(html,'text/html');
      var body=doc.querySelector('body');
      if(!body){ box.innerHTML='<div style="padding:40px;color:#f66;">view error</div>'; return rec; }

      // CSS din head -> injectat global, dar inregistrat pe view (curatat la nevoie)
      var head=doc.querySelector('head');
      if(head){
        head.querySelectorAll('style').forEach(function(st){
          var c=document.createElement('style'); c.textContent=st.textContent;
          c.setAttribute('data-view-css',info.route); document.head.appendChild(c); rec.cssNodes.push(c);
        });
        head.querySelectorAll('link[rel="stylesheet"]').forEach(function(lk){
          var href=lk.getAttribute('href'); if(!href||href.indexOf('style.css')>=0) return;
          if(document.querySelector('link[href="'+href+'"]')) return;
          var c=document.createElement('link'); c.rel='stylesheet'; c.href=href;
          c.setAttribute('data-view-css',info.route); document.head.appendChild(c); rec.cssNodes.push(c);
        });
      }

      // FIX — scripturile din <head> (ex D3) trebuie injectate INAINTE de body scripts
      var headScripts=[];
      if(head){ headScripts=Array.prototype.slice.call(head.querySelectorAll('script')); }
      var scripts=headScripts.concat(Array.prototype.slice.call(body.querySelectorAll('script')));
      scripts.forEach(function(s){ s.parentNode.removeChild(s); });
      // remove ALL of the page's own navs (multiple selector variants)
      var navSel='.bnav, .v3-final-nav, nav.bnav, nav[class*="nav"], .bottom-nav';
      // HIDE the view's nav (do not remove it from the DOM) — scripts look for navHome etc.; if it is missing, applyLang crashes
      body.querySelectorAll(navSel).forEach(function(n){ n.style.display='none'; n.setAttribute('data-spa-hidden','1'); });
      // fallback: any fixed bottom element (an inline-styled nav bar)
      body.querySelectorAll('[style*="bottom:0"],[style*="bottom: 0"]').forEach(function(n){
        var st=(n.getAttribute('style')||''); 
        if(/position:\s*fixed/.test(st) && (/<a /i.test(n.innerHTML)) && n.querySelectorAll('a').length>=3){
          n.style.display='none'; n.setAttribute('data-spa-hidden','1');
        }
      });

      // FIX — onclick="...location.href='/v3/X'..." din HTML (butoane HOME etc.) -> navigare SPA
      var _bhtml=body.innerHTML;
      _bhtml=_bhtml.replace(/(?:window\.)?location\.href\s*=\s*(&#39;|'|\\?")(\/[^'"&]+?)\1/g,
        function(m,q,url){ return "(window.__spaNavTo&&window.__spaNavTo('"+url+"'))||(location.href='"+url+"')"; });
      box.innerHTML=_bhtml;
      window.__spaBuildingEl = box;
      try{
        for(var i=0;i<scripts.length;i++){ await runScript(scripts[i], box); }
      } finally { window.__spaBuildingEl = null; }
      // FIX — many pages boot via DOMContentLoaded; in the SPA it does not fire on its own
      try{
        document.dispatchEvent(new Event('DOMContentLoaded',{bubbles:false,cancelable:false}));
        window.dispatchEvent(new Event('load'));
      }catch(e){}
      rec.built=true;
    }catch(e){
      box.innerHTML='<div style="padding:40px;color:#f66;font-family:monospace;">load fail: '+e.message+'</div>';
      console.error('[spa] build',info.route,e);
    }
    return rec;
  }

  // FIX ID-scoping: view-urile coexista in DOM cu ID-uri duplicate (app, lockOverlay...).
  // getElementById cauta INTAI in view-ul activ, apoi fallback global.
  var _origGetById = document.getElementById.bind(document);
  document.getElementById = function(id){
    try{
      var _esc = (window.CSS&&CSS.escape)?CSS.escape(id):id;
      if (window.__spaBuildingEl){
        var bhit = window.__spaBuildingEl.querySelector('#'+_esc);
        if (bhit) return bhit;
      }
      if (curRoute && views[curRoute] && views[curRoute].el){
        var hit = views[curRoute].el.querySelector('#'+_esc);
        if (hit) return hit;
      }
    }catch(e){}
    return _origGetById(id);
  };

  async function show(){
    var info=parseHash();
    if(curRoute===info.route){ return; }   // deja vizibil
    // ascunde view-ul curent (NU distruge)
    Object.keys(views).forEach(function(rt){
      var v=views[rt]; if(!v) return;
      v.el.style.display = (rt===info.route)?'block':'none';
      v.cssNodes.forEach(function(n){ n.disabled = (rt!==info.route); });
    });
    // build on first visit
    if(!views[info.route]){
      var rec=await buildView(info);
      // re-aplica vizibilitate (build dureaza, alt view putea fi cerut)
      var now=parseHash();
      Object.keys(views).forEach(function(rt){
        views[rt].el.style.display=(rt===now.route)?'block':'none';
        views[rt].cssNodes.forEach(function(n){ n.disabled=(rt!==now.route); });
      });
    } else {
      views[info.route].el.style.display='block';
      views[info.route].cssNodes.forEach(function(n){ n.disabled=false; });
    }
    curRoute=info.route;
    window.scrollTo(0,0);
    setActiveNav(info.route);
    // hook optional de refresh la revenire (paginile pot defini window['gbxRefresh_'+route])
    var rfn=window['gbxRefresh_'+info.route];
    if(typeof rfn==='function'){ try{ rfn(); }catch(_e){} }
  }

  var START_ROUTES=['unlock','welcome','disclaimer','create-wallet','import-wallet'];
  function setActiveNav(name){
    document.querySelectorAll('#spa-nav .bnav__item').forEach(function(a){
      a.classList.toggle('active',(a.getAttribute('data-route')||'')===name);
    });
    // navbar + ticker + banner DOAR dupa login (ascunse pe ecranele de pornire)
    var pre = START_ROUTES.indexOf(name) >= 0;
    var nav = document.getElementById('spa-nav');
    if(nav){ nav.style.display = pre ? 'none' : 'flex'; }
    // ticker (din home, fixed) + pwa banner (din welcome) — ascunse pe pre-login
    ['.gbx-promo-bar','.gbx-burns-bar','#pwaBanner','.v3-pwa-banner'].forEach(function(sel){
      document.querySelectorAll(sel).forEach(function(el){ el.style.display = pre ? 'none' : ''; });
    });
    // remove the padding-top added by the promo banner when the bar is hidden pre-login
    if(pre){ document.body.classList.remove('gbx-has-promo'); }
  }

  function _routeFromUrl(u){
    if(!u) return null;
    if(u.charAt(0)==='#'||u.indexOf('http')===0) return null;
    var path=u.split('#')[0]; var q=''; var qi=path.indexOf('?');
    if(qi>=0){ q=path.slice(qi+1); path=path.slice(0,qi); }
    var route=PATH2ROUTE[path];
    return route?{route:route,q:q}:null;
  }
  document.addEventListener('click', function(e){
    var el=e.target;
    // walk up the DOM at most 4 levels looking for an <a href> OR an onclick with /v3/
    for(var i=0; i<5 && el && el!==document; i++){
      // 1) <a href>
      if(el.tagName==='A' && el.getAttribute && el.getAttribute('href')){
        if(el.target==='_blank'){ return; }
        var r=_routeFromUrl(el.getAttribute('href'));
        if(r){ e.preventDefault(); location.hash='#'+r.route+(r.q?('?'+r.q):''); return; }
      }
      // 2) onclick care contine /v3/X.html (location.href / this.href)
      var oc=el.getAttribute && el.getAttribute('onclick');
      if(oc){
        var m=oc.match(/['"](\/[a-zA-Z0-9_\-]+\.html(?:\?[^'"]*)?)['"]/);
        if(m){ var r2=_routeFromUrl(m[1]); if(r2){ e.preventDefault(); e.stopPropagation(); location.hash='#'+r2.route+(r2.q?('?'+r2.q):''); return; } }
      }
      el=el.parentNode;
    }
  }, true);

  window.addEventListener('hashchange', show);
  // GARDIAN de pornire — replica logica HOME, dar navigheaza in SPA (nu location.replace)
  function initialRoute(){
    try{
      if(localStorage.getItem('gbx_disclaimer_agreed')!=='true') return 'disclaimer';
      var st=localStorage.getItem('goldbrix_state_v3');
      if(!st) return 'welcome';
      var s=JSON.parse(st);
      if(!s.wallets||s.wallets.length===0||!s.salt||!s.pwdHash) return 'welcome';
      if(!sessionStorage.getItem('gbx_unlocked_wallets')) return 'unlock';
      return 'home';
    }catch(e){ return 'welcome'; }
  }
  document.addEventListener('DOMContentLoaded', function(){
    if(!location.hash){ location.hash='#'+initialRoute(); }
    show();
  });
})();

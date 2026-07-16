// GBX s47 v3 — frozen overlay, route-aware (SPA hash + standalone), nav always on top
(function(){
  if(window.__gbxFrozenOvl)return; window.__gbxFrozenOvl=1;
  var L={
   en:{t:'The launchpad moves on-chain',b:'The old test coins were burned — proof lives on the chain, forever.',c:'The new launchpad, where a coin is born of WORK and lives in consensus, opens at activation.',l:'View burn on explorer'},
   ro:{t:'Launchpad-ul se mută pe lanț',b:'Vechile monede de test au fost arse — dovada trăiește pe lanț, pentru totdeauna.',c:'Noul launchpad, unde o monedă se naște prin MUNCĂ și trăiește în consens, se deschide la activare.',l:'Vezi arderea în explorer'},
   de:{t:'Das Launchpad zieht auf die Chain',b:'Die alten Test-Coins wurden verbrannt — der Beweis lebt für immer auf der Chain.',c:'Das neue Launchpad, wo ein Coin durch ARBEIT geboren wird und im Konsens lebt, öffnet bei der Aktivierung.',l:'Burn im Explorer ansehen'},
   zh:{t:'启动台正迁移至链上',b:'旧的测试币已被销毁——证明永远留在链上。',c:'新的启动台将在激活时开放：币由「工作」诞生，活在共识之中。',l:'在浏览器中查看销毁'},
   ar:{t:'منصة الإطلاق تنتقل إلى السلسلة',b:'تم حرق العملات التجريبية القديمة — والدليل يعيش على السلسلة إلى الأبد.',c:'منصة الإطلاق الجديدة، حيث تولد العملة بالعمل وتعيش في الإجماع، تفتح عند التفعيل.',l:'عرض الحرق في المستكشف'}
  };
  var lang=localStorage.getItem('gbx_lang')||localStorage.getItem('goldbrix_lang')||'en';
  var t=L[lang]||L.en;
  var tx='c9d87e34f40d56046cb503b38a9c5c0c0b0bb9eefa74bd08c949cdd291cb643e';
  var d=document.createElement('div');
  d.id='gbx-frozen-ovl';
  d.style.cssText='position:fixed;left:0;right:0;top:0;bottom:0;z-index:90;background:rgba(18,14,8,.98);display:none;align-items:center;justify-content:center;padding:24px 24px 130px;text-align:center'+(lang==='ar'?';direction:rtl':'');
  d.innerHTML='<div style="max-width:420px"><div style="font-size:56px">🔥</div>'+
    '<h2 style="color:#f0c060;font-size:22px;margin:16px 0 10px">'+t.t+'</h2>'+
    '<p style="color:#c9bfa8;line-height:1.5;margin:0 0 8px">'+t.b+'</p>'+
    '<p style="color:#c9bfa8;line-height:1.5;margin:0 0 20px">'+t.c+'</p>'+
    '<a href="/v3/explorer.html?tx='+tx+'" style="color:#54b8f0;text-decoration:underline">'+t.l+'</a></div>';
  function onFrozenRoute(){
    var h=(location.hash||'').toLowerCase(), p=location.pathname.toLowerCase();
    return h.indexOf('launch')>=0||h.indexOf('trade')>=0||p.indexOf('launch')>=0||p.indexOf('trade')>=0;
  }
  function navUp(){
    var n=document.querySelector('#spa-nav,.bnav,.v3-final-nav,nav');
    if(n){var cs=getComputedStyle(n); if(cs.position==='static')n.style.position='relative'; n.style.zIndex='9000';}
  }
  function sync(){ d.style.display=onFrozenRoute()?'flex':'none'; }
  function mount(){ if(!document.getElementById('gbx-frozen-ovl'))document.body.appendChild(d); sync(); }
  if(document.body){mount();}else if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',mount);}else{mount();}
  window.addEventListener('hashchange',sync);
  setInterval(sync,1500); // plasă: rute schimbate programatic fără hashchange
})();

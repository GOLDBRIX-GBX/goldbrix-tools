// GBX s47 v2 — launchpad frozen overlay (scoped to page view; removed at activation)
(function(){
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
  // host = containerul view-ului (SPA) sau body (standalone)
  var host=document.currentScript&&document.currentScript.parentElement;
  if(!host||host===document.documentElement)host=document.body;
  var spa=(host!==document.body);
  var d=document.createElement('div');
  d.id='gbx-frozen-ovl';
  d.style.cssText=(spa?'position:absolute':'position:fixed')+
    ';left:0;right:0;top:0;bottom:0;z-index:5000;background:rgba(18,14,8,.97);display:flex;align-items:center;justify-content:center;padding:24px 24px 120px;text-align:center'+
    (lang==='ar'?';direction:rtl':'');
  d.innerHTML='<div style="max-width:420px"><div style="font-size:56px">🔥</div>'+
    '<h2 style="color:#f0c060;font-size:22px;margin:16px 0 10px">'+t.t+'</h2>'+
    '<p style="color:#c9bfa8;line-height:1.5;margin:0 0 8px">'+t.b+'</p>'+
    '<p style="color:#c9bfa8;line-height:1.5;margin:0 0 20px">'+t.c+'</p>'+
    '<a href="/v3/explorer.html?tx='+tx+'" style="color:#54b8f0;text-decoration:underline">'+t.l+'</a></div>';
  function mount(){
    if(document.getElementById('gbx-frozen-ovl'))return;
    if(spa){ if(getComputedStyle(host).position==='static')host.style.position='relative'; host.appendChild(d); }
    else{
      document.body.appendChild(d);
      var nav=document.querySelector('.bnav,.v3-final-nav,nav');
      if(nav){nav.style.position='relative';nav.style.zIndex='6000';}
    }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();

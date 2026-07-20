/* GoldBrix V4.9 — Universal Live Ticker: Promoted + Top 24h + Newest — 5 langs */
(function(){
  const API = 'https://goldbrix.app';
  let bannerEl = null;
  let items = [];
  let lastFingerprint = '';

  const I18N = {
    en:{join:'JOIN THE FEDERATION',promoted:'PROMOTED',top:'TOP',neu:'NEW',upd:'🚀 NEW VERSION · tap or go to Settings'},
    ro:{join:'AL\u0102TUR\u0102-TE FEDERA\u021aIEI',promoted:'PROMOVAT',top:'TOP',neu:'NOU',upd:'🚀 VERSIUNE NOUĂ · click sau Setări'},
    de:{join:'TRITT DER F\u00d6DERATION BEI',promoted:'BEWORBEN',top:'TOP',neu:'NEU',upd:'🚀 NEUE VERSION · tippen oder Einstellungen'},
    zh:{join:'\u52a0\u5165\u8054\u90a6',promoted:'推广',top:'热门',neu:'新',upd:'🚀 新版本 · 点击或前往设置'},
    ar:{join:'\u0627\u0646\u0636\u0645 \u0625\u0644\u0649 \u0627\u0644\u0627\u062a\u062d\u0627\u062f',promoted:'مُروّج',top:'الأعلى',neu:'جديد',upd:'🚀 إصدار جديد · انقر أو الإعدادات'}
  };
  function lang(){ try{ return localStorage.getItem('gbx_lang')||localStorage.getItem('goldbrix_lang')||'en'; }catch(e){ return 'en'; } }
  function t(k){ const l=lang(); return (I18N[l]&&I18N[l][k])||I18N.en[k]||k; }

  function injectCSS(){
    if (document.getElementById('gbx-promo-css')) return;
    const s=document.createElement('style'); s.id='gbx-promo-css';
    s.textContent=`
      .gbx-promo-bar{position:fixed;top:0;left:0;right:0;z-index:99998;background:linear-gradient(90deg,#1a1208,#3a2510,#1a1208);border-bottom:1px solid #F0C060;padding:calc(7px + env(safe-area-inset-top,0px)) 0 7px 0;overflow:hidden;box-shadow:0 2px 12px rgba(240,192,96,0.25);font-family:'JetBrains Mono',monospace;font-size:11px;color:#FFE099;}
      .gbx-promo-track{display:inline-flex;white-space:nowrap;animation:gbxMarquee 40s linear infinite;will-change:transform;}
      @keyframes gbxMarquee{from{transform:translateX(0);}to{transform:translateX(-50%);}}
      .gbx-promo-item{display:inline-flex;align-items:center;gap:7px;padding:0 13px;cursor:pointer;}
      .gbx-promo-badge{font-weight:800;font-size:9px;letter-spacing:0.5px;}
      .gbx-promo-ticker{color:#F0C060;font-weight:800;font-size:12px;}
      .gbx-promo-metric{font-weight:700;font-size:10px;}
      .gbx-promo-sep{color:#F0C060;opacity:0.35;}
      body.gbx-has-promo{padding-top:calc(34px + env(safe-area-inset-top,0px)) !important;}
      .gbx-promo-bar:active .gbx-promo-track{animation-play-state:paused;}
    `;
    document.head.appendChild(s);
  }
  function fmtTime(endMs){ const ms=endMs-Date.now(); if(ms<=0)return 'exp'; const h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000); return h>0?h+'h '+m+'m':m+'m'; }
  function pct(n){ n=Number(n)||0; return (n>=0?'+':'')+n.toFixed(1)+'%'; }

  function render(){
    if(!items.length){ if(bannerEl){bannerEl.remove();bannerEl=null;lastFingerprint='';} document.body.classList.remove('gbx-has-promo'); return; }
    injectCSS();
    if(!bannerEl){ bannerEl=document.createElement('div'); bannerEl.className='gbx-promo-bar'; document.body.insertBefore(bannerEl,document.body.firstChild); document.body.classList.add('gbx-has-promo'); }
    const fp=items.map(i=>i.cat+i.coin_id).join('|')+'|'+lang();
    if(fp===lastFingerprint){ updateTimes(); return; }
    lastFingerprint=fp;
    const itemHtml=i=>{
      let badge,color,metric=i.metric||'';
      if(i.cat==='join'){ return `<span class="gbx-promo-item" data-cat="join"><span class="gbx-promo-badge" style="color:#F0C060">\ud83e\udd1d ${t('join')}</span><span class="gbx-promo-metric" style="color:#FFE099">${i.metric||''}</span><span class="gbx-promo-sep">\u2022</span></span>`; }
      if(i.cat==='update'){ return `<span class="gbx-promo-item" data-cat="update"><span class="gbx-promo-ticker" style="color:#F0C060">${t('upd')}</span><span class="gbx-promo-sep">•</span></span>`; }
      if(i.cat==='promoted'){ badge='🔥 '+t('promoted'); color='#F0C060'; metric='⏱ '+fmtTime(i.ends_at); }
      else if(i.cat==='top'){ badge='📈 '+t('top'); color='#5cd68b'; }
      else { badge='🆕 '+t('neu'); color='#7fb3ff'; }
      return `<span class="gbx-promo-item" data-coin="${i.coin_id}" data-cat="${i.cat}"><span class="gbx-promo-badge" style="color:${color}">${badge}</span><span class="gbx-promo-ticker">$${i.ticker}</span>${metric?`<span class="gbx-promo-metric" style="color:${color}">${metric}</span>`:''}<span class="gbx-promo-sep">•</span></span>`;
    };
    const html=items.map(itemHtml).join('');
    bannerEl.innerHTML='<div class="gbx-promo-track">'+html+html+'</div>';
    bannerEl.querySelectorAll('.gbx-promo-item').forEach(el=>{ el.onclick=()=>{ if(el.dataset.cat==='update'){
      // GBX — plic = descarcare DIRECTA (browser extern). Butoanele din settings duc la pagina /get.
      var ABS='https://goldbrix.app/downloads/android/latest.apk';
      try{ var P=window.Capacitor&&window.Capacitor.Plugins; if(P&&P.Browser){ P.Browser.open({url:ABS}); return; } }catch(_){}
      window.open(ABS,'_system')||(window.location.href=ABS);
    } else { if(el.dataset.cat==='join'){window.location.href='/v3/join.html';}else{window.location.href='/v3/coin-x.html?coin='+el.dataset.coin;} } }; });
    const track=bannerEl.querySelector('.gbx-promo-track');
    if(track){ const dur=Math.max(25,Math.min(95,items.length*6)); track.style.animationDuration=dur+'s'; }
  }
  function updateTimes(){
    if(!bannerEl)return;
    items.filter(i=>i.cat==='promoted').forEach(i=>{
      bannerEl.querySelectorAll('[data-coin="'+i.coin_id+'"][data-cat="promoted"] .gbx-promo-metric').forEach(el=>{ el.textContent='⏱ '+fmtTime(i.ends_at); });
    });
  }

  async function refresh(){
    try{
      // live sources only - consensus launchpad index + on-chain registries.
      const [curvesR,nodesR,lpsR]=await Promise.all([
        window.GBXRead.json('/api/curves').catch(()=>({})),
        window.GBXRead.json('/api/node-registry').catch(()=>({})),
        window.GBXRead.json('/api/lp-registry').catch(()=>({}))
      ]);
      const nN=nodesR.nodes?Object.keys(nodesR.nodes).length:0;
      const nL=lpsR.lps?Object.keys(lpsR.lps).length:0;
      const join={cat:'join',metric:nN+'\ud83d\udd17 '+nL+'\ud83d\udca7'};
      const all=(curvesR.curves||[]);
      const newest=all.slice().sort((a,b)=>(b.created_height||0)-(a.created_height||0)).slice(0,5)
        .map(c=>({cat:'new',coin_id:c.coin_id,ticker:c.ticker||'?'}));
      const top=all.slice().sort((a,b)=>(Number(b.reserve_sat)||0)-(Number(a.reserve_sat)||0)).slice(0,10)
        .map(c=>({cat:'top',coin_id:c.coin_id,ticker:c.ticker||'?'}));
      const us=window.__GBX_UPDATE_STATE__||{};
      const others=[join,...top,...newest];
      if(us.available && us.remote){
        const out=[{cat:'update'}]; let c=0;
        for(const it of others){ out.push(it); c++; if(c%4===0) out.push({cat:'update'}); }
        items=out;
      } else {
        items=others;
      }
      render();
    }catch(e){}
  }
  async function recoverPending(){ /* retired with the custodial launchpad */ }
  function start(){
    refresh(); recoverPending();
    setInterval(refresh,30000);
    setInterval(updateTimes,15000);
    window.addEventListener('gbx:update-available', function(){ refresh(); });
    window.addEventListener('storage',function(e){ if(e.key&&e.key.indexOf('lang')>-1){ lastFingerprint=''; render(); } });
  }
  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded',start); } else { start(); }
})();

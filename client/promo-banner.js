/* GoldBrix V4.9 — Universal Live Ticker: Promoted + Top 24h + Newest — 5 langs */
(function(){
  const API = 'https://goldbrix.app';
  let bannerEl = null;
  let items = [];
  let lastFingerprint = '';

  const I18N = {
    en:{promoted:'PROMOTED',top:'TOP',neu:'NEW',upd:'🚀 NEW VERSION · tap or go to Settings'},
    ro:{promoted:'PROMOVAT',top:'TOP',neu:'NOU',upd:'🚀 VERSIUNE NOUĂ · click sau Setări'},
    de:{promoted:'BEWORBEN',top:'TOP',neu:'NEU',upd:'🚀 NEUE VERSION · tippen oder Einstellungen'},
    zh:{promoted:'推广',top:'热门',neu:'新',upd:'🚀 新版本 · 点击或前往设置'},
    ar:{promoted:'مُروّج',top:'الأعلى',neu:'جديد',upd:'🚀 إصدار جديد · انقر أو الإعدادات'}
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
    const fp=items.map(i=>i.cat+i.coin_id).join('|');
    if(fp===lastFingerprint){ updateTimes(); return; }
    lastFingerprint=fp;
    const itemHtml=i=>{
      let badge,color,metric=i.metric||'';
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
    } else { window.location.href='/v3/trade.html?coin='+el.dataset.coin; } }; });
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
      const [promoR,listR]=await Promise.all([
        fetch(API+'/launchpad/promote/active').then(r=>r.json()).catch(()=>({})),
        fetch(API+'/v2/memecoin/list?limit=100').then(r=>r.json()).catch(()=>({}))
      ]);
      const promoted=(promoR.active||[]).map(c=>({cat:'promoted',coin_id:c.coin_id,ticker:c.ticker||'?',ends_at:c.ends_at}));
      const all=(listR.coins||[]);
      const newest=all.slice(0,5).map(c=>({cat:'new',coin_id:c.id,ticker:c.ticker||'?'}));
      const top=all.slice().sort((a,b)=>(b.change_24h_pct||0)-(a.change_24h_pct||0)).slice(0,10).map(c=>({cat:'top',coin_id:c.id,ticker:c.ticker||'?',metric:pct(c.change_24h_pct)}));
      // GBX — item update PRIMUL, doar daca e update real disponibil
      const us=window.__GBX_UPDATE_STATE__||{};
      const others=[...promoted,...top,...newest];
      if(us.available && us.remote){
        // GBX — insereaza update-ul la inceput SI la fiecare 4 items (circula des, mai vizibil)
        const out=[{cat:'update'}]; let c=0;
        for(const it of others){ out.push(it); c++; if(c%4===0) out.push({cat:'update'}); }
        items=out;
      } else {
        items=others;
      }
      render();
    }catch(e){}
  }
  async function recoverPending(){
    try{
      const p=JSON.parse(localStorage.getItem('gbx_pending_promo')||'{}');
      if(!p.promo_id||!p.tx_hash)return;
      if(Date.now()-(p.timestamp||0)<30000)return;
      const r=await fetch(API+'/launchpad/promote/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({promo_id:p.promo_id,tx_hash:p.tx_hash})});
      const d=await r.json();
      if(d.success){ localStorage.removeItem('gbx_pending_promo'); refresh(); }
    }catch(e){}
  }
  function start(){
    refresh(); recoverPending();
    setInterval(refresh,30000);
    setInterval(updateTimes,15000);
    window.addEventListener('gbx:update-available', function(){ refresh(); });
    window.addEventListener('storage',function(e){ if(e.key&&e.key.indexOf('lang')>-1){ lastFingerprint=''; render(); } });
  }
  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded',start); } else { start(); }
})();

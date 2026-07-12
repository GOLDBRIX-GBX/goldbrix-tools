/* GoldBrix V4.9 — Universal Burns Banner — i18n 5 langs */
(function(){
  const API = 'https://goldbrix.app';
  let bannerEl = null;
  let mode = 0;
  let lastStats = null;
  let lastTrending = null;
  
  // === i18n self-contained (5 langs) ===
  const I18N = {
    en: { forever:'burned forever', txs:'txs', today:'TODAY', trending:'TRENDING', liq:'liq', loading:'Loading...' },
    ro: { forever:'arse pentru totdeauna', txs:'tx', today:'ASTĂZI', trending:'ÎN TRENDING', liq:'lichid.', loading:'Încărcare...' },
    de: { forever:'für immer verbrannt', txs:'Txs', today:'HEUTE', trending:'TRENDS', liq:'Liq', loading:'Lädt...' },
    zh: { forever:'永久销毁', txs:'笔', today:'今日', trending:'热门', liq:'流动性', loading:'加载中...' },
    ar: { forever:'محروقة للأبد', txs:'معاملة', today:'اليوم', trending:'رائج', liq:'سيولة', loading:'تحميل...' }
  };
  
  function getLang() {
    try {
      // Try multiple localStorage keys + window var + document
      return localStorage.getItem('gbx_lang') 
          || localStorage.getItem('lang')
          || localStorage.getItem('userLang')
          || (window.currentLang)
          || document.documentElement.lang
          || 'en';
    } catch(e) { return 'en'; }
  }
  
  function t(key) {
    const lang = getLang();
    return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
  }
  
  function injectCSS() {
    if (document.getElementById('gbx-burns-css')) return;
    const s = document.createElement('style');
    s.id = 'gbx-burns-css';
    s.textContent = `
      .gbx-burns-bar { position:fixed; left:0; right:0; top:calc(env(safe-area-inset-top, 0px)); z-index:99997; background:linear-gradient(90deg,#2a0a0a,#4a1810,#2a0a0a); border-bottom:1px solid rgba(255,100,68,0.45); padding:6px 12px; text-align:center; font-family:'JetBrains Mono',monospace; font-size:11px; color:#ffccaa; line-height:1.4; transition:opacity 0.3s; transition:top 0.3s; }
      body.gbx-has-promo .gbx-burns-bar { top:calc(env(safe-area-inset-top, 0px) + 34px); }
      body.gbx-has-burns { padding-top:calc(30px + env(safe-area-inset-top, 0px)) !important; }
      body.gbx-has-promo.gbx-has-burns { padding-top:calc(64px + env(safe-area-inset-top, 0px)) !important; }
    `;
    document.head.appendChild(s);
  }
  
  function fmt(n, dec) {
    if (n == null) return '0';
    if (n >= 1000000) return (n/1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n/1000).toFixed(1) + 'K';
    return Number(n).toFixed(dec !== undefined ? dec : 2);
  }
  
  function ensure() {
    if (bannerEl) return;
    injectCSS();
    bannerEl = document.createElement('div');
    bannerEl.className = 'gbx-burns-bar';
    bannerEl.innerHTML = '🔥 ' + t('loading');
    document.body.insertBefore(bannerEl, document.body.firstChild);
    document.body.classList.add('gbx-has-burns');
  }
  
  function render() {
    if (!bannerEl) return;
    if (mode === 0 && lastStats) {
      bannerEl.innerHTML = '🔥 <b style="color:#fff">' + fmt(lastStats.real_burns_gbx) + '</b> GBX ' + t('forever') + ' · <b>' + lastStats.real_burns_count + '</b> ' + t('txs') + ' · ' + t('today') + ': <b style="color:#ffdd99">' + fmt(lastStats.burned_24h, 4) + '</b>';
    } else if (mode === 1 && lastTrending) {
      bannerEl.innerHTML = '📈 ' + t('trending') + ': <b style="color:#ffdd99">$' + lastTrending.ticker + '</b> · ' + t('liq') + ' <b>' + fmt(lastTrending.reserve_gbx, 2) + '</b> GBX · ' + (lastTrending.name||'').substring(0,20);
    }
    mode = 1 - mode;
  }
  
  async function refreshBurns() {
    try {
      const r = await fetch(API + '/launchpad/burns/total');
      lastStats = await r.json();
      ensure();
      if (mode === 0) { render(); mode = 1; }
    } catch(e) {}
  }
  
  async function refreshTrending() {
    try {
      const r = await fetch(API + '/v2/memecoin/list?limit=20');
      const d = await r.json();
      const coins = (d.coins || d || []);
      if (coins.length) {
        coins.sort((a,b) => (b.reserve_gbx||0) - (a.reserve_gbx||0));
        lastTrending = coins[0];
      }
    } catch(e) {}
  }
  
  function start() {
    refreshBurns();
    refreshTrending();
    setInterval(refreshBurns, 30000);
    setInterval(refreshTrending, 60000);
    setInterval(render, 5000);
    
    // Re-render on language change (listen for storage event)
    window.addEventListener('storage', e => {
      if (e.key && (e.key.indexOf('lang') > -1)) {
        if (bannerEl) { mode = 0; render(); mode = 1; }
      }
    });
  }
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

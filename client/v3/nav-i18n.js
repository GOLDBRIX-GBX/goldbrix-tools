// === GOLDBRIX UNIVERSAL NAV — single source of truth ===
// Builds the standard 7-item bottom nav on every standalone page,
// hides any legacy per-page navs, translates in 5 languages.
(function() {
  const NAV_T = {
    en: { navHome:'HOME', navWallet:'WALLET', navTrade:'TRADE', navLaunch:'LAUNCH', navBurns:'BURNS', navExplorer:'EXPLORER', navSettings:'SETTINGS' },
    ro: { navHome:'ACASĂ', navWallet:'PORTOFEL', navTrade:'TRADE', navLaunch:'LANSARE', navBurns:'ARDERI', navExplorer:'EXPLORER', navSettings:'SETĂRI' },
    de: { navHome:'HOME', navWallet:'WALLET', navTrade:'HANDEL', navLaunch:'STARTEN', navBurns:'BURNS', navExplorer:'EXPLORER', navSettings:'EINSTELL.' },
    zh: { navHome:'首页', navWallet:'钱包', navTrade:'交易', navLaunch:'发行', navBurns:'燃烧', navExplorer:'浏览器', navSettings:'设置' },
    ar: { navHome:'الرئيسية', navWallet:'محفظة', navTrade:'تداول', navLaunch:'إطلاق', navBurns:'حرق', navExplorer:'مستكشف', navSettings:'إعدادات' }
  };
  const ITEMS = [
    ['/',                    '🏠','navHome'],
    ['/v3/wallet.html',      '👤','navWallet'],
    ['/v3/trade.html',       '📊','navTrade'],
    ['/v3/launch.html',      '🚀','navLaunch'],
    ['/v3/leaderboard.html', '🔥','navBurns'],
    ['/v3/explorer.html',    '🔍','navExplorer'],
    ['/v3/settings.html',    '⚙️','navSettings']
  ];
  const ALIAS = { '/v3/launch-x.html':'/v3/launch.html', '/v3/coins-x.html':'/v3/trade.html', '/v3/coin-x.html':'/v3/trade.html', '/v3/burns.html':'/v3/leaderboard.html', '/index.html':'/' };
  function getLang(){ return localStorage.getItem('gbx_lang') || localStorage.getItem('goldbrix_lang') || 'en'; }
  function applyNavI18n(){
    try {
      const t = NAV_T[getLang()] || NAV_T.en;
      document.documentElement.dir = getLang() === 'ar' ? 'rtl' : 'ltr';
      document.querySelectorAll('[data-t]').forEach(el => {
        const k = el.getAttribute('data-t');
        if (t[k]) el.textContent = t[k];
      });
    } catch(e){ console.error('[nav-i18n]', e); }
  }
  function buildNav(){
    try {
      // hide every legacy per-page nav (never the SPA shell nav #spa-nav)
      document.querySelectorAll('#pgNav, nav.v3-final-nav, div.bnav').forEach(n => {
        if (n.id !== 'spa-nav') n.style.display = 'none';
      });
      if (window.__SPA_PATH2ROUTE) return;           // SPA shell has its own nav
      if (document.getElementById('gbxNav')) return; // already built
      let here = location.pathname; here = ALIAS[here] || here;
      const nav = document.createElement('nav');
      nav.id = 'gbxNav';
      nav.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#2a2218;border-top:1px solid #3a3025;padding:6px 0 calc(6px + env(safe-area-inset-bottom));display:flex;z-index:9999;';
      ITEMS.forEach(function(it){
        const active = (here === it[0]);
        const a = document.createElement('a');
        a.href = it[0];
        a.style.cssText = 'flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px;text-decoration:none;font-family:JetBrains Mono,monospace;font-size:9px;font-weight:700;letter-spacing:.1em;color:' + (active?'#F5CC75':'#FFE099') + ';opacity:' + (active?'1':'.7') + ';';
        a.innerHTML = '<span style="font-size:18px;">' + it[1] + '</span><span data-t="' + it[2] + '"></span>';
        nav.appendChild(a);
      });
      document.body.appendChild(nav);
      document.body.style.paddingBottom = '76px';
    } catch(e){ console.error('[nav-build]', e); }
  }
  function run(){ buildNav(); applyNavI18n(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
  window.addEventListener('storage', e => { if (e.key && e.key.indexOf('lang') > -1) applyNavI18n(); });
  let lastLang = getLang();
  setInterval(() => { const c = getLang(); if (c !== lastLang){ lastLang = c; applyNavI18n(); } }, 600);
})();

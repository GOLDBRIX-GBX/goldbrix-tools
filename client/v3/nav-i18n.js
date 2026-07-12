// === GOLDBRIX UNIVERSAL NAV i18n ===
// Translates [data-t="navXxx"] elements in 5 languages
// Auto-runs on load + storage event
(function() {
  const NAV_T = {
    en: { navHome:'HOME', navWallet:'WALLET', navTrade:'TRADE', navLaunch:'LAUNCH', navBurns:'BURNS', navSettings:'SETTINGS' },
    ro: { navHome:'ACASĂ', navWallet:'PORTOFEL', navTrade:'TRADE', navLaunch:'LANSARE', navBurns:'ARDERI', navSettings:'SETĂRI' },
    de: { navHome:'HOME', navWallet:'WALLET', navTrade:'HANDEL', navLaunch:'STARTEN', navBurns:'BURNS', navSettings:'EINSTELL.' },
    zh: { navHome:'首页', navWallet:'钱包', navTrade:'交易', navLaunch:'发行', navBurns:'燃烧', navSettings:'设置' },
    ar: { navHome:'الرئيسية', navWallet:'محفظة', navTrade:'تداول', navLaunch:'إطلاق', navBurns:'حرق', navSettings:'إعدادات' }
  };
  function getLang() {
    return localStorage.getItem('gbx_lang') || localStorage.getItem('goldbrix_lang') || 'en';
  }
  function applyNavI18n() {
    try {
      const lang = getLang();
      const t = NAV_T[lang] || NAV_T.en;
      document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
      document.querySelectorAll('[data-t]').forEach(el => {
        const k = el.getAttribute('data-t');
        if (t[k]) el.textContent = t[k];
      });
    } catch(e) { console.error('[nav-i18n]', e); }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyNavI18n);
  } else {
    applyNavI18n();
  }
  window.addEventListener('storage', e => {
    if (e.key && e.key.indexOf('lang') > -1) applyNavI18n();
  });
  // Periodic check for same-tab lang change (no storage event)
  let lastLang = getLang();
  setInterval(() => {
    const cur = getLang();
    if (cur !== lastLang) { lastLang = cur; applyNavI18n(); }
  }, 600);
})();

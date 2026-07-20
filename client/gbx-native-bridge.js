// gbx-native-bridge.js v3 — Strict selectors, no false positives
(function() {
  var Cap = window.Capacitor;
  if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return;
  function setNativeClass() { if (document.body) document.body.classList.add('is-native'); }
  if (document.body) setNativeClass();
  else document.addEventListener('DOMContentLoaded', setNativeClass);
  var css = ''
    + 'body.is-native {'
    + '  padding-top: env(safe-area-inset-top, 24px) !important;'
    + '  padding-bottom: env(safe-area-inset-bottom, 0px);'
    + '}'
    + 'body.is-native [class*="install-banner"],'
    + 'body.is-native [class*="pwa-banner"]:not(.v3-pwa-banner),'
    + 'body.is-native [id*="install-banner"],'
    + 'body.is-native [id*="installBanner"],'
    + 'body.is-native .install-prompt,'
    + 'body.is-native .pwa-prompt,'
    + 'body.is-native .install-nudge {'
    + '  display: none !important;'
    + '}'
    // v3-pwa-banner = the floating banner top of pages, hide in native
    + 'body.is-native .v3-pwa-banner { display: none !important; }';
  var style = document.createElement('style');
  style.id = 'gbx-native-bridge-css';
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
})();


// gbxHaptic - feedback tactil (no-op pe web)
window.gbxHaptic = function(kind){
  try {
    if (!navigator.vibrate) return;
    if (kind === 'success') navigator.vibrate([35, 40, 70]);
    else if (kind === 'error') navigator.vibrate([70, 50, 70, 50, 70]);
    else navigator.vibrate(30);
  } catch(e){}
};

/* ── Buton fizic BACK Android (Capacitor) ──
 * Pe pagini interioare -> wallet. Pe wallet/home -> minimizeaza (nu iese brusc). */
(function(){
  var Cap = window.Capacitor;
  if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return;
  function path(){ return (location.pathname||'').toLowerCase(); }
  function isHome(){ var p=path(); return p==='/'||p.endsWith('/index.html')||p.endsWith('/wallet.html')||p.endsWith('/get/index.html'); }
  function setup(App){
    if(!App||!App.addListener) return;
    App.addListener('backButton', function(ev){
      // If the page has history and we are not on home -> normal in-page back
      if (!isHome() && window.history.length > 1) {
        // inner pages: go to the wallet (predictable), not a blind history.back
        window.location.href = '/v3/wallet.html';
        return;
      }
      if (isHome()) {
        // pe home/wallet: minimizeaza app-ul (nu inchide brusc)
        if (App.minimizeApp) { App.minimizeApp(); }
        else if (ev && ev.canGoBack === false && App.exitApp) { App.exitApp(); }
        return;
      }
      // fallback
      window.location.href = '/v3/wallet.html';
    });
  }
  // @capacitor/app exposes App via Capacitor.Plugins.App
  if (Cap.Plugins && Cap.Plugins.App) { setup(Cap.Plugins.App); }
  else { document.addEventListener('deviceready', function(){ if(Cap.Plugins&&Cap.Plugins.App) setup(Cap.Plugins.App); }); }
})();

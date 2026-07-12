/* GoldBrix Smart Install (v3 - bulletproof hijack)
 * Detects platform: Android → APK, iOS → Add to Home, Desktop → QR + PWA
 * Forces override on window.load (defeats inline pwaInstall declarations)
 */
(function() {
  'use strict';

  var APK_URL = 'https://goldbrix.app/downloads/android/latest.apk';
  var deferredPrompt = null;

  function getPlatform() {
    var ua = navigator.userAgent || '';
    if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) return 'native';
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    return 'desktop';
  }

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
           window.navigator.standalone === true;
  }

  window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    deferredPrompt = e;
  });

  function updateInstallButton() {
    var btn = document.getElementById('pwaBtn');
    var lbl = document.getElementById('pwaBtnLabel');
    if (btn && lbl) {
      var plat = getPlatform();
      if (plat === 'native') { btn.style.opacity='0.5'; btn.disabled=true; lbl.textContent='RUNNING IN NATIVE APP ✓'; }
      else if (isStandalone()) { btn.style.opacity='0.5'; btn.disabled=true; lbl.textContent='PWA INSTALLED ✓'; }
      else if (plat === 'android') lbl.textContent = '📥 DOWNLOAD ANDROID APP';
      else if (plat === 'ios') lbl.textContent = '📱 INSTALL ON iOS';
      else lbl.textContent = '💻 INSTALL GOLDBRIX APP';
    }
    // Also update welcome banner button if exists
    var bannerBtn = document.getElementById('pwaInstallBtn');
    if (bannerBtn) {
      var plat2 = getPlatform();
      if (plat2 === 'android') bannerBtn.textContent = '📥 GET APP';
      else if (plat2 === 'ios') bannerBtn.textContent = '📱 INSTALL';
      else bannerBtn.textContent = '💻 INSTALL';
    }
  }

  // === Smart install (stored under immutable name) ===
  window._gbxSmartInstall = function() {
    var plat = getPlatform();
    if (plat === 'native' || isStandalone()) { showToast('Already installed ✓'); return; }
    if (plat === 'android') return showAndroidModal();
    if (plat === 'ios') return showIOSModal();
    return showDesktopModal();
  };

  function showAndroidModal() {
    showModal({
      icon: '📦',
      title: 'Install GoldBrix Android App',
      body: '<p style="margin:12px 0;color:#ccc;line-height:1.5;font-size:14px;">Tap below to download official APK (~21 MB). Open file to install.</p>' +
            '<p style="margin:12px 0;font-size:12px;color:#888;">⚠️ Allow install from this source if prompted.</p>' +
            '<p style="margin:6px 0;font-size:11px;color:#666;">Cert SHA: 34bf...7085 (verify Settings → Apps → GoldBrix)</p>',
      primary: { label: '📥 DOWNLOAD APK', action: function() {
        window.location.href = APK_URL;
        closeModal();
        setTimeout(function() { showToast('Download started ↓'); }, 600);
      }},
      secondary: { label: 'Cancel', action: closeModal }
    });
  }

  function showIOSModal() {
    showModal({
      icon: '📱', title: 'Install on iOS',
      body: '<p style="margin:12px 0;color:#ccc;font-size:14px;">Use <b>Safari</b>:</p>' +
            '<ol style="margin:12px 0;padding-left:22px;color:#ccc;line-height:1.9;font-size:13px;">' +
            '<li>Tap <b>Share</b> ⬆️ (bottom of Safari)</li>' +
            '<li>Scroll → <b>"Add to Home Screen"</b></li>' +
            '<li>Tap <b>Add</b> (top right)</li></ol>' +
            '<p style="margin:14px 0;font-size:12px;color:#888;">Native iOS app coming soon.</p>',
      primary: { label: 'Got it', action: closeModal }
    });
  }

  function showDesktopModal() {
    var qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(APK_URL);
    showModal({
      icon: '💻', title: 'Install GoldBrix',
      body: '<div style="text-align:center;margin:14px 0;">' +
            '<p style="margin:0 0 12px;color:#ccc;font-size:14px;">Scan with phone for Android app:</p>' +
            '<img src="' + qrUrl + '" width="220" height="220" style="background:#fff;padding:10px;border-radius:10px;" onerror="this.style.display=\'none\'"></div>' +
            '<p style="text-align:center;margin:10px 0;color:#888;font-size:12px;">— OR —</p>' +
            '<p style="text-align:center;margin:8px 0;"><a href="' + APK_URL + '" download style="display:inline-block;background:#FFC107;color:#000;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;">📥 Download APK</a></p>' +
            '<p style="text-align:center;margin:14px 0 4px;"><a href="#" onclick="window.pwaInstallDesktop();return false;" style="color:#FFC107;font-size:12px;text-decoration:underline;">Install as PWA shortcut</a></p>',
      primary: { label: 'Close', action: closeModal }
    });
  }

  window.pwaInstallDesktop = function() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function(c) {
        deferredPrompt = null; closeModal();
        showToast(c.outcome === 'accepted' ? 'PWA installed ✓' : 'Cancelled');
      });
    } else { showToast('Use browser menu → Install GoldBrix'); }
  };

  function showModal(opts) {
    closeModal();
    var ov = document.createElement('div');
    ov.id = 'pwa-install-modal';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;';
    var card = document.createElement('div');
    card.style.cssText = 'background:#1a1410;border:1px solid #FFC107;border-radius:14px;padding:24px;max-width:420px;width:100%;color:#fff;box-shadow:0 12px 40px rgba(0,0,0,0.6);max-height:90vh;overflow-y:auto;';
    card.innerHTML =
      '<div style="font-size:46px;text-align:center;margin-bottom:6px;">' + opts.icon + '</div>' +
      '<h3 style="margin:0 0 14px;text-align:center;color:#FFC107;font-size:18px;font-weight:700;">' + opts.title + '</h3>' +
      '<div>' + opts.body + '</div>' +
      '<div style="display:flex;gap:8px;margin-top:18px;">' +
      (opts.primary ? '<button id="pwa-modal-primary" style="flex:1;background:#FFC107;color:#000;border:0;padding:13px;border-radius:8px;font-weight:700;font-size:14px;cursor:pointer;">' + opts.primary.label + '</button>' : '') +
      (opts.secondary ? '<button id="pwa-modal-secondary" style="background:transparent;color:#888;border:1px solid #444;padding:13px 18px;border-radius:8px;cursor:pointer;font-size:14px;">' + opts.secondary.label + '</button>' : '') +
      '</div>';
    ov.appendChild(card);
    ov.addEventListener('click', function(e) { if (e.target === ov) closeModal(); });
    document.body.appendChild(ov);
    if (opts.primary) document.getElementById('pwa-modal-primary').onclick = opts.primary.action;
    if (opts.secondary) document.getElementById('pwa-modal-secondary').onclick = opts.secondary.action;
  }

  function closeModal() {
    var m = document.getElementById('pwa-install-modal');
    if (m) m.remove();
  }

  function showToast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.92);color:#FFC107;padding:12px 22px;border-radius:8px;z-index:99998;font-size:14px;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,0.4);max-width:90vw;text-align:center;';
    document.body.appendChild(t);
    setTimeout(function() { t.style.opacity='0'; t.style.transition='opacity 0.4s'; }, 2600);
    setTimeout(function() { t.remove(); }, 3200);
  }

  // === BULLETPROOF HIJACK — runs AFTER all inline scripts ===
  function hijackInstall() {
    window.pwaInstall = window._gbxSmartInstall;
    var buttons = document.querySelectorAll('[onclick*="pwaInstall"]');
    buttons.forEach(function(btn) {
      btn.onclick = function(e) {
        e.preventDefault();
        e.stopPropagation();
        window._gbxSmartInstall();
        return false;
      };
    });
    updateInstallButton();
  }

  // Multiple hooks to ensure hijack runs in all cases
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hijackInstall);
  } else {
    hijackInstall();
  }
  window.addEventListener('load', hijackInstall); // bulletproof: runs after EVERYTHING

  // GBX-PERF-LOCK — register SW v5 (stale-while-revalidate shell, network-only API)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
      // NU inregistra SW pe native (Capacitor) - paginile sunt in bundle, SW ar rupe navigarea (localhost)
      if (!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform())) {
        navigator.serviceWorker.register('/sw.js').catch(function(e){ console.warn('SW reg failed', e); });
      }
    });
  }

})();


/* ===== GBX-UX-NATIVE v1 — native feel: block arbitrary text selection + pull-to-refresh ===== */
(function(){
  if (window.__gbxUxNative) return; window.__gbxUxNative = true;
  try {
    var st = document.createElement('style');
    st.textContent =
      'html,body{-webkit-user-select:none;-moz-user-select:none;user-select:none;-webkit-touch-callout:none;}' +
      'input,textarea,select,[contenteditable="true"],code,pre,.selectable,.copyable,.address,.addr,.mnemonic,.seed,[data-copy]{-webkit-user-select:text;-moz-user-select:text;user-select:text;-webkit-touch-callout:default;}' +
      '#gbx-ptr{position:fixed;top:0;left:0;right:0;display:flex;justify-content:center;align-items:flex-start;height:0;overflow:hidden;z-index:100000;pointer-events:none;transition:height .15s ease;}' +
      '#gbx-ptr i{display:block;width:24px;height:24px;margin-top:8px;border:3px solid rgba(245,204,117,.25);border-top-color:#F5CC75;border-radius:50%;opacity:0;}' +
      '@keyframes gbxspin{to{transform:rotate(360deg)}}#gbx-ptr.spin i{animation:gbxspin .7s linear infinite;opacity:1 !important;}';
    (document.head||document.documentElement).appendChild(st);
  } catch(e){}
  function selExempt(t){ return t && t.closest && t.closest('input,textarea,select,[contenteditable="true"],code,pre,.selectable,.copyable,.address,.addr,.mnemonic,.seed,[data-copy]'); }
  document.addEventListener('contextmenu', function(e){ if(!selExempt(e.target)) e.preventDefault(); }, false);
  function ready(fn){ if(document.readyState!=='loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  ready(function(){
    if (!document.body) return;
    var ind=document.createElement('div'); ind.id='gbx-ptr'; ind.innerHTML='<i></i>';
    document.body.appendChild(ind);
    var startY=0, pulling=false, dist=0, REFRESH=70, MAX=120, busy=false;
    function scTop(){ var e=document.scrollingElement||document.documentElement||document.body; return e?e.scrollTop:0; }
    window.addEventListener('touchstart', function(e){ if(busy){pulling=false;return;} if(scTop()<=0 && e.touches.length===1){ startY=e.touches[0].clientY; pulling=true; dist=0; } else pulling=false; }, {passive:true});
    window.addEventListener('touchmove', function(e){ if(!pulling||busy) return; dist=e.touches[0].clientY-startY; if(dist>0){ var h=Math.min(dist*0.5,MAX); ind.style.height=h+'px'; ind.firstChild.style.opacity=Math.min(1,h/REFRESH); } else ind.style.height='0px'; }, {passive:true});
    window.addEventListener('touchend', function(){ if(!pulling||busy){pulling=false;return;} pulling=false; if(dist*0.5>=REFRESH){ busy=true; ind.style.height='42px'; ind.classList.add('spin'); var done=function(){ ind.classList.remove('spin'); ind.style.height='0px'; ind.firstChild.style.opacity=0; busy=false; }; try{ if(typeof window.__ptrRefresh==='function'){ Promise.resolve(window.__ptrRefresh()).catch(function(){}).then(function(){ setTimeout(done,400); }); } else { setTimeout(function(){ location.reload(); }, 250); } }catch(e){ location.reload(); } } else { ind.style.height='0px'; ind.firstChild.style.opacity=0; } }, {passive:true});
  });
})();

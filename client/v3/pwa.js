/* GoldBrix Smart Install (v3 - bulletproof hijack)
 * Detects platform: Android → APK, iOS → Add to Home, Desktop → QR + PWA
 * Forces override on window.load (defeats inline pwaInstall declarations)
 */
(function() {
  'use strict';

  // The published build changes; a URL frozen at build time turns into a 404
  // the day the next release lands. version.json is served by every federation
  // node, so the link is read from it and the constant is only a last resort.
  var APK_URL = 'https://github.com/GOLDBRIX-GBX/goldbrix-core/releases/download/v31-gbx-launchpad/goldbrix-1.0.118-118.apk';
  var APK_SIZE = '';
  var deferredPrompt = null;

  function fmtMB(n) { return n > 0 ? (n / 1048576).toFixed(0) + ' MB' : ''; }

  function refreshApkInfo() {
    try {
      fetch('/version.json?t=' + Date.now(), { cache: 'no-store' })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (!d) return;
          if (d.downloadUrl) APK_URL = d.downloadUrl;
          // The size travels with the metadata: asking the release host costs a
          // cross-origin request it does not answer, and a figure written by
          // hand goes stale at the next build.
          APK_SIZE = fmtMB(d.sizeBytes ? parseInt(d.sizeBytes, 10) : 0);
        })
        .catch(function() { /* no figure is better than a wrong figure */ });
    } catch (e) {}
  }

  function getPlatform() {
    var ua = navigator.userAgent || '';
    if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) return 'native';
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    return 'desktop';
  }

  var GBX_PWA_I18N={
en:{native:'RUNNING IN NATIVE APP \u2713',pwaOk:'PWA INSTALLED \u2713',dlAnd:'\ud83d\udce5 DOWNLOAD ANDROID APP',instIos:'\ud83d\udcf1 INSTALL ON iOS',instApp:'\ud83d\udcbb INSTALL GOLDBRIX APP',getApp:'\ud83d\udce5 GET APP',instS:'\ud83d\udcf1 INSTALL',instD:'\ud83d\udcbb INSTALL',already:'Already installed \u2713',andTitle:'Install GoldBrix Android App',andBody:'Tap below to download the official APK',andOpen:'Open file to install.',andWarn:'\u26a0\ufe0f Allow install from this source if prompted.',cert:'Cert SHA: 34bf...7085 (verify Settings \u2192 Apps \u2192 GoldBrix)',dlApk:'\ud83d\udce5 DOWNLOAD APK',dlApkS:'\ud83d\udce5 Download APK',dlStart:'Download started \u2193',cancel:'Cancel',iosTitle:'Install on iOS',iosUse:'Use <b>Safari</b>:',ios1:'Tap <b>Share</b> \u2b06\ufe0f (bottom of Safari)',ios2:'Scroll \u2192 <b>"Add to Home Screen"</b>',ios3:'Tap <b>Add</b> (top right)',iosSoon:'Native iOS app coming soon.',gotIt:'Got it',deskTitle:'Install GoldBrix',scan:'Scan with phone for Android app:',orX:'\u2014 OR \u2014',shortcut:'Install as PWA shortcut',close:'Close',pwaDone:'PWA installed \u2713',cancelled:'Cancelled',menuHint:'Use browser menu \u2192 Install GoldBrix'},
ro:{native:'RULEAZ\u0102 \u00ceN APLICA\u021aIA NATIV\u0102 \u2713',pwaOk:'PWA INSTALAT \u2713',dlAnd:'\ud83d\udce5 DESCARC\u0102 APLICA\u021aIA ANDROID',instIos:'\ud83d\udcf1 INSTALEAZ\u0102 PE iOS',instApp:'\ud83d\udcbb INSTALEAZ\u0102 GOLDBRIX',getApp:'\ud83d\udce5 IA APLICA\u021aIA',instS:'\ud83d\udcf1 INSTALEAZ\u0102',instD:'\ud83d\udcbb INSTALEAZ\u0102',already:'Deja instalat \u2713',andTitle:'Instaleaz\u0103 aplica\u021bia GoldBrix Android',andBody:'Apas\u0103 mai jos pentru a desc\u0103rca APK-ul oficial',andOpen:'Deschide fi\u0219ierul pentru instalare.',andWarn:'\u26a0\ufe0f Permite instalarea din aceast\u0103 surs\u0103 dac\u0103 \u021bi se cere.',cert:'SHA certificat: 34bf...7085 (verific\u0103 Set\u0103ri \u2192 Aplica\u021bii \u2192 GoldBrix)',dlApk:'\ud83d\udce5 DESCARC\u0102 APK',dlApkS:'\ud83d\udce5 Descarc\u0103 APK',dlStart:'Desc\u0103rcare pornit\u0103 \u2193',cancel:'Anuleaz\u0103',iosTitle:'Instaleaz\u0103 pe iOS',iosUse:'Folose\u0219te <b>Safari</b>:',ios1:'Apas\u0103 <b>Share</b> \u2b06\ufe0f (jos \u00een Safari)',ios2:'Deruleaz\u0103 \u2192 <b>\u201eAdd to Home Screen\u201d</b>',ios3:'Apas\u0103 <b>Add</b> (dreapta sus)',iosSoon:'Aplica\u021bia iOS nativ\u0103 vine cur\u00e2nd.',gotIt:'Am \u00een\u021beles',deskTitle:'Instaleaz\u0103 GoldBrix',scan:'Scaneaz\u0103 cu telefonul pentru aplica\u021bia Android:',orX:'\u2014 SAU \u2014',shortcut:'Instaleaz\u0103 ca scurt\u0103tur\u0103 PWA',close:'\u00cenchide',pwaDone:'PWA instalat \u2713',cancelled:'Anulat',menuHint:'Meniul browserului \u2192 Install GoldBrix'},
de:{native:'L\u00c4UFT IN NATIVER APP \u2713',pwaOk:'PWA INSTALLIERT \u2713',dlAnd:'\ud83d\udce5 ANDROID-APP HERUNTERLADEN',instIos:'\ud83d\udcf1 AUF iOS INSTALLIEREN',instApp:'\ud83d\udcbb GOLDBRIX INSTALLIEREN',getApp:'\ud83d\udce5 APP HOLEN',instS:'\ud83d\udcf1 INSTALLIEREN',instD:'\ud83d\udcbb INSTALLIEREN',already:'Bereits installiert \u2713',andTitle:'GoldBrix Android-App installieren',andBody:'Unten tippen, um die offizielle APK zu laden',andOpen:'Datei zum Installieren \u00f6ffnen.',andWarn:'\u26a0\ufe0f Installation aus dieser Quelle erlauben, falls gefragt.',cert:'Zertifikat-SHA: 34bf...7085 (pr\u00fcfen: Einstellungen \u2192 Apps \u2192 GoldBrix)',dlApk:'\ud83d\udce5 APK HERUNTERLADEN',dlApkS:'\ud83d\udce5 APK herunterladen',dlStart:'Download gestartet \u2193',cancel:'Abbrechen',iosTitle:'Auf iOS installieren',iosUse:'<b>Safari</b> verwenden:',ios1:'<b>Teilen</b> \u2b06\ufe0f tippen (unten in Safari)',ios2:'Scrollen \u2192 <b>\u201eZum Home-Bildschirm\u201c</b>',ios3:'<b>Hinzuf\u00fcgen</b> tippen (oben rechts)',iosSoon:'Native iOS-App kommt bald.',gotIt:'Verstanden',deskTitle:'GoldBrix installieren',scan:'Mit dem Handy scannen f\u00fcr die Android-App:',orX:'\u2014 ODER \u2014',shortcut:'Als PWA-Verkn\u00fcpfung installieren',close:'Schlie\u00dfen',pwaDone:'PWA installiert \u2713',cancelled:'Abgebrochen',menuHint:'Browser-Men\u00fc \u2192 GoldBrix installieren'},
zh:{native:'\u6b63\u5728\u539f\u751f\u5e94\u7528\u4e2d\u8fd0\u884c \u2713',pwaOk:'PWA \u5df2\u5b89\u88c5 \u2713',dlAnd:'\ud83d\udce5 \u4e0b\u8f7d\u5b89\u5353\u5e94\u7528',instIos:'\ud83d\udcf1 \u5728 iOS \u5b89\u88c5',instApp:'\ud83d\udcbb \u5b89\u88c5 GOLDBRIX',getApp:'\ud83d\udce5 \u83b7\u53d6\u5e94\u7528',instS:'\ud83d\udcf1 \u5b89\u88c5',instD:'\ud83d\udcbb \u5b89\u88c5',already:'\u5df2\u5b89\u88c5 \u2713',andTitle:'\u5b89\u88c5 GoldBrix \u5b89\u5353\u5e94\u7528',andBody:'\u70b9\u51fb\u4e0b\u65b9\u4e0b\u8f7d\u5b98\u65b9 APK',andOpen:'\u6253\u5f00\u6587\u4ef6\u5b89\u88c5\u3002',andWarn:'\u26a0\ufe0f \u5982\u63d0\u793a\uff0c\u8bf7\u5141\u8bb8\u6b64\u6765\u6e90\u5b89\u88c5\u3002',cert:'\u8bc1\u4e66 SHA\uff1a34bf...7085\uff08\u9a8c\u8bc1\uff1a\u8bbe\u7f6e \u2192 \u5e94\u7528 \u2192 GoldBrix\uff09',dlApk:'\ud83d\udce5 \u4e0b\u8f7d APK',dlApkS:'\ud83d\udce5 \u4e0b\u8f7d APK',dlStart:'\u5f00\u59cb\u4e0b\u8f7d \u2193',cancel:'\u53d6\u6d88',iosTitle:'\u5728 iOS \u5b89\u88c5',iosUse:'\u4f7f\u7528 <b>Safari</b>\uff1a',ios1:'\u70b9\u51fb<b>\u5206\u4eab</b> \u2b06\ufe0f\uff08Safari \u5e95\u90e8\uff09',ios2:'\u6ed1\u52a8 \u2192 <b>\u201c\u6dfb\u52a0\u5230\u4e3b\u5c4f\u5e55\u201d</b>',ios3:'\u70b9\u51fb<b>\u6dfb\u52a0</b>\uff08\u53f3\u4e0a\u89d2\uff09',iosSoon:'\u539f\u751f iOS \u5e94\u7528\u5373\u5c06\u63a8\u51fa\u3002',gotIt:'\u77e5\u9053\u4e86',deskTitle:'\u5b89\u88c5 GoldBrix',scan:'\u7528\u624b\u673a\u626b\u7801\u83b7\u53d6\u5b89\u5353\u5e94\u7528\uff1a',orX:'\u2014 \u6216 \u2014',shortcut:'\u5b89\u88c5\u4e3a PWA \u5feb\u6377\u65b9\u5f0f',close:'\u5173\u95ed',pwaDone:'PWA \u5df2\u5b89\u88c5 \u2713',cancelled:'\u5df2\u53d6\u6d88',menuHint:'\u6d4f\u89c8\u5668\u83dc\u5355 \u2192 \u5b89\u88c5 GoldBrix'},
ar:{native:'\u064a\u0639\u0645\u0644 \u0641\u064a \u0627\u0644\u062a\u0637\u0628\u064a\u0642 \u0627\u0644\u0623\u0635\u0644\u064a \u2713',pwaOk:'PWA \u0645\u062b\u0628\u062a \u2713',dlAnd:'\ud83d\udce5 \u062a\u0646\u0632\u064a\u0644 \u062a\u0637\u0628\u064a\u0642 \u0623\u0646\u062f\u0631\u0648\u064a\u062f',instIos:'\ud83d\udcf1 \u0627\u0644\u062a\u062b\u0628\u064a\u062a \u0639\u0644\u0649 iOS',instApp:'\ud83d\udcbb \u062a\u062b\u0628\u064a\u062a GOLDBRIX',getApp:'\ud83d\udce5 \u0627\u062d\u0635\u0644 \u0639\u0644\u0649 \u0627\u0644\u062a\u0637\u0628\u064a\u0642',instS:'\ud83d\udcf1 \u062a\u062b\u0628\u064a\u062a',instD:'\ud83d\udcbb \u062a\u062b\u0628\u064a\u062a',already:'\u0645\u062b\u0628\u062a \u0628\u0627\u0644\u0641\u0639\u0644 \u2713',andTitle:'\u062a\u062b\u0628\u064a\u062a \u062a\u0637\u0628\u064a\u0642 GoldBrix \u0644\u0623\u0646\u062f\u0631\u0648\u064a\u062f',andBody:'\u0627\u0636\u063a\u0637 \u0623\u062f\u0646\u0627\u0647 \u0644\u062a\u0646\u0632\u064a\u0644 APK \u0627\u0644\u0631\u0633\u0645\u064a',andOpen:'\u0627\u0641\u062a\u062d \u0627\u0644\u0645\u0644\u0641 \u0644\u0644\u062a\u062b\u0628\u064a\u062a.',andWarn:'\u26a0\ufe0f \u0627\u0633\u0645\u062d \u0628\u0627\u0644\u062a\u062b\u0628\u064a\u062a \u0645\u0646 \u0647\u0630\u0627 \u0627\u0644\u0645\u0635\u062f\u0631 \u0625\u0630\u0627 \u0637\u064f\u0644\u0628.',cert:'SHA \u0627\u0644\u0634\u0647\u0627\u062f\u0629: 34bf...7085 (\u062a\u062d\u0642\u0642: \u0627\u0644\u0625\u0639\u062f\u0627\u062f\u0627\u062a \u2190 \u0627\u0644\u062a\u0637\u0628\u064a\u0642\u0627\u062a \u2190 GoldBrix)',dlApk:'\ud83d\udce5 \u062a\u0646\u0632\u064a\u0644 APK',dlApkS:'\ud83d\udce5 \u062a\u0646\u0632\u064a\u0644 APK',dlStart:'\u0628\u062f\u0623 \u0627\u0644\u062a\u0646\u0632\u064a\u0644 \u2193',cancel:'\u0625\u0644\u063a\u0627\u0621',iosTitle:'\u0627\u0644\u062a\u062b\u0628\u064a\u062a \u0639\u0644\u0649 iOS',iosUse:'\u0627\u0633\u062a\u062e\u062f\u0645 <b>Safari</b>:',ios1:'\u0627\u0636\u063a\u0637 <b>\u0645\u0634\u0627\u0631\u0643\u0629</b> \u2b06\ufe0f (\u0623\u0633\u0641\u0644 Safari)',ios2:'\u0645\u0631\u0631 \u2190 <b>\u0625\u0636\u0627\u0641\u0629 \u0625\u0644\u0649 \u0627\u0644\u0634\u0627\u0634\u0629 \u0627\u0644\u0631\u0626\u064a\u0633\u064a\u0629</b>',ios3:'\u0627\u0636\u063a\u0637 <b>\u0625\u0636\u0627\u0641\u0629</b> (\u0623\u0639\u0644\u0649 \u0627\u0644\u064a\u0645\u064a\u0646)',iosSoon:'\u062a\u0637\u0628\u064a\u0642 iOS \u0627\u0644\u0623\u0635\u0644\u064a \u0642\u0627\u062f\u0645 \u0642\u0631\u064a\u0628\u0627\u064b.',gotIt:'\u0641\u0647\u0645\u062a',deskTitle:'\u062a\u062b\u0628\u064a\u062a GoldBrix',scan:'\u0627\u0645\u0633\u062d \u0628\u0627\u0644\u0647\u0627\u062a\u0641 \u0644\u062a\u0637\u0628\u064a\u0642 \u0623\u0646\u062f\u0631\u0648\u064a\u062f:',orX:'\u2014 \u0623\u0648 \u2014',shortcut:'\u062a\u062b\u0628\u064a\u062a \u0643\u0627\u062e\u062a\u0635\u0627\u0631 PWA',close:'\u0625\u063a\u0644\u0627\u0642',pwaDone:'PWA \u0645\u062b\u0628\u062a \u2713',cancelled:'\u0623\u064f\u0644\u063a\u064a',menuHint:'\u0642\u0627\u0626\u0645\u0629 \u0627\u0644\u0645\u062a\u0635\u0641\u062d \u2190 \u062a\u062b\u0628\u064a\u062a GoldBrix'}};
  function gbxPwaT(k){var l='en';try{l=(localStorage.getItem('gbx_lang')||localStorage.getItem('goldbrix_lang')||localStorage.getItem('gbx-lang')||(navigator.language||'en')).slice(0,2);}catch(e){}
    var d=GBX_PWA_I18N[l]||GBX_PWA_I18N.en;return d[k]||GBX_PWA_I18N.en[k]||k;}
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
      if (plat === 'native') { btn.style.opacity='0.5'; btn.disabled=true; lbl.textContent=gbxPwaT('native'); }
      else if (isStandalone()) { btn.style.opacity='0.5'; btn.disabled=true; lbl.textContent=gbxPwaT('pwaOk'); }
      else if (plat === 'android') lbl.textContent = gbxPwaT('dlAnd');
      else if (plat === 'ios') lbl.textContent = gbxPwaT('instIos');
      else lbl.textContent = gbxPwaT('instApp');
    }
    // Also update welcome banner button if exists
    var bannerBtn = document.getElementById('pwaInstallBtn');
    if (bannerBtn) {
      var plat2 = getPlatform();
      if (plat2 === 'android') bannerBtn.textContent = gbxPwaT('getApp');
      else if (plat2 === 'ios') bannerBtn.textContent = gbxPwaT('instS');
      else bannerBtn.textContent = gbxPwaT('instD');
    }
  }

  // === Smart install (stored under immutable name) ===
  window._gbxSmartInstall = function() {
    var plat = getPlatform();
    if (plat === 'native' || isStandalone()) { showToast(gbxPwaT('already')); return; }
    if (plat === 'android') return showAndroidModal();
    if (plat === 'ios') return showIOSModal();
    return showDesktopModal();
  };

  function showAndroidModal() {
    showModal({
      icon: '📦',
      title: gbxPwaT('andTitle'),
      body: '<p style="margin:12px 0;color:#ccc;line-height:1.5;font-size:14px;">'+gbxPwaT('andBody')+'' + (APK_SIZE ? ' (' + APK_SIZE + ')' : '') + '. '+gbxPwaT('andOpen')+'</p>' +
            '<p style="margin:12px 0;font-size:12px;color:#888;">'+gbxPwaT('andWarn')+'</p>' +
            '<p style="margin:6px 0;font-size:11px;color:#666;">'+gbxPwaT('cert')+'</p>',
      primary: { label: gbxPwaT('dlApk'), action: function() {
        window.location.href = APK_URL;
        closeModal();
        setTimeout(function() { showToast(gbxPwaT('dlStart')); }, 600);
      }},
      secondary: { label: gbxPwaT('cancel'), action: closeModal }
    });
  }

  function showIOSModal() {
    showModal({
      icon: '📱', title: gbxPwaT('iosTitle'),
      body: '<p style="margin:12px 0;color:#ccc;font-size:14px;">'+gbxPwaT('iosUse')+'</p>' +
            '<ol style="margin:12px 0;padding-left:22px;color:#ccc;line-height:1.9;font-size:13px;">' +
            '<li>'+gbxPwaT('ios1')+'</li>' +
            '<li>'+gbxPwaT('ios2')+'</li>' +
            '<li>'+gbxPwaT('ios3')+'</li></ol>' +
            '<p style="margin:14px 0;font-size:12px;color:#888;">'+gbxPwaT('iosSoon')+'</p>',
      primary: { label: gbxPwaT('gotIt'), action: closeModal }
    });
  }

  function showDesktopModal() {
    // A QR built by a third-party host puts the distribution path in someone
    // else's hands. The library is already in the client; it is loaded here on
    // demand, because this modal is the only place that needs it.
    setTimeout(function() {
      var box = document.getElementById('gbxApkQr');
      if (!box) return;
      var draw = function() {
        try { new QRCode(box, { text: APK_URL, width: 220, height: 220, colorDark: '#13100b', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M }); }
        catch (e) { box.style.display = 'none'; }
      };
      if (window.QRCode) return draw();
      var sc = document.createElement('script');
      sc.src = '/qrcode.min.js';
      sc.onload = draw;
      sc.onerror = function() { box.style.display = 'none'; };
      document.head.appendChild(sc);
    }, 0);
    showModal({
      icon: '💻', title: gbxPwaT('deskTitle'),
      body: '<div style="text-align:center;margin:14px 0;">' +
            '<p style="margin:0 0 12px;color:#ccc;font-size:14px;">'+gbxPwaT('scan')+'</p>' +
            '<div id="gbxApkQr" style="display:inline-block;background:#fff;padding:10px;border-radius:10px;"></div></div>' +
            '<p style="text-align:center;margin:10px 0;color:#888;font-size:12px;">'+gbxPwaT('orX')+'</p>' +
            '<p style="text-align:center;margin:8px 0;"><a href="' + APK_URL + '" download style="display:inline-block;background:#FFC107;color:#000;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;">'+gbxPwaT('dlApkS')+'</a></p>' +
            '<p style="text-align:center;margin:14px 0 4px;"><a href="#" onclick="window.pwaInstallDesktop();return false;" style="color:#FFC107;font-size:12px;text-decoration:underline;">'+gbxPwaT('shortcut')+'</a></p>',
      primary: { label: gbxPwaT('close'), action: closeModal }
    });
  }

  window.pwaInstallDesktop = function() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function(c) {
        deferredPrompt = null; closeModal();
        showToast(c.outcome === 'accepted' ? gbxPwaT('pwaDone') : gbxPwaT('cancelled'));
      });
    } else { showToast(gbxPwaT('menuHint')); }
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
  window.addEventListener('load', refreshApkInfo);

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

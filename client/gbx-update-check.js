// gbx-update-check.js v3 — Settings-driven update UX
// State exposed via window.__GBX_UPDATE_STATE__ + events
window.__GBX_BUILD_LOCAL__ = 103;
window.__GBX_VERSION_LOCAL__ = "1.0.103";
window.__GBX_DEBUG__ = false;

(function() {
  var VERSION_URL = 'https://goldbrix.app/version.json';
  var CHECK_DELAY_MS = 2000;
  var debugLog = [];

  window.__GBX_UPDATE_STATE__ = {
    checking: false, available: false, remote: null, error: null, lastCheck: 0
  };

  function log(msg) {
    var ts = new Date().toISOString().substr(11, 8);
    debugLog.push('[' + ts + '] ' + msg);
    if (debugLog.length > 10) debugLog.shift();
    console.log('[GBX]', msg);
    if (window.__GBX_DEBUG__) updateOverlay();
  }

  function updateOverlay() {
    var el = document.getElementById('gbx-debug-overlay');
    if (!el) return;
    el.innerHTML = '<div style="font-weight:700;margin-bottom:4px;color:#FFC107;">🔧 Debug · tap to close</div>' +
      debugLog.map(function(l) { return '<div>' + l + '</div>'; }).join('');
  }

  function createOverlay() {
    if (!window.__GBX_DEBUG__ || document.getElementById('gbx-debug-overlay')) return;
    var el = document.createElement('div');
    el.id = 'gbx-debug-overlay';
    el.style.cssText = 'position:fixed;bottom:90px;right:8px;z-index:99998;background:rgba(0,0,0,0.92);color:#0F0;padding:8px 10px;font-size:10px;font-family:monospace;border:1px solid #FFC107;border-radius:6px;max-width:260px;max-height:220px;overflow:auto;line-height:1.35;cursor:pointer;';
    el.onclick = function() { el.remove(); };
    (document.body || document.documentElement).appendChild(el);
    updateOverlay();
  }

  function isNative() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }

  async function fetchVersion() {
    var P = window.Capacitor && window.Capacitor.Plugins;
    if (P && P.CapacitorHttp) {
      try {
        var resp = await P.CapacitorHttp.get({
          url: VERSION_URL,
          headers: { 'Cache-Control': 'no-cache' },
          params: { t: String(Date.now()) }
        });
        log('← HTTP ' + resp.status);
        return resp.data;
      } catch (e) { log('✗ ' + (e.message||e).substr(0,40)); return null; }
    }
    try {
      var r = await fetch(VERSION_URL + '?t=' + Date.now(), { cache: 'no-store' });
      log('← Fetch ' + r.status);
      return r.ok ? await r.json() : null;
    } catch (e) { log('✗ ' + (e.message||e).substr(0,40)); return null; }
  }

  async function runCheck() {
    createOverlay();
    log('v3 build=' + window.__GBX_BUILD_LOCAL__);

    window.__GBX_UPDATE_STATE__.checking = true;
    window.__GBX_UPDATE_STATE__.error = null;
    window.dispatchEvent(new CustomEvent('gbx:update-check-start'));

    if (!isNative()) {
      log('Skip (web)');
      window.__GBX_UPDATE_STATE__.checking = false;
      window.dispatchEvent(new CustomEvent('gbx:update-check-end'));
      return;
    }
    log('Native ✓');

    var remote = await fetchVersion();
    window.__GBX_UPDATE_STATE__.checking = false;
    window.__GBX_UPDATE_STATE__.lastCheck = Date.now();

    if (!remote) {
      window.__GBX_UPDATE_STATE__.error = 'No data';
      window.dispatchEvent(new CustomEvent('gbx:update-check-end'));
      return;
    }

    var L = window.__GBX_BUILD_LOCAL__ || 0;
    var R = parseInt(remote.build) || 0;
    log('local=' + L + ' remote=' + R);

    window.__GBX_UPDATE_STATE__.remote = remote;
    window.__GBX_UPDATE_STATE__.available = R > L;

    if (R > L) window.dispatchEvent(new CustomEvent('gbx:update-available', { detail: remote }));
    window.dispatchEvent(new CustomEvent('gbx:update-check-end', {
      detail: { available: R > L, localBuild: L, remoteBuild: R, remoteVersion: remote.version }
    }));
  }

  window.gbxStartUpdate = function() {
    var remote = window.__GBX_UPDATE_STATE__.remote;
    if (!remote) return false;
    var url = remote.downloadUrl || 'https://goldbrix.app/downloads/android/latest.apk';
    var P = window.Capacitor && window.Capacitor.Plugins;
    if (P && P.Browser) P.Browser.open({ url: url });
    else window.open(url, '_system');
    return true;
  };

  window.gbxCheckForUpdates = runCheck;

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(runCheck, CHECK_DELAY_MS);
  } else {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(runCheck, CHECK_DELAY_MS); });
  }
})();

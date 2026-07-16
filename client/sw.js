/* GoldBrix SW v6 — HTML network-first (cod mereu proaspat), assets SWR, API network-only.
 * Fix 4 Iun 2026: stale-while-revalidate pe HTML servea cod vechi. */
const CACHE = 'gbx-shell-v81-20260716-ovl-route';

function isNetworkOnly(url) {
  // s29: /lp/ + lps.json + ORICE cross-origin = network-only. Quote/pret STALE din cache = interzis (LEGEA).
  return /\/(api|v2|launchpad|onramp|lp)\//.test(url)
      || /\/lps\.json/.test(url)
      || /\/version\.json/.test(url)
      || /\/downloads\//.test(url)
      || !url.startsWith(self.location.origin);
}
function isHTML(req, url) {
  return req.mode === 'navigate'
      || (req.headers.get('accept') || '').includes('text/html')
      || /\.html($|\?)/.test(url);
}

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (isNetworkOnly(url)) return;
  if (!url.startsWith('http')) return;

  // Capacitor/localhost: NU intercepta deloc - WebView serveste din bundle direct
  if (/^https?:\/\/localhost/.test(url) || /^capacitor:/.test(url) || /^https?:\/\/127\.0\.0\.1/.test(url)) {
    return; // lasa WebView-ul sa serveasca local din APK
  }

  // HTML -> NETWORK-FIRST (cod mereu proaspat; cache doar offline)
  if (isHTML(req, url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
        return res;
      } catch (e) {
        const cached = await cache.match(req);
        return cached || Response.error();
      }
    })());
    return;
  }

  // assets (JS/CSS/img) -> stale-while-revalidate
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // NETWORK-FIRST pe assets (cod mereu proaspat, nu stale)
    try {
      const fresh = await fetch(req, {cache: 'no-cache'});
      if (fresh && fresh.status === 200 && fresh.type === 'basic') { cache.put(req, fresh.clone()); return fresh; }
    } catch(e) {}
    const cached = await cache.match(req);
    const network = fetch(req, {cache: 'no-cache'}).then(res => {
      if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});

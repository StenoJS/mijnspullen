// Minimale service worker: maakt de app installeerbaar en cachet alleen de app-shell.
// API-verkeer wordt nooit gecachet (data moet altijd live en per gebruiker zijn).
const CACHE = 'mijn-spullen-shell-v13';
const SHELL = ['/', '/style.css', '/app.js', '/lib.js', '/nfc.js', '/qr.js', '/vendor/qrcode.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then((m) => m || caches.match('/'))));
});

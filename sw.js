// Opens instantly from the saved copy; refreshes the saved copy in the background.
// The app itself checks version.json and offers "New version — tap to reload".
const CACHE = 'portfolio-v2.0.0';
const SHELL = ['./', './index.html', './styles.css', './app.js', './calc.js', './db.js', './api.js', './ibkr.js', './xlsx.js', './history.js', './charts.js',
  './preact-htm.mjs', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('/version.json')) { e.respondWith(fetch(e.request, { cache: 'no-store' })); return; }
  const fresh = () => fetch(e.request, { cache: 'no-cache' }).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  });
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => {
    if (hit) { e.waitUntil(fresh().catch(() => {})); return hit; }
    return fresh().catch(() => caches.match('./index.html'));
  }));
});

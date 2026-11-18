// Lift Happens service worker.
// Network first (always checks for the newest files when online), cache as fallback (offline at the gym).
// Bump VERSION whenever any app file changes.
const PREFIX = 'lift-happens-beta-';
const VERSION = PREFIX + 'v1.2.2';
const FILES = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/db.js',
  './js/logic.js',
  './js/quotes.js',
  './js/vendor/preact-htm.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's HTTP cache, so old and new files never get mixed.
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Only remove this app's old caches; the regular app's caches are left alone.
    const old = keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION);
    await Promise.all(old.map((k) => caches.delete(k)));
    await self.clients.claim();
    // Open pages reload themselves on 'controllerchange' (see index.html).
  })());
});

function cacheKey(url) {
  const u = new URL(url);
  return u.origin + u.pathname;
}

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await Promise.race([fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }), timeout(NETWORK_TIMEOUT_MS)]);
      if (res && res.ok) cache.put(cacheKey(req.url), res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(cacheKey(req.url));
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await cache.match(cacheKey(new URL('./index.html', self.location).href));
        if (shell) return shell;
      }
      return Response.error();
    }
  })());
});

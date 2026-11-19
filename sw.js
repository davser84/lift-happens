// Lift Happens service worker.
// The app starts straight from the files saved on the phone (fast, also offline).
// Updates: the browser checks sw.js on every launch; a new VERSION downloads ALL files
// into a fresh cache in one go (never mixed), then the open page reloads once (see index.html).
// Bump VERSION whenever any app file changes.
// Cache names of the regular app all start with 'lift-happens-v' (the beta uses 'lift-happens-beta-').
const PREFIX = 'lift-happens-v';
const VERSION = PREFIX + '1.5.4';
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
  './icons/icon-512.png',
  './icons/face.png',
  './icons/face-wink.png'
];
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
    // Only remove this app's old caches; the beta's caches are left alone.
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    let hit = await cache.match(cacheKey(req.url));
    if (!hit && req.mode === 'navigate') {
      hit = (await cache.match(cacheKey(new URL('./', self.location).href)))
        || (await cache.match(cacheKey(new URL('./index.html', self.location).href)));
    }
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok) cache.put(cacheKey(req.url), res.clone());
      return res;
    } catch (err) {
      return Response.error();
    }
  })());
});

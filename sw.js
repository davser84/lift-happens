// Lift Happens service worker.
// The app starts straight from the files saved on the phone (fast, also offline).
// Updates: the browser checks sw.js on every launch; a new VERSION downloads ALL files
// into a fresh cache in one go, each with ?v=VERSION so none can be a stale copy (never mixed), then the open page reloads once (see index.html).
// Bump VERSION whenever any app file changes.
// Cache names of the regular app all start with 'lift-happens-v' (the beta uses 'lift-happens-beta-').
const PREFIX = 'lift-happens-v';
const VERSION = PREFIX + '1.12.0';
const FILES = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/db.js',
  './js/logic.js',
  './js/quotes.js',
  './js/exercise-icons.js',
  './js/vendor/preact-htm.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/face.png',
  './icons/face-wink.png',
  './icons/exercises/back-extension.png',
  './icons/exercises/cable-triceps-pushdown.png',
  './icons/exercises/chest-press.png',
  './icons/exercises/deadlift.png',
  './icons/exercises/decline-bench-press.png',
  './icons/exercises/decline-crunches.png',
  './icons/exercises/dips.png',
  './icons/exercises/dumbbell-biceps-curl.png',
  './icons/exercises/face-pull.png',
  './icons/exercises/lateral-raises.png',
  './icons/exercises/leg-curl.png',
  './icons/exercises/leg-press.png',
  './icons/exercises/lying-dumbbell-triceps-extension.png',
  './icons/exercises/machine-biceps-curl.png',
  './icons/exercises/pull-ups.png',
  './icons/exercises/rear-delt-fly.png',
  './icons/exercises/seated-cable-row.png',
  './icons/exercises/shoulder-press.png',
  './icons/exercises/squat.png',
  './icons/exercises/total-abdominal.png'
];
self.addEventListener('install', (event) => {
  // Every file is downloaded as e.g. "js/app.js?v=lift-happens-v1.5.7". GitHub's network has never
  // seen that address, so it must return the freshly published file, never a copy left over from
  // before the publish (that is how 1.5.6 could end up mixed with 1.5.5 files). cache: 'reload'
  // also skips the phone's own HTTP cache. Files are stored under their plain address.
  // If any download fails, the update is discarded and retried on the next launch.
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    try {
      await Promise.all(FILES.map(async (f) => {
        const url = new URL(f, self.location);
        const fresh = new URL(url.href);
        fresh.searchParams.set('v', VERSION);
        const res = await fetch(new Request(fresh.href, { cache: 'reload' }));
        if (!res.ok) throw new Error('Download failed: ' + f + ' (' + res.status + ')');
        await cache.put(cacheKey(url.href), res);
      }));
    } catch (err) {
      await caches.delete(VERSION);
      throw err;
    }
  })());
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

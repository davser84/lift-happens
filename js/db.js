// IndexedDB storage for Lift Happens. Everything stays on this device.

const DB_NAME = 'lift-happens';
const DB_VERSION = 1;
const STORES = ['exercises', 'plans', 'sessions', 'meta'];

let dbPromise = null;

// WebKit bug: on iPhone, indexedDB.open() can stall right after the app launches.
// Calling indexedDB.databases() until it answers wakes it up (same idea as "safari-14-idb-fix").
function idbReady() {
  const ua = navigator.userAgent || '';
  const isWebKit = /AppleWebKit\//.test(ua) && !/Chrom(e|ium)\//.test(ua);
  if (!isWebKit || !indexedDB.databases) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => { if (!finished) { finished = true; clearInterval(timer); resolve(); } };
    const poke = () => { try { indexedDB.databases().then(finish, finish); } catch (e) { finish(); } };
    const timer = setInterval(poke, 100);
    poke();
    setTimeout(finish, 3000);
  });
}

function openOnce(timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Storage did not answer in time')); } }, timeoutMs);
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      clearTimeout(timer);
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (settled) { db.close(); return; }
      settled = true;
      clearTimeout(timer);
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(req.error); } };
    req.onblocked = () => { /* another tab holds an old version; keep waiting until the timeout */ };
  });
}

async function openWithRetry() {
  await idbReady();
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await openOnce(2000 + attempt * 1000);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw lastErr;
}

function open() {
  if (!dbPromise) {
    dbPromise = openWithRetry().catch((e) => { dbPromise = null; throw e; });
  }
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export async function loadAll() {
  const db = await open();
  const tx = db.transaction(STORES, 'readonly');
  const read = (name) => new Promise((resolve, reject) => {
    const r = tx.objectStore(name).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
  const [exercises, plans, sessions, meta] = await Promise.all(STORES.map(read));
  const settingsRec = meta.find((m) => m.id === 'settings');
  return { exercises, plans, sessions, settings: settingsRec ? settingsRec.value : null };
}

export async function put(store, value) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return done(tx);
}

export async function putMany(store, values) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const v of values) os.put(v);
  return done(tx);
}

export async function remove(store, id) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(id);
  return done(tx);
}

export async function saveSettings(settings) {
  return put('meta', { id: 'settings', value: settings });
}

// Replaces all data in one transaction (used by Import).
export async function replaceAll(data) {
  const db = await open();
  const tx = db.transaction(STORES, 'readwrite');
  for (const name of STORES) tx.objectStore(name).clear();
  for (const e of data.exercises) tx.objectStore('exercises').put(e);
  for (const p of data.plans) tx.objectStore('plans').put(p);
  for (const s of data.sessions) tx.objectStore('sessions').put(s);
  tx.objectStore('meta').put({ id: 'settings', value: data.settings });
  return done(tx);
}

// Ask the browser to keep our data even when storage is low.
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (e) { /* not supported */ }
  return false;
}

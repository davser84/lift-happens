// IndexedDB storage for Lift Happens. Everything stays on this device.

const DB_NAME = 'lift-happens';
const DB_VERSION = 1;
const STORES = ['exercises', 'plans', 'sessions', 'meta'];

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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

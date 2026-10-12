// Tiny IndexedDB wrapper. Stores: lots (user data), kv (quotes, fx, settings, meta).
const DB_NAME = 'portfolio';
const DB_VERSION = 1;
let dbp;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('lots')) db.createObjectStore('lots', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const getLots = () => tx('lots', 'readonly', (s) => reqP(s.getAll()));
export const putLot = (lot) => tx('lots', 'readwrite', (s) => { s.put(lot); });
export const deleteLot = (id) => tx('lots', 'readwrite', (s) => { s.delete(id); });
export const replaceLots = (lots) => tx('lots', 'readwrite', (s) => { s.clear(); lots.forEach((l) => s.put(l)); });

export const kvGet = (key) => tx('kv', 'readonly', (s) => reqP(s.get(key)));
export const kvSet = (key, value) => tx('kv', 'readwrite', (s) => { s.put(value, key); });
export const kvDel = (key) => tx('kv', 'readwrite', (s) => { s.delete(key); });

// Ask the browser not to evict our data when storage runs low.
export async function persist() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch {}
  return false;
}

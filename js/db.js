// IndexedDB: "sessions" hält abgeschlossene Einheiten (nie überschrieben),
// "meta" hält Kleinkram — laufende Einheit, Einstellungen, Seed-Flag.

const DB_NAME = 'training';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Alle Einheiten, älteste zuerst. */
export async function getSessions() {
  const all = await run('sessions', 'readonly', (s) => s.getAll());
  const key = (x) => x.date + (x.finishedAt || '');
  return all.sort((a, b) => key(a).localeCompare(key(b)));
}

export const putSession = (session) => run('sessions', 'readwrite', (s) => s.put(session));
export const deleteSession = (id) => run('sessions', 'readwrite', (s) => s.delete(id));

export async function getMeta(key) {
  const row = await run('meta', 'readonly', (s) => s.get(key));
  return row ? row.value : undefined;
}
export const setMeta = (key, value) => run('meta', 'readwrite', (s) => s.put({ key, value }));
export const delMeta = (key) => run('meta', 'readwrite', (s) => s.delete(key));

/** Spielt die mitgelieferten Einheiten genau einmal ein — auch gelöschte kommen nicht wieder. */
export async function seedOnce(url) {
  if (await getMeta('seeded')) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Seed nicht ladbar: ${res.status}`);
  for (const s of await res.json()) await putSession(s);
  await setMeta('seeded', true);
}

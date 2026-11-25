// Claude's answers kept in this browser (IndexedDB), so that a document opened again is laid out,
// prepared and translated at once, without asking Claude again — even after the server has
// forgotten its own copies, which the hosted one does whenever it restarts.
//
// Answers sit on "shelves": one kind of answer for one document ({ key: answer }), read whole the
// first time it is wanted and written back a moment after anything is added. Without IndexedDB
// (a private window in some browsers, a page opened from disk) the shelves last as long as the page.

const DB_NAME = 'reader-answers';
const STORE = 'shelves';
const DAY = 864e5;
const KEEP = 90 * DAY; // a shelf not used for this long is let go

let dbPromise = null;
const shelves = new Map(); // id → Promise<Shelf>
const unsaved = new Set(); // shelves waiting to be written

// Leaving the page doesn't wait for the timer: write what is waiting now.
globalThis.addEventListener?.('pagehide', () => {
  for (const s of unsaved) { clearTimeout(s.timer); s.save(); }
});

function openDb() {
  return dbPromise ??= new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' }).createIndex('used', 'used');
    req.onsuccess = () => { prune(req.result); resolve(req.result); };
    req.onerror = () => resolve(null);
  });
}

function prune(db) {
  try {
    const old = IDBKeyRange.upperBound(Date.now() - KEEP);
    db.transaction(STORE, 'readwrite').objectStore(STORE).index('used').openCursor(old).onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
  } catch {}
}

const result = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

class Shelf {
  constructor(id, db, saved) {
    this.id = id;
    this.db = db;
    this.map = new Map(Object.entries(saved?.map || {}));
    this.fresh = new Map(); // added since the last save
    this.timer = 0;
    if (saved && Date.now() - saved.used > 7 * DAY) this.later(); // still in use: keep it
  }

  get(key) { return this.map.get(key); }

  set(key, value) {
    this.map.set(key, value);
    this.fresh.set(key, value);
    this.later();
  }

  later() {
    if (!this.db || this.timer) return;
    this.timer = setTimeout(() => this.save(), 400);
    unsaved.add(this);
  }

  save() {
    this.timer = 0;
    unsaved.delete(this);
    const fresh = this.fresh;
    this.fresh = new Map();
    try {
      const tx = this.db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      // Another tab may have saved to this shelf meanwhile: add to what is there rather than replace it.
      store.get(this.id).onsuccess = (e) => {
        const map = e.target.result?.map || Object.fromEntries(this.map);
        for (const [k, v] of fresh) map[k] = v;
        store.put({ id: this.id, used: Date.now(), map });
      };
      tx.onerror = () => console.warn('Could not keep Claude’s answers in this browser', tx.error);
    } catch (e) {
      console.warn('Could not keep Claude’s answers in this browser', e);
    }
  }
}

/** The shelf called `id`, with what was kept on it before. */
export function shelf(id) {
  let s = shelves.get(id);
  if (!s) {
    s = (async () => {
      const db = await openDb();
      let saved = null;
      if (db) try { saved = await result(db.transaction(STORE).objectStore(STORE).get(id)); } catch {}
      return new Shelf(id, db, saved);
    })();
    shelves.set(id, s);
  }
  return s;
}

// Sound from Azure's voices, a sentence at a time, in the Cache API rather than on a shelf:
// shelves are read whole, which suits short answers, not audio. The oldest go past SOUND_KEEP.
const SOUND = 'reader-sound-v1';
const SOUND_KEEP = 3000; // sentences: about 100 MB
let soundAdded = 0;

/** The audio kept under `key`, or else `make()`'s (then kept). `make` → ArrayBuffer */
export async function keptSound(key, make) {
  let cache = null;
  try { cache = await caches.open(SOUND); } catch {} // no Cache API (a page not on https or localhost)
  const name = new Request(`https://reader.invalid/sound/${key}`);
  const kept = await cache?.match(name).catch(() => null);
  if (kept) return kept.arrayBuffer();
  const bytes = await make();
  if (cache) {
    cache.put(name, new Response(bytes.slice(0), { headers: { 'Content-Type': 'audio/mpeg' } }))
      .then(() => { if (++soundAdded % 50 === 0) return trimSound(cache); })
      .catch(() => {});
  }
  return bytes;
}

async function trimSound(cache) {
  const keys = await cache.keys(); // oldest first
  await Promise.all(keys.slice(0, Math.max(0, keys.length - SOUND_KEEP)).map((k) => cache.delete(k)));
}

/** A short, stable name for a long string (106 bits: two 53-bit hashes). */
export function hashKey(str) {
  const h = (seed) => {
    let a = 0xdeadbeef ^ seed, b = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      a = Math.imul(a ^ c, 2654435761);
      b = Math.imul(b ^ c, 1597334677);
    }
    a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
    b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
    return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
  };
  return `${h(0)}.${h(1)}`;
}

/** A document's fingerprint: the SHA-256 of its bytes (or of its text), or null where the browser can't work one out. */
export async function fingerprint(payload) {
  try {
    const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

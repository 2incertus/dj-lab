// A Cabine: what lives on the phone (IndexedDB "cabine", version 1).
//
// Object stores:
//   tracks      key file: {file, meta, grid, bytes, carriedAt}        (light)
//   audio       key file: {file, mp3: ArrayBuffer, peaks: ArrayBuffer} (heavy)
//   hotcues     key file: {file, cues}
//   recordings  key id:   {id, blob, mime, createdAt, uploaded}
//
// The audio sits in its own store so listing the crate never pulls every
// carried MP3 into memory (a dozen tracks is a few hundred MB on a phone).
// getTrack() joins both and returns the full {file, meta, grid, peaks, mp3,
// bytes, carriedAt}.
//
// The MP3 is kept as an ArrayBuffer, never a Blob, and getTrack() hands out
// a fresh copy each call: Safari's decodeAudioData detaches its input.

export const DB_NAME = "cabine";
export const DB_VERSION = 1;
const STORES = { tracks: "file", audio: "file", hotcues: "file", recordings: "id" };

const done = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

const committed = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
});

const copy = (buf) => (buf instanceof ArrayBuffer ? buf.slice(0) : buf);

async function toArrayBuffer(x) {
  if (x instanceof ArrayBuffer) return x;
  if (ArrayBuffer.isView(x)) return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength);
  if (x && typeof x.arrayBuffer === "function") return x.arrayBuffer();
  throw new TypeError("expected an ArrayBuffer, a typed array or a Blob");
}

function openDb(idb) {
  const req = idb.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    for (const [name, keyPath] of Object.entries(STORES)) {
      if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
    }
  };
  return done(req);
}

export class Store {
  constructor(db, { storage = null, now = () => Date.now() } = {}) {
    this.db = db;
    this.storage = storage;
    this.now = now;
  }

  async _get(name, key) {
    const tx = this.db.transaction(name, "readonly");
    const v = await done(tx.objectStore(name).get(key));
    return v === undefined ? null : v;
  }

  async _all(name) {
    const tx = this.db.transaction(name, "readonly");
    return done(tx.objectStore(name).getAll());
  }

  async _put(name, value) {
    const tx = this.db.transaction(name, "readwrite");
    tx.objectStore(name).put(value);
    await committed(tx);
  }

  // ---- tracks ---------------------------------------------------------------

  async putTrack({ file, meta, grid = null, peaks, mp3 }) {
    if (!file) throw new TypeError("putTrack needs a file");
    const mp3Buf = await toArrayBuffer(mp3);
    const peaksBuf = await toArrayBuffer(peaks);
    const entry = {
      file,
      meta: meta || { file },
      grid: grid || null,
      bytes: mp3Buf.byteLength + peaksBuf.byteLength,
      carriedAt: this.now(),
    };
    const tx = this.db.transaction(["tracks", "audio"], "readwrite");
    tx.objectStore("audio").put({ file, mp3: mp3Buf, peaks: peaksBuf });
    tx.objectStore("tracks").put(entry);
    await committed(tx);
    return entry;
  }

  /** The light entry {file, meta, grid, bytes, carriedAt}, or null. */
  getEntry(file) { return this._get("tracks", file); }

  /** Everything carried for `file`, with fresh ArrayBuffers; null if not carried. */
  async getTrack(file) {
    const tx = this.db.transaction(["tracks", "audio"], "readonly");
    const [entry, audio] = await Promise.all([
      done(tx.objectStore("tracks").get(file)),
      done(tx.objectStore("audio").get(file)),
    ]);
    if (!entry || !audio) return null;
    return { ...entry, mp3: copy(audio.mp3), peaks: copy(audio.peaks) };
  }

  /** Light entries, newest carry first. */
  async listTracks() {
    const all = await this._all("tracks");
    return all.sort((a, b) => (b.carriedAt || 0) - (a.carriedAt || 0));
  }

  /** Replace a carried track's grid. False (and nothing written) if not carried. */
  async setGrid(file, grid) {
    const tx = this.db.transaction("tracks", "readwrite");
    const st = tx.objectStore("tracks");
    const entry = await done(st.get(file));
    if (!entry) { await committed(tx); return false; }
    st.put({ ...entry, grid: grid || null });
    await committed(tx);
    return true;
  }

  async removeTrack(file) {
    const tx = this.db.transaction(["tracks", "audio"], "readwrite");
    tx.objectStore("tracks").delete(file);
    tx.objectStore("audio").delete(file);
    await committed(tx);
  }

  async carriedBytes() {
    return (await this._all("tracks")).reduce((s, e) => s + (e.bytes || 0), 0);
  }

  // ---- hot cues -------------------------------------------------------------

  putHotCues(file, cues) { return this._put("hotcues", { file, cues }); }

  async getHotCues(file) {
    const v = await this._get("hotcues", file);
    return v ? v.cues : null;
  }

  // ---- recordings -------------------------------------------------------------

  putRecording({ id, blob, mime, createdAt, uploaded = false }) {
    return this._put("recordings", { id, blob, mime, createdAt, uploaded: !!uploaded });
  }

  async listRecordings() {
    return (await this._all("recordings")).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  async markUploaded(id) {
    const tx = this.db.transaction("recordings", "readwrite");
    const st = tx.objectStore("recordings");
    const r = await done(st.get(id));
    if (r) st.put({ ...r, uploaded: true });
    await committed(tx);
  }

  // ---- storage ------------------------------------------------------------------

  /** {usage, quota} from navigator.storage (nulls when unavailable). */
  async estimate() {
    if (!this.storage || typeof this.storage.estimate !== "function") return { usage: null, quota: null };
    try {
      const e = await this.storage.estimate();
      return { usage: e.usage ?? null, quota: e.quota ?? null };
    } catch (e) {
      return { usage: null, quota: null };
    }
  }

  /** Ask for persistent storage (once granted, no prompt again). */
  async persist() {
    const s = this.storage;
    if (!s || typeof s.persist !== "function") return false;
    try {
      if (typeof s.persisted === "function" && await s.persisted()) return true;
      return !!(await s.persist());
    } catch (e) {
      return false;
    }
  }
}

export async function openStore(opts = {}) {
  const idb = opts.indexedDB || globalThis.indexedDB;
  const storage = "storage" in opts ? opts.storage
    : (globalThis.navigator && globalThis.navigator.storage) || null;
  const db = await openDb(idb);
  return new Store(db, { storage, now: opts.now });
}

/** The loader's source interface (engine/loader.js) over the store: offline play. */
export function storeSource(store) {
  return {
    async getMp3(file) {
      const t = await store.getTrack(file);
      if (!t) throw new Error(`${file} is not on this phone`);
      return t.mp3;
    },
    async getGrid(file) {
      const e = await store.getEntry(file);
      return e ? e.grid : null;
    },
    async getMeta(file) {
      const e = await store.getEntry(file);
      return (e && e.meta) || { file };
    },
  };
}

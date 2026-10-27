// A tiny in-memory IndexedDB for node --test: enough of open / upgrade /
// transaction / objectStore (put, get, delete, getAll, getAllKeys, clear)
// to run store.js. Values are structured-cloned in and out, as the real
// thing does. Requests succeed on a later macrotask; a transaction
// completes once its last request has fired and no new one was queued.

class Req {
  constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; }
}

class FakeStore {
  constructor(tx, name, data, keyPath) {
    this.tx = tx; this.name = name; this.data = data; this.keyPath = keyPath;
  }
  _req(fn) {
    if (this.tx.done) throw new Error("TransactionInactiveError");
    if (this.tx.mode === "readonly" && fn.write) throw new Error("ReadOnlyError");
    const r = new Req();
    this.tx._queue(r, fn);
    return r;
  }
  put(value) {
    const fn = () => {
      const key = value[this.keyPath];
      if (key === undefined) throw new Error("DataError: no key");
      this.data.set(key, structuredClone(value));
      return key;
    };
    fn.write = true;
    return this._req(fn);
  }
  get(key) { return this._req(() => (this.data.has(key) ? structuredClone(this.data.get(key)) : undefined)); }
  delete(key) {
    const fn = () => { this.data.delete(key); return undefined; };
    fn.write = true;
    return this._req(fn);
  }
  clear() {
    const fn = () => { this.data.clear(); return undefined; };
    fn.write = true;
    return this._req(fn);
  }
  getAll() { return this._req(() => [...this.data.keys()].sort().map((k) => structuredClone(this.data.get(k)))); }
  getAllKeys() { return this._req(() => [...this.data.keys()].sort()); }
}

class FakeTx {
  constructor(db, names, mode) {
    this.db = db; this.names = names; this.mode = mode;
    this.pending = 0; this.done = false; this.oncomplete = null; this.onerror = null; this.onabort = null;
    this.error = null;
    setTimeout(() => this._maybeComplete(), 0);      // an empty transaction still completes
  }
  objectStore(name) {
    if (!this.names.includes(name)) throw new Error(`NotFoundError: ${name} not in this transaction`);
    const s = this.db._stores.get(name);
    return new FakeStore(this, name, s.data, s.keyPath);
  }
  _queue(r, fn) {
    this.pending++;
    setTimeout(() => {
      try {
        r.result = fn();
        if (r.onsuccess) r.onsuccess({ target: r });
      } catch (e) {
        r.error = e;
        this.error = e;
        if (r.onerror) r.onerror({ target: r });
        this.done = true;
        if (this.onerror) this.onerror({ target: this });
        if (this.onabort) this.onabort({ target: this });
        return;
      } finally {
        this.pending--;
      }
      setTimeout(() => this._maybeComplete(), 0);
    }, 0);
  }
  _maybeComplete() {
    if (this.done || this.pending > 0) return;
    this.done = true;
    if (this.oncomplete) this.oncomplete({ target: this });
  }
}

class FakeDb {
  constructor(name) {
    this.name = name; this.version = 0; this._stores = new Map();
  }
  get objectStoreNames() {
    const names = [...this._stores.keys()];
    return { contains: (n) => names.includes(n), length: names.length };
  }
  createObjectStore(name, opts = {}) {
    if (this._stores.has(name)) throw new Error(`ConstraintError: ${name} exists`);
    this._stores.set(name, { data: new Map(), keyPath: opts.keyPath });
    return {};
  }
  transaction(names, mode = "readonly") {
    const list = Array.isArray(names) ? names : [names];
    for (const n of list) if (!this._stores.has(n)) throw new Error(`NotFoundError: ${n}`);
    return new FakeTx(this, list, mode);
  }
  close() {}
}

export class FakeIDB {
  constructor() { this.dbs = new Map(); this.opens = []; }
  open(name, version) {
    const r = new Req();
    r.onupgradeneeded = null;
    this.opens.push([name, version]);
    setTimeout(() => {
      let db = this.dbs.get(name);
      if (!db) { db = new FakeDb(name); this.dbs.set(name, db); }
      if (version > db.version) {
        const old = db.version;
        db.version = version;
        r.result = db;
        if (r.onupgradeneeded) r.onupgradeneeded({ target: r, oldVersion: old, newVersion: version });
      }
      r.result = db;
      if (r.onsuccess) r.onsuccess({ target: r });
    }, 0);
    return r;
  }
}

/** navigator.storage stand-in. */
export function fakeStorage({ usage = 1234, quota = 999999, persisted = false, grant = true } = {}) {
  const s = {
    calls: [],
    async estimate() { s.calls.push("estimate"); return { usage, quota }; },
    async persisted() { s.calls.push("persisted"); return persisted; },
    async persist() { s.calls.push("persist"); persisted = grant; return grant; },
  };
  return s;
}

// A Cabine: the REC button's recorder (spec section 7).
//
// new Recorder(ctx, mixer.masterTap, store, opts)
//   start() -> ride id, stop() -> ride id, state ("inactive" | "recording"),
//   elapsed() seconds, flushed() (every chunk so far is in IndexedDB).
//
// Master only: it taps mixer.masterTap (after MASTER LEVEL and the clipper,
// before the split-cue fold), never the merged output, so the headphones'
// cue never enters a recording.
//
// Formats, from what MediaRecorder offers:
//   - WebM/Opus (Chromium, the Galaxy): one recording per ride, a chunk every
//     CHUNK_MS appended to IndexedDB as it comes (store.appendChunk), so a
//     crash loses at most the last 5 s. The server turns it into M4A.
//   - MP4/AAC only (Safari): the file is only sure to play once stopped, so
//     the ride is recorded in parts: the recorder is stopped and started again
//     every PART_S, each part its own recording "<ride>-<n>" uploaded as its
//     own export. A crash loses at most the current part. PART_S is a
//     constant because the iPhone measurement (does a stop-less MP4 play?) is
//     still to come; if it plays, parts can go.

export const CHUNK_MS = 5000;
export const PART_S = 300;
export const BITRATE = 160000;

/** {mime, parts} for this browser's MediaRecorder, or null. */
export function pickFormat(MR = globalThis.MediaRecorder) {
  if (!MR || typeof MR.isTypeSupported !== "function") return null;
  if (MR.isTypeSupported("audio/webm;codecs=opus")) return { mime: "audio/webm;codecs=opus", parts: false };
  if (MR.isTypeSupported("audio/mp4")) return { mime: "audio/mp4", parts: true };
  return null;
}

const randomId = () => {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
};

export class Recorder {
  constructor(ctx, masterTap, store, opts = {}) {
    this.ctx = ctx;
    this.tap = masterTap;
    this.store = store;
    this.MR = opts.MediaRecorder || globalThis.MediaRecorder;
    this.now = opts.now || (() => performance.now());
    this.newId = opts.newId || randomId;
    this.partS = opts.partS || PART_S;
    this.chunkMs = opts.chunkMs || CHUNK_MS;
    this.setTimer = opts.setTimer || ((fn, ms) => setInterval(fn, ms));
    this.clearTimer = opts.clearTimer || ((t) => clearInterval(t));
    this.onfinish = opts.onfinish || (() => {});
    this.dest = null;
    this.ride = null;
    this.format = null;
    this.part = null;              // {id, mr, t0, seq, stopped}
    this.partNo = 0;
    this.t0 = 0;
    this.timer = null;
    this._write = Promise.resolve();
    this._busy = null;
  }

  get state() { return this.ride ? "recording" : "inactive"; }

  /** Seconds since start (0 when idle). */
  elapsed() { return this.ride ? (this.now() - this.t0) / 1000 : 0; }

  /** Every chunk received so far is written. */
  flushed() { return this._write; }

  /** The ids of recordings being written now (store.finishStale leaves them). */
  liveIds() { return this.part ? new Set([this.part.id]) : new Set(); }

  start() {
    if (this._busy) return this._busy.then(() => this.ride);
    if (this.ride) return Promise.resolve(this.ride);
    this._busy = (async () => {
      const fmt = pickFormat(this.MR);
      if (!fmt) throw new Error("this browser cannot record audio");
      if (!this.dest) this.dest = this.ctx.createMediaStreamDestination();
      this.tap.connect(this.dest);
      this.format = fmt;
      this.ride = this.newId();
      this.partNo = 0;
      this.t0 = this.now();
      try {
        this.part = await this._startPart();
      } catch (e) {
        this.ride = null;
        try { this.tap.disconnect(this.dest); } catch (err) { /* already */ }
        throw e;
      }
      if (fmt.parts) this.timer = this.setTimer(() => this._nextPart(), this.partS * 1000);
      return this.ride;
    })();
    return this._busy.finally(() => { this._busy = null; });
  }

  async _startPart() {
    const parts = this.format.parts;
    const n = ++this.partNo;
    const id = parts ? `${this.ride}-${n}` : this.ride;
    await this.store.startRecording({ id, mime: this.format.mime, createdAt: Date.now(), ride: this.ride, part: parts ? n : 0 });
    const mr = new this.MR(this.dest.stream, { mimeType: this.format.mime, audioBitsPerSecond: BITRATE });
    const part = { id, mr, t0: this.now(), seq: 0, stopped: null };
    part.stopped = new Promise((resolve) => { mr.onstop = () => resolve(); });
    mr.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      const seq = part.seq++;
      this._write = this._write
        .then(() => this.store.appendChunk(id, seq, e.data))
        .catch((err) => console.warn("A Cabine: a recording chunk was not saved", err));
    };
    mr.start(this.chunkMs);
    return part;
  }

  async _endPart(part) {
    if (part.mr.state !== "inactive") part.mr.stop();
    await part.stopped;
    await this._write;
    await this.store.finishRecording(part.id, { durationS: (this.now() - part.t0) / 1000 });
    try { this.onfinish(part.id); } catch (e) { /* app hook */ }
  }

  /** Safari parts: the next part starts before the old one stops (no gap). */
  async _nextPart() {
    if (!this.ride || this._busy) return;
    const old = this.part;
    this._busy = (async () => {
      this.part = await this._startPart();
      await this._endPart(old);
    })();
    try { await this._busy; } finally { this._busy = null; }
  }

  /** Stop; resolves with the ride id once the last chunk is stored. */
  async stop() {
    if (this._busy) { try { await this._busy; } catch (e) { /* start failed */ } }
    if (!this.ride) return null;
    const ride = this.ride;
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    const part = this.part;
    this.part = null;
    await this._endPart(part);
    try { this.tap.disconnect(this.dest); } catch (e) { /* already */ }
    this.ride = null;
    return ride;
  }
}

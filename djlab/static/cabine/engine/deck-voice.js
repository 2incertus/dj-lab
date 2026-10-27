// A Cabine: the main-thread side of one deck's AudioWorklet player.
// Implements the voice interface the Deck drives (deck.js): load, unload,
// setRate, seek, setLoop, play, pause, position, onposition, underruns.

export const PROCESSOR_URL = "/static/cabine/engine/deck-processor.js";

const modules = new WeakMap();
/** How each context got its module: "direct" or "blob" (tests, the phone). */
export const workletLoads = new WeakMap();

/** addModule once per context. Offline, WebKit's addModule may bypass the
 *  service worker and fail; then the source is fetched as text (the service
 *  worker answers from its cache) and loaded from a blob: URL. The processor
 *  imports nothing, so a blob URL runs it as is. A failed registration is
 *  not kept, so the next tap tries again. */
export function registerDeckProcessor(ctx, url = PROCESSOR_URL, env = {}) {
  let p = modules.get(ctx);
  if (!p) {
    const fetchFn = env.fetch || ((...a) => globalThis.fetch(...a));
    const URLs = env.URL || globalThis.URL;
    p = (async () => {
      try {
        await ctx.audioWorklet.addModule(url);
        workletLoads.set(ctx, "direct");
        return;
      } catch (direct) {
        let src;
        try {
          const r = await fetchFn(url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          src = await r.text();
        } catch (e) {
          throw direct;
        }
        const blobUrl = URLs.createObjectURL(new Blob([src], { type: "text/javascript" }));
        try {
          await ctx.audioWorklet.addModule(blobUrl);
        } finally {
          try { URLs.revokeObjectURL(blobUrl); } catch (e) { /* fine */ }
        }
        workletLoads.set(ctx, "blob");
      }
    })();
    p.catch(() => { if (modules.get(ctx) === p) modules.delete(ctx); });
    modules.set(ctx, p);
  }
  return p;
}

export class DeckVoice {
  /** Register the worklet module (once) and build a voice. */
  static async create(ctx, opts = {}) {
    await registerDeckProcessor(ctx, opts.url);
    return new DeckVoice(ctx, opts);
  }

  /**
   * @param ctx   AudioContext or OfflineAudioContext with the module registered
   * @param opts  {detectUnderrun}: defaults to on for a realtime context;
   *              {testHooks}: sync() and stall() work only with this set (the
   *              proof page and e2e tests pass it; the app never does)
   */
  constructor(ctx, opts = {}) {
    const offline = typeof OfflineAudioContext !== "undefined" && ctx instanceof OfflineAudioContext;
    this.ctx = ctx;
    this.testHooks = !!opts.testHooks;
    this.node = new AudioWorkletNode(ctx, "cabine-deck", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        detectUnderrun: opts.detectUnderrun !== undefined ? !!opts.detectUnderrun : !offline,
        underrunMs: opts.underrunMs,
        testHooks: this.testHooks,
      },
    });
    this.duration = 0;
    this._sent = 0;
    this._pos = 0;
    this._t = 0;
    this._underruns = 0;
    this._posCbs = [];
    this._endCbs = [];
    this._underrunCbs = [];
    this._pings = new Map();
    this._pingId = 0;
    this.node.port.onmessage = (e) => this._onMessage(e.data);
  }

  connect(dest) { this.node.connect(dest); return dest; }

  disconnect() { this.node.disconnect(); }

  _post(msg, transfer) {
    this._sent++;
    this.node.port.postMessage(msg, transfer || []);
  }

  /** Hand the PCM to the worklet. The Int16Array buffers are transferred:
   *  they are detached (length 0) on this thread afterwards. */
  load({ left, right, sampleRate }) {
    this.duration = left.length / sampleRate;
    const transfer = [left.buffer];
    if (right && right.buffer !== left.buffer) transfer.push(right.buffer);
    this._pos = 0;
    this._post({ type: "load", left, right: right || left, sampleRate }, transfer);
  }

  /** Drop the track: the worklet gets an empty load and lets go of its PCM. */
  unload() {
    this.duration = 0;
    this._pos = 0;
    this._post({ type: "load", left: new Int16Array(0), right: new Int16Array(0), sampleRate: 0 });
  }

  setRate(r, immediate = false) { this._post({ type: "rate", value: r, immediate: !!immediate }); }

  seek(seconds, atTime) {
    this._pos = seconds;
    this._post({ type: "seek", s: seconds, at: atTime === undefined ? null : atTime });
  }

  /** Loop [startS, endS) now, or from audio-clock time atTime (exact frame). */
  setLoop(startS, endS, atTime) {
    this._post({ type: "loop", start: startS, end: endS, at: atTime === undefined ? null : atTime });
  }

  /** Start now, or at audio-clock time atTime (lands on that exact frame). */
  play(atTime) {
    this._post({ type: "run", on: true, at: atTime === undefined ? null : atTime });
  }

  pause() { this._post({ type: "run", on: false, at: null }); }

  /** Seconds, as last reported by the worklet (or last seek). */
  get position() { return this._pos; }

  /** Audio-clock time of the last report. */
  get positionTime() { return this._t; }

  get underruns() { return this._underruns; }

  onposition(cb) { this._posCbs.push(cb); }

  onended(cb) { this._endCbs.push(cb); }

  onunderrun(cb) { this._underrunCbs.push(cb); }

  /** Test hook: resolves once the worklet has handled every earlier message,
   *  with its playhead {s, t} at that moment. Rejects without testHooks. */
  sync() {
    if (!this.testHooks) return Promise.reject(new Error("DeckVoice.sync: test hooks are off"));
    const id = ++this._pingId;
    return new Promise((resolve) => {
      this._pings.set(id, resolve);
      this._post({ type: "ping", id });
    });
  }

  /** Test hook: block the render thread once for ms (no-op without testHooks). */
  stall(ms) { if (this.testHooks) this._post({ type: "stall", ms }); }

  _onMessage(d) {
    switch (d.type) {
      case "pos":
        // a report the worklet made before our latest command is stale
        if (d.seq !== this._sent || d.pending) return;
        this._pos = d.s;
        this._t = d.t;
        for (const cb of this._posCbs) cb(d.s, d.t);
        break;
      case "pong": {
        const r = this._pings.get(d.id);
        this._pings.delete(d.id);
        if (r) r({ s: d.s, t: d.t });
        break;
      }
      case "underrun":
        this._underruns++;
        for (const cb of this._underrunCbs) cb(this._underruns);
        break;
      case "ended":
        this._pos = d.s;
        for (const cb of this._endCbs) cb();
        break;
      default:
        break;
    }
  }
}

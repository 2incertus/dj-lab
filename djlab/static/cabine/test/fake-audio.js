// A minimal stand-in for a Web Audio context, for node --test: every node
// records its connections, every AudioParam its last value. No sound.

export class FakeParam {
  constructor(value = 0) { this.value = value; this.events = []; }
  setValueAtTime(v, t) { this.value = v; this.events.push(["set", v, t]); return this; }
  setTargetAtTime(v, t, tau) { this.value = v; this.events.push(["target", v, t, tau]); return this; }
  linearRampToValueAtTime(v, t) { this.value = v; this.events.push(["lin", v, t]); return this; }
  exponentialRampToValueAtTime(v, t) { this.value = v; this.events.push(["exp", v, t]); return this; }
  cancelScheduledValues() { return this; }
  cancelAndHoldAtTime() { return this; }
  connect() {}
}

const PARAMS = ["gain", "delayTime", "frequency", "Q", "detune", "offset", "playbackRate",
  "threshold", "knee", "ratio", "attack", "release", "pan"];

export class FakeNode {
  constructor(ctx, kind, opts = {}) {
    this.context = ctx;
    this.kind = kind;
    this.outputs = [];
    for (const p of PARAMS) this[p] = new FakeParam(p === "gain" ? 1 : 0);
    this.type = opts.type || null;
    this.channelCount = 2;
    this.channelCountMode = "max";
    this.channelInterpretation = "speakers";
    this.started = null;
    this.stopped = null;
    this.buffer = null;
    this.fftSize = 2048;
    Object.assign(this, opts);
    ctx.nodes.push(this);
  }
  connect(dest, out = 0, inp = 0) { this.outputs.push({ dest, out, inp }); return dest; }
  disconnect(dest) {
    this.outputs = dest === undefined ? [] : this.outputs.filter((o) => o.dest !== dest);
  }
  start(t = 0) { this.started = t; }
  stop(t = 0) { this.stopped = t; }
  getFloatTimeDomainData(a) { a.fill(this.level || 0); }
  connectedTo(dest) { return this.outputs.some((o) => o.dest === dest); }
}

export class FakeBuffer {
  constructor(ch, length, sampleRate) {
    this.numberOfChannels = ch;
    this.length = length;
    this.sampleRate = sampleRate;
    this._d = Array.from({ length: ch }, () => new Float32Array(length));
  }
  getChannelData(i) { return this._d[i]; }
  get duration() { return this.length / this.sampleRate; }
}

export class FakeContext {
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.nodes = [];
    this.destination = new FakeNode(this, "destination");
  }
  createGain() { return new FakeNode(this, "gain"); }
  createDelay(max = 1) { return new FakeNode(this, "delay", { maxDelayTime: max }); }
  createBiquadFilter() { return new FakeNode(this, "biquad", { type: "lowpass" }); }
  createConvolver() { return new FakeNode(this, "convolver", { normalize: true }); }
  createOscillator() { return new FakeNode(this, "oscillator", { type: "sine" }); }
  createBufferSource() { return new FakeNode(this, "source", { loop: false }); }
  createConstantSource() { return new FakeNode(this, "constant"); }
  createAnalyser() { return new FakeNode(this, "analyser"); }
  createChannelMerger(n = 6) { return new FakeNode(this, "merger", { numberOfInputs: n }); }
  createChannelSplitter(n = 6) { return new FakeNode(this, "splitter", { numberOfOutputs: n }); }
  createDynamicsCompressor() { return new FakeNode(this, "compressor"); }
  createWaveShaper() { return new FakeNode(this, "waveshaper", { curve: null, oversample: "none" }); }
  createBuffer(ch, length, sr) { return new FakeBuffer(ch, length, sr); }
  of(kind) { return this.nodes.filter((n) => n.kind === kind); }
}

/** A deck stand-in for Beat FX Roll: records roll() calls. */
export class FakeDeck {
  constructor(playing = true, grid = true) {
    this.state = { playing, loaded: true };
    this.grid = grid;
    this.rolls = [];
  }
  roll(b) { this.rolls.push(b); }
}

/** A deck voice stand-in (as in deck.test.js): records state, no sound. */
export class FakeVoice {
  constructor() { this.loop = [null, null]; this.running = false; this.seeks = []; this._cb = null; }
  load() { this.running = false; this.loop = [null, null]; }
  setRate(r) { this.rate = r; }
  seek(s, at) { this.seeks.push({ s, at }); }
  setLoop(a, b) { this.loop = [a, b]; }
  play() { this.running = true; }
  pause() { this.running = false; }
  onposition(cb) { this._cb = cb; }
  report(s, t) { this._cb && this._cb(s, t); }
}

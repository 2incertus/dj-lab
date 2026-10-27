// A Cabine: one deck's player, as an AudioWorklet ("cabine-deck").
//
// Holds the track as planar int16 PCM (half the memory of float32), plays it
// at any rate including negative (the jog scratches backwards), loops, and
// lands scheduled jumps on an exact sample of the audio clock. Output is
// cubic Hermite (Catmull-Rom) interpolated; rate changes ramp over 5 ms
// unless sent with immediate:true (scratching).
//
// Messages in:  {type:"load", left, right, sampleRate?} (buffers transferred;
//                empty arrays = unload: the PCM is dropped, nothing plays)
//               {type:"rate", value, immediate?}
//               {type:"seek", s, at?}        at = audio-clock time, null = now
//               {type:"loop", start, end, at?} seconds, null/null = off; at as seek
//               {type:"run", on, at?}        at = audio-clock time, null = now
//               {type:"ping", id}            test hook: answered with {type:"pong", id, s, t, seq}
//               {type:"stall", ms}           test hook: block the render thread once
// Test hooks run only for a node created with processorOptions.testHooks;
// otherwise ping and stall are ignored (the shipped app cannot stall it).
// Messages out: {type:"pos", s, t, seq, pending} every 32 render quanta
//               {type:"underrun", n}         render thread fell behind the wall clock
//               {type:"loaded", frames, seq}, {type:"ended", s}
//
// seq counts the messages processed so far; the main-thread voice drops
// position reports that predate its latest command. process() allocates
// nothing except the periodic message objects.

const POS_EVERY = 32;
const SMOOTH_S = 0.005;
const UNDERRUN_MS = 30;          // lag beyond the device's own burst that counts as a dropout
const CREEP_MS = 0.01;           // per quantum: lets the lag baseline absorb clock skew
const BURST_DECAY_MS = 0.02;     // per quantum: a learned burst size shrinks back slowly

class CabineDeckProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.detect = !!o.detectUnderrun;
    this.underrunMs = o.underrunMs > 0 ? o.underrunMs : UNDERRUN_MS;
    this.testHooks = !!o.testHooks;
    this.L = null;
    this.R = null;
    this.n = 0;
    this.srcRate = sampleRate;
    this.step = 1;                 // source frames per output frame at rate 1
    this.pos = 0;                  // playhead, source frames (fractional)
    this.rate = 1;
    this.target = 1;
    this.rampStep = 0;
    this.rampLeft = 0;
    this.running = false;
    this.loopStart = -1;           // source frames; loopEnd < 0 = no loop
    this.loopEnd = -1;
    this.pendLoopStart = -1;
    this.pendLoopEnd = -1;
    this.loopFrame = -1;           // absolute output frame of a pending loop change, -1 = none
    this.seekTo = 0;
    this.seekFrame = -1;           // absolute output frame of a pending jump, -1 = none
    this.runOn = false;
    this.runFrame = -1;            // absolute output frame of a pending start/stop, -1 = none
    this.seq = 0;
    this.quanta = 0;
    this.baseline = null;
    this.lastWall = -1;
    this.burstMs = 0;
    this.burstMax = 0;
    this.underruns = 0;
    this.stallMs = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(d) {
    this.seq++;
    switch (d.type) {
      case "load": {
        // an empty load (DeckVoice.unload) lets go of the track's PCM
        const empty = !d.left || d.left.length === 0;
        this.L = empty ? null : d.left;
        this.R = empty ? null : (d.right || d.left);
        this.n = empty ? 0 : Math.min(this.L.length, this.R.length);
        this.srcRate = d.sampleRate > 0 ? d.sampleRate : sampleRate;
        this.step = this.srcRate / sampleRate;
        this.pos = 0;
        this.running = false;
        this.loopStart = -1;
        this.loopEnd = -1;
        this.seekFrame = -1;
        this.runFrame = -1;
        this.loopFrame = -1;
        this.port.postMessage({ type: "loaded", frames: this.n, seq: this.seq });
        break;
      }
      case "rate": {
        const v = Number(d.value);
        if (!Number.isFinite(v)) break;
        if (d.immediate) {
          this.rate = this.target = v;
          this.rampLeft = 0;
        } else {
          this.target = v;
          this.rampLeft = Math.max(1, Math.round(SMOOTH_S * sampleRate));
          this.rampStep = (v - this.rate) / this.rampLeft;
        }
        break;
      }
      case "seek": {
        const f = Math.min(Math.max(Number(d.s) * this.srcRate, 0), this.n);
        if (!Number.isFinite(f)) break;
        if (d.at === null || d.at === undefined || d.at <= currentTime) {
          this.pos = f;
          this.seekFrame = -1;
        } else {
          this.seekTo = f;
          this.seekFrame = Math.round(d.at * sampleRate);
        }
        break;
      }
      case "loop": {
        let ls = -1, le = -1;
        if (!(d.start === null || d.end === null || !(d.end > d.start))) {
          ls = Math.max(0, d.start * this.srcRate);
          le = Math.min(d.end * this.srcRate, this.n);
          if (!(le > ls)) ls = le = -1;
        }
        if (d.at === null || d.at === undefined || d.at <= currentTime) {
          this.loopStart = ls;
          this.loopEnd = le;
          this.loopFrame = -1;                   // a later command wins over a pending one
        } else {
          this.pendLoopStart = ls;
          this.pendLoopEnd = le;
          this.loopFrame = Math.round(d.at * sampleRate);
        }
        break;
      }
      case "run": {
        const on = !!d.on && this.L !== null;
        if (d.at === null || d.at === undefined || d.at <= currentTime) {
          this.running = on;
          this.runFrame = -1;                    // a later command wins over a pending one
        } else {
          this.runOn = on;
          this.runFrame = Math.round(d.at * sampleRate);
        }
        break;
      }
      case "ping":
        if (!this.testHooks) break;
        this.port.postMessage({ type: "pong", id: d.id, s: this.pos / this.srcRate,
          t: currentTime, seq: this.seq });
        break;
      case "stall":
        if (this.testHooks) this.stallMs = Number(d.ms) || 0;
        break;
      default:
        break;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const oL = out[0];
    const oR = out.length > 1 ? out[1] : out[0];
    const frames = oL.length;
    const f0 = currentFrame;

    if (this.stallMs > 0) {                       // test hook only
      const until = Date.now() + this.stallMs;
      this.stallMs = 0;
      while (Date.now() < until) { /* block */ }
    }
    if (this.detect) this.watchClock(frames);

    const L = this.L;
    const R = this.R;
    const n = this.n;
    let pos = this.pos;
    let ended = false;
    for (let i = 0; i < frames; i++) {
      if (this.loopFrame >= 0 && f0 + i >= this.loopFrame) {
        this.loopStart = this.pendLoopStart;
        this.loopEnd = this.pendLoopEnd;
        this.loopFrame = -1;
      }
      if (this.seekFrame >= 0 && f0 + i >= this.seekFrame) {
        pos = this.seekTo;
        this.seekFrame = -1;
      }
      if (this.runFrame >= 0 && f0 + i >= this.runFrame) {   // same frame as a jump due now
        this.running = this.runOn;
        this.runFrame = -1;
      }
      if (!this.running) {
        oL[i] = 0;
        oR[i] = 0;
        continue;
      }
      if (this.rampLeft > 0) {
        this.rate += this.rampStep;
        if (--this.rampLeft === 0) this.rate = this.target;
      }
      // cubic Hermite (Catmull-Rom) at the fractional playhead
      const k = Math.floor(pos);
      const t = pos - k;
      let a0, a1, a2, a3, b0, b1, b2, b3;
      if (k >= 1 && k + 2 < n) {
        a0 = L[k - 1]; a1 = L[k]; a2 = L[k + 1]; a3 = L[k + 2];
        b0 = R[k - 1]; b1 = R[k]; b2 = R[k + 1]; b3 = R[k + 2];
      } else {
        a0 = k - 1 >= 0 && k - 1 < n ? L[k - 1] : 0;
        a1 = k >= 0 && k < n ? L[k] : 0;
        a2 = k + 1 >= 0 && k + 1 < n ? L[k + 1] : 0;
        a3 = k + 2 >= 0 && k + 2 < n ? L[k + 2] : 0;
        b0 = k - 1 >= 0 && k - 1 < n ? R[k - 1] : 0;
        b1 = k >= 0 && k < n ? R[k] : 0;
        b2 = k + 1 >= 0 && k + 1 < n ? R[k + 1] : 0;
        b3 = k + 2 >= 0 && k + 2 < n ? R[k + 2] : 0;
      }
      oL[i] = (((((a3 - a0) * 0.5 + (a1 - a2) * 1.5) * t
        + (a0 - 2.5 * a1 + 2 * a2 - 0.5 * a3)) * t
        + (a2 - a0) * 0.5) * t + a1) * (1 / 32768);
      oR[i] = (((((b3 - b0) * 0.5 + (b1 - b2) * 1.5) * t
        + (b0 - 2.5 * b1 + 2 * b2 - 0.5 * b3)) * t
        + (b2 - b0) * 0.5) * t + b1) * (1 / 32768);

      const prev = pos;
      pos += this.rate * this.step;
      const le = this.loopEnd;
      if (le > 0) {
        const ls = this.loopStart;
        const len = le - ls;
        if (pos >= le && prev < le && this.rate > 0) pos = ls + ((pos - le) % len);
        else if (pos < ls && prev >= ls && prev < le && this.rate < 0) pos = le - ((ls - pos) % len);
      }
      if (pos >= n) {
        pos = n;
        this.running = false;
        ended = true;
      } else if (pos < 0) {
        pos = 0;                                  // backwards past the start: hold there
      }
    }
    this.pos = pos;

    if (ended) this.port.postMessage({ type: "ended", s: pos / this.srcRate });
    if (++this.quanta >= POS_EVERY) {
      this.quanta = 0;
      this.port.postMessage({ type: "pos", s: pos / this.srcRate,
        t: (f0 + frames) / sampleRate, seq: this.seq, pending: this.seekFrame >= 0 || this.runFrame >= 0 || this.loopFrame >= 0 });
    }
    return true;
  }

  /** The render thread fell behind if the wall clock ran ahead of the audio
   *  clock by more than the device's buffering explains. Devices pull audio
   *  in bursts (headless Chromium: 16 quanta every ~43 ms; an iPhone: 1 to 8
   *  quanta), so the lag (wall - audio) is a sawtooth as tall as one burst.
   *  The burst size is learned as it happens (quanta whose wake-ups are less
   *  than half a quantum apart belong to one burst) because it changes with
   *  the device and the output route. The baseline is the smallest lag seen,
   *  creeping up slowly to absorb clock skew. A lag more than one burst plus
   *  underrunMs above it is a dropout. Only counted while playing. */
  watchClock(frames) {
    const wall = Date.now();
    const quantumMs = (frames * 1000) / sampleRate;
    this.burstMs = this.lastWall >= 0 && wall - this.lastWall < quantumMs / 2
      ? this.burstMs + quantumMs : quantumMs;
    this.lastWall = wall;
    this.burstMax = Math.max(this.burstMs, this.burstMax - BURST_DECAY_MS);
    const drift = wall - currentTime * 1000;
    if (this.baseline === null || drift < this.baseline) {
      this.baseline = drift;
    } else if (drift - this.baseline > this.burstMax + this.underrunMs) {
      if (this.running) {
        this.underruns++;
        this.port.postMessage({ type: "underrun", n: this.underruns });
      }
      this.baseline = drift;
    } else {
      this.baseline += Math.min(CREEP_MS, drift - this.baseline);
    }
  }
}

registerProcessor("cabine-deck", CabineDeckProcessor);

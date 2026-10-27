// A Cabine: the SAMPLER pad mode. rekordbox's factory bank is not ours to
// ship, so the eight slots are synthesized one-shots (spec: the mesa's own
// drums and synth stabs). The drum voices are modelled on escola.js DRUMS
// (kick, closed hat, open hat, rim) and copied here; escola.js is untouched.
// Clap, crash noise, sub drop and synth stab are new, in the same style.
//
// Manual (DDJ-FLX4 Instruction Manual, "Using Sampler", pp. 61-62):
// - a pad plays its slot; pressed again during playback it "plays from the
//   beginning again" (retrigger: the earlier hit is cut);
// - SHIFT + pad during playback stops that slot (stop(i));
// - deck 2's pads are slots 9-16 in rekordbox. A Cabine has eight sounds,
//   so both decks' pads play slots 1-8 (changed from rekordbox, flagged).
// Output goes to the master (Mixer.samplerInput), not a channel [spec].

export const SAMPLER_PADS = ["kick", "clap", "open hat", "closed hat", "rim",
  "crash noise", "sub drop", "synth stab"];
/** Board actions on the Sampler (Task 9's control map resolves these). */
export const SAMPLER_ACTIONS = ["trigger", "stop", "setGain"];
export const SAMPLER_DEFAULT_GAIN = 0.85;            // knob 0..1, gain = k^2
const FLOOR = 0.0012;
const CUT_TAU_S = 0.004;

// ---- voices (t: start time, vel: 0..1, out: destination, v: voice record) ----

function noiseHit(v, t, vel, out, { type, freq, Q = 1, dec, atk = 0 }) {
  const ctx = v.ctx;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = Q;
  const g = ctx.createGain();
  if (atk > 0) {
    g.gain.setValueAtTime(FLOOR, t);
    g.gain.linearRampToValueAtTime(vel, t + atk);
  } else g.gain.setValueAtTime(vel, t);
  g.gain.exponentialRampToValueAtTime(FLOOR, t + atk + dec);
  const s = ctx.createBufferSource();
  s.buffer = v.noise;
  s.loop = true;
  s.connect(f).connect(g).connect(out);
  s.start(t);
  s.stop(t + atk + dec + 0.05);
  v.sources.push(s);
}

function tone(v, t, out, { type = "sine", freq, to = null, glide = 0, peak, dec }) {
  const ctx = v.ctx;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to !== null) o.frequency.exponentialRampToValueAtTime(to, t + glide);
  g.gain.setValueAtTime(peak, t);
  g.gain.exponentialRampToValueAtTime(FLOOR, t + dec);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dec + 0.02);
  v.sources.push(o);
  return o;
}

export const VOICES = [
  // kick (escola DRUMS.kick)
  (v, t, vel, out) => {
    tone(v, t, out, { freq: 150, to: 44, glide: 0.09, peak: vel, dec: 0.30 });
    noiseHit(v, t, vel * 0.4, out, { type: "highpass", freq: 3000, dec: 0.018 });
  },
  // clap: three quick bursts and a short room
  (v, t, vel, out) => {
    for (let i = 0; i < 3; i++) {
      noiseHit(v, t + i * 0.011, vel * 0.7, out, { type: "bandpass", freq: 1200, Q: 1.2, dec: 0.012 });
    }
    noiseHit(v, t + 0.033, vel * 0.55, out, { type: "bandpass", freq: 1100, Q: 1.0, dec: 0.14 });
  },
  // open hat (escola DRUMS.ohat)
  (v, t, vel, out) => noiseHit(v, t, vel * 0.4, out, { type: "highpass", freq: 6200, dec: 0.26 }),
  // closed hat (escola DRUMS.hat)
  (v, t, vel, out) => noiseHit(v, t, vel * 0.5, out, { type: "highpass", freq: 7500, dec: 0.045 }),
  // rim (escola DRUMS.rim)
  (v, t, vel, out) => noiseHit(v, t, vel * 0.8, out, { type: "bandpass", freq: 1900, Q: 8, dec: 0.07 }),
  // crash noise: a long bright wash
  (v, t, vel, out) => {
    noiseHit(v, t, vel * 0.45, out, { type: "highpass", freq: 4000, Q: 0.7, dec: 1.6 });
    noiseHit(v, t, vel * 0.25, out, { type: "bandpass", freq: 9000, Q: 0.8, dec: 0.9, atk: 0.004 });
  },
  // sub drop: a sine falling an octave and a half
  (v, t, vel, out) => tone(v, t, out, { freq: 90, to: 32, glide: 1.2, peak: vel * 0.9, dec: 1.4 }),
  // synth stab: a detuned saw minor chord through a closing low-pass
  (v, t, vel, out) => {
    const ctx = v.ctx;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.Q.value = 4;
    f.frequency.setValueAtTime(4000, t);
    f.frequency.exponentialRampToValueAtTime(400, t + 0.25);
    f.connect(out);
    for (const hz of [220, 261.63, 329.63]) {
      for (const det of [-7, 7]) {
        const o = tone(v, t, f, { type: "sawtooth", freq: hz, peak: vel * 0.09, dec: 0.35 });
        o.detune.value = det;
      }
    }
  },
];

export class Sampler {
  /** @param out  where the sampler plays (Mixer.samplerInput: the master) */
  constructor(ctx, out) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.gain.value = SAMPLER_DEFAULT_GAIN ** 2;
    if (out) this.output.connect(out);
    this._noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this._noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this._playing = new Array(SAMPLER_PADS.length).fill(null);
  }

  /** Pad i (0..7): play the slot from the beginning (cuts its last hit). */
  trigger(i, vel = 1) {
    if (!(i >= 0 && i < VOICES.length)) return null;
    this.stop(i);
    const t = this.ctx.currentTime;
    const out = this.ctx.createGain();
    out.gain.value = 1;
    out.connect(this.output);
    const v = { ctx: this.ctx, noise: this._noise, sources: [], out };
    VOICES[i](v, t, vel, out);
    this._playing[i] = v;
    return v;
  }

  /** SHIFT + pad: stop slot i. */
  stop(i) {
    const v = this._playing[i];
    if (!v) return;
    this._playing[i] = null;
    const t = this.ctx.currentTime;
    v.out.gain.cancelScheduledValues(t);
    v.out.gain.setTargetAtTime(0, t, CUT_TAU_S);
    for (const s of v.sources) {
      try { s.stop(t + 0.03); } catch (e) { /* already stopped */ }
    }
  }

  /** Sampler GAIN (rekordbox panel) 0..1. */
  setGain(k) {
    const g = Math.min(1, Math.max(0, Number(k) || 0)) ** 2;
    const t = this.ctx.currentTime;
    this.output.gain.cancelScheduledValues(t);
    this.output.gain.setTargetAtTime(g, t, CUT_TAU_S);
  }
}

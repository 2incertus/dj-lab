// A Cabine: the FLX4 mixer section as rekordbox runs it (the FLX4 has no
// mixer of its own; rekordbox mixes in software), in Web Audio.
//
// Manual check (Task 7, step 1), done 2026-10-27 against:
//   [M]  Pioneer DJ "DDJ-FLX4 Instruction Manual" (EN PDF), "Part names and
//        functions > Mixer section, Using rekordbox" (pp. 25-28), "Playing a
//        track" / "Monitoring with headphones" (pp. 51-53), "Changing the
//        settings > [Controller] > [Mixer] tab" (pp. 77-80).
//   [R]  rekordbox 7.2.18 Instruction Manual (EN PDF): "Mixer panel" (p. 146),
//        "Using the mixer function" (p. 173), "Preferences > Controller >
//        Mixer" (p. 242).
//   [X]  Mixxx DDJ-FLX4 mapping (read only, GPL, nothing copied).
//   [S]  the approved spec, section 5, where [M] and [R] are silent.
//   [B]  builder's choice: no source gives the number. Kept as named
//        constants so they can be corrected after a session on the hardware.
//
// | Control           | Implemented                                                | Source |
// |-------------------|------------------------------------------------------------|--------|
// | TRIM              | Channel gain before EQ. Fully CCW = silent (the manual's   | M, B   |
// |                   | setup starts there and raises TRIM against the meter).     |        |
// |                   | 12 o'clock = 0 dB, fully CW = +9 dB (TRIM_MAX_DB, the DJM  |        |
// |                   | range rekordbox's mixer models). Below center the gain is  |        |
// |                   | (2k)^3 (-18 dB at a quarter turn).                         |        |
// | EQ HI / MID / LOW | "Boost or reduce the relevant frequency" [M]. rekordbox    | M,R,S,B|
// |                   | offers EQ or ISOLATOR mode [R]; the spec asks for a full   |        |
// |                   | kill at minimum, which is ISOLATOR: -inf .. 0 dB (center)  |        |
// |                   | .. +6 dB (EQ_MAX_DB, the DJM boost both modes share).      |        |
// |                   | Below center gain = (2k)^2 (-12 dB at a quarter turn).      |        |
// |                   | Three-band Linkwitz-Riley (24 dB/oct) isolator crossing at |        |
// |                   | 250 Hz and 2.5 kHz [B]; flat (allpass) with all at center. |        |
// | CFX               | Sound Color FX "FILTER" (Smart CFX off, rekordbox default  | M, S, B|
// |                   | type per the spec). Center: unchanged [M]. CCW: low-pass   |        |
// |                   | cutoff falls (20 kHz -> 80 Hz), CW: high-pass cutoff rises |        |
// |                   | (20 Hz -> 10 kHz) [M, Serato section states the directions;|        |
// |                   | rekordbox's section only says center is unchanged].        |        |
// |                   | Off within +-0.02 of center; resonance ramps from 0.707 to |        |
// |                   | 2.0 over the first 15 % of travel [B].                     |        |
// | Headphones CUE    | Channel sound to the headphones, pre-fader; both may be on.| M      |
// | Channel level     | "the volume ... BEFORE it passes through the channel        | M, R   |
// | indicators        | faders" [M p.26, R p.146]: level() is pre-fader (post trim,|        |
// |                   | EQ and CFX). The Level Meter setting defaults to Channel   |        |
// |                   | Level [M p.78].                                            |        |
// | Channel fader     | Gain = f^2 [B] (the manual names a Channel Fader Curve     | M, B   |
// |                   | preference but not its default).                            |        |
// | Crossfader        | "balance ... depending on the crossfader curve setting"    | M, B   |
// |                   | [M]; the default curve is not named in either manual. Here |        |
// |                   | a constant-power curve (both -3 dB at center), with Cut    |        |
// |                   | Lag at both edges: rekordbox default 1.0 mm [M p.78] =     |        |
// |                   | CF_CUT_LAG 0.022 of travel, assuming ~45 mm travel [B].    |        |
// | MASTER LEVEL      | Master output level, gain = k^2. masterTap sits right      | M, B   |
// |                   | after it (the recorder and the right ear).                 |        |
// | MASTER CUE        | "Plays the master sound through your headphones" [M]:      | M      |
// |                   | master joins the cue bus.                                  |        |
// | HEADPHONES MIX    | Balance between the CUE'd channels and the master [M].     | M, B   |
// |                   | Constant power: full CCW cue only, full CW master only.    |        |
// | HEADPHONES LEVEL  | Headphones level, gain = k^2; full CCW silent [M p.53].    | M, B   |
// | Split cue         | One stereo out: left = mono(headphones), right =           | S      |
// |                   | mono(master). Recorder taps the master, never the cue.     |        |
//
// | Output Level      | rekordbox Preferences > Mixer > [Output Level] (internal   | R, B   |
// | (headroom)        | mixer: -21 .. -3 dB / NONE) "Adjust the output level of    |        |
// |                   | decks ... If the level is too high, clipping is likely ... |        |
// |                   | Clipping will enable the limiter" [R p.242]. No default is |        |
// |                   | stated: OUTPUT_LEVEL_DB = -6 dB on each deck before TRIM.  |        |
// | Peak limiter      | FLX4 [Master output] > [Peak Limiter] [M p.80] and the      | M, R, B|
// |                   | limiter above: a zero-latency soft clipper (WaveShaper,    |        |
// |                   | transparent to CLIP_KNEE 0.7 = -3.1 dBFS, tanh above, held |        |
// |                   | under CLIP_CEILING 0.99) after MASTER LEVEL (so masterTap and the     |        |
// |                   | right ear never pass 1.0) and after HEADPHONES LEVEL (left |        |
// |                   | ear). No look-ahead, so the split cue stays sample-aligned.|        |
//
// Changed from spec:
// - Channel level meters: the spec says post-fader; the manual and the
//   rekordbox mixer panel both say before the channel fader. level() is
//   pre-fader.
// Not modelled (flagged): a look-ahead limiter (a DynamicsCompressor adds
// ~6 ms of look-ahead, which would skew the split cue; the soft clipper
// stands in for it), Fader Start (SHIFT + fader), Smart Fader, Smart CFX,
// crossfader REVERSE, mic.
//
// Graph per channel:
//   input(OUTPUT_LEVEL) -> TRIM -> isolator(LOW | MID | HIGH) -> CFX biquad -> post (meter, CUE send)
//   post -> fader -> crossfader -> FX insert (channel) -> bus
// Master: bus -> FX insert ("master" = the FLX4 lever's 1&2, see fx.js) -> masterSum
//   (+ sampler) -> MASTER LEVEL -> clipper -> masterTap -> mono -> merger input 1 (right)
// Phones: (CUE'd channels + MASTER CUE) * mixCue + masterSum * mixMaster
//   -> HEADPHONES LEVEL -> clipper -> mono -> merger input 0 (left)
//
// Pure math at the top imports into Node (no Web Audio at import time).

export const OUTPUT_LEVEL_DB = -6;
export const CLIP_KNEE = 0.7;
export const CLIP_CEILING = 0.99;              // -0.09 dBFS: stays under 1.0 in float32 too
export const CLIP_RANGE = 16;                  // the clipper's curve covers +-16 (+24 dBFS)
export const CLIP_CURVE_POINTS = 16385;
export const TRIM_MAX_DB = 9;
export const EQ_MAX_DB = 6;
export const EQ_BANDS = ["hi", "mid", "low"];
export const EQ_CROSSOVER_LOW_HZ = 250;
export const EQ_CROSSOVER_HIGH_HZ = 2500;
export const CFX_DEAD_ZONE = 0.02;
export const CFX_LP_MIN_HZ = 80;
export const CFX_LP_MAX_HZ = 20000;
export const CFX_HP_MIN_HZ = 20;
export const CFX_HP_MAX_HZ = 10000;
export const CFX_Q_MAX = 2.0;
export const CFX_Q_RAMP = 0.15;
export const CF_CUT_LAG = 0.022;
export const SMOOTH_TAU_S = 0.005;
export const DEFAULTS = Object.freeze({
  trim: 0.5, eq: 0.5, cfx: 0.5, fader: 1, cue: false,
  crossfader: 0.5, masterLevel: 1, masterCue: false, phonesMix: 0.5, phonesLevel: 0.8,
});

/** Board actions on the Mixer (Task 9's control map resolves these). The
 *  per-channel ones take the channel first: setTrim(ch, k). */
export const MIXER_ACTIONS = [
  "setTrim", "setEq", "setCfx", "setFader", "setCue", "level",
  "setCrossfader", "setMasterLevel", "setMasterCue", "setPhonesMix", "setPhonesLevel",
];
/** The same controls on a channel strip object: mixer.channel(i).setTrim(k). */
export const CHANNEL_ACTIONS = ["setTrim", "setEq", "setCfx", "setFader", "setCue", "level"];

const clamp01 = (x) => Math.min(1, Math.max(0, Number(x) || 0));
const SQRT1_2 = Math.SQRT1_2;

export function dbToGain(dB) {
  return dB === -Infinity ? 0 : 10 ** (dB / 20);
}

/** TRIM knob 0..1 -> linear gain: 0 silent, 0.5 unity, 1 +TRIM_MAX_DB. */
export function trimGain(k01) {
  const k = clamp01(k01);
  if (k <= 0) return 0;
  if (k < 0.5) return (2 * k) ** 3;
  return dbToGain((k - 0.5) * 2 * TRIM_MAX_DB);
}

/** EQ knob 0..1 -> dB: -Infinity (kill) at 0, 0 at 0.5, +EQ_MAX_DB at 1. */
export function eqGainDb(k01) {
  const k = Number(k01);
  if (!(k > 0)) return -Infinity;
  if (k < 0.5) return 40 * Math.log10(2 * k);
  return (Math.min(k, 1) - 0.5) * 2 * EQ_MAX_DB;
}

/** CFX knob 0..1 -> filter: off near center, low-pass left, high-pass right.
 *  q is linear (BiquadFilterNode wants dB for these types: 20*log10(q)). */
export function cfxFilter(k01) {
  const d = clamp01(k01) - 0.5;
  if (Math.abs(d) <= CFX_DEAD_ZONE + 1e-9) return { type: "off", freq: null, q: null };
  const u = (Math.abs(d) - CFX_DEAD_ZONE) / (0.5 - CFX_DEAD_ZONE);
  const q = SQRT1_2 + (CFX_Q_MAX - SQRT1_2) * Math.min(1, u / CFX_Q_RAMP);
  if (d < 0) return { type: "lowpass", freq: CFX_LP_MAX_HZ * (CFX_LP_MIN_HZ / CFX_LP_MAX_HZ) ** u, q };
  return { type: "highpass", freq: CFX_HP_MIN_HZ * (CFX_HP_MAX_HZ / CFX_HP_MIN_HZ) ** u, q };
}

/** Crossfader 0 (left, channel 1) .. 1 (right, channel 2) -> [gain1, gain2]. */
export function crossfaderGains(x01) {
  const x = clamp01(x01);
  if (x <= CF_CUT_LAG) return [1, 0];
  if (x >= 1 - CF_CUT_LAG) return [0, 1];
  const u = (x - CF_CUT_LAG) / (1 - 2 * CF_CUT_LAG);
  return [Math.cos((u * Math.PI) / 2), Math.sin((u * Math.PI) / 2)];
}

/** Channel fader 0 (bottom) .. 1 (top) -> gain. */
export function faderGain(f01) {
  return clamp01(f01) ** 2;
}

/** MASTER LEVEL and HEADPHONES LEVEL knobs -> gain (full CCW silent). */
export function levelGain(k01) {
  return clamp01(k01) ** 2;
}

/** HEADPHONES MIX 0 (cue) .. 1 (master) -> [cueGain, masterGain]. */
export function phonesMixGains(k01) {
  const k = clamp01(k01);
  if (k <= 0) return [1, 0];
  if (k >= 1) return [0, 1];
  return [Math.cos((k * Math.PI) / 2), Math.sin((k * Math.PI) / 2)];
}

/** The clipper: identity up to CLIP_KNEE, then a tanh knee (slope 1 at the
 *  knee) that approaches CLIP_CEILING. Odd and monotonic. */
export function softClip(x) {
  const a = Math.abs(x);
  if (a <= CLIP_KNEE) return x;
  const h = CLIP_CEILING - CLIP_KNEE;
  const y = CLIP_KNEE + h * Math.tanh((a - CLIP_KNEE) / h);
  return x < 0 ? -y : y;
}

/** WaveShaper curve: point i maps input CLIP_RANGE * (2i / (n - 1) - 1)
 *  (the shaper's input is scaled by 1 / CLIP_RANGE first). Linear
 *  interpolation reproduces the identity part exactly. */
export function softClipCurve(n = CLIP_CURVE_POINTS) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = softClip(CLIP_RANGE * ((2 * i) / (n - 1) - 1));
  return c;
}

/** Linear peak -> dBFS (for meters). */
export function levelDb(lin) {
  return lin > 0 ? 20 * Math.log10(lin) : -Infinity;
}

// ---- Web Audio -------------------------------------------------------------------

function setSmooth(ctx, param, v) {
  const t = ctx.currentTime;
  param.cancelScheduledValues(t);
  param.setTargetAtTime(v, t, SMOOTH_TAU_S);
}

function gainNode(ctx, value = 1, channels = 2) {
  const g = ctx.createGain();
  g.gain.value = value;
  g.channelCount = channels;
  g.channelCountMode = "explicit";
  g.channelInterpretation = "speakers";
  return g;
}

function biquad(ctx, type, freq, q) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

const LR_Q_DB = 20 * Math.log10(SQRT1_2);       // Butterworth section, in the dB units LP/HP use

/** Two Butterworth sections = a Linkwitz-Riley 24 dB/oct filter. */
function lr4(ctx, type, freq, from) {
  const a = biquad(ctx, type, freq, LR_Q_DB);
  const b = biquad(ctx, type, freq, LR_Q_DB);
  from.connect(a).connect(b);
  return b;
}

/** pre-scale + WaveShaper: no latency (oversample "none"). */
function clipper(ctx, curve) {
  const pre = gainNode(ctx, 1 / CLIP_RANGE);
  const ws = ctx.createWaveShaper();
  ws.curve = curve;
  ws.oversample = "none";
  pre.connect(ws);
  return { input: pre, output: ws };
}

class Insert {
  constructor(ctx) {
    this.send = gainNode(ctx);
    this.ret = gainNode(ctx);
    this.send.connect(this.ret);                 // dry path: always on
  }
}

class Channel {
  constructor(mixer, n) {
    const ctx = mixer.ctx;
    this.mixer = mixer;
    this.n = n;
    this.state = { trim: DEFAULTS.trim, hi: DEFAULTS.eq, mid: DEFAULTS.eq, low: DEFAULTS.eq,
      cfx: DEFAULTS.cfx, fader: DEFAULTS.fader, cue: DEFAULTS.cue };
    const level = gainNode(ctx, dbToGain(OUTPUT_LEVEL_DB));
    const trim = gainNode(ctx, trimGain(DEFAULTS.trim));
    level.connect(trim);
    // isolator: LOW = LR4 low-pass at f1 (+ allpass at f2 to match the other
    // bands' phase), MID = LR4 high-pass f1 then low-pass f2, HIGH = high-pass f1 and f2
    const lowLp = lr4(ctx, "lowpass", EQ_CROSSOVER_LOW_HZ, trim);
    const lowAp = biquad(ctx, "allpass", EQ_CROSSOVER_HIGH_HZ, SQRT1_2);
    lowLp.connect(lowAp);
    const upper = lr4(ctx, "highpass", EQ_CROSSOVER_LOW_HZ, trim);
    const midLp = lr4(ctx, "lowpass", EQ_CROSSOVER_HIGH_HZ, upper);
    const hiHp = lr4(ctx, "highpass", EQ_CROSSOVER_HIGH_HZ, upper);
    const bands = {
      low: gainNode(ctx, dbToGain(eqGainDb(DEFAULTS.eq))),
      mid: gainNode(ctx, dbToGain(eqGainDb(DEFAULTS.eq))),
      hi: gainNode(ctx, dbToGain(eqGainDb(DEFAULTS.eq))),
    };
    const eqSum = gainNode(ctx);
    lowAp.connect(bands.low).connect(eqSum);
    midLp.connect(bands.mid).connect(eqSum);
    hiHp.connect(bands.hi).connect(eqSum);
    const cfx = biquad(ctx, "lowpass", ctx.sampleRate / 2, 0);
    const post = gainNode(ctx);
    eqSum.connect(cfx).connect(post);
    const meter = ctx.createAnalyser();
    meter.fftSize = 1024;
    post.connect(meter);
    const cue = gainNode(ctx, DEFAULTS.cue ? 1 : 0);
    post.connect(cue).connect(mixer._cueBus);
    const fader = gainNode(ctx, faderGain(DEFAULTS.fader));
    const xf = gainNode(ctx, 1);
    this.insert = new Insert(ctx);
    post.connect(fader).connect(xf).connect(this.insert.send);
    this.insert.ret.connect(mixer._bus);
    this.input = level;
    this._nodes = { trim, bands, cfx, post, meter, cue, fader, xf };
    this._meterBuf = new Float32Array(meter.fftSize);
    this._cfxType = "off";
  }

  setTrim(k) {
    this.state.trim = clamp01(k);
    setSmooth(this.mixer.ctx, this._nodes.trim.gain, trimGain(this.state.trim));
  }

  setEq(band, k) {
    const node = this._nodes.bands[band];
    if (!node) throw new Error(`EQ band ${band}`);
    this.state[band] = clamp01(k);
    setSmooth(this.mixer.ctx, node.gain, dbToGain(eqGainDb(this.state[band])));
  }

  setCfx(k) {
    const ctx = this.mixer.ctx;
    this.state.cfx = clamp01(k);
    const f = cfxFilter(this.state.cfx);
    const bq = this._nodes.cfx;
    const t = ctx.currentTime;
    if (f.type === "off") {
      // a low-pass at Nyquist is the identity: no type change, no click
      if (this._cfxType !== "off") {
        bq.type = "lowpass";
        bq.frequency.cancelScheduledValues(t);
        bq.frequency.setValueAtTime(ctx.sampleRate / 2, t);
        bq.Q.cancelScheduledValues(t);
        bq.Q.setValueAtTime(0, t);
      }
      this._cfxType = "off";
      return;
    }
    const qDb = 20 * Math.log10(f.q);
    bq.frequency.cancelScheduledValues(t);
    if (f.type !== this._cfxType) {
      // entering a side from the dead zone: start the sweep at its open end
      bq.type = f.type;
      bq.frequency.setValueAtTime(f.type === "lowpass" ? CFX_LP_MAX_HZ : CFX_HP_MIN_HZ, t);
      this._cfxType = f.type;
    }
    bq.frequency.setTargetAtTime(f.freq, t, SMOOTH_TAU_S);
    setSmooth(ctx, bq.Q, qDb);
  }

  setFader(f) {
    this.state.fader = clamp01(f);
    setSmooth(this.mixer.ctx, this._nodes.fader.gain, faderGain(this.state.fader));
  }

  setCue(on) {
    this.state.cue = !!on;
    setSmooth(this.mixer.ctx, this._nodes.cue.gain, this.state.cue ? 1 : 0);
  }

  /** Pre-fader peak (linear) over the last 1024 frames: the channel meter. */
  level() {
    const a = this._meterBuf;
    this._nodes.meter.getFloatTimeDomainData(a);
    let p = 0;
    for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > p) p = v; }
    return p;
  }
}

export class Mixer {
  constructor(ctx) {
    this.ctx = ctx;
    this._bus = gainNode(ctx);
    this._cueBus = gainNode(ctx);
    this._channels = [];
    this.state = {
      crossfader: DEFAULTS.crossfader, masterLevel: DEFAULTS.masterLevel,
      masterCue: DEFAULTS.masterCue, phonesMix: DEFAULTS.phonesMix,
      phonesLevel: DEFAULTS.phonesLevel, channels: [],
    };
    for (const n of [1, 2]) {
      const ch = new Channel(this, n);
      this._channels.push(ch);
      this.state.channels.push(ch.state);
    }
    this._masterInsert = new Insert(ctx);
    this._bus.connect(this._masterInsert.send);
    this._masterSum = gainNode(ctx);
    this._masterInsert.ret.connect(this._masterSum);
    /** The sampler's way in: joins the master after the Beat FX insert. */
    this.samplerInput = gainNode(ctx);
    this.samplerInput.connect(this._masterSum);
    this._masterGain = gainNode(ctx, levelGain(DEFAULTS.masterLevel));
    /** Post MASTER LEVEL, pre split: what the recorder records. */
    this.masterTap = gainNode(ctx);
    const curve = softClipCurve();
    const mClip = clipper(ctx, curve);
    this._masterSum.connect(this._masterGain).connect(mClip.input);
    mClip.output.connect(this.masterTap);
    this._masterClip = mClip.output;

    this._masterCue = gainNode(ctx, DEFAULTS.masterCue ? 1 : 0);
    this._masterSum.connect(this._masterCue).connect(this._cueBus);
    const [mc, mm] = phonesMixGains(DEFAULTS.phonesMix);
    this._phonesCue = gainNode(ctx, mc);
    this._phonesMaster = gainNode(ctx, mm);
    this._phonesGain = gainNode(ctx, levelGain(DEFAULTS.phonesLevel));
    this._cueBus.connect(this._phonesCue).connect(this._phonesGain);
    this._masterSum.connect(this._phonesMaster).connect(this._phonesGain);

    // split: each side folded to mono ((L + R) / 2) on its own merger input
    this.output = ctx.createChannelMerger(2);
    const leftMono = gainNode(ctx, 1, 1);
    const rightMono = gainNode(ctx, 1, 1);
    const pClip = clipper(ctx, curve);
    this._phonesGain.connect(pClip.input);
    pClip.output.connect(leftMono).connect(this.output, 0, 0);
    this.masterTap.connect(rightMono).connect(this.output, 0, 1);
    this.setCrossfader(DEFAULTS.crossfader);
  }

  /** Channel strip 1 or 2. */
  channel(i) {
    const ch = this._channels[Number(i) - 1];
    if (!ch) throw new Error(`no channel ${i}`);
    return ch;
  }

  /** Beat FX insert point {send, ret}: target 1, 2 (post crossfader) or
   *  "master" (the summed channels, before the sampler and MASTER LEVEL).
   *  send -> ret is always connected (dry); an effect adds a wet path. */
  fxSend(target) {
    if (target === "master") return this._masterInsert;
    return this.channel(target).insert;
  }

  setTrim(ch, k) { this.channel(ch).setTrim(k); }

  setEq(ch, band, k) { this.channel(ch).setEq(band, k); }

  setCfx(ch, k) { this.channel(ch).setCfx(k); }

  setFader(ch, f) { this.channel(ch).setFader(f); }

  setCue(ch, on) { this.channel(ch).setCue(on); }

  level(ch) { return this.channel(ch).level(); }

  setCrossfader(x) {
    this.state.crossfader = clamp01(x);
    const [a, b] = crossfaderGains(this.state.crossfader);
    setSmooth(this.ctx, this._channels[0]._nodes.xf.gain, a);
    setSmooth(this.ctx, this._channels[1]._nodes.xf.gain, b);
  }

  setMasterLevel(k) {
    this.state.masterLevel = clamp01(k);
    setSmooth(this.ctx, this._masterGain.gain, levelGain(this.state.masterLevel));
  }

  setMasterCue(on) {
    this.state.masterCue = !!on;
    setSmooth(this.ctx, this._masterCue.gain, this.state.masterCue ? 1 : 0);
  }

  setPhonesMix(k) {
    this.state.phonesMix = clamp01(k);
    const [c, m] = phonesMixGains(this.state.phonesMix);
    setSmooth(this.ctx, this._phonesCue.gain, c);
    setSmooth(this.ctx, this._phonesMaster.gain, m);
  }

  setPhonesLevel(k) {
    this.state.phonesLevel = clamp01(k);
    setSmooth(this.ctx, this._phonesGain.gain, levelGain(this.state.phonesLevel));
  }
}

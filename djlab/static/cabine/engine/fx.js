// A Cabine: the FLX4 Beat FX section (one unit) as rekordbox runs it.
//
// Manual check (Task 7, step 1), done 2026-10-27 against the DDJ-FLX4
// Instruction Manual [M] "Effects section, Using rekordbox" (pp. 31-32) and
// "Using Beat FX" (pp. 68-69), and the rekordbox 7.2.18 manual [R] "Using
// BEAT FX" (pp. 182-185). Tags as in mixer.js ([S] spec, [B] builder).
//
// | Control              | Implemented                                            | Source |
// |----------------------|--------------------------------------------------------|--------|
// | BEAT FX SELECT       | Next effect; SHIFT = previous (select(+1 / -1)). The   | M, S   |
// |                      | v1 set, in order: Delay, Echo, Reverb, Flanger, Roll.  |        |
// | BEAT < / >           | Fewer / more beats, stopping at the ends: 1/4, 1/2,    | M, S   |
// |                      | 3/4, 1, 2, 4. Default 1.                               | (B)    |
// | BPM                  | BPM Auto mode (the default [M p.69]): the track's BPM, | M      |
// |                      | from getBpm(target); 120 when there is none [B].       |        |
// | CH SELECT            | Lever 1 / 2 / 1&2. The API value of the third position | M, B   |
// |                      | is "master" (ruling), and it behaves as the manual's   |        |
// |                      | 1&2: the effect runs on the summed channels before the |        |
// |                      | sampler joins (the effects are linear, so this equals  |        |
// |                      | one effect on each channel with the same settings).    |        |
// |                      | Touch: a tap cycles 1 > 2 > 1&2 [S].                   |        |
// | LEVEL/DEPTH          | Wet level: CCW original sound only, CW full effect     | R      |
// |                      | [R p.183]. The dry signal is never cut.                |        |
// | ON/OFF               | Toggles; lit/flashing while on (UI). Off closes the    | M, S   |
// |                      | effect's input; Delay, Echo and Reverb tails ring out. |        |
// | Delay                | One repeat, `fraction` beats later.                    | B      |
// | Echo                 | Repeats every `fraction` beats, feedback 0.5, 7 kHz    | B      |
// |                      | damping in the loop.                                   |        |
// | Reverb               | BEAT sets a parameter, not beats [R p.183]: the six    | R, B   |
// |                      | steps map to decay times 0.4 .. 3.5 s.                 |        |
// | Flanger              | Sweep cycle = fraction x 16 beats (4 .. 64 beats),     | B      |
// |                      | 1 .. 5 ms modulated delay, no feedback (Web Audio      |        |
// |                      | clamps delays inside a cycle to 128 frames).           |        |
// | Roll                 | Deck.roll(fraction) on the target deck while on        | S, R3  |
// |                      | (1&2: every playing deck), roll(null) on off, on a     |        |
// |                      | lever move and on leaving Roll. LEVEL is ignored: the  |        |
// |                      | deck plays one stream, so the roll replaces the sound. |        |
//
// Not modelled (flagged): SHIFT + BEAT < (BPM Tap mode) and SHIFT + BEAT >
// (back to Auto), SHIFT + ON/OFF (Release FX), multi/single mode, the
// flanger's sweep phase is not locked to the bar.

export const FX_NAMES = ["Delay", "Echo", "Reverb", "Flanger", "Roll"];
export const FX_FRACTIONS = [0.25, 0.5, 0.75, 1, 2, 4];
export const FX_FRACTION_LABELS = ["1/4", "1/2", "3/4", "1", "2", "4"];
export const FX_TARGETS = ["1", "2", "master"];
export const DEFAULT_FRACTION = 1;
export const MAX_DELAY_S = 8;                      // 4 beats down to 30 BPM
export const FALLBACK_BPM = 120;
export const ECHO_FEEDBACK = 0.5;
export const ECHO_DAMP_HZ = 7000;
export const REVERB_DECAY_S = [0.4, 0.7, 1.0, 1.6, 2.4, 3.5];
export const FLANGER_CYCLE_BEATS_PER_FRACTION = 16;
export const FLANGER_BASE_S = 0.003;
export const FLANGER_DEPTH_S = 0.002;
const GLIDE_TAU_S = 0.02;
const GATE_TAU_S = 0.005;

/** Board actions on BeatFx (Task 9's control map resolves these). */
export const BEATFX_ACTIONS = ["select", "beat", "setTarget", "cycleTarget", "setLevel",
  "setOn", "toggle", "refresh"];

/** Seconds for `fraction` beats at `bpm` (FALLBACK_BPM when unknown). */
export function fxBeatSeconds(bpm, fraction) {
  return (fraction * 60) / (bpm > 0 ? bpm : FALLBACK_BPM);
}

const clamp01 = (x) => Math.min(1, Math.max(0, Number(x) || 0));

function gainNode(ctx, value) {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

function smooth(ctx, param, v, tau = GATE_TAU_S) {
  const t = ctx.currentTime;
  param.cancelScheduledValues(t);
  param.setTargetAtTime(v, t, tau);
}

/** Stereo exponentially decaying noise, -60 dB at `decay` seconds. */
function reverbImpulse(ctx, decay) {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.round(decay * sr));
  const buf = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp((-6.9 * i) / n);
  }
  return buf;
}

export class BeatFx {
  /**
   * @param ctx     AudioContext / OfflineAudioContext
   * @param mixer   Mixer (fxSend(target) -> {send, ret})
   * @param getBpm  (target) => BPM the effect follows (BPM Auto mode)
   * @param opts    {decks: [deck1, deck2]} for Roll
   */
  constructor(ctx, mixer, getBpm, opts = {}) {
    this.ctx = ctx;
    this.mixer = mixer;
    this.getBpm = getBpm || (() => null);
    this.decks = opts.decks || [];
    this.state = { name: FX_NAMES[0], fraction: DEFAULT_FRACTION, target: "1", on: false, level: 0.5 };
    this._fi = FX_FRACTIONS.indexOf(DEFAULT_FRACTION);
    this._ni = 0;
    this._bpm = null;
    this._rolling = [];
    this._reverbBufs = new Map();

    this._in = gainNode(ctx, 1);
    this._wet = gainNode(ctx, this.state.level);
    const u = (this._units = {});

    // Delay: one repeat
    u.Delay = { gate: gainNode(ctx, 0), delay: ctx.createDelay(MAX_DELAY_S) };
    this._in.connect(u.Delay.gate).connect(u.Delay.delay).connect(this._wet);

    // Echo: repeats through a damped feedback loop
    const e = (u.Echo = { gate: gainNode(ctx, 0), delay: ctx.createDelay(MAX_DELAY_S),
      damp: ctx.createBiquadFilter(), fb: gainNode(ctx, ECHO_FEEDBACK) });
    e.damp.type = "lowpass";
    e.damp.frequency.value = ECHO_DAMP_HZ;
    this._in.connect(e.gate).connect(e.delay);
    e.delay.connect(e.damp).connect(e.fb).connect(e.delay);
    e.delay.connect(this._wet);

    // Reverb
    u.Reverb = { gate: gainNode(ctx, 0), conv: ctx.createConvolver() };
    this._in.connect(u.Reverb.gate).connect(u.Reverb.conv).connect(this._wet);

    // Flanger: a short delay swept by an LFO, mixed with the dry signal
    const f = (u.Flanger = { gate: gainNode(ctx, 0), delay: ctx.createDelay(0.05),
      lfo: ctx.createOscillator(), depth: gainNode(ctx, FLANGER_DEPTH_S) });
    f.delay.delayTime.value = FLANGER_BASE_S;
    f.lfo.type = "sine";
    f.lfo.connect(f.depth).connect(f.delay.delayTime);
    f.lfo.start();
    this._in.connect(f.gate).connect(f.delay).connect(this._wet);

    this._insert = null;
    this._patch();
    this.refresh(true);
  }

  // ---- controls ------------------------------------------------------------------

  /** FX SELECT: +1 next, -1 previous (SHIFT). */
  select(dir = 1) {
    const step = dir < 0 ? -1 : 1;
    const was = this.state.name;
    this._ni = (this._ni + step + FX_NAMES.length) % FX_NAMES.length;
    this.state.name = FX_NAMES[this._ni];
    if (this.state.on) this._switch(was, this.state.name);
    this.refresh();
  }

  /** BEAT < (-1) / BEAT > (+1). Stops at 1/4 and 4. */
  beat(dir) {
    const i = Math.min(FX_FRACTIONS.length - 1, Math.max(0, this._fi + (dir < 0 ? -1 : 1)));
    if (i === this._fi) return;
    this._fi = i;
    this.state.fraction = FX_FRACTIONS[i];
    this.refresh();
    if (this.state.on && this.state.name === "Roll") this._rollOn();
  }

  /** CH SELECT lever: "1" | "2" | "master" (the FLX4 lever's 1&2). */
  setTarget(target) {
    const t = String(target);
    if (!FX_TARGETS.includes(t)) throw new Error(`Beat FX target ${target}`);
    if (t === this.state.target) return;
    const rolling = this.state.on && this.state.name === "Roll";
    if (rolling) this._rollOff();
    this.state.target = t;
    this._patch();
    this.refresh();
    if (rolling) this._rollOn();
  }

  /** Touch translation: a tap moves the lever to the next position. */
  cycleTarget() {
    const i = FX_TARGETS.indexOf(this.state.target);
    this.setTarget(FX_TARGETS[(i + 1) % FX_TARGETS.length]);
  }

  /** LEVEL/DEPTH 0..1: wet level. */
  setLevel(k) {
    this.state.level = clamp01(k);
    smooth(this.ctx, this._wet.gain, this.state.level);
  }

  setOn(on) {
    on = !!on;
    if (on === this.state.on) return;
    this.state.on = on;
    this.refresh();
    if (on) this._open(this.state.name);
    else this._close(this.state.name);
  }

  /** ON/OFF button press. */
  toggle() { this.setOn(!this.state.on); }

  /** Re-read the BPM (call when a tempo or the master deck changes; cheap
   *  when nothing changed). */
  refresh(force = false) {
    const bpm = this.getBpm(this.state.target);
    const key = `${bpm}|${this._fi}`;
    if (!force && key === this._key) return;
    this._key = key;
    this._bpm = bpm;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const secs = Math.min(fxBeatSeconds(bpm, this.state.fraction), MAX_DELAY_S);
    for (const name of ["Delay", "Echo"]) {
      const p = this._units[name].delay.delayTime;
      if (force) p.value = secs;
      else { p.cancelScheduledValues(t); p.setTargetAtTime(secs, t, GLIDE_TAU_S); }
    }
    const cycle = fxBeatSeconds(bpm, this.state.fraction * FLANGER_CYCLE_BEATS_PER_FRACTION);
    this._units.Flanger.lfo.frequency.value = 1 / cycle;
    let ir = this._reverbBufs.get(this._fi);
    if (!ir) {
      ir = reverbImpulse(ctx, REVERB_DECAY_S[this._fi]);
      this._reverbBufs.set(this._fi, ir);
    }
    if (this._units.Reverb.conv.buffer !== ir) this._units.Reverb.conv.buffer = ir;
  }

  // ---- internals -------------------------------------------------------------------

  /** Move the effect's input and output to the current CH SELECT insert. */
  _patch() {
    const ins = this.mixer.fxSend(this.state.target);
    if (this._insert === ins) return;
    if (this._insert) {
      this._insert.send.disconnect(this._in);
      this._wet.disconnect(this._insert.ret);
    }
    ins.send.connect(this._in);
    this._wet.connect(ins.ret);
    this._insert = ins;
  }

  _open(name) {
    if (name === "Roll") { this._rollOn(); return; }
    smooth(this.ctx, this._units[name].gate.gain, 1);
  }

  _close(name) {
    if (name === "Roll") { this._rollOff(); return; }
    smooth(this.ctx, this._units[name].gate.gain, 0);    // the tail already inside rings out
  }

  _switch(from, to) {
    this._close(from);
    this._open(to);
  }

  _targetDecks() {
    const [a, b] = this.decks;
    if (this.state.target === "1") return a ? [a] : [];
    if (this.state.target === "2") return b ? [b] : [];
    return this.decks.filter((d) => d && d.state && d.state.playing);
  }

  _rollOn() {
    const decks = this._rolling.length ? this._rolling : this._targetDecks();
    for (const d of decks) d.roll(this.state.fraction);
    this._rolling = decks;
  }

  _rollOff() {
    for (const d of this._rolling) d.roll(null);
    this._rolling = [];
  }
}

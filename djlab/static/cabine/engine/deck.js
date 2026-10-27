// A Cabine: one FLX4 deck as rekordbox drives it, over an injected voice.
//
// Manual check (Task 5, step 1), done 2026-10-27 against:
//   [M]  Pioneer DJ "DDJ-FLX4 Instruction Manual" (EN PDF), section
//        "Part names and functions > Deck section > Using rekordbox for
//        Mac/Windows or rekordbox for iOS/Android" (pp. 15-20) and
//        "rekordbox for Mac/Windows > Advanced use" (pp. 54-67).
//   [X]  Mixxx mapping res/controllers/Pioneer-DDJ-FLX4-script.js and
//        Pioneer-DDJ-FLX4.midi.xml (read only, GPL, nothing copied).
//        Used only as a second witness; where Mixxx does something
//        Mixxx-specific (SHIFT+PLAY "censor", 4 BEAT as reloop) it is ignored.
//   [S]  the approved spec's control map (section 5), kept where [M] is silent.
//   [B]  builder's choice, not stated in any source (touch math, limits).
//
// | Control                  | Behavior implemented                                   | Source |
// |--------------------------|--------------------------------------------------------|--------|
// | PLAY/PAUSE               | Toggle play / pause.                                   | M      |
// | SHIFT + PLAY/PAUSE       | Nothing. The rekordbox section lists no SHIFT function  | M      |
// |                          | for PLAY/PAUSE (Stutter is listed for Serato only).    |        |
// | CUE, paused              | Sets the cue point at the playhead (quantized when the | M (+S) |
// |                          | grid is reliable) and, while held, plays from it       |        |
// |                          | (Cue Point Sampler); release returns to it and pauses. |        |
// | CUE, playing             | Back Cue: return to the cue point and pause.           | M      |
// | PLAY while CUE held      | Playback continues after CUE is released.              | B (CDJ |
// |                          |                                                        | habit) |
// | SHIFT + CUE              | Playback position to the start of the track (play      | M      |
// |                          | state unchanged; the manual does not say it stops).    |        |
// | Jog top, touched + turn  | Vinyl mode (rekordbox default on): scratch; audio      | M, X   |
// |                          | follows the finger, forward and backward, paused too.  |        |
// |                          | Lift: back to playing speed (or stays paused).         |        |
// | SHIFT + jog top turn     | Fast-forward / fast-reverse with extra speed (search). | M, X   |
// | Jog outer ring turn      | Pitch bend while turning, proportional to speed.       | M      |
// | TEMPO slider             | Down = faster. rate = 1 + range * (2 * fader - 1).     | M, S   |
// | SHIFT + BEAT SYNC        | Tempo range +-6 > +-10 > +-16 > WIDE > +-6.            | M      |
// | Default tempo range      | +-10 (rekordbox preference default; the manual lists   | S, X   |
// |                          | the cycle but not the default).                        |        |
// | BEAT SYNC                | Matches tempo (BPM) and beatgrid phase to the other    | M      |
// |                          | deck (the master); stays synced; press again cancels.  |        |
// |                          | Disabled (no-op, state.noGrid) without a reliable grid.| S      |
// | IN                       | Sets the loop in point (quantized).                    | M      |
// | OUT                      | Sets the loop out point, loop playback begins.         | M      |
// | IN / OUT during loop     | Adjust that loop point with the jog wheel (press the   | M (+X  |
// |                          | same button again to finish).                          | toggle)|
// | 4 BEAT/EXIT              | No loop: Auto Beat Loop of 4 beats from the beat at    | M      |
// |                          | the playhead. Loop active: cancel, play continues.     |        |
// | SHIFT + 4 BEAT/EXIT      | Active Loop: arms / cancels the saved loop (a loop hot | M      |
// |                          | cue here) nearest the playhead; playback loops when it |        |
// |                          | reaches that loop's in point.                          |        |
// | CUE/LOOP CALL < >, loop  | Halve / double the loop (also during 4 Beat Loop).     | M      |
// | CUE/LOOP CALL, no loop   | Calls memory cues: out of scope v1 ("not yet").        | M, S   |
// | HOT CUE pads A-H         | Unlit pad: sets a hot cue at the playhead (quantized), | M      |
// |                          | or saves the active loop as a loop hot cue. Lit pad:   |        |
// |                          | playback starts from that point (also when paused);    |        |
// |                          | a loop hot cue starts loop playback from its in point. |        |
// |                          | SHIFT + pad clears it.                                 |        |
// | BEAT JUMP pads           | 1: -1, 2: +1, 3: -2, 4: +2, 5: -4, 6: +4, 7: -8, 8: +8 | M      |
// |                          | beats (rekordbox default order). Phase kept.           |        |
// | SHIFT + BEAT JUMP pad 7/8| Halve / double the beats on every pad (1/8 to 64).     | M (lim-|
// |                          |                                                        | its B) |
// | BEAT LOOP (SHIFT + BEAT  | Pads 1/4, 1/2, 1, 2, 4, 8, 16, 32 beats; the same pad  | M      |
// | JUMP mode)               | again cancels the loop.                                |        |
// | SHIFT                    | Held, per deck.                                        | M, S   |
//
// Changed from spec:
// - SHIFT + PLAY/PAUSE: spec said "stutter back to the cue point (rekordbox
//   default)". The rekordbox section of the manual has no SHIFT + PLAY/PAUSE
//   entry (Stutter is a Serato DJ Lite function), so it does nothing here.
// - SHIFT + 4 BEAT/EXIT: spec said "reloop". The manual says it sets/cancels
//   the loop nearest the playhead as Active Loop (loops saved on the track
//   or in Hot Cue mode). Implemented over loop hot cues.
// - Hot cue on a lit pad: spec said "jumps (and plays if playing)". The
//   manual says "Playback starts from the Hot Cue point", so it plays from a
//   paused deck too.
// - Hot Cue mode also stores loops: a pad pressed during loop playback saves
//   the loop, and calling it starts loop playback (manual p. 57; spec silent).
// - IN / OUT pressed during loop playback adjust the loop point with the jog
//   (manual p. 15-16; spec silent).
// - Beat Loop: pressing the same pad again cancels the loop (manual p. 64).
// - SHIFT + BEAT JUMP pads 7 / 8 change the jump size (manual p. 60).
//
// Not from any source (builder, flagged so they can be checked later):
// - Quantize is on (rekordbox default) and applies to cue, hot cues, loops
//   and beat jump when the grid is reliable; a quantized hot cue call while
//   playing keeps the beat phase (jumps to cue + current beat fraction).
// - Beat jump during an active loop moves the loop with the playhead.
// - Calling a point hot cue during a loop exits the loop.
// - On a synced deck the TEMPO slider is ignored until sync is cancelled;
//   cancelling keeps the synced tempo until the slider moves again.
// - Changing the tempo range keeps the slider position (tempo rescales).
// - Jog math: 1 turn = 1.8 s of audio (33 1/3 rpm); fast search = 16x;
//   pitch bend = 10 % per turn per second, capped at +-30 %; loop adjust
//   = 0.5 s per turn.
//
// Time model. The deck never reads audio; it keeps an anchor {s, t, rate}:
// "at audio-clock time t the playhead was at s seconds, moving at rate".
// posAt(T) extrapolates it (wrapping at an armed loop's OUT). The voice's
// position reports (the worklet posts one every 32 render quanta) re-anchor
// it, except reports older than a jump the deck has scheduled. Jumps that
// must keep the beat (sync, beat jump, quantized hot cues) are scheduled
// SCHEDULE_LEAD_S ahead on the audio clock, so the worklet lands them on an
// exact sample instead of whenever the message arrives.
//
// Loops live in state.loop {in, out, active, beats, pad, adjust}; the
// helpers _engageLoop / _exitLoop are the only places that arm or disarm the
// voice's loop, so a slip roll (Task 7, Deck.roll) can wrap them and resume
// from posAt-style bookkeeping of where playback would have been.
//
// Roll (Task 7, ruling R3; Beat FX "Roll" drives it). roll(beats) arms a
// loop of `beats` beats from the current beat (floored to the quarter for
// rolls under a beat, to the beat otherwise) and keeps a second, silent
// anchor: the slip position, where playback would be without the roll
// (extrapolated through any loop that was active before, re-anchored on
// tempo changes). roll(null) jumps there, scheduled SCHEDULE_LEAD_S ahead,
// and releases the roll loop on that same frame (or re-arms the loop that
// was active before). Roll is HELD, like the Beat FX button it serves:
// roll(beats) on a paused deck arms the hold and the roll starts when the
// deck starts playing (PLAY, a hot cue, the CUE preview, the jog let go);
// pausing (PLAY, Back Cue, CUE release, track end) ends the current roll
// where it is and keeps the hold, so the next play rolls again; roll(null)
// releases the hold. Builder rules [B]: no reliable grid = no-op (like
// sync and quantize); any other loop action during a roll takes over and
// the slip is dropped (the hold stays for the next play or length change);
// a new length during a roll keeps the in point and the slip; the hold
// survives a load (the Beat FX button is still down).

import { beatPeriod, beatIndexAt, timeOfBeat, quantize, phaseAt } from "./grid.js";

export const TEMPO_RANGES = [6, 10, 16, 100];          // percent; 100 = WIDE
export const DEFAULT_RANGE = 10;
export const BEAT_JUMP_PADS = [-1, 1, -2, 2, -4, 4, -8, 8];
export const BEAT_LOOP_PADS = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
export const BEAT_JUMP_SCALE_MIN = -3;                 // pads down to 1/8 .. 1 beat
export const BEAT_JUMP_SCALE_MAX = 3;                  // pads up to 8 .. 64 beats
export const SECONDS_PER_TURN = 1.8;                   // 33 1/3 rpm platter
export const FAST_SEARCH_X = 16;
export const BEND_PER_TURN_PER_S = 0.10;
export const MAX_BEND = 0.30;
export const LOOP_ADJUST_S_PER_TURN = 0.5;
export const SCHEDULE_LEAD_S = 0.03;
export const ROLL_MIN_UNIT = 0.25;                     // sub-beat rolls start on a quarter
const SCRATCH_TAU_S = 0.03;          // the record closes the gap to the finger in ~30 ms
const SCRATCH_TICK_MS = 15;
const SCRATCH_DONE_S = 0.0005;
const MAX_SCRATCH_RATE = 16;
const BEND_HOLD_MS = 60;
const MIN_LOOP_S = 0.01;

/** Every control-map action; Task 9's flx4-map names must resolve here. */
export const DECK_ACTIONS = [
  "playPause", "shiftPlayPause", "cueDown", "cueUp", "shiftCue",
  "jogTouch", "jogTurn", "jogRing", "setTempo", "cycleRange", "syncPress",
  "loopIn", "loopOut", "fourBeatExit", "shiftFourBeatExit", "loopHalve", "loopDouble",
  "hotCue", "shiftHotCue", "beatJump", "shiftBeatJump", "beatLoop",
  "setShift", "effectiveBpm", "load", "roll",
];

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const emptyLoop = () => ({ in: null, out: null, active: false, beats: null, pad: null, adjust: null });

/** Where an anchor {s, t, rate} puts the playhead at T, wrapping at the OUT
 *  of loop L when it is active (forward play only), clamped to [0, dur]. */
function extrapolate(a, L, T, dur) {
  let s = a.s + (T - a.t) * a.rate;
  if (L && L.active && a.rate > 0 && a.s < L.out && s >= L.out) {
    s = L.in + ((s - L.out) % (L.out - L.in));
  }
  return clamp(s, 0, dur);
}

function normalizeHotCues(list) {
  const out = new Array(8).fill(null);
  if (!Array.isArray(list)) return out;
  for (let i = 0; i < 8; i++) {
    const h = list[i];
    if (h && Number.isFinite(h.start)) {
      out[i] = { start: h.start, end: Number.isFinite(h.end) && h.end > h.start ? h.end : null };
    }
  }
  return out;
}

function freshState(range = DEFAULT_RANGE, shift = false) {
  return {
    loaded: false, playing: false, cuePoint: 0, hotCues: new Array(8).fill(null),
    loop: emptyLoop(), tempoPct: 0, range, syncOn: false, shift,
    noGrid: true, quantize: true, jogTouched: false, cueHeld: false,
    activeLoop: null, beatJumpScale: 0, roll: null,
  };
}

export class Deck {
  /**
   * @param voice  implements load/setRate/seek/setLoop/play/pause/position/
   *               onposition/underruns (deck-voice.js, or a fake in tests)
   * @param opts   {now: () => audio clock seconds, setTimeout, clearTimeout}
   */
  constructor(voice, opts = {}) {
    this.voice = voice;
    this.now = opts.now || (() => 0);
    this._setTimeout = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = opts.clearTimeout || ((id) => clearTimeout(id));
    this.track = null;
    this.grid = null;
    this.state = freshState();
    this._fader = 0.5;                 // TEMPO slider, 0 = top (slow) .. 1 = bottom (fast)
    this._syncRate = null;             // rate imposed by BEAT SYNC
    this._heldRate = null;             // tempo kept after sync is cancelled, until the slider moves
    this._master = null;
    this._followers = new Set();
    this._bend = 0;
    this._bendT = -Infinity;
    this._bendTimer = null;
    this._scratchRate = 0;
    this._scratchTarget = 0;
    this._scratchTimer = null;
    this._cueLatch = false;
    this._duration = Infinity;
    this._anchor = { s: 0, t: 0, rate: 0 };
    this._holdUntil = -Infinity;
    this._roll = null;                 // {slip: anchor, prior: loop | null} while rolling
    this._rollHold = null;             // beats while Beat FX Roll is held on this deck
    voice.onposition((s, t) => this._report(s, t));
    if (typeof voice.onended === "function") voice.onended(() => this._ended());
  }

  // ---- reading ---------------------------------------------------------------

  /** Playhead (track seconds) at audio-clock time T. */
  posAt(T = this.now()) {
    return extrapolate(this._anchor, this.state.loop, T, this._duration);
  }

  /** BPM with tempo / sync applied (pitch bend excluded), null if unknown. */
  effectiveBpm() {
    if (!this.state.loaded) return null;
    const bpm = this.grid ? this.grid.bpm : this.track && this.track.meta && this.track.meta.bpm;
    return bpm ? bpm * this._baseRate() : null;
  }

  get duration() { return this._duration; }

  /** Beats of a held Beat FX Roll on this deck, null when not held. */
  get rollHold() { return this._rollHold; }

  // ---- load --------------------------------------------------------------------

  load(track) {
    this._clearTimers();
    this._unsync();
    for (const f of [...this._followers]) f._unsync();
    this.track = track;
    this.grid = track.grid || null;
    const g = this.grid;
    const reliable = !!(g && g.reliable !== false && g.bpm > 0 && Number.isFinite(g.first_beat_s));
    const pcm = track.pcm;
    // duration before voice.load: the real voice transfers (detaches) the buffers
    this._duration = pcm && pcm.left && pcm.left.length
      ? pcm.left.length / pcm.sampleRate
      : (track.meta && track.meta.duration_s) || Infinity;
    this._syncRate = null;
    this._heldRate = null;
    this._bend = 0;
    this._scratchRate = 0;
    this._cueLatch = false;
    this._roll = null;
    this.state = {
      ...freshState(this.state.range, this.state.shift),
      loaded: true,
      hotCues: normalizeHotCues(track.hotCues),
      noGrid: !reliable,
    };
    this.voice.load(pcm);
    this._anchor = { s: 0, t: this.now(), rate: 0 };
    this._holdUntil = -Infinity;
    this._applyRate();
  }

  // ---- transport -----------------------------------------------------------------

  playPause() {
    const st = this.state;
    if (!st.loaded) return;
    if (st.cueHeld) { this._cueLatch = true; return; }   // PLAY while CUE held: keep playing
    const T = this.now();
    const s = this.posAt(T);
    if (st.playing) {
      this._pauseRoll();
      st.playing = false;
      if (!st.jogTouched) this.voice.pause();
      this._anchor = { s, t: T, rate: this._currentRate() };
    } else {
      st.playing = true;
      if (st.jogTouched) {                     // the hand holds the record: just arm play
        this._anchor = { s, t: T, rate: this._currentRate() };
        return;
      }

      this.voice.setRate(this._playRate());
      // Synced start (rekordbox beat sync on play): the start and the phase
      // jump land on the same frame, SCHEDULE_LEAD_S ahead; nothing sounds
      // from the unaligned position first.
      const Ta = T + SCHEDULE_LEAD_S;
      const aligned = st.syncOn ? this._alignedPos(Ta, s) : null;
      if (aligned !== null) {
        this.voice.seek(aligned, Ta);
        this.voice.play(Ta);
        this._holdUntil = Ta;
        this._anchor = { s: aligned, t: Ta, rate: this._currentRate() };
      } else {
        this.voice.play();
        this._anchor = { s, t: T, rate: this._currentRate() };
      }
      this._resumeRoll();
    }
  }

  /** rekordbox lists no SHIFT + PLAY/PAUSE function (see the table above). */
  shiftPlayPause() {}

  cueDown() {
    const st = this.state;
    if (!st.loaded || st.cueHeld) return;
    const T = this.now();
    if (st.playing) {                                    // Back Cue
      this._pauseRoll();
      st.playing = false;
      this.voice.pause();
      this._seekNow(st.cuePoint, T);
      return;
    }
    st.cuePoint = this._q(this.posAt(T));                 // set, then Cue Point Sampler
    st.cueHeld = true;
    this._cueLatch = false;
    st.playing = true;
    this.voice.seek(st.cuePoint);
    this.voice.setRate(this._playRate());
    this.voice.play();
    this._holdUntil = T;
    this._anchor = { s: st.cuePoint, t: T, rate: this._currentRate() };
    this._resumeRoll();
  }

  cueUp() {
    const st = this.state;
    if (!st.loaded || !st.cueHeld) return;
    st.cueHeld = false;
    if (this._cueLatch) { this._cueLatch = false; return; }
    this._pauseRoll();
    st.playing = false;
    this.voice.pause();
    this._seekNow(st.cuePoint, this.now());
  }

  shiftCue() {
    if (!this.state.loaded) return;
    this._seekNow(0, this.now());
  }

  setShift(on) {
    this.state.shift = !!on;
  }

  _ended() {
    this._pauseRoll();
    const T = this.now();
    this.state.playing = false;
    this._anchor = { s: this._duration, t: T, rate: 0 };
  }

  // ---- jog -------------------------------------------------------------------------

  jogTouch(on) {
    const st = this.state;
    if (!st.loaded) return;
    const T = this.now();
    if (on) {
      if (st.jogTouched || st.loop.adjust || st.shift) return;   // SHIFT: search, no grab
      const s = this.posAt(T);
      st.jogTouched = true;
      this._scratchRate = 0;
      this._scratchTarget = s;
      this.voice.setRate(0, true);
      if (!st.playing) this.voice.play();
      this._anchor = { s, t: T, rate: 0 };
      return;
    }
    if (!st.jogTouched) return;
    this._stopTimer("_scratchTimer");
    const s = this.posAt(T);
    st.jogTouched = false;
    this._scratchRate = 0;
    const r = this._playRate();
    this.voice.setRate(r);
    if (!st.playing) this.voice.pause();
    this._anchor = { s, t: T, rate: st.playing ? r : 0 };
    this._resumeRoll();
  }

  /** Top plate turn: scratch while touched, SHIFT = fast search. */
  jogTurn(deltaDeg) {
    const st = this.state;
    if (!st.loaded || !deltaDeg) return;
    if (st.loop.adjust) { this._adjustLoop(deltaDeg); return; }
    if (st.shift) {
      const T = this.now();
      const s = clamp(this.posAt(T) + (deltaDeg / 360) * SECONDS_PER_TURN * FAST_SEARCH_X,
        0, this._duration);
      this._seekNow(s, T);
      return;
    }
    if (!st.jogTouched) { this.jogRing(deltaDeg); return; }   // top without touch: vinyl off = bend
    this._scratchTarget = clamp(this._scratchTarget + (deltaDeg / 360) * SECONDS_PER_TURN,
      0, this._duration);
    this._stopTimer("_scratchTimer");
    this._scratchTick();
  }

  _scratchTick() {
    this._scratchTimer = null;
    if (!this.state.jogTouched) return;
    const T = this.now();
    const s = this.posAt(T);
    const err = this._scratchTarget - s;
    const r = Math.abs(err) < SCRATCH_DONE_S ? 0
      : clamp(err / SCRATCH_TAU_S, -MAX_SCRATCH_RATE, MAX_SCRATCH_RATE);
    if (r !== this._scratchRate) {
      this._scratchRate = r;
      this.voice.setRate(r, true);
    }
    this._anchor = { s, t: T, rate: r };
    if (r !== 0) this._scratchTimer = this._setTimeout(() => this._scratchTick(), SCRATCH_TICK_MS);
  }

  /** Outer ring: pitch bend while turning, back to tempo when it stops. */
  jogRing(deltaDeg) {
    const st = this.state;
    if (!st.loaded || !deltaDeg) return;
    if (st.loop.adjust) { this._adjustLoop(deltaDeg); return; }
    const T = this.now();
    const dt = clamp(T - this._bendT, 1 / 120, 0.1);
    this._bendT = T;
    this._bend = clamp((deltaDeg / 360 / dt) * BEND_PER_TURN_PER_S, -MAX_BEND, MAX_BEND);
    this._applyRate();
    this._stopTimer("_bendTimer");
    this._bendTimer = this._setTimeout(() => {
      this._bendTimer = null;
      this._bend = 0;
      this._applyRate();
    }, BEND_HOLD_MS);
  }

  // ---- tempo and sync -----------------------------------------------------------------

  setTempo(fader01) {
    this._fader = clamp(Number(fader01) || 0, 0, 1);
    if (this.state.syncOn) return;          // a synced deck follows its master
    this._heldRate = null;
    this._tempoChanged();
  }

  cycleRange() {
    const st = this.state;
    const i = TEMPO_RANGES.indexOf(st.range);
    st.range = TEMPO_RANGES[(i + 1) % TEMPO_RANGES.length];
    if (st.syncOn || this._heldRate !== null) return;
    this._tempoChanged();
  }

  syncPress(other) {
    const st = this.state;
    if (!st.loaded) return;
    if (st.syncOn) { this._unsync(); return; }
    if (st.noGrid || !other || !other.state || !other.state.loaded || other.state.noGrid) return;
    if (other._master === this) other._unsync();          // no sync loops: A follows B follows A
    this._master = other;
    other._followers.add(this);
    st.syncOn = true;
    this._syncRate = other.effectiveBpm() / this.grid.bpm;
    this._heldRate = null;
    this._tempoChanged();
    if (st.playing) this._alignPhase();
  }

  _unsync() {
    if (this._master) this._master._followers.delete(this);
    this._master = null;
    if (this.state.syncOn) {
      this._heldRate = this._syncRate;
      this._syncRate = null;
      this.state.syncOn = false;
    }
  }

  _followMaster() {
    const m = this._master;
    if (!m || !m.state.loaded || !this.grid) return;
    this._syncRate = m.effectiveBpm() / this.grid.bpm;
    this._tempoChanged();
  }

  /** Jump (SCHEDULE_LEAD_S ahead) to the nearest position whose beat phase
   *  matches the master's at that moment: never more than half a beat. */
  _alignPhase() {
    const T = this.now() + SCHEDULE_LEAD_S;
    const target = this._alignedPos(T, this.posAt(T));
    if (target !== null) this._seekAt(target, T);
  }

  /** Where this deck should be at time T so its beat phase matches the
   *  (playing) master's: own position s shifted by at most half a beat.
   *  null when there is nothing to align to. */
  _alignedPos(T, s) {
    const m = this._master;
    if (!m || !m.state.playing || !m.grid || !this.grid) return null;
    const ph = phaseAt(m.grid, m.posAt(T));
    const bi = beatIndexAt(this.grid, s);
    const n = Math.round(bi - ph) + ph;
    return clamp(timeOfBeat(this.grid, n), 0, this._duration);
  }

  // ---- loops ------------------------------------------------------------------------

  loopIn() {
    const st = this.state;
    if (!st.loaded) return;
    const L = st.loop;
    if (L.active) { L.adjust = L.adjust === "in" ? null : "in"; return; }
    L.in = this._q(this.posAt());
    L.out = null;
  }

  loopOut() {
    const st = this.state;
    if (!st.loaded) return;
    const L = st.loop;
    if (L.active) { L.adjust = L.adjust === "out" ? null : "out"; return; }
    if (L.in === null) return;
    const T = this.now();
    const s = this.posAt(T);
    let out = this._q(s);
    if (out <= L.in + MIN_LOOP_S) out = s > L.in + MIN_LOOP_S ? s : null;
    if (out === null) return;
    this._engageLoop(L.in, out, T, { wrapNow: true });
  }

  fourBeatExit() {
    const st = this.state;
    if (!st.loaded) return;
    if (st.loop.active) { this._exitLoop(); return; }
    const p = this._beatLen();
    if (!p) return;
    const T = this.now();
    const inS = this._floorTo(this.posAt(T), 1);
    this._engageLoop(inS, inS + 4 * p, T, { wrapNow: true, beats: 4 });
  }

  /** Active Loop: arm / cancel the saved loop nearest the playhead. */
  shiftFourBeatExit() {
    const st = this.state;
    if (!st.loaded) return;
    if (st.activeLoop !== null) {
      const h = st.hotCues[st.activeLoop];
      st.activeLoop = null;
      if (st.loop.active && h && st.loop.in === h.start && st.loop.out === h.end) this._exitLoop();
      return;
    }
    const s = this.posAt();
    let best = null;
    st.hotCues.forEach((h, i) => {
      if (h && h.end !== null && (best === null || Math.abs(h.start - s) < Math.abs(st.hotCues[best].start - s))) best = i;
    });
    if (best === null) return;
    const h = st.hotCues[best];
    this._engageLoop(h.start, h.end, this.now(), { wrapNow: false });
    st.activeLoop = best;
  }

  loopHalve() { this._scaleLoop(0.5); }

  loopDouble() { this._scaleLoop(2); }

  _scaleLoop(k) {
    const st = this.state;
    const L = st.loop;
    if (!st.loaded || !L.active) return;
    const len = (L.out - L.in) * k;
    if (len < MIN_LOOP_S || L.in + len > this._duration) return;
    const T = this.now();
    this._engageLoop(L.in, L.in + len, T,
      { wrapNow: true, beats: L.beats === null ? null : L.beats * k });
  }

  beatLoop(i) {
    const st = this.state;
    const beats = BEAT_LOOP_PADS[i];
    if (!st.loaded || beats === undefined) return;
    const L = st.loop;
    if (L.active && L.pad === i) { this._exitLoop(); return; }
    const p = this._beatLen();
    if (!p) return;
    const T = this.now();
    const inS = L.active && L.pad !== null ? L.in : this._floorTo(this.posAt(T), Math.min(beats, 1));
    this._engageLoop(inS, inS + beats * p, T, { wrapNow: true, beats, pad: i });
  }

  _adjustLoop(deltaDeg) {
    const L = this.state.loop;
    const d = (deltaDeg / 360) * LOOP_ADJUST_S_PER_TURN;
    if (L.adjust === "in") L.in = clamp(L.in + d, 0, L.out - MIN_LOOP_S);
    else L.out = clamp(L.out + d, L.in + MIN_LOOP_S, this._duration);
    L.beats = null;
    L.pad = null;
    this.voice.setLoop(L.in, L.out);
  }

  /** Arm the voice's loop [inS, outS). wrapNow: if the playhead is already
   *  past OUT, fold it back inside (keeps the beat for whole-beat loops). */
  _engageLoop(inS, outS, T, { wrapNow = true, beats = null, pad = null, roll = false } = {}) {
    const st = this.state;
    if (!roll) this._dropRoll();
    const s = this.posAt(T);
    const L = st.loop;
    L.in = inS; L.out = outS; L.active = true; L.beats = beats; L.pad = pad; L.adjust = null;
    st.activeLoop = null;
    this.voice.setLoop(inS, outS);
    if (wrapNow && s >= outS) this._seekNow(inS + ((s - inS) % (outS - inS)), T);
    else this._anchor = { s, t: T, rate: this._currentRate() };
  }

  _exitLoop() {
    const st = this.state;
    this._dropRoll();
    const T = this.now();
    const s = this.posAt(T);
    st.loop.active = false;
    st.loop.beats = null;
    st.loop.pad = null;
    st.loop.adjust = null;
    st.activeLoop = null;
    this.voice.setLoop(null, null);
    this._anchor = { s, t: T, rate: this._currentRate() };
  }

  // ---- roll (Beat FX) --------------------------------------------------------------

  /** Beat FX Roll held at `beats` beats (rolls now if playing, else on the
   *  next play); null releases it with slip (see header). */
  roll(beats) {
    const st = this.state;
    if (beats === null || beats === undefined) {
      this._rollHold = null;
      if (this._roll) this._endRoll(true);
      return;
    }
    if (!st.loaded || st.noGrid || !(beats > 0)) return;
    this._rollHold = beats;
    if (!st.playing || st.jogTouched) return;
    this._startRoll(beats);
  }

  /** The deck just started playing: a held roll starts. */
  _resumeRoll() {
    const st = this.state;
    if (this._rollHold === null || this._roll || !st.playing || st.jogTouched || st.noGrid) return;
    this._startRoll(this._rollHold, Math.max(this.now(), this._anchor.t));
  }

  /** The deck is pausing: the roll stops where it is, the hold stays. */
  _pauseRoll() {
    if (this._roll) this._endRoll(false);
  }

  _startRoll(beats, T = this.now()) {
    const st = this.state;
    const p = beatPeriod(this.grid);
    if (this._roll) {                               // new length: same in point, same slip
      const inS = st.roll.in;
      const outS = Math.min(inS + beats * p, this._duration);
      if (outS - inS < MIN_LOOP_S) return;
      this._engageLoop(inS, outS, T, { wrapNow: true, beats, roll: true });
      st.roll = { beats, in: inS, out: outS };
      return;
    }
    let unit = Math.min(1, beats);
    if (!Number.isInteger(Math.log2(unit))) unit = ROLL_MIN_UNIT;
    const s = this.posAt(T);
    const n = Math.floor(beatIndexAt(this.grid, s) / unit + 1e-9) * unit;
    const inS = Math.max(0, timeOfBeat(this.grid, n));
    const outS = Math.min(inS + beats * p, this._duration);
    if (outS - inS < MIN_LOOP_S) return;
    const L = st.loop;
    const prior = L.active ? { ...L } : null;
    this._dropRoll();
    this._engageLoop(inS, outS, T, { wrapNow: true, beats, roll: true });
    this._roll = { slip: { s, t: T, rate: this._playRate() }, prior };
    st.roll = { beats, in: inS, out: outS };
  }

  /** Where playback would be at T without the roll. */
  _slipAt(T, r = this._roll) {
    return extrapolate(r.slip, r.prior, T, this._duration);
  }

  /** End the roll: back to the slip position (slip) or stay where it is. */
  _endRoll(slip) {
    const st = this.state;
    const r = this._roll;
    this._roll = null;
    st.roll = null;
    const moving = st.playing && !st.jogTouched;
    const T = this.now() + (slip && moving ? SCHEDULE_LEAD_S : 0);
    const target = slip ? this._slipAt(T, r) : this.posAt(T);
    if (r.prior) {
      st.loop = { ...r.prior, adjust: null };
      this.voice.setLoop(r.prior.in, r.prior.out, T);
    } else {
      st.loop = { ...st.loop, active: false, beats: null, pad: null, adjust: null };
      this.voice.setLoop(null, null, T);
    }
    if (!slip) { this._anchor = { s: target, t: T, rate: this._currentRate() }; return; }
    if (moving) this._seekAt(target, T);
    else this._seekNow(target, T);
  }

  /** Another loop action took over: forget the slip, keep the loop state. */
  _dropRoll() {
    if (!this._roll) return;
    this._roll = null;
    this.state.roll = null;
  }

  // ---- pads: hot cue, beat jump -------------------------------------------------------

  hotCue(i) {
    const st = this.state;
    if (!st.loaded || i < 0 || i > 7) return;
    const h = st.hotCues[i];
    const T = this.now();
    if (!h) {
      const L = st.loop;
      st.hotCues[i] = L.active
        ? { start: L.in, end: L.out }
        : { start: this._q(this.posAt(T)), end: null };
      return;
    }
    const wasPlaying = st.playing;
    if (h.end !== null) {
      this._go(h.start, wasPlaying);
      this._engageLoop(h.start, h.end, this.now(), { wrapNow: false });
    } else {
      if (st.loop.active) this._exitLoop();
      this._go(h.start, wasPlaying);
    }
    if (!wasPlaying) {
      st.playing = true;
      if (!st.jogTouched) {
        this.voice.setRate(this._playRate());
        this.voice.play();
      }
      this._anchor = { ...this._anchor, rate: this._currentRate() };
      this._resumeRoll();
    }
  }

  shiftHotCue(i) {
    const st = this.state;
    if (!st.loaded || i < 0 || i > 7) return;
    st.hotCues[i] = null;
    if (st.activeLoop === i) st.activeLoop = null;
  }

  beatJump(i) {
    const st = this.state;
    const pad = BEAT_JUMP_PADS[i];
    if (!st.loaded || pad === undefined) return;
    const p = this._beatLen();
    if (!p) return;
    const d = pad * 2 ** st.beatJumpScale * p;
    const moving = st.playing || st.jogTouched;
    const T = this.now() + (moving ? SCHEDULE_LEAD_S : 0);
    const target = clamp(this.posAt(T) + d, 0, this._duration);
    const L = st.loop;
    if (L.active && L.in + d >= 0 && L.out + d <= this._duration) {
      L.in += d; L.out += d;                     // the loop travels with the jump
      this.voice.setLoop(L.in, L.out);
    }
    if (moving) this._seekAt(target, T);
    else this._seekNow(target, T);
  }

  /** SHIFT + pad 7 / 8 in Beat Jump mode: fewer / more beats on every pad. */
  shiftBeatJump(i) {
    const st = this.state;
    if (!st.loaded) return;
    if (i === 6) st.beatJumpScale = Math.max(BEAT_JUMP_SCALE_MIN, st.beatJumpScale - 1);
    else if (i === 7) st.beatJumpScale = Math.min(BEAT_JUMP_SCALE_MAX, st.beatJumpScale + 1);
  }

  // ---- internals ------------------------------------------------------------------

  _baseRate() {
    if (this._syncRate !== null) return this._syncRate;
    if (this._heldRate !== null) return this._heldRate;
    return 1 + (this.state.range / 100) * (2 * this._fader - 1);
  }

  _playRate() { return this._baseRate() * (1 + this._bend); }

  _currentRate() {
    if (this.state.jogTouched) return this._scratchRate;
    return this.state.playing ? this._playRate() : 0;
  }

  _applyRate() {
    const st = this.state;
    st.tempoPct = (this._baseRate() - 1) * 100;
    if (!st.loaded) return;
    const T = this.now();
    const s = this.posAt(T);
    if (!st.jogTouched) this.voice.setRate(this._playRate());
    this._anchor = { s, t: T, rate: this._currentRate() };
    if (this._roll) this._roll.slip = { s: this._slipAt(T), t: T, rate: this._playRate() };
  }

  _tempoChanged() {
    this._applyRate();
    for (const f of this._followers) f._followMaster();
  }

  _report(s, t) {
    if (t < this._holdUntil) return;          // older than a jump we asked for
    this._anchor = { s, t, rate: this._currentRate() };
  }

  _seekNow(s, T) {
    this.voice.seek(s);
    this._holdUntil = T;
    this._anchor = { s, t: T, rate: this._currentRate() };
  }

  _seekAt(s, T) {
    this.voice.seek(s, T);
    this._holdUntil = T;
    this._anchor = { s, t: T, rate: this._currentRate() };
  }

  /** Hot cue call: quantized and moving = same beat phase, scheduled; else now. */
  _go(start, moving) {
    const g = this.grid;
    if (moving && this.state.quantize && !this.state.noGrid) {
      const T = this.now() + SCHEDULE_LEAD_S;
      const dph = phaseAt(g, this.posAt(T)) - phaseAt(g, start);
      const k = dph - Math.floor(dph);
      this._seekAt(clamp(start + k * beatPeriod(g), 0, this._duration), T);
    } else {
      this._seekNow(start, this.now());
    }
  }

  _q(s) {
    return this.state.quantize && !this.state.noGrid ? quantize(this.grid, s) : s;
  }

  _floorTo(s, unit) {
    if (!this.state.quantize || this.state.noGrid) return s;
    const n = Math.floor(beatIndexAt(this.grid, s) / unit + 1e-9) * unit;
    return timeOfBeat(this.grid, n);
  }

  _beatLen() {
    if (this.grid && this.grid.bpm > 0) return beatPeriod(this.grid);
    const bpm = this.track && this.track.meta && this.track.meta.bpm;
    return bpm > 0 ? 60 / bpm : null;
  }

  _stopTimer(name) {
    if (this[name] !== null) this._clearTimeout(this[name]);
    this[name] = null;
  }

  _clearTimers() {
    this._stopTimer("_scratchTimer");
    this._stopTimer("_bendTimer");
  }
}

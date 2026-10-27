// A Cabine: beat grid math. Pure functions, no DOM, no Web Audio.
//
// `g` is the server Grid (djlab/grid.py): {bpm, first_beat_s, downbeat_s,
// beat_cv, reliable, source, fixed}. The loader adds `offset_s` (the carried
// file's offset against the source, meta.carry_offset_s, default 0); every
// grid time below is shifted by it, so callers work in carried-file seconds.

const off = (g) => (Number.isFinite(g.offset_s) ? g.offset_s : 0);
const frac = (x) => {
  const f = x - Math.floor(x);
  return f >= 1 ? 0 : f;                 // floor of a tiny negative can round f up to 1
};

/** Seconds per beat. */
export function beatPeriod(g) {
  return 60 / g.bpm;
}

/** Fractional beat index of time t (beat 0 = first_beat_s). */
export function beatIndexAt(g, t) {
  return (t - (g.first_beat_s + off(g))) / beatPeriod(g);
}

/** Time of (possibly fractional) beat index n. */
export function timeOfBeat(g, n) {
  return g.first_beat_s + off(g) + n * beatPeriod(g);
}

/** Time of the grid beat nearest t. */
export function nearestBeatTime(g, t) {
  return timeOfBeat(g, Math.round(beatIndexAt(g, t)));
}

/** Quantize a time to the grid (nearest beat). */
export function quantize(g, t) {
  return nearestBeatTime(g, t);
}

/** Position inside the beat, in [0, 1). */
export function phaseAt(g, t) {
  return frac(beatIndexAt(g, t));
}

/** Position inside the bar, in beats [0, 4), 0 at downbeat_s. */
export function barPhaseAt(g, t) {
  const b = (t - (g.downbeat_s + off(g))) / beatPeriod(g);
  const f = b - 4 * Math.floor(b / 4);
  return f >= 4 ? 0 : f;
}

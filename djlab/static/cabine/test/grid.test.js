import { test } from "node:test";
import assert from "node:assert/strict";

import {
  beatPeriod, beatIndexAt, timeOfBeat, nearestBeatTime, quantize, phaseAt, barPhaseAt,
} from "../engine/grid.js";

const g120 = { bpm: 120, first_beat_s: 0, downbeat_s: 0, beat_cv: 0.01, reliable: true };
const g = { bpm: 128.5, first_beat_s: 0.231, downbeat_s: 1.164, beat_cv: 0.02, reliable: true };

test("beat period is 60 / bpm", () => {
  assert.equal(beatPeriod(g120), 0.5);
});

test("timeOfBeat inverts beatIndexAt", () => {
  for (const t of [0, 0.1, 3.7, 61.234, 599.99]) {
    assert.ok(Math.abs(timeOfBeat(g, beatIndexAt(g, t)) - t) < 1e-9, `t=${t}`);
  }
  assert.ok(Math.abs(beatIndexAt(g, 0.231)) < 1e-12);
});

test("quantize snaps 0.49 to 0.5 at 120 BPM, first beat 0", () => {
  assert.equal(quantize(g120, 0.49), 0.5);
  assert.equal(quantize(g120, 0.74), 0.5);
  assert.equal(quantize(g120, 0.76), 1.0);
  assert.equal(nearestBeatTime(g120, 10.2), 10.0);
});

test("phase is in [0, 1) and 0 on a beat", () => {
  assert.ok(Math.abs(phaseAt(g120, 10.0)) < 1e-12);
  assert.ok(Math.abs(phaseAt(g120, 10.125) - 0.25) < 1e-12);
  const p = phaseAt(g120, -0.125);          // before the first beat
  assert.ok(p >= 0 && p < 1 && Math.abs(p - 0.75) < 1e-12);
  for (let i = 0; i < 200; i++) {
    const v = phaseAt(g, i * 0.4687);
    assert.ok(v >= 0 && v < 1, `phase ${v}`);
  }
});

test("bar phase is 0 at the downbeat and counts beats to 4", () => {
  assert.ok(Math.abs(barPhaseAt(g, g.downbeat_s)) < 1e-9);
  const p = beatPeriod(g);
  assert.ok(Math.abs(barPhaseAt(g, g.downbeat_s + 2.5 * p) - 2.5) < 1e-9);
  assert.ok(Math.abs(barPhaseAt(g, g.downbeat_s + 4 * p)) < 1e-9);
  const before = barPhaseAt(g, g.downbeat_s - p);     // beat 4 of the bar before
  assert.ok(Math.abs(before - 3) < 1e-9);
  for (let i = 0; i < 200; i++) {
    const v = barPhaseAt(g, i * 0.37);
    assert.ok(v >= 0 && v < 4, `bar phase ${v}`);
  }
});

test("offset_s (carry offset) shifts every grid time", () => {
  const go = { ...g120, offset_s: 0.01 };
  assert.ok(Math.abs(timeOfBeat(go, 2) - 1.01) < 1e-12);
  assert.ok(Math.abs(quantize(go, 0.49) - 0.51) < 1e-12);
  assert.ok(Math.abs(phaseAt(go, 0.51)) < 1e-12);
  assert.ok(Math.abs(barPhaseAt(go, 0.01)) < 1e-12);
  const gn = { ...g120, offset_s: undefined };
  assert.equal(timeOfBeat(gn, 2), 1.0);
});

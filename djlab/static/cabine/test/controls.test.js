import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Knob, Encoder, Fader, XFader, Button, Pad, Jog, Lever,
  KNOB_SWEEP_PX, TEMPO_FINE_HOLD_MS, TEMPO_FINE_SCALE, JOG_TOP_PLATE_RATIO, RING_BEND_GAIN,
  angleDelta, jogZone, faderDelta,
} from "../ui/controls.js";
import { FakeEl, fakeClock } from "./fake-dom.js";

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test("knob_sweep_and_double_tap_reset", () => {
  assert.equal(KNOB_SWEEP_PX, 180);
  const clock = fakeClock();
  const el = new FakeEl({ left: 0, top: 0, width: 20, height: 20 });
  const got = [];
  const k = new Knob(el, { def: 0.5, value: 0 }, (v) => got.push(v), clock);
  el.fire("pointerdown", 1, 10, 300);
  el.fire("pointermove", 1, 10, 210);                         // 90 px up = half the sweep
  assert.ok(near(got.at(-1), 0.5), `half sweep: ${got.at(-1)}`);
  el.fire("pointermove", 1, 400, 120);                        // 180 px up, finger far off the knob
  assert.ok(near(got.at(-1), 1), "full sweep is 180 px, still captured off the knob");
  el.fire("pointermove", 1, 10, 0);
  assert.equal(got.at(-1), 1, "clamped at the end");
  el.fire("pointerup", 1, 10, 0);
  assert.ok(near(k.value, 1));
  // a second finger on the same knob is ignored while the first holds it
  el.fire("pointerdown", 2, 10, 100);
  el.fire("pointerdown", 3, 10, 100);
  el.fire("pointermove", 3, 10, 300);
  assert.ok(near(k.value, 1), "one pointer per widget");
  el.fire("pointerup", 2, 10, 100);
  // double tap = default
  clock.advance(1000);
  el.fire("pointerdown", 4, 10, 100); el.fire("pointerup", 4, 10, 100);
  clock.advance(150);
  el.fire("pointerdown", 5, 11, 101);
  assert.equal(got.at(-1), 0.5, "double tap resets to the default");
  el.fire("pointerup", 5, 11, 101);
  // two taps too far apart in time are not a double tap
  const n = got.length;
  clock.advance(1000);
  el.fire("pointerdown", 6, 10, 100); el.fire("pointerup", 6, 10, 100);
  clock.advance(600);
  el.fire("pointerdown", 7, 10, 100); el.fire("pointerup", 7, 10, 100);
  assert.equal(got.length, n, "slow taps change nothing");
});

test("knob_center_detent_and_cancel", () => {
  const el = new FakeEl();
  const got = [];
  const k = new Knob(el, { def: 0.5, value: 0.4, detent: true }, (v) => got.push(v), fakeClock());
  el.fire("pointerdown", 1, 0, 100);
  el.fire("pointermove", 1, 0, 84);                           // 0.4 + 16/180 = 0.489: inside the detent
  assert.equal(got.at(-1), 0.5, "EQ and CFX hold their center");
  el.fire("pointermove", 1, 0, 60);                           // 0.622: out of it
  assert.ok(got.at(-1) > 0.6);
  el.fire("pointercancel", 1, 0, 60);
  el.fire("pointermove", 1, 0, 0);
  assert.ok(k.value < 0.7, "pointercancel releases the knob");
  el.fire("pointerdown", 2, 0, 0);
  assert.ok(el.hasPointerCapture(2), "a new touch captures it again");
});

test("fader_full_length_and_tempo_fine_mode", () => {
  const clock = fakeClock();
  // a 200 px track: box 220 px tall with a 20 px cap
  const el = new FakeEl({ left: 0, top: 0, width: 20, height: 220 });
  const got = [];
  const f = new Fader(el, { dir: "down", tempo: true, value: 0.5, cap: { h: 10 }, h: 110 }, (v) => got.push(v), clock);
  assert.equal(f.travelPx(), 200);
  el.fire("pointerdown", 1, 10, 110);
  el.fire("pointermove", 1, 10, 210);                         // 100 px down: +0.5
  assert.ok(near(got.at(-1), 1), `down = larger value (faster): ${got.at(-1)}`);
  el.fire("pointermove", 1, 10, 110);
  assert.ok(near(got.at(-1), 0.5));
  clock.advance(TEMPO_FINE_HOLD_MS + 1);                      // held still: fine mode
  assert.ok(el.classList.contains("cab-fine"));
  el.fire("pointermove", 1, 10, 118);                         // 8 px = one coarse px
  assert.ok(near(got.at(-1), 0.5 + 1 / 200), `1:${TEMPO_FINE_SCALE}: ${got.at(-1)}`);
  el.fire("pointerup", 1, 10, 118);
  assert.ok(!el.classList.contains("cab-fine"));
  // a moving finger never enters fine mode
  el.fire("pointerdown", 2, 10, 100);
  for (let i = 1; i <= 10; i++) { clock.advance(100); el.fire("pointermove", 2, 10, 100 + 4 * i); }
  assert.ok(!el.classList.contains("cab-fine"));
  el.fire("pointerup", 2, 10, 140);
  // a channel fader: 1 at the top, no fine mode
  const ch = new FakeEl({ left: 0, top: 0, width: 20, height: 120 });
  const cv = [];
  new Fader(ch, { dir: "up", value: 1, cap: { h: 10 }, h: 60 }, (v) => cv.push(v), clock);
  ch.fire("pointerdown", 3, 10, 10);
  clock.advance(500);
  assert.ok(!ch.classList.contains("cab-fine"), "fine mode is the tempo fader's");
  ch.fire("pointermove", 3, 10, 60);
  assert.ok(near(cv.at(-1), 0.5), `up fader: ${cv.at(-1)}`);
  assert.ok(near(faderDelta(50, 100, false), 0.5));
});

test("xfader_is_horizontal", () => {
  const el = new FakeEl({ left: 0, top: 0, width: 120, height: 20 });
  const got = [];
  new XFader(el, { value: 0.5, cap: { w: 2 }, w: 12 }, (v) => got.push(v), fakeClock());
  el.fire("pointerdown", 1, 60, 10);
  el.fire("pointermove", 1, 110, 80);
  assert.ok(near(got.at(-1), 1), `right = 1: ${got.at(-1)}`);
  el.fire("pointermove", 1, 10, 0);
  assert.ok(near(got.at(-1), 0));
});

test("buttons_pads_and_lever", () => {
  const el = new FakeEl();
  const got = [];
  new Button(el, {}, (v) => got.push(v), fakeClock());
  el.fire("pointerdown", 1, 5, 5);
  el.fire("pointerleave", 1, 500, 500);
  el.fire("pointermove", 1, 500, 500);
  el.fire("pointerup", 1, 500, 500);
  assert.deepEqual(got, [true, false], "down then up, even when the finger slid off");
  el.fire("pointerdown", 2, 5, 5);
  el.fire("pointercancel", 2, 5, 5);
  assert.deepEqual(got, [true, false, true, false], "cancel releases");
  const p = new FakeEl();
  const pg = [];
  new Pad(p, {}, (v) => pg.push(v), fakeClock());
  p.fire("pointerdown", 3); p.fire("pointerup", 3);
  assert.deepEqual(pg, [true, false]);
  const l = new FakeEl();
  const lg = [];
  new Lever(l, { positions: [{ value: "1" }, { value: "2" }, { value: "master" }], def: 0 }, (v) => lg.push(v), fakeClock());
  for (let i = 0; i < 4; i++) { l.fire("pointerdown", 10 + i); l.fire("pointerup", 10 + i); }
  assert.deepEqual(lg, [1, 2, 0, 1], "tap cycles 1 > 2 > 1&2 > 1");
});

test("encoder_turns_in_steps_and_presses_on_tap", () => {
  const el = new FakeEl();
  const got = [];
  new Encoder(el, {}, (v) => got.push(v), fakeClock());
  el.fire("pointerdown", 1, 50, 50); el.fire("pointerup", 1, 51, 50);
  assert.deepEqual(got, [{ press: true }]);
  el.fire("pointerdown", 2, 50, 200);
  el.fire("pointermove", 2, 50, 140);                         // drag up = clockwise
  el.fire("pointerup", 2, 50, 140);
  const turns = got.slice(1).reduce((s, e) => s + (e.turn || 0), 0);
  assert.ok(turns >= 2, `steps: ${JSON.stringify(got)}`);
  assert.ok(!got.slice(1).some((e) => e.press), "a drag is not a press");
});

test("jog_radius_split_inner_vs_ring", () => {
  assert.equal(JOG_TOP_PLATE_RATIO, 0.62);
  assert.ok(RING_BEND_GAIN > 0 && RING_BEND_GAIN < 1);
  assert.equal(jogZone(0, 0, 100), "plate");
  assert.equal(jogZone(61, 0, 100), "plate");
  assert.equal(jogZone(63, 0, 100), "ring");
  assert.equal(jogZone(99, 0, 100), "ring");
  assert.equal(jogZone(80, 80, 100), null, "outside the wheel");
  assert.equal(angleDelta(350, 10), 20);
  assert.equal(angleDelta(10, 350), -20);

  const el = new FakeEl({ left: 0, top: 0, width: 200, height: 200 });  // center 100,100, R 100
  const got = [];
  new Jog(el, {}, (e) => got.push(e), fakeClock());
  // top plate: touch, a quarter turn clockwise (screen y down), release
  el.fire("pointerdown", 1, 150, 100);                         // r = 50: plate
  el.fire("pointermove", 1, 100, 150);
  el.fire("pointerup", 1, 100, 150);
  assert.deepEqual(got[0], { touch: true });
  const turn = got.filter((e) => "turn" in e).reduce((s, e) => s + e.turn, 0);
  assert.ok(near(turn, 90, 1e-6), `angle-faithful: ${turn}`);
  assert.deepEqual(got.at(-1), { touch: false });
  // outer ring: no touch event, bend deltas scaled by RING_BEND_GAIN
  got.length = 0;
  el.fire("pointerdown", 2, 190, 100);                         // r = 90: ring
  el.fire("pointermove", 2, 100, 190);                         // finger stays on the ring
  el.fire("pointermove", 2, 300, 300);                         // and slides far off: still the jog's
  el.fire("pointerup", 2, 300, 300);
  assert.ok(!got.some((e) => "touch" in e || "turn" in e), JSON.stringify(got));
  const ring = got.filter((e) => "ring" in e);
  assert.ok(near(ring[0].ring, 90 * RING_BEND_GAIN, 1e-6), `ring: ${ring[0].ring}`);
  assert.equal(ring.length, 2);
  // the corner of the box is not the wheel
  got.length = 0;
  el.fire("pointerdown", 3, 5, 5);
  el.fire("pointermove", 3, 50, 5);
  assert.deepEqual(got, []);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Knob, Encoder, Fader, XFader, Button, Pad, Jog, Lever, TouchRouter,
  KNOB_SWEEP_PX, TEMPO_FINE_HOLD_MS, TEMPO_FINE_SCALE, JOG_TOP_PLATE_RATIO, RING_BEND_GAIN,
  JOG_HUB_RATIO, JOG_MAX_STEP_DEG, angleDelta, jogZone, faderDelta, fineScale,
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
  assert.ok(near(faderDelta(50, 100), 0.5));
  assert.ok(near(faderDelta(50, 100, 10), 0.05));
  assert.equal(fineScale(200), TEMPO_FINE_SCALE, "1:8 on a long fader");
  assert.equal(fineScale(70), 9, "finer on the iPhone's ~70 px track");
  assert.equal(fineScale(64), 10);
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
  assert.equal(JOG_TOP_PLATE_RATIO, 0.80, "the FLX4's plate edge (ruling R24)");
  assert.ok(RING_BEND_GAIN > 0 && RING_BEND_GAIN < 1);
  assert.equal(jogZone(0, 0, 100), "plate");
  assert.equal(jogZone(79, 0, 100), "plate");
  assert.equal(jogZone(81, 0, 100), "ring");
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

test("jog_line_through_the_hub_emits_no_turn", () => {
  assert.ok(JOG_HUB_RATIO >= 0.15 && JOG_HUB_RATIO <= 0.2);
  const el = new FakeEl({ left: 0, top: 0, width: 148, height: 148 });   // the iPhone's jog, R 74
  const got = [];
  new Jog(el, {}, (e) => got.push(e), fakeClock());
  // a finger sliding straight left across the center, 4 px right to 4 px left, in 1 px steps
  el.fire("pointerdown", 1, 78, 74);
  for (let x = 77; x >= 70; x--) el.fire("pointermove", 1, x, 74);
  // a 1 px wobble at r = 3 px
  for (let i = 0; i < 6; i++) el.fire("pointermove", 1, 77, 74 + (i % 2 ? 1 : -1));
  el.fire("pointerup", 1, 70, 74);
  assert.deepEqual(got.filter((e) => "turn" in e), [], JSON.stringify(got));
  assert.deepEqual(got, [{ touch: true }, { touch: false }]);

  // through the hub and out the far side: re-anchors there, then turns normally
  got.length = 0;
  el.fire("pointerdown", 2, 74 + 40, 74);                          // r = 40, plate, angle 0
  el.fire("pointermove", 2, 74, 74);                               // center: dropped
  el.fire("pointermove", 2, 74 - 40, 74);                          // out at 180 degrees: re-anchor only
  el.fire("pointermove", 2, 74, 74 - 40);                          // a real quarter turn clockwise (180 -> 270)
  el.fire("pointerup", 2, 74, 34);
  const turns = got.filter((e) => "turn" in e).map((e) => e.turn);
  assert.equal(turns.length, 1);
  assert.ok(near(turns[0], 90, 1e-6), JSON.stringify(turns));

  // a jump between two events is capped
  got.length = 0;
  el.fire("pointerdown", 3, 74 + 50, 74);
  el.fire("pointermove", 3, 74 - 35, 74 + 35);                     // 135 degrees in one event
  el.fire("pointerup", 3, 39, 109);
  assert.equal(got.find((e) => "turn" in e).turn, JOG_MAX_STEP_DEG);
});

test("router_hands_a_zone_touch_to_its_widget_with_capture", () => {
  // the section answers for its small parts: a touch anywhere in a part's
  // zone is that part's, captured on the section, one pointer per part
  const clock = fakeClock();
  const sec = new FakeEl({ left: 0, top: 0, width: 300, height: 200 });
  const knobEl = new FakeEl(), shiftEl = new FakeEl(), padEl = new FakeEl();
  const got = [];
  const knob = new Knob(knobEl, { def: 0.5, value: 0.5 }, (v) => got.push(["knob", v]), { ...clock, routed: sec });
  const shift = new Button(shiftEl, {}, (v) => got.push(["shift", v]), { ...clock, routed: sec });
  const pad = new Pad(padEl, {}, (v) => got.push(["pad", v]), { ...clock, routed: sec });
  assert.equal(knobEl.listeners.size, 0, "a routed widget does not listen on its drawn element");
  // zones: x < 100 knob, 100..200 shift, 200.. pad, y > 150 nobody
  const router = new TouchRouter(sec, (e) => (e.clientY > 150 ? null : e.clientX < 100 ? knob : e.clientX < 200 ? shift : pad));
  sec.fire("pointerdown", 1, 150, 10);                       // SHIFT held
  assert.deepEqual(got.at(-1), ["shift", true]);
  assert.ok(sec.captured.has(1) && shiftEl.classes.has("cab-held"));
  sec.fire("pointerdown", 2, 40, 100);                        // a drag starting at the knob zone's edge
  sec.fire("pointermove", 2, 250, 10);                        // slides over the pad's zone: still the knob
  assert.deepEqual(got.at(-1), ["knob", 1], "the knob: 90 px up = +0.5, capture kept");
  assert.ok(!got.some(([k]) => k === "pad"));
  sec.fire("pointerdown", 3, 250, 50);                        // pad while SHIFT and the knob are held
  assert.deepEqual(got.at(-1), ["pad", true]);
  sec.fire("pointerdown", 4, 120, 50);                        // a second finger on SHIFT: ignored
  sec.fire("pointerup", 4, 120, 50);
  assert.equal(got.filter(([k]) => k === "shift").length, 1, "one pointer per widget");
  sec.fire("pointerdown", 5, 50, 180);                        // nobody's zone: nothing
  sec.fire("pointerup", 5, 50, 180);
  sec.fire("pointercancel", 2, 250, 10);                      // cancel = release
  assert.equal(knob.pid, null);
  sec.fire("pointermove", 2, 250, 300);
  assert.deepEqual(got.filter(([k]) => k === "knob").at(-1), ["knob", 1], "after cancel the knob holds nothing");
  sec.fire("pointerup", 3, 250, 50);
  sec.fire("pointerup", 1, 150, 10);
  assert.deepEqual(got.at(-1), ["shift", false]);
  assert.ok(!sec.captured.has(1) && !shiftEl.classes.has("cab-held"));
  // a lost capture releases too
  sec.fire("pointerdown", 6, 150, 10);
  sec.fire("lostpointercapture", 6, 150, 10);
  assert.deepEqual(got.at(-1), ["shift", false]);
  // the knob's double tap works through the router
  sec.fire("pointerdown", 7, 40, 100); sec.fire("pointerup", 7, 40, 100);
  clock.advance(100);
  sec.fire("pointerdown", 8, 42, 100); sec.fire("pointerup", 8, 42, 100);
  assert.deepEqual(got.at(-1), ["knob", 0.5]);
  router.destroy();
  assert.equal(sec.listeners.get("pointerdown").size, 0);
});

test("fader_cap_set_by_the_layout_sets_the_travel", () => {
  // phone layout: the tempo box is re-proportioned, its cap is not the photo's
  // share of the box; the layout tells the widget, the travel follows
  const el = new FakeEl({ left: 0, top: 0, width: 24, height: 250 });
  const got = [];
  const f = new Fader(el, { dir: "down", cap: { w: 3.68, h: 7.40 }, w: 3.68, h: 32.74, value: 0 }, (v) => got.push(v), fakeClock());
  assert.ok(Math.abs(f.travelPx() - 250 * (1 - 7.40 / 32.74)) < 1e-9, "the photo's cap share by default");
  f.setCap({ w: 1, h: 25 / 250 });
  assert.ok(Math.abs(f.travelPx() - 225) < 1e-9);
  el.fire("pointerdown", 1, 10, 0);
  el.fire("pointermove", 1, 10, 225);
  assert.ok(Math.abs(got.at(-1) - 1) < 1e-9, "the whole new travel is the whole range");
  el.fire("pointerup", 1, 10, 225);
});

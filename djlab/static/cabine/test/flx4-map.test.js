import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONTROLS, INDICATORS, BOARD_ASPECT, DECK2_DX, PAD_MODES, STRIP_ACTIONS, BOARD_ACTIONS,
  DRAWN_ONLY, HOT_CUE_COLOURS,
} from "../flx4-map.js";
import { DECK_ACTIONS, TEMPO_RANGES } from "../engine/deck.js";
import { MIXER_ACTIONS } from "../engine/mixer.js";
import { BEATFX_ACTIONS } from "../engine/fx.js";
import { SAMPLER_ACTIONS } from "../engine/sampler.js";
import {
  fitBoard, placeBox, sectionOf, placeControls, faderCap, LAYOUT, LAYOUTS, STRIP_SHARE, XFADER_CLEAR_PX, SAFE_FALLBACK,
} from "../ui/board-layout.js";
import { faderDelta, fineScale, TEMPO_FINE_SCALE } from "../ui/controls.js";

const byId = new Map(CONTROLS.map((c) => [c.id, c]));

// Spec section 5, every "works" control, both decks.
const DECK_V1 = ["play", "cue", "jog", "tempo", "sync", "in", "out", "4beat", "call-prev", "call-next",
  "shift", "mode-hotcue", "mode-beatjump", "mode-sampler",
  "pad1", "pad2", "pad3", "pad4", "pad5", "pad6", "pad7", "pad8"];
const MIXER_V1 = ["ch1-trim", "ch1-hi", "ch1-mid", "ch1-low", "ch1-cfx", "ch1-cue", "ch1-fader",
  "ch2-trim", "ch2-hi", "ch2-mid", "ch2-low", "ch2-cfx", "ch2-cue", "ch2-fader",
  "xfader", "master-level", "master-cue", "phones-mix", "phones-level", "browse", "load1", "load2"];
const FX_V1 = ["fx-ch", "fx-select", "fx-beat-down", "fx-beat-up", "fx-level", "fx-on"];

test("every_v1_control_from_spec_present", () => {
  const want = [...[1, 2].flatMap((d) => DECK_V1.map((id) => `d${d}-${id}`)), ...MIXER_V1, ...FX_V1];
  for (const id of want) {
    const c = byId.get(id);
    assert.ok(c, `missing ${id}`);
    assert.equal(c.v1, true, `${id} must work in v1`);
  }
  assert.equal(new Set(CONTROLS.map((c) => c.id)).size, CONTROLS.length, "ids are unique");
  for (const c of CONTROLS) {
    assert.ok(["deck", "mixer", "fx", "browse"].includes(c.section), `${c.id} section`);
    assert.ok(["button", "knob", "encoder", "fader", "xfader", "jog", "pad", "lever"].includes(c.kind), c.id);
    assert.ok(c.deck === null || c.deck === 1 || c.deck === 2, `${c.id} deck`);
    for (const k of ["x", "y", "w", "h"]) assert.ok(Number.isFinite(c[k]), `${c.id}.${k}`);
    assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= 100 && c.y + c.h <= 100, `${c.id} inside the panel`);
  }
  // the CH SELECT lever's third position reads 1&2 (the manual), driving the "master" target
  assert.deepEqual(byId.get("fx-ch").positions.map((p) => p.label), ["1", "2", "1&2"]);
  assert.deepEqual(byId.get("fx-ch").positions.map((p) => p.value), ["1", "2", "master"]);
  assert.match(HOT_CUE_COLOURS.cue, /^#[0-9a-f]{6}$/);
});

// boxes in units of the panel height, so circles stay round
const phys = (b) => ({ x: b.x * BOARD_ASPECT, y: b.y, w: b.w * BOARD_ASPECT, h: b.h });

function intersects(a, b) {
  const A = phys(a), B = phys(b);
  const rectHit = A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h;
  if (!rectHit) return false;
  // a jog is a disc: only its circle counts (the boxes' corners are empty panel)
  const disc = a.kind === "jog" ? A : b.kind === "jog" ? B : null;
  if (!disc) return true;
  const other = disc === A ? B : A;
  const r = disc.w / 2, cx = disc.x + r, cy = disc.y + disc.h / 2;
  const nx = Math.max(other.x, Math.min(cx, other.x + other.w));
  const ny = Math.max(other.y, Math.min(cy, other.y + other.h));
  return Math.hypot(nx - cx, ny - cy) < r;
}

test("no_overlaps", () => {
  const all = [...CONTROLS, ...INDICATORS];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      assert.ok(!intersects(all[i], all[j]), `${all[i].id} overlaps ${all[j].id}`);
    }
  }
  // every part sits inside one section (deck 1 | mixer | deck 2), so the spread
  // layout can move the sections apart without cutting a part in two
  for (const c of [...CONTROLS, ...INDICATORS]) {
    const sec = sectionOf(c.x);
    assert.ok(c.x >= sec.x0 && c.x + c.w <= sec.x1, `${c.id} crosses into another section`);
    if (c.section === "deck") assert.equal(sec.key, `deck${c.deck}`, c.id);
    else assert.equal(sec.key, "mixer", c.id);
  }
  // the jog is drawn round: its box is square in panel units
  const jog = byId.get("d1-jog");
  assert.ok(Math.abs(jog.w * BOARD_ASPECT - jog.h) < 0.1, "jog box is square on the panel");
});

test("deck2_mirrors_deck1_where_hardware_does", () => {
  // The FLX4 repeats deck 1 for deck 2 (a copy shifted right, not a mirror image):
  // tempo right of the jog, CUE and PLAY at the left edge, on both decks.
  const d1 = CONTROLS.filter((c) => c.deck === 1 && c.section === "deck");
  const d2 = CONTROLS.filter((c) => c.deck === 2 && c.section === "deck");
  assert.equal(d1.length, d2.length);
  assert.ok(Math.abs(DECK2_DX - 65.37) < 0.05, "measured deck offset");
  for (const a of d1) {
    const b = byId.get(a.id.replace(/^d1-/, "d2-"));
    assert.ok(b, `deck 2 lacks ${a.id}`);
    assert.ok(Math.abs(b.x - (a.x + DECK2_DX)) < 0.011, `${b.id} x`);
    for (const k of ["y", "w", "h", "kind", "label", "action", "shift", "up", "v1", "index"]) {
      assert.deepEqual(b[k], a[k], `${b.id}.${k}`);
    }
  }
  for (const d of [1, 2]) {
    const t = byId.get(`d${d}-tempo`), j = byId.get(`d${d}-jog`), p4 = byId.get(`d${d}-pad4`);
    assert.ok(t.x > j.x + j.w / 2 && t.x > p4.x + p4.w, `deck ${d}: tempo at the deck's right edge`);
    assert.ok(byId.get(`d${d}-play`).x < byId.get(`d${d}-pad1`).x, `deck ${d}: PLAY at the left`);
  }
  // the mixer's channel strips are the other "copy": channel 2 = channel 1 shifted
  for (const id of ["trim", "hi", "mid", "low", "cfx", "cue", "fader"]) {
    const a = byId.get(`ch1-${id}`), b = byId.get(`ch2-${id}`);
    assert.ok(Math.abs(b.x - a.x - 8.29) < 0.011 && b.y === a.y, `ch2-${id}`);
    assert.equal(a.deck, 1); assert.equal(b.deck, 2);
  }
});

test("drawn_only_set_matches_spec", () => {
  const off = CONTROLS.filter((c) => c.v1 === false).map((c) => c.id).sort();
  assert.deepEqual(off, ["d1-mode-padfx1", "d2-mode-padfx1", "mic-level", "smart-cfx", "smart-fader"]);
  for (const c of CONTROLS.filter((x) => x.v1 === false)) {
    assert.equal(c.action, "board.notYet", `${c.id} only says not yet`);
  }
  const names = ["Mic", "Smart CFX", "Smart Fader", "PAD FX1", "PAD FX2", "KEYBOARD", "KEY SHIFT",
    "CUE/LOOP CALL memory cues"];
  assert.deepEqual(Object.keys(DRAWN_ONLY).sort(), names.sort());
  for (const [name, refs] of Object.entries(DRAWN_ONLY)) {
    for (const ref of refs) {
      const [id, layer] = ref.split(":");
      const c = byId.get(id);
      assert.ok(c, `${name}: ${id}`);
      if (layer === "shift") assert.equal(c.shift, "board.notYet", `${name}: SHIFT + ${id}`);
      else assert.equal(c.v1, false, `${name}: ${id} drawn only`);
    }
  }
  // the SHIFT legends drawn under the pad mode buttons match the hardware
  assert.deepEqual(["hotcue", "padfx1", "beatjump", "sampler"].map((m) => byId.get(`d1-mode-${m}`).sub),
    ["KEYBOARD", "PAD FX2", "BEAT LOOP", "KEY SHIFT"]);
});

test("every_action_names_an_existing_method", () => {
  const lists = { deck: DECK_ACTIONS, mixer: MIXER_ACTIONS, fx: BEATFX_ACTIONS, sampler: SAMPLER_ACTIONS,
    strip: STRIP_ACTIONS, board: BOARD_ACTIONS };
  const names = [];
  for (const c of CONTROLS) {
    for (const k of ["action", "shift", "up", "press", "touch", "ring"]) if (c[k]) names.push([c.id, c[k]]);
  }
  for (const [m, p] of Object.entries(PAD_MODES)) {
    names.push([`mode ${m}`, p.action]);
    if (p.shift) names.push([`mode ${m}`, p.shift]);
  }
  assert.ok(names.length > 100);
  for (const [id, a] of names) {
    const [target, method, extra] = a.split(".");
    assert.equal(extra, undefined, `${id}: ${a}`);
    assert.ok(lists[target], `${id}: unknown target in ${a}`);
    assert.ok(lists[target].includes(method), `${id}: ${a} is not a ${target} method`);
  }
  assert.deepEqual(STRIP_ACTIONS, ["openBrowse", "browseMove", "load1", "load2", "closeBrowse"]);
});

const PHONES = [
  // iPhone landscape with its real insets; the same with env() = 0 (fallbacks); the Galaxy
  { W: 844, H: 390, insets: { left: 47, right: 47, bottom: 21, top: 0 } },
  { W: 844, H: 390, insets: { left: 0, right: 0, bottom: 0, top: 0 } },
  { W: 760, H: 360, insets: { left: 0, right: 0, bottom: 0, top: 0 } },
  { W: 1400, H: 900, insets: { left: 0, right: 0, bottom: 0, top: 0 } },
];

test("crossfader_clears_the_home_indicator_zone", () => {
  const xf = byId.get("xfader");
  assert.equal(LAYOUT, "phone", "phone is the default (Cabine v2 V1b); panels, spread and exact stay for comparison");
  assert.ok(XFADER_CLEAR_PX >= 34);
  // "phone" re-solves the decks' proportions (test/board-layout.test.js covers it)
  for (const mode of LAYOUTS.filter((m) => m !== "phone")) {
    for (const { W, H, insets } of PHONES) {
      const b = fitBoard({ W, H, insets, mode });
      const tag = `${mode} ${W}x${H}`;
      const x = placeBox(xf, b);
      assert.ok(x.top + x.height <= H - XFADER_CLEAR_PX + 1e-9, `${tag}: crossfader ends ${H - x.top - x.height} px above the edge`);
      const L = Math.max(insets.left, SAFE_FALLBACK.side), R = Math.max(insets.right, SAFE_FALLBACK.side);
      assert.ok(b.left >= L - 1e-9 && b.left + b.width <= W - R + 1e-9, `${tag}: inside the side safe areas`);
      assert.ok(b.top >= b.stripBottom - 1e-9, `${tag}: below the strip`);
      if (mode === "panels") assert.equal(b.stripBottom, b.stripTop, `${tag}: no strip band`);
      assert.ok(b.top + b.height <= H - Math.max(insets.bottom, SAFE_FALLBACK.bottom) + 1e-9, `${tag}: above the home bar`);
      assert.equal(b.stripBottom - b.stripTop, Math.round(STRIP_SHARE[mode] * H));
      // every control lands inside the board, inside the safe area, and keeps its shape
      for (const c of CONTROLS) {
        const p = placeBox(c, b);
        assert.ok(p.left >= b.left - 1e-6 && p.left + p.width <= b.left + b.width + 1e-6, `${tag}: ${c.id} x`);
        assert.ok(Math.abs(p.width / p.height - (c.w * BOARD_ASPECT) / c.h) < 1e-9, `${tag}: ${c.id} proportions`);
      }
      const secs = b.sections;
      assert.equal(secs[0].left, 0);
      if (mode === "exact") {
        assert.ok(Math.abs(b.width / b.height - BOARD_ASPECT) < 1e-9, `${tag}: aspect kept`);
        assert.ok(Math.abs(secs[1].left - secs[0].width) < 1e-9, `${tag}: sections abut`);
      } else {
        // the whole usable width, the extra split evenly into the two gaps
        assert.ok(Math.abs(b.width - (W - L - R)) < 1e-9, `${tag}: full width`);
        const g1 = secs[1].left - secs[0].width, g2 = secs[2].left - (secs[1].left + secs[1].width);
        assert.ok(g1 >= -1e-9 && Math.abs(g1 - g2) < 1e-9, `${tag}: even gaps ${g1} ${g2}`);
        assert.ok(Math.abs(secs[2].left + secs[2].width - b.width) < 1e-9, `${tag}: deck 2 at the right edge`);
        // inside a section, positions are the photo's (deck 1's pad 1 to its tempo)
        const pad = placeBox(byId.get("d1-pad1"), b), tempo = placeBox(byId.get("d1-tempo"), b);
        const ex = fitBoard({ W, H, insets, mode: "exact" });
        const k = b.height / ex.height;
        const pe = placeBox(byId.get("d1-pad1"), ex), te = placeBox(byId.get("d1-tempo"), ex);
        assert.ok(Math.abs((tempo.left - pad.left) - k * (te.left - pe.left)) < 1e-6, `${tag}: deck geometry kept`);
      }
    }
    // at 844 x 390 one of the bottom rules is what limits the board (no wasted height)
    const b = fitBoard({ ...PHONES[0], mode });
    const x = placeBox(xf, b);
    assert.ok(Math.abs(x.top + x.height - (390 - XFADER_CLEAR_PX)) < 0.5 || b.top + b.height >= 390 - 21 - 0.5, mode);
  }
  // spread gives a bigger board than exact on the iPhone
  const e = fitBoard({ ...PHONES[0], mode: "exact" }), sp = fitBoard({ ...PHONES[0], mode: "spread" });
  assert.ok(sp.height > e.height * 1.1, `${sp.height} vs ${e.height}`);
});

test("tempo_fine_step_reaches_spec_resolution", () => {
  // spec: "the drag must allow 0.02% steps at +-6%": one pixel of fine drag on the
  // board's real tempo track, both phones, both layouts
  const range = TEMPO_RANGES[0] / 100;                         // +-6 %
  assert.equal(range, 0.06);
  const rateSpan = 2 * range;                                   // fader 0..1 = -6 % .. +6 %
  assert.equal(TEMPO_FINE_SCALE, 8, "never coarser than 1:8");
  const t = byId.get("d1-tempo");
  for (const mode of LAYOUTS) {
    for (const ph of PHONES.slice(0, 3)) {
      const b = fitBoard({ ...ph, mode });
      const drawnT = placeControls(b).get("d1-tempo");
      const travel = drawnT.h - faderCap(b, t, drawnT).h;      // the drawn track
      if (mode !== "phone") assert.ok(Math.abs(travel - ((t.h - t.cap.h) / 100) * b.height) < 1e-6);
      else assert.ok(travel > 150, `phone: a long tempo track (${travel})`);
      const coarse = Math.abs(faderDelta(1, travel)) * rateSpan;
      const fine = Math.abs(faderDelta(1, travel, fineScale(travel))) * rateSpan;
      const tag = `${mode} ${ph.W}x${ph.H}, travel ${travel.toFixed(1)} px, 1:${fineScale(travel)}`;
      assert.ok(coarse > 0.0002, `${tag}: coarse alone is not enough (${coarse * 100}% per px)`);
      assert.ok(fine <= 0.0002, `${tag}: fine ${fine * 100}% per px`);
      assert.ok(fineScale(travel) >= TEMPO_FINE_SCALE);
    }
  }
  // the drag direction: down = larger fader value (faster), on the full drawn length
  assert.ok(faderDelta(10, 200) > 0 && Math.abs(faderDelta(200, 200) - 1) < 1e-12);
});

// A Cabine v2 (Task V1): the "panels" layout, grown drawn sizes and hit zones.
import { test } from "node:test";
import assert from "node:assert/strict";

import { CONTROLS, INDICATORS, LEGENDS } from "../flx4-map.js";
import {
  fitBoard, placeControls, hitMap, edgeDistance, panelSlots, fitText, textWidth, legendPlan, LAYOUT, LAYOUTS, XFADER_CLEAR_PX,
  SAFE_FALLBACK, HIT_MIN_PX, BUTTON_MIN_PX, KNOB_MIN_PX, PAD_GAP_PX, LEGEND_MIN_PX, PANELS_TOP_PX, BIG_KINDS, LEVER_MIN_PX,
} from "../ui/board-layout.js";

const byId = new Map(CONTROLS.map((c) => [c.id, c]));
const IPHONE = { left: 47, right: 47, bottom: 21, top: 0 };
// the two iPhone targets (installed app, Safari with its bars) and the Galaxy
const VIEWPORTS = [
  { W: 844, H: 390, insets: IPHONE, tag: "844x390" },
  { W: 844, H: 330, insets: IPHONE, tag: "844x330" },
  { W: 760, H: 360, insets: {}, tag: "760x360" },
];
const EPS = 1e-6;

const right = (r) => r.x + r.w;
const bottom = (r) => r.y + r.h;
const overlap = (a, b) => a.x < right(b) - EPS && b.x < right(a) - EPS && a.y < bottom(b) - EPS && b.y < bottom(a) - EPS;
const contains = (outer, inner) => inner.x >= outer.x - EPS && inner.y >= outer.y - EPS
  && right(inner) <= right(outer) + EPS && bottom(inner) <= bottom(outer) + EPS;
function hitsShape(r, s) {
  if (!overlap(r, s)) return false;
  if (s.shape !== "circle") return true;
  const R = s.w / 2, cx = s.x + R, cy = s.y + s.h / 2;
  const nx = Math.max(r.x, Math.min(cx, right(r))), ny = Math.max(r.y, Math.min(cy, bottom(r)));
  return Math.hypot(nx - cx, ny - cy) < R - EPS;
}
const isBig = (c) => BIG_KINDS.includes(c.kind);

function geometry(vp, mode = "panels") {
  const fit = fitBoard({ W: vp.W, H: vp.H, insets: vp.insets, mode });
  const drawn = placeControls(fit);
  const map = hitMap(fit, drawn);
  return { fit, drawn, map };
}

test("panels_spans_the_height", () => {
  assert.deepEqual([...LAYOUTS].sort(), ["exact", "panels", "phone", "spread"]);
  for (const vp of VIEWPORTS) {
    const { fit } = geometry(vp);
    const L = Math.max(vp.insets.left || 0, SAFE_FALLBACK.side), R = Math.max(vp.insets.right || 0, SAFE_FALLBACK.side);
    assert.equal(fit.mode, "panels");
    assert.equal(fit.stripBottom - fit.stripTop, 0, `${vp.tag}: no strip band`);
    assert.ok(fit.top >= PANELS_TOP_PX - EPS, `${vp.tag}: top inset ${fit.top}`);
    // as tall as the bottom rules allow: the crossfader's clear zone or the home bar
    const xf = byId.get("xfader");
    const xfBottom = fit.top + ((xf.y + xf.h) / 100) * fit.height;
    assert.ok(xfBottom <= vp.H - XFADER_CLEAR_PX + EPS, `${vp.tag}: crossfader clears`);
    const bottomSafe = vp.H - Math.max(vp.insets.bottom || 0, SAFE_FALLBACK.bottom);
    assert.ok(Math.abs(xfBottom - (vp.H - XFADER_CLEAR_PX)) < 0.5 || Math.abs(fit.top + fit.height - bottomSafe) < 0.5,
      `${vp.tag}: no wasted height`);
    assert.ok(Math.abs(fit.top - PANELS_TOP_PX) < 0.5 || fit.top + fit.height >= bottomSafe - 0.5, `${vp.tag}: board sits at the top`);
    // deck 1 at the left safe edge, deck 2 at the right, the mixer centred
    const [d1, mx, d2] = fit.sections;
    assert.ok(Math.abs(fit.left - L) < EPS && Math.abs(fit.left + fit.width - (vp.W - R)) < EPS, `${vp.tag}: full width`);
    assert.equal(d1.left, 0);
    assert.ok(Math.abs(d2.left + d2.width - fit.width) < EPS);
    const gapL = mx.left - d1.width, gapR = d2.left - (mx.left + mx.width);
    assert.ok(Math.abs(gapL - gapR) < EPS && gapL > 0, `${vp.tag}: mixer centred ${gapL} ${gapR}`);
    // the panels layout is bigger than spread (the strip band is gone)
    const sp = fitBoard({ W: vp.W, H: vp.H, insets: vp.insets, mode: "spread" });
    assert.ok(fit.height > sp.height * 1.08, `${vp.tag}: ${fit.height} vs spread ${sp.height}`);
  }
});

test("panel_slots_are_the_two_gaps", () => {
  for (const vp of VIEWPORTS) {
    const { fit } = geometry(vp);
    const slots = panelSlots(fit);
    assert.equal(slots.length, 2, vp.tag);
    const [d1, mx, d2] = fit.sections;
    const want = [
      { x: fit.left + d1.width, w: mx.left - d1.width },
      { x: fit.left + mx.left + mx.width, w: d2.left - (mx.left + mx.width) },
    ];
    slots.forEach((s, i) => {
      assert.ok(s.w > 20 && s.h > 100, `${vp.tag}: slot ${i} non-empty ${JSON.stringify(s)}`);
      assert.ok(Math.abs(s.x - want[i].x) < EPS && Math.abs(s.w - want[i].w) < EPS, `${vp.tag}: slot ${i} x`);
      assert.ok(Math.abs(s.y - fit.top) < EPS && Math.abs(s.h - fit.height) < EPS, `${vp.tag}: slot ${i} y`);
    });
  }
});

test("drawn_sizes_grow_to_their_minimums_around_their_centres", () => {
  for (const vp of VIEWPORTS) {
    for (const mode of ["panels", "spread"]) {
      const { fit, drawn } = geometry(vp, mode);
      const tag = `${mode} ${vp.tag}`;
      const pxw = fit.unit * 1.805;
      const shortfalls = [];
      for (const c of CONTROLS) {
        const d = drawn.get(c.id);
        assert.ok(d, `${tag}: ${c.id} placed`);
        const base = d.base;
        assert.ok(Math.abs(base.w - c.w * pxw) < EPS && Math.abs(base.h - c.h * fit.unit) < EPS, `${tag}: ${c.id} base`);
        if (isBig(c)) {
          assert.ok(Math.abs(d.w - base.w) < EPS && Math.abs(d.h - base.h) < EPS, `${tag}: ${c.id} keeps its box`);
          continue;
        }
        if (c.kind === "pad") continue;                         // pads: their grid cell (below)
        assert.ok(d.w >= base.w - EPS && d.h >= base.h - EPS, `${tag}: ${c.id} never shrinks`);
        // grown around the centre: the centre is the photo's
        const bx = base.x + base.w / 2, by = base.y + base.h / 2;
        assert.ok(Math.abs(d.x + d.w / 2 - bx) < EPS && Math.abs(d.y + d.h / 2 - by) < EPS, `${tag}: ${c.id} centre moved`);
        const round = c.kind === "knob" || c.kind === "encoder" || c.look === "round" || c.look === "big";
        if (round) assert.ok(Math.abs(d.w - d.h) < EPS, `${tag}: ${c.id} stays round`);
        const min = c.kind === "knob" || c.kind === "encoder" ? KNOB_MIN_PX : c.kind === "lever" ? LEVER_MIN_PX : BUTTON_MIN_PX;
        const short = Math.min(d.w, d.h);
        if (short < min - 0.05) {
          // only a neighbour (half the distance to its centre) or the section may stop it
          assert.ok(["neighbour", "section", "big"].includes(d.limit), `${tag}: ${c.id} ${short.toFixed(1)} px, no reason`);
          shortfalls.push(c.id);
        }
      }
      // at 844 x 390 in the panels layout only the parts whose neighbours sit
      // closer than the minimum fall short: CUE/LOOP CALL (28.3 px apart), LOAD
      // (diagonal to TRIM), FX SELECT (diagonal to BEAT), BEAT (19.6 px apart)
      if (mode === "panels" && vp.tag === "844x390") {
        const known = ["d1-call-prev", "d1-call-next", "d2-call-prev", "d2-call-next", "load1", "load2",
          "fx-select", "fx-beat-down", "fx-beat-up"];
        assert.deepEqual(shortfalls.filter((id) => !known.includes(id)), [], `${tag}: short ${shortfalls}`);
        for (const id of shortfalls) assert.equal(drawn.get(id).limit, "neighbour", id);
      }
      // pads: square, the deck's pad area filled with PAD_GAP_PX gaps
      for (const deck of [1, 2]) {
        const pads = CONTROLS.filter((c) => c.kind === "pad" && c.deck === deck).map((c) => drawn.get(c.id));
        for (const p of pads) assert.ok(Math.abs(p.w - p.h) < EPS, `${tag}: pad square`);
        const p1 = pads[0], p2 = pads[1], p5 = pads[4];
        assert.ok(Math.abs(p2.x - right(p1) - PAD_GAP_PX) < EPS || p1.w < p1.cellW - EPS, `${tag}: column gap`);
        assert.ok(Math.abs(p5.y - bottom(p1) - PAD_GAP_PX) < EPS || p1.h < p1.cellH - EPS, `${tag}: row gap`);
        assert.ok(Math.min(p1.cellW, p1.cellH) - p1.w < EPS, `${tag}: pads fill their cells`);
      }
    }
  }
});

test("drawn_parts_never_overlap", () => {
  for (const vp of VIEWPORTS) {
    for (const mode of LAYOUTS) {
      const { fit, drawn } = geometry(vp, mode);
      const all = [...drawn.entries()];
      for (let i = 0; i < all.length; i++) {
        const [ia, a] = all[i];
        const sec = fit.sections.find((s) => s.key === a.section);
        assert.ok(a.x >= sec.left - EPS && right(a) <= sec.left + sec.width + EPS && a.y >= -EPS && bottom(a) <= fit.height + EPS,
          `${mode} ${vp.tag}: ${ia} inside its section`);
        for (let j = i + 1; j < all.length; j++) {
          const [ib, b] = all[j];
          const hit = a.shape === "circle" ? hitsShape(b, a) : b.shape === "circle" ? hitsShape(a, b) : overlap(a, b);
          assert.ok(!hit, `${mode} ${vp.tag}: ${ia} overlaps ${ib}`);
        }
      }
    }
  }
});

const inShape = (x, y, d) => x >= d.x && x < right(d) && y >= d.y && y < bottom(d)
  && (d.shape !== "circle" || Math.hypot(x - (d.x + d.w / 2), y - (d.y + d.h / 2)) <= d.w / 2);

test("hit_zones_are_44px_nearest_centre_and_spare_the_big_controls", () => {
  for (const vp of VIEWPORTS) {
    for (const mode of LAYOUTS) {
      const { fit, drawn, map } = geometry(vp, mode);
      const tag = `${mode} ${vp.tag}`;
      const smalls = CONTROLS.filter((c) => !isBig(c));
      const bigs = CONTROLS.filter(isBig);
      for (const c of CONTROLS) {
        const d = drawn.get(c.id);
        assert.equal(map.at(d.x + d.w / 2, d.y + d.h / 2), c.id, `${tag}: ${c.id} centre`);
        const e = map.extent(c.id);
        if (isBig(c)) {
          assert.ok(Math.abs(e.w - d.w) < EPS && Math.abs(e.h - d.h) < EPS, `${tag}: ${c.id} zone = its box`);
          continue;
        }
        if (e.w < HIT_MIN_PX - 0.5 || e.h < HIT_MIN_PX - 0.5) {
          assert.ok(["neighbour", "section", "big"].includes(e.limit),
            `${tag}: ${c.id} zone ${e.w.toFixed(1)} x ${e.h.toFixed(1)} with no reason`);
        }
        // bigger than the drawn part (pads: their cell, 3 px gaps)
        assert.ok(e.w >= d.w - 0.5 && e.h >= d.h - 0.5, `${tag}: ${c.id} zone ${e.w}x${e.h} under ${d.w}x${d.h}`);
        if (mode === "panels" && c.kind !== "pad") {
          assert.ok((e.w - d.w) + (e.h - d.h) >= 6, `${tag}: ${c.id} zone ${e.w}x${e.h} barely past ${d.w}x${d.h}`);
        }
      }
      // every point of the board, every 1.5 px: a big part's shape is that part's
      // alone; a drawn small part is its own; elsewhere the nearest drawn part
      // among the small parts whose region holds the point, in the same section
      for (let y = 0.25; y < fit.height; y += 1.5) {
        for (let x = 0.25; x < fit.width; x += 1.5) {
          const id = map.at(x, y);
          const bigHere = bigs.find((c) => inShape(x, y, drawn.get(c.id)));
          if (bigHere) { assert.equal(id, bigHere.id, `${tag}: (${x}, ${y}) in ${bigHere.id}`); continue; }
          const drawnHere = smalls.find((c) => inShape(x, y, drawn.get(c.id)));
          if (drawnHere) { assert.equal(id, drawnHere.id, `${tag}: (${x}, ${y}) on ${drawnHere.id}`); continue; }
          const cands = smalls.filter((c) => { const r = map.region(c.id); return x >= r.x && x < right(r) && y >= r.y && y < bottom(r); });
          if (!cands.length) { assert.equal(id, null, `${tag}: (${x}, ${y}) is no one's`); continue; }
          const dist = (c) => edgeDistance(x, y, drawn.get(c.id));
          const near = Math.min(...cands.map(dist));
          assert.ok(id && Math.abs(dist(byId.get(id)) - near) < EPS, `${tag}: (${x}, ${y}) went to ${id}, not the nearest`);
          const sec = fit.sections.find((t) => x >= t.left && x < t.left + t.width);
          assert.equal(drawn.get(id).section, sec.key, `${tag}: (${x}, ${y}) crosses sections`);
        }
      }
      // the jog's box corners are not the jog's
      for (const d of [1, 2]) {
        const j = drawn.get(`d${d}-jog`);
        assert.notEqual(map.at(j.x + 1, j.y + 1), `d${d}-jog`);
      }
    }
  }
});

test("a_point_between_two_controls_goes_to_the_nearer", () => {
  for (const vp of VIEWPORTS) {
    const { drawn, map } = geometry(vp);
    const pairs = [["d1-in", "d1-out"], ["d1-call-prev", "d1-call-next"], ["d1-mode-hotcue", "d1-mode-padfx1"],
      ["fx-beat-down", "fx-beat-up"], ["ch1-hi", "ch1-mid"], ["d2-4beat", "d2-call-prev"], ["d1-pad1", "d1-pad2"],
      ["load1", "ch1-trim"], ["d1-shift", "d1-cue"], ["fx-select", "fx-beat-up"], ["ch1-cue", "phones-mix"]];
    for (const [ia, ib] of pairs) {
      const a = drawn.get(ia), b = drawn.get(ib);
      const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      // along the line between the centres: always one of the two, the nearer
      // to what is drawn (equal sizes: the nearer centre)
      let seen = new Set();
      for (let t = 0; t <= 1; t += 0.01) {
        const x = ca.x + (cb.x - ca.x) * t, y = ca.y + (cb.y - ca.y) * t;
        const da = edgeDistance(x, y, a), db = edgeDistance(x, y, b);
        if (Math.abs(da - db) < 0.5) continue;
        const got = map.at(x, y);
        assert.equal(got, da < db ? ia : ib, `${vp.tag}: ${t.toFixed(2)} of the way from ${ia} to ${ib}`);
        seen.add(got);
      }
      assert.equal(seen.size, 2, `${vp.tag}: ${ia} / ${ib}`);
      // same-size neighbours: the split is halfway between the centres
      if (Math.abs(a.w - b.w) < EPS && Math.abs(a.h - b.h) < EPS) {
        for (const [t, want] of [[0.45, ia], [0.55, ib]]) {
          assert.equal(map.at(ca.x + (cb.x - ca.x) * t, ca.y + (cb.y - ca.y) * t), want, `${vp.tag}: ${ia}/${ib} at ${t}`);
        }
      }
    }
  }
});

test("legends_fit_at_six_px_or_more", () => {
  assert.equal(LEGEND_MIN_PX, 6);
  // fitText: the largest size that fits, or the hardware's short form
  const f = fitText("MEMORY", 21, { base: 7 });
  assert.ok(f.px >= 6 && f.fits && f.text !== "MEMORY" && textWidth(f.text, f.px) <= 21 + EPS, JSON.stringify(f));
  assert.equal(fitText("IN", 40, { base: 7 }).px, 7, "never above the base size");
  for (const vp of VIEWPORTS) {
    for (const mode of ["panels", "phone"]) {
      const { fit, drawn } = geometry(vp, mode);
      const plan = legendPlan(fit, drawn);
      assert.ok(plan.length > 100, `${plan.length} legends`);
      for (const l of plan) {
        if (l.hidden) {
          // a stacked line printed on its neighbour's line (CUE/LOOP CALL) is not lost
          if (l.joined) { assert.ok(plan.some((m) => m.key === l.joined && m.text.includes(l.text)), l.key); continue; }
          // only a SHIFT legend for a layer v1 does not have may be left off
          const c = byId.get(l.owner);
          // (or PLAY/PAUSE, the name printed under PLAY, which its face already shows)
          assert.ok(l.part === "sub" && c && (c.subPlain || !c.shift || c.shift === "board.notYet"), `${mode} ${vp.tag}: ${l.key} hidden`);
          continue;
        }
        assert.ok(l.px >= LEGEND_MIN_PX - EPS, `${mode} ${vp.tag}: ${l.key} "${l.text}" at ${l.px.toFixed(2)} px`);
        assert.ok(l.fits, `${mode} ${vp.tag}: ${l.key} "${l.text}" does not fit its room at ${l.px.toFixed(2)} px`);
      }
      // every free legend and indicator is accounted for
      assert.equal(plan.filter((l) => l.key.startsWith("legend:")).length, LEGENDS.length);
      assert.ok(INDICATORS.length === 2);
    }
  }
});

// ---- the "phone" layout (Task V1b) ---------------------------------------------------

const deckIds = (n) => CONTROLS.filter((c) => c.section === "deck" && c.deck === n);
/** Targets per viewport: hit zones, drawn buttons (short side), pads. */
const TARGETS = { "844x390": { zone: 44, button: 32, pad: 46 }, "844x330": { zone: 38, button: 28, pad: 28 } };

test("phone_is_the_default_band_on_top_decks_widened_mixer_centred", () => {
  assert.equal(LAYOUT, "phone");
  for (const vp of VIEWPORTS) {
    const { fit } = geometry(vp, "phone");
    const tag = vp.tag;
    const usable = vp.H - Math.max(vp.insets.bottom || 0, SAFE_FALLBACK.bottom) - (vp.insets.top || 0);
    const band = fit.stripBottom - fit.stripTop;
    assert.ok(Math.abs(band - Math.max(30, Math.round(usable * 0.1))) < 1, `${tag}: band ${band}`);
    assert.ok(fit.top >= fit.stripBottom, `${tag}: the board under the band`);
    const xf = byId.get("xfader");
    assert.ok(fit.top + ((xf.y + xf.h) / 100) * fit.height <= vp.H - XFADER_CLEAR_PX + EPS, `${tag}: crossfader clears`);
    const L = Math.max(vp.insets.left || 0, SAFE_FALLBACK.side), Rr = Math.max(vp.insets.right || 0, SAFE_FALLBACK.side);
    assert.ok(Math.abs(fit.left - L) < EPS && Math.abs(fit.width - (vp.W - L - Rr)) < EPS, `${tag}: full width`);
    const [d1, mx, d2] = fit.sections;
    // the mixer keeps the panel's proportions, centred; the decks take the rest, 6 px off it
    assert.ok(Math.abs(mx.width - 0.32 * fit.height * 1.805) < EPS, `${tag}: mixer ${mx.width}`);
    assert.ok(Math.abs(mx.left + mx.width / 2 - fit.width / 2) < EPS, `${tag}: mixer centred`);
    assert.equal(d1.left, 0);
    assert.ok(Math.abs(d1.width - (mx.left - 6)) < EPS && Math.abs(d2.left - (mx.left + mx.width + 6)) < EPS, `${tag}: deck gaps`);
    assert.ok(Math.abs(d2.left + d2.width - fit.width) < EPS && Math.abs(d1.width - d2.width) < EPS, `${tag}: decks`);
    assert.ok(d1.width > 0.34 * fit.height * 1.805 * 1.2, `${tag}: decks wider than the photo's`);
  }
});

test("phone_decks_keep_the_flx4_topology", () => {
  for (const vp of VIEWPORTS) {
    const { fit, drawn } = geometry(vp, "phone");
    for (const n of [1, 2]) {
      const g = (id) => drawn.get(`d${n}-${id}`);
      const cx = (r) => r.x + r.w / 2, cy = (r) => r.y + r.h / 2;
      const tag = `${vp.tag} deck ${n}`;
      const sec = fit.sections.find((s) => s.key === `deck${n}`);
      // the loop row, left to right, one row
      const row = ["in", "out", "4beat", "call-prev", "call-next", "sync"].map(g);
      for (let i = 1; i < row.length; i++) {
        assert.ok(cx(row[i]) > cx(row[i - 1]) && right(row[i - 1]) <= row[i].x, `${tag}: loop row order ${i}`);
        assert.ok(Math.abs(cy(row[i]) - cy(row[0])) < EPS, `${tag}: one loop row`);
      }
      const jog = g("jog");
      assert.ok(Math.abs(jog.w - jog.h) < EPS && jog.shape === "circle", `${tag}: the jog is round`);
      assert.ok(jog.y >= Math.max(...row.map(bottom)) - EPS, `${tag}: the jog under the loop row`);
      // SHIFT over CUE over PLAY, at the deck's left
      const [sh, cue, play] = ["shift", "cue", "play"].map(g);
      assert.ok(bottom(sh) <= cue.y + EPS && bottom(cue) <= play.y + EPS, `${tag}: SHIFT, CUE, PLAY`);
      const pads = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => g(`pad${i}`));
      const modes = ["hotcue", "padfx1", "beatjump", "sampler"].map((m) => g(`mode-${m}`));
      for (const r of [sh, cue, play]) assert.ok(right(r) <= Math.min(...pads.map((p) => p.x)) + EPS, `${tag}: left column`);
      // mode row over the 2 x 4 pads, under the jog; columns line up
      for (let i = 0; i < 4; i++) {
        assert.ok(bottom(modes[i]) <= pads[i].y + EPS && bottom(pads[i]) <= pads[i + 4].y + EPS, `${tag}: rows ${i}`);
        assert.ok(Math.abs(cx(modes[i]) - cx(pads[i])) < EPS && Math.abs(cx(pads[i]) - cx(pads[i + 4])) < EPS, `${tag}: columns`);
        if (i) assert.ok(pads[i].x >= right(pads[i - 1]) + 4 - EPS && pads[i].y === pads[i - 1].y, `${tag}: pad gaps`);
      }
      assert.ok(Math.abs(pads[4].y - bottom(pads[0]) - 4) < EPS, `${tag}: 4 px between pad rows`);
      assert.ok(Math.min(...modes.map((m) => m.y)) >= bottom(jog) - EPS, `${tag}: mode row under the jog`);
      for (const p of pads) {
        const a = p.w / p.h;
        assert.ok(a >= 1 - EPS && a <= 1.4 + EPS, `${tag}: pad aspect ${a}`);
      }
      // the tempo fader at the deck's right edge (the outer edge of deck 2), right of the pads
      const t = g("tempo");
      assert.ok(t.x >= Math.max(...pads.map(right)) - EPS && sec.left + sec.width - right(t) <= 6 + EPS, `${tag}: tempo at the right edge`);
      assert.ok(t.h > 100, `${tag}: tempo travel ${t.h}`);
      // the jog: no bigger than 44 % of the deck's height
      assert.ok(jog.w <= 0.44 * fit.height + EPS, `${tag}: jog ${jog.w}`);
    }
  }
});

test("phone_meets_the_targets_in_the_decks", () => {
  for (const vp of VIEWPORTS.filter((v) => TARGETS[v.tag])) {
    const T = TARGETS[vp.tag];
    const { drawn, map } = geometry(vp, "phone");
    for (const n of [1, 2]) {
      for (const c of deckIds(n)) {
        const d = drawn.get(c.id);
        const tag = `${vp.tag}: ${c.id}`;
        if (isBig(c)) continue;
        const e = map.extent(c.id);
        assert.ok(e.w >= T.zone - 0.5 && e.h >= T.zone - 0.5, `${tag} zone ${e.w.toFixed(1)} x ${e.h.toFixed(1)}`);
        const short = Math.min(d.w, d.h);
        if (c.kind === "pad") assert.ok(short >= T.pad - EPS, `${tag} pad ${short.toFixed(1)}`);
        else assert.ok(short >= T.button - EPS, `${tag} drawn ${short.toFixed(1)}`);
      }
    }
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { floatToInt16, audioBufferToPcm, loadTrack } from "../engine/loader.js";

function fakeBuffer(channels, sampleRate = 48000) {
  return {
    numberOfChannels: channels.length,
    sampleRate,
    getChannelData: (i) => channels[i],
  };
}

test("float to int16 clamps and rounds", async () => {
  const f = new Float32Array([0, 1, -1, 1.5, -1.5, 0.5, -0.5, 1 / 32767, -0.4 / 32767]);
  const o = await floatToInt16(f);
  assert.deepEqual([...o], [0, 32767, -32767, 32767, -32768, 16384, -16384, 1, 0]);
});

test("long buffers convert across yields", async () => {
  const n = (1 << 20) * 2 + 5;
  const f = new Float32Array(n).fill(0.25);
  const o = await floatToInt16(f);
  assert.equal(o.length, n);
  assert.equal(o[n - 1], 8192);
  assert.equal(o[(1 << 20)], 8192);
});

test("mono is copied into its own right channel buffer", async () => {
  const pcm = await audioBufferToPcm(fakeBuffer([new Float32Array([0.5, -0.5])], 44100));
  assert.equal(pcm.sampleRate, 44100);
  assert.deepEqual([...pcm.right], [...pcm.left]);
  assert.notEqual(pcm.right.buffer, pcm.left.buffer, "both buffers get transferred");
});

test("loadTrack decodes, adds the carry offset to the grid and drops nothing it needs", async () => {
  const grid = { bpm: 128, first_beat_s: 0.2, downbeat_s: 0.2, reliable: true };
  const calls = [];
  const source = {
    getMp3: async (f) => { calls.push(["mp3", f]); return new ArrayBuffer(8); },
    getGrid: async (f) => { calls.push(["grid", f]); return grid; },
    getMeta: async (f) => ({ file: f, bpm: 128, carry_offset_s: 0.012 }),
  };
  const ctx = {
    decodeAudioData: async (ab) => {
      assert.equal(ab.byteLength, 8);
      return fakeBuffer([new Float32Array([0.1, 0.2]), new Float32Array([0.3, 0.4])], 48000);
    },
  };
  const t = await loadTrack(ctx, source, "a.wav");
  assert.deepEqual(calls.map((c) => c[0]).sort(), ["grid", "mp3"]);
  assert.equal(t.pcm.sampleRate, 48000);
  assert.ok(t.pcm.left instanceof Int16Array && t.pcm.right instanceof Int16Array);
  assert.equal(t.grid.offset_s, 0.012);
  assert.equal(grid.offset_s, undefined, "the source's grid object is not mutated");
  assert.deepEqual(t.hotCues, new Array(8).fill(null));

  const t2 = await loadTrack(ctx, { ...source, getMeta: async (f) => ({ file: f }) }, "a.wav");
  assert.equal(t2.grid.offset_s, 0, "no carry_offset_s means 0");
  const t3 = await loadTrack(ctx, { ...source, getGrid: async () => null }, "a.wav");
  assert.equal(t3.grid, null);
});

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

// ---- Task 10: offline decode at 44.1 kHz, gapless guard, LAME header ---------

import { gaplessTrim, parseLameGapless, LAME_DECODER_DELAY, DEFAULT_GAPLESS_HEAD,
  DECODE_RATE } from "../engine/loader.js";

/** An MPEG-1 Layer III frame with an Info tag carrying a LAME extension. */
function lameMp3(delay, padding) {
  const b = new Uint8Array(600);
  b.set([0xff, 0xfb, 0x90, 0x64], 0);           // MPEG-1 L3, 128 kbps, 44.1 kHz, joint stereo
  const xing = 4 + 32;                           // side info is 32 bytes for MPEG-1 stereo
  b.set([..."Info"].map((c) => c.charCodeAt(0)), xing);
  b.set([0, 0, 0, 0x0f], xing + 4);              // flags: frames, bytes, toc, quality
  const lame = xing + 8 + 4 + 4 + 100 + 4;
  b.set([..."LAME3.100"].map((c) => c.charCodeAt(0)), lame);
  b[lame + 21] = delay >> 4;
  b[lame + 22] = ((delay & 0xf) << 4) | (padding >> 8);
  b[lame + 23] = padding & 0xff;
  return b.buffer;
}

test("lame_header_gives_encoder_delay_and_padding", () => {
  assert.deepEqual(parseLameGapless(lameMp3(576, 1234)), { delay: 576, padding: 1234 });
  const id3 = new Uint8Array(10 + 50 + 600);
  id3.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 50]);  // "ID3" v2.4, 50-byte tag (syncsafe)
  id3.set(new Uint8Array(lameMp3(576, 900)), 60);
  assert.deepEqual(parseLameGapless(id3.buffer), { delay: 576, padding: 900 }, "skips an ID3v2 tag");
  assert.equal(parseLameGapless(new ArrayBuffer(16)), null, "no header: null");
  assert.equal(parseLameGapless(new Uint8Array([0xff, 0xfb, 0x90, 0x64, ...new Array(300).fill(0)]).buffer), null);
});

test("gapless_trim_cases", () => {
  const S = 441000;
  assert.equal(DEFAULT_GAPLESS_HEAD, 1105);
  assert.equal(LAME_DECODER_DELAY, 529);
  // exact decode: nothing to do
  assert.deepEqual(gaplessTrim(S, S), { head: 0, tail: 0, action: "exact", excess: 0 });
  // delay + padding left in (no LAME info): head = 1105, the rest is padding
  let t = gaplessTrim(S + 1105 + 576, S);
  assert.deepEqual([t.head, t.tail, t.action], [1105, 576, "trimmed"]);
  // the LAME header says delay 576: head = 576 + 529
  t = gaplessTrim(S + 1105 + 1000, S, { delay: 576, padding: 1529 });
  assert.deepEqual([t.head, t.tail], [1105, 1000]);
  // padding only (the decoder already dropped the delay)
  t = gaplessTrim(S + 700, S);
  assert.deepEqual([t.head, t.tail, t.action], [0, 700, "padding"]);
  // way off, or shorter, or unknown: leave it, say so
  assert.equal(gaplessTrim(S + 20000, S).action, "mismatch");
  assert.equal(gaplessTrim(S - 300, S).action, "mismatch");
  assert.equal(gaplessTrim(S + 3000, S).head, 0, "beyond delay + one frame of padding");
  assert.equal(gaplessTrim(S, null).action, "unknown");
  assert.equal(gaplessTrim(S + 1105, undefined).head, 0);
});

test("loadTrack_decodes_at_44100_and_trims_a_padded_decode", async () => {
  assert.equal(DECODE_RATE, 44100);
  const S = 5000, head = 1105, tail = 576;
  const ramp = (k) => Float32Array.from({ length: S + head + tail }, (_, i) => ((i - head) % 1000) / 2000 * k);
  const decodeCalls = [];
  const decodeCtx = {
    sampleRate: 44100,
    decodeAudioData: async (ab) => {
      decodeCalls.push(ab.byteLength);
      return fakeBuffer([ramp(1), ramp(-1)], 44100);
    },
  };
  const logs = [];
  const source = {
    getMp3: async () => new ArrayBuffer(32),
    getGrid: async () => ({ bpm: 120, first_beat_s: 0.5, downbeat_s: 0.5, reliable: true }),
    getMeta: async (f) => ({ file: f, samples: S }),
    getHotCues: async () => [{ start: 1, end: null }],
    getPeaks: async () => new Uint8Array([0x50, 0x4b, 0x30, 0x31, 100, 0, 0, 0, 1, 0, 0, 0, 9]).buffer,
  };
  const liveCtx = { decodeAudioData: async () => { throw new Error("must decode offline, not on the live context"); } };
  const t = await loadTrack(liveCtx, source, "a.mp3", { decodeCtx, log: (m) => logs.push(m) });
  assert.equal(decodeCalls.length, 1);
  assert.equal(t.pcm.sampleRate, 44100, "no upsampling: the worklet resamples");
  assert.equal(t.pcm.left.length, S, "trimmed to the source's frames");
  assert.equal(t.pcm.left[0], 0, "the first frame is the source's frame 0");
  assert.equal(t.pcm.left[1], Math.round((1 / 2000) * 32767));
  assert.equal(t.pcm.right[1], -Math.round((1 / 2000) * 32767));
  assert.deepEqual([t.gapless.head, t.gapless.tail, t.gapless.action], [head, tail, "trimmed"]);
  assert.equal(t.grid.offset_s, 0, "trimmed exactly: the grid needs no residual");
  assert.ok(logs.some((m) => /gapless/.test(m) && /1105/.test(m)), logs);
  assert.deepEqual(t.hotCues[0], { start: 1, end: null }, "saved hot cues come back with the track");
  assert.equal(t.hotCues.length, 8);
  assert.ok(t.peaks instanceof ArrayBuffer, "the waveform peaks ride along");
});

test("loadTrack_on_an_exact_decode_trims_nothing", async () => {
  const S = 3000;
  const decodeCtx = { decodeAudioData: async () => fakeBuffer([new Float32Array(S).fill(0.5), new Float32Array(S)], 44100) };
  const t = await loadTrack({}, {
    getMp3: async () => new ArrayBuffer(8), getGrid: async () => null, getMeta: async (f) => ({ file: f, samples: S }),
  }, "b.mp3", { decodeCtx, log: () => {} });
  assert.equal(t.pcm.left.length, S);
  assert.equal(t.gapless.action, "exact");
  assert.equal(t.peaks, null);
});

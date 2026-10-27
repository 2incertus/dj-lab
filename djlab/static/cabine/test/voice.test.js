import { test } from "node:test";
import assert from "node:assert/strict";

// ---- the worklet, run in Node with the AudioWorkletGlobalScope stubbed ------

const posted = [];
class FakePort {
  constructor() { this.onmessage = null; }
  postMessage(m) { posted.push(m); }
}
let Processor = null;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = new FakePort(); } };
globalThis.registerProcessor = (name, cls) => { if (name === "cabine-deck") Processor = cls; };
globalThis.sampleRate = 48000;
globalThis.currentTime = 0;
globalThis.currentFrame = 0;
await import("../engine/deck-processor.js");

function render(p) {
  const out = [[new Float32Array(128), new Float32Array(128)]];
  const t0 = Date.now();
  p.process([], out);
  return Date.now() - t0;
}

test("worklet_ignores_stall_and_ping_without_test_hooks", () => {
  const p = new Processor({ processorOptions: {} });
  posted.length = 0;
  p.port.onmessage({ data: { type: "stall", ms: 150 } });
  assert.ok(render(p) < 50, "the stall message is ignored: the render thread does not block");
  p.port.onmessage({ data: { type: "ping", id: 7 } });
  assert.equal(posted.filter((m) => m.type === "pong").length, 0, "no pong without test hooks");
});

test("worklet_runs_test_hooks_when_created_with_them", () => {
  const p = new Processor({ processorOptions: { testHooks: true } });
  posted.length = 0;
  p.port.onmessage({ data: { type: "stall", ms: 150 } });
  assert.ok(render(p) >= 140, "the stall blocks the render thread once");
  assert.ok(render(p) < 50, "only once");
  p.port.onmessage({ data: { type: "ping", id: 7 } });
  assert.deepEqual(posted.filter((m) => m.type === "pong").map((m) => m.id), [7]);
});

// ---- the main-thread voice, with AudioWorkletNode stubbed -------------------

const nodes = [];
globalThis.AudioWorkletNode = class {
  constructor(ctx, name, opts) {
    this.name = name;
    this.opts = opts;
    this.sent = [];
    this.port = { postMessage: (m) => this.sent.push(m), onmessage: null };
    nodes.push(this);
  }
  connect() {}
  disconnect() {}
};
const { DeckVoice } = await import("../engine/deck-voice.js");

test("voice_test_hooks_are_off_by_default", async () => {
  const v = new DeckVoice({});
  const node = nodes[nodes.length - 1];
  assert.equal(node.opts.processorOptions.testHooks, false, "production voices never ask for hooks");
  v.stall(100);
  assert.equal(node.sent.length, 0, "stall() sends nothing");
  await assert.rejects(v.sync(), /test hooks/);
  assert.equal(node.sent.length, 0, "sync() sends nothing");
});

test("voice_test_hooks_on_request", async () => {
  const v = new DeckVoice({}, { testHooks: true });
  const node = nodes[nodes.length - 1];
  assert.equal(node.opts.processorOptions.testHooks, true);
  v.stall(100);
  assert.deepEqual(node.sent[0], { type: "stall", ms: 100 });
  const p = v.sync();
  const ping = node.sent[1];
  assert.equal(ping.type, "ping");
  node.port.onmessage({ data: { type: "pong", id: ping.id, s: 1.5, t: 2 } });
  assert.deepEqual(await p, { s: 1.5, t: 2 });
});

test("voice_unload_sends_an_empty_load_and_the_worklet_drops_the_pcm", () => {
  const v = new DeckVoice({});
  const node = nodes[nodes.length - 1];
  v.load({ left: new Int16Array(4), right: new Int16Array(4), sampleRate: 44100 });
  v.unload();
  const m = node.sent[node.sent.length - 1];
  assert.equal(m.type, "load");
  assert.equal(m.left.length, 0);
  assert.equal(v.duration, 0);

  const p = new Processor({ processorOptions: {} });
  p.port.onmessage({ data: { type: "load", left: new Int16Array(1000).fill(1000), right: new Int16Array(1000), sampleRate: 48000 } });
  p.port.onmessage({ data: { type: "run", on: true } });
  p.port.onmessage({ data: { type: "load", left: new Int16Array(0), right: new Int16Array(0), sampleRate: 0 } });
  assert.equal(p.L, null, "the old PCM is released");
  assert.equal(p.n, 0);
  p.port.onmessage({ data: { type: "run", on: true } });
  const out = [[new Float32Array(128), new Float32Array(128)]];
  p.process([], out);
  assert.ok(out[0][0].every((x) => x === 0), "an unloaded deck is silent");
});

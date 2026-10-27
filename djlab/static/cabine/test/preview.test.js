import { test } from "node:test";
import assert from "node:assert/strict";

import { Preview } from "../ui/preview.js";

/** Records what the preview asks of its voice. */
class FakeVoice {
  constructor() { this.calls = []; }
  unload() { this.calls.push("unload"); }
  disconnect() { this.calls.push("disconnect"); }
}

test("close_unloads_the_voice_before_letting_it_go", async () => {
  const p = new Preview({});
  const v = new FakeVoice();
  p.voice = v;
  p.deck = { state: { playing: false } };
  await p.close();
  assert.ok(v.calls.includes("unload"), "the worklet is told to drop its PCM");
  assert.ok(v.calls.indexOf("unload") < v.calls.indexOf("disconnect"), "unload goes out while the node is still wired");
  assert.equal(p.voice, null);
});

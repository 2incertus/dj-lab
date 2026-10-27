// A Cabine: the whole engine for one board, wired the way rekordbox routes an
// FLX4: two deck voices into the mixer's channels, the mixer's split output
// (left ear = headphones, right ear = master) to the speakers, Beat FX on the
// mixer's inserts with the decks for Roll, the sampler into the master.
//
// createRig(ctx, opts) -> {ctx, voices, decks, mixer, fx, sampler, underruns()}
//   opts {testHooks, eqMode, destination}
// The context is the caller's: on the phone it is created on the first tap
// (app.js), after navigator.audioSession.type = "playback".

import { Deck } from "./deck.js";
import { DeckVoice } from "./deck-voice.js";
import { Mixer } from "./mixer.js";
import { BeatFx } from "./fx.js";
import { Sampler } from "./sampler.js";

/** The deck the other one follows (BEAT SYNC master), or null. */
export function masterDeck(decks) {
  for (const d of decks) if (d && d._followers && d._followers.size > 0) return d;
  return null;
}

/** BPM Auto for Beat FX: the CH SELECT deck's tempo; for 1&2 the sync
 *  master's, else the first playing deck's, else the first loaded one's.
 *  null lets BeatFx fall back to its default. */
export function fxBpm(decks, target) {
  const bpm = (d) => (d && d.state && d.state.loaded ? d.effectiveBpm() : null);
  if (target === "1") return bpm(decks[0]);
  if (target === "2") return bpm(decks[1]);
  const m = masterDeck(decks);
  if (m) return bpm(m);
  const playing = decks.find((d) => d && d.state.playing && bpm(d));
  if (playing) return bpm(playing);
  const loaded = decks.find((d) => bpm(d));
  return loaded ? bpm(loaded) : null;
}

export async function createRig(ctx, opts = {}) {
  const voices = await Promise.all([1, 2].map(() => DeckVoice.create(ctx, { testHooks: !!opts.testHooks })));
  const mixer = new Mixer(ctx, { eqMode: opts.eqMode });
  const decks = voices.map((v) => new Deck(v, { now: () => ctx.currentTime }));
  voices.forEach((v, i) => v.connect(mixer.channel(i + 1).input));
  mixer.output.connect(opts.destination || ctx.destination);
  const fx = new BeatFx(ctx, mixer, (target) => fxBpm(decks, target), { decks });
  const sampler = new Sampler(ctx, mixer.samplerInput);
  return {
    ctx, voices, decks, mixer, fx, sampler,
    /** Worklet dropouts on both decks since they were made. */
    underruns: () => voices.reduce((n, v) => n + v.underruns, 0),
  };
}

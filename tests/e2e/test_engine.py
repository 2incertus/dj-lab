"""A Cabine deck engine in a real browser: the AudioWorklet player fed by the
carried MP3 through the loader.

Chromium only (ruling R8): Playwright's WebKit on Linux is not a faithful
Safari audio stack; Safari is proven on the real iPhone (Task 6).
"""

import pytest

pytestmark = pytest.mark.usefixtures("carried")

IMPORTS = """
  const { Deck } = await import('/static/cabine/engine/deck.js');
  const { DeckVoice } = await import('/static/cabine/engine/deck-voice.js');
  const { loadTrack, networkSource } = await import('/static/cabine/engine/loader.js');
  const G = await import('/static/cabine/engine/grid.js');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
"""


def test_carried_buffer_grid_alignment(proof_page, carried):
    """Render 2 s of deck output offline from between two beats: the first
    click comes out where the server grid says the next beat is (5 ms)."""
    r = proof_page.evaluate("async (file) => {" + IMPORTS + """
      const sr = 44100;
      const ctx = new OfflineAudioContext(2, 2 * sr, sr);
      const track = await loadTrack(ctx, networkSource(), file);
      const voice = await DeckVoice.create(ctx);
      voice.connect(ctx.destination);
      const deck = new Deck(voice, { now: () => ctx.currentTime });
      deck.load(track);
      const p0 = 1.1;                              // between beats: grid 0.25 + k * 0.5, next 1.25
      deck._seekNow(p0, 0);
      deck.playPause();
      await voice.sync();
      const out = await ctx.startRendering();
      const L = out.getChannelData(0), R = out.getChannelData(1);
      let k = -1;
      for (let i = 0; i < L.length; i++) { if (Math.abs(L[i]) > 0.2) { k = i; break; } }
      let peak = 0, rpeak = 0;
      for (let i = 0; i < L.length; i++) { peak = Math.max(peak, Math.abs(L[i])); rpeak = Math.max(rpeak, Math.abs(R[i])); }
      const nextBeat = G.timeOfBeat(track.grid, Math.ceil(G.beatIndexAt(track.grid, p0)));
      return { k, onset: p0 + k / sr, nextBeat, peak, rpeak, offset: track.grid.offset_s };
    }""", carried["click120"])
    print(f"\nalignment: first click {1000 * (r['onset'] - r['nextBeat']):+.3f} ms vs grid")
    assert r["k"] > 0, r
    assert r["peak"] > 0.5 and r["rpeak"] > 0.5, r            # both channels carry audio
    assert abs(r["nextBeat"] - 1.25) < 1e-9, r                # the fixture grid
    assert abs(r["onset"] - r["nextBeat"]) < 0.005, \
        f"first click {1000 * (r['onset'] - r['nextBeat']):.2f} ms off the grid"


def test_reverse_scrub_plays_backwards(proof_page, carried):
    """Rate +1 then rate -1 for the same time returns to the start (10 ms),
    and the reverse half is the source sample-for-sample backwards."""
    r = proof_page.evaluate("async (file) => {" + IMPORTS + """
      const sr = 44100, Q = 128, F = 344 * Q;     // both halves exactly F frames
      const ctx = new OfflineAudioContext(2, 3 * F, sr);
      const track = await loadTrack(ctx, networkSource(), file);
      const src = new Int16Array(track.pcm.left);  // keep a copy: load transfers the buffers
      const voice = await DeckVoice.create(ctx);
      voice.connect(ctx.destination);
      const start = 2.0, f0 = start * sr;
      voice.load(track.pcm);
      voice.seek(start);
      voice.setRate(1, true);
      voice.play();
      await voice.sync();
      const marks = {};
      ctx.suspend(F / sr).then(async () => {
        marks.fwd = await voice.sync();
        voice.setRate(-1, true);                   // the scratch path: no smoothing
        await voice.sync();
        ctx.resume();
      });
      ctx.suspend(2 * F / sr).then(async () => {
        marks.back = await voice.sync();
        voice.pause();
        await voice.sync();
        ctx.resume();
      });
      const out = await ctx.startRendering();
      const L = out.getChannelData(0);
      let maxRev = 0, maxFwdMismatch = 0, energy = 0;
      for (let j = 0; j < F; j++) {
        const expect = src[f0 + F - j] / 32768;
        const got = L[F + j];
        maxRev = Math.max(maxRev, Math.abs(got - expect));
        maxFwdMismatch = Math.max(maxFwdMismatch, Math.abs(got - src[f0 + F + j] / 32768));
        energy = Math.max(energy, Math.abs(got));
      }
      let tail = 0;
      for (let j = 2 * F; j < 3 * F; j++) tail = Math.max(tail, Math.abs(L[j]));
      return { start, fwd: marks.fwd, back: marks.back, maxRev, maxFwdMismatch, energy, tail };
    }""", carried["click120"])
    print(f"\nreverse: back at {1000 * (r['back']['s'] - r['start']):+.3f} ms, max sample error {r['maxRev']:.2e}")
    assert abs(r["fwd"]["s"] - (r["start"] + 344 * 128 / 44100)) < 0.002, r
    assert abs(r["back"]["s"] - r["start"]) < 0.010, f"returned to {r['back']['s']}"
    assert r["energy"] > 0.3, "the reverse half is not silence"
    assert r["maxRev"] < 1e-3, f"reverse half differs from the reversed source by {r['maxRev']}"
    assert r["maxFwdMismatch"] > 0.1, "a forward render would not pass the reverse check"
    assert r["tail"] == 0, "paused deck is silent"


LOAD_WHILE_PLAYING = "async ({a, b, stallMs}) => {" + IMPORTS + """
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.resume();
  const src = networkSource();
  const vA = await DeckVoice.create(ctx);
  vA.connect(ctx.destination);
  const A = new Deck(vA, { now: () => ctx.currentTime });
  A.load(await loadTrack(ctx, src, a));
  A.playPause();
  await vA.sync();
  const w0 = performance.now(), t0 = ctx.currentTime, s0 = (await vA.sync()).s;
  await sleep(1000);
  const before = vA.underruns;
  if (stallMs) vA.stall(stallMs);
  const vB = await DeckVoice.create(ctx);
  vB.connect(ctx.destination);
  const B = new Deck(vB, { now: () => ctx.currentTime });
  const l0 = performance.now();
  const tb = await loadTrack(ctx, src, b);
  const loadMs = performance.now() - l0;
  const frames = tb.pcm.left.length, rate = tb.pcm.sampleRate;
  B.load(tb);
  await vB.sync();
  await sleep(1500);
  const end = await vA.sync();
  const res = {
    state: ctx.state, before, after: vA.underruns, bUnder: vB.underruns,
    seconds: frames / rate, loadMs,
    wallS: (performance.now() - w0) / 1000, audioS: ctx.currentTime - t0,
    advanced: end.s - s0, playing: A.state.playing,
  };
  await ctx.close();
  return res;
}"""


def test_load_while_playing_no_underrun(proof_page, carried):
    r = proof_page.evaluate(LOAD_WHILE_PLAYING,
                            {"a": carried["click128"], "b": carried["long14"], "stallMs": 0})
    print(f"\nload while playing: {r}")
    assert r["state"] == "running", r
    assert abs(r["seconds"] - 840) < 1, r                     # really the 14-minute track
    assert r["audioS"] > 0.8 * r["wallS"], f"audio clock not realtime: {r}"
    assert r["playing"] and r["advanced"] > 0.8 * r["audioS"], f"deck A stopped: {r}"
    assert r["before"] == 0 and r["after"] == 0, f"underruns on the playing deck: {r}"


def test_underrun_detector_sees_a_stalled_render_thread(proof_page, carried):
    """Negative control: the counter that must stay 0 above does move when
    the render thread really stalls (150 ms busy wait in process())."""
    r = proof_page.evaluate(LOAD_WHILE_PLAYING,
                            {"a": carried["click128"], "b": carried["click120"], "stallMs": 150})
    assert r["before"] == 0, r
    assert r["after"] >= 1, f"a 150 ms stall went unnoticed: {r}"


def test_scheduled_start_lands_with_its_seek(proof_page, carried):
    """play(at) + seek(s, at): silence until frame at, then the track from s,
    no sound from the old position first (the synced start from pause)."""
    r = proof_page.evaluate("async (file) => {" + IMPORTS + """
      const sr = 44100;
      const ctx = new OfflineAudioContext(2, sr, sr);
      const track = await loadTrack(ctx, networkSource(), file);
      const voice = await DeckVoice.create(ctx);
      voice.connect(ctx.destination);
      voice.load(track.pcm);
      voice.seek(0.25);                   // parked ON a click: any early start would sound
      const at = 0.3, s = 1.1;            // then start at 0.3 s from 1.1 s (next click 1.25)
      voice.seek(s, at);
      voice.play(at);
      await voice.sync();
      const out = await ctx.startRendering();
      const L = out.getChannelData(0);
      const atF = Math.round(at * sr);
      let before = 0;
      for (let i = 0; i < atF; i++) before = Math.max(before, Math.abs(L[i]));
      let k = -1;
      for (let i = 0; i < L.length; i++) { if (Math.abs(L[i]) > 0.2) { k = i; break; } }
      return { before, onset: k / sr, expect: at + (1.25 - s) };
    }""", carried["click120"])
    print(f"\nscheduled start: silent before {r['before']}, onset {1000 * (r['onset'] - r['expect']):+.3f} ms")
    assert r["before"] == 0, "sound before the scheduled start"
    assert abs(r["onset"] - r["expect"]) < 0.001, r


def test_scheduled_loop_release_lands_with_its_seek(proof_page, carried):
    """setLoop(null, null, at) + seek(s, at): the loop holds until frame at,
    then playback continues from s (how a Beat FX roll returns to its slip
    position). The loop [1.0, 1.1) holds no click; released early, the
    playhead would run on into the click at 1.25 before at."""
    r = proof_page.evaluate("async (file) => {" + IMPORTS + """
      const sr = 44100;
      const ctx = new OfflineAudioContext(2, sr, sr);
      const track = await loadTrack(ctx, networkSource(), file);
      const voice = await DeckVoice.create(ctx);
      voice.connect(ctx.destination);
      voice.load(track.pcm);
      voice.seek(1.0);
      voice.setLoop(1.0, 1.1);
      voice.play();
      const at = 0.4, s = 1.2;            // next click 1.25 -> sounds at 0.45
      voice.setLoop(null, null, at);
      voice.seek(s, at);
      await voice.sync();
      const out = await ctx.startRendering();
      const L = out.getChannelData(0);
      const atF = Math.round(at * sr);
      let before = 0;
      for (let i = 0; i < atF; i++) before = Math.max(before, Math.abs(L[i]));
      let k = -1;
      for (let i = atF; i < L.length; i++) { if (Math.abs(L[i]) > 0.2) { k = i; break; } }
      return { before, onset: k / sr, expect: at + (1.25 - s) };
    }""", carried["click120"])
    print(f"\nscheduled loop release: before {r['before']}, onset {1000 * (r['onset'] - r['expect']):+.3f} ms")
    assert r["before"] < 0.05, "the loop let go before its frame"
    assert abs(r["onset"] - r["expect"]) < 0.001, r

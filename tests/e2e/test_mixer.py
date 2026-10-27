"""A Cabine mixer, Beat FX and sampler, rendered offline in a real browser.

Oscillators and impulses stand in for the decks. Chromium only (ruling R8).
The modules are served from /static/; the gated proof page is just a page
to run them in.
"""

IMPORTS = """
  const M = await import('/static/cabine/engine/mixer.js');
  const F = await import('/static/cabine/engine/fx.js');
  const S = await import('/static/cabine/engine/sampler.js');
  const SR = 48000;
  const rmsDb = (a, t0, t1) => {
    const i0 = Math.round(t0 * SR), i1 = Math.round(t1 * SR);
    let e = 0;
    for (let i = i0; i < i1; i++) e += a[i] * a[i];
    const r = Math.sqrt(e / (i1 - i0));
    return r > 0 ? 20 * Math.log10(r) : -400;
  };
  // level of one frequency in a window (Goertzel), as dBFS of a sine's peak
  const toneDb = (a, hz, t0, t1) => {
    const i0 = Math.round(t0 * SR), i1 = Math.round(t1 * SR), n = i1 - i0;
    const w = 2 * Math.PI * hz / SR;
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { re += a[i0 + i] * Math.cos(w * i); im -= a[i0 + i] * Math.sin(w * i); }
    const amp = 2 * Math.sqrt(re * re + im * im) / n;
    return amp > 0 ? 20 * Math.log10(amp) : -400;
  };
  const osc = (ctx, hz, amp) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = hz; g.gain.value = amp;
    o.connect(g); o.start();
    return g;
  };
"""


def test_split_cue_left_is_cue_right_is_master(proof_page):
    r = proof_page.evaluate("async () => {" + IMPORTS + """
      // the brief's case: deck 1 CUE on, its fader down, nothing else
      let ctx = new OfflineAudioContext(2, SR, SR);
      let m = new M.Mixer(ctx);
      m.output.connect(ctx.destination);
      osc(ctx, 440, 0.5).connect(m.channel(1).input);
      m.channel(1).setCue(true);
      m.channel(1).setFader(0);
      let out = await ctx.startRendering();
      const solo = { left: rmsDb(out.getChannelData(0), 0.3, 1), right: rmsDb(out.getChannelData(1), 0.3, 1) };

      // both decks: 1 cued with its fader down, 2 on air and not cued, MIX full to cue
      ctx = new OfflineAudioContext(2, SR, SR);
      m = new M.Mixer(ctx);
      m.output.connect(ctx.destination);
      osc(ctx, 440, 0.5).connect(m.channel(1).input);
      osc(ctx, 1000, 0.5).connect(m.channel(2).input);
      m.channel(1).setCue(true);
      m.channel(1).setFader(0);
      m.channel(2).setFader(1);
      m.setPhonesMix(0);
      out = await ctx.startRendering();
      const L = out.getChannelData(0), R = out.getChannelData(1);
      const both = { l440: toneDb(L, 440, 0.3, 1), l1k: toneDb(L, 1000, 0.3, 1),
                     r440: toneDb(R, 440, 0.3, 1), r1k: toneDb(R, 1000, 0.3, 1) };

      // MIX full to master puts the master in the left ear too
      ctx = new OfflineAudioContext(2, SR, SR);
      m = new M.Mixer(ctx);
      m.output.connect(ctx.destination);
      osc(ctx, 440, 0.5).connect(m.channel(1).input);
      osc(ctx, 1000, 0.5).connect(m.channel(2).input);
      m.channel(1).setCue(true);
      m.channel(1).setFader(0);
      m.setPhonesMix(1);
      out = await ctx.startRendering();
      const mixM = { l440: toneDb(out.getChannelData(0), 440, 0.3, 1),
                     l1k: toneDb(out.getChannelData(0), 1000, 0.3, 1) };
      return { solo, both, mixM };
    }""")
    print(f"\nsplit cue: {r}")
    assert r["solo"]["left"] > -30, r
    assert r["solo"]["right"] < -60, r
    b = r["both"]
    assert b["l440"] > -30 and b["r1k"] > -30, r            # cue left, master right
    assert b["l1k"] < -60, f"master leaked into the cue ear: {r}"
    assert b["r440"] < -60, f"cue leaked into the master ear: {r}"
    assert r["mixM"]["l1k"] > -30 and r["mixM"]["l440"] < -60, r


def test_low_at_minimum_eq_minus_26_and_isolator_kill(proof_page):
    """EQ mode (default): LOW fully CCW takes 60 Hz down 26 dB. ISOLATOR mode:
    a full kill (more than 40 dB). Neither touches 5 kHz."""
    r = proof_page.evaluate("async () => {" + IMPORTS + """
      async function render(hz, low, eqMode) {
        const ctx = new OfflineAudioContext(2, SR, SR);
        const m = new M.Mixer(ctx, eqMode ? { eqMode } : {});
        m.output.connect(ctx.destination);
        osc(ctx, hz, 0.5).connect(m.channel(1).input);
        m.setCrossfader(0);
        if (low !== null) m.channel(1).setEq('low', low);
        const out = await ctx.startRendering();
        return toneDb(out.getChannelData(1), hz, 0.4, 1);
      }
      return {
        mode: M.EQ_MODE,
        sub: await render(60, 0.5), subMin: await render(60, 0),
        hi: await render(5000, 0.5), hiWithLowMin: await render(5000, 0),
        subKilled: await render(60, 0, 'ISOLATOR'), hiWithLowKilled: await render(5000, 0, 'ISOLATOR'),
        sub3: await render(60, 1),
        flat: [await render(250, null), await render(800, null), await render(2500, null)],
      };
    }""")
    print(f"\nlow at minimum: {r}")
    assert r["mode"] == "EQ", r
    # 0.5 sine through OUTPUT_LEVEL_DB (-6) headroom, crossfader full to channel 1
    assert abs(r["sub"] - (20 * __import__("math").log10(0.5) - 6)) < 0.5, f"wrong level at center: {r}"
    assert abs(r["sub"] - r["subMin"] - 26) < 1, f"EQ mode: 60 Hz dropped {r['sub'] - r['subMin']:.1f} dB, want 26"
    assert r["sub"] - r["subKilled"] > 40, f"ISOLATOR: 60 Hz only dropped {r['sub'] - r['subKilled']:.1f} dB"
    assert abs(r["hi"] - r["hiWithLowMin"]) < 0.5, f"LOW at minimum touched 5 kHz: {r}"
    assert abs(r["hi"] - r["hiWithLowKilled"]) < 0.5, f"low kill touched 5 kHz: {r}"
    assert abs(r["sub3"] - r["sub"] - 6) < 0.5, f"full LOW boost is not +6 dB: {r}"
    for db in r["flat"]:                                       # at and between the crossovers
        assert abs(db - r["sub"]) < 0.5, f"isolator not flat at center: {r}"


def test_beat_fx_delay_time_tracks_bpm(proof_page):
    r = proof_page.evaluate("async () => {" + IMPORTS + """
      async function render(bpm) {
        const ctx = new OfflineAudioContext(2, SR, SR);
        const m = new M.Mixer(ctx);
        m.output.connect(ctx.destination);
        const buf = ctx.createBuffer(1, SR, SR);
        buf.getChannelData(0)[Math.round(0.3 * SR)] = 1;           // impulse at 0.3 s
        const src = ctx.createBufferSource();
        src.buffer = buf; src.connect(m.channel(1).input); src.start();
        const fx = new F.BeatFx(ctx, m, () => bpm, { decks: [] });
        fx.beat(-1); fx.beat(-1);                                    // 1 -> 3/4 -> 1/2
        fx.setLevel(1);
        fx.setOn(true);
        const out = await ctx.startRendering();
        const R = out.getChannelData(1);
        const argmax = (t0, t1) => {
          let k = -1, best = 0;
          for (let i = Math.round(t0 * SR); i < Math.round(t1 * SR); i++) {
            if (Math.abs(R[i]) > best) { best = Math.abs(R[i]); k = i; }
          }
          return { k, best };
        };
        const dry = argmax(0.25, 0.45), wet = argmax(0.47, 0.95);
        return { fraction: fx.state.fraction, name: fx.state.name,
                 delayMs: 1000 * (wet.k - dry.k) / SR, dry: dry.best, wet: wet.best };
      }
      return { b128: await render(128), b100: await render(100) };
    }""")
    print(f"\ndelay: {r}")
    for key, want in (("b128", 234.375), ("b100", 300.0)):
        x = r[key]
        assert x["name"] == "Delay" and x["fraction"] == 0.5, x
        assert x["wet"] > 0.5 * x["dry"], f"no repeat: {x}"
        assert abs(x["delayMs"] - want) < 2, f"{key}: delay {x['delayMs']:.2f} ms, want {want}"


def test_fx_tail_rings_after_off(proof_page):
    r = proof_page.evaluate("async () => {" + IMPORTS + """
      async function render(turnOn) {
        const ctx = new OfflineAudioContext(2, 2 * SR, SR);
        const m = new M.Mixer(ctx);
        m.output.connect(ctx.destination);
        const buf = ctx.createBuffer(1, 2 * SR, SR);
        const d = buf.getChannelData(0);
        for (const t0 of [0.1, 1.1]) {                               // two 50 ms bursts
          for (let i = 0; i < 0.05 * SR; i++) d[Math.round(t0 * SR) + i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / SR);
        }
        const src = ctx.createBufferSource();
        src.buffer = buf; src.connect(m.channel(1).input); src.start();
        const fx = new F.BeatFx(ctx, m, () => 128, { decks: [] });
        fx.select(1);                                                // Echo
        fx.beat(-1); fx.beat(-1);                                    // 1/2 beat = 234 ms
        fx.setLevel(1);
        if (turnOn) {
          fx.setOn(true);
          ctx.suspend(0.2).then(() => { fx.setOn(false); ctx.resume(); });
        }
        const out = await ctx.startRendering();
        const R = out.getChannelData(1);
        return {
          name: fx.state.name, on: fx.state.on,
          repeat2: rmsDb(R, 0.575, 0.61),      // 0.1 + 2 x 0.234: after off
          repeat4: rmsDb(R, 1.045, 1.08),      // 0.1 + 4 x 0.234: still ringing
          noNewEcho: rmsDb(R, 1.340, 1.38),    // where the second burst's echo would be
        };
      }
      return { on: await render(true), never: await render(false) };
    }""")
    print(f"\necho tail: {r}")
    on, never = r["on"], r["never"]
    assert on["name"] == "Echo" and on["on"] is False, r
    assert on["repeat2"] > -30, f"no tail after off: {r}"
    assert on["repeat4"] > -50, f"tail died too early: {r}"
    assert never["repeat2"] < -90, f"the control render has an echo: {r}"
    assert on["noNewEcho"] < -60, f"the input was not closed at off: {r}"


def test_sampler_plays_through_the_master_only(proof_page):
    r = proof_page.evaluate("async () => {" + IMPORTS + """
      const ctx = new OfflineAudioContext(2, SR, SR);
      const m = new M.Mixer(ctx);
      m.output.connect(ctx.destination);
      m.channel(1).setFader(0); m.channel(2).setFader(0);
      m.setPhonesMix(0);                                  // phones: cue only
      const s = new S.Sampler(ctx, m.samplerInput);
      const hits = [];
      for (let i = 0; i < 8; i++) {
        ctx.suspend(0.1 * (i + 1)).then(() => { s.trigger(i); ctx.resume(); });
      }
      const out = await ctx.startRendering();
      const L = out.getChannelData(0), R = out.getChannelData(1);
      for (let i = 0; i < 8; i++) hits.push(rmsDb(R, 0.1 * (i + 1), 0.1 * (i + 1) + 0.04));
      return { hits, left: rmsDb(L, 0, 1) };
    }""")
    print(f"\nsampler: {r}")
    for i, h in enumerate(r["hits"]):
        # -50 dB, not -45: the rim pad is unseeded noise and once read -45.7 dB
        # over this 40 ms window; silence is far below either line
        assert h > -50, f"pad {i + 1} silent: {r}"
    assert r["left"] < -90, f"sampler reached the cue ear with MIX on cue: {r}"


def test_sampler_hit_sits_at_deck_level(proof_page):
    """A sampler hit at full GAIN and the same sound played by a deck at
    unity (TRIM center, EQ flat, fader up, crossfader to it) peak within 1 dB
    on the master: both pass the same OUTPUT_LEVEL_DB headroom. The pad is
    the sub drop (pad 7): no noise in it, so the two renders are the same
    sound (each Sampler makes its own random noise buffer)."""
    r = proof_page.evaluate("async () => {" + IMPORTS + """
      const PAD = 6;
      // the raw sub drop, as the sampler voice makes it
      let ctx = new OfflineAudioContext(1, 2 * SR, SR);
      let s = new S.Sampler(ctx, ctx.destination);
      s.setGain(1);
      ctx.suspend(0.1).then(() => { s.trigger(PAD); ctx.resume(); });
      const raw = await ctx.startRendering();
      // sampler hit at 0.1 s, the same sound from a deck at 2.0 s
      ctx = new OfflineAudioContext(2, 4 * SR, SR);
      const m = new M.Mixer(ctx);
      m.masterTap.connect(ctx.destination);
      m.setCrossfader(0);
      const buf = ctx.createBuffer(1, 2 * SR, SR);
      buf.getChannelData(0).set(raw.getChannelData(0).subarray(Math.round(0.1 * SR), Math.round(1.7 * SR)));
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(m.channel(1).input); src.start(2.0);
      s = new S.Sampler(ctx, m.samplerInput);
      s.setGain(1);
      ctx.suspend(0.1).then(() => { s.trigger(PAD); ctx.resume(); });
      const out = await ctx.startRendering();
      const R = out.getChannelData(0);
      const pk = (t0, t1) => { let p = 0; for (let i = Math.round(t0 * SR); i < Math.round(t1 * SR); i++) p = Math.max(p, Math.abs(R[i])); return p; };
      const rawPk = (() => { const a = raw.getChannelData(0); let p = 0; for (const v of a) p = Math.max(p, Math.abs(v)); return p; })();
      return { sampler: pk(0.1, 1.7), deck: pk(2.0, 3.6), raw: rawPk };
    }""")
    import math
    diff = 20 * math.log10(r["sampler"] / r["deck"])
    print(f"\nsampler vs deck: {r}, {diff:+.2f} dB")
    assert r["deck"] > 0.1, r
    assert abs(diff) < 1, f"sampler hit {diff:+.2f} dB against the deck"


def test_beat_fx_roll_slips_back_on_the_grid(proof_page, carried):
    """Roll 1 beat on a real deck through the mixer, held 2.5 beats: while
    rolling the soft beat repeats, and after off the track is where it would
    have been (the loud downbeat lands on its original time, within 1 ms)."""
    r = proof_page.evaluate("async (file) => {" + IMPORTS + """
      const { Deck } = await import('/static/cabine/engine/deck.js');
      const { DeckVoice } = await import('/static/cabine/engine/deck-voice.js');
      const { loadTrack, networkSource } = await import('/static/cabine/engine/loader.js');
      const sr = 44100;
      const ctx = new OfflineAudioContext(2, Math.round(3.6 * sr), sr);
      const m = new M.Mixer(ctx);
      m.output.connect(ctx.destination);
      const voice = await DeckVoice.create(ctx, { testHooks: true });
      voice.connect(m.channel(1).input);
      const deck = new Deck(voice, { now: () => ctx.currentTime });
      deck.load(await loadTrack(ctx, networkSource(), file));      // 120 BPM, beats at 0.25 + k/2
      const fx = new F.BeatFx(ctx, m, () => deck.effectiveBpm(), { decks: [deck, null] });
      for (let i = 0; i < 4; i++) fx.select(1);                        // Roll, 1 beat, CH 1
      deck._seekNow(1.0, 0);
      deck.playPause();
      await voice.sync();
      const marks = {};
      ctx.suspend(0.3).then(async () => {                              // at 1.3 s: roll from 1.25
        fx.setOn(true); marks.roll = deck.state.roll; await voice.sync(); ctx.resume();
      });
      ctx.suspend(1.55).then(async () => {                             // 2.5 beats later
        fx.setOn(false); marks.after = deck.state.roll; await voice.sync(); ctx.resume();
      });
      const out = await ctx.startRendering();
      const R = out.getChannelData(1);
      const peak = (t) => { let p = 0; for (let i = Math.round((t - 0.01) * sr); i < Math.round((t + 0.03) * sr); i++) p = Math.max(p, Math.abs(R[i])); return p; };
      const onset = (t) => { for (let i = Math.round((t - 0.05) * sr); i < R.length; i++) if (Math.abs(R[i]) > 0.1) return i / sr; return -1; };
      return { roll: marks.roll, after: marks.after, name: fx.state.name,
               p125: peak(1.25), p225: peak(2.25), p325: peak(3.25), on325: onset(3.25) };
    }""", carried["click120"])
    print(f"\nroll: {r}")
    assert r["name"] == "Roll" and r["roll"] == {"beats": 1, "in": 1.25, "out": 1.75}, r
    assert r["after"] is None, r
    # unrolled, 1.25 s would be track 2.25 (a downbeat, loud); rolled it is the soft beat at 1.25
    assert r["p125"] < 0.8 * r["p325"], f"no roll: {r}"
    # with slip, 2.25 s is track 3.25 (soft) and 3.25 s is track 4.25 (loud)
    assert r["p225"] < 0.8 * r["p325"], f"no slip: {r}"
    assert abs(r["on325"] - 3.25) < 0.001, f"downbeat off by {1000 * (r['on325'] - 3.25):.2f} ms"


def test_master_never_clips_and_split_stays_aligned(proof_page):
    """Two in-phase 0 dBFS decks at crossfader center, trims and LOW at full,
    plus a sampler kick, every cue on: neither ear nor masterTap goes past
    1.0. The clipper has no latency, so cue and master stay sample-aligned."""
    r = proof_page.evaluate("async () => {" + IMPORTS + """
      async function loud(tapMaster) {
        const ctx = new OfflineAudioContext(2, SR, SR);
        const m = new M.Mixer(ctx);
        if (tapMaster) m.masterTap.connect(ctx.destination); else m.output.connect(ctx.destination);
        const o = ctx.createOscillator();
        o.frequency.value = 100; o.start();
        o.connect(m.channel(1).input); o.connect(m.channel(2).input);   // same phase
        for (const n of [1, 2]) {
          const ch = m.channel(n);
          ch.setTrim(1); ch.setEq('low', 1); ch.setFader(1); ch.setCue(true);
        }
        m.setMasterCue(true);
        m.setPhonesLevel(1);
        const s = new S.Sampler(ctx, m.samplerInput);
        ctx.suspend(0.5).then(() => { s.trigger(0); s.trigger(6); ctx.resume(); });
        const out = await ctx.startRendering();
        const pk = (a) => { let p = 0; for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i])); return p; };
        return { left: pk(out.getChannelData(0)), right: pk(out.getChannelData(1)) };
      }
      // the same impulse in the cue ear and the master ear, at a level that clips
      async function aligned(amp) {
        const ctx = new OfflineAudioContext(2, SR, SR);
        const m = new M.Mixer(ctx);
        m.output.connect(ctx.destination);
        const buf = ctx.createBuffer(1, SR, SR);
        buf.getChannelData(0)[Math.round(0.3 * SR)] = amp;
        const src = ctx.createBufferSource();
        src.buffer = buf; src.connect(m.channel(1).input); src.start();
        m.setCrossfader(0); m.channel(1).setCue(true); m.setPhonesMix(0); m.setPhonesLevel(1);
        const out = await ctx.startRendering();
        const am = (a) => { let k = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > Math.abs(a[k])) k = i; return k; };
        return am(out.getChannelData(0)) - am(out.getChannelData(1));
      }
      // the same tone level in both ears below the knee: the clipper is transparent
      const quiet = async () => {
        const ctx = new OfflineAudioContext(2, SR, SR);
        const m = new M.Mixer(ctx);
        m.output.connect(ctx.destination);
        osc(ctx, 440, 0.5).connect(m.channel(1).input);
        m.setCrossfader(0); m.channel(1).setCue(true); m.setPhonesMix(0); m.setPhonesLevel(1);
        const out = await ctx.startRendering();
        return [toneDb(out.getChannelData(0), 440, 0.3, 1), toneDb(out.getChannelData(1), 440, 0.3, 1)];
      };
      return { ears: await loud(false), tap: await loud(true),
               lagQuiet: await aligned(0.5), lagLoud: await aligned(8), quiet: await quiet() };
    }""")
    print(f"\nheadroom: {r}")
    assert r["ears"]["right"] < 1.0, f"master ear clips: {r}"
    assert r["ears"]["left"] < 1.0, f"phones ear clips: {r}"
    assert r["tap"]["left"] < 1.0 and r["tap"]["right"] < 1.0, f"masterTap reaches 1.0: {r}"
    assert r["ears"]["right"] > 0.8, f"the loud mix should still be loud: {r}"
    assert r["lagQuiet"] == 0 and r["lagLoud"] == 0, f"cue and master not aligned: {r}"
    assert abs(r["quiet"][0] - r["quiet"][1]) < 0.01, f"ears differ below the knee: {r}"

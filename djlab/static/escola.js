/* Lado D, Escola: seven hands-on lessons in rhythm, synthesis, keys,
   warping, beatmatching, sidechain and EQ. Everything is synthesized
   in the browser or pulled from the crate previews. */

(function () {
  const q = (sel, el = document) => el.querySelector(sel);
  const qa = (sel, el = document) => [...el.querySelectorAll(sel)];
  const db = v => Math.pow(10, v / 20);
  const nameOf = f => f.split("/").pop().replace(/\.(wav|mp3|flac|m4a)$/, "");
  const toLog = (v, lo, hi) => lo * Math.pow(hi / lo, v / 100);
  const fromLog = (hz, lo, hi) => Math.round(100 * Math.log(hz / lo) / Math.log(hi / lo));

  let _ctx = null;
  const AC = () => _ctx || (_ctx = new (window.AudioContext || window.webkitAudioContext)());
  const emit = ev => { if (window.escolaEmit) window.escolaEmit(ev); };

  /* every sounding widget registers a stop fn. Modules are free to sound
     TOGETHER (that is the point of the mesa): starting one no longer
     silences the rest. The mesa bar lists what is live, can kill each
     channel, stop everything, record the bus and press sessions. */
  const running = new Map();   /* stopFn -> module name */
  function hush() { [...running.keys()].forEach(f => f()); if (window.__appStop) window.__appStop(); }
  function claim(name, stopFn) {
    const fresh = !running.has(stopFn);
    running.set(stopFn, name);
    if (fresh) {
      diario("ao vivo: " + name);
      if (running.size >= 2) diario("jam: " + [...running.values()].join(" + "));
    }
    if (running.size >= 2) emit("jam-duo");
    mesaLive();
  }
  function release(stopFn) { running.delete(stopFn); mesaLive(); }
  if (window.stopAllPlayback) {
    window.__appStop = window.stopAllPlayback;
    window.stopAllPlayback = function () { window.__appStop(); [...running.keys()].forEach(f => f()); };
  }

  /* master bus: every widget sounds through a named channel strip into this,
     so the mesa can ride, place and wet each module without the module knowing.
     A strip is fader -> pan -> (dry + reverb send + delay send). The sum runs
     through master EQ and glue compression into a brick limiter, so ten
     modules at once do not clip. */
  let _bus = null, _limiter = null, _an = null;
  let _mEq = null, _mComp = null, _revBus = null, _dlyBus = null, _dly = null;

  /* a plate is just noise decaying into silence: cheap, and no impulse to ship */
  function makeIR(seconds, decay) {
    const ctx = AC();
    const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
    return buf;
  }

  function BUS() {
    if (!_bus) {
      const ctx = AC();
      _bus = ctx.createGain();
      _bus.gain.value = 0.9;
      _mEq = {
        low: new BiquadFilterNode(ctx, { type: "lowshelf", frequency: 120, gain: 0 }),
        mid: new BiquadFilterNode(ctx, { type: "peaking", frequency: 1000, Q: 0.7, gain: 0 }),
        high: new BiquadFilterNode(ctx, { type: "highshelf", frequency: 6000, gain: 0 }),
      };
      _mComp = new DynamicsCompressorNode(ctx, {
        threshold: -18, knee: 6, ratio: 3, attack: 0.012, release: 0.25 });
      _limiter = new DynamicsCompressorNode(ctx, {
        threshold: -9, knee: 3, ratio: 12, attack: 0.002, release: 0.12 });
      _bus.connect(_mEq.low).connect(_mEq.mid).connect(_mEq.high)
        .connect(_mComp).connect(_limiter).connect(ctx.destination);
      _an = ctx.createAnalyser();
      _an.fftSize = 1024;
      _an.smoothingTimeConstant = 0.5;
      _limiter.connect(_an);

      /* two send buses every channel can feed: a plate and a dub delay. Both
         return into the bus ahead of the master chain, so they get glued too. */
      const conv = ctx.createConvolver();
      conv.buffer = makeIR(2.4, 2.6);
      _revBus = ctx.createGain();
      const revRet = ctx.createGain(); revRet.gain.value = 0.9;
      _revBus.connect(conv).connect(revRet).connect(_bus);

      _dlyBus = ctx.createGain();
      _dly = ctx.createDelay(2);
      _dly.delayTime.value = (60 / TR.bpm) * 0.75;   /* a dotted eighth, retuned with the tempo */
      const fb = ctx.createGain(); fb.gain.value = 0.38;
      const tone = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 2600 });
      const dlyRet = ctx.createGain(); dlyRet.gain.value = 0.8;
      _dlyBus.connect(_dly);
      _dly.connect(tone).connect(fb).connect(_dly);   /* the repeats, darkening each pass */
      _dly.connect(dlyRet).connect(_bus);
    }
    return _bus;
  }
  const CHANNELS = {};
  function CHAN(name) {
    if (!CHANNELS[name]) {
      const ctx = AC();
      BUS();
      const g = ctx.createGain();          /* the node modules sound into: the fader */
      const pan = ctx.createStereoPanner();
      const dry = ctx.createGain();
      const rev = ctx.createGain(); rev.gain.value = 0;
      const dly = ctx.createGain(); dly.gain.value = 0;
      const an = ctx.createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.6;
      g.connect(pan);
      pan.connect(dry).connect(_bus);
      pan.connect(rev).connect(_revBus);
      pan.connect(dly).connect(_dlyBus);
      pan.connect(an);
      CHANNELS[name] = { g, pan, rev, dly, an, muted: false, solo: false, vol: 1 };
    }
    return CHANNELS[name].g;
  }
  const anySolo = () => Object.keys(CHANNELS).some(n => CHANNELS[n].solo);
  /* a soloed channel silences every channel that is not soloed, mute aside */
  function chanApply(name) {
    const ch = CHANNELS[name];
    if (!ch) return;
    const solo = anySolo();
    const open = !ch.muted && (!solo || ch.solo);
    ch.g.gain.setTargetAtTime(open ? ch.vol : 0.0001, AC().currentTime, 0.015);
  }
  function chanApplyAll() { Object.keys(CHANNELS).forEach(chanApply); }
  function chanKill(name, muted) {
    if (!CHANNELS[name]) return;
    CHANNELS[name].muted = muted;
    chanApply(name);
    mixerSync();
  }
  function chanVol(name, vol) {
    CHAN(name);
    CHANNELS[name].vol = vol;
    chanApply(name);
    mixerSync();
  }
  function chanSolo(name, on) {
    CHAN(name);
    CHANNELS[name].solo = on;
    chanApplyAll();
    mixerSync();
  }
  function chanPan(name, v) {
    CHAN(name);
    CHANNELS[name].pan.pan.setTargetAtTime(v, AC().currentTime, 0.02);
  }
  function chanSend(name, which, v) {
    CHAN(name);
    CHANNELS[name][which].gain.setTargetAtTime(v, AC().currentTime, 0.02);
  }

  /* shared transport: clocked modules that start at the mesa tempo land on
     the same beat grid, so grade + duck phase-lock instead of flamming */
  const TR = { bpm: 132, epoch: 0, quant: 0, cycle: 4, pending: 0 };
  const trBar = () => 60 / TR.bpm * 4;
  /* launch quantize: with quant set, a module entering the jam waits for the
     next bar (or the top of the cycle) instead of starting under your finger.
     Retempo calls pass launch=false: those must land on the nearest step
     rather than leaving a bar of silence behind. */
  function trAlign(stepDur, launch = true) {
    const ctx = AC();
    if (!TR.epoch) TR.epoch = ctx.currentTime + 0.1;
    const now = ctx.currentTime + 0.08;
    if (launch && TR.quant > 0) {
      const win = TR.quant * trBar();
      const t = TR.epoch + Math.max(0, Math.ceil((now - TR.epoch) / win)) * win;
      /* a quantized launch can sit silent for bars. The strip counts it down
         so the desk never looks like it ignored you. */
      TR.pending = Math.max(TR.pending, t);
      return { t, k: Math.round((t - TR.epoch) / stepDur) };
    }
    const k = Math.max(0, Math.ceil((now - TR.epoch) / stepDur));
    return { t: TR.epoch + k * stepDur, k };
  }
  /* where the desk is right now, counted in sixteenths from the epoch */
  function trPos() {
    if (!TR.epoch || !_ctx) return { bar: 1, beat: 1, step: 1, cyc: 1 };
    const step = Math.max(0, Math.floor((_ctx.currentTime - TR.epoch) / (60 / TR.bpm / 4)));
    const bars = Math.floor(step / 16);
    return {
      bar: bars + 1,
      beat: Math.floor(step / 4) % 4 + 1,
      step: step % 4 + 1,
      cyc: TR.cycle > 0 ? bars % TR.cycle + 1 : bars + 1,
    };
  }

  /* built widgets register here so the mesa can save/load/retempo them */
  const MOD = {};

  /* ---------- shared voices ---------- */

  let _noise = null;
  function noiseBuf() {
    if (_noise) return _noise;
    const ctx = AC();
    _noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = _noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return _noise;
  }
  function noiseSrc(t, dur) {
    const s = AC().createBufferSource();
    s.buffer = noiseBuf(); s.loop = true;
    s.start(t); s.stop(t + dur + 0.05);
    return s;
  }
  function nHit(t, vel, out, { type, freq, Q = 1, dec, atk = 0 }) {
    const ctx = AC();
    const f = new BiquadFilterNode(ctx, { type, frequency: freq, Q });
    const g = ctx.createGain();
    if (atk > 0) {
      g.gain.setValueAtTime(0.0012, t);
      g.gain.linearRampToValueAtTime(vel, t + atk);
    } else g.gain.setValueAtTime(vel, t);
    g.gain.exponentialRampToValueAtTime(0.0012, t + atk + dec);
    noiseSrc(t, atk + dec).connect(f).connect(g).connect(out);
  }
  const DRUMS = {
    kick(t, vel, out, punch = 150) {
      const ctx = AC();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(punch, t);
      o.frequency.exponentialRampToValueAtTime(44, t + 0.09);
      g.gain.setValueAtTime(vel, t);
      g.gain.exponentialRampToValueAtTime(0.0012, t + 0.30);
      o.connect(g).connect(out);
      o.start(t); o.stop(t + 0.32);
      nHit(t, vel * 0.4, out, { type: "highpass", freq: 3000, dec: 0.018 });
    },
    sub(t, vel, out) {
      const ctx = AC();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = 55;
      g.gain.setValueAtTime(vel * 0.9, t);
      g.gain.exponentialRampToValueAtTime(0.0012, t + 0.28);
      o.connect(g).connect(out);
      o.start(t); o.stop(t + 0.3);
    },
    hat(t, vel, out) { nHit(t, vel * 0.5, out, { type: "highpass", freq: 7500, dec: 0.045 }); },
    ohat(t, vel, out) { nHit(t, vel * 0.4, out, { type: "highpass", freq: 6200, dec: 0.26 }); },
    rim(t, vel, out) { nHit(t, vel * 0.8, out, { type: "bandpass", freq: 1900, Q: 8, dec: 0.07 }); },
    shaker(t, vel, out) { nHit(t, vel * 0.5, out, { type: "bandpass", freq: 4300, Q: 1.5, dec: 0.08, atk: 0.012 }); },
  };

  function droneVoice(hz, out, { lp = 1100, fifth = false, gain = 0.14 } = {}) {
    const ctx = AC();
    const g = ctx.createGain(); g.gain.value = 0.0001;
    const f = new BiquadFilterNode(ctx, { type: "lowpass", frequency: lp, Q: 0.7 });
    const oscs = [];
    const mk = (freq, det) => {
      const o = ctx.createOscillator();
      o.type = "sawtooth"; o.frequency.value = freq; o.detune.value = det;
      o.connect(f); o.start(); oscs.push(o);
    };
    mk(hz, -6); mk(hz, 6);
    if (fifth) mk(hz * Math.pow(2, 7 / 12), 0);
    f.connect(g).connect(out);
    g.gain.setTargetAtTime(gain, ctx.currentTime, 0.06);
    return {
      stop() {
        const t = AC().currentTime;
        g.gain.setTargetAtTime(0.0001, t, 0.08);
        oscs.forEach(o => { try { o.stop(t + 0.6); } catch (e) {} });
      },
    };
  }

  const PC = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5,
               "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };
  const hzOf = (pc, oct) => 440 * Math.pow(2, (PC[pc] - 9 + (oct - 4) * 12) / 12);

  /* ---------- crate data + previews ---------- */

  let _crate = null;
  async function crate() {
    if (!_crate) {
      const st = await (await fetch("/api/state")).json();
      _crate = (st.analysis || []).filter(a => !a.error);
    }
    return _crate;
  }
  const _bufs = {};
  function previewBuf(fname) {
    if (!_bufs[fname]) {
      _bufs[fname] = fetch(`/api/source/preview?file=${encodeURIComponent(fname)}`)
        .then(r => { if (!r.ok) throw new Error("preview failed"); return r.arrayBuffer(); })
        .then(b => AC().decodeAudioData(b));
    }
    return _bufs[fname];
  }
  const _sbufs = {};
  function stemPreviewBuf(fname, stem) {
    const k = fname + "::" + stem;
    if (!_sbufs[k]) {
      _sbufs[k] = fetch(`/api/source/stem-preview?file=${encodeURIComponent(fname)}&stem=${stem}`)
        .then(r => {
          if (!r.ok) throw new Error(r.status === 409 ? "not separated" : "stem preview failed");
          return r.arrayBuffer();
        })
        .then(b => AC().decodeAudioData(b));
      _sbufs[k].catch(() => { delete _sbufs[k]; });
    }
    return _sbufs[k];
  }

  const sizeCanvas = (c, h) => {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 300;
    if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
    if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
    return c.getContext("2d");
  };

  /* ================= 01 A Grade: step sequencer ================= */

  const VOICES = [["kick", "kick"], ["sub", "sub"], ["hat", "cl hat"],
                  ["ohat", "op hat"], ["rim", "rim"], ["shaker", "shaker"]];
  /* portrait phones get the grid in two stacked halves instead of a side-scroll */
  const SEQ_MQ = window.matchMedia("(max-width: 640px)");
  const SEQ_BANKS = ["A", "B", "C", "D"];
  let _seqMQ = null;
  const P = (steps, rows, note) => ({ steps, rows, note });
  const SEQ_PRESETS = {
    "roller 4/4 (frame 1)": P(16,
      { kick: { 0: 2, 4: 2, 8: 2, 12: 2 }, ohat: { 2: 1, 6: 1, 10: 1, 14: 1 },
        shaker: { 0: 2, 2: 1, 4: 2, 6: 1, 8: 2, 10: 1, 12: 2, 14: 1 } },
      "the bones of hypnotic techno: kick on every beat, open hats breathing on the offbeats."),
    "rolling wave (frame 2)": P(16,
      { kick: { 0: 2, 4: 2, 8: 2, 12: 2 },
        hat: { 0: 2, 1: 1, 2: 1, 3: 1, 4: 2, 5: 1, 6: 1, 7: 1, 8: 2, 9: 1, 10: 1, 11: 1, 12: 2, 13: 1, 14: 1, 15: 1 } },
      "sixteenth hats where only the accents move. The loud-soft wave, not the notes, makes it roll. Add swing."),
    "broken (frame 3)": P(16,
      { kick: { 0: 2, 7: 1, 10: 2, 13: 1 }, sub: { 2: 2, 8: 1, 11: 2 },
        rim: { 3: 1, 9: 1, 14: 1 }, hat: { 2: 1, 10: 1 } },
      "the kick leaves the grid and a syncopated sub answers it. Livity school."),
    "tresillo / baiao": P(16,
      { kick: { 0: 2, 3: 1, 6: 1, 8: 2, 11: 1, 14: 1 }, rim: { 4: 1, 12: 1 },
        shaker: { 0: 1, 2: 1, 4: 1, 6: 1, 8: 1, 10: 1, 12: 1, 14: 1 } },
      "3+3+2, the tresillo: the cell under baiao, and under half of all dance music."),
    "maracatu": P(16,
      { kick: { 0: 2, 4: 2, 8: 2, 12: 2, 14: 1 }, sub: { 3: 2, 11: 2 }, rim: { 6: 1, 13: 1 },
        shaker: { 0: 1, 2: 1, 4: 1, 6: 1, 8: 1, 10: 1, 12: 1, 14: 1 } },
      "alfaia weight falling off the beat, bell on the crossbar. Frame 6 industrializes this."),
    "6/8 atabaque (frame 7)": P(12,
      { kick: { 0: 2, 3: 1, 6: 2, 9: 1 }, rim: { 2: 1, 5: 1, 8: 1, 11: 1 },
        shaker: { 0: 2, 1: 1, 2: 1, 3: 2, 4: 1, 5: 1, 6: 2, 7: 1, 8: 1, 9: 2, 10: 1, 11: 1 } },
      "a 12-step grid, three cells per beat: candomble 6/8 locks in without touching the warp."),
    "empty 16": P(16, {}, "yours. Start with a kick on 1, 2, 3, 4 and then break it."),
    "empty 12 (6/8)": P(12, {},
      "the triplet grid, empty. Kicks on the four beats, rims in the gaps, and you have frame 7's spine."),
  };

  function buildSeq(el) {
    el.innerHTML = `
      <div class="esc-controls">
        <button class="ghost" data-a="play">play</button>
        <label title="a groove to start from: each one explains itself in the note below. Edit the cells while it runs">preset <select data-k="preset">
          ${Object.keys(SEQ_PRESETS).map(n => `<option>${n}</option>`).join("")}
        </select></label>
        <label title="how fast the grid runs, in beats per minute. The mesa tempo and sync push this too">bpm <b data-v="bpm">132</b>
          <input type="range" min="100" max="170" value="132" data-k="bpm"></label>
        <label title="delays every second cell: 0 = rigid machine, around 0.15 it rolls, past 0.4 it limps">swing <b data-v="swing">0.18</b>
          <input type="range" min="0" max="0.6" step="0.01" value="0.18" data-k="swing"></label>
      </div>
      <div class="esc-controls seq-banks">
        <span class="bank-lab">bancos</span>
        ${SEQ_BANKS.map((b, i) => `<button class="ghost bank${i === 0 ? " active" : ""}"
          data-bank="${i}" title="pattern ${b}: four grids you can switch between and chain">${b}</button>`).join("")}
        <button class="ghost" data-a="copy" title="copy this bank over the next one">copiar &rarr;</button>
        <label title="the scene: which banks play, in what order. They swap on the bar, never mid pattern">cena
          <input type="text" data-k="chain" placeholder="A A B A" size="9"></label>
        <button class="ghost" data-a="chain" title="run the scene instead of looping one bank">tocar a cena</button>
      </div>
      <p class="side-note esc-note" data-v="note"></p>
      <div class="seq"></div>
      <p class="side-note esc-note">provas live in this grid: rebuild the <b>tresillo</b> kick from
        "empty 16" (peek at the preset, then do it by memory), and the <b>6/8 skeleton</b> from
        "empty 12" (kicks on the beats, rims in the gaps). The grid checks silently and stamps you
        the moment it matches.</p>`;
    let bpm = 132, swing = 0.18, stepsN = 16, grid = [], playing = false,
        timer = null, cur = 0, nextT = 0, master = null, phCol = -1, edited = false,
        lastPreset = "";
    /* four grids in the machine at once, and a scene that walks them */
    let banks = SEQ_BANKS.map(() => null), bank = 0;
    let chain = [], chainOn = false, chainPos = 0;
    const drawQ = [];
    const gridEl = q(".seq", el), playBtn = q("[data-a=play]", el);

    function checkProvas() {
      const hits = r => grid[r].map((v, i) => v ? i : -1).filter(i => i >= 0).join(",");
      if (lastPreset === "empty 16" && hits(0) === "0,3,6,8,11,14") emit("prova-tresillo");
      if (lastPreset === "empty 12 (6/8)" && hits(0) === "0,3,6,9" && hits(4) === "2,5,8,11")
        emit("prova-clave");
    }
    /* the grid draws itself from `grid`. On a portrait phone sixteen steps do
       not fit, so it splits into two stacked halves of eight (bars 1-2 above
       bars 3-4) instead of asking for a horizontal scroll or a rotated phone. */
    function renderGrid() {
      const perBeat = stepsN / 4;
      const split = SEQ_MQ.matches && stepsN >= 8;
      const chunks = split ? [[0, stepsN / 2], [stepsN / 2, stepsN]] : [[0, stepsN]];
      gridEl.innerHTML = chunks.map(([a, b]) => {
        const n = b - a;
        const cells = (mk) => Array.from({ length: n }, (_, i) => mk(a + i)).join("");
        const head = `<div class="seq-row" style="--n:${n}"><span class="seq-lab"></span>
          <div class="seq-steps">${cells(s =>
            `<span class="seq-beat">${s % perBeat === 0 ? s / perBeat + 1 : ""}</span>`)}</div></div>`;
        const rows = VOICES.map(([vk, lab], r) =>
          `<div class="seq-row" style="--n:${n}"><span class="seq-lab">${lab}</span>
            <div class="seq-steps">${cells(s => {
              const v = grid[r][s];
              return `<button type="button" class="seq-cell${s % perBeat === 0 ? " b0" : ""}${v === 2 ? " acc" : v ? " on" : ""}"
                data-r="${r}" data-s="${s}"></button>`;
            })}</div></div>`).join("");
        return `<div class="seq-half">${head}${rows}</div>`;
      }).join("");
      qa(".seq-cell", gridEl).forEach(c => c.addEventListener("click", () => {
        const r = +c.dataset.r, s = +c.dataset.s;
        grid[r][s] = (grid[r][s] + 1) % 3;
        qa(`.seq-cell[data-r="${r}"][data-s="${s}"]`, gridEl).forEach(x => {
          x.classList.toggle("on", grid[r][s] === 1);
          x.classList.toggle("acc", grid[r][s] === 2);
        });
        edited = true;
        if (playing) emit("seq-own");
        checkProvas();
      }));
      if (phCol >= 0) qa(`.seq-cell[data-s="${phCol}"]`, gridEl).forEach(c => c.classList.add("ph"));
    }
    /* redraw when the phone is rotated across the split threshold. Only the
       newest build listens: a station reset replaces the handler. */
    if (_seqMQ) {
      if (SEQ_MQ.removeEventListener) SEQ_MQ.removeEventListener("change", _seqMQ);
      else SEQ_MQ.removeListener(_seqMQ);
    }
    _seqMQ = () => renderGrid();
    if (SEQ_MQ.addEventListener) SEQ_MQ.addEventListener("change", _seqMQ);
    else SEQ_MQ.addListener(_seqMQ);

    function buildGrid(name) {
      const p = SEQ_PRESETS[name];
      lastPreset = name;
      stepsN = p.steps;
      grid = VOICES.map(([vk]) =>
        Array.from({ length: stepsN }, (_, s) => (p.rows[vk] || {})[s] || 0));
      q("[data-v=note]", el).textContent = p.note;
      cur = 0; phCol = -1;
      renderGrid();
    }

    function schedule() {
      const ctx = AC();
      while (nextT < ctx.currentTime + 0.12) {
        const dur = 60 / bpm / (stepsN / 4);
        const t = nextT + (cur % 2 === 1 ? swing * dur : 0);
        VOICES.forEach(([vk], r) => {
          const lvl = grid[r][cur];
          if (lvl) DRUMS[vk](t, lvl === 2 ? 1.0 : 0.5, master);
        });
        drawQ.push({ step: cur, t });
        nextT += dur;
        cur = (cur + 1) % stepsN;
        /* the scene only ever turns the page on the bar line */
        if (cur === 0 && chainOn && chain.length) {
          chainPos = (chainPos + 1) % chain.length;
          switchBank(chain[chainPos], true);
        }
      }
    }
    function playhead() {
      if (!playing) return;
      const now = AC().currentTime;
      while (drawQ.length && drawQ[0].t <= now) {
        const { step } = drawQ.shift();
        if (phCol >= 0) qa(`.seq-cell[data-s="${phCol}"]`, gridEl).forEach(c => c.classList.remove("ph"));
        qa(`.seq-cell[data-s="${step}"]`, gridEl).forEach(c => c.classList.add("ph"));
        phCol = step;
      }
      requestAnimationFrame(playhead);
    }
    function stop() {
      if (!playing) return;
      playing = false;
      clearInterval(timer);
      drawQ.length = 0;
      if (phCol >= 0) qa(`.seq-cell[data-s="${phCol}"]`, gridEl).forEach(c => c.classList.remove("ph"));
      phCol = -1;
      playBtn.textContent = "play";
      release(stop);
    }
    playBtn.addEventListener("click", () => {
      if (playing) { stop(); return; }
      claim("grade", stop);
      const ctx = AC(); ctx.resume();
      if (!master) { master = ctx.createGain(); master.gain.value = 0.85; master.connect(CHAN("grade")); }
      playing = true;
      const al = trAlign(60 / bpm / (stepsN / 4));
      nextT = al.t; cur = al.k % stepsN;
      timer = setInterval(schedule, 25);
      playBtn.textContent = "stop";
      requestAnimationFrame(playhead);
      emit("seq-play");
      if (edited) emit("seq-own");
      if (swing >= 0.25) emit("seq-swing");
    });
    /* a bank is the whole pattern: its grid, its length and where it came from */
    function saveBank() {
      banks[bank] = { grid: grid.map(r => r.slice()), stepsN, preset: lastPreset };
    }
    /* load only: the caller decides whether the outgoing bank is worth keeping */
    function loadBank(i, keepPlaying) {
      bank = i;
      const b = banks[bank];
      if (b) {
        grid = b.grid.map(r => r.slice());
        stepsN = b.stepsN;
        lastPreset = b.preset;
      }
      if (!keepPlaying) { cur = 0; phCol = -1; }
      renderGrid();
      qa(".bank", el).forEach(btn => btn.classList.toggle("active", +btn.dataset.bank === bank));
    }
    function switchBank(i, keepPlaying) {
      if (i === bank && keepPlaying) return;
      saveBank();
      loadBank(i, keepPlaying);
    }
    qa(".bank", el).forEach(btn =>
      btn.addEventListener("click", () => switchBank(+btn.dataset.bank, false)));
    q("[data-a=copy]", el).addEventListener("click", () => {
      saveBank();
      const to = (bank + 1) % SEQ_BANKS.length;
      banks[to] = { grid: grid.map(r => r.slice()), stepsN, preset: lastPreset };
      diario(`banco ${SEQ_BANKS[bank]} copiado para ${SEQ_BANKS[to]}`);
    });
    function parseChain(s) {
      return String(s).toUpperCase().split("").map(c => SEQ_BANKS.indexOf(c)).filter(i => i >= 0);
    }
    q("[data-a=chain]", el).addEventListener("click", () => {
      const btn = q("[data-a=chain]", el);
      if (chainOn) {
        chainOn = false;
        btn.classList.remove("active");
        btn.textContent = "tocar a cena";
        return;
      }
      chain = parseChain(q("[data-k=chain]", el).value);
      if (!chain.length) {
        diario("a cena precisa de bancos: escreva algo como A A B A");
        return;
      }
      saveBank();
      chainOn = true;
      chainPos = 0;
      switchBank(chain[0], playing);
      btn.classList.add("active");
      btn.textContent = "parar a cena";
      diario("cena: " + chain.map(i => SEQ_BANKS[i]).join(" "));
    });
    q("[data-k=preset]", el).addEventListener("change", e => buildGrid(e.target.value));
    q("[data-k=bpm]", el).addEventListener("input", e => {
      bpm = +e.target.value; q("[data-v=bpm]", el).textContent = bpm;
    });
    q("[data-k=swing]", el).addEventListener("input", e => {
      swing = +e.target.value; q("[data-v=swing]", el).textContent = swing.toFixed(2);
      if (playing && swing >= 0.25) emit("seq-swing");
    });
    buildGrid(Object.keys(SEQ_PRESETS)[0]);
    /* all four banks start as the same groove, so switching never drops into
       silence by surprise. Edit one and the scene has something to say. */
    banks = SEQ_BANKS.map(() => ({ grid: grid.map(r => r.slice()), stepsN, preset: lastPreset }));

    function refreshCells() {
      qa(".seq-cell", gridEl).forEach(c => {
        const v = grid[+c.dataset.r][+c.dataset.s];
        c.classList.toggle("on", v === 1);
        c.classList.toggle("acc", v === 2);
      });
    }
    MOD.grade = {
      get: () => {
        saveBank();
        return { preset: lastPreset, bpm, swing, grid: grid.map(r => r.slice()),
                 bank, banks: banks.map(b => b && { grid: b.grid.map(r => r.slice()),
                   stepsN: b.stepsN, preset: b.preset }),
                 chain: chain.map(i => SEQ_BANKS[i]).join("") };
      },
      set(st) {
        buildGrid(SEQ_PRESETS[st.preset] ? st.preset : "empty 16");
        q("[data-k=preset]", el).value = SEQ_PRESETS[st.preset] ? st.preset : "empty 16";
        if (st.grid) st.grid.forEach((row, r) => row.forEach((v, s) => {
          if (grid[r] && s < grid[r].length) grid[r][s] = v;
        }));
        if (st.bpm) bpm = st.bpm;
        if (st.swing != null) swing = st.swing;
        q("[data-k=bpm]", el).value = bpm; q("[data-v=bpm]", el).textContent = bpm;
        q("[data-k=swing]", el).value = swing; q("[data-v=swing]", el).textContent = swing.toFixed(2);
        lastPreset = "(prensagem)";   /* loaded grids never count for the grid provas */
        refreshCells();
        if (st.banks) {
          banks = st.banks.map(b => b && { grid: b.grid.map(r => r.slice()),
            stepsN: b.stepsN, preset: b.preset });
          if (banks[st.bank || 0]) loadBank(st.bank || 0, false);
        }
        if (st.chain != null) q("[data-k=chain]", el).value = st.chain;
      },
      setTempo(v) {
        bpm = Math.max(100, Math.min(170, v));
        q("[data-k=bpm]", el).value = bpm; q("[data-v=bpm]", el).textContent = bpm;
        if (playing) {
          const al = trAlign(60 / bpm / (stepsN / 4), false);
          nextT = al.t; cur = al.k % stepsN; drawQ.length = 0;
        }
      },
    };
  }

  /* ================= 02 O Sintetizador ================= */

  let _synthKb = null;   /* previous build's keyboard handlers, removed on rebuild */
  let _midiTarget = null;   /* the live synth's midi note sink, swapped on rebuild */
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const SCALES = {
    menor: [0, 2, 3, 5, 7, 8, 10],
    maior: [0, 2, 4, 5, 7, 9, 11],
    dorico: [0, 2, 3, 5, 7, 9, 10],
    frigio: [0, 1, 3, 5, 7, 8, 10],
  };
  const ROLL_ROWS = 12;
  let _rolStop = null;   /* the previous build's roll, stopped when the station rebuilds */
  function buildSynth(el) {
    const S = { wave1: "sawtooth", wave2: "sawtooth", interval: 7, detune: 8, noise: 0,
                cutoff: 900, res: 1.5, envAmt: 1200, fDecay: 0.35, attack: 0.01,
                decay: 0.2, sustain: 0.8, release: 0.35, lfoRate: 0.07, lfoDepth: 0,
                latch: false };
    const PRESETS = {
      "init": { p: Object.assign({}, S),
        note: "the blank patch: two raw saws, filter half open, nothing moving. Start here when you want to understand a knob." },
      "the drone (frames 1/4/7)": { p: { wave1: "sawtooth", wave2: "sawtooth", interval: 7, detune: 10,
        noise: 0, cutoff: 520, res: 0.8, envAmt: 0, fDecay: 0.3, attack: 1.2, decay: 0.3,
        sustain: 1, release: 1.6, lfoRate: 0.07, lfoDepth: 260, latch: true },
        note: "root + fifth, no third, slow attack, dark filter with a slow LFO breathing it. This exact patch sits under frames 1, 4 and 7." },
      "acid line": { p: { wave1: "sawtooth", wave2: "sawtooth", interval: 0, detune: 4, noise: 0,
        cutoff: 300, res: 13, envAmt: 2600, fDecay: 0.18, attack: 0.003, decay: 0.12,
        sustain: 0.15, release: 0.15, lfoRate: 0.07, lfoDepth: 0, latch: false },
        note: "the 303 recipe: huge resonance, a big fast filter envelope, instant attack. Sweep the cutoff while playing and it squeals." },
      "dub stab": { p: { wave1: "square", wave2: "square", interval: 0, detune: 7, noise: 0,
        cutoff: 1100, res: 4, envAmt: 900, fDecay: 0.2, attack: 0.002, decay: 0.25,
        sustain: 0, release: 0.5, lfoRate: 0.07, lfoDepth: 0, latch: false },
        note: "hollow squares, zero sustain: a short bark that wants delay. The stab layer in the frames is this idea, pressed." },
      "rumble (shaped noise)": { p: { wave1: "sawtooth", wave2: "sawtooth", interval: 7, detune: 0,
        noise: 1, cutoff: 150, res: 1, envAmt: 0, fDecay: 0.3, attack: 0.05, decay: 0.2,
        sustain: 1, release: 0.5, lfoRate: 0.07, lfoDepth: 0, latch: true },
        note: "pure noise through a nearly closed filter: the warehouse air under every kick here. Latched, it is a texture, not a note." },
      "sub bass": { p: { wave1: "sine", wave2: "sine", interval: 0, detune: 0, noise: 0,
        cutoff: 220, res: 0.7, envAmt: 0, fDecay: 0.3, attack: 0.005, decay: 0.2,
        sustain: 1, release: 0.2, lfoRate: 0.07, lfoDepth: 0, latch: false },
        note: "two sines, no filter movement: pure low end for basslines. Play it an octave down (Z) and keep it out of the kick's way with the duck." },
      "pluck": { p: { wave1: "triangle", wave2: "triangle", interval: 12, detune: 6, noise: 0,
        cutoff: 900, res: 2.5, envAmt: 1800, fDecay: 0.09, attack: 0.002, decay: 0.15,
        sustain: 0, release: 0.3, lfoRate: 0.07, lfoDepth: 0, latch: false },
        note: "triangles an octave apart with a snappy filter envelope: a bright key sound for melodies over the top. Glissando on the controlador suits it." },
      "pad lento": { p: { wave1: "sawtooth", wave2: "sawtooth", interval: 7, detune: 14,
        noise: 0, cutoff: 850, res: 1, envAmt: 0, fDecay: 0.3, attack: 1.0, decay: 0.3,
        sustain: 1, release: 2.0, lfoRate: 0.09, lfoDepth: 300, latch: false },
        note: "wide detuned saws that fade in and hang after you let go: held chords one note at a time. Slower and brighter than the drone." },
    };
    const KEYS = ["C2", "C#2", "D2", "D#2", "E2", "F2", "F#2", "G2", "G#2", "A2", "A#2", "B2", "C3"];
    const waveOpts = sel => ["sawtooth", "square", "triangle", "sine"].map(w =>
      `<option ${w === sel ? "selected" : ""}>${w}</option>`).join("");
    el.innerHTML = `
      <div class="esc-controls">
        <label title="a saved patch: pick one and every knob below jumps to it. The note under this row explains the sound">preset <select data-k="preset">
          ${Object.keys(PRESETS).map(n => `<option>${n}</option>`).join("")}</select></label>
        <label title="the raw timbre of oscillator 1: saw is buzzy and rich, square hollow, triangle soft, sine pure">osc 1 <select data-k="wave1">${waveOpts(S.wave1)}</select></label>
        <label title="the raw timbre of oscillator 2, stacked on top of osc 1">osc 2 <select data-k="wave2">${waveOpts(S.wave2)}</select></label>
        <label title="the interval of osc 2 in semitones: 0 = unison (thick), 7 = a fifth (the house drone), 12 = an octave (bright)">osc 2 semis <b data-v="interval">7</b>
          <input type="range" min="-12" max="12" step="1" value="7" data-k="interval"></label>
        <label title="pulls the two oscillators slightly out of tune: more = wider, fatter, more chorus-like">detune ct <b data-v="detune">8</b>
          <input type="range" min="0" max="30" step="1" value="8" data-k="detune"></label>
        <label title="mixes white noise into the note: air, breath, texture. At 1.0 the oscillators are gone and it is pure noise">noise mix <b data-v="noise">0.00</b>
          <input type="range" min="0" max="1" step="0.05" value="0" data-k="noise"></label>
      </div>
      <p class="side-note esc-note" data-v="pnote"></p>
      <div class="esc-controls">
        <label title="the filter: how much brightness survives. Low = dark and muffled, high = open and harsh. THE knob of subtractive synthesis">cutoff Hz <b data-v="cutoff">900</b>
          <input type="range" min="0" max="100" step="1" value="${fromLog(900, 60, 12000)}" data-k="cutoff"></label>
        <label title="boosts the edge right at the cutoff: past 10 the filter whistles along, which is the acid sound">resonance <b data-v="res">1.5</b>
          <input type="range" min="0.5" max="18" step="0.1" value="1.5" data-k="res"></label>
        <label title="how far the filter kicks open on each new note: 0 = static pad, big = a bright attack that closes down">filter env Hz <b data-v="envAmt">1200</b>
          <input type="range" min="0" max="4000" step="50" value="1200" data-k="envAmt"></label>
        <label title="how fast that filter kick closes again: short = plucky stab, long = slow sweep">filter decay s <b data-v="fDecay">0.35</b>
          <input type="range" min="0.05" max="1.2" step="0.01" value="0.35" data-k="fDecay"></label>
      </div>
      <div class="esc-controls">
        <label title="how long a note takes to reach full volume: 0 = instant click, 1s+ = it fades in like a pad">attack s <b data-v="attack">0.01</b>
          <input type="range" min="0.001" max="1.5" step="0.005" value="0.01" data-k="attack"></label>
        <label title="how long the note hangs after you let go of the key">release s <b data-v="release">0.35</b>
          <input type="range" min="0.05" max="2.5" step="0.05" value="0.35" data-k="release"></label>
        <label title="how fast the automatic wobble moves the filter: slow = breathing, fast = trembling">lfo Hz <b data-v="lfoRate">0.07</b>
          <input type="range" min="0.03" max="8" step="0.01" value="0.07" data-k="lfoRate"></label>
        <label title="how deep that wobble digs into the cutoff: 0 = still, high = the drone breathes on its own">lfo depth Hz <b data-v="lfoDepth">0</b>
          <input type="range" min="0" max="1500" step="25" value="0" data-k="lfoDepth"></label>
        <label class="check" title="holds the note forever instead of stopping on key-up: drone mode">
          <input type="checkbox" data-k="latch"> latch (drone mode)</label>
        <button class="ghost" data-a="silence" title="kill the voice and the latch">silence</button>
      </div>
      <div class="keys"></div>
      <p class="side-note esc-note">computer keyboard: <b>A W S E D F T G Y H U J K</b> play C2
        to C3 (the little letters on the keys), <b>O L P ;</b> continue up to E3, <b>Z / X</b>
        shift the octave (<b data-v="oct">+0</b>). Works from any surface of the mesa. A real
        controller works too: hit <b>midi</b> in the AO VIVO strip and play with velocity.</p>
      <div class="rolo">
        <div class="rolo-head"><span class="st-no">R</span><span class="st-name">O Rolo</span>
          <span class="st-tag">piano roll</span></div>
        <div class="esc-controls">
          <button class="ghost" data-r="play" title="the roll plays this synth for you, locked to the mesa grid">tocar o rolo</button>
          <label title="the key the roll is locked to">tom <select data-r="root">
            ${NOTE_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join("")}</select></label>
          <label title="every row is a degree of this scale, so the roll cannot land on a wrong note">escala <select data-r="scale">
            ${Object.keys(SCALES).map(n => `<option>${n}</option>`).join("")}</select></label>
          <label title="which octave the lowest row sits in">oitava <b data-v="rolOct">3</b>
            <input type="range" min="1" max="5" step="1" value="3" data-r="oct"></label>
          <label title="how many steps before the roll comes back around">passos <select data-r="steps">
            <option>8</option><option selected>16</option><option>32</option></select></label>
          <label title="how much of each step the note is held for: short = stabs, long = legato">gate <b data-v="rolGate">0.55</b>
            <input type="range" min="0.1" max="1" step="0.05" value="0.55" data-r="gate"></label>
          <button class="ghost" data-r="clear" title="empty the roll">limpar</button>
        </div>
        <div class="roll"></div>
        <p class="side-note esc-note">one note per step: this synth is monophonic, so a cell
          replaces whatever else was in its column. The roll starts on the mesa grid and follows
          the mesa tempo, so it phase locks with A Grade instead of drifting against it.</p>
      </div>
      <canvas class="scope"></canvas>`;
    let chain = null, voice = null, active = false, scopeOn = false, curPreset = "init";

    function ensureChain() {
      if (chain) return chain;
      const ctx = AC();
      const filter = new BiquadFilterNode(ctx, { type: "lowpass", frequency: S.cutoff, Q: S.res });
      const an = ctx.createAnalyser(); an.fftSize = 1024;
      const out = ctx.createGain(); out.gain.value = 0.4;
      filter.connect(an).connect(out).connect(CHAN("sintetizador"));
      const lfo = ctx.createOscillator(); lfo.frequency.value = S.lfoRate;
      const lg = ctx.createGain(); lg.gain.value = S.lfoDepth;
      lfo.connect(lg).connect(filter.frequency);
      lfo.start();
      chain = { filter, lfo, lg, an, out };
      scopeOn = true;
      requestAnimationFrame(scope);
      return chain;
    }
    function scope() {
      if (!scopeOn) return;
      const c = q("canvas.scope", el);
      if (c && c.clientWidth) {
        const g = sizeCanvas(c, 56);
        const { width: w, height: h } = c;
        g.clearRect(0, 0, w, h);
        const data = new Uint8Array(chain.an.fftSize);
        chain.an.getByteTimeDomainData(data);
        g.strokeStyle = "#a34a24"; g.lineWidth = 1.5 * (devicePixelRatio || 1);
        g.beginPath();
        for (let x = 0; x < w; x++) {
          const v = data[Math.floor(x / w * data.length)] / 255;
          x ? g.lineTo(x, v * h) : g.moveTo(x, v * h);
        }
        g.stroke();
      }
      requestAnimationFrame(scope);
    }
    function killVoice(fast) {
      if (!voice) return;
      const t = AC().currentTime, tau = fast ? 0.015 : Math.max(0.02, S.release / 4);
      voice.vg.gain.cancelScheduledValues(t);
      voice.vg.gain.setTargetAtTime(0.0001, t, tau);
      voice.parts.forEach(p => { try { p.stop(t + tau * 6 + 0.1); } catch (e) {} });
      voice = null;
    }
    function stopSynth() {
      rolStop();          /* parar tudo has to stop the roll, not just the voice */
      killVoice(true);
      active = false;
      qa(".key.held", el).forEach(k => k.classList.remove("held"));
      release(stopSynth);
    }
    function noteOn(hz, vel = 1) {
      const ctx = AC(); ctx.resume();
      if (!active) { claim("sintetizador", stopSynth); active = true; }
      const c = ensureChain();
      killVoice(true);
      const t = ctx.currentTime;
      const vg = ctx.createGain(); vg.gain.value = 0;
      const parts = [];
      const og = ctx.createGain(); og.gain.value = 1 - S.noise;
      og.connect(vg);
      for (const [w, det, mul] of [[S.wave1, -S.detune, 1],
                                   [S.wave2, S.detune, Math.pow(2, S.interval / 12)]]) {
        const o = ctx.createOscillator();
        o.type = w; o.frequency.value = hz * mul; o.detune.value = det;
        o.connect(og); o.start(t); parts.push(o);
      }
      if (S.noise > 0.01) {
        const n = ctx.createBufferSource(); n.buffer = noiseBuf(); n.loop = true;
        const ng = ctx.createGain(); ng.gain.value = S.noise * 1.3;
        n.connect(ng).connect(vg); n.start(t); parts.push(n);
      }
      vg.connect(c.filter);
      const peak = 0.65 * (0.35 + 0.65 * Math.max(0, Math.min(1, vel)));
      vg.gain.setValueAtTime(0.0001, t);
      vg.gain.linearRampToValueAtTime(peak, t + Math.max(0.002, S.attack));
      vg.gain.setTargetAtTime(peak * S.sustain, t + Math.max(0.002, S.attack), Math.max(0.02, S.decay / 3));
      const f = c.filter.frequency;
      f.cancelScheduledValues(t);
      if (S.envAmt > 0) {
        f.setValueAtTime(Math.min(S.cutoff + S.envAmt, 15000), t);
        f.exponentialRampToValueAtTime(Math.max(S.cutoff, 40), t + S.fDecay);
      } else f.setValueAtTime(Math.max(S.cutoff, 40), t);
      voice = { vg, parts };
      emit("synth-note");
      if (curPreset === "acid line") emit("synth-acid");
      if (curPreset === "the drone (frames 1/4/7)" && S.latch) emit("synth-drone");
      /* provas: the same targets reached WITHOUT loading their preset */
      if (curPreset !== "acid line" && S.res >= 10 && S.envAmt >= 2000 &&
          S.fDecay <= 0.25 && S.attack <= 0.02) emit("prova-acid");
      if (curPreset !== "the drone (frames 1/4/7)" && S.latch && S.interval === 7 &&
          S.envAmt === 0 && S.attack >= 0.8 && S.cutoff <= 700 && S.lfoDepth > 0)
        emit("prova-drone");
    }
    const KEYHINT = { "C2": "A", "C#2": "W", "D2": "S", "D#2": "E", "E2": "D", "F2": "F",
                      "F#2": "T", "G2": "G", "G#2": "Y", "A2": "H", "A#2": "U", "B2": "J",
                      "C3": "K" };
    const keysEl = q(".keys", el);
    keysEl.innerHTML = KEYS.map(k =>
      `<button type="button" class="key${k.includes("#") ? " black" : ""}" data-note="${k}">
        <span class="kb-hint">${KEYHINT[k] || ""}</span>${k}</button>`).join("");
    qa(".key", keysEl).forEach(k => {
      const hz = hzOf(k.dataset.note.slice(0, -1), +k.dataset.note.slice(-1));
      k.addEventListener("pointerdown", ev => {
        ev.preventDefault();
        qa(".key.held", el).forEach(x => x.classList.remove("held"));
        k.classList.add("held");
        noteOn(hz);
      });
      const up = () => {
        if (!S.latch) { killVoice(false); k.classList.remove("held"); }
      };
      k.addEventListener("pointerup", up);
      k.addEventListener("pointerleave", up);
    });
    /* the computer keyboard is a real keybed: DAW-style map, and the top row
       continues past K into the next octave like GarageBand */
    const KEYMAP = { KeyA: "C2", KeyW: "C#2", KeyS: "D2", KeyE: "D#2", KeyD: "E2",
                     KeyF: "F2", KeyT: "F#2", KeyG: "G2", KeyY: "G#2", KeyH: "A2",
                     KeyU: "A#2", KeyJ: "B2", KeyK: "C3", KeyO: "C#3", KeyL: "D3",
                     KeyP: "D#3", Semicolon: "E3" };
    let octShift = 0;
    const heldCodes = new Set();
    const showOct = () => {
      const lab = q("[data-v=oct]", el);
      if (lab) lab.textContent = `${octShift >= 0 ? "+" : ""}${octShift}`;
    };
    const clearHeld = () => qa(".key.held", el).forEach(x => x.classList.remove("held"));
    function kbDown(e) {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.target.matches("input, select, textarea") || e.target.isContentEditable) return;
      if (e.code === "KeyZ") { octShift = Math.max(-2, octShift - 1); showOct(); return; }
      if (e.code === "KeyX") { octShift = Math.min(2, octShift + 1); showOct(); return; }
      const note = KEYMAP[e.code];
      if (!note) return;
      e.preventDefault();
      heldCodes.add(e.code);
      clearHeld();
      const kEl = q(`.key[data-note="${note}"]`, el);
      if (kEl) kEl.classList.add("held");
      noteOn(hzOf(note.slice(0, -1), +note.slice(-1)) * Math.pow(2, octShift));
    }
    function kbUp(e) {
      if (!KEYMAP[e.code]) return;
      heldCodes.delete(e.code);
      if (!S.latch && heldCodes.size === 0 && midiHeld.size === 0) { killVoice(false); clearHeld(); }
    }
    function kbBlur() {
      heldCodes.clear();
      if (!S.latch && midiHeld.size === 0) { killVoice(false); clearHeld(); }
    }
    /* a plugged midi keyboard plays this same voice, with velocity */
    const midiHeld = new Set();
    _midiTarget = {
      on(n, vel) {
        midiHeld.add(n);
        const hz = 440 * Math.pow(2, (n - 69) / 12);
        clearHeld();
        const names = Object.keys(PC).filter(k => PC[k] === ((n % 12 + 12) % 12));
        const oct = Math.floor(n / 12) - 1;
        for (const nm of names) {
          const kEl = q(`.key[data-note="${nm}${oct}"]`, el);
          if (kEl) { kEl.classList.add("held"); break; }
        }
        noteOn(hz, vel);
      },
      off(n) {
        midiHeld.delete(n);
        if (!S.latch && midiHeld.size === 0 && heldCodes.size === 0) { killVoice(false); clearHeld(); }
      },
      cc(num, v) {
        if (num !== 1) return;   /* CC1, the mod wheel, rides the cutoff */
        S.cutoff = Math.round(toLog(v * 100, 60, 12000));
        const inp = q("input[data-k=cutoff]", el);
        if (inp) inp.value = fromLog(S.cutoff, 60, 12000);
        const lab = q("[data-v=cutoff]", el);
        if (lab) lab.textContent = Math.round(S.cutoff);
        applyLive();
      },
    };
    if (_synthKb) {
      document.removeEventListener("keydown", _synthKb.d);
      document.removeEventListener("keyup", _synthKb.u);
      window.removeEventListener("blur", _synthKb.b);
    }
    _synthKb = { d: kbDown, u: kbUp, b: kbBlur };
    document.addEventListener("keydown", kbDown);
    document.addEventListener("keyup", kbUp);
    window.addEventListener("blur", kbBlur);

    q("[data-a=silence]", el).addEventListener("click", stopSynth);
    q("[data-k=preset]", el).addEventListener("change", e => {
      curPreset = e.target.value;
      Object.assign(S, PRESETS[curPreset].p);
      q("[data-v=pnote]", el).textContent = PRESETS[curPreset].note;
      syncUI();
      applyLive();
    });
    function applyLive() {
      if (!chain) return;
      const t = AC().currentTime;
      chain.filter.frequency.cancelScheduledValues(t);
      chain.filter.frequency.setTargetAtTime(Math.max(S.cutoff, 40), t, 0.03);
      chain.filter.Q.value = S.res;
      chain.lfo.frequency.value = S.lfoRate;
      chain.lg.gain.value = S.lfoDepth;
    }
    function syncUI() {
      for (const inp of qa("input[data-k],select[data-k]", el)) {
        const k = inp.dataset.k;
        if (k === "preset") continue;
        if (k === "latch") { inp.checked = S.latch; continue; }
        inp.value = k === "cutoff" ? fromLog(S.cutoff, 60, 12000) : S[k];
        const lab = q(`[data-v=${k}]`, el);
        if (lab) lab.textContent = k === "cutoff" ? Math.round(S.cutoff)
          : Number.isInteger(S[k]) ? S[k] : (+S[k]).toFixed(2);
      }
    }
    qa("input[data-k],select[data-k]", el).forEach(inp => {
      if (inp.dataset.k === "preset") return;
      inp.addEventListener("input", () => {
        const k = inp.dataset.k;
        if (k === "latch") { S.latch = inp.checked; if (!S.latch) killVoice(false); return; }
        if (k === "wave1" || k === "wave2") S[k] = inp.value;
        else if (k === "cutoff") S.cutoff = Math.round(toLog(+inp.value, 60, 12000));
        else S[k] = +inp.value;
        const lab = q(`[data-v=${k}]`, el);
        if (lab) lab.textContent = k === "cutoff" ? Math.round(S.cutoff)
          : Number.isInteger(S[k]) ? S[k] : (+S[k]).toFixed(2);
        applyLive();
      });
    });
    syncUI();

    /* ---- O Rolo: the piano roll that plays this synth for you ----
       The synth voice is triggered live rather than scheduled, so the roll
       runs a 25ms lookahead and lands each note with a timer keyed to the
       audio clock. Monophonic, so a step holds one row or nothing. */
    const R = { root: 0, scale: "menor", oct: 3, steps: 16, gate: 0.55 };
    let rolNotes = new Array(32).fill(null);
    let rolOn = false, rolTimer = null, rolCur = 0, rolNextT = 0, rolPh = -1;
    const rolQ = [], rolPend = [];
    const rollEl = q(".roll", el);

    const rolMidi = row => {
      const sc = SCALES[R.scale];
      return 12 * (R.oct + 1) + R.root + sc[row % sc.length] + 12 * Math.floor(row / sc.length);
    };
    const rolLabel = row => {
      const n = rolMidi(row);
      return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
    };
    function renderRoll() {
      const perBeat = R.steps / 4;
      rollEl.innerHTML = Array.from({ length: ROLL_ROWS }, (_, i) => {
        const row = ROLL_ROWS - 1 - i;            /* the high notes draw on top */
        const n = rolMidi(row);
        const black = [1, 3, 6, 8, 10].includes(((n % 12) + 12) % 12);
        return `<div class="roll-row${black ? " sharp" : ""}" style="--n:${R.steps}">
          <span class="roll-lab">${rolLabel(row)}</span>
          <div class="roll-steps">${Array.from({ length: R.steps }, (_, s) =>
            `<button type="button" class="roll-cell${s % perBeat === 0 ? " b0" : ""}${rolNotes[s] === row ? " on" : ""}"
              data-row="${row}" data-s="${s}"></button>`).join("")}</div></div>`;
      }).join("");
      qa(".roll-cell", rollEl).forEach(c => c.addEventListener("click", () => {
        const s = +c.dataset.s, row = +c.dataset.row;
        rolNotes[s] = rolNotes[s] === row ? null : row;
        qa(`.roll-cell[data-s="${s}"]`, rollEl).forEach(x =>
          x.classList.toggle("on", rolNotes[s] === +x.dataset.row));
      }));
      if (rolPh >= 0) qa(`.roll-cell[data-s="${rolPh}"]`, rollEl).forEach(c => c.classList.add("ph"));
    }
    function rolSchedule() {
      const ctx = AC();
      const dur = 60 / TR.bpm / (R.steps / 4);
      while (rolNextT < ctx.currentTime + 0.15) {
        const row = rolNotes[rolCur];
        if (row != null) {
          const n = rolMidi(row), t = rolNextT;
          rolPend.push(
            setTimeout(() => { if (rolOn && _midiTarget) _midiTarget.on(n, 0.9); },
              Math.max(0, (t - ctx.currentTime) * 1000)),
            setTimeout(() => { if (rolOn && _midiTarget) _midiTarget.off(n); },
              Math.max(0, (t + dur * R.gate - ctx.currentTime) * 1000)));
        }
        rolQ.push({ step: rolCur, t: rolNextT });
        rolNextT += dur;
        rolCur = (rolCur + 1) % R.steps;
      }
      if (rolPend.length > 240) rolPend.splice(0, 160);   /* these have all fired */
    }
    function rolHead() {
      if (!rolOn) return;
      const now = AC().currentTime;
      while (rolQ.length && rolQ[0].t <= now) {
        const { step } = rolQ.shift();
        if (rolPh >= 0) qa(`.roll-cell[data-s="${rolPh}"]`, rollEl).forEach(c => c.classList.remove("ph"));
        qa(`.roll-cell[data-s="${step}"]`, rollEl).forEach(c => c.classList.add("ph"));
        rolPh = step;
      }
      requestAnimationFrame(rolHead);
    }
    function rolStop() {
      if (!rolOn) return;
      rolOn = false;
      clearInterval(rolTimer);
      rolPend.forEach(clearTimeout); rolPend.length = 0;
      rolQ.length = 0;
      killVoice(false);
      if (rolPh >= 0) qa(`.roll-cell[data-s="${rolPh}"]`, rollEl).forEach(c => c.classList.remove("ph"));
      rolPh = -1;
      q("[data-r=play]", el).textContent = "tocar o rolo";
    }
    function rolStart() {
      const ctx = AC(); ctx.resume();
      ensureChain();
      rolOn = true;
      const al = trAlign(60 / TR.bpm / (R.steps / 4));
      rolNextT = al.t; rolCur = al.k % R.steps;
      rolTimer = setInterval(rolSchedule, 25);
      q("[data-r=play]", el).textContent = "parar o rolo";
      requestAnimationFrame(rolHead);
    }
    function syncRolUI() {
      q("[data-r=root]", el).value = R.root;
      q("[data-r=scale]", el).value = R.scale;
      q("[data-r=oct]", el).value = R.oct;
      q("[data-v=rolOct]", el).textContent = R.oct;
      q("[data-r=steps]", el).value = R.steps;
      q("[data-r=gate]", el).value = R.gate;
      q("[data-v=rolGate]", el).textContent = R.gate.toFixed(2);
    }
    if (_rolStop) _rolStop();
    _rolStop = rolStop;
    q("[data-r=play]", el).addEventListener("click", () => rolOn ? rolStop() : rolStart());
    q("[data-r=clear]", el).addEventListener("click", () => { rolNotes.fill(null); renderRoll(); });
    q("[data-r=root]", el).addEventListener("change", e => { R.root = +e.target.value; renderRoll(); });
    q("[data-r=scale]", el).addEventListener("change", e => { R.scale = e.target.value; renderRoll(); });
    q("[data-r=oct]", el).addEventListener("input", e => {
      R.oct = +e.target.value; q("[data-v=rolOct]", el).textContent = R.oct; renderRoll();
    });
    q("[data-r=steps]", el).addEventListener("change", e => {
      R.steps = +e.target.value; rolCur = 0; renderRoll();
    });
    q("[data-r=gate]", el).addEventListener("input", e => {
      R.gate = +e.target.value; q("[data-v=rolGate]", el).textContent = R.gate.toFixed(2);
    });
    renderRoll();

    MOD.sintetizador = {
      get: () => ({ patch: Object.assign({}, S), preset: curPreset,
                    rolo: Object.assign({}, R, { notes: rolNotes.slice(0, R.steps) }) }),
      set(st) {
        if (st.patch) Object.assign(S, st.patch);
        curPreset = PRESETS[st.preset] ? st.preset : "init";
        q("[data-k=preset]", el).value = curPreset;
        q("[data-v=pnote]", el).textContent = PRESETS[curPreset].note;
        syncUI(); applyLive();
        if (st.rolo) {
          if (st.rolo.root != null) R.root = st.rolo.root;
          if (SCALES[st.rolo.scale]) R.scale = st.rolo.scale;
          if (st.rolo.oct != null) R.oct = st.rolo.oct;
          if (st.rolo.steps) R.steps = st.rolo.steps;
          if (st.rolo.gate != null) R.gate = st.rolo.gate;
          rolNotes = new Array(32).fill(null);
          (st.rolo.notes || []).forEach((v, i) => { if (i < 32) rolNotes[i] = v; });
          syncRolUI(); renderRoll();
        }
      },
      setTempo() {
        if (!rolOn) return;
        const al = trAlign(60 / TR.bpm / (R.steps / 4), false);
        rolNextT = al.t; rolCur = al.k % R.steps; rolQ.length = 0;
      },
    };
    q("[data-v=pnote]", el).textContent = PRESETS.init.note;
  }

  /* ================= 03 A Roda: the wheel of keys ================= */

  const CAM_B = { 1: "B", 2: "F#", 3: "Db", 4: "Ab", 5: "Eb", 6: "Bb",
                  7: "F", 8: "C", 9: "G", 10: "D", 11: "A", 12: "E" };
  const CAM_A = { 1: "Ab", 2: "Eb", 3: "Bb", 4: "F", 5: "C", 6: "G",
                  7: "D", 8: "A", 9: "E", 10: "B", 11: "F#", 12: "Db" };

  async function buildWheel(el) {
    el.innerHTML = `
      <canvas class="wheel"></canvas>
      <div class="wheel-verdict">tap two slots on the wheel, or two tracks below, to hear and judge the move</div>
      <div class="esc-controls">
        <button class="ghost" data-a="quiet">stop sound</button>
        <button class="ghost" data-a="prova">prova da roda</button>
      </div>
      <div class="chips"><span class="side-note">loading crate ...</span></div>`;
    const canvas = q("canvas.wheel", el), verdictEl = q(".wheel-verdict", el);
    let tracks = [];
    try { tracks = (await crate()).filter(a => /^\d+[AB]$/.test(a.camelot || "")); } catch (e) {}
    const bySlot = {};
    tracks.forEach(a => (bySlot[a.camelot] = bySlot[a.camelot] || []).push(a));
    let sel = [], drones = [];

    function stopW() { drones.forEach(d => d.stop()); drones = []; }
    function draw() {
      const g = sizeCanvas(canvas, Math.min(canvas.clientWidth || 340, 440));
      const { width: W, height: H } = canvas;
      const cx = W / 2, cy = H / 2, dpr = devicePixelRatio || 1;
      const R2 = Math.min(cx, cy) * 0.98, R1 = R2 * 0.68, R0 = R2 * 0.38;
      g.clearRect(0, 0, W, H);
      const styles = getComputedStyle(document.documentElement);
      const ink = styles.getPropertyValue("--ink").trim() || "#3a332c";
      for (let n = 1; n <= 12; n++) {
        const c = ((n % 12) / 12) * 2 * Math.PI - Math.PI / 2;
        const a0 = c - Math.PI / 12, a1 = c + Math.PI / 12;
        for (const [ring, rIn, rOut] of [["B", R1, R2], ["A", R0, R1]]) {
          const isSel = sel.some(s => s.n === n && s.ring === ring);
          g.beginPath();
          g.arc(cx, cy, rOut, a0, a1);
          g.arc(cx, cy, rIn, a1, a0, true);
          g.closePath();
          g.fillStyle = isSel ? "rgba(163,74,36,0.30)" : "rgba(58,51,44,0.04)";
          g.fill();
          g.strokeStyle = "rgba(58,51,44,0.25)";
          g.lineWidth = 1 * dpr;
          g.stroke();
          const rm = (rIn + rOut) / 2;
          const lx = cx + Math.cos(c) * rm, ly = cy + Math.sin(c) * rm;
          g.fillStyle = ink;
          g.textAlign = "center";
          g.font = `700 ${11 * dpr}px ${"Archivo"}, sans-serif`;
          g.fillText(`${n}${ring}`, lx, ly - 2 * dpr);
          g.font = `${8.5 * dpr}px ${"Archivo"}, sans-serif`;
          g.globalAlpha = 0.6;
          g.fillText(ring === "B" ? CAM_B[n] : CAM_A[n] + "m", lx, ly + 9 * dpr);
          g.globalAlpha = 1;
          const here = bySlot[`${n}${ring}`] || [];
          here.slice(0, 4).forEach((a, i) => {
            const da = c + (i - (Math.min(here.length, 4) - 1) / 2) * 0.09;
            const dr = rOut - 9 * dpr;
            g.beginPath();
            g.arc(cx + Math.cos(da) * dr, cy + Math.sin(da) * dr, 3.4 * dpr, 0, 7);
            g.fillStyle = "#a34a24";
            g.globalAlpha = 0.35 + 0.65 * Math.min(1, (a.confidence || 0) * 2.5);
            g.fill();
            g.globalAlpha = 1;
          });
        }
      }
    }
    function slotDesc(s) {
      return `${s.n}${s.ring} (${s.ring === "B" ? CAM_B[s.n] + " major" : CAM_A[s.n] + " minor"})` +
        (s.label ? ` : ${s.label}` : "");
    }
    function judge(a, b) {
      if (a.n === b.n && a.ring === b.ring) return "same slot, same key. Mix anything into anything.";
      const lines = [];
      const dn = Math.min((a.n - b.n + 12) % 12, (b.n - a.n + 12) % 12);
      if (a.ring === b.ring && dn === 1)
        lines.push("one step around the wheel: a perfect fifth apart, the classic safe move.");
      else if (a.ring !== b.ring && a.n === b.n)
        lines.push("relative major and minor: the same notes with a different center of gravity. Seamless.");
      const pa = PC[(a.ring === "B" ? CAM_B : CAM_A)[a.n]];
      const pb = PC[(b.ring === "B" ? CAM_B : CAM_A)[b.n]];
      const d = Math.min((pa - pb + 12) % 12, (pb - pa + 12) % 12);
      lines.push("roots " + {
        0: "share the same pitch: only the mode differs",
        1: "a semitone apart: the textbook clash",
        2: "a whole step apart: workable if the overlap stays short",
        3: "a minor third apart: a real color change, judge by ear",
        4: "a major third apart: a real color change, judge by ear",
        5: "a fourth or fifth apart: smooth",
        6: "a tritone apart: maximum tension, a weapon",
      }[d] + ".");
      return lines.join(" ");
    }
    function update() {
      draw();
      qa(".chip", el).forEach(ch =>
        ch.classList.toggle("sel", sel.some(s => `${s.n}${s.ring}` === ch.dataset.cam)));
      if (!sel.length)
        verdictEl.textContent = "tap two slots on the wheel, or two tracks below, to hear and judge the move";
      else if (sel.length === 1)
        verdictEl.innerHTML = `from <b>${slotDesc(sel[0])}</b>. Now tap the destination.`;
      else
        verdictEl.innerHTML = `<b>${slotDesc(sel[0])}</b> into <b>${slotDesc(sel[1])}</b>:<br>${judge(sel[0], sel[1])}`;
      if (sel.length === 2) {
        emit("wheel-pair");
        const [a, b] = sel;
        const dn = Math.min((a.n - b.n + 12) % 12, (b.n - a.n + 12) % 12);
        if ((a.n === b.n && a.ring === b.ring) || (a.ring === b.ring && dn === 1) ||
            (a.n === b.n && a.ring !== b.ring)) emit("wheel-safe");
      }
      stopW();
      if (sel.length) {
        claim("roda", stopW);
        const ctx = AC(); ctx.resume();
        sel.forEach(s => {
          const pc = (s.ring === "B" ? CAM_B : CAM_A)[s.n];
          drones.push(droneVoice(hzOf(pc, 3), CHAN("roda"), { lp: 1500, gain: 0.1 }));
        });
      } else release(stopW);
    }
    /* prova da roda: from a random origin, tap safe destinations, 4 in a row */
    let quiz = null;
    const isSafe = (a, b) => {
      const dn = Math.min((a.n - b.n + 12) % 12, (b.n - a.n + 12) % 12);
      return (a.ring === b.ring && dn === 1) || (a.n === b.n && a.ring !== b.ring);
    };
    const randSlot = () => ({ n: 1 + Math.floor(Math.random() * 12),
                              ring: Math.random() < 0.5 ? "A" : "B" });
    function quizPrompt(prefix) {
      sel = [quiz.origin];
      draw();
      qa(".chip", el).forEach(ch => ch.classList.remove("sel"));
      verdictEl.innerHTML = `${prefix || ""}<b>prova ${quiz.streak}/4</b> &middot; you are playing in
        <b>${slotDesc(quiz.origin)}</b>. Tap a SAFE destination: one step around, or the relative.`;
    }
    function answerQuiz(slot) {
      if (slot.n === quiz.origin.n && slot.ring === quiz.origin.ring) return;
      const from = quiz.origin;
      const ok = isSafe(from, slot);
      stopW();
      claim("roda", stopW);
      const ctx = AC(); ctx.resume();
      [from, slot].forEach(s => {
        const pc = (s.ring === "B" ? CAM_B : CAM_A)[s.n];
        drones.push(droneVoice(hzOf(pc, 3), ctx.destination, { lp: 1500, gain: 0.1 }));
      });
      if (ok) quiz.streak++; else quiz.streak = 0;
      if (quiz.streak >= 4) {
        emit("prova-roda");
        sel = [from, slot]; draw();
        verdictEl.innerHTML = `<b>aprovado.</b> Four safe moves in a row. ${judge(from, slot)}`;
        quiz = null;
        q("[data-a=prova]", el).textContent = "prova da roda";
        return;
      }
      quiz.origin = randSlot();
      quizPrompt(`<b>${ok ? "certo" : "errado, streak reset"}</b> &middot;
        ${slotDesc(from)} into ${slotDesc(slot)}: ${judge(from, slot)}<br>`);
    }
    function select(slot) {
      if (quiz) { answerQuiz(slot); return; }
      const i = sel.findIndex(s => s.n === slot.n && s.ring === slot.ring);
      if (i >= 0) sel.splice(i, 1);
      else if (sel.length >= 2) sel = [slot];
      else sel.push(slot);
      update();
    }
    q("[data-a=prova]", el).addEventListener("click", ev => {
      if (quiz) {
        quiz = null;
        ev.target.textContent = "prova da roda";
        sel = []; update();
        return;
      }
      quiz = { origin: randSlot(), streak: 0 };
      ev.target.textContent = "sair da prova";
      quizPrompt();
    });
    canvas.addEventListener("click", ev => {
      const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
      const x = (ev.clientX - r.left) * dpr - canvas.width / 2;
      const y = (ev.clientY - r.top) * dpr - canvas.height / 2;
      const rad = Math.hypot(x, y);
      const R2 = Math.min(canvas.width, canvas.height) / 2 * 0.98, R1 = R2 * 0.68, R0 = R2 * 0.38;
      const ring = rad > R1 && rad <= R2 ? "B" : rad > R0 && rad <= R1 ? "A" : null;
      if (!ring) return;
      let ang = Math.atan2(y, x) + Math.PI / 2;
      if (ang < 0) ang += 2 * Math.PI;
      const idx = Math.round(ang / (Math.PI / 6)) % 12;
      select({ n: idx === 0 ? 12 : idx, ring });
    });
    q("[data-a=quiet]", el).addEventListener("click", () => { stopW(); release(stopW); });
    const chipsEl = q(".chips", el);
    chipsEl.innerHTML = tracks.length ? tracks.map((a, i) => {
      const low = (a.confidence || 0) < 0.15;
      return `<button type="button" class="chip${low ? " lowkey" : ""}" data-cam="${a.camelot}" data-i="${i}"
        ${low ? 'title="low key confidence: this track barely has a key"' : ""}>
        ${nameOf(a.file)}<span class="cam">${a.camelot}</span></button>`;
    }).join("") : '<span class="side-note">no analyzed tracks with a detected key yet</span>';
    qa(".chip", chipsEl).forEach(ch => ch.addEventListener("click", () => {
      const a = tracks[+ch.dataset.i];
      const m = a.camelot.match(/^(\d+)([AB])$/);
      select({ n: +m[1], ring: m[2], label: nameOf(a.file) });
    }));
    draw();
  }

  /* ================= 04 O Warp ================= */

  async function buildWarp(el) {
    let tracks = [];
    try { tracks = await crate(); } catch (e) {}
    if (!tracks.length) {
      el.innerHTML = '<p class="side-note">no analyzed tracks yet: pull something in Lado C first.</p>';
      return;
    }
    el.innerHTML = `
      <div class="esc-controls">
        <label title="which crate track to warp">track <select data-k="track">
          ${tracks.map((a, i) => `<option value="${i}">${nameOf(a.file)} (${a.bpm} BPM)</option>`).join("")}
        </select></label>
        <label title="the tempo you want to reach: the three plans below show what each route costs">target bpm <b data-v="tgt">132</b>
          <input type="range" min="118" max="150" step="1" value="132" data-k="tgt"></label>
        <button class="ghost" data-a="play">play</button>
        <button class="ghost" data-a="prova">prova do warp</button>
        <span class="side-note" data-v="load"></span>
      </div>
      <div class="warp-plans"></div>
      <div class="warp-quiz"></div>`;
    const MULTS = [["straight", 1, "bar for bar"],
                   ["half time", 0.5, "one source bar rides across two techno bars"],
                   ["double time", 2, "two source bars packed into each techno bar"]];
    let ti = 0, tgt = 132, selMult = null, playing = false, srcNode = null, gainNode = null;
    const plansEl = q(".warp-plans", el);

    const rateOf = m => tgt * m / tracks[ti].bpm;
    function bestMult() {
      return MULTS.reduce((best, [, m]) =>
        Math.abs(Math.log2(rateOf(m))) < Math.abs(Math.log2(rateOf(best))) ? m : best, 1);
    }
    function plans() {
      plansEl.innerHTML = MULTS.map(([lab, m, desc]) => {
        const rate = rateOf(m);
        const cost = Math.abs(Math.log2(rate));
        const cls = cost < 0.085 ? "ok" : cost < 0.18 ? "care" : "flag";
        const word = cls === "ok" ? "invisible" : cls === "care" ? "borderline" : "audible";
        const pct = (rate - 1) * 100, st = 12 * Math.log2(rate);
        return `<button type="button" class="warp-plan${m === selMult ? " sel" : ""}" data-m="${m}">
          <b>${lab} &times;${m}</b>
          <span>${desc} &middot; heard as ${(tracks[ti].bpm * m).toFixed(1)} BPM</span>
          <span class="warp-cost ${cls}">${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% (${st >= 0 ? "+" : ""}${st.toFixed(1)} st) ${word}</span>
        </button>`;
      }).join("");
      qa(".warp-plan", plansEl).forEach(b => b.addEventListener("click", () => {
        selMult = +b.dataset.m;
        plans();
        if (srcNode) srcNode.playbackRate.value = rateOf(selMult);
        if (playing && selMult !== 1) emit("warp-half");
      }));
    }
    function stop() {
      if (srcNode) { try { srcNode.stop(); } catch (e) {} srcNode = null; }
      playing = false;
      q("[data-a=play]", el).textContent = "play";
      release(stop);
    }
    q("[data-a=play]", el).addEventListener("click", async ev => {
      if (playing) { stop(); return; }
      claim("warp", stop);
      const ctx = AC(); ctx.resume();
      q("[data-v=load]", el).textContent = "loading preview ...";
      let buf;
      try { buf = await previewBuf(tracks[ti].file.split("/").pop()); }
      catch (e) { q("[data-v=load]", el).textContent = "preview failed"; release(stop); return; }
      q("[data-v=load]", el).textContent = "";
      srcNode = ctx.createBufferSource();
      srcNode.buffer = buf; srcNode.loop = true;
      srcNode.playbackRate.value = rateOf(selMult);
      gainNode = gainNode || (() => { const g = ctx.createGain(); g.gain.value = 0.85; g.connect(CHAN("warp")); return g; })();
      srcNode.connect(gainNode);
      srcNode.start();
      playing = true;
      ev.target.textContent = "stop";
      if (selMult !== 1) emit("warp-half");
    });
    q("[data-k=track]", el).addEventListener("change", e => {
      ti = +e.target.value; selMult = bestMult(); plans();
      if (playing) stop();
    });
    q("[data-k=tgt]", el).addEventListener("input", e => {
      tgt = +e.target.value;
      q("[data-v=tgt]", el).textContent = tgt;
      plans();
      if (srcNode) srcNode.playbackRate.value = rateOf(selMult);
    });
    selMult = bestMult();
    plans();

    MOD.warp = {
      sync() {
        tgt = Math.max(118, Math.min(150, TR.bpm));
        q("[data-k=tgt]", el).value = tgt;
        q("[data-v=tgt]", el).textContent = tgt;
        selMult = bestMult();
        plans();
        if (srcNode) srcNode.playbackRate.value = rateOf(selMult);
      },
    };

    /* prova do warp: pick the cheapest plan for random pairings, 4 in a row */
    let wq = null;
    const quizEl = q(".warp-quiz", el);
    function wqQuestion() {
      const t = tracks[Math.floor(Math.random() * tracks.length)];
      const qtgt = 120 + Math.floor(Math.random() * 29);
      const cost = m => Math.abs(Math.log2(qtgt * m / t.bpm));
      const sorted = MULTS.map(([, m]) => cost(m)).sort((a, b) => a - b);
      if (sorted[1] - sorted[0] < 0.08) return wqQuestion();  // no ambiguous questions
      wq.cur = { bpm: t.bpm, name: nameOf(t.file), tgt: qtgt };
      quizEl.innerHTML = `<div class="quiz-card">
        <b>prova ${wq.streak}/4</b> &middot; <b>${wq.cur.name}</b> sits at <b>${t.bpm} BPM</b>
        and the frame wants <b>${qtgt} BPM</b>. Which plan costs least?
        <div class="row-actions">
          ${MULTS.map(([lab, m]) => `<button type="button" class="ghost" data-wq="${m}">${lab}</button>`).join("")}
        </div><div class="quiz-fb"></div></div>`;
      qa("[data-wq]", quizEl).forEach(b =>
        b.addEventListener("click", () => wqAnswer(+b.dataset.wq)));
    }
    function wqAnswer(m) {
      if (!wq) return;
      const { bpm, tgt: qtgt } = wq.cur;
      const cost = mm => Math.abs(Math.log2(qtgt * mm / bpm));
      const best = MULTS.reduce((a, [, mm]) => cost(mm) < cost(a) ? mm : a, 1);
      const detail = MULTS.map(([lab, mm]) =>
        `${lab} ${((qtgt * mm / bpm - 1) * 100).toFixed(0)}%`).join(" &middot; ");
      const fb = q(".quiz-fb", quizEl);
      if (m === best) {
        wq.streak++;
        if (wq.streak >= 4) {
          emit("prova-warp");
          quizEl.innerHTML = `<div class="quiz-card"><b>aprovado.</b> Four plans read right. ${detail}</div>`;
          wq = null;
          q("[data-a=prova]", el).textContent = "prova do warp";
          return;
        }
        fb.innerHTML = `<b>certo (${wq.streak}/4)</b> &middot; ${detail}`;
        setTimeout(() => { if (wq) wqQuestion(); }, 1500);
      } else {
        wq.streak = 0;
        fb.innerHTML = `<b>errado, streak reset.</b> Cheapest was &times;${best}. ${detail}`;
        setTimeout(() => { if (wq) wqQuestion(); }, 2200);
      }
    }
    q("[data-a=prova]", el).addEventListener("click", ev => {
      if (wq) { wq = null; quizEl.innerHTML = ""; ev.target.textContent = "prova do warp"; return; }
      wq = { streak: 0 };
      ev.target.textContent = "sair da prova";
      wqQuestion();
    });
  }

  /* ================= 05 O Pulso: beatmatch trainer ================= */

  function buildPulso(el) {
    el.innerHTML = `
      <div class="esc-controls">
        <button class="ghost" data-a="go">start</button>
        <button class="ghost" data-a="round">new round</button>
        <label class="check" title="shows deck B's true tempo: training wheels. Lock with this off to pass the prova as cegas"><input type="checkbox" data-k="reveal"> reveal deck B</label>
      </div>
      <p class="side-note esc-note">deck B starts a few percent off, tempo hidden. The
        <b>pitch fader</b> fixes its SPEED; <b>atrasar / adiantar</b> (hold them down) nudge its
        PHASE so the kicks land together. Fader until the gap stops growing, nudge until the bar
        turns green, hold both for 3.5 s and it locks.</p>
      <div class="decks">
        <div class="deck"><span class="dname">deck A</span>
          ${'<span class="blip"></span>'.repeat(4)}<span class="dbpm">132.0</span></div>
        <div class="deck"><span class="dname">deck B</span>
          ${'<span class="blip"></span>'.repeat(4)}<span class="dbpm" data-v="bbpm">?</span></div>
      </div>
      <div class="esc-controls fader-row">
        <label class="fader-lab" title="deck B's SPEED: if the gap between the decks keeps growing, this is the knob that is wrong">pitch fader <b data-v="fader">+0.00%</b>
          <input type="range" min="-8" max="8" step="0.05" value="0" data-k="fader"></label>
        <span class="nudge-pair">
          <button class="ghost" data-a="drag" title="hold: slow deck B for a moment">&larr; atrasar B</button>
          <button class="ghost" data-a="push" title="hold: speed deck B for a moment">adiantar B &rarr;</button>
        </span>
      </div>
      <div class="phase-wrap"><canvas class="phase"></canvas></div>
      <div data-v="lock"></div>`;
    const BASE = 132;
    let on = false, timer = null, offset = 0, fader = 0, nudge = 0,
        lockStart = null, locked = false, master = null, revealUsed = false;
    const A = { next: 0, count: 0, last: 0, lastN: 0, q: [] };
    const B = { next: 0, count: 0, last: 0, lastN: 0, q: [] };
    const bTempo = () => BASE * (1 + offset / 100) * (1 + (fader + nudge) / 100);

    function newRound() {
      offset = (1.5 + Math.random() * 2.5) * (Math.random() < 0.5 ? -1 : 1);
      fader = 0; nudge = 0; lockStart = null; locked = false;
      revealUsed = q("[data-k=reveal]", el).checked;
      q("[data-k=fader]", el).value = 0;
      q("[data-v=fader]", el).textContent = "+0.00%";
      q("[data-v=lock]", el).innerHTML = "";
    }
    function schedule() {
      const ctx = AC();
      while (A.next < ctx.currentTime + 0.15) {
        DRUMS.kick(A.next, 1, master.a);
        DRUMS.hat(A.next + 30 / BASE, 0.7, master.a);
        A.q.push({ t: A.next, i: A.count % 4 });
        A.lastN = A.next; A.next += 60 / BASE; A.count++;
      }
      while (B.next < ctx.currentTime + 0.15) {
        const tp = bTempo();
        DRUMS.kick(B.next, 1, master.b, 210);
        DRUMS.rim(B.next + 30 / tp, 0.5, master.b);
        B.q.push({ t: B.next, i: B.count % 4 });
        B.lastN = B.next; B.next += 60 / tp; B.count++;
      }
    }
    function frame() {
      if (!on) return;
      const now = AC().currentTime;
      [[A, 0], [B, 1]].forEach(([d, row]) => {
        while (d.q.length && d.q[0].t <= now) {
          const { i } = d.q.shift();
          qa(".deck", el)[row].querySelectorAll(".blip").forEach((b, bi) =>
            b.classList.toggle("hit", bi === i));
        }
      });
      /* phase: distance between the decks' most recent scheduled beats */
      const spbA = 60 / BASE, tB = bTempo(), spbB = 60 / tB;
      const aPrev = A.next - spbA, bPrev = B.next - spbB;
      let diff = (bPrev - aPrev) / spbA;
      diff = ((diff % 1) + 1.5) % 1 - 0.5;
      const ms = diff * spbA * 1000;
      const c = q("canvas.phase", el);
      const g = sizeCanvas(c, 34);
      const { width: w, height: h } = c;
      const dpr = devicePixelRatio || 1;
      g.clearRect(0, 0, w, h);
      g.fillStyle = "rgba(58,51,44,0.2)";
      g.fillRect(w / 2 - dpr, 0, 2 * dpr, h);
      const inPhase = Math.abs(ms) < 25, inTempo = Math.abs(tB - BASE) / BASE < 0.0015;
      const x = w / 2 + Math.max(-1, Math.min(1, ms / (spbA * 500))) * (w / 2 - 8 * dpr);
      g.fillStyle = inPhase ? "#4a7c59" : "#a34a24";
      g.fillRect(x - 3 * dpr, 4 * dpr, 6 * dpr, h - 8 * dpr);
      g.fillStyle = "rgba(58,51,44,0.7)";
      g.font = `${9.5 * dpr}px monospace`;
      g.textAlign = "left";
      g.fillText("phase", 6 * dpr, h - 7 * dpr);
      g.textAlign = "right";
      g.fillText(`${ms >= 0 ? "+" : ""}${ms.toFixed(0)} ms ${inTempo ? "tempo ok" : "tempo off"}`, w - 6 * dpr, h - 7 * dpr);
      q("[data-v=bbpm]", el).textContent =
        q("[data-k=reveal]", el).checked ? tB.toFixed(1) : "?";
      if (inPhase && inTempo) {
        if (!lockStart) lockStart = now;
        else if (now - lockStart > 3.5 && !locked) {
          locked = true;
          q("[data-v=lock]", el).innerHTML = `<span class="lock-stamp">LOCKED &middot; TRAVADO${revealUsed ? "" : " &middot; AS CEGAS"}</span>`;
          emit("pulso-lock");
          if (!revealUsed) emit("prova-pulso");
        }
      } else { lockStart = null; }
      requestAnimationFrame(frame);
    }
    function stop() {
      if (!on) return;
      on = false;
      clearInterval(timer);
      A.q.length = B.q.length = 0;
      qa(".blip.hit", el).forEach(b => b.classList.remove("hit"));
      q("[data-a=go]", el).textContent = "start";
      release(stop);
    }
    q("[data-a=go]", el).addEventListener("click", ev => {
      if (on) { stop(); return; }
      claim("pulso", stop);
      const ctx = AC(); ctx.resume();
      if (!master) {
        const mk = pan => {
          const p = new StereoPannerNode(ctx, { pan });
          const g = ctx.createGain(); g.gain.value = 0.8;
          g.connect(p).connect(CHAN("pulso"));
          return g;
        };
        master = { a: mk(-0.35), b: mk(0.35) };
      }
      on = true;
      A.next = ctx.currentTime + 0.1; A.count = 0;
      B.next = ctx.currentTime + 0.1 + Math.random() * 0.4; B.count = 0;
      timer = setInterval(schedule, 25);
      ev.target.textContent = "stop";
      requestAnimationFrame(frame);
    });
    q("[data-a=round]", el).addEventListener("click", () => newRound());
    q("[data-k=reveal]", el).addEventListener("change", e => {
      if (e.target.checked) revealUsed = true;
    });
    q("[data-k=fader]", el).addEventListener("input", e => {
      fader = +e.target.value;
      q("[data-v=fader]", el).textContent = `${fader >= 0 ? "+" : ""}${fader.toFixed(2)}%`;
      if (locked) { locked = false; lockStart = null; q("[data-v=lock]", el).innerHTML = ""; }
    });
    for (const [act, val] of [["drag", -1.2], ["push", 1.2]]) {
      const b = q(`[data-a=${act}]`, el);
      b.addEventListener("pointerdown", ev => { ev.preventDefault(); nudge = val; });
      const off = () => { nudge = 0; };
      b.addEventListener("pointerup", off);
      b.addEventListener("pointerleave", off);
    }
    newRound();
  }

  /* ================= 06 O Duck: sidechain lab ================= */

  function buildDuck(el) {
    el.innerHTML = `
      <div class="esc-controls">
        <button class="ghost" data-a="go">start</button>
        <label title="how far everything dives when the kick hits: shallow = subtle glue, deep = hard pumping">depth dB <b data-v="depth">-12</b>
          <input type="range" min="2" max="24" step="1" value="12" data-k="depth"></label>
        <label title="how fast it climbs back up: fast = the classic pump, slow = everything just gets quieter">release s <b data-v="rel">0.09</b>
          <input type="range" min="0.03" max="0.35" step="0.01" value="0.09" data-k="rel"></label>
        <label class="check" title="the sidechain itself: off = the drone plays flat"><input type="checkbox" data-k="duckon" checked> duck on</label>
        <label class="check" title="mute the kick and the drone keeps breathing in its shape: that ghost is the sidechain"><input type="checkbox" data-k="kickon" checked> kick audible</label>
        <button class="ghost" data-a="prova">prova do duck</button>
      </div>
      <canvas class="duckcurve"></canvas>
      <div class="duck-quiz"></div>
      <p class="side-note esc-note">the curve is one beat of the drone's gain. Uncheck the kick and
        the drone keeps breathing in its shape: that ghost is the sidechain.</p>`;
    let bpm = TR.bpm;
    const spb = () => 60 / bpm;
    let on = false, timer = null, depth = 12, rel = 0.09, duckOn = true, kickOn = true,
        nodes = null, drone = null, next = 0, t0 = 0, dq = null;

    const duckEff = () => dq ? dq.truth : duckOn;
    function env(t) {
      const floor = db(-depth);
      if (!duckEff()) return 1;
      if (t < 0.012) return 1 + (floor - 1) * (t / 0.012);
      return floor + (1 - floor) * (1 - Math.exp(-(t - 0.012) / rel));
    }
    function drawCurve() {
      const c = q("canvas.duckcurve", el);
      const g = sizeCanvas(c, 90);
      const { width: w, height: h } = c;
      const dpr = devicePixelRatio || 1;
      g.clearRect(0, 0, w, h);
      if (dq) {
        g.fillStyle = "rgba(58,51,44,0.55)";
        g.font = `700 ${26 * dpr}px Georgia, serif`;
        g.textAlign = "center";
        g.fillText("?", w / 2, h / 2 + 9 * dpr);
        g.font = `${9.5 * dpr}px monospace`;
        g.fillText("curve hidden during the prova: use your ears", w / 2, h - 8 * dpr);
        return;
      }
      g.strokeStyle = "rgba(58,51,44,0.15)";
      g.lineWidth = dpr;
      for (const f of [0.25, 0.5, 0.75]) {
        g.beginPath(); g.moveTo(w * f, 0); g.lineTo(w * f, h); g.stroke();
      }
      g.strokeStyle = "#a34a24";
      g.lineWidth = 2 * dpr;
      g.beginPath();
      for (let x = 0; x < w; x++) {
        const y = h - (env(x / w * spb()) * 0.82 + 0.09) * h;
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
      if (on) {
        const s = spb();
        const ph = ((AC().currentTime - t0) % s) / s;
        g.fillStyle = "rgba(74,124,89,0.85)";
        g.fillRect(ph * w - dpr, 0, 2 * dpr, h);
      }
    }
    function anim() { if (!on) return; drawCurve(); requestAnimationFrame(anim); }
    function schedule() {
      const ctx = AC();
      while (next < ctx.currentTime + 0.15) {
        DRUMS.kick(next, 1, nodes.kickG);
        if (duckEff()) {
          const g = nodes.duckG.gain, floor = db(-depth);
          g.setValueAtTime(1, next);
          g.linearRampToValueAtTime(floor, next + 0.012);
          g.setTargetAtTime(1, next + 0.012, rel);
        }
        next += spb();
      }
    }
    function stop() {
      if (!on) return;
      on = false;
      clearInterval(timer);
      if (drone) { drone.stop(); drone = null; }
      q("[data-a=go]", el).textContent = "start";
      release(stop);
      if (dq) endDq();
      drawCurve();
    }

    /* prova do duck: breathing or flat, judged blind, 3 in a row */
    function endDq(msg) {
      dq = null;
      qa("input[type=checkbox]", el).forEach(c => { c.disabled = false; });
      if (nodes) nodes.kickG.gain.value = kickOn ? 1 : 0;
      if (nodes && duckOn === false) {
        const t = AC().currentTime;
        nodes.duckG.gain.cancelScheduledValues(t);
        nodes.duckG.gain.setTargetAtTime(1, t, 0.05);
      }
      q(".duck-quiz", el).innerHTML = msg ? `<div class="quiz-card">${msg}</div>` : "";
      q("[data-a=prova]", el).textContent = "prova do duck";
      drawCurve();
    }
    function renderDqUI(prefix) {
      q(".duck-quiz", el).innerHTML = `<div class="quiz-card">${prefix || ""}
        <b>prova ${dq.streak}/3</b> &middot; listen: is the drone <b>breathing</b> (ducked) or
        <b>flat</b>?
        <div class="row-actions">
          <button type="button" class="ghost" data-dq="resp">breathing</button>
          <button type="button" class="ghost" data-dq="flat">flat</button>
        </div></div>`;
      qa("[data-dq]", el).forEach(b => b.addEventListener("click", () => {
        if (!dq) return;
        const ok = (b.dataset.dq === "resp") === dq.truth;
        const was = dq.truth ? "breathing" : "flat";
        if (ok) dq.streak++; else dq.streak = 0;
        if (dq.streak >= 3) {
          emit("prova-duck");
          endDq("<b>aprovado.</b> Three blind calls in a row: you can hear the pump now.");
          return;
        }
        if (!duckOn && !dq.truth) { /* keep gain clean between rounds */ }
        dq.truth = Math.random() < 0.5;
        renderDqUI(`<b>${ok ? "certo" : "errado, streak reset"}</b> &middot; it was ${was}.
          New round is live.<br>`);
      }));
    }
    q("[data-a=prova]", el).addEventListener("click", ev => {
      if (dq) { endDq(); return; }
      if (!on) q("[data-a=go]", el).click();
      dq = { truth: Math.random() < 0.5, streak: 0 };
      if (nodes) nodes.kickG.gain.value = 0;
      qa("input[type=checkbox]", el).forEach(c => { c.disabled = true; });
      ev.target.textContent = "sair da prova";
      renderDqUI();
      drawCurve();
    });
    q("[data-a=go]", el).addEventListener("click", ev => {
      if (on) { stop(); return; }
      claim("duck", stop);
      const ctx = AC(); ctx.resume();
      if (!nodes) {
        const master = ctx.createGain(); master.gain.value = 0.9;
        master.connect(CHAN("duck"));
        const duckG = ctx.createGain();
        duckG.connect(master);
        const kickG = ctx.createGain(); kickG.gain.value = kickOn ? 1 : 0;
        kickG.connect(master);
        nodes = { master, duckG, kickG };
      }
      nodes.duckG.gain.cancelScheduledValues(ctx.currentTime);
      nodes.duckG.gain.setValueAtTime(1, ctx.currentTime);
      drone = droneVoice(55, nodes.duckG, { lp: 380, fifth: true, gain: 0.26 });
      on = true;
      const al = trAlign(spb());
      t0 = next = al.t;
      timer = setInterval(schedule, 25);
      ev.target.textContent = "stop";
      requestAnimationFrame(anim);
    });
    q("[data-k=depth]", el).addEventListener("input", e => {
      depth = +e.target.value;
      q("[data-v=depth]", el).textContent = `-${depth}`;
      drawCurve();
    });
    q("[data-k=rel]", el).addEventListener("input", e => {
      rel = +e.target.value;
      q("[data-v=rel]", el).textContent = rel.toFixed(2);
      drawCurve();
    });
    q("[data-k=duckon]", el).addEventListener("change", e => {
      duckOn = e.target.checked;
      if (!duckOn && nodes) {
        const t = AC().currentTime;
        nodes.duckG.gain.cancelScheduledValues(t);
        nodes.duckG.gain.setTargetAtTime(1, t, 0.05);
      }
      drawCurve();
    });
    q("[data-k=kickon]", el).addEventListener("change", e => {
      kickOn = e.target.checked;
      if (nodes) nodes.kickG.gain.value = kickOn ? 1 : 0;
      if (on && !kickOn) emit("duck-ghost");
    });
    drawCurve();

    MOD.duck = {
      get: () => ({ bpm, depth, rel, duckOn, kickOn }),
      set(st) {
        if (st.bpm) bpm = st.bpm;
        if (st.depth != null) depth = st.depth;
        if (st.rel != null) rel = st.rel;
        if (st.duckOn != null) duckOn = st.duckOn;
        if (st.kickOn != null) kickOn = st.kickOn;
        q("[data-k=depth]", el).value = depth; q("[data-v=depth]", el).textContent = `-${depth}`;
        q("[data-k=rel]", el).value = rel; q("[data-v=rel]", el).textContent = rel.toFixed(2);
        q("[data-k=duckon]", el).checked = duckOn;
        q("[data-k=kickon]", el).checked = kickOn;
        if (nodes) nodes.kickG.gain.value = kickOn ? 1 : 0;
        drawCurve();
      },
      setTempo(v) {
        bpm = Math.max(100, Math.min(170, v));
        if (on) { const al = trAlign(spb(), false); t0 = next = al.t; }
        drawCurve();
      },
    };
  }

  /* ================= 07 As Bandas: EQ lab ================= */

  async function buildEq(el) {
    let tracks = [];
    try { tracks = await crate(); } catch (e) {}
    if (!tracks.length) {
      el.innerHTML = '<p class="side-note">no analyzed tracks yet: pull something in Lado C first.</p>';
      return;
    }
    el.innerHTML = `
      <div class="esc-controls">
        <label title="which crate track plays through the three bands">track <select data-k="track">
          ${tracks.map((a, i) => `<option value="${i}">${nameOf(a.file)}</option>`).join("")}
        </select></label>
        <button class="ghost" data-a="play">play</button>
        <button class="ghost" data-a="prova">prova das bandas</button>
        <span class="side-note" data-v="load"></span>
      </div>
      ${[["low", "below 200 Hz: kick, sub, zabumba weight. Cut it to make room for another bassline"],
         ["mid", "200 Hz to 4 kHz: voices, berimbau, guitars, almost all the music"],
         ["high", "above 4 kHz: hats, chiado, air. Kill it and the room goes dull"]].map(([b, r]) => `
        <div class="eq-band">
          <span title="${r}">${b}</span>
          <button class="ghost killbtn" data-kill="${b}" title="cut this whole band in one move: the bass swap lives on this button">kill</button>
          <input type="range" min="-24" max="9" step="0.5" value="0" data-band="${b}" title="${r}">
          <b data-bv="${b}">0.0</b>
        </div>`).join("")}
      <div class="eq-quiz"></div>
      <canvas class="spectrum"></canvas>`;
    const G = { low: 0, mid: 0, high: 0 }, PREV = { low: 0, mid: 0, high: 0 };
    let ti = 0, playing = false, srcNode = null, chain = null, eq2 = null;

    function ensureChain() {
      if (chain) return chain;
      const ctx = AC();
      const low = new BiquadFilterNode(ctx, { type: "lowshelf", frequency: 200 });
      const mid = new BiquadFilterNode(ctx, { type: "peaking", frequency: 850, Q: 0.55 });
      const high = new BiquadFilterNode(ctx, { type: "highshelf", frequency: 4000 });
      const an = ctx.createAnalyser(); an.fftSize = 4096; an.smoothingTimeConstant = 0.82;
      const out = ctx.createGain(); out.gain.value = 0.9;
      low.connect(mid).connect(high).connect(an).connect(out).connect(CHAN("bandas"));
      chain = { low, mid, high, an, out };
      apply();
      return chain;
    }
    function apply() {
      if (!chain) return;
      chain.low.gain.value = G.low;
      chain.mid.gain.value = G.mid;
      chain.high.gain.value = G.high;
      if (eq2) chain[eq2.band].gain.value = -24;
    }
    function spectrum() {
      if (!playing) return;
      const c = q("canvas.spectrum", el);
      const g = sizeCanvas(c, 120);
      const { width: w, height: h } = c;
      const dpr = devicePixelRatio || 1;
      const ctx = AC();
      g.clearRect(0, 0, w, h);
      if (eq2) {
        g.fillStyle = "rgba(58,51,44,0.55)";
        g.font = `700 ${26 * dpr}px Georgia, serif`;
        g.textAlign = "center";
        g.fillText("?", w / 2, h / 2 + 9 * dpr);
        g.font = `${9.5 * dpr}px monospace`;
        g.fillText("spectrum hidden during the prova: use your ears", w / 2, h - 8 * dpr);
        requestAnimationFrame(spectrum);
        return;
      }
      const F0 = 35, F1 = 17000;
      const xOf = f => w * Math.log(f / F0) / Math.log(F1 / F0);
      g.fillStyle = "rgba(163,74,36,0.06)";
      g.fillRect(0, 0, xOf(200), h);
      g.fillStyle = "rgba(74,124,89,0.06)";
      g.fillRect(xOf(4000), 0, w - xOf(4000), h);
      g.strokeStyle = "rgba(58,51,44,0.25)";
      g.lineWidth = dpr;
      for (const f of [200, 4000]) {
        g.beginPath(); g.moveTo(xOf(f), 0); g.lineTo(xOf(f), h); g.stroke();
      }
      const data = new Uint8Array(chain.an.frequencyBinCount);
      chain.an.getByteFrequencyData(data);
      const nyq = ctx.sampleRate / 2, N = 72;
      g.fillStyle = "rgba(58,51,44,0.8)";
      for (let i = 0; i < N; i++) {
        const f0 = F0 * Math.pow(F1 / F0, i / N), f1 = F0 * Math.pow(F1 / F0, (i + 1) / N);
        const b0 = Math.floor(f0 / nyq * data.length), b1 = Math.max(b0 + 1, Math.floor(f1 / nyq * data.length));
        let sum = 0;
        for (let b = b0; b < b1 && b < data.length; b++) sum += data[b];
        const v = sum / (b1 - b0) / 255;
        const x0 = xOf(f0), bw = Math.max(dpr, xOf(f1) - x0 - dpr);
        g.fillRect(x0, h - v * (h - 14 * dpr), bw, v * (h - 14 * dpr));
      }
      g.fillStyle = "rgba(58,51,44,0.6)";
      g.font = `${9.5 * dpr}px monospace`;
      g.textAlign = "center";
      g.fillText("low", xOf(85), 11 * dpr);
      g.fillText("mid", xOf(900), 11 * dpr);
      g.fillText("high", xOf(8500), 11 * dpr);
      requestAnimationFrame(spectrum);
    }
    function stop() {
      if (srcNode) { try { srcNode.stop(); } catch (e) {} srcNode = null; }
      playing = false;
      q("[data-a=play]", el).textContent = "play";
      release(stop);
      if (eq2) endEq2();
    }

    /* prova das bandas: one band is killed in secret, name it, 3 in a row */
    function endEq2(msg) {
      eq2 = null;
      apply();
      qa("input[data-band],[data-kill]", el).forEach(i => { i.disabled = false; });
      q(".eq-quiz", el).innerHTML = msg ? `<div class="quiz-card">${msg}</div>` : "";
      q("[data-a=prova]", el).textContent = "prova das bandas";
    }
    function renderEqQuiz(prefix) {
      q(".eq-quiz", el).innerHTML = `<div class="quiz-card">${prefix || ""}
        <b>prova ${eq2.streak}/3</b> &middot; one band is killed in secret. Which one is missing?
        <div class="row-actions">
          ${["low", "mid", "high"].map(b =>
            `<button type="button" class="ghost" data-eqq="${b}">${b}</button>`).join("")}
        </div></div>`;
      qa("[data-eqq]", el).forEach(b => b.addEventListener("click", () => {
        if (!eq2) return;
        const ok = b.dataset.eqq === eq2.band;
        const was = eq2.band;
        if (ok) eq2.streak++; else eq2.streak = 0;
        if (eq2.streak >= 3) {
          emit("prova-eq");
          endEq2("<b>aprovado.</b> Three bands named blind: that is a working pair of ears.");
          return;
        }
        eq2.band = ["low", "mid", "high"][Math.floor(Math.random() * 3)];
        apply();
        renderEqQuiz(`<b>${ok ? "certo" : "errado, streak reset"}</b> &middot; it was ${was}.
          New cut is live.<br>`);
      }));
    }
    q("[data-a=prova]", el).addEventListener("click", ev => {
      if (eq2) { endEq2(); return; }
      if (!playing) {
        q(".eq-quiz", el).innerHTML =
          '<div class="quiz-card">press play first, then start the prova.</div>';
        return;
      }
      eq2 = { band: ["low", "mid", "high"][Math.floor(Math.random() * 3)], streak: 0 };
      apply();
      qa("input[data-band],[data-kill]", el).forEach(i => { i.disabled = true; });
      ev.target.textContent = "sair da prova";
      renderEqQuiz();
    });
    q("[data-a=play]", el).addEventListener("click", async ev => {
      if (playing) { stop(); return; }
      claim("bandas", stop);
      const ctx = AC(); ctx.resume();
      q("[data-v=load]", el).textContent = "loading preview ...";
      let buf;
      try { buf = await previewBuf(tracks[ti].file.split("/").pop()); }
      catch (e) { q("[data-v=load]", el).textContent = "preview failed"; release(stop); return; }
      q("[data-v=load]", el).textContent = "";
      ensureChain();
      srcNode = ctx.createBufferSource();
      srcNode.buffer = buf; srcNode.loop = true;
      srcNode.connect(chain.low);
      srcNode.start();
      playing = true;
      ev.target.textContent = "stop";
      requestAnimationFrame(spectrum);
      emit("eq-play");
    });
    q("[data-k=track]", el).addEventListener("change", e => { ti = +e.target.value; if (playing) stop(); });
    qa("input[data-band]", el).forEach(inp => inp.addEventListener("input", () => {
      const b = inp.dataset.band;
      G[b] = +inp.value;
      q(`[data-bv=${b}]`, el).textContent = G[b].toFixed(1);
      const kb = q(`[data-kill=${b}]`, el);
      if (G[b] > -24) kb.classList.remove("on");
      apply();
    }));
    qa("[data-kill]", el).forEach(kb => kb.addEventListener("click", () => {
      const b = kb.dataset.kill;
      const inp = q(`input[data-band=${b}]`, el);
      if (kb.classList.toggle("on")) {
        PREV[b] = G[b]; G[b] = -24;
        if (playing && b === "low") emit("eq-kill");
      } else G[b] = PREV[b];
      inp.value = G[b];
      q(`[data-bv=${b}]`, el).textContent = G[b].toFixed(1);
      apply();
    }));
  }

  /* ================= 08 A Voz: the vocal channel ================= */

  async function buildVoz(el) {
    let tracks = [];
    try { tracks = await crate(); } catch (e) {}
    if (!tracks.length) {
      el.innerHTML = '<p class="side-note">no analyzed tracks yet: pull something in Lado C first.</p>';
      return;
    }
    const isLush = a => /\/lush\//.test(a.file);
    const ordered = tracks.map((a, i) => ({ a, i })).sort((x, y) => isLush(y.a) - isLush(x.a));
    el.innerHTML = `
      <div class="esc-controls">
        <label title="which crate track this channel plays: the lush shelf (voices) sorts first">vocal channel <select data-k="track">
          ${ordered.map(({ a, i }) =>
            `<option value="${i}">${isLush(a) ? "lush - " : ""}${nameOf(a.file)} (${a.bpm} BPM)</option>`).join("")}
        </select></label>
        <label title="demucs isolation: the whole track, or just its voice, drums, bass, or everything else (strings, keys, guitars)">camada <select data-k="stem">
          <option value="">faixa inteira</option>
          <option value="vocals">so a voz</option>
          <option value="drums">so a percussao</option>
          <option value="bass">so o baixo</option>
          <option value="other">o resto (cordas, teclas)</option>
        </select></label>
        <button class="ghost" data-a="play">play</button>
        <button class="ghost" data-a="match" title="beat match: warp this channel to the mesa tempo with the cheapest straight/half/double plan">bpm match</button>
        <span class="side-note" data-v="plan">straight, at the track's own tempo</span>
      </div>
      <div class="esc-controls">
        <label title="this channel's own level, before the high-pass">level <b data-v="gain">0.80</b>
          <input type="range" min="0" max="1" step="0.05" value="0.8" data-k="gain"></label>
        <label title="cuts everything below this frequency: raise it and a whole track thins into a topline that sits over your groove">high-pass Hz <b data-v="hp">80</b>
          <input type="range" min="0" max="100" step="1" value="${fromLog(80, 40, 2000)}" data-k="hp"></label>
        <button class="ghost" data-a="sep" hidden>separar camadas</button>
        <span class="side-note" data-v="sep"></span>
        <span class="side-note" data-v="load"></span>
      </div>
      <canvas class="hunt"></canvas>
      <div class="esc-controls">
        <button class="ghost" data-a="savesel" disabled>salvar passagem</button>
        <button class="ghost" data-a="clearsel" disabled>limpar passagem</button>
        <span class="side-note" data-v="hunt">loading the wave ...</span>
      </div>`;
    let ti = ordered[0].i, playing = false, srcNode = null, nodes = null,
        matched = false, gainV = 0.8, hpHz = 80, stemSel = "",
        waveBuf = null, loopSaved = null, sel = null,
        playT0 = 0, playOff = 0, playRate = 1;
    q("[data-k=track]", el).value = ti;

    async function checkStem() {
      const sepBtn = q("[data-a=sep]", el);
      if (!stemSel) { sepBtn.hidden = true; q("[data-v=sep]", el).textContent = ""; return; }
      let ready = false;
      try {
        const fname = tracks[ti].file.split("/").pop();
        ready = (await (await fetch(`/api/source/stems?file=${encodeURIComponent(fname)}`)).json()).ready;
      } catch (e) {}
      sepBtn.hidden = ready;
      q("[data-v=sep]", el).textContent = ready ? "" :
        "this track's camadas are not split yet: separar runs demucs once on the plant's gpu (about 20 seconds) and caches it for good";
    }

    function ensureNodes() {
      if (nodes) return nodes;
      const ctx = AC();
      const hp = new BiquadFilterNode(ctx, { type: "highpass", frequency: hpHz, Q: 0.7 });
      const g = ctx.createGain(); g.gain.value = gainV;
      hp.connect(g).connect(CHAN("voz"));
      nodes = { hp, g };
      return nodes;
    }
    const bestMult = bpm => [1, 0.5, 2].reduce((x, m) =>
      Math.abs(Math.log2(TR.bpm * m / bpm)) < Math.abs(Math.log2(TR.bpm * x / bpm)) ? m : x, 1);
    function applyRate() {
      const bpm = tracks[ti].bpm;
      let rate = 1, label = "straight, at the track's own tempo";
      if (matched && bpm) {
        const m = bestMult(bpm);
        rate = TR.bpm * m / bpm;
        const st = 12 * Math.log2(rate);
        label = `x${m} into ${TR.bpm} BPM: rate ${rate.toFixed(3)} (${st >= 0 ? "+" : ""}${st.toFixed(1)} st)`;
      }
      if (srcNode && playing) {
        const p = curPos();
        if (p != null) { playOff = p; playT0 = AC().currentTime; }
      }
      playRate = rate;
      if (srcNode) srcNode.playbackRate.value = rate;
      q("[data-v=plan]", el).textContent = label;
      q("[data-a=match]", el).classList.toggle("on", matched);
    }
    function stop() {
      if (srcNode) { try { srcNode.stop(); } catch (e) {} srcNode = null; }
      playing = false;
      q("[data-a=play]", el).textContent = "play";
      release(stop);
      drawHunt();
    }

    /* ---- the sample hunter: scrub, select, cut, loop, save ---- */
    function activeBounds() {
      const dur = waveBuf ? waveBuf.duration : 0;
      if (sel && sel.b - sel.a > 0.1) return { a: sel.a, b: Math.min(sel.b, dur) };
      if (loopSaved && loopSaved.end && loopSaved.end > (loopSaved.start || 0))
        return { a: loopSaved.start || 0, b: Math.min(loopSaved.end, dur) };
      return { a: 0, b: dur };
    }
    function curPos() {
      if (!playing || !srcNode || !waveBuf) return null;
      const a = srcNode.loopStart || 0, b = srcNode.loopEnd || waveBuf.duration;
      const raw = playOff + (AC().currentTime - playT0) * playRate;
      if (b <= a) return a;
      if (raw < b) return Math.max(0, raw);
      return a + (raw - b) % (b - a);
    }
    function beginPlayback(offset) {
      const ctx = AC(); ctx.resume();
      ensureNodes();
      if (srcNode) { try { srcNode.stop(); } catch (e) {} }
      const bounds = activeBounds();
      srcNode = ctx.createBufferSource();
      srcNode.buffer = waveBuf;
      srcNode.loop = true;
      srcNode.loopStart = bounds.a;
      srcNode.loopEnd = bounds.b;
      srcNode.connect(nodes.hp);
      const off = offset != null ? Math.max(0, Math.min(offset, waveBuf.duration - 0.05)) : bounds.a;
      srcNode.start(ctx.currentTime, off);
      playT0 = ctx.currentTime;
      playOff = off;
      applyRate();
      playing = true;
      q("[data-a=play]", el).textContent = "stop";
      syncHunt();
      requestAnimationFrame(huntAnim);
    }
    async function loadWave() {
      const fname = tracks[ti].file.split("/").pop();
      const hint = q("[data-v=hunt]", el);
      hint.textContent = "loading the wave ...";
      waveBuf = null;
      sel = null;
      try { waveBuf = stemSel ? await stemPreviewBuf(fname, stemSel) : await previewBuf(fname); }
      catch (e) {
        hint.textContent = e.message === "not separated"
          ? "this camada is not split yet: separar camadas first, the wave loads after"
          : "could not load the wave";
        drawHunt();
        return;
      }
      try { loopSaved = await (await fetch(`/api/source/loop?file=${encodeURIComponent(fname)}`)).json(); }
      catch (e) { loopSaved = null; }
      drawHunt();
      syncHunt();
    }
    function syncHunt() {
      const saved = loopSaved && loopSaved.end;
      q("[data-a=savesel]", el).disabled = !(sel && waveBuf);
      q("[data-a=clearsel]", el).disabled = !sel && !saved;
      const hint = q("[data-v=hunt]", el);
      if (!waveBuf) return;
      if (sel) {
        hint.innerHTML = `passagem ${sel.a.toFixed(1)}s a ${sel.b.toFixed(1)}s
          (${(sel.b - sel.a).toFixed(1)}s) &middot; ${playing ? "playing it" : "press play to loop it"}
          &middot; salvar makes it the track's passage everywhere`;
      } else if (saved) {
        hint.textContent = `saved passage ${(loopSaved.start || 0).toFixed(1)}s to ` +
          `${loopSaved.end.toFixed(1)}s: drag to hunt a new one, click to jump the playhead`;
      } else {
        hint.textContent = "drag on the wave to hunt a passage; click to jump the playhead";
      }
    }
    function drawHunt() {
      const c = q("canvas.hunt", el);
      if (!c || !c.clientWidth) return;
      const g = sizeCanvas(c, 84);
      const { width: w, height: h } = c;
      const dpr = devicePixelRatio || 1;
      g.clearRect(0, 0, w, h);
      if (!waveBuf) {
        g.fillStyle = "rgba(58,51,44,0.4)";
        g.font = `${10 * dpr}px monospace`;
        g.textAlign = "center";
        g.fillText("no wave", w / 2, h / 2);
        return;
      }
      const dur = waveBuf.duration;
      const data = waveBuf.getChannelData(0);
      if (loopSaved && loopSaved.end) {
        g.fillStyle = "rgba(74,124,89,0.16)";
        const x0 = (loopSaved.start || 0) / dur * w;
        g.fillRect(x0, 0, loopSaved.end / dur * w - x0, h);
      }
      if (sel) {
        g.fillStyle = "rgba(163,74,36,0.22)";
        g.fillRect(sel.a / dur * w, 0, (sel.b - sel.a) / dur * w, h);
      }
      g.fillStyle = "rgba(58,51,44,0.75)";
      const cols = Math.max(1, Math.floor(w / (2 * dpr)));
      const cw = w / cols;
      const spc = Math.floor(data.length / cols) || 1;
      for (let i = 0; i < cols; i++) {
        let peak = 0;
        const base = i * spc;
        for (let jj = 0; jj < spc; jj += 64) {
          const v = Math.abs(data[base + jj] || 0);
          if (v > peak) peak = v;
        }
        const bh = Math.max(dpr, peak * (h - 8 * dpr));
        g.fillRect(i * cw, (h - bh) / 2, Math.max(1, cw - 1), bh);
      }
      const p = curPos();
      if (p != null) {
        g.fillStyle = "#4a7c59";
        g.fillRect(p / dur * w - 1.5 * dpr, 0, 3 * dpr, h);
      }
      if (sel) {
        g.fillStyle = "#a34a24";
        g.fillRect(sel.a / dur * w - dpr, 0, 2 * dpr, h);
        g.fillRect(sel.b / dur * w - dpr, 0, 2 * dpr, h);
      }
    }
    function huntAnim() {
      drawHunt();
      if (playing) requestAnimationFrame(huntAnim);
    }
    const huntC = q("canvas.hunt", el);
    let dragA = null;
    const evT = ev => {
      const r = huntC.getBoundingClientRect();
      return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * (waveBuf ? waveBuf.duration : 0);
    };
    huntC.addEventListener("pointerdown", ev => {
      if (!waveBuf) return;
      ev.preventDefault();
      try { huntC.setPointerCapture(ev.pointerId); } catch (e) {}
      dragA = evT(ev);
    });
    huntC.addEventListener("pointermove", ev => {
      if (dragA == null || !waveBuf) return;
      const t = evT(ev);
      if (Math.abs(t - dragA) > 0.15) {
        sel = { a: Math.min(dragA, t), b: Math.max(dragA, t) };
        drawHunt();
        syncHunt();
      }
    });
    huntC.addEventListener("pointerup", ev => {
      if (dragA == null || !waveBuf) return;
      const t = evT(ev);
      const wasDrag = Math.abs(t - dragA) > 0.15;
      dragA = null;
      if (wasDrag) {
        if (playing) beginPlayback(sel.a);
        drawHunt();
        syncHunt();
        return;
      }
      if (playing) beginPlayback(t);
      else { sel = null; drawHunt(); syncHunt(); }
    });
    q("[data-a=savesel]", el).addEventListener("click", async () => {
      if (!sel) return;
      const fname = tracks[ti].file.split("/").pop();
      try {
        await fetch("/api/source/loop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: fname, start: sel.a, end: sel.b }),
        });
        loopSaved = { start: sel.a, end: sel.b };
        sel = null;
        drawHunt();
        syncHunt();
        q("[data-v=hunt]", el).textContent =
          "passagem salva: this deck, the crate, the engine and the blends all use it now";
      } catch (e) { q("[data-v=hunt]", el).textContent = "could not save the passage"; }
    });
    q("[data-a=clearsel]", el).addEventListener("click", async () => {
      sel = null;
      if (loopSaved && loopSaved.end) {
        const fname = tracks[ti].file.split("/").pop();
        try {
          await fetch("/api/source/loop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: fname, start: 0, end: null }),
          });
        } catch (e) {}
        loopSaved = null;
      }
      if (playing) beginPlayback(null);
      drawHunt();
      syncHunt();
    });

    q("[data-a=play]", el).addEventListener("click", async () => {
      if (playing) { stop(); return; }
      claim("voz", stop);
      if (!waveBuf) {
        q("[data-v=load]", el).textContent = "loading preview ...";
        await loadWave();
        q("[data-v=load]", el).textContent = "";
      }
      if (!waveBuf) { release(stop); checkStem(); return; }
      beginPlayback(null);
      if (running.size >= 2) emit("voz-float");
    });
    q("[data-a=match]", el).addEventListener("click", () => { matched = !matched; applyRate(); });
    q("[data-k=track]", el).addEventListener("change", e => {
      ti = +e.target.value;
      if (playing) stop();
      applyRate();
      checkStem();
      loadWave();
    });
    q("[data-k=stem]", el).addEventListener("change", e => {
      stemSel = e.target.value;
      if (playing) stop();
      checkStem();
      loadWave();
    });
    q("[data-a=sep]", el).addEventListener("click", async ev => {
      ev.target.disabled = true;
      ev.target.textContent = "separando ...";
      const fname = tracks[ti].file.split("/").pop();
      try {
        const r = await fetch("/api/source/stems", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: fname }),
        });
        if (!r.ok) throw new Error((await r.json()).detail);
      } catch (e) {
        ev.target.disabled = false;
        ev.target.textContent = "separar camadas";
        q("[data-v=sep]", el).textContent = "could not start the separation: " + e.message;
        return;
      }
      while (true) {
        await new Promise(r2 => setTimeout(r2, 3000));
        let jobs = [];
        try { jobs = await (await fetch("/api/jobs")).json(); } catch (e) { break; }
        const j = jobs[jobs.length - 1];
        if (!j || j.status === "running") {
          q("[data-v=sep]", el).textContent =
            "demucs is splitting the track into voice, drums, bass and the rest on the plant's gpu ...";
          continue;
        }
        if (j.status === "done") {
          diario("camadas separadas: " + nameOf(tracks[ti].file));
          q("[data-v=sep]", el).textContent = "camadas prontas: press play";
          loadWave();
        } else {
          q("[data-v=sep]", el).textContent = "separation failed: check the pressing plant console";
        }
        break;
      }
      ev.target.disabled = false;
      ev.target.textContent = "separar camadas";
      checkStem();
    });
    q("[data-k=gain]", el).addEventListener("input", e => {
      gainV = +e.target.value;
      q("[data-v=gain]", el).textContent = gainV.toFixed(2);
      if (nodes) nodes.g.gain.setTargetAtTime(gainV, AC().currentTime, 0.02);
    });
    q("[data-k=hp]", el).addEventListener("input", e => {
      hpHz = Math.round(toLog(+e.target.value, 40, 2000));
      q("[data-v=hp]", el).textContent = hpHz;
      if (nodes) nodes.hp.frequency.setTargetAtTime(hpHz, AC().currentTime, 0.02);
    });
    MOD.voz = {
      get: () => ({ file: tracks[ti].file, gain: gainV, hp: hpHz, matched, stem: stemSel }),
      set(st) {
        if (st.file) {
          const want = st.file.split("/").pop();
          const idx = tracks.findIndex(a => a.file.split("/").pop() === want);
          if (idx >= 0) { ti = idx; q("[data-k=track]", el).value = idx; }
        }
        stemSel = st.stem || "";
        q("[data-k=stem]", el).value = stemSel;
        checkStem();
        if (st.gain != null) {
          gainV = st.gain;
          q("[data-k=gain]", el).value = gainV;
          q("[data-v=gain]", el).textContent = gainV.toFixed(2);
          if (nodes) nodes.g.gain.value = gainV;
        }
        if (st.hp != null) {
          hpHz = st.hp;
          q("[data-k=hp]", el).value = fromLog(hpHz, 40, 2000);
          q("[data-v=hp]", el).textContent = hpHz;
          if (nodes) nodes.hp.frequency.value = hpHz;
        }
        matched = !!st.matched;
        applyRate();
        loadWave();
      },
      setTempo() { if (matched) applyRate(); },
      sync() { matched = true; applyRate(); },
    };
    applyRate();
    checkStem();
    loadWave();
  }

  /* ================= 09 O Controlador: the virtual midi board ================= */

  let _ctlKb = null;   /* previous build's pad-key + pointer handlers */
  function buildController(el) {
    el.innerHTML = `
      <div class="pads"></div>
      <div class="esc-controls">
        <label title="the mod wheel, CC1: rides the synth's filter cutoff live. A hardware mod wheel lands on this exact control">mod / cutoff
          <input type="range" min="0" max="100" value="35" data-k="mod" class="mod-strip"></label>
        <span class="side-note">pads: click LOW for a hard hit, HIGH for soft &middot;
          <b>C V B N M ,</b> play them from the keyboard &middot; drag across the keybed
          below for glissando into O Sintetizador</span>
      </div>
      <div class="ctl-keys"></div>`;
    const PADS = [["kick", "kick", "KeyC", "C"], ["sub", "sub", "KeyV", "V"],
                  ["hat", "cl hat", "KeyB", "B"], ["ohat", "op hat", "KeyN", "N"],
                  ["rim", "rim", "KeyM", "M"], ["shaker", "shaker", "Comma", ","]];
    const padsEl = q(".pads", el);
    padsEl.innerHTML = PADS.map(([k, lab, , hint]) =>
      `<button type="button" class="pad" data-pad="${k}">
        <span class="kb-hint">${hint}</span>${lab}</button>`).join("");
    function padHit(name, vel) {
      const ctx = AC(); ctx.resume();
      DRUMS[name](ctx.currentTime, vel, CHAN("controlador"));
      const p = q(`.pad[data-pad="${name}"]`, el);
      if (p) { p.classList.add("hit"); setTimeout(() => p.classList.remove("hit"), 120); }
    }
    qa(".pad", padsEl).forEach(p => p.addEventListener("pointerdown", ev => {
      ev.preventDefault();
      const r = p.getBoundingClientRect();
      padHit(p.dataset.pad, 0.5 + 0.5 * Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
    }));

    /* two octaves, C2 to C4, mono glissando straight into the synth's midi sink */
    const K0 = 36, NK = 25;
    const isBlack = n => [1, 3, 6, 8, 10].includes(n % 12);
    const kb = q(".ctl-keys", el);
    kb.innerHTML = Array.from({ length: NK }, (_, i) =>
      `<button type="button" class="ctl-key${isBlack(K0 + i) ? " black" : ""}" data-n="${K0 + i}"></button>`).join("");
    let dragging = false;
    function press(b, ev) {
      if (!_midiTarget) ensureBuilt(1);
      if (!_midiTarget) return;
      const r = b.getBoundingClientRect();
      const vel = 0.45 + 0.55 * Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
      _midiTarget.on(+b.dataset.n, vel);
      b.classList.add("held");
    }
    function liftAll() {
      qa(".ctl-key.held", kb).forEach(b => {
        if (_midiTarget) _midiTarget.off(+b.dataset.n);
        b.classList.remove("held");
      });
    }
    kb.addEventListener("pointerdown", ev => {
      const b = ev.target.closest(".ctl-key");
      if (!b) return;
      ev.preventDefault();
      if (b.releasePointerCapture) { try { b.releasePointerCapture(ev.pointerId); } catch (e) {} }
      dragging = true;
      press(b, ev);
    });
    kb.addEventListener("pointermove", ev => {
      if (!dragging) return;
      const at = document.elementFromPoint(ev.clientX, ev.clientY);
      const b = at && at.closest ? at.closest(".ctl-key") : null;
      if (!b || b.classList.contains("held")) return;
      liftAll();
      press(b, ev);
    });
    const ptrUp = () => { if (dragging) { dragging = false; liftAll(); } };
    function padKeys(e) {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.matches("input, select, textarea") || e.target.isContentEditable) return;
      const hit = PADS.find(([, , code]) => code === e.code);
      if (!hit) return;
      e.preventDefault();
      padHit(hit[0], 0.9);
    }
    if (_ctlKb) {
      document.removeEventListener("keydown", _ctlKb.d);
      window.removeEventListener("pointerup", _ctlKb.u);
    }
    _ctlKb = { d: padKeys, u: ptrUp };
    document.addEventListener("keydown", padKeys);
    window.addEventListener("pointerup", ptrUp);

    q("[data-k=mod]", el).addEventListener("input", e => {
      if (!_midiTarget) ensureBuilt(1);
      if (_midiTarget && _midiTarget.cc) _midiTarget.cc(1, +e.target.value / 100);
    });
  }

  /* ================= 10 O Loop: the phrase looper ================= */

  let _loopSp = null;   /* previous build's tap, disconnected on rebuild */
  function buildLooper(el) {
    el.innerHTML = `
      <div class="esc-controls">
        <button class="ghost" data-a="rec" title="punch in, play a phrase, punch out: the take rounds to whole bars and loops on the grid (shift+L)">gravar loop</button>
        <button class="ghost" data-a="dub" hidden title="overdub: records one full cycle starting now, wrapping around the loop's seam">sobrepor</button>
        <button class="ghost" data-a="play" hidden>parar</button>
        <button class="ghost" data-a="clear" hidden>x limpar</button>
        <label title="the loop's own playback level under whatever you play on top">level <b data-v="lv">0.90</b>
          <input type="range" min="0" max="1" step="0.05" value="0.9" data-k="lv"></label>
        <span class="side-note" data-v="st">vazio: play the synth or the controlador and this catches it</span>
      </div>
      <p class="side-note esc-note">a pedal looper for everything you play. Gravar, play a phrase,
        fechar: the length rounds to whole bars at the mesa tempo and drops onto the grid.
        Sobrepor layers another pass, wrapping around the seam. Shift+L punches gravar/fechar.</p>`;
    const barDur = () => 60 / TR.bpm * 4;
    let sp = null, chunksL = null, chunksR = null, recT0 = 0, recTimer = null,
        loop = null, dubbing = null;
    const setSt = txt => { q("[data-v=st]", el).innerHTML = txt; };
    const barsWord = b => `${b} ${b === 1 ? "compasso" : "compassos"}`;

    function tap() {
      if (sp) return;
      const ctx = AC();
      if (_loopSp) {
        try { CHAN("sintetizador").disconnect(_loopSp); } catch (e) {}
        try { CHAN("controlador").disconnect(_loopSp); } catch (e) {}
        try { _loopSp.disconnect(); } catch (e) {}
      }
      sp = ctx.createScriptProcessor(4096, 2, 2);
      _loopSp = sp;
      const sink = ctx.createGain(); sink.gain.value = 0;
      CHAN("sintetizador").connect(sp);
      CHAN("controlador").connect(sp);
      sp.connect(sink).connect(ctx.destination);
      sp.onaudioprocess = onChunk;
    }
    function onChunk(e) {
      const inL = e.inputBuffer.getChannelData(0), inR = e.inputBuffer.getChannelData(1);
      if (chunksL) {
        chunksL.push(new Float32Array(inL));
        chunksR.push(new Float32Array(inR));
        if (chunksL.length * 4096 > AC().sampleRate * 60) closeLoop();   /* 60 s cap */
      } else if (dubbing && loop) {
        const t = e.playbackTime !== undefined ? e.playbackTime : AC().currentTime;
        const total = loop.buf.length, sr = AC().sampleRate;
        let pos = Math.round((((t - loop.startT) % loop.dur) + loop.dur) % loop.dur * sr) % total;
        for (let i = 0; i < inL.length; i++) {
          loop.mixL[(pos + i) % total] += inL[i];
          loop.mixR[(pos + i) % total] += inR[i];
        }
        dubbing.n += inL.length;
        if (dubbing.n >= total) finishDub();
      }
    }
    function startSrc(at) {
      const ctx = AC();
      const src = ctx.createBufferSource();
      src.buffer = loop.buf;
      src.loop = true;
      src.playbackRate.value = loop.rate;
      src.connect(loop.gain);
      src.start(at);
      loop.src = src;
      loop.startT = at;
      loop.playing = true;
    }
    function stopLoop() {
      if (loop && loop.src) { try { loop.src.stop(); } catch (e) {} loop.src = null; }
      if (loop) loop.playing = false;
      dubbing = null;
      release(stopLoop);
      syncBtns();
    }
    function startRecLoop() {
      const ctx = AC(); ctx.resume();
      tap();
      if (loop) clearLoop();
      chunksL = []; chunksR = [];
      recT0 = ctx.currentTime;
      q("[data-a=rec]", el).textContent = "fechar loop";
      recTimer = setInterval(() => {
        if (!chunksL) return;
        setSt(`gravando: ${barsWord(Math.max(1, Math.round((AC().currentTime - recT0) / barDur())))} ...`);
      }, 250);
      setSt("gravando ...");
    }
    function closeLoop() {
      const ctx = AC();
      clearInterval(recTimer);
      const bars = Math.min(16, Math.max(1, Math.round((ctx.currentTime - recT0) / barDur())));
      const n = Math.round(bars * barDur() * ctx.sampleRate);
      const buf = ctx.createBuffer(2, n, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const dst = buf.getChannelData(ch), src2 = ch ? chunksR : chunksL;
        let o = 0;
        for (const c of src2) {
          for (let i = 0; i < c.length && o < n; i++, o++) dst[o] = c[i];
          if (o >= n) break;
        }
      }
      chunksL = chunksR = null;
      const gain = ctx.createGain();
      gain.gain.value = +q("[data-k=lv]", el).value;
      gain.connect(CHAN("loop"));
      loop = { buf, bars, dur: bars * barDur(), recBpm: TR.bpm, gain, rate: 1,
               src: null, startT: 0, playing: false, mixL: null, mixR: null };
      claim("loop", stopLoop);
      startSrc(trAlign(barDur()).t);
      q("[data-a=rec]", el).textContent = "gravar loop";
      setSt(`looping ${barsWord(bars)}, locked to the grid`);
      syncBtns();
    }
    function startDub() {
      if (!loop || !loop.playing || loop.rate !== 1 || dubbing) return;
      AC().resume();
      tap();
      loop.mixL = new Float32Array(loop.buf.getChannelData(0));
      loop.mixR = new Float32Array(loop.buf.getChannelData(1));
      dubbing = { n: 0 };
      q("[data-a=dub]", el).disabled = true;
      q("[data-a=dub]", el).textContent = "gravando volta ...";
      setSt("sobrepondo: play, it wraps around the loop for one full cycle");
    }
    function finishDub() {
      const ctx = AC();
      const nb = ctx.createBuffer(2, loop.buf.length, ctx.sampleRate);
      nb.copyToChannel(loop.mixL, 0);
      nb.copyToChannel(loop.mixR, 1);
      loop.mixL = loop.mixR = null;
      dubbing = null;
      const k = Math.ceil((ctx.currentTime + 0.05 - loop.startT) / loop.dur);
      const tSwap = loop.startT + k * loop.dur;
      const old = loop.src;
      loop.buf = nb;
      startSrc(tSwap);
      try { old.stop(tSwap); } catch (e) {}
      q("[data-a=dub]", el).disabled = false;
      q("[data-a=dub]", el).textContent = "sobrepor";
      setSt(`looping ${barsWord(loop.bars)}, one more layer pressed in`);
    }
    function clearLoop() {
      stopLoop();
      loop = null;
      setSt("vazio: play the synth or the controlador and this catches it");
      syncBtns();
    }
    function syncBtns() {
      q("[data-a=dub]", el).hidden = !(loop && loop.playing && loop.rate === 1);
      q("[data-a=play]", el).hidden = !loop;
      q("[data-a=play]", el).textContent = loop && loop.playing ? "parar" : "tocar";
      q("[data-a=clear]", el).hidden = !loop;
    }
    q("[data-a=rec]", el).addEventListener("click", () => {
      if (chunksL) closeLoop(); else startRecLoop();
    });
    q("[data-a=dub]", el).addEventListener("click", startDub);
    q("[data-a=play]", el).addEventListener("click", () => {
      if (!loop) return;
      if (loop.playing) stopLoop();
      else {
        claim("loop", stopLoop);
        startSrc(trAlign(barDur()).t);
        setSt(`looping ${barsWord(loop.bars)}${loop.rate !== 1 ? ", repitched" : ""}`);
      }
      syncBtns();
    });
    q("[data-a=clear]", el).addEventListener("click", clearLoop);
    q("[data-k=lv]", el).addEventListener("input", e => {
      q("[data-v=lv]", el).textContent = (+e.target.value).toFixed(2);
      if (loop) loop.gain.gain.value = +e.target.value;
    });
    MOD.loop = {
      setTempo(v) {
        if (!loop) return;
        loop.rate = v / loop.recBpm;
        if (loop.src) loop.src.playbackRate.value = loop.rate;
        if (loop.playing) setSt(`looping ${barsWord(loop.bars)}${loop.rate !== 1
          ? `, repitched to ${v} BPM like vinyl (back to ${loop.recBpm} to sobrepor)` : ""}`);
        syncBtns();
      },
    };
  }

  /* ================= the ten lessons ================= */

  const LESSONS = [
    { no: "01", title: "A Grade", tag: "ritmo", build: buildSeq,
      sub: "program the grooves the frames are made of",
      intro: `Everything rhythmic on this site lives on a step grid: sixteen cells per bar,
        four per beat (the 6/8 preset uses twelve, three per beat). Tap a cell for a hit,
        tap again for an accent, a third time to clear. Start a preset, then bend it while it runs.`,
      notes: [
        `<b>swing</b> delays every second cell. Zero is a rigid machine, around 0.15 it starts
         to roll, past 0.4 it limps. The swing knob in every frame's mixer multiplies exactly this.`,
        `<b>velocity is the groove.</b> Load rolling wave: the hats play all sixteen steps and only
         the accents move. That loud-soft wave, not the note placement, is the Mulero-school pull.`,
        `<b>tresillo</b> is 3+3+2. Count it out loud: baiao rides it, and so does most dance
         music since New Orleans.`,
        `<b>the 6/8 grid</b> has three cells per beat instead of four. That is the whole secret of
         frame 7: candomble material locks onto it without warping its feel.`,
      ],
      lab: "open any mixer and push the swing knob; press blend 7 and count its grid in threes." },
    { no: "02", title: "O Sintetizador", tag: "sintese", build: buildSynth,
      sub: "one oscillator chain explains every bed layer",
      intro: `Subtractive synthesis in one sentence: start with something rich, carve it with a
        filter, move everything with envelopes. This is the entire recipe behind the drones, stabs,
        subs and rumbles in the frames. Hold a key (or latch) and sculpt.`,
      notes: [
        `<b>cutoff is the dark/light axis.</b> The drone lp knob on frames 1, 4 and 7 is this
         exact control.`,
        `<b>resonance</b> boosts the edge right at the cutoff. Push it past 10, hold a note and
         sweep the cutoff: that whistle is the acid sound.`,
        `<b>the filter envelope</b> kicks the filter open for an instant on each note. Short decay
         plus a big amount is a stab; zero amount is a pad.`,
        `<b>the drone preset stacks a root and a fifth, no third.</b> A third would commit to major
         or minor and fight whatever modal Brazilian source sits on top. That rule is why the beds
         never argue with the crate.`,
        `<b>the rumble preset is noise through a nearly closed filter.</b> The rumble layer under
         every kick here is the same trick, shaped by the kick's sidechain.`,
      ],
      lab: "frame knobs: drone lp and stab feedback; the mixer's hp/lp sliders are these same filters, live." },
    { no: "03", title: "A Roda", tag: "harmonia", build: buildWheel,
      sub: "your crate plotted on the wheel of keys",
      intro: `Every tonal track has a center of gravity: its key. The wheel (DJs call it Camelot)
        arranges all 24 keys so that neighbours share almost all their notes. The dots are your
        crate, placed by detected key. Tap two slots, or two tracks, and listen to the interval
        they make.`,
      notes: [
        `<b>three safe moves:</b> one step around the wheel (a perfect fifth), swapping inner and
         outer ring on the same number (relative major/minor), or staying put.`,
        `<b>a semitone apart sounds like a mistake, a tritone like a threat.</b> Both are real
         tools, but know which one you are holding.`,
        `<b>key clarity matters as much as key.</b> A berimbau or a drum choir barely has a key.
         Faded dots are low-confidence keys: treat those tracks as texture and mix them anywhere.`,
      ],
      lab: "the crate table's key column and the engine's key clarity term are this lesson applied." },
    { no: "04", title: "O Warp", tag: "tempo", build: buildWarp,
      sub: "the half-time trick, with the real numbers",
      intro: `Warping is a ratio: the tempo you want divided by the tempo the track has. Small
        ratios are invisible, big ones change the material. The escape hatch this whole site runs
        on: you can also aim at half or double the target and let the source ride across two bars.
        Pick a track, move the target, audition each plan.`,
      notes: [
        `<b>under 6 percent</b> stretch is a pitch-fader move, nobody hears it. <b>Past 13
         percent</b> the material audibly changes character. The engine's tempo cost uses these
         same lines.`,
        `<b>half time is free real estate:</b> a 70 BPM zabumba refuses 140 straight (+100 percent)
         but in half time it asks for nothing. Blends 5 and 6 are flagged precisely because their
         sources sit near 95, not 70: the known fix is a slower take.`,
        `<b>this demo repitches</b> like a turntable: speed and pitch move together (hear the
         semitones). The pressing engine time-stretches instead, keeping pitch. Toggle repitch in
         any mixer to compare on a real press.`,
      ],
      lab: "the crate's half / 2x column and every engine plan line are this widget, precomputed." },
    { no: "05", title: "O Pulso", tag: "dj", build: buildPulso,
      sub: "beatmatch by ear, the eternal drill",
      intro: `Two decks. Deck A holds 132. Deck B starts a few percent off and the offset is
        hidden. Lock them using only the pitch fader (speed) and the nudges (phase). The lights
        and the phase bar are training wheels: graduate to eyes closed.`,
      notes: [
        `<b>the fader fixes tempo, the nudge fixes phase.</b> If the gap keeps growing it is a
         tempo problem: touch the fader. If the gap is steady, one push or drag settles it.`,
        `<b>a 0.2 percent tempo error drifts audibly within one phrase.</b> That is why the lock
         needs both conditions, and why DJs keep a finger near the platter.`,
        `<b>count in fours.</b> The flam you hear when the kicks almost coincide is the classic
         sound of nearly there.`,
      ],
      lab: "reveal shows deck B's true tempo when you give up; new round hides a fresh offset." },
    { no: "06", title: "O Duck", tag: "mix", build: buildDuck,
      sub: "the sidechain, techno's breathing",
      intro: `Everything that is not the kick dips the instant the kick hits, then recovers. That
        pumping is sidechain ducking, and it is most of why a techno mix feels alive and why kick
        and bass never fight. Start it, then pull the kick out and listen to its ghost still
        breathing in the drone.`,
      notes: [
        `<b>depth</b> is how far everything dives, <b>release</b> is how fast it climbs back.
         Fast release pumps; slow release just makes things quieter.`,
        `<b>kick and bass share 40 to 100 Hz.</b> Ducking clears that shelf 130 times a minute
         instead of an EQ doing it permanently.`,
        `<b>the mixer's duck sliders are this exact envelope</b>, applied live per layer in your
         browser, and baked the same way on a press.`,
      ],
      lab: "open any mixer, play the mix, and ride a layer's duck slider while it runs." },
    { no: "07", title: "As Bandas", tag: "mix", build: buildEq,
      sub: "three bands, a spectrum, and the bass swap",
      intro: `A DJ mixer gives you three knobs per channel: low, mid, high. Pick a crate track,
        watch its spectrum, and learn what lives where by killing bands. Then practice the oldest
        rule in mixing: never two basslines at once.`,
      notes: [
        `<b>low is below 200 Hz:</b> kick, sub, zabumba weight. <b>mid is 200 Hz to 4 kHz:</b>
         voices, berimbau, guitars, almost all the music. <b>high is above 4 kHz:</b> hats,
         chiado, air.`,
        `<b>the bass swap:</b> on a transition, kill the incoming track's low, bring the rest in,
         and on one phrase boundary swap the two lows in a single move.`,
        `<b>every frame already leaves a hole:</b> frame 2 keeps 150 to 600 Hz empty for the
         berimbau, frame 4 leaves the mids open for a voice. EQ is how you keep that hole open
         when a source misbehaves.`,
      ],
      lab: "the hp and lp sliders on every mixer layer are surgical versions of these three knobs." },
    { no: "08", title: "A Voz", tag: "voz", build: buildVoz,
      sub: "float a voice, or any separated camada, over the machine",
      intro: `The oldest Brasil x maquina move there is: a voice floating over a relentless
        groove. Pick a channel from the crate, choose a camada (the whole track, or just its
        voice, its percussion, its bass, or the strings and keys), loop it over whatever else
        is running on the mesa, and carve it until it sits.`,
      notes: [
        `<b>the camada picker is real isolation.</b> Demucs splits any crate track into voice,
         drums, bass and the rest, on the plant's gpu in about twenty seconds, cached for good;
         the blends' stem mixers use the exact same split.`,
        `<b>the high-pass is the seat.</b> A whole track carries its own bass and drums; cut
         everything below 150 to 300 Hz, or just pick the vocal camada and skip the fight.`,
        `<b>bpm match warps the channel to the mesa tempo</b> with the same straight, half and
         double plans as O Warp, and the same honesty: under 6 percent nobody hears it.`,
        `<b>some voices should not be matched.</b> Rubato singing fights any grid; leave it
         unmatched and let it float free, exactly what the engine does with rubato sources.`,
      ],
      lab: "pick Elza's vocal camada, drag the wave until you find the hook, salvar passagem, then loop it over A Grade's tresillo; swap the camada to so a percussao and the same passage becomes a drum break." },
    { no: "09", title: "O Controlador", tag: "midi", build: buildController,
      sub: "a virtual controller: pads, two octaves, a mod strip",
      intro: `No hardware? This is the controller. Six drum pads (the exact voices A Grade
        sequences), a two octave keybed with glissando that plays O Sintetizador, and a mod
        strip riding the filter. A real midi controller plugs into the same wiring: hit
        midi in the AO VIVO strip and it lands on the same synth, same velocity, same CC1.`,
      notes: [
        `<b>velocity lives in the click.</b> Hit a pad or a key LOW for a hard strike, HIGH
         for a soft one: the same axis a finger brings to a real pad.`,
        `<b>drag across the keybed for glissando.</b> The mono voice steals from note to note
         the way a 303 slides; with the acid patch loaded it is instantly that sound.`,
        `<b>the mod strip is CC1.</b> It rides the synth's cutoff live, and a hardware mod
         wheel lands on exactly the same control.`,
        `<b>machines keep time, hands bring drift.</b> That tension is the groove: quantized
         pads are A Grade's job, this surface is for playing.`,
      ],
      lab: "run A Grade with its shaker row cleared, then play the shaker pad by hand over the top: the drift between your hand and the grid is what samba calls balanco." },
    { no: "10", title: "O Loop", tag: "loop", build: buildLooper,
      sub: "a pedal looper for everything you play",
      intro: `The looper catches what you PLAY (the synth and the controlador, from any keybed:
        computer, virtual or midi) and turns it into a bar-locked phrase. Gravar, play a line,
        fechar: the mesa rounds it to whole bars and drops it onto the grid, on its own killable
        channel. Then play over yourself.`,
      notes: [
        `<b>close early, close late, it still locks.</b> The length rounds to the nearest whole
         bar at the mesa tempo, so a sloppy punch-out stays in time.`,
        `<b>sobrepor wraps.</b> The overdub starts the moment you press, lands wherever the loop
         happens to be, and wraps around the seam for exactly one cycle: the classic pedal trick
         for building a riff one note per pass.`,
        `<b>tempo changes repitch the loop like vinyl.</b> Slow the mesa and the phrase drops
         with it, pitch and all. Return to the recorded tempo to overdub again.`,
        `<b>loops are performance, not files.</b> They live until you clear or reset them:
         record the mesa in the AO VIVO strip to press one into a wav.`,
      ],
      lab: "record a one bar bassline, loop it, then solo over the top an octave up (Z X shift fast); kill the loop channel in the strip for a break, revive it for the drop." },
  ];

  /* ================= O Percurso: the gamified path ================= */

  const LEVELS = [
    { name: "Nivel 1 · Ouvinte", cps: [
      { id: "o1", title: "toca-discos", desc: "play any blend or bed in Lado A", auto: "app-play", goto: "#blends" },
      { id: "o2", title: "duas fontes", desc: "judge any pair of keys on the wheel", auto: "wheel-pair", goto: "aula:2" },
      { id: "o3", title: "raio-x", desc: "watch a crate track's spectrum in As Bandas", auto: "eq-play", goto: "aula:6" },
    ], provas: [
      { id: "pv-duck", title: "o pulmao", desc: "blind test in O Duck: breathing or flat, 3 in a row", auto: "prova-duck", goto: "aula:5" },
      { id: "pv-eq", title: "banda cega", desc: "blind test in As Bandas: name the killed band, 3 in a row", auto: "prova-eq", goto: "aula:6" },
    ] },
    { name: "Nivel 2 · Ritmista", cps: [
      { id: "r1", title: "quatro no chao", desc: "run any groove in A Grade", auto: "seq-play", goto: "aula:0" },
      { id: "r2", title: "gingado", desc: "push swing past 0.25 while the grid runs", auto: "seq-swing", goto: "aula:0" },
      { id: "r3", title: "autoral", desc: "edit the cells, then play your own pattern", auto: "seq-own", goto: "aula:0" },
    ], provas: [
      { id: "pv-tresillo", title: "tresillo de cor", desc: "in A Grade, rebuild the 3+3+2 kick from the empty 16 grid, by memory", auto: "prova-tresillo", goto: "aula:0" },
      { id: "pv-clave", title: "seis por oito", desc: "from the empty 12 grid: kicks on the four beats, rims in the gaps", auto: "prova-clave", goto: "aula:0" },
    ] },
    { name: "Nivel 3 · Sintesista", cps: [
      { id: "s1", title: "primeira nota", desc: "play a note on the synth", auto: "synth-note", goto: "aula:1" },
      { id: "s2", title: "acido", desc: "load the acid preset and play it", auto: "synth-acid", goto: "aula:1" },
      { id: "s3", title: "drone da casa", desc: "latch the drone preset: root and fifth, no third", auto: "synth-drone", goto: "aula:1" },
    ], provas: [
      { id: "pv-acid", title: "acido a mao", desc: "dial acid without the preset: resonance past 10, env past 2000, snappy decay, instant attack, then play", auto: "prova-acid", goto: "aula:1" },
      { id: "pv-drone", title: "drone a mao", desc: "build the house drone without the preset: fifth up, zero filter env, slow attack, cutoff under 700, some lfo, latch on", auto: "prova-drone", goto: "aula:1" },
    ] },
    { name: "Nivel 4 · Operador", cps: [
      { id: "p1", title: "o fantasma", desc: "mute the kick in O Duck and hear the pumping alone", auto: "duck-ghost", goto: "aula:5" },
      { id: "p2", title: "corte seco", desc: "kill the low band while a track plays", auto: "eq-kill", goto: "aula:6" },
      { id: "p3", title: "meio tempo", desc: "audition a half or double time plan in O Warp", auto: "warp-half", goto: "aula:3" },
    ], provas: [
      { id: "pv-warp", title: "o plano", desc: "quiz in O Warp: pick the cheapest plan for 4 pairings in a row", auto: "prova-warp", goto: "aula:3" },
      { id: "pv-roda", title: "a volta segura", desc: "quiz in A Roda: tap a safe destination 4 times in a row", auto: "prova-roda", goto: "aula:2" },
    ] },
    { name: "Nivel 5 · DJ", cps: [
      { id: "d1", title: "harmonico", desc: "land a safe move on the wheel: a fifth or a relative", auto: "wheel-safe", goto: "aula:2" },
      { id: "d2", title: "prensagem", desc: "press a blend, or audition a pairing from the Engine", auto: "app-press", goto: "#engine" },
      { id: "d3", title: "travado", desc: "earn the LOCKED stamp in O Pulso", auto: "pulso-lock", goto: "aula:4" },
    ], provas: [
      { id: "pv-pulso", title: "as cegas", desc: "earn LOCKED with reveal off for the whole round", auto: "prova-pulso", goto: "aula:4" },
    ] },
    { name: "Nivel 6 · Produtor", cps: [
      { id: "j1", title: "duas maquinas", desc: "two modules sounding at once: leave one running, start another", auto: "jam-duo", goto: "#mesa" },
      { id: "j2", title: "a voz por cima", desc: "float a vocal channel while another module runs", auto: "voz-float", goto: "aula:7" },
      { id: "j3", title: "prensagem propria", desc: "name and press a session at the mesa", auto: "press-save", goto: "#mesa" },
      { id: "j4", title: "master", desc: "record the mesa and keep the wav: download it or archive it", auto: "rec-save", goto: "#mesa" },
    ], provas: [
      { id: "pv-sessao", title: "a sessao", desc: "record 20 seconds with two or more modules live at the same time", auto: "prova-sessao", goto: "#mesa" },
    ] },
  ];
  const CARIMBOS = LEVELS.flatMap(l => l.cps);
  const PROVAS = LEVELS.flatMap(l => l.provas);
  const ALL_CPS = CARIMBOS.concat(PROVAS);
  const PROG_KEY = "escola_progress";
  let progress = {};
  try { progress = JSON.parse(localStorage.getItem(PROG_KEY) || "{}"); } catch (e) {}

  function toast(cp) {
    const t = document.createElement("div");
    t.className = "perc-toast";
    t.style.bottom = `${18 + qa(".perc-toast").length * 48}px`;
    t.innerHTML = `carimbado &middot; <b>${cp.title}</b>`;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 500); }, 2800);
  }
  window.escolaEmit = function (ev) {
    let hit = false;
    for (const cp of ALL_CPS) {
      if (cp.auto === ev && !progress[cp.id]) {
        progress[cp.id] = Date.now();
        hit = true;
        toast(cp);
        diario((cp.id.startsWith("pv-") ? "aprovado: " : "carimbado: ") + cp.title);
      }
    }
    if (hit) {
      try { localStorage.setItem(PROG_KEY, JSON.stringify(progress)); } catch (e) {}
      renderPercurso();
      renderTeaser();
    }
  };

  /* compact progress chip for the main page (full percurso lives on /escola) */
  function renderTeaser() {
    const el = q("#escola-teaser");
    if (!el) return;
    const dc = CARIMBOS.filter(c => progress[c.id]).length;
    const dp = PROVAS.filter(c => progress[c.id]).length;
    el.innerHTML = `<a class="esc-teaser" href="/mesa">
      <span class="perc-count">${dc}/${CARIMBOS.length} carimbos &middot; ${dp}/${PROVAS.length} provas</span>
      <span class="perc-groove teaser-groove"><span class="perc-fill"
        style="width:${Math.round((dc + dp) / ALL_CPS.length * 100)}%"></span></span>
      <span class="side-note">${dc + dp === 0 ? "fresh vinyl, nothing stamped yet: start the percurso"
        : dc + dp === ALL_CPS.length ? "diploma de ouro on the wall" : "continue the percurso"} &rarr;</span>
    </a>`;
  }

  function openLesson(i) {
    const st = q(`.station[data-mod="${i}"]`);
    if (!st) return;
    const panel = st.closest(".mesa-panel");
    if (panel && !panel.classList.contains("active")) setTab(panel.dataset.panel);
    st.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function renderPercurso() {
    const el = q("#percurso");
    if (!el) return;
    const doneC = CARIMBOS.filter(cp => progress[cp.id]).length;
    const doneP = PROVAS.filter(cp => progress[cp.id]).length;
    const pct = Math.round((doneC + doneP) / ALL_CPS.length * 100);
    const cpRow = cp => `
      <button type="button" class="perc-cp${progress[cp.id] ? " done" : ""}" data-goto="${cp.goto}"
        title="${progress[cp.id] ? "earned" : "tap to go where this is earned"}">
        <span class="perc-dot"></span>
        <span class="perc-cp-text"><b>${cp.title}</b> ${cp.desc}</span>
      </button>`;
    const pvRow = cp => `
      <button type="button" class="perc-cp prova${progress[cp.id] ? " done" : ""}" data-goto="${cp.goto}"
        title="${progress[cp.id] ? "passed" : "a prova: the page verifies it, tap to go try"}">
        <span class="perc-dot"></span>
        <span class="perc-cp-text"><b>${cp.title}</b> ${cp.desc}</span>
      </button>`;
    el.innerHTML = `
      <div class="perc-head">
        <h3>O Percurso</h3>
        <span class="side-note"><b>carimbos</b> are stamped for doing; <b>provas</b> are graded:
          the page itself checks your pattern, your patch or your streak. Progress lives in this
          browser.</span>
        <span class="perc-count">${doneC}/${CARIMBOS.length} carimbos &middot; ${doneP}/${PROVAS.length} provas</span>
        ${doneC === CARIMBOS.length && doneP === PROVAS.length
          ? '<span class="perc-diploma ouro">DIPLOMA DE OURO &middot; DJ DE BAILE</span>'
          : doneC === CARIMBOS.length
            ? '<span class="perc-diploma">DIPLOMA &middot; all carimbos, provas pending</span>' : ""}
        ${doneC + doneP ? '<button class="perc-reset" type="button">restart</button>' : ""}
      </div>
      <div class="perc-groove"><div class="perc-fill" style="width:${pct}%"></div></div>
      <div class="perc-levels">
        ${LEVELS.map(lv => {
          const lvDone = lv.cps.every(cp => progress[cp.id]);
          const lvProva = lv.provas.every(cp => progress[cp.id]);
          return `<div class="perc-level${lvDone ? " done" : ""}">
            <div class="perc-level-name">${lv.name}
              ${lvDone ? '<span class="perc-stamp">PRENSADO</span>' : ""}
              ${lvProva ? '<span class="perc-stamp aprovado">APROVADO</span>' : ""}</div>
            ${lv.cps.map(cpRow).join("")}
            <div class="perc-divider">provas</div>
            ${lv.provas.map(pvRow).join("")}
          </div>`;
        }).join("")}
      </div>`;
    qa(".perc-cp", el).forEach(b => b.addEventListener("click", () => {
      const g = b.dataset.goto;
      if (g.startsWith("aula:")) openLesson(+g.slice(5));
      else {
        const t = q(g);
        if (!t) return;
        if (g === "#mesa") {
          t.classList.add("flash");
          setTimeout(() => t.classList.remove("flash"), 1300);
        } else t.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }));
    const rst = q(".perc-reset", el);
    if (rst) rst.addEventListener("click", () => {
      progress = {};
      try { localStorage.removeItem(PROG_KEY); } catch (e) {}
      renderPercurso();
    });
  }

  /* ================= A Mesa: jam bar, recorder, prensagens ================= */

  const PRESS_KEY = "escola_prensagens";
  const LMAP = { grade: 0, sintetizador: 1, duck: 5, voz: 7 };
  const escHtml = s => String(s).replace(/[&<>"]/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtT = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  let mesaEl = null, rec = null, recTimer = null;

  const MODNAMES = ["grade", "sintetizador", "roda", "warp", "pulso", "duck", "bandas", "voz", "controlador", "loop"];
  function mesaLive() {
    const liveSet = new Set(running.values());
    qa(".station[data-mod]").forEach(st =>
      st.classList.toggle("live", liveSet.has(MODNAMES[+st.dataset.mod])));
    mixerSync();
    if (!mesaEl) return;
    const live = q(".mesa-live", mesaEl);
    if (!running.size) {
      live.innerHTML = '<span class="side-note">nada soando</span>';
      return;
    }
    live.innerHTML = [...running.values()].map(n =>
      `<button type="button" class="mesa-chip${CHANNELS[n] && CHANNELS[n].muted ? " killed" : ""}"
        data-ch="${n}" title="kill / revive this channel">${n}</button>`).join("");
    qa(".mesa-chip", live).forEach(ch => ch.addEventListener("click", () => {
      const n = ch.dataset.ch;
      chanKill(n, !(CHANNELS[n] && CHANNELS[n].muted));
      mesaLive();
    }));
  }

  /* ================= A Linha: clips and the arrangement ==================
     Capture a channel for a whole number of bars, then place the clips on four
     tracks and print the result. Clips are captured post fader and post pan,
     which is what you actually heard, and they play back through one "linha"
     channel so the mixer can still ride the arrangement as a whole. */

  const TL_BARS = 16, TL_TRACKS = 4;
  const CLIPS = [];
  const TRACKS = Array.from({ length: TL_TRACKS }, () => []);
  let clipSeq = 0, clipSel = null, tlPlaying = false, tlSrcs = [], tlT0 = 0, tlEl = null;
  let tlLoop = false, tlLoopA = 0, tlLoopB = 4, tlTimer = null, tlNextPass = 0, tlPassLen = 0;

  function tlStatus(msg) {
    const s = tlEl && q(".tl-status", tlEl);
    if (s) s.textContent = msg || "";
  }
  const tlLast = () => TRACKS.reduce((m, items) =>
    items.reduce((n, it) => Math.max(n, it.bar + it.clip.bars), m), 0);

  /* record exactly `bars` bars of a channel, starting on the next bar line.
     ScriptProcessor blocks do not land on bar lines, so the first block is
     trimmed with playbackTime to keep the clip sample accurate. */
  function captureClip(chanName, bars, onDone) {
    const ctx = AC(); ctx.resume();
    const src = chanName === "master" ? _limiter : (CHANNELS[chanName] && CHANNELS[chanName].pan);
    if (!src) { tlStatus(`${chanName} has not sounded yet, so there is nothing to capture`); return; }
    const barDur = trBar();
    if (!TR.epoch) TR.epoch = ctx.currentTime + 0.1;
    const start = TR.epoch +
      Math.max(0, Math.ceil((ctx.currentTime + 0.15 - TR.epoch) / barDur)) * barDur;
    const total = Math.round(bars * barDur * ctx.sampleRate);
    const L = new Float32Array(total), R = new Float32Array(total);
    const sp = ctx.createScriptProcessor(4096, 2, 2);
    const sink = ctx.createGain(); sink.gain.value = 0;
    let written = 0, done = false;
    function finish() {
      done = true;
      try { src.disconnect(sp); } catch (e) {}
      try { sp.disconnect(); sink.disconnect(); } catch (e) {}
      sp.onaudioprocess = null;
      const buf = ctx.createBuffer(2, total, ctx.sampleRate);
      buf.copyToChannel(L, 0); buf.copyToChannel(R, 1);
      const clip = { id: ++clipSeq, chan: chanName, bars, buf,
                     name: `${chanName} ${bars}c`, bpm: Math.round(TR.bpm) };
      CLIPS.push(clip);
      clipSel = clip.id;
      renderPool(); renderTimeline();
      tlStatus(`clipe ${clip.name} capturado. Escolha uma faixa e um compasso.`);
      diario("clipe: " + clip.name);
      if (onDone) onDone(clip);
    }
    sp.onaudioprocess = e => {
      if (done) return;
      const bl = e.inputBuffer.getChannelData(0), br = e.inputBuffer.getChannelData(1);
      const t0 = e.playbackTime != null ? e.playbackTime : ctx.currentTime;
      if (t0 + bl.length / ctx.sampleRate <= start) return;   /* still before the line */
      let from = t0 < start ? Math.round((start - t0) * ctx.sampleRate) : 0;
      for (let i = from; i < bl.length && written < total; i++, written++) {
        L[written] = bl[i]; R[written] = br[i];
      }
      if (written >= total) finish();
    };
    src.connect(sp); sp.connect(sink).connect(ctx.destination);
    tlStatus(`esperando o compasso para capturar ${bars} de ${chanName} ...`);
  }

  function stopLinha() {
    if (!tlPlaying) return;
    tlPlaying = false;
    clearInterval(tlTimer); tlTimer = null;
    tlSrcs.forEach(s => { try { s.stop(); } catch (e) {} });
    tlSrcs = [];
    const b = tlEl && q("[data-t=play]", tlEl);
    if (b) b.textContent = "tocar a linha";
    qa(".tl-cell.ph", tlEl || document).forEach(c => c.classList.remove("ph"));
    release(stopLinha);
  }
  /* the bracket, in bars, as a half open range. Off means the whole line once. */
  function tlBracket() {
    if (!tlLoop) return { a: 0, b: tlLast() };
    const a = Math.max(0, Math.min(TL_BARS - 1, tlLoopA));
    const b = Math.max(a + 1, Math.min(TL_BARS, tlLoopB));
    return { a, b };
  }
  /* one pass of the bracket, laid down starting at t0 */
  function schedulePass(t0) {
    const ctx = AC(), barDur = trBar(), { a, b } = tlBracket();
    TRACKS.forEach(items => items.forEach(it => {
      if (it.bar < a || it.bar >= b) return;
      const s = ctx.createBufferSource();
      s.buffer = it.clip.buf;
      s.connect(CHAN("linha"));
      s.start(t0 + (it.bar - a) * barDur);
      tlSrcs.push(s);
    }));
  }
  /* keep roughly a second of passes queued ahead of the clock */
  function tlFill() {
    if (!tlPlaying) return;
    const ctx = AC();
    while (tlNextPass < ctx.currentTime + 1.0) {
      schedulePass(tlNextPass);
      tlNextPass += tlPassLen;
      if (!tlLoop) { clearInterval(tlTimer); tlTimer = null; return; }
    }
    if (tlSrcs.length > 400) tlSrcs.splice(0, 200);   /* these have already played */
  }
  function playLinha() {
    if (!tlLast()) { tlStatus("a linha esta vazia: capture um clipe e coloque numa faixa"); return; }
    const ctx = AC(); ctx.resume();
    const barDur = trBar(), { a, b } = tlBracket();
    tlPassLen = Math.max(1, b - a) * barDur;
    tlT0 = tlNextPass = trAlign(barDur).t;
    tlSrcs = [];
    tlPlaying = true;
    tlFill();
    tlTimer = setInterval(tlFill, 200);
    claim("linha", stopLinha);
    q("[data-t=play]", tlEl).textContent = "parar a linha";
    tlStatus(tlLoop ? `repetindo os compassos ${a + 1} a ${b}` : "tocando a linha inteira");
    requestAnimationFrame(tlHead);
  }
  function tlHead() {
    if (!tlPlaying || !tlEl) return;
    const barDur = trBar(), { a, b } = tlBracket();
    const span = Math.max(1, b - a);
    const since = (AC().currentTime - tlT0) / barDur;
    const bar = since < 0 ? -1 : a + (tlLoop ? Math.floor(since) % span : Math.floor(since));
    qa(".tl-cell.ph", tlEl).forEach(c => c.classList.remove("ph"));
    if (bar >= 0 && bar < TL_BARS) {
      /* a clip stays lit for its whole span, not just its first bar */
      TRACKS.forEach((items, t) => {
        const it = items.find(x => bar >= x.bar && bar < x.bar + x.clip.bars);
        const c = q(`.tl-cell[data-t="${t}"][data-bar="${it ? it.bar : bar}"]`, tlEl);
        if (c) c.classList.add("ph");
      });
    }
    if (!tlLoop && since >= tlLast() - a) { stopLinha(); return; }
    requestAnimationFrame(tlHead);
  }

  /* print the arrangement offline through the same brick limiter the desk uses */
  async function renderLinha() {
    const ctx = AC();
    const barDur = trBar(), last = tlLast();
    if (!last) return null;
    const oc = new OfflineAudioContext(2,
      Math.ceil((last * barDur + 1.5) * ctx.sampleRate), ctx.sampleRate);
    const lim = new DynamicsCompressorNode(oc, {
      threshold: -9, knee: 3, ratio: 12, attack: 0.002, release: 0.12 });
    lim.connect(oc.destination);
    TRACKS.forEach(items => items.forEach(it => {
      const s = oc.createBufferSource();
      s.buffer = it.clip.buf;
      s.connect(lim);
      s.start(it.bar * barDur);
    }));
    const out = await oc.startRendering();
    return wavBlob([out.getChannelData(0)], [out.getChannelData(1)], out.length, out.sampleRate);
  }

  function renderPool() {
    const pool = tlEl && q(".tl-pool", tlEl);
    if (!pool) return;
    if (!CLIPS.length) {
      pool.innerHTML = `<span class="side-note">no clips yet: capture one above</span>`;
      return;
    }
    pool.innerHTML = CLIPS.map(c =>
      `<span class="tl-clip${c.id === clipSel ? " sel" : ""}" data-clip="${c.id}"
        title="${c.bars} bars of ${c.chan} at ${c.bpm} BPM. Tap to pick it up, then tap a cell">
        ${escHtml(c.name)}<button type="button" class="tl-del" data-del="${c.id}"
          title="throw this clip away">x</button></span>`).join("");
    qa(".tl-clip", pool).forEach(ch => ch.addEventListener("click", e => {
      if (e.target.matches(".tl-del")) return;
      clipSel = +ch.dataset.clip;
      renderPool();
      tlStatus("clipe na mao: toque num compasso de uma faixa para soltar");
    }));
    qa(".tl-del", pool).forEach(b => b.addEventListener("click", () => {
      const id = +b.dataset.del;
      const i = CLIPS.findIndex(c => c.id === id);
      if (i >= 0) CLIPS.splice(i, 1);
      TRACKS.forEach(items => {
        for (let k = items.length - 1; k >= 0; k--) if (items[k].clip.id === id) items.splice(k, 1);
      });
      if (clipSel === id) clipSel = null;
      renderPool(); renderTimeline();
    }));
  }

  function renderTimeline() {
    const tl = tlEl && q(".tl-grid", tlEl);
    if (!tl) return;
    tl.innerHTML = `
      <div class="tl-row tl-ruler"><span class="tl-lab"></span>
        <div class="tl-cells">${Array.from({ length: TL_BARS }, (_, b) =>
          `<span class="tl-bar${tlLoop && b >= tlLoopA && b < tlLoopB ? " inloop" : ""}"
            >${b % 4 === 0 ? b + 1 : ""}</span>`).join("")}</div></div>
      ${TRACKS.map((items, t) => {
        /* a placed clip spans its own bars, so the covered bars get no cell of
           their own: one more and the row would overflow the 16 column grid */
        const cells = Array.from({ length: TL_BARS }, (_, b) => {
          const it = items.find(x => x.bar === b);
          if (it) {
            return `<button type="button" class="tl-cell full" data-t="${t}" data-bar="${b}"
              style="--span:${it.clip.bars}" title="${escHtml(it.clip.name)}: tap to lift it off"
              >${escHtml(it.clip.chan)}</button>`;
          }
          if (items.some(x => b > x.bar && b < x.bar + x.clip.bars)) return "";
          return `<button type="button" class="tl-cell${b % 4 === 0 ? " b0" : ""}"
            data-t="${t}" data-bar="${b}" title="drop the clip in your hand here"></button>`;
        }).join("");
        return `<div class="tl-row"><span class="tl-lab">faixa ${t + 1}</span>
          <div class="tl-cells">${cells}</div></div>`;
      }).join("")}`;
    qa(".tl-cell.full", tl).forEach(c => c.addEventListener("click", () => {
      const t = +c.dataset.t, bar = +c.dataset.bar;
      const i = TRACKS[t].findIndex(x => x.bar === bar);
      if (i >= 0) { clipSel = TRACKS[t][i].clip.id; TRACKS[t].splice(i, 1); }
      renderPool(); renderTimeline();
      tlStatus("clipe de volta na mao");
    }));
    qa(".tl-cell:not(.full):not(.held)", tl).forEach(c => c.addEventListener("click", () => {
      const clip = CLIPS.find(x => x.id === clipSel);
      if (!clip) { tlStatus("escolha um clipe primeiro, ali em cima"); return; }
      const t = +c.dataset.t, bar = +c.dataset.bar;
      if (bar + clip.bars > TL_BARS) { tlStatus("esse clipe nao cabe ate o fim da linha"); return; }
      const clash = TRACKS[t].some(x => bar < x.bar + x.clip.bars && x.bar < bar + clip.bars);
      if (clash) { tlStatus("ja tem clipe nesse trecho da faixa"); return; }
      TRACKS[t].push({ clip, bar });
      renderTimeline();
      tlStatus(`${clip.name} na faixa ${t + 1}, compasso ${bar + 1}`);
    }));
  }

  function buildLinha(el) {
    tlEl = el;
    el.innerHTML = `
      <div class="esc-controls">
        <label title="which channel to capture. Master takes the whole desk, after the limiter">canal
          <select data-t="chan">
            <option value="master">master</option>
            ${MODNAMES.map(n => `<option value="${n}">${n}</option>`).join("")}
          </select></label>
        <label title="how many bars to capture. Recording starts on the next bar line">compassos
          <select data-t="bars"><option>1</option><option selected>2</option>
            <option>4</option><option>8</option></select></label>
        <button class="ghost" data-t="cap" title="capture starts on the next bar and stops on its own">capturar clipe</button>
        <button class="ghost" data-t="play" title="play the arrangement from the top">tocar a linha</button>
        <label class="check" title="repeat a stretch of the line instead of playing it once through">
          <input type="checkbox" data-t="loop"> repetir</label>
        <label title="the first bar of the bracket">de
          <input type="number" data-t="la" min="1" max="16" step="1" value="1"></label>
        <label title="the last bar of the bracket, played and then looped">ate
          <input type="number" data-t="lb" min="1" max="16" step="1" value="4"></label>
        <button class="ghost" data-t="wav" title="print the arrangement offline and download it">exportar wav</button>
        <button class="ghost" data-t="arq" title="print it and keep it in the plant's archive">arquivar</button>
      </div>
      <p class="side-note tl-status"></p>
      <div class="tl-pool"></div>
      <div class="tl-grid"></div>
      <p class="side-note esc-note">clips hold the audio you actually heard, fader and pan included,
        and they do not stretch: a clip captured at one tempo keeps its own length if you move the
        mesa afterwards. The whole line sounds through the <b>linha</b> channel, so you can ride or
        kill the arrangement from A Mistura like any other module.</p>`;
    renderPool();
    renderTimeline();
    q("[data-t=cap]", el).addEventListener("click", () => {
      captureClip(q("[data-t=chan]", el).value, +q("[data-t=bars]", el).value);
    });
    q("[data-t=play]", el).addEventListener("click", () => tlPlaying ? stopLinha() : playLinha());
    const readBracket = () => {
      tlLoopA = Math.max(1, Math.min(TL_BARS, +q("[data-t=la]", el).value || 1)) - 1;
      tlLoopB = Math.max(1, Math.min(TL_BARS, +q("[data-t=lb]", el).value || 1));
      if (tlLoopB <= tlLoopA) tlLoopB = tlLoopA + 1;
      q("[data-t=la]", el).value = tlLoopA + 1;
      q("[data-t=lb]", el).value = tlLoopB;
      renderTimeline();
      if (tlPlaying) { stopLinha(); playLinha(); }   /* re-lay the passes on the new bracket */
    };
    q("[data-t=loop]", el).addEventListener("change", e => { tlLoop = e.target.checked; readBracket(); });
    qa("[data-t=la], [data-t=lb]", el).forEach(i => i.addEventListener("change", readBracket));
    q("[data-t=wav]", el).addEventListener("click", async ev => {
      ev.target.disabled = true; ev.target.textContent = "prensando ...";
      try {
        const blob = await renderLinha();
        if (blob) { dlBlob(`djlab-linha-${Date.now()}.wav`, blob); tlStatus("linha exportada"); }
        else tlStatus("a linha esta vazia");
      } finally { ev.target.disabled = false; ev.target.textContent = "exportar wav"; }
    });
    q("[data-t=arq]", el).addEventListener("click", async ev => {
      ev.target.disabled = true; ev.target.textContent = "enviando ...";
      try {
        const blob = await renderLinha();
        if (!blob) { tlStatus("a linha esta vazia"); return; }
        const r = await fetch("/api/mesa/export?name=linha", { method: "POST", body: blob });
        const j = await r.json();
        if (!r.ok) throw new Error(j.detail || "upload failed");
        tlStatus("arquivada: " + j.file);
        diario("linha arquivada: " + j.file);
        renderExports();
      } catch (e) {
        tlStatus("nao consegui arquivar: " + e.message);
      } finally { ev.target.disabled = false; ev.target.textContent = "arquivar"; }
    });
  }

  /* ================= A Mistura: the mixer surface ================= */

  const MXLABEL = {
    grade: "grade", sintetizador: "sinte", roda: "roda", warp: "warp", pulso: "pulso",
    duck: "duck", bandas: "bandas", voz: "voz", controlador: "ctrl", loop: "loop",
    linha: "linha",
  };
  /* the arrangement gets a strip too, though it has no station of its own */
  const MXCHANS = MODNAMES.concat(["linha"]);
  let mixerEl = null, mixerOn = false;

  function mixerStrip(n) {
    return `<div class="mx-strip" data-ch="${n}">
      <span class="mx-name" title="${n}">${MXLABEL[n] || n}</span>
      <div class="mx-body">
        <canvas class="mx-meter" title="this channel, post fader and pan"></canvas>
        <input class="mx-fader" type="range" min="0" max="1.2" step="0.01" value="1"
          aria-label="${n} fader" title="channel fader">
      </div>
      <div class="mx-btns">
        <button type="button" class="mx-m" title="mute this channel">M</button>
        <button type="button" class="mx-s" title="solo: leave only the soloed channels standing">S</button>
      </div>
      <div class="mx-knobs">
        <label class="mx-knob">pan<input class="mx-pan" type="range" min="-1" max="1" step="0.02"
          value="0" aria-label="${n} pan" title="place this channel left to right"></label>
        <label class="mx-knob">rev<input class="mx-send" data-send="rev" type="range" min="0" max="1"
          step="0.02" value="0" aria-label="${n} reverb send" title="send to the plate"></label>
        <label class="mx-knob">dly<input class="mx-send" data-send="dly" type="range" min="0" max="1"
          step="0.02" value="0" aria-label="${n} delay send" title="send to the dub delay"></label>
      </div>
    </div>`;
  }

  function buildMixer(el) {
    mixerEl = el;
    el.innerHTML = `
      <div class="mx-rack">
        ${MXCHANS.map(mixerStrip).join("")}
        <div class="mx-strip mx-master" data-ch="__master">
          <span class="mx-name">master</span>
          <div class="mx-body">
            <canvas class="mx-meter" title="the master bus, after the limiter"></canvas>
            <input class="mx-fader" type="range" min="0" max="1.2" step="0.01" value="0.9"
              aria-label="master fader" title="master fader">
          </div>
          <div class="mx-knobs">
            <canvas class="mx-spec" title="the master spectrum, after the limiter"></canvas>
            <label class="mx-knob">low<input class="mx-eq" data-eq="low" type="range" min="-12"
              max="12" step="0.5" value="0" title="low shelf at 120 Hz"></label>
            <label class="mx-knob">mid<input class="mx-eq" data-eq="mid" type="range" min="-12"
              max="12" step="0.5" value="0" title="peaking at 1 kHz"></label>
            <label class="mx-knob">high<input class="mx-eq" data-eq="high" type="range" min="-12"
              max="12" step="0.5" value="0" title="high shelf at 6 kHz"></label>
            <label class="mx-knob">cola<input class="mx-glue" type="range" min="-40" max="0"
              step="1" value="-18" title="glue: how hard the master bus squeezes the sum"></label>
          </div>
        </div>
      </div>
      <p class="side-note mx-note">every module sounds through its own strip. <b>M</b> kills a
        channel, <b>S</b> leaves only the soloed ones standing, and the two sends feed a plate
        and a tempo locked dub delay shared by the whole desk.</p>`;

    qa(".mx-strip[data-ch]", el).forEach(st => {
      const n = st.dataset.ch;
      if (n === "__master") return;
      q(".mx-fader", st).addEventListener("input", e => {
        chanVol(n, +e.target.value);
        const sv = q(`.station[data-mod="${MODNAMES.indexOf(n)}"] .st-vol`);
        if (sv) sv.value = e.target.value;
      });
      q(".mx-pan", st).addEventListener("input", e => chanPan(n, +e.target.value));
      qa(".mx-send", st).forEach(s => s.addEventListener("input", () =>
        chanSend(n, s.dataset.send, +s.value)));
      q(".mx-m", st).addEventListener("click", () => {
        CHAN(n);
        chanKill(n, !CHANNELS[n].muted);
        mesaLive();
      });
      q(".mx-s", st).addEventListener("click", () => {
        CHAN(n);
        chanSolo(n, !CHANNELS[n].solo);
      });
    });

    const mst = q(".mx-master", el);
    q(".mx-fader", mst).addEventListener("input", e => {
      BUS();
      _bus.gain.setTargetAtTime(+e.target.value, AC().currentTime, 0.02);
    });
    qa(".mx-eq", mst).forEach(inp => inp.addEventListener("input", () => {
      BUS();
      _mEq[inp.dataset.eq].gain.setTargetAtTime(+inp.value, AC().currentTime, 0.02);
    }));
    q(".mx-glue", mst).addEventListener("input", e => {
      BUS();
      _mComp.threshold.setTargetAtTime(+e.target.value, AC().currentTime, 0.02);
    });
    mixerSync();
  }

  /* keep the strips honest when a station head, a mesa chip or a pressing
     moves a channel behind the mixer's back */
  function mixerSync() {
    if (!mixerEl) return;
    const solo = anySolo();
    const live = new Set(running.values());
    qa(".mx-strip[data-ch]", mixerEl).forEach(st => {
      const n = st.dataset.ch;
      if (n === "__master") return;
      const ch = CHANNELS[n];
      const f = q(".mx-fader", st);
      if (ch && document.activeElement !== f) f.value = ch.vol;
      q(".mx-m", st).classList.toggle("on", !!(ch && ch.muted));
      q(".mx-s", st).classList.toggle("on", !!(ch && ch.solo));
      st.classList.toggle("dimmed", solo && !(ch && ch.solo));
      st.classList.toggle("live", live.has(n));
    });
  }

  function mxRms(an) {
    const d = new Uint8Array(an.fftSize);
    an.getByteTimeDomainData(d);
    let sum = 0;
    for (let i = 0; i < d.length; i++) { const v = (d[i] - 128) / 128; sum += v * v; }
    return Math.sqrt(sum / d.length);
  }
  /* the meters only run while A Mistura is the open surface: this machine is
     thermally capped and ten analysers per frame is not free */
  function mixerLoop() {
    if (!mixerOn || !mixerEl || !document.body.contains(mixerEl)) return;
    qa(".mx-strip[data-ch]", mixerEl).forEach(st => {
      const n = st.dataset.ch;
      const c = q(".mx-meter", st);
      if (!c || !c.clientWidth) return;
      const g = sizeCanvas(c, c.clientHeight || 110);
      const { width: w, height: h } = c;
      g.clearRect(0, 0, w, h);
      let rms = 0;
      if (n === "__master") { if (_an) rms = mxRms(_an); }
      else if (CHANNELS[n]) rms = mxRms(CHANNELS[n].an);
      const lvl = Math.min(1, rms * 3);
      const segs = 12, lit = Math.round(lvl * segs);
      const flat = w > h;   /* the strip lies down on a phone, so the meter does too */
      const seg = (flat ? w : h) / segs;
      for (let i = 0; i < segs; i++) {
        const hot = i >= segs - 2;
        g.fillStyle = i < lit ? (hot ? "#c8502a" : "#4a7a5c") : "rgba(50,38,30,0.12)";
        if (flat) g.fillRect(i * seg + 1, 1, Math.max(1, seg - 2), Math.max(1, h - 2));
        else g.fillRect(1, h - (i + 1) * seg + 1, Math.max(1, w - 2), Math.max(1, seg - 2));
      }
    });
    const sp = q(".mx-spec", mixerEl);
    if (sp && sp.clientWidth && _an) {
      const g = sizeCanvas(sp, sp.clientHeight || 34);
      const { width: w, height: h } = sp;
      g.clearRect(0, 0, w, h);
      const d = new Uint8Array(_an.frequencyBinCount);
      _an.getByteFrequencyData(d);
      const bars = 28, step = Math.floor(d.length * 0.62 / bars), bw = w / bars;
      for (let i = 0; i < bars; i++) {
        let m = 0;
        for (let k = 0; k < step; k++) m = Math.max(m, d[i * step + k] || 0);
        const bh = (m / 255) * h;
        g.fillStyle = "rgba(122,74,42,0.55)";
        g.fillRect(i * bw + 1, h - bh, Math.max(1, bw - 2), bh);
      }
    }
    requestAnimationFrame(mixerLoop);
  }

  function dlBlob(fname, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function wavBlob(L, R, n, rate) {
    const buf = new ArrayBuffer(44 + n * 4);
    const dv = new DataView(buf);
    const tag = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    tag(0, "RIFF"); dv.setUint32(4, 36 + n * 4, true); tag(8, "WAVE");
    tag(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, 2, true); dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
    tag(36, "data"); dv.setUint32(40, n * 4, true);
    let o = 44;
    for (let b = 0; b < L.length; b++) {
      const l = L[b], r = R[b];
      for (let i = 0; i < l.length; i++) {
        dv.setInt16(o, Math.max(-1, Math.min(1, l[i])) * 32767, true); o += 2;
        dv.setInt16(o, Math.max(-1, Math.min(1, r[i])) * 32767, true); o += 2;
      }
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  function startRec() {
    const ctx = AC(); ctx.resume();
    const sp = ctx.createScriptProcessor(4096, 2, 2);
    const sink = ctx.createGain(); sink.gain.value = 0;
    BUS();  /* ensures the limiter exists; the tap records the limited master */
    _limiter.connect(sp); sp.connect(sink).connect(ctx.destination);
    rec = { sp, sink, L: [], R: [], n: 0, jamMs: 0, stamp: performance.now(), sessao: false };
    sp.onaudioprocess = e => {
      if (!rec) return;
      rec.L.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      rec.R.push(new Float32Array(e.inputBuffer.getChannelData(1)));
      rec.n += e.inputBuffer.getChannelData(0).length;
      if (rec.n >= ctx.sampleRate * 600) stopRec();  /* 10 minute cap */
    };
    recTimer = setInterval(() => {
      if (!rec) return;
      const now = performance.now();
      if (running.size >= 2) {
        rec.jamMs += now - rec.stamp;
        if (rec.jamMs >= 20000 && !rec.sessao) { rec.sessao = true; emit("prova-sessao"); }
      }
      rec.stamp = now;
      q(".mesa-rec-info", mesaEl).innerHTML =
        `<span class="rec-dot"></span> ${fmtT(rec.n / ctx.sampleRate)}`;
    }, 300);
  }
  function stopRec() {
    if (!rec) return;
    const ctx = AC();
    clearInterval(recTimer);
    try { _limiter.disconnect(rec.sp); } catch (e) {}
    try { rec.sp.disconnect(); rec.sink.disconnect(); } catch (e) {}
    rec.sp.onaudioprocess = null;
    const { L, R, n } = rec;
    rec = null;
    mesaEl.classList.remove("recording");
    q(".rec-lab", mesaEl).textContent = "gravar";
    const info = q(".mesa-rec-info", mesaEl);
    if (n < ctx.sampleRate / 2) { info.textContent = ""; return; }
    const blob = wavBlob(L, R, n, ctx.sampleRate);
    diario("gravacao: " + fmtT(n / ctx.sampleRate));
    info.innerHTML = `<button type="button" class="ghost" data-m="dl">
      baixar wav (${fmtT(n / ctx.sampleRate)} &middot; ${(blob.size / 1048576).toFixed(1)} MB)</button>
      <button type="button" class="ghost" data-m="arq" title="save this master to the plant's archive">arquivar</button>`;
    q("[data-m=dl]", mesaEl).addEventListener("click", () => {
      dlBlob(`djlab-sessao-${Date.now()}.wav`, blob);
      emit("rec-save");
    });
    q("[data-m=arq]", mesaEl).addEventListener("click", async ev => {
      ev.target.disabled = true;
      ev.target.textContent = "enviando ...";
      try {
        const r = await fetch("/api/mesa/export?name=sessao", { method: "POST", body: blob });
        const j = await r.json();
        if (!r.ok) throw new Error(j.detail || "upload failed");
        ev.target.textContent = "arquivada";
        emit("rec-save");
        diario("arquivada: " + j.file);
        renderExports();
      } catch (e) {
        ev.target.disabled = false;
        ev.target.textContent = "arquivar (retry)";
      }
    });
  }

  function pressings() {
    try { return JSON.parse(localStorage.getItem(PRESS_KEY) || "[]"); } catch (e) { return []; }
  }
  function ensureBuilt(i) {
    const st = q(`.station[data-mod="${i}"]`);
    if (!st) return;
    const panel = st.closest(".mesa-panel");
    if (panel && !panel.classList.contains("active")) setTab(panel.dataset.panel);
  }
  function applyMods(mods, tries) {
    const left = {};
    for (const [k, st] of Object.entries(mods)) {
      if (MOD[k] && MOD[k].set) MOD[k].set(st);
      else { if (LMAP[k] != null) ensureBuilt(LMAP[k]); left[k] = st; }
    }
    if (Object.keys(left).length && tries < 20) setTimeout(() => applyMods(left, tries + 1), 150);
  }
  function setMesaTempo(v, fromInput) {
    TR.bpm = Math.max(100, Math.min(170, Math.round(v) || TR.bpm));
    if (mesaEl && !fromInput) q("[data-m=tempo]", mesaEl).value = TR.bpm;
    for (const k of Object.keys(MOD)) if (MOD[k].setTempo) MOD[k].setTempo(TR.bpm);
    /* the dub delay is a dotted eighth, so it has to follow the tempo too */
    if (_dly) _dly.delayTime.setTargetAtTime((60 / TR.bpm) * 0.75, AC().currentTime, 0.05);
    if (clickOn) startClick();   /* and the click relands on the new beat */
  }
  function renderDrawer() {
    const list = pressings();
    qa(".press-panel").forEach(dr => renderPressPanel(dr, list));
  }
  function renderPressPanel(dr, list) {
    dr.innerHTML = `
      <div class="mesa-save">
        <input type="text" maxlength="40" placeholder="nome da sessao" data-m="pname">
        <button class="ghost" type="button" data-m="press">prensar sessao</button>
        <span class="side-note">a pressing saves the mesa tempo plus the grid, the synth patch,
          the duck and the vocal channel of every module you have opened</span>
      </div>
      ${list.length ? list.map((p, i) => `
        <div class="mesa-press">
          <b>${escHtml(p.name)}</b>
          <span class="side-note">${new Date(p.ts).toLocaleDateString()} &middot; ${p.tempo || "?"} BPM
            &middot; ${Object.keys(p.mods || {}).join(" + ") || "empty"}</span>
          <span class="mesa-press-actions">
            <button class="ghost" type="button" data-load="${i}">carregar</button>
            <button class="ghost" type="button" data-json="${i}">json</button>
            <button class="ghost" type="button" data-del="${i}" title="delete this pressing">x</button>
          </span>
        </div>`).join("")
      : '<p class="side-note">no pressings yet: open a module, dial something in, name it, press it.</p>'}`;
    q("[data-m=press]", dr).addEventListener("click", () => {
      const mods = {};
      for (const k of Object.keys(MOD)) if (MOD[k].get) mods[k] = MOD[k].get();
      const inp = q("[data-m=pname]", dr);
      if (!Object.keys(mods).length) { inp.placeholder = "open a module first, then press"; return; }
      const list2 = pressings();
      const name = (inp.value || "").trim() || `sessao ${list2.length + 1}`;
      list2.unshift({ name, ts: Date.now(), tempo: TR.bpm, mods });
      try { localStorage.setItem(PRESS_KEY, JSON.stringify(list2)); } catch (e) {}
      emit("press-save");
      diario("prensagem: " + name);
      renderDrawer();
    });
    qa("[data-load]", dr).forEach(b => b.addEventListener("click", () => {
      const p = pressings()[+b.dataset.load];
      if (!p) return;
      if (p.tempo) setMesaTempo(p.tempo, false);
      applyMods(p.mods || {}, 0);
      diario("carregada: " + p.name);
      b.textContent = "carregado";
      setTimeout(() => { b.textContent = "carregar"; }, 1400);
    }));
    qa("[data-json]", dr).forEach(b => b.addEventListener("click", () => {
      const p = pressings()[+b.dataset.json];
      if (!p) return;
      dlBlob(`${p.name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "sessao"}.djlab.json`,
        new Blob([JSON.stringify(p, null, 2)], { type: "application/json" }));
    }));
    qa("[data-del]", dr).forEach(b => b.addEventListener("click", () => {
      const list2 = pressings();
      list2.splice(+b.dataset.del, 1);
      try { localStorage.setItem(PRESS_KEY, JSON.stringify(list2)); } catch (e) {}
      renderDrawer();
    }));
  }

  /* ---------- o arquivo: the logbook + archived masters ---------- */

  /* the livro de registro was retired (2026-08-13, "a bit much"): diario()
     stays as a no-op so the call sites remain cheap to revive later */
  try { localStorage.removeItem("escola_diario"); } catch (e) {}
  function diario() {}

  let arqAudio = null;
  function stopArq() {
    if (arqAudio) { arqAudio.pause(); arqAudio = null; }
    qa("[data-arq-play].playing-x").forEach(b => {
      b.classList.remove("playing-x");
      b.textContent = "tocar";
    });
    release(stopArq);
  }
  async function renderExports() {
    const el = q("#exports");
    if (!el) return;
    let list = [];
    try { list = await (await fetch("/api/mesa/exports")).json(); }
    catch (e) { el.innerHTML = '<p class="side-note">could not load the archive</p>'; return; }
    if (!list.length) {
      el.innerHTML = '<p class="side-note">no masters archived yet: record at the mesa, then hit arquivar.</p>';
      return;
    }
    el.innerHTML = list.map(x => `
      <div class="arq-row">
        <b>${escHtml(x.file.replace(/\.wav$/, ""))}</b>
        <span class="side-note">${new Date(x.mtime * 1000).toLocaleDateString()}
          ${x.dur != null ? "&middot; " + fmtT(x.dur) : ""} &middot; ${(x.size / 1048576).toFixed(1)} MB</span>
        <span class="mesa-press-actions">
          <button class="ghost" type="button" data-arq-play="${escHtml(x.file)}">tocar</button>
          <a class="ghost" href="/api/mesa/export/${encodeURIComponent(x.file)}" download>baixar</a>
          <button class="ghost" type="button" data-arq-del="${escHtml(x.file)}" title="delete this master">x</button>
        </span>
      </div>`).join("");
    qa("[data-arq-play]", el).forEach(b => b.addEventListener("click", () => {
      if (b.classList.contains("playing-x")) { stopArq(); return; }
      stopArq();
      claim("arquivo", stopArq);
      arqAudio = new Audio("/api/mesa/export/" + encodeURIComponent(b.dataset.arqPlay));
      arqAudio.play();
      arqAudio.addEventListener("ended", stopArq);
      b.classList.add("playing-x");
      b.textContent = "parar";
    }));
    qa("[data-arq-del]", el).forEach(b => b.addEventListener("click", async () => {
      if (!b.classList.contains("confirm")) {
        b.classList.add("confirm");
        b.textContent = "confirma?";
        setTimeout(() => { b.classList.remove("confirm"); b.textContent = "x"; }, 2500);
        return;
      }
      try { await fetch("/api/mesa/export/" + encodeURIComponent(b.dataset.arqDel), { method: "DELETE" }); }
      catch (e) {}
      renderExports();
    }));
  }

  /* ---------- intake at the mesa: pull vocals + samples straight in ---------- */

  const CRATE_MODS = { roda: 2, warp: 3, bandas: 6, voz: 7 };
  function refreshCrate() {
    _crate = null;
    const live = new Set(running.values());
    for (const [name, i] of Object.entries(CRATE_MODS)) {
      const st = q(`.station[data-mod="${i}"]`);
      if (st && st.dataset.built && !live.has(name)) {
        try { LESSONS[i].build(q(".station-widget", st)); } catch (e) {}
      }
    }
  }

  function buildIntake() {
    const el = q("#mesa-intake");
    if (!el) return;
    el.innerHTML = `
      <div class="esc-controls mi-bar">
        <label title="where to search: your spotify (rips via a youtube upload you choose) or youtube directly">fonte <select data-mi="src">
          <option value="spotify">my spotify</option>
          <option value="youtube">youtube</option></select></label>
        <input type="search" data-mi="q" placeholder="pull vocals, drums, strings, anything into the crate ...">
        <button class="ghost" type="button" data-mi="go">search</button>
        <span class="side-note">spotify picks rip via a youtube upload YOU choose &middot;
          new tracks land in every module's track list, and A Voz can split them into camadas</span>
      </div>
      <div class="mi-results"></div>
      <div class="mi-status"></div>`;
    const resEl = q(".mi-results", el), stEl = q(".mi-status", el);
    const SHELVES = ["lush", "cosmic", "rhythmic", "percussion"];
    const fmtD = s => {
      s = Math.round(s || 0);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
    async function search() {
      const src = q("[data-mi=src]", el).value;
      const qq = q("[data-mi=q]", el).value.trim();
      if (!qq) { stEl.textContent = "type something first."; return; }
      stEl.textContent = `searching ${src} ...`;
      try {
        if (src === "youtube") {
          const d = await (await fetch(`/api/intake/youtube/search?q=${encodeURIComponent(qq)}`)).json();
          renderYt(d.videos || []);
        } else {
          const r = await fetch(`/api/intake/spotify/search?q=${encodeURIComponent(qq)}`);
          if (!r.ok) throw new Error((await r.json()).detail);
          renderSp((await r.json()).tracks || []);
        }
      } catch (e) { stEl.textContent = "intake error: " + e.message; }
    }
    function renderSp(tracks) {
      if (!tracks.length) { resEl.innerHTML = ""; stEl.textContent = "nothing found."; return; }
      stEl.textContent = "";
      resEl.innerHTML = tracks.slice(0, 8).map((t, i) => `
        <div class="arq-row">
          <b>${escHtml(t.title)}</b>
          <span class="side-note">${escHtml(t.artist)}${t.album ? " &middot; " + escHtml(t.album) : ""}
            &middot; ${fmtD((t.duration_ms || 0) / 1000)}</span>
          <span class="mesa-press-actions">
            <button class="ghost" type="button" data-sp="${i}">find on youtube &rarr;</button>
          </span>
        </div>`).join("");
      qa("[data-sp]", resEl).forEach(b => b.addEventListener("click", () => {
        const t = tracks[+b.dataset.sp];
        q("[data-mi=q]", el).value = `${(t.artist || "").split(",")[0]} ${t.title}`;
        q("[data-mi=src]", el).value = "youtube";
        search();
      }));
    }
    function renderYt(videos) {
      if (!videos.length) { resEl.innerHTML = ""; stEl.textContent = "nothing found."; return; }
      stEl.innerHTML = "choose the upload to rip, pick its shelf (<b>lush</b> = voices), pull.";
      resEl.innerHTML = videos.slice(0, 8).map((v, i) => `
        <div class="arq-row">
          <b>${escHtml(v.title)}</b>
          <span class="side-note">${escHtml(v.channel || "")} &middot; ${fmtD(v.duration)}</span>
          <span class="mesa-press-actions">
            <select data-shelf="${i}">${SHELVES.map(s =>
              `<option${s === "lush" ? " selected" : ""}>${s}</option>`).join("")}</select>
            <button class="ghost" type="button" data-pull="${i}">pull &darr;</button>
          </span>
        </div>`).join("");
      qa("[data-pull]", resEl).forEach(b => b.addEventListener("click", async () => {
        const i = +b.dataset.pull;
        const folder = q(`[data-shelf="${i}"]`, resEl).value;
        b.disabled = true;
        try {
          const r = await fetch("/api/intake/pull", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: videos[i].url, folder }),
          });
          if (!r.ok) throw new Error((await r.json()).detail);
        } catch (e) {
          stEl.textContent = "could not start the pull: " + e.message;
          b.disabled = false;
          return;
        }
        stEl.innerHTML = `<b>pulling</b> ${escHtml(videos[i].title)} &rarr; ${folder} shelf: starting ...`;
        while (true) {
          await new Promise(r2 => setTimeout(r2, 1500));
          let jobs = [];
          try { jobs = await (await fetch("/api/jobs")).json(); } catch (e) { break; }
          const j = jobs[jobs.length - 1];
          if (!j) break;
          const lines = j.log.split("\n").map(l => l.trim()).filter(Boolean);
          if (j.status === "running") {
            stEl.innerHTML = `<b>pulling</b> ${escHtml(videos[i].title)}:
              ${escHtml(lines[lines.length - 1] || "working ...")}`;
            continue;
          }
          if (j.status === "done") {
            const verdict = lines.find(l => /BPM/.test(l) && /beat cv/.test(l)) || "";
            stEl.innerHTML = `<b>in the crate</b> &middot; ${escHtml(videos[i].title)} landed on the
              ${folder} shelf. <span class="side-note">${escHtml(verdict)}</span> Track lists refreshed.`;
            diario("crate: pulled " + videos[i].title);
            refreshCrate();
          } else {
            stEl.innerHTML = `<b>pull failed</b>: ${escHtml(lines.slice(-2).join(" / "))}`;
          }
          break;
        }
        b.disabled = false;
      }));
    }
    q("[data-mi=go]", el).addEventListener("click", search);
    q("[data-mi=q]", el).addEventListener("keydown", e => { if (e.key === "Enter") search(); });
  }

  /* ---------- web midi: a real controller into the synth ---------- */

  let _midi = null;
  function midiStatus(txt, title) {
    const b = q("[data-m=midi]", mesaEl);
    if (!b) return;
    b.textContent = txt;
    b.title = title || "connect a midi keyboard: notes and velocity go to O Sintetizador";
  }
  function onMidiMsg(ev) {
    const [st, d1, d2] = ev.data;
    const cmd = st & 0xf0;
    if (cmd === 0x90 && d2 > 0) {
      if (!_midiTarget) ensureBuilt(1);
      if (_midiTarget) _midiTarget.on(d1, d2 / 127);
    } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
      if (_midiTarget) _midiTarget.off(d1);
    } else if (cmd === 0xb0 && d1 === 1) {
      if (_midiTarget && _midiTarget.cc) _midiTarget.cc(1, d2 / 127);
    }
  }
  async function midiConnect() {
    if (!navigator.requestMIDIAccess) { midiStatus("midi: n/a", "this browser has no Web MIDI"); return; }
    try { _midi = await navigator.requestMIDIAccess(); }
    catch (e) { midiStatus("midi: blocked", "midi permission was denied"); return; }
    const wire = () => {
      const names = [];
      _midi.inputs.forEach(inp => { names.push(inp.name); inp.onmidimessage = onMidiMsg; });
      midiStatus(names.length ? `midi: ${names.length} in` : "midi: sem device",
        names.join(", ") || "no controller found: plug one in, it hot-connects");
    };
    wire();
    _midi.onstatechange = wire;
    try { localStorage.setItem("escola_midi", "1"); } catch (e) {}
  }

  /* ---- the click ----
     A scheduled woodblock that connects straight to the destination, past the
     bus and past the limiter the recorder taps. A metronome you can hear but
     never print into a take. */
  let clickOn = false, clickTimer = null, clickNext = 0;
  function clickHit(t, accent) {
    const ctx = AC();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "square";
    o.frequency.value = accent ? 1600 : 1050;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(accent ? 0.3 : 0.16, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + 0.06);
  }
  function clickSchedule() {
    if (!clickOn) return;
    const ctx = AC(), beat = 60 / TR.bpm;
    while (clickNext < ctx.currentTime + 0.15) {
      const b = Math.round((clickNext - TR.epoch) / beat);
      clickHit(clickNext, ((b % 4) + 4) % 4 === 0);
      clickNext += beat;
    }
  }
  function startClick() {
    const ctx = AC(); ctx.resume();
    if (!TR.epoch) TR.epoch = ctx.currentTime + 0.1;
    clickOn = true;
    const beat = 60 / TR.bpm;
    clickNext = TR.epoch + Math.max(0, Math.ceil((ctx.currentTime + 0.1 - TR.epoch) / beat)) * beat;
    clearInterval(clickTimer);
    clickTimer = setInterval(clickSchedule, 25);
  }
  function stopClick() { clickOn = false; clearInterval(clickTimer); }
  /* four clicks from the next bar line, then the callback on the downbeat */
  function countInThen(cb) {
    const ctx = AC(); ctx.resume();
    if (!TR.epoch) TR.epoch = ctx.currentTime + 0.1;
    const beat = 60 / TR.bpm, bar = trBar();
    const start = TR.epoch + Math.max(0, Math.ceil((ctx.currentTime + 0.12 - TR.epoch) / bar)) * bar;
    for (let i = 0; i < 4; i++) clickHit(start + i * beat, i === 0);
    setTimeout(cb, Math.max(0, (start + 4 * beat - ctx.currentTime) * 1000));
  }

  /* ---- tap tempo ---- */
  let taps = [];
  function tapTempo() {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2200) taps = [];   /* a new count-off */
    taps.push(now);
    if (taps.length > 5) taps.shift();
    if (taps.length < 2) return null;
    const gaps = taps.slice(1).map((t, i) => t - taps[i]);
    return Math.round(60000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length));
  }

  function buildMesa() {
    if (!q("#escola-list")) return;
    mesaEl = document.createElement("div");
    mesaEl.id = "mesa";
    mesaEl.innerHTML = `
      <div class="mesa-row">
        <span class="mesa-tag" title="modules sound together: tap a live chip to kill just that channel">AO VIVO</span>
        <canvas class="vu" title="the master bus, after the limiter"></canvas>
        <span class="mesa-live"><span class="side-note">nada soando</span></span>
        <label class="mesa-tempo" title="the mesa tempo: pushes A Grade, O Duck, a matched vocal and the loop's repitch, and realigns them to one grid">tempo
          <input type="number" min="100" max="170" step="1" value="${TR.bpm}" data-m="tempo"></label>
        <button class="ghost" type="button" data-m="stopall">parar tudo</button>
        <button class="ghost rec-btn" type="button" data-m="rec">
          <span class="rec-ind"></span><span class="rec-lab">gravar</span></button>
        <span class="mesa-rec-info"></span>
        <button class="ghost" type="button" data-m="midi"
          title="connect a midi keyboard: notes and velocity go to O Sintetizador">midi</button>
        <button class="ghost" type="button" data-m="drawer">prensagens</button>
        <button class="ghost" type="button" data-m="tr"
          title="the transport: counter, tap tempo, click, count-in and launch quantize">transporte</button>
      </div>
      <div class="mesa-row mesa-transport">
        <span class="tr-pos" title="where the desk is in the cycle: bar . beat . step">001 . 1 . 01</span>
        <span class="tr-arm" hidden></span>
        <button class="ghost" type="button" data-m="tap"
          title="tap four times in time and the mesa takes the tempo">tap</button>
        <button class="ghost" type="button" data-m="click"
          title="the click. It bypasses the bus, so it is never printed into a take">claque</button>
        <label class="check" title="one bar of clicks before the recorder rolls">
          <input type="checkbox" data-m="countin"> entrada</label>
        <label title="modules wait for this boundary before entering, instead of starting under your finger">entrar
          <select data-m="quant">
            <option value="0">ja</option>
            <option value="1">no compasso</option>
            <option value="2">2 compassos</option>
            <option value="4">4 compassos</option>
          </select></label>
        <label title="the cycle the counter wraps in">ciclo
          <select data-m="cycle">
            <option value="2">2</option><option value="4" selected>4</option>
            <option value="8">8</option><option value="16">16</option>
          </select></label>
      </div>
      <div class="mesa-drawer press-panel" hidden></div>`;
    document.body.appendChild(mesaEl);
    document.body.classList.add("has-mesa");
    q("[data-m=tempo]", mesaEl).addEventListener("change", e => {
      setMesaTempo(+e.target.value, true);
      e.target.value = TR.bpm;
    });
    q("[data-m=stopall]", mesaEl).addEventListener("click", () => hush());
    function armRec() {
      startRec();
      mesaEl.classList.add("recording");
      q(".rec-lab", mesaEl).textContent = "parar rec";
      q(".mesa-rec-info", mesaEl).innerHTML = '<span class="rec-dot"></span> 0:00';
    }
    q("[data-m=rec]", mesaEl).addEventListener("click", () => {
      if (rec) { stopRec(); return; }
      const btn = q("[data-m=rec]", mesaEl);
      if (btn.dataset.arming) return;
      if (q("[data-m=countin]", mesaEl).checked) {
        btn.dataset.arming = "1";
        q(".rec-lab", mesaEl).textContent = "entrando";
        countInThen(() => {
          delete btn.dataset.arming;
          armRec();
        });
        return;
      }
      armRec();
    });
    q("[data-m=tap]", mesaEl).addEventListener("click", () => {
      const v = tapTempo();
      if (v && v >= 100 && v <= 170) setMesaTempo(v);
      else if (v) diario(`tap deu ${v} BPM, fora do alcance da mesa`);
    });
    q("[data-m=click]", mesaEl).addEventListener("click", e => {
      if (clickOn) { stopClick(); e.target.classList.remove("active"); }
      else { startClick(); e.target.classList.add("active"); }
    });
    q("[data-m=quant]", mesaEl).addEventListener("change", e => {
      TR.quant = +e.target.value;
      diario(TR.quant ? `entrada quantizada em ${TR.quant} compasso(s)` : "entrada imediata");
    });
    q("[data-m=cycle]", mesaEl).addEventListener("change", e => { TR.cycle = +e.target.value; });
    /* a phone cannot spare a third of its screen for a bar it is not using, so
       the transport row folds away there and stays open on a desk */
    const trRow = q(".mesa-transport", mesaEl), trBtn = q("[data-m=tr]", mesaEl);
    const setTr = open => {
      trRow.hidden = !open;
      trBtn.classList.toggle("active", open);
    };
    setTr(!SEQ_MQ.matches);
    trBtn.addEventListener("click", () => setTr(trRow.hidden));
    q("[data-m=drawer]", mesaEl).addEventListener("click", () => {
      const dr = q(".mesa-drawer", mesaEl);
      dr.hidden = !dr.hidden;
      if (!dr.hidden) renderDrawer();
    });
    q("[data-m=midi]", mesaEl).addEventListener("click", midiConnect);
    let wantMidi = false;
    try { wantMidi = !!localStorage.getItem("escola_midi"); } catch (e) {}
    if (wantMidi) midiConnect();
    document.addEventListener("keydown", hotkeys);
    requestAnimationFrame(vuLoop);
  }

  /* master VU: rms segments + decaying peak tick, fed by the bus analyser */
  let vuPeak = 0;
  function vuLoop() {
    if (!mesaEl) return;
    const c = q("canvas.vu", mesaEl);
    if (c && c.clientWidth) {
      const g = sizeCanvas(c, 18);
      const { width: w, height: h } = c;
      g.clearRect(0, 0, w, h);
      let rms = 0;
      if (_an) {
        const d = new Uint8Array(_an.fftSize);
        _an.getByteTimeDomainData(d);
        let sum = 0, peak = 0;
        for (let i = 0; i < d.length; i++) {
          const v = (d[i] - 128) / 128;
          sum += v * v;
          if (Math.abs(v) > peak) peak = Math.abs(v);
        }
        rms = Math.sqrt(sum / d.length);
        vuPeak = Math.max(peak, vuPeak * 0.96);
      } else vuPeak *= 0.96;
      const segs = 26, sw = w / segs;
      for (let i = 0; i < segs; i++) {
        const on = i / segs < Math.min(1, rms * 2.4);
        const hot = i > segs * 0.78;
        g.fillStyle = hot
          ? (on ? "#c8502a" : "rgba(200,80,42,0.22)")
          : (on ? "#8fbf9c" : "rgba(242,237,226,0.14)");
        g.fillRect(i * sw + 1, 2, Math.max(1, sw - 2.5), h - 4);
      }
      if (vuPeak > 0.02) {
        g.fillStyle = "#f2ede2";
        g.fillRect(Math.min(1, vuPeak) * (w - 3), 0, 3, h);
      }
    }
    const pos = q(".tr-pos", mesaEl);
    if (pos) {
      const p = trPos();
      const s = `${String(p.cyc).padStart(3, "0")} . ${p.beat} . ${String(p.step).padStart(2, "0")}`;
      if (pos.textContent !== s) pos.textContent = s;
    }
    const arm = q(".tr-arm", mesaEl);
    if (arm) {
      const left = _ctx ? TR.pending - _ctx.currentTime : 0;
      if (left > 0.05) {
        arm.hidden = false;
        const s2 = `entra em ${left.toFixed(1)}s`;
        if (arm.textContent !== s2) arm.textContent = s2;
      } else if (!arm.hidden) {
        arm.hidden = true;
        TR.pending = 0;
      }
    }
    requestAnimationFrame(vuLoop);
  }

  function aulaHead(L) {
    return `<button class="aula-head" type="button">
      <span class="aula-no">${L.no}</span>
      <span class="aula-name">${L.title}</span>
      <span class="aula-tag">${L.tag}</span>
      <span class="aula-sub">${L.sub}</span>
      <span class="aula-toggle">abrir +</span>
    </button>`;
  }
  function wireToggle(card, onOpen) {
    const head = q(".aula-head", card), body = q(".aula-body", card);
    head.addEventListener("click", () => {
      if (body.hidden) {
        body.hidden = false;
        q(".aula-toggle", head).textContent = "fechar ×";
        if (onOpen) onOpen();
      } else {
        body.hidden = true;
        q(".aula-toggle", head).textContent = "abrir +";
      }
    });
  }
  /* the desk: three surfaces of always-open stations, like a real table */
  const DESK = [
    { id: "maquinas", label: "M&aacute;quinas", slots: [[0], [5], [1, "wide"], [8, "wide"], [9, "wide"]] },
    { id: "discos", label: "Discos", slots: [["intake", "wide"], [7, "wide"], [3], [2]] },
    { id: "mistura", label: "Mistura", slots: [[4], [6], ["master", "wide"]] },
    { id: "linha", label: "A Linha", slots: [["linha", "wide"]] },
  ];
  function buildTab(id) {
    const panel = q(`.mesa-panel[data-panel="${id}"]`);
    if (!panel) return;
    qa(".station[data-mod]", panel).forEach(st => {
      if (st.dataset.built) return;
      st.dataset.built = "1";
      const i = +st.dataset.mod;
      try { LESSONS[i].build(q(".station-widget", st)); }
      catch (e) {
        q(".station-widget", st).innerHTML =
          `<p class="side-note">this module failed to load: ${e.message}</p>`;
      }
    });
    const mx = q(".mesa-mixer", panel);
    if (mx && !mx.dataset.built) {
      mx.dataset.built = "1";
      try { buildMixer(mx); }
      catch (e) { mx.innerHTML = `<p class="side-note">the mixer failed to load: ${e.message}</p>`; }
    }
    const ln = q(".station-widget.linha", panel);
    if (ln && !ln.dataset.built) {
      ln.dataset.built = "1";
      try { buildLinha(ln); }
      catch (e) { ln.innerHTML = `<p class="side-note">a linha failed to load: ${e.message}</p>`; }
    }
    /* the meters cost a frame each, so they only run on the surface showing them */
    mixerOn = !!mx;
    if (mixerOn) requestAnimationFrame(mixerLoop);
  }
  function setTab(id) {
    qa(".mtab").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
    qa(".mesa-panel").forEach(p => p.classList.toggle("active", p.dataset.panel === id));
    buildTab(id);
    mixerSync();
  }
  /* reset = stop the module's channel and rebuild its widget from scratch */
  function resetStation(st) {
    const i = +st.dataset.mod;
    const entry = [...running.entries()].find(([, n]) => n === MODNAMES[i]);
    if (entry) entry[0]();
    st.dataset.built = "1";
    try { LESSONS[i].build(q(".station-widget", st)); }
    catch (e) {
      q(".station-widget", st).innerHTML =
        `<p class="side-note">this module failed to load: ${e.message}</p>`;
    }
    diario("reset: " + MODNAMES[i]);
  }
  function resetAll() {
    hush();
    qa(".station[data-mod]").forEach(st => { if (st.dataset.built) resetStation(st); });
    diario("reset da mesa");
  }
  /* beat match: snap a tempo-bearing module to the mesa tempo. Async-built
     modules (warp, voz) register MOD after an await, so retry briefly. */
  function syncStation(st) {
    const i = +st.dataset.mod;
    if (!st.dataset.built) {
      st.dataset.built = "1";
      try { LESSONS[i].build(q(".station-widget", st)); } catch (e) {}
    }
    let tries = 0;
    const go = () => {
      const m = MOD[MODNAMES[i]];
      if (m) {
        if (m.sync) m.sync();
        else if (m.setTempo) m.setTempo(TR.bpm);
        return;
      }
      if (++tries < 20) setTimeout(go, 150);
    };
    go();
  }
  function hotkeys(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.matches("input, select, textarea") || e.target.isContentEditable) return;
    if (e.code === "Digit1") setTab("maquinas");
    else if (e.code === "Digit2") setTab("discos");
    else if (e.code === "Digit3") setTab("mistura");
    else if (e.code === "Digit4") setTab("linha");
    else if (e.code === "Escape") hush();
    else if (e.code === "KeyR" && e.shiftKey) {
      const b = q("#mesa [data-m=rec]");
      if (b) b.click();
    } else if (e.code === "KeyL" && e.shiftKey) {
      const st = q('.station[data-mod="9"]');
      if (!st) return;
      if (!st.dataset.built) setTab("maquinas");
      const b = q('.station[data-mod="9"] [data-a=rec]');
      if (b) b.click();
    } else if (e.code === "Space" && e.target === document.body) {
      e.preventDefault();
      const st = q('.station[data-mod="0"]');
      if (!st) return;
      if (!st.dataset.built) setTab("maquinas");
      const play = q('.station[data-mod="0"] [data-a=play]');
      if (play) play.click();
    }
  }
  function render() {
    const desk = q("#modulos");
    if (desk) {
      desk.innerHTML = `
        <div class="mesa-tabs">${DESK.map((t, ti) =>
          `<button type="button" class="mtab${ti === 0 ? " active" : ""}" data-tab="${t.id}">${t.label}</button>`).join("")}
          <button type="button" class="ghost mesa-reset" title="stop everything and rebuild every open module fresh">reset da mesa</button>
        </div>
        <p class="atalhos">atalhos &middot; <b>1 2 3 4</b> trocam a superficie &middot; <b>espaco</b> toca
          a grade &middot; <b>shift+R</b> grava &middot; <b>shift+L</b> loop &middot; <b>esc</b> para tudo
          &middot; <b>A</b>..<b>K</b> e <b>O L P ;</b> tocam o sintetizador &middot; <b>Z X</b> oitava
          &middot; <b>C V B N M ,</b> tocam os pads</p>
        ${DESK.map((t, ti) => `<div class="mesa-panel${ti === 0 ? " active" : ""}" data-panel="${t.id}">
          ${t.slots.map(([m, wide]) => {
            if (m === "intake") {
              return `<div class="station wide" data-special="intake">
                <div class="station-head"><span class="st-no">&darr;</span>
                  <span class="st-name">Intake</span><span class="st-tag">crate</span></div>
                <div id="mesa-intake"></div>
              </div>`;
            }
            if (m === "linha") {
              return `<div class="station wide" data-special="linha">
                <div class="station-head"><span class="st-no">L</span>
                  <span class="st-name">A Linha</span><span class="st-tag">arranjo</span></div>
                <div class="station-widget linha"></div>
              </div>`;
            }
            if (m === "master") {
              return `<div class="station wide master" data-special="master">
                <div class="station-head"><span class="st-no">M</span>
                  <span class="st-name">A Mistura</span><span class="st-tag">mixer</span></div>
                <div class="station-widget">
                  <div class="mesa-mixer"></div>
                  <p class="side-note">the transport lives in the AO VIVO strip below: tempo, channel
                    kills, the recorder and parar tudo. Archived masters land in O Arquivo. A pressing
                    saves the state of every open module:</p>
                  <div class="press-panel"></div>
                </div>
              </div>`;
            }
            const L = LESSONS[m];
            const syncable = [0, 3, 5, 7].includes(m);
            return `<div class="station${wide ? " wide" : ""}" data-mod="${m}">
              <div class="station-head"><span class="st-no">${L.no}</span>
                <span class="st-name">${L.title}</span><span class="st-tag">${L.tag}</span>
                <span class="st-live" title="lit while this module sounds"></span>
                <input type="range" class="st-vol" min="0" max="1.2" step="0.01" value="1"
                  title="this module's channel volume on the mesa">
                ${syncable ? `<button type="button" class="st-sync"
                  title="beat match: snap this module to the mesa tempo">sync</button>` : ""}
                <button type="button" class="st-reset" title="reset this module to its defaults">reset</button></div>
              <div class="station-widget"></div>
            </div>`;
          }).join("")}
        </div>`).join("")}`;
      qa(".mtab", desk).forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));
      qa(".st-reset", desk).forEach(b =>
        b.addEventListener("click", () => resetStation(b.closest(".station"))));
      qa(".st-vol", desk).forEach(inp => inp.addEventListener("input", () => {
        chanVol(MODNAMES[+inp.closest(".station").dataset.mod], +inp.value);
      }));
      qa(".st-sync", desk).forEach(b =>
        b.addEventListener("click", () => syncStation(b.closest(".station"))));
      const mr = q(".mesa-reset", desk);
      mr.addEventListener("click", () => {
        if (!mr.classList.contains("confirm")) {
          mr.classList.add("confirm");
          mr.textContent = "confirma? para tudo e zera os modulos";
          setTimeout(() => {
            mr.classList.remove("confirm");
            mr.textContent = "reset da mesa";
          }, 3000);
          return;
        }
        mr.classList.remove("confirm");
        mr.textContent = "reset da mesa";
        resetAll();
      });
      buildTab("maquinas");
    }
    /* the liner notes: the teaching text behind each module */
    const list = q("#escola-list");
    if (!list) return;
    list.innerHTML = LESSONS.map((L, i) => `
      <div class="aula nota" data-n="${i}">
        ${aulaHead(L)}
        <div class="aula-body" hidden>
          <p class="aula-intro">${L.intro}</p>
          <ul class="aula-notes">${L.notes.map(n => `<li>${n}</li>`).join("")}</ul>
          <p class="aula-lab"><b>in this lab:</b> ${L.lab}</p>
          <p><button class="ghost" type="button" data-open-mod="${i}">tocar este modulo &uarr;</button></p>
        </div>
      </div>`).join("");
    qa(".nota", list).forEach(card => wireToggle(card));
    qa("[data-open-mod]", list).forEach(b =>
      b.addEventListener("click", () => openLesson(+b.dataset.openMod)));
  }
  render();
  buildMesa();
  buildIntake();
  renderDrawer();
  renderPercurso();
  renderTeaser();
  renderExports();
})();

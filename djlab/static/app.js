/* dj-lab front end: state render, waveform players, live mixer, jobs. */

const $ = (sel, el = document) => el.querySelector(sel);
const PLAY_SVG = '<svg viewBox="0 0 16 16"><path d="M4 2l10 6-10 6z"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 16 16"><path d="M3 2h4v12H3zM9 2h4v12H9z"/></svg>';

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let currentAudio = null;
let currentBtn = null;
let currentMixer = null;

/* ---------- waveform preview players ---------- */

async function drawWave(canvas, url) {
  try {
    const res = await fetch(url);
    const buf = await audioCtx.decodeAudioData(await res.arrayBuffer());
    const data = buf.getChannelData(0);
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr;
    canvas.width = w; canvas.height = h;
    const cols = Math.floor(w / (3 * dpr));
    const step = Math.floor(data.length / cols);
    canvas._peaks = [];
    for (let i = 0; i < cols; i++) {
      let max = 0;
      for (let j = i * step; j < (i + 1) * step; j += 24) {
        const v = Math.abs(data[j]);
        if (v > max) max = v;
      }
      canvas._peaks.push(max);
    }
    canvas._dur = buf.duration;
    paintWave(canvas, 0);
  } catch (e) {
    canvas.replaceWith(Object.assign(document.createElement("span"),
      { textContent: "waveform unavailable", className: "tag" }));
  }
}

function paintWave(canvas, progress) {
  const ctx = canvas.getContext("2d");
  const { width: w, height: h } = canvas;
  const peaks = canvas._peaks || [];
  ctx.clearRect(0, 0, w, h);
  const styles = getComputedStyle(document.documentElement);
  const ink = styles.getPropertyValue("--ink");
  const terra = styles.getPropertyValue("--terra");
  const barW = w / peaks.length;
  peaks.forEach((p, i) => {
    const x = i * barW;
    const bh = Math.max(2, p * h * 0.92);
    ctx.fillStyle = (i / peaks.length) < progress ? terra : ink;
    ctx.globalAlpha = (i / peaks.length) < progress ? 1 : 0.75;
    ctx.fillRect(x, (h - bh) / 2, barW * 0.62, bh);
  });
  ctx.globalAlpha = 1;
}

function makePlayer(tag, urls) {
  const row = document.createElement("div");
  row.className = "player";
  row.innerHTML = `<button class="play-btn" aria-label="play ${tag}">${PLAY_SVG}</button>
    <span class="tag">${tag}</span><canvas class="wave"></canvas>`;
  const btn = $(".play-btn", row);
  const canvas = $("canvas", row);
  const audio = new Audio(urls.mp3);
  audio.preload = "none";
  requestAnimationFrame(() => drawWave(canvas, urls.mp3));
  function tick() {
    if (!audio.paused) {
      paintWave(canvas, audio.currentTime / (canvas._dur || audio.duration || 1));
      requestAnimationFrame(tick);
    }
  }
  btn.addEventListener("click", () => {
    if (audio.paused) {
      stopAllPlayback();
      audio.play();
      if (window.escolaEmit) window.escolaEmit("app-play");
      if (window.escolaDiario) window.escolaDiario("tocou: " + tag);
      currentAudio = audio; currentBtn = btn;
      btn.classList.add("playing");
      btn.innerHTML = PAUSE_SVG;
      tick();
    } else {
      audio.pause();
      btn.classList.remove("playing");
      btn.innerHTML = PLAY_SVG;
    }
  });
  audio.addEventListener("ended", () => {
    btn.classList.remove("playing");
    btn.innerHTML = PLAY_SVG;
    paintWave(canvas, 0);
  });
  canvas.addEventListener("click", (e) => {
    const frac = e.offsetX / canvas.clientWidth;
    audio.currentTime = frac * (canvas._dur || audio.duration || 0);
    paintWave(canvas, frac);
  });
  return row;
}

function stopAllPlayback() {
  if (currentAudio) {
    currentAudio.pause();
    if (currentBtn) { currentBtn.classList.remove("playing"); currentBtn.innerHTML = PLAY_SVG; }
  }
  if (currentMixer) currentMixer.stop();
}

/* ---------- live mixer ---------- */

const dbToGain = db => Math.pow(10, db / 20);

/* ---------- section picker: drag a passage on the full waveform ---------- */

let _pickCtx = null;
const pickCtx = () => _pickCtx ||
  (_pickCtx = new (window.AudioContext || window.webkitAudioContext)());
const _prevCache = {};
function loadPreview(file) {
  if (!_prevCache[file]) {
    _prevCache[file] = fetch(`/api/source/preview?file=${encodeURIComponent(file)}`)
      .then(r => { if (!r.ok) throw new Error("preview failed"); return r.arrayBuffer(); })
      .then(b => pickCtx().decodeAudioData(b));
  }
  return _prevCache[file];
}

function sectionPicker(file, initial, onChange, extraActions = []) {
  const el = document.createElement("div");
  el.className = "section-picker";
  el.innerHTML = `
    <div class="picker-head">
      <span class="side-note">drag across the waveform to choose a passage &middot; tap once to clear (back to auto)</span>
      <span class="picker-time"></span>
      <button class="ghost" data-a="listen">listen</button>
      ${extraActions.map((a, i) => `<button class="ghost" data-x="${i}">${a.label}</button>`).join("")}
    </div>
    <canvas class="pick-wave" height="76"></canvas>
    <div class="picker-load side-note">rendering waveform (first open transcodes the track, a few seconds) ...</div>`;
  const canvas = $("canvas", el), timeEl = $(".picker-time", el);
  let buf = null;
  let sel = { start: initial.start ?? null, end: initial.end ?? null };
  let playing = null;

  const fmt = t => `${Math.floor(t / 60)}:${String((t % 60).toFixed(1)).padStart(4, "0")}`;
  function labels() {
    if (sel.start == null) { timeEl.textContent = "no section picked: automatic"; return; }
    const e = sel.end ?? (buf ? buf.duration : 0);
    timeEl.textContent = `${fmt(sel.start)} to ${fmt(e)}  (${(e - sel.start).toFixed(1)}s)`;
  }
  function draw() {
    if (!buf || !canvas.clientWidth) return;
    const W = canvas.width = canvas.clientWidth * devicePixelRatio;
    const H = canvas.height = 76 * devicePixelRatio;
    const g = canvas.getContext("2d");
    g.clearRect(0, 0, W, H);
    if (sel.start != null) {
      const x0 = sel.start / buf.duration * W;
      const x1 = (sel.end ?? buf.duration) / buf.duration * W;
      g.fillStyle = "rgba(163, 74, 36, 0.18)";
      g.fillRect(x0, 0, x1 - x0, H);
    }
    const data = buf.getChannelData(0), step = Math.ceil(data.length / W);
    g.fillStyle = getComputedStyle(canvas).color;
    for (let x = 0; x < W; x++) {
      let min = 1, max = -1;
      for (let i = x * step; i < (x + 1) * step && i < data.length; i += 32) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (max < min) continue;
      const y0 = (1 - max) / 2 * H, y1 = (1 - min) / 2 * H;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
    if (sel.start != null) {
      const x0 = sel.start / buf.duration * W;
      const x1 = (sel.end ?? buf.duration) / buf.duration * W;
      g.fillStyle = "#a34a24";
      g.fillRect(x0 - 1, 0, 3, H);
      g.fillRect(x1 - 2, 0, 3, H);
    }
    labels();
  }
  loadPreview(file)
    .then(b => { buf = b; $(".picker-load", el).remove(); draw(); })
    .catch(e => { $(".picker-load", el).textContent = `could not load preview: ${e.message}`; });

  const timeAt = ev => {
    const r = canvas.getBoundingClientRect();
    const x = Math.min(Math.max(ev.clientX - r.left, 0), r.width);
    return x / r.width * (buf ? buf.duration : 0);
  };
  let anchor = null;
  canvas.addEventListener("pointerdown", ev => {
    if (!buf) return;
    ev.preventDefault();
    canvas.setPointerCapture(ev.pointerId);
    anchor = timeAt(ev);
    sel = { start: anchor, end: anchor };
    draw();
  });
  canvas.addEventListener("pointermove", ev => {
    if (anchor == null || !buf) return;
    const t = timeAt(ev);
    sel = { start: Math.min(anchor, t), end: Math.max(anchor, t) };
    draw();
  });
  canvas.addEventListener("pointerup", () => {
    if (anchor == null) return;
    anchor = null;
    if ((sel.end ?? 0) - (sel.start ?? 0) < 0.5) sel = { start: null, end: null };
    draw();
    onChange(sel.start, sel.end);
  });
  $("button[data-a=listen]", el).addEventListener("click", ev => {
    if (!buf) return;
    if (playing) { playing.stop(); playing = null; ev.target.textContent = "listen"; return; }
    const src = pickCtx().createBufferSource();
    src.buffer = buf;
    src.connect(pickCtx().destination);
    const s = sel.start ?? 0, e = sel.end ?? buf.duration;
    src.start(0, s, Math.max(0.1, e - s));
    src.onended = () => { playing = null; ev.target.textContent = "listen"; };
    playing = src;
    ev.target.textContent = "stop";
    pickCtx().resume();
  });
  extraActions.forEach((a, i) =>
    $(`button[data-x="${i}"]`, el).addEventListener("click", ev => a.fn(sel, ev.target)));
  el._redraw = draw;
  el._setSel = (s0, e0) => { sel = { start: s0, end: e0 }; draw(); };
  return el;
}

function makeMixer(blendNum, container) {
  const state = { layers: {}, sources: {}, bed: {}, buffers: {},
                  nodes: {}, playing: false, srcNodes: [] };

  async function open() {
    container.innerHTML = '<p class="side-note mixer-loading">loading stems ...</p>';
    const cfg = await (await fetch(`/api/blend/${blendNum}/settings`)).json();
    if (!cfg.manifest) {
      container.innerHTML = '<p class="side-note mixer-loading">no stems yet: press the blend once, then reopen the mixer.</p>';
      return;
    }
    state.cfg = cfg;
    const saved = cfg.saved || {};
    state.bed = Object.assign({ bpm: cfg.manifest.bpm, root: cfg.manifest.root,
                                duck_depth_db: cfg.manifest.duck_depth_db },
                              saved.bed || {});
    state.bed.knobs = (saved.bed && saved.bed.knobs) || {};
    for (const la of cfg.manifest.layers) {
      state.layers[la.name] = Object.assign({}, la, (saved.layers || {})[la.name] || {});
    }
    for (const [key, defs] of Object.entries(cfg.source_defaults)) {
      state.sources[key] = Object.assign({}, defs, (saved.sources || {})[key] || {});
      if (!state.sources[key].file) {
        state.sources[key].file = (cfg.manifest.sources || {})[key] || null;
      }
    }
    await Promise.all(cfg.manifest.layers.map(async la => {
      const res = await fetch(`${cfg.stems_base}/${la.name}.mp3`);
      state.buffers[la.name] = await audioCtx.decodeAudioData(await res.arrayBuffer());
    }));
    build();
  }

  function strip(la) {
    const s = state.layers[la.name];
    const el = document.createElement("div");
    el.className = "strip" + (la.is_source ? " src" : "");
    el.innerHTML = `
      <div class="strip-name">${la.name}</div>
      <div class="strip-btns">
        <button class="mini ${s.mute ? "on" : ""}" data-k="mute">M</button>
        <button class="mini" data-k="solo">S</button>
      </div>
      <label>gain <b data-v="gain">${(+s.gain_db).toFixed(1)}</b>
        <input type="range" min="-24" max="6" step="0.5" value="${s.gain_db}" data-k="gain_db"></label>
      <label>duck <b data-v="duck">${(+(s.duck || 0)).toFixed(2)}</b>
        <input type="range" min="0" max="1" step="0.05" value="${s.duck || 0}" data-k="duck"></label>
      <label>pan <b data-v="pan">${(+s.pan).toFixed(2)}</b>
        <input type="range" min="-1" max="1" step="0.05" value="${s.pan}" data-k="pan"></label>
      <label>hp <b data-v="hp">${s.hp_hz ? Math.round(s.hp_hz) : "off"}</b>
        <input type="range" min="0" max="100" step="1" data-k="hp_hz"
          value="${s.hp_hz ? hzToSlider(s.hp_hz, 20, 2000) : 0}"></label>
      <label>lp <b data-v="lp">${s.lp_hz ? Math.round(s.lp_hz) : "off"}</b>
        <input type="range" min="0" max="100" step="1" data-k="lp_hz"
          value="${s.lp_hz ? hzToSlider(s.lp_hz, 200, 18000) : 100}"></label>`;
    el.querySelectorAll("input").forEach(inp => inp.addEventListener("input", () => {
      const k = inp.dataset.k;
      if (k === "gain_db") {
        s.gain_db = +inp.value;
        $('[data-v=gain]', el).textContent = s.gain_db.toFixed(1);
      } else if (k === "duck") {
        s.duck = +inp.value;
        $('[data-v=duck]', el).textContent = s.duck.toFixed(2);
        if (state.playing) scheduleDuck(la.name);
      } else if (k === "pan") {
        s.pan = +inp.value;
        $('[data-v=pan]', el).textContent = s.pan.toFixed(2);
      } else if (k === "hp_hz") {
        s.hp_hz = +inp.value === 0 ? null : sliderToHz(+inp.value, 20, 2000);
        $('[data-v=hp]', el).textContent = s.hp_hz ? Math.round(s.hp_hz) : "off";
      } else if (k === "lp_hz") {
        s.lp_hz = +inp.value === 100 ? null : sliderToHz(+inp.value, 200, 18000);
        $('[data-v=lp]', el).textContent = s.lp_hz ? Math.round(s.lp_hz) : "off";
      }
      applyNode(la.name);
    }));
    el.querySelector('[data-k=mute]').addEventListener("click", (e) => {
      s.mute = !s.mute;
      e.target.classList.toggle("on", s.mute);
      applyNode(la.name);
    });
    el.querySelector('[data-k=solo]').addEventListener("click", (e) => {
      state.solo = state.solo === la.name ? null : la.name;
      container.querySelectorAll('[data-k=solo]').forEach(b => b.classList.remove("on"));
      if (state.solo) e.target.classList.add("on");
      Object.keys(state.layers).forEach(applyNode);
    });
    return el;
  }

  const hzToSlider = (hz, lo, hi) => Math.round(100 * Math.log(hz / lo) / Math.log(hi / lo));
  const sliderToHz = (v, lo, hi) => Math.round(lo * Math.pow(hi / lo, v / 100));

  function srcParams(key) {
    const s = state.sources[key];
    const files = state.cfg.files.map(f =>
      `<option value="${f}" ${f === s.file ? "selected" : ""}>${f}</option>`).join("");
    const el = document.createElement("div");
    el.className = "src-form";
    el.innerHTML = `
      <div class="strip-name">${key} settings <span class="press-tag">re-press to apply</span></div>
      <label>file <select data-k="file">${files}</select></label>
      <label>stem <select data-k="stem">
        ${["", "drums", "bass", "vocals", "other"].map(st =>
          `<option value="${st}" ${String(s.stem || "") === st ? "selected" : ""}>${st || "full mix"}</option>`).join("")}
      </select></label>
      <label>mode <select data-k="mode">
        ${["auto", "half", "straight", "double", "free"].map(m =>
          `<option ${s.mode === m ? "selected" : ""}>${m}</option>`).join("")}
      </select></label>
      <label>loop start s <input type="number" step="0.1" data-k="start" value="${s.start ?? ""}" placeholder="auto"></label>
      <label>loop end s <input type="number" step="0.1" data-k="end" value="${s.end ?? ""}" placeholder="auto"></label>
      <label>enter bar <input type="number" step="1" data-k="enter_bar" value="${s.enter_bar}"></label>
      <label>fx <select data-k="fx">
        ${["", "delay", "reverb"].map(f =>
          `<option value="${f}" ${String(s.fx || "") === f ? "selected" : ""}>${f || "none"}</option>`).join("")}
      </select></label>
      <label>fx amount <input type="range" min="0" max="1" step="0.05" data-k="fx_amount" value="${s.fx_amount ?? 0.5}"></label>
      <label>delay time <select data-k="delay_time">
        ${[[0.375, "3/16"], [0.5, "8th"], [0.75, "dotted 8th"], [1.0, "1/4"]].map(([v, l]) =>
          `<option value="${v}" ${+(s.delay_time ?? 0.75) === v ? "selected" : ""}>${l}</option>`).join("")}
      </select></label>
      <label class="check"><input type="checkbox" data-k="repitch" ${s.repitch ? "checked" : ""}> repitch (vinyl-style)</label>
      <button type="button" class="ghost pick-btn" data-a="pick">pick section on the waveform</button>`;
    const startInp = $('input[data-k=start]', el), endInp = $('input[data-k=end]', el);
    const PICK_LABEL = "pick section on the waveform";
    const closeDock = () => {
      state.dock.hidden = true;
      state.dock.dataset.for = "";
      state.dock.innerHTML = "";
      container.querySelectorAll("button[data-a=pick]")
        .forEach(b => b.textContent = PICK_LABEL);
    };
    $("button[data-a=pick]", el).addEventListener("click", ev => {
      if (state.dock.dataset.for === key && !state.dock.hidden) { closeDock(); return; }
      closeDock();
      state.dock.dataset.for = key;
      const head = document.createElement("div");
      head.className = "strip-name";
      head.textContent = `${key} · drag the passage this blend should use`;
      state.dock.appendChild(head);
      const picker = sectionPicker(s.file, { start: s.start, end: s.end }, (s0, e0) => {
        s.start = s0; s.end = e0;
        startInp.value = s0 == null ? "" : s0.toFixed(1);
        endInp.value = e0 == null ? "" : e0.toFixed(1);
      });
      state.dock._picker = picker;
      state.dock.appendChild(picker);
      state.dock.hidden = false;
      ev.target.textContent = "hide waveform";
      picker._redraw();
      state.dock.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    el.querySelectorAll("select,input").forEach(inp => inp.addEventListener("change", () => {
      const k = inp.dataset.k;
      if (k === "repitch") s[k] = inp.checked;
      else if (k === "start" || k === "end") {
        s[k] = inp.value === "" ? null : +inp.value;
        if (state.dock.dataset.for === key && state.dock._picker)
          state.dock._picker._setSel(s.start, s.end);
      } else if (k === "enter_bar") s[k] = parseInt(inp.value || "0", 10);
      else if (k === "fx_amount" || k === "delay_time") s[k] = +inp.value;
      else {
        s[k] = inp.value || null;
        if (k === "file" && state.dock.dataset.for === key) closeDock();
      }
    }));
    return el;
  }

  function bedParams() {
    const b = state.bed;
    const notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const roots = [];
    for (const o of [1, 2, 3]) for (const n of notes) roots.push(n + o);
    const el = document.createElement("div");
    el.className = "src-form";
    el.innerHTML = `
      <div class="strip-name">frame settings <span class="press-tag">re-press to apply</span></div>
      <label>bpm <input type="number" step="1" min="100" max="170" data-k="bpm" value="${Math.round(b.bpm)}"></label>
      <label>root <select data-k="root">
        ${roots.map(r => `<option ${b.root === r ? "selected" : ""}>${r}</option>`).join("")}
      </select></label>
      <label>duck depth dB (live) <input type="number" step="1" min="-24" max="0" data-k="duck_depth_db" value="${b.duck_depth_db}"></label>`;
    el.querySelectorAll("input,select").forEach(inp => inp.addEventListener("change", () => {
      b[inp.dataset.k] = inp.dataset.k === "root" ? inp.value : +inp.value;
      if (inp.dataset.k === "duck_depth_db" && state.playing) scheduleAllDucks();
    }));
    return el;
  }

  function frameKnobs() {
    const el = document.createElement("div");
    el.className = "src-form knobs";
    el.innerHTML = `<div class="strip-name">frame knobs <span class="press-tag">re-press to apply</span></div>`;
    for (const kn of state.cfg.bed_knobs) {
      const val = state.bed.knobs[kn.key] ?? kn.default;
      const row = document.createElement("label");
      row.className = "knob-row";
      row.innerHTML = `${kn.label} <b>${val}</b>
        <input type="range" min="${kn.min}" max="${kn.max}" step="${kn.step}" value="${val}">`;
      const inp = row.querySelector("input");
      inp.addEventListener("input", () => {
        state.bed.knobs[kn.key] = +inp.value;
        row.querySelector("b").textContent = inp.value;
      });
      el.appendChild(row);
    }
    return el;
  }

  function build() {
    container.innerHTML = "";
    const bar = document.createElement("div");
    bar.className = "mixer-bar";
    bar.innerHTML = `
      <button class="ghost" data-a="play">play mix</button>
      <button class="ghost" data-a="save">save mix</button>
      <button class="primary" data-a="repress">save + re-press</button>
      <span class="side-note">sliders are live; file/loop/mode/frame changes render on re-press</span>`;
    container.appendChild(bar);
    const strips = document.createElement("div");
    strips.className = "strips";
    for (const la of state.cfg.manifest.layers) strips.appendChild(strip(la));
    container.appendChild(strips);
    state.dock = document.createElement("div");
    state.dock.className = "picker-dock";
    state.dock.hidden = true;
    container.appendChild(state.dock);
    const forms = document.createElement("div");
    forms.className = "forms";
    for (const key of Object.keys(state.sources)) forms.appendChild(srcParams(key));
    forms.appendChild(bedParams());
    forms.appendChild(frameKnobs());
    container.appendChild(forms);
    $('[data-a=play]', bar).addEventListener("click", () => {
      state.playing ? stop() : play(bar);
    });
    $('[data-a=save]', bar).addEventListener("click", async () => {
      await save();
      $("#console").textContent = `blend ${blendNum}: mix saved. It will be used on the next press.`;
    });
    $('[data-a=repress]', bar).addEventListener("click", async () => {
      await save();
      stop();
      runAction(`blend/${blendNum}`);
    });
  }

  function applyNode(name) {
    const n = state.nodes[name];
    if (!n) return;
    const s = state.layers[name];
    const soloMuted = state.solo && state.solo !== name;
    n.gain.gain.value = (s.mute || soloMuted) ? 0 : dbToGain(s.gain_db);
    n.pan.pan.value = s.pan;
    n.hp.frequency.value = s.hp_hz || 10;
    n.lp.frequency.value = s.lp_hz || 20000;
  }

  function scheduleDuck(name) {
    const n = state.nodes[name];
    if (!n) return;
    const s = state.layers[name];
    const g = n.duck.gain;
    const now = audioCtx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(1, now);
    const kicks = state.cfg.manifest.kick_positions_s || [];
    if (!s.duck || !kicks.length) return;
    // The sidechain, client-side: dip to the floor at every kick and
    // recover exponentially. This is the same envelope the server
    // bakes at render time, driven by the live duck + depth values.
    const floor = 1 - s.duck * (1 - dbToGain(state.bed.duck_depth_db));
    const loopLen = state.buffers[name].duration;
    for (let rep = 0; rep < 12; rep++) {
      for (const kp of kicks) {
        const t = state.t0 + rep * loopLen + kp;
        if (t < now - 0.05) continue;
        g.setValueAtTime(1, Math.max(t, now));
        g.linearRampToValueAtTime(floor, Math.max(t, now) + 0.012);
        g.setTargetAtTime(1, Math.max(t, now) + 0.012, 0.07);
      }
    }
  }

  function scheduleAllDucks() {
    Object.keys(state.nodes).forEach(scheduleDuck);
  }

  function play(bar) {
    stopAllPlayback();
    audioCtx.resume();
    const t0 = audioCtx.currentTime + 0.15;
    state.t0 = t0;
    for (const la of state.cfg.manifest.layers) {
      const src = audioCtx.createBufferSource();
      src.buffer = state.buffers[la.name];
      src.loop = true;
      const hp = new BiquadFilterNode(audioCtx, { type: "highpass", Q: 0.7 });
      const lp = new BiquadFilterNode(audioCtx, { type: "lowpass", Q: 0.7 });
      const gain = audioCtx.createGain();
      const duck = audioCtx.createGain();
      const pan = new StereoPannerNode(audioCtx);
      src.connect(hp).connect(lp).connect(gain).connect(duck).connect(pan).connect(audioCtx.destination);
      state.nodes[la.name] = { src, hp, lp, gain, duck, pan };
      applyNode(la.name);
      src.start(t0);
      state.srcNodes.push(src);
    }
    scheduleAllDucks();
    state.playing = true;
    currentMixer = api;
    if (bar) $('[data-a=play]', bar).textContent = "stop";
  }

  function stop() {
    state.srcNodes.forEach(s => { try { s.stop(); } catch (e) {} });
    state.srcNodes = [];
    state.nodes = {};
    state.playing = false;
    const b = container.querySelector('[data-a=play]');
    if (b) b.textContent = "play mix";
  }

  async function save() {
    const layers = {};
    for (const [name, s] of Object.entries(state.layers)) {
      layers[name] = { gain_db: s.gain_db, pan: s.pan, hp_hz: s.hp_hz,
                       lp_hz: s.lp_hz, mute: s.mute, duck: s.duck };
    }
    await fetch(`/api/blend/${blendNum}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bed: state.bed, layers, sources: state.sources }),
    });
  }

  const api = { open, stop };
  return api;
}

/* ---------- state ---------- */

async function refresh() {
  const state = await (await fetch("/api/state")).json();
  renderBlends(state);
  renderAuditions(state.auditions);
  renderCrate(state.analysis);
  document.querySelectorAll("button[data-action]")
    .forEach(b => b.disabled = state.busy);
  try { renderEngine(await (await fetch("/api/pairings")).json()); } catch (e) {}
  try { renderRefs(await (await fetch("/api/references")).json()); } catch (e) {}
  intakeStatus();
}

function renderBlends(state) {
  const list = $("#blend-list");
  list.innerHTML = "";
  for (const b of state.blends) {
    const li = document.createElement("li");
    li.className = "blend-row";
    const missing = b.specs.filter(s => !s.found);
    const status = b.blend ? ["BLEND READY", "ready"]
      : b.bed ? ["BED ONLY", "bedonly"] : ["AGUARDANDO", "waiting"];
    li.innerHTML = `
      <div class="blend-no">0${b.num}</div>
      <div>
        <span class="blend-title">${b.title}</span>
        <span class="blend-meta">${b.bpm} BPM</span>
        <span class="badges">
          <span class="badge ${status[1]}">${status[0]}</span>
          ${b.demo ? '<span class="badge synth">SYNTH DEMO</span>' : ""}
        </span>
        <div class="missing">${missing.map(m =>
          `falta: <b>${m.want}</b> &rarr; sources/${m.folder}/ (${m.acquire})`).join("<br>")}</div>
        <div class="players"></div>
        <div class="row-actions">
          <button class="ghost" data-action="blend" data-num="${b.num}">press blend 0${b.num}</button>
          <button class="ghost" data-mixer="${b.num}">open mixer</button>
        </div>
        <div class="mixer" hidden></div>
      </div>`;
    const players = $(".players", li);
    if (b.blend) players.appendChild(makePlayer("blend", b.blend));
    if (b.bed) players.appendChild(makePlayer("bed", b.bed));
    if (b.demo) players.appendChild(makePlayer("synth demo", b.demo));
    const mixerEl = $(".mixer", li);
    const mixer = makeMixer(b.num, mixerEl);
    $(`button[data-mixer="${b.num}"]`, li).addEventListener("click", (e) => {
      if (mixerEl.hidden) {
        mixerEl.hidden = false;
        e.target.textContent = "close mixer";
        mixer.open();
      } else {
        mixer.stop();
        mixerEl.hidden = true;
        e.target.textContent = "open mixer";
      }
    });
    list.appendChild(li);
  }
  list.querySelectorAll("button[data-action=blend]").forEach(btn =>
    btn.addEventListener("click", () => runAction(`blend/${btn.dataset.num}`)));
}

function renderCrate(analysis) {
  const el = $("#crate-table");
  if (!analysis.length) {
    el.innerHTML = '<p class="side-note" style="padding:16px 0">crate is empty: upload sources or run the acquisition, then re-analyze.</p>';
    return;
  }
  const rows = analysis.map(a => {
    if (a.error) return `<tr><td colspan="8">${fileBase(a.file)} ERROR ${a.error}</td></tr>`;
    const parts = a.warp.split("--");
    const head = a.warp.includes("FLAG")
      ? `<span class="flag">${parts[0]}</span>` : parts[0];
    const fname = a.file.split("/").pop();
    return `<tr>
      <td>${fileBase(a.file)}</td>
      <td class="num">${a.duration_s}s</td>
      <td class="num"><b>${a.bpm}</b></td>
      <td class="num">${a.bpm_half} / ${a.bpm_double}</td>
      <td>${a.key} <span class="camelot">${a.camelot}</span></td>
      <td class="num">${a.beat_cv}</td>
      <td>${head}<span class="warpnote">${parts[1] || ""}</span></td>
      <td><button class="ghost loop-btn" data-loop="${fname}">pick loop</button></td></tr>`;
  }).join("");
  el.innerHTML = `<div class="crate-scroll"><table>
    <thead><tr><th>source</th><th>dur</th><th>bpm</th><th>half / 2x</th>
    <th>key</th><th>beat cv</th><th>warp verdict</th><th>loop</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <div id="crate-dock" class="picker-dock" hidden></div>
    <p class="side-note" style="padding-top:8px">pick loop = choose this track's default passage on its waveform.
    Blends without an explicit section (and the pairing engine) use it after the next press.</p>`;
  const dock = $("#crate-dock", el);
  const closeDock = () => {
    dock.hidden = true;
    dock.dataset.for = "";
    dock.innerHTML = "";
    el.querySelectorAll("button[data-loop]").forEach(b => b.textContent = "pick loop");
  };
  el.querySelectorAll("button[data-loop]").forEach(btn =>
    btn.addEventListener("click", async () => {
      const file = btn.dataset.loop;
      if (dock.dataset.for === file && !dock.hidden) { closeDock(); return; }
      closeDock();
      dock.dataset.for = file;
      btn.textContent = "close";
      let init = { start: null, end: null };
      try {
        const r = await (await fetch(`/api/source/loop?file=${encodeURIComponent(file)}`)).json();
        init = { start: r.start > 0 || r.end ? r.start : null, end: r.end };
      } catch (e) {}
      const head = document.createElement("div");
      head.className = "strip-name";
      head.textContent = `${fileBase(file)} · drag this track's default passage, then save`;
      dock.appendChild(head);
      dock.appendChild(sectionPicker(file, init, () => {}, [{
        label: "save loop",
        fn: async (sel, saveBtn) => {
          const res = await fetch("/api/source/loop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file, start: sel.start ?? 0, end: sel.end }),
          });
          saveBtn.textContent = res.ok ? "saved" : "save failed";
          setTimeout(() => { saveBtn.textContent = "save loop"; }, 2000);
        },
      }]));
      dock.hidden = false;
      dock.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }));
}

function renderEngine(pairings) {
  const el = $("#engine-list");
  if (!el) return;
  if (!pairings.length) {
    el.innerHTML = '<p class="side-note" style="padding:16px 0">no pairings yet: analyze sources first, then re-run the engine.</p>';
    return;
  }
  const shown = pairings.slice(0, 14);
  el.innerHTML = shown.map((p, i) => `
    <div class="pairing">
      <div class="pair-score">${p.score}</div>
      <div>
        <div class="pair-line">${p.source} <b>&rarr;</b> ${p.bed} <span class="blend-meta">${p.plan}</span></div>
        <div class="pair-why">${p.why}</div>
      </div>
      <button class="ghost aud-btn" data-aud="${i}"
        title="press a quick test of this pairing; it lands under Auditions in Lado A">audition &darr;</button>
    </div>`).join("");
  el.querySelectorAll("button[data-aud]").forEach(b =>
    b.addEventListener("click", async () => {
      const p = shown[b.dataset.aud];
      b.disabled = true;
      b.textContent = "pressing ...";
      try {
        const res = await fetch("/api/run/audition", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bed: p.bed_num, source: p.source }),
        });
        if (!res.ok) throw new Error((await res.json()).detail);
        b.textContent = "pressing (about a minute) ...";
        if (window.escolaEmit) window.escolaEmit("app-press");
        if (window.escolaDiario) window.escolaDiario(`audicao: bed ${p.bed_num} + ${String(p.source).split("/").pop()}`);
        pollJobs();
      } catch (e) {
        b.disabled = false;
        b.textContent = "audition failed, retry?";
        $("#console").textContent = `audition error: ${e.message}`;
      }
    }));
}

function renderAuditions(auds) {
  const el = $("#auditions");
  if (!el) return;
  if (!auds || !auds.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="aud-head">
      <h3>Auditions</h3>
      <span class="side-note">test presses from The Engine &middot;
        adopt = this source takes over that blend (full press, editable in the mixer)
        &middot; discard just deletes the test</span>
    </div>` +
    auds.map((a, i) => `
    <div class="aud-card" data-i="${i}">
      <div class="aud-title"><b>${a.source}</b> over ${a.bed_title} &middot; ${a.bpm} BPM</div>
      <div class="aud-player"></div>
      <div class="row-actions">
        <button class="ghost" data-adopt="${i}">adopt as blend 0${a.bed}</button>
        <button class="ghost" data-discard="${i}">discard</button>
      </div>
    </div>`).join("");
  auds.forEach((a, i) =>
    $(`.aud-card[data-i="${i}"] .aud-player`, el).appendChild(makePlayer("audition", a.urls)));
  el.querySelectorAll("button[data-adopt]").forEach(b =>
    b.addEventListener("click", async () => {
      const a = auds[b.dataset.adopt];
      b.disabled = true;
      b.textContent = "adopting: re-pressing the real blend ...";
      const res = await fetch(`/api/blend/${a.bed}/adopt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: a.source }),
      });
      if (res.ok) pollJobs();
      else { b.disabled = false; b.textContent = "adopt failed, retry?"; }
    }));
  el.querySelectorAll("button[data-discard]").forEach(b =>
    b.addEventListener("click", async () => {
      const a = auds[b.dataset.discard];
      b.disabled = true;
      await fetch(`/api/audition?bed=${a.bed}&source=${encodeURIComponent(a.source)}`,
        { method: "DELETE" });
      refresh();
    }));
}

function renderRefs(refs) {
  const el = $("#ref-list");
  if (!el) return;
  el.innerHTML = refs.map(r => `
    <div class="ref-item">
      <span class="who">${r.artist}</span> ${r.track}
      ${r.match ? `<span class="link-tag">${r.match}</span>` : ""}
      <span class="why-ref">${r.why || ""}</span>
    </div>`).join("");
}

const fileBase = f => f.split("/").pop().replace(/\.(wav|mp3|flac|m4a)$/, "");

/* ---------- actions + console ---------- */

async function runAction(action) {
  try {
    const res = await fetch(`/api/run/${action}`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).detail);
    if (window.escolaEmit && action.startsWith("blend/")) window.escolaEmit("app-press");
    if (window.escolaDiario && action.startsWith("blend/")) window.escolaDiario("prensou: " + action.replace("/", " "));
    pollJobs();
  } catch (e) {
    $("#console").textContent = `error: ${e.message}`;
  }
}

let polling = false;
async function pollJobs() {
  if (polling) return;
  polling = true;
  const consoleEl = $("#console");
  while (true) {
    const jobs = await (await fetch("/api/jobs")).json();
    const last = jobs[jobs.length - 1];
    if (last) {
      consoleEl.textContent = `[${last.action}] ${last.status}\n${last.log}`;
      consoleEl.scrollTop = consoleEl.scrollHeight;
      if (last.status !== "running") break;
    } else break;
    await new Promise(r => setTimeout(r, 1500));
  }
  polling = false;
  refresh();
}

document.querySelectorAll("button[data-action=analyze]").forEach(b =>
  b.addEventListener("click", () => runAction("analyze")));
document.querySelectorAll("button[data-action=beds]").forEach(b =>
  b.addEventListener("click", () => runAction("beds")));
const engineBtn = document.querySelector("button[data-action=engine]");
if (engineBtn) engineBtn.addEventListener("click", () => runAction("engine"));

$("#file-input").addEventListener("change", async (e) => {
  const folder = $("#folder-select").value;
  for (const file of e.target.files) {
    const fd = new FormData();
    fd.append("folder", folder);
    fd.append("file", file);
    $("#console").textContent = `uploading ${file.name} -> sources/${folder}/ ...`;
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    $("#console").textContent = res.ok
      ? `saved ${file.name} -> sources/${folder}/. Run re-analyze, then press the blend.`
      : `upload failed: ${(await res.json()).detail}`;
  }
  refresh();
});

/* ---------- intake (Lado C): find -> pick the upload -> pull ---------- */

const INTAKE_SHELVES = [
  ["cosmic", "cosmic: pads & psychedelia"],
  ["rhythmic", "rhythmic: full-band grooves"],
  ["lush", "lush: vocals & strings"],
  ["percussion", "percussion: drums & batucada"],
];
const esc = s => String(s ?? "").replace(/[&<>"]/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtDur = sec => sec
  ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}` : "?";
const fmtViews = v => !v ? "" : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M views`
  : v >= 1e3 ? `${Math.round(v / 1e3)}K views` : `${v} views`;

let intakeTab = "spotify";
let lastSpotify = null;   // cached step-1 results for "back"

function setIntakeTab(t) {
  intakeTab = t;
  document.querySelectorAll(".intake-tabs .tab").forEach(b =>
    b.classList.toggle("active", b.dataset.intake === t));
  $("#intake-q").placeholder =
    t === "youtube" ? "search youtube for anything ..."
      : t === "liked" ? "your liked songs load by themselves, newest first"
        : "search your spotify: track, artist, album ...";
  $("#intake-q").disabled = t === "liked";
}

function intakeMsg(html) {
  $("#intake-results").innerHTML =
    `<p class="side-note" style="padding:12px 0">${html}</p>`;
}

function showContext(html) {
  $("#intake-context").innerHTML = html
    ? `<div class="intake-ctx">${html}</div>` : "";
}

async function intakeSearch(kind) {
  const q = $("#intake-q").value.trim();
  if (kind !== "liked" && !q) {
    intakeMsg("type something above, then hit search.");
    return;
  }
  intakeMsg(kind === "liked" ? "loading your liked songs ..." : `searching ${kind} ...`);
  try {
    if (kind === "youtube") {
      const d = await (await fetch(
        `/api/intake/youtube/search?q=${encodeURIComponent(q)}`)).json();
      renderYt(d.videos || []);
    } else {
      const url = kind === "liked" ? "/api/intake/spotify/liked"
        : `/api/intake/spotify/search?q=${encodeURIComponent(q)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error((await res.json()).detail);
      const tracks = (await res.json()).tracks || [];
      lastSpotify = tracks;
      showContext(null);
      renderSpotify(tracks);
    }
  } catch (e) { intakeMsg(`intake error: ${esc(e.message)}`); }
}

function findOnYoutube(artist, title) {
  const q = `${(artist || "").split(",")[0]} ${title}`;
  $("#intake-q").value = q;
  showContext(`<b>step 2</b> &middot; choose which youtube upload of
    <b>${esc(title)}</b> (${esc((artist || "").split(",")[0])}) to rip
    ${lastSpotify ? '<button class="ghost" id="ctx-back">&larr; back to spotify results</button>' : ""}`);
  const back = $("#ctx-back");
  if (back) back.addEventListener("click", () => {
    showContext(null);
    renderSpotify(lastSpotify);
  });
  intakeSearch("youtube");
}

function renderSpotify(tracks) {
  if (!tracks.length) return intakeMsg("nothing found.");
  $("#intake-results").innerHTML = tracks.map((t, i) => `
    <div class="intake-row">
      ${t.art ? `<img class="intake-art" src="${esc(t.art)}" alt="" loading="lazy">`
              : `<div class="intake-art"></div>`}
      <div class="intake-meta">
        <b>${esc(t.title)}</b>
        <span>${esc(t.artist)}${t.album ? ` &middot; ${esc(t.album)}` : ""}</span>
      </div>
      <span class="intake-dur">${fmtDur((t.duration_ms || 0) / 1000)}</span>
      <button class="ghost" data-find="${i}">find on youtube &rarr;</button>
    </div>`).join("");
  document.querySelectorAll("#intake-results [data-find]").forEach(b =>
    b.addEventListener("click", () => {
      const t = tracks[b.dataset.find];
      findOnYoutube(t.artist, t.title);
    }));
}

function renderYt(videos) {
  if (!videos.length) return intakeMsg("nothing found.");
  $("#intake-results").innerHTML = videos.map((v, i) => `
    <div class="intake-row">
      <div class="intake-meta">
        <b>${esc(v.title)}</b>
        <span>${esc(v.channel)}${v.views ? ` &middot; ${fmtViews(v.views)}` : ""}</span>
      </div>
      <span class="intake-dur">${fmtDur(v.duration)}</span>
      <select data-folder="${i}" title="which shelf of the crate this lands on">
        ${INTAKE_SHELVES.map(([val, label]) =>
          `<option value="${val}"${val === "rhythmic" ? " selected" : ""}>${label}</option>`).join("")}
      </select>
      <button class="ghost primary" data-pull="${i}">pull &darr;</button>
    </div>`).join("");
  document.querySelectorAll("#intake-results [data-pull]").forEach(b =>
    b.addEventListener("click", () => {
      const i = b.dataset.pull;
      const folder = document.querySelector(`#intake-results [data-folder="${i}"]`).value;
      intakePull(videos[i], folder, b);
    }));
}

async function intakePull(video, folder, btn) {
  btn.disabled = true;
  const card = $("#intake-status");
  try {
    const res = await fetch("/api/intake/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: video.url, folder }),
    });
    if (!res.ok) throw new Error((await res.json()).detail);
  } catch (e) {
    card.innerHTML = `<div class="pull-card fail">could not start the pull: ${esc(e.message)}</div>`;
    btn.disabled = false;
    return;
  }
  card.innerHTML = `<div class="pull-card"><b>pulling</b> ${esc(video.title)}
    &rarr; ${esc(folder)} shelf <span class="pull-live">starting ...</span></div>`;
  while (true) {
    await new Promise(r => setTimeout(r, 1500));
    const jobs = await (await fetch("/api/jobs")).json();
    const j = jobs[jobs.length - 1];
    if (!j) break;
    const lines = j.log.split("\n").map(l => l.trim()).filter(Boolean);
    if (j.status === "running") {
      $(".pull-live", card).textContent = lines[lines.length - 1] || "working ...";
      continue;
    }
    if (j.status === "done") {
      const verdict = lines.find(l => /BPM/.test(l) && /beat cv/.test(l)) || "";
      const bi = lines.indexOf("best frames for this track:");
      const best = bi >= 0 ? lines.slice(bi + 1, bi + 4).join("<br>") : "";
      card.innerHTML = `<div class="pull-card ok">
        <b>in the crate</b> &middot; ${esc(video.title)} landed on the ${esc(folder)} shelf<br>
        <span class="mono">${esc(verdict)}</span>
        ${best ? `<br><b>best frames:</b><br><span class="mono">${best}</span>` : ""}
        <br><button class="ghost" id="pull-goto">see it in Lado B</button></div>`;
      $("#pull-goto").addEventListener("click", () =>
        $("#crate").scrollIntoView({ behavior: "smooth" }));
    } else {
      card.innerHTML = `<div class="pull-card fail"><b>pull failed</b><br>
        <span class="mono">${esc(lines.slice(-3).join(" / "))}</span></div>`;
    }
    break;
  }
  btn.disabled = false;
  refresh();
}

async function intakeStatus() {
  const el = $("#now-playing");
  if (!el) return;
  try {
    const st = await (await fetch("/api/intake/status")).json();
    const np = st.now_playing;
    if (np && np.is_playing) {
      el.innerHTML = `<div class="np-chip">
        ${np.album_art ? `<img src="${esc(np.album_art)}" alt="">` : ""}
        <span>on spotify right now: <b>${esc(np.track)}</b> &middot; ${esc(np.artist)}</span>
        <button class="ghost" id="np-find">find on youtube &rarr;</button></div>`;
      $("#np-find").addEventListener("click", () => {
        lastSpotify = null;
        findOnYoutube(np.artist, np.track);
      });
    } else if (!st.taste) {
      el.innerHTML = `<div class="np-chip muted">taste engine unreachable
        &middot; spotify browsing is offline, youtube still works</div>`;
    } else if (!st.spotify) {
      el.innerHTML = `<div class="np-chip muted">spotify not connected
        &middot; authorize once at taste.library.icu</div>`;
    } else {
      el.innerHTML = "";
    }
  } catch (e) { el.innerHTML = ""; }
}

document.querySelectorAll(".intake-tabs .tab").forEach(b =>
  b.addEventListener("click", () => {
    setIntakeTab(b.dataset.intake);
    if (b.dataset.intake === "liked") intakeSearch("liked");
    else if ($("#intake-q").value.trim()) intakeSearch(b.dataset.intake);
  }));
$("#intake-go").addEventListener("click", () => intakeSearch(intakeTab));
$("#intake-q").addEventListener("keydown", e => {
  if (e.key === "Enter") intakeSearch(intakeTab);
});
setIntakeTab("spotify");

refresh();
pollJobs();

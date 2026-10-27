// A Cabine: turn a carried track into what a deck plays.
//
// loadTrack(ctx, source, file) -> {pcm: {left, right, sampleRate}, grid, meta, hotCues}
//
// `source` is where the bytes come from: networkSource() below fetches the
// gated /api/cabine/* routes (proof page, crate); the store (Task 8) offers
// the same three methods from IndexedDB for offline play.
//
// The MP3 is decoded with ctx.decodeAudioData (resampled to the context
// rate), converted to int16 planar right away, and the AudioBuffer is
// dropped, so a 15-minute track costs ~160 MB instead of ~320 MB. The PCM
// buffers are meant to be transferred to the worklet (DeckVoice.load).

const YIELD_EVERY = 1 << 20;          // samples between yields to the event loop

/** Source over the dj-lab HTTP API (needs the dj_auth cookie). */
export function networkSource(base = "") {
  let library = null;
  const q = (file) => encodeURIComponent(file);
  return {
    async getMp3(file) {
      const r = await fetch(`${base}/api/cabine/carry?file=${q(file)}`, { credentials: "same-origin" });
      if (!r.ok) throw new Error(`carry ${file}: HTTP ${r.status}`);
      return r.arrayBuffer();
    },
    async getGrid(file) {
      const r = await fetch(`${base}/api/cabine/grid?file=${q(file)}`, { credentials: "same-origin" });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`grid ${file}: HTTP ${r.status}`);
      return r.json();
    },
    async getMeta(file) {
      if (!library) {
        library = fetch(`${base}/api/cabine/library`, { credentials: "same-origin" })
          .then((r) => {
            if (!r.ok) throw new Error(`library: HTTP ${r.status}`);
            return r.json();
          })
          .catch((e) => { library = null; throw e; });
      }
      const { tracks } = await library;
      return tracks.find((t) => t.file === file) || { file };
    },
  };
}

const pause = () => new Promise((r) => setTimeout(r, 0));

/** float32 [-1, 1] -> int16, clamped and rounded, yielding now and then. */
export async function floatToInt16(f32) {
  const n = f32.length;
  const out = new Int16Array(n);
  for (let start = 0; start < n; start += YIELD_EVERY) {
    const end = Math.min(n, start + YIELD_EVERY);
    for (let i = start; i < end; i++) {
      const v = f32[i] * 32767;
      out[i] = v >= 32767 ? 32767 : v <= -32768 ? -32768 : (v < 0 ? v - 0.5 : v + 0.5) | 0;
    }
    if (end < n) await pause();
  }
  return out;
}

/** AudioBuffer -> planar int16 stereo (mono is copied to both sides). */
export async function audioBufferToPcm(buf) {
  const left = await floatToInt16(buf.getChannelData(0));
  const right = buf.numberOfChannels > 1
    ? await floatToInt16(buf.getChannelData(1))
    : new Int16Array(left);                  // own buffer: both get transferred
  return { left, right, sampleRate: buf.sampleRate };
}

export async function loadTrack(ctx, source, file) {
  const [mp3, grid, meta] = await Promise.all([
    source.getMp3(file),
    source.getGrid(file),
    source.getMeta(file),
  ]);
  let decoded = await ctx.decodeAudioData(mp3);
  const pcm = await audioBufferToPcm(decoded);
  decoded = null;                            // drop the float copy now
  const offset = meta && Number.isFinite(meta.carry_offset_s) ? meta.carry_offset_s : 0;
  const g = grid ? { ...grid, offset_s: offset } : null;
  return { pcm, grid: g, meta: meta || { file }, hotCues: new Array(8).fill(null) };
}

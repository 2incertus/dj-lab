// A Cabine: turn a carried track into what a deck plays.
//
// loadTrack(ctx, source, file, opts) -> {pcm: {left, right, sampleRate}, grid,
//   meta, hotCues, peaks, gapless}
//
// `source` is where the bytes come from: networkSource() below fetches the
// gated /api/cabine/* routes (proof page, crate); the store (Task 8) offers
// the same methods from IndexedDB for offline play (store.js storeSource,
// which adds getHotCues and getPeaks; both are optional here).
//
// Decode (ruling R19, Task 10). The MP3 is decoded in its own
// OfflineAudioContext(2, 1, DECODE_RATE): the carried file's own 44.1 kHz,
// so nothing is upsampled to the phone's 48 kHz (the worklet resamples as
// it plays). It is converted to int16 planar right away and the AudioBuffer
// dropped, so a 15-minute track costs ~160 MB instead of ~320 MB. The PCM
// buffers are meant to be transferred to the worklet (DeckVoice.load). The
// caller unloads the target deck before calling this (Deck.unload), so a
// swap never holds the old and the new track at once.
//
// Gapless guard. A carried MP3 starts with the encoder delay (576 frames from
// libmp3lame, plus 529 of decoder delay = 1105) and ends with padding up to
// one frame (1152). Browsers that read the LAME/Info header drop both; one
// that does not hands back the whole thing, and every beat would land 25 ms
// late. meta.samples is the source's exact frame count (cabine.py), so the
// loader compares: equal = nothing to do; longer by the head delay plus up
// to a frame of padding = trim both ends (the LAME header's own delay is used
// when it can be read); longer by less than the head delay = the decoder
// dropped the delay but not the padding, trim the tail; anything else is
// left alone and logged. Trimming exactly leaves no residual, so grid.offset_s
// stays meta.carry_offset_s; that offset is the hook for any residual a phone
// turns out to have.

export const DECODE_RATE = 44100;
/** mpg123 / libmad decoder delay, added to the encoder's (LAME convention). */
export const LAME_DECODER_DELAY = 529;
/** libmp3lame's encoder delay (576) + the decoder delay, at 44.1 kHz. */
export const DEFAULT_GAPLESS_HEAD = 576 + LAME_DECODER_DELAY;
export const GAPLESS_FRAME = 1152;
const GAPLESS_SLACK = 64;             // frames of tolerance either side of the window

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

/** Size of an ID3v2 tag at the start (0 if none). */
function id3Size(b) {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  return 10 + size + (b[5] & 0x10 ? 10 : 0);
}

/** The encoder delay and padding from the first frame's Xing/Info tag and
 *  its LAME extension (written by libmp3lame and by ffmpeg, whose encoder
 *  string reads "Lavc..."), or null when there is none. */
export function parseLameGapless(buf) {
  const b = new Uint8Array(buf, 0, Math.min(buf.byteLength, 16384));
  const f = id3Size(b);
  if (f + 4 > b.length || b[f] !== 0xff || (b[f + 1] & 0xe0) !== 0xe0) return null;
  const mpeg1 = (b[f + 1] & 0x18) === 0x18;
  const mono = (b[f + 3] & 0xc0) === 0xc0;
  const x = f + 4 + (mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17));
  if (x + 8 > b.length) return null;
  const tag = String.fromCharCode(b[x], b[x + 1], b[x + 2], b[x + 3]);
  if (tag !== "Xing" && tag !== "Info") return null;
  const flags = (b[x + 4] << 24) | (b[x + 5] << 16) | (b[x + 6] << 8) | b[x + 7];
  let o = x + 8;
  if (flags & 1) o += 4;
  if (flags & 2) o += 4;
  if (flags & 4) o += 100;
  if (flags & 8) o += 4;
  if (o + 24 > b.length) return null;
  for (let i = 0; i < 4; i++) if (b[o + i] < 0x20 || b[o + i] > 0x7e) return null;   // encoder string
  const delay = (b[o + 21] << 4) | (b[o + 22] >> 4);
  const padding = ((b[o + 22] & 0x0f) << 8) | b[o + 23];
  return { delay, padding };
}

/**
 * What to cut from a decode of `decoded` frames whose source has `samples`
 * frames (both at DECODE_RATE). lame: {delay, padding} from the header or null.
 * @returns {head, tail, action: "exact" | "trimmed" | "padding" | "mismatch" | "unknown", excess}
 */
export function gaplessTrim(decoded, samples, lame = null) {
  if (!(samples > 0)) return { head: 0, tail: 0, action: "unknown", excess: null };
  const excess = decoded - samples;
  if (excess === 0) return { head: 0, tail: 0, action: "exact", excess };
  const head = lame ? lame.delay + LAME_DECODER_DELAY : DEFAULT_GAPLESS_HEAD;
  if (excess >= head - GAPLESS_SLACK && excess <= head + GAPLESS_FRAME + GAPLESS_SLACK) {
    const h = Math.min(head, excess);
    return { head: h, tail: excess - h, action: "trimmed", excess };
  }
  if (excess > 0 && excess <= GAPLESS_FRAME + GAPLESS_SLACK && excess < head - GAPLESS_SLACK) {
    return { head: 0, tail: excess, action: "padding", excess };
  }
  return { head: 0, tail: 0, action: "mismatch", excess };
}

function offlineDecoder() {
  return typeof OfflineAudioContext !== "undefined" ? new OfflineAudioContext(2, 1, DECODE_RATE) : null;
}

/** AudioBuffer frames [head, length - tail) -> planar int16 stereo. */
async function bufferToPcm(buf, head, tail) {
  const end = buf.length !== undefined ? buf.length - tail : buf.getChannelData(0).length - tail;
  const ch = (i) => buf.getChannelData(i).subarray(head, end);
  const left = await floatToInt16(ch(0));
  const right = buf.numberOfChannels > 1 ? await floatToInt16(ch(1)) : new Int16Array(left);
  return { left, right, sampleRate: buf.sampleRate };
}

/**
 * @param ctx     the live context (used to decode only when no
 *                OfflineAudioContext exists, i.e. in Node tests)
 * @param opts    {decodeCtx: a context with decodeAudioData (default: a fresh
 *                OfflineAudioContext at DECODE_RATE), log: (message) => void}
 */
export async function loadTrack(ctx, source, file, opts = {}) {
  const log = opts.log || ((m) => console.info(m));
  const [mp3, grid, meta, hotCues] = await Promise.all([
    source.getMp3(file),
    source.getGrid(file),
    source.getMeta(file),
    typeof source.getHotCues === "function" ? source.getHotCues(file).catch(() => null) : null,
  ]);
  const peaks = typeof source.getPeaks === "function" ? await source.getPeaks(file).catch(() => null) : null;
  const lame = parseLameGapless(mp3);           // before decoding: Safari detaches mp3
  const decoder = opts.decodeCtx || offlineDecoder() || ctx;
  let decoded = await decoder.decodeAudioData(mp3);
  const frames = decoded.length !== undefined ? decoded.length : decoded.getChannelData(0).length;
  const scale = decoded.sampleRate / DECODE_RATE;
  const samples = meta && meta.samples > 0 ? Math.round(meta.samples * scale) : null;
  const g = gaplessTrim(frames, samples, scale === 1 ? lame : null);
  const name = (meta && meta.file) || file;
  if (g.action === "trimmed" || g.action === "padding") {
    log(`gapless guard: ${name}: decode ${frames} frames, source ${samples}: trimmed head ${g.head} + tail ${g.tail}`
      + (lame ? ` (LAME delay ${lame.delay}, padding ${lame.padding})` : " (no LAME header, default delay)"));
  } else if (g.action === "mismatch") {
    log(`gapless guard: ${name}: decode ${frames} frames, source ${samples}: ${g.excess} frames off, left as is`);
  }
  const pcm = await bufferToPcm(decoded, g.head, g.tail);
  decoded = null;                            // drop the float copy now
  const offset = meta && Number.isFinite(meta.carry_offset_s) ? meta.carry_offset_s : 0;
  const gr = grid ? { ...grid, offset_s: offset } : null;
  const cues = new Array(8).fill(null);
  if (Array.isArray(hotCues)) for (let i = 0; i < 8; i++) cues[i] = hotCues[i] || null;
  return { pcm, grid: gr, meta: meta || { file }, hotCues: cues, peaks: peaks || null,
    gapless: { ...g, decoded: frames, samples } };
}

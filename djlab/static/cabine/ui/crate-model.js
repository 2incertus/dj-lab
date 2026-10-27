// A Cabine crate: the pure parts (formatting, the merged track list, the
// beat-1 tap time). No DOM, so node --test covers them.

const MB = 1024 * 1024;

export function formatBytes(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "?";
  if (n >= 1024 * MB) return `${(n / (1024 * MB)).toFixed(2)} GB`;
  if (n === 0) return "0 MB";
  if (n < MB) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / MB).toFixed(1)} MB`;
}

export function formatDuration(s) {
  if (s === null || s === undefined || !Number.isFinite(s)) return "?:??";
  const whole = Math.floor(s);
  const m = Math.floor(whole / 60);
  return `${m}:${String(whole - m * 60).padStart(2, "0")}`;
}

export function formatBpm(bpm) {
  return Number.isFinite(bpm) ? bpm.toFixed(2) : "?";
}

/**
 * One row per track: the server library in its order (newest first), each
 * joined with what the phone holds, then tracks only the phone still has
 * (removed from the server, or the server is unreachable: `server` null).
 */
export function mergeLibrary(server, carried) {
  const byFile = new Map((carried || []).map((e) => [e.file, e]));
  const rows = [];
  const row = (file, meta, entry, onServer) => ({
    file,
    title: meta.title || file,
    folder: meta.folder || "",
    bpm: meta.bpm ?? null,
    camelot: meta.camelot || "",
    duration_s: meta.duration_s ?? null,
    beat_cv: meta.beat_cv ?? null,
    onPhone: !!entry,
    onServer,
    bytes: entry ? entry.bytes : (meta.carry_bytes ?? null),
    grid: entry ? entry.grid : (meta.grid || null),
    gridPending: !!entry && !entry.grid,
    meta,
  });
  for (const t of server || []) {
    rows.push(row(t.file, t, byFile.get(t.file), true));
    byFile.delete(t.file);
  }
  for (const e of byFile.values()) rows.push(row(e.file, e.meta || { file: e.file }, e, false));
  return rows;
}

/** The YouTube query for a Spotify pick: first credited artist + title. */
export function uploadQuery(t) {
  const artist = String(t.artist || "").split(",")[0].trim();
  return [artist, String(t.title || "").trim()].filter(Boolean).join(" ");
}

/**
 * "This is beat 1": the source time he heard when he tapped. What comes out
 * of the speaker now left the deck output+base latency ago (150 to 250 ms on
 * Bluetooth), and the grid lives in source time (the carried file sits
 * offset_s later), so both come off. Never negative.
 */
export function tapToSourceTime(deck, ctx, grid) {
  const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
  const pos = deck.posAt(ctx.currentTime - lat);
  const off = grid && Number.isFinite(grid.offset_s) ? grid.offset_s : 0;
  return Math.max(0, pos - off);
}

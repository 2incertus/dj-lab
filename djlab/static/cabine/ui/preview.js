// A Cabine crate: the grid-fix preview. Plays the CARRIED mp3 through the
// same path a deck uses (loadTrack -> Deck + DeckVoice worklet), out of the
// phone speaker, so a "this is beat 1" tap lands where the deck will play.

import { Deck } from "../engine/deck.js";
import { DeckVoice } from "../engine/deck-voice.js";
import { loadTrack } from "../engine/loader.js";
import { storeSource } from "../store.js";
import { tapToSourceTime } from "./crate-model.js";

export class Preview {
  constructor(store) {
    this.source = storeSource(store);
    this.ctx = null;
    this.voice = null;
    this.deck = null;
    this.track = null;
    this.file = null;
  }

  /** Call from a tap (iOS starts audio only inside a user gesture). */
  _context() {
    if (!this.ctx) {
      if (navigator.audioSession) {
        try { navigator.audioSession.type = "playback"; } catch (e) { /* older Safari */ }
      }
      this.ctx = new AudioContext({ latencyHint: "interactive" });
    }
    return this.ctx;
  }

  get playing() { return !!(this.deck && this.deck.state.playing); }

  async start(file) {
    const ctx = this._context();
    const resumed = ctx.resume();
    if (!this.voice) {
      this.voice = await DeckVoice.create(ctx);
      this.voice.connect(ctx.destination);
      this.deck = new Deck(this.voice, { now: () => ctx.currentTime });
    }
    await resumed;
    if (this.file !== file) {
      if (this.deck.state.playing) this.deck.playPause();
      this.track = await loadTrack(ctx, this.source, file);
      this.deck.load(this.track);
      this.file = file;
    }
    if (!this.deck.state.playing) this.deck.playPause();
  }

  pause() {
    if (this.deck && this.deck.state.playing) this.deck.playPause();
  }

  /** Source seconds of what is coming out of the speaker right now. */
  tapTime() {
    if (!this.deck || !this.ctx) return null;
    return tapToSourceTime(this.deck, this.ctx, this.track && this.track.grid);
  }

  /** Carried-file seconds at the speaker (for the beat lights). */
  heardPos() {
    if (!this.deck || !this.ctx) return null;
    const lat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return this.deck.posAt(this.ctx.currentTime - lat);
  }

  /** After a fix: the preview's beat lights follow the new grid. */
  setGrid(grid) {
    if (!this.track || !grid) return;
    const g = this.track.grid;
    const off = g && Number.isFinite(g.offset_s) ? g.offset_s : 0;
    this.track.grid = { ...grid, offset_s: off };
    if (this.deck) this.deck.grid = this.track.grid;
  }

  /** Stop and let go of the decoded track (the phone's memory). */
  async close() {
    this.pause();
    if (this.voice) this.voice.disconnect();
    this.voice = null;
    this.deck = null;
    this.track = null;
    this.file = null;
    if (this.ctx && this.ctx.state === "running") {
      try { await this.ctx.suspend(); } catch (e) { /* closed */ }
    }
  }
}


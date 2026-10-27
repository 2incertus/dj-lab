# dj-lab

Brasil x Maquina. A studio for blending Brazilian music with techno: a crate of samba,
choro, frevo and afrosambas on one side, seven synthesized techno frames on the other,
and a live console where the two meet.

## What it does

**The blends.** Seven recipes pair a source track with a techno frame. Each recipe names
its layers, the Demucs stem each layer pulls from, and how they sit against each other:
Evinha's voice over a rolling frame, a pandeiro pattern driving the kick, a cavaquinho
answering a stab. The server renders the blend with numpy and pedalboard (sidechain
ducking, a master bus, peak normalization), and also writes every layer out raw so the
browser can rebuild the mix live. You move a fader in the page and you are re-mixing the
real signal, not scrubbing a bounce.

**A Mesa.** A live console of ten modules that all sound together on a shared transport,
synthesized in the browser with the Web Audio API:

| | | |
|---|---|---|
| 01 A Grade (rhythm) | 02 O Sintetizador (synthesis) | 03 A Roda (harmony) |
| 04 O Warp (tempo) | 05 O Pulso (dj) | 06 O Duck (mix) |
| 07 As Bandas (mix) | 08 A Voz (voice) | 09 O Controlador (midi) |
| 10 O Loop (loop) | | |

Every module sounds through its own named channel into a master bus with a brick limiter,
so you can kill a channel mid-jam without stopping anything else. Clocked modules phase
lock to one grid instead of flamming. The console records the master bus to WAV and
archives the take, and a pressing saves the state of every open module so you can bring a
jam back.

The desk has four surfaces:

**Máquinas** holds the machines. A Grade carries four pattern banks and a scene field, so
you can type `A A B A` and the grid turns the page on the bar line. O Sintetizador carries
O Rolo underneath it, a piano roll locked to a root and a scale that plays the synth for
you instead of asking you to hold keys.

**Discos** is the crate: intake, the vocal channel, the wheel of keys, the warp.

**Mistura** is a real mixer. Every channel gets a strip with a fader, pan, mute, solo and a
post-fader meter, plus sends to a plate reverb and a tempo-locked dub delay. The sum runs
through a three-band master EQ and a glue compressor before the limiter.

**A Linha** is the arrangement. Capture any channel for a whole number of bars, drop the
clips on four tracks across sixteen bars, set a loop bracket over any stretch you want to
keep hearing, and print the result offline to a WAV you can download or file in the
archive.

Under all of it, the AO VIVO strip carries the transport: a bar/beat/step counter, tap
tempo, a metronome that bypasses the bus so it never prints into a take, a one-bar
count-in for the recorder, and launch quantize so modules enter on the bar rather than
under your finger.

**The crate.** Search Spotify through the taste engine, pick the YouTube match yourself
(nothing is ever silently substituted), and yt-dlp pulls the audio. New tracks are
analyzed for BPM and key and re-scored against every frame. Demucs (htdemucs) splits any
source into vocals, drums, bass and other on the GPU, cached once and reused.

**O Percurso.** Nineteen carimbos and ten provas: a path through the room that marks what
you have actually done rather than what you have read.

## A Cabine

A DDJ-FLX4 on a phone, inside the mesa at `/cabine`. It exists so a friend who owns the
real controller can practice on the train. It behaves the way rekordbox does, with both
decks and the mixer in the hardware's positions. Cue is split: the left ear is cue, the
right ear is master. You carry tracks to the phone, mix with no signal at all, record,
and the take uploads to O Arquivo the next time you are back online.

In five lines:

1. Install it to the home screen first, so it opens with no signal.
2. Carry tracks from A Caixa while you are still on wifi.
3. Turn the phone sideways.
4. Use BROWSE and LOAD to put a track on each deck.
5. Press REC, mix, press it again.

Three rekordbox settings are read off the owner's install, not guessed, and each is a
single constant: `EQ_MODE` in `engine/mixer.js`, `DEFAULT_RANGE` in `engine/deck.js` and
`LOAD_LOCK` in `bindings.js`. Change them there. The layout has one switch, `?board=exact`,
which draws the panel at the controller's aspect ratio instead of spreading it to fill
the screen.

The service worker has one rule: bump `VERSION` and `SHELL_HASH` in `djlab/cabine_sw.js`
on every client change. Phones pick the new version up on the next launch.

Credits. Beat This! (CPJKU, MIT) makes the beat and downbeat grids. The Pioneer DJ
DDJ-FLX4 operating instructions are the behavior reference. Mixxx's FLX4 mapping was read
as a second witness only (GPL, nothing copied). NextDJ (MIT) was consulted, no code
copied.

## Running it

```bash
cp .env.example .env          # set PIN_HASH, or leave empty to skip auth
docker compose up -d --build
```

Serves on port 8127. The container wants an NVIDIA GPU for Demucs and falls back to CPU
if it cannot find one.

There is also a CLI for the offline half:

```bash
./dj analyze                  # BPM and key across the crate
./dj beds                     # render the seven techno frames
./dj pair                     # score every source against every frame
./dj stems FILE               # split one source into its four camadas
./dj render 3                 # render blend 3
```

## Layout

```
djlab/
  server.py      FastAPI app, PIN gate, every route
  recipes.py     the seven blends, Demucs stem cache
  mix.py         layering, sidechain, master bus, per-layer stem export
  beds.py        the seven synthesized techno frames
  engine.py      pairing scorer
  intake.py      Spotify search plus YouTube pull
  analyze.py     BPM and key detection
  warp.py        time stretch plans
  synth.py       synth voices
  static/        index.html, mesa.html, app.js, escola.js, style.css
  static/cabine/ A Cabine client: engine/, ui/, store.js + sync.js, app.js
  cabine.py      carry-ready MP3s, grids and waveform peaks for the phone
  grid.py        beat and downbeat grids (Beat This!)
  cabine_sw.js   the A Cabine service worker
```

Audio lives outside git: `sources/` (including `sources/techno/`), `stems/`, `renders/`, `beds/`, `previews/`,
and `carry/`, the phone-ready copies A Cabine builds.

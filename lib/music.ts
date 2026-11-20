// Music: write songs as a score (notes, chords, drum patterns) and play them with real instrument sounds,
// or generate whole songs with vocals from a description (song pack).
// CLI:     node joedit.ts music <command> ...
// Library: import { compose } from "./joEdit/music.ts"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ASSETS, need, numberFlag, optionalNumberFlag, readJson, requireFile, round, runCli, runPack, withTempDir, type Command } from "./shared.ts";
import * as sound from "./sound.ts";

// ---------- The score ----------

export type Note = [pitch: string | number, beat: number, length: number, velocity?: number];

export type Part = {
  instrument?: string | number; // a General MIDI name ("piano", "strings", "synth bass"), a number 0-127, or "pluck" (a real plucked string)
  notes?: Note[]; // exact notes: ["C4", beat, lengthInBeats, velocity 1-127]
  melody?: string; // quick melody: "E4 D4 C4:2 - G4:0.5" (each note 1 beat unless :length, "-" is a rest)
  chords?: string; // "Am F C G" (each chord lasts one bar unless beatsPerChord)
  rhythm?: string; // how chords are played: pad, block, arp, strum, pulse, bass, chug
  octave?: number; // octave for chords (default 4, bass 2)
  beatsPerChord?: number;
  start?: number; // beat where this part starts
  repeat?: number; // play the chords/melody this many times
  volume?: number; // 0..1
  pan?: number; // -1 (left) .. 1 (right)
  fx?: PartFx | string; // an amp, distortion, EQ and reverb for this part only ("metal" = {"amp": "metal"})
  double?: boolean; // play it twice, hard left and hard right (the wide sound of rock guitars)
};

// Effects for one part. amp: a guitar amp and speaker cabinet. drive: 0..1 more distortion.
// eq: decibels (-12..12) for low (200 Hz), mid (1 kHz) and high (4 kHz). reverb: a room; mix: how much of it (default 0.2).
export type PartFx = { amp?: string; drive?: number; eq?: { low?: number; mid?: number; high?: number }; reverb?: string; mix?: number };

type Filter = [type: string, frequency: number, gain?: number, q?: number];

// Guitar amps: filters before the distortion (what it bites on), how hard it distorts (two stages for metal),
// and the speaker cabinet after it (which takes away the fizz that raw distortion has).
const AMPS: Record<string, { drive: number; second?: number; before: Filter[]; cabinet: Filter[] }> = {
  clean: { drive: 1.5, before: [["highpass", 80]], cabinet: [["peaking", 2500, 2, 1], ["lowpass", 7500, 0, 0.7]] },
  crunch: { drive: 8, before: [["highpass", 90], ["peaking", 800, 4, 0.8]], cabinet: [["highpass", 80], ["peaking", 120, 2, 1], ["lowpass", 6000, 0, 0.7]] },
  metal: {
    drive: 40, second: 4,
    before: [["highpass", 110], ["peaking", 900, 6, 0.9]],
    cabinet: [["highpass", 75], ["peaking", 110, 4, 1.1], ["peaking", 450, -5, 1], ["peaking", 2600, 4, 1], ["lowpass", 5500, 0, 0.8]],
  },
};

export type Drums = {
  style?: string; // four-on-floor, hiphop, rock, halftime, trap, bossa, waltz
  pattern?: Record<string, string>; // {"kick": "x...x...", "snare": "....x..."}: each character is a 16th note
  bars?: number;
  start?: number; // beat where the drums start
  crash?: boolean; // a crash cymbal on the first beat (default true)
  volume?: number;
};

export type Score = {
  tempo?: number; // beats per minute (default 120)
  beatsPerBar?: number; // default 4
  bars?: number; // total length; default: as long as the longest part
  tracks?: Part[];
  drums?: Drums;
};

// The 128 General MIDI instruments, in program-number order.
export const INSTRUMENTS = [
  "acoustic grand piano", "bright acoustic piano", "electric grand piano", "honky-tonk piano", "electric piano 1", "electric piano 2", "harpsichord", "clavinet",
  "celesta", "glockenspiel", "music box", "vibraphone", "marimba", "xylophone", "tubular bells", "dulcimer",
  "drawbar organ", "percussive organ", "rock organ", "church organ", "reed organ", "accordion", "harmonica", "tango accordion",
  "nylon guitar", "steel guitar", "jazz guitar", "clean guitar", "muted guitar", "overdriven guitar", "distortion guitar", "guitar harmonics",
  "acoustic bass", "finger bass", "pick bass", "fretless bass", "slap bass 1", "slap bass 2", "synth bass 1", "synth bass 2",
  "violin", "viola", "cello", "contrabass", "tremolo strings", "pizzicato strings", "orchestral harp", "timpani",
  "string ensemble 1", "string ensemble 2", "synth strings 1", "synth strings 2", "choir aahs", "voice oohs", "synth voice", "orchestra hit",
  "trumpet", "trombone", "tuba", "muted trumpet", "french horn", "brass section", "synth brass 1", "synth brass 2",
  "soprano sax", "alto sax", "tenor sax", "baritone sax", "oboe", "english horn", "bassoon", "clarinet",
  "piccolo", "flute", "recorder", "pan flute", "blown bottle", "shakuhachi", "whistle", "ocarina",
  "square lead", "saw lead", "calliope lead", "chiff lead", "charang lead", "voice lead", "fifths lead", "bass and lead",
  "new age pad", "warm pad", "polysynth pad", "choir pad", "bowed pad", "metallic pad", "halo pad", "sweep pad",
  "rain fx", "soundtrack fx", "crystal fx", "atmosphere fx", "brightness fx", "goblins fx", "echoes fx", "sci-fi fx",
  "sitar", "banjo", "shamisen", "koto", "kalimba", "bagpipe", "fiddle", "shanai",
  "tinkle bell", "agogo", "steel drums", "woodblock", "taiko drum", "melodic tom", "synth drum", "reverse cymbal",
  "guitar fret noise", "breath noise", "seashore", "bird tweet", "telephone ring", "helicopter", "applause", "gunshot",
];

// Short names that are easy to remember.
export const INSTRUMENT_ALIASES: Record<string, number> = {
  piano: 0, "electric piano": 4, rhodes: 4, organ: 16, guitar: 25, "acoustic guitar": 25, "electric guitar": 27,
  bass: 33, "synth bass": 38, strings: 48, violin: 40, cello: 42, harp: 46, choir: 52, trumpet: 56, brass: 61,
  sax: 65, flute: 73, lead: 81, "synth lead": 81, pad: 89, "synth pad": 89, bells: 14, "music box": 10, marimba: 12,
};

// Drum sounds (General MIDI channel 10 note numbers).
export const DRUM_SOUNDS: Record<string, number> = {
  kick: 36, snare: 38, rim: 37, clap: 39, hat: 42, pedalhat: 44, openhat: 46, crash: 49, ride: 51,
  hightom: 50, midtom: 47, lowtom: 45, tambourine: 54, cowbell: 56, shaker: 70, conga: 63, bongo: 60,
};

// Ready-made one-bar drum grooves (16 steps per bar of 4 beats). x = hit, X = accent, o = soft, . = rest.
export const DRUM_STYLES: Record<string, Record<string, string>> = {
  "four-on-floor": { kick: "x...x...x...x...", clap: "....x.......x...", hat: "o.x.o.x.o.x.o.x.", openhat: "..o...o...o...o." },
  hiphop: { kick: "x......x..x.....", snare: "....X.......X...", hat: "x.x.x.x.x.x.x.xo" },
  rock: { kick: "x.......x.x.....", snare: "....X.......X...", hat: "x.x.x.x.x.x.x.x." },
  halftime: { kick: "x.........x.....", snare: "........X.......", hat: "x.x.x.x.x.x.x.x." },
  trap: { kick: "x......x...x....", snare: "........X.......", hat: "xoxoxoxoxoxxxoxo" },
  bossa: { kick: "x..x..x.x..x..x.", rim: "x..x...x..x..x..", hat: "xxxxxxxxxxxxxxxx" },
  waltz: { kick: "x...........", snare: "....o...o...", hat: "x...x...x..." },
};

// Chord shapes: semitones above the root.
const CHORD_SHAPES: Record<string, number[]> = {
  "": [0, 4, 7], m: [0, 3, 7], "7": [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], dim: [0, 3, 6], aug: [0, 4, 8],
  sus2: [0, 2, 7], sus4: [0, 5, 7], add9: [0, 4, 7, 14], "6": [0, 4, 7, 9], m6: [0, 3, 7, 9], "9": [0, 4, 7, 10, 14],
  m9: [0, 3, 7, 10, 14], maj9: [0, 4, 7, 11, 14], "5": [0, 7, 12], // "5" = power chord (root, fifth, octave)
};

export const RHYTHMS = ["pad", "block", "arp", "strum", "pulse", "bass", "chug"];

const NOTE_NAMES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// "C4" → 60 (middle C), "F#3" → 54, "Bb2" → 46. Numbers are MIDI note numbers already.
export function pitchNumber(pitch: string | number): number {
  if (typeof pitch === "number") return pitch;
  const match = pitch.trim().match(/^([A-Ga-g])([#b]?)(-?\d)$/);
  if (!match) throw new Error(`"${pitch}" is not a note. Use a letter, an optional # or b, and an octave, e.g. C4, F#3, Bb2.`);
  const [, letter, accidental, octave] = match;
  const shift = accidental === "#" ? 1 : accidental === "b" ? -1 : 0;
  return (Number(octave) + 1) * 12 + NOTE_NAMES[letter.toUpperCase()] + shift;
}

// "Am7" in octave 4 → its notes. "C/E" puts E in the bass.
function chordNotes(name: string, octave: number): number[] {
  const [chord, bass] = name.split("/");
  const match = chord.match(/^([A-G])([#b]?)(.*)$/);
  const shape = match ? CHORD_SHAPES[match[3]] : undefined;
  if (!match || !shape) throw new Error(`"${name}" is not a chord I know. Examples: C, Am, G7, Fmaj7, Dm7, Esus4, Cadd9, Bdim, C/E.`);
  const root = pitchNumber(`${match[1]}${match[2]}${octave}`);
  const notes = shape.map((step) => root + step);
  if (bass) notes.unshift(pitchNumber(`${bass}${octave - 1}`));
  return notes;
}

const isPluck = (part: Part) => typeof part.instrument === "string" && part.instrument.toLowerCase().trim() === "pluck";

function instrumentNumber(instrument: string | number = "piano"): number {
  if (typeof instrument === "number") return instrument;
  const name = instrument.toLowerCase().trim();
  if (name === "pluck") return 30; // in a .mid file, the plucked string becomes "distortion guitar"
  if (name in INSTRUMENT_ALIASES) return INSTRUMENT_ALIASES[name];
  const index = INSTRUMENTS.indexOf(name);
  if (index >= 0) return index;
  const partial = INSTRUMENTS.findIndex((n) => n.includes(name));
  if (partial >= 0) return partial;
  throw new Error(`Unknown instrument "${instrument}". See: node joedit.ts music instruments`);
}

type Event = { beat: number; length: number; pitch: number; velocity: number };

// Turn one part into timed notes.
function partEvents(part: Part, beatsPerBar: number): Event[] {
  const events: Event[] = [];
  const start = part.start ?? 0;
  const repeat = part.repeat ?? 1;
  for (const [pitch, beat, length, velocity] of part.notes ?? []) {
    events.push({ beat: start + beat, length, pitch: pitchNumber(pitch), velocity: velocity ?? 90 });
  }
  if (part.melody) {
    const tokens = part.melody.split(/\s+/).filter(Boolean);
    let beat = start;
    for (let r = 0; r < repeat; r++) {
      for (const token of tokens) {
        const [name, len] = token.split(":");
        const length = len ? Number(len) : 1;
        if (name !== "-") events.push({ beat, length: length * 0.95, pitch: pitchNumber(name), velocity: 95 });
        beat += length;
      }
    }
  }
  if (part.chords) {
    const rhythm = part.rhythm ?? "pad";
    if (!RHYTHMS.includes(rhythm)) throw new Error(`Unknown rhythm "${rhythm}". Rhythms: ${RHYTHMS.join(", ")}`);
    const octave = part.octave ?? (rhythm === "bass" ? 2 : 4);
    const span = part.beatsPerChord ?? beatsPerBar;
    const chords = part.chords.split(/[\s|]+/).filter(Boolean);
    let beat = start;
    for (let r = 0; r < repeat; r++) {
      for (const chord of chords) {
        const notes = chordNotes(chord, octave);
        const add = (at: number, length: number, pitch: number, velocity: number) => events.push({ beat: beat + at, length, pitch, velocity });
        if (rhythm === "pad") notes.forEach((p) => add(0, span, p, 75));
        if (rhythm === "block") for (let b = 0; b < span; b++) notes.forEach((p) => add(b, 0.9, p, b === 0 ? 90 : 72));
        if (rhythm === "pulse") for (let b = 0; b < span; b += 0.5) notes.forEach((p) => add(b, 0.4, p, b % 1 === 0 ? 85 : 65));
        if (rhythm === "arp") {
          const up = [...notes, notes[0] + 12];
          for (let b = 0, k = 0; b < span; b += 0.5, k++) add(b, 0.5, up[k % up.length], 80);
        }
        if (rhythm === "strum") {
          // A guitar-like pattern: down, down-up, up-down, with each string slightly later.
          for (const at of [0, 1.5, 2.5, 3].filter((t) => t < span)) notes.forEach((p, k) => add(at + k * 0.03, 0.9, p, at === 0 ? 92 : 74));
        }
        if (rhythm === "bass") {
          const root = notes[0];
          for (const [at, pitch] of [[0, root], [1.5, root], [2, root + 7], [3, root]] as const) if (at < span) add(at, 0.45, pitch, at === 0 ? 100 : 85);
        }
        if (rhythm === "chug") {
          // Rock and metal rhythm guitar: short (palm-muted) eighth notes, harder on the beat.
          for (let b = 0; b < span; b += 0.5) notes.forEach((p) => add(b, b % 1 === 0 ? 0.45 : 0.3, p, b % 1 === 0 ? 112 : 88));
        }
        beat += span;
      }
    }
  }
  return events;
}

// Turn the drum part into timed hits.
function drumEvents(drums: Drums, beatsPerBar: number, totalBars: number): Event[] {
  const pattern = drums.pattern ?? DRUM_STYLES[drums.style ?? "rock"];
  if (!pattern) throw new Error(`Unknown drum style "${drums.style}". Styles: ${Object.keys(DRUM_STYLES).join(", ")}`);
  const events: Event[] = [];
  const start = drums.start ?? 0;
  const bars = drums.bars ?? Math.max(1, totalBars - Math.floor(start / beatsPerBar));
  const velocity: Record<string, number> = { x: 100, X: 122, o: 62 };
  for (const [name, steps] of Object.entries(pattern)) {
    const note = DRUM_SOUNDS[name];
    if (note === undefined) throw new Error(`Unknown drum "${name}". Drums: ${Object.keys(DRUM_SOUNDS).join(", ")}`);
    // Each character is a 16th note; a pattern shorter or longer than a bar simply repeats.
    const total = bars * beatsPerBar * 4;
    for (let step = 0; step < total; step++) {
      const char = steps[step % steps.length];
      if (velocity[char]) events.push({ beat: start + step / 4, length: 0.25, pitch: note, velocity: velocity[char] });
    }
  }
  if (drums.crash !== false) events.push({ beat: start, length: 1, pitch: DRUM_SOUNDS.crash, velocity: 105 });
  return events;
}

// ---------- MIDI file writer ----------

const TICKS = 480; // ticks per beat

// MIDI stores many numbers as "variable length": 7 bits per byte, high bit = more bytes follow.
function variableLength(value: number): number[] {
  const bytes = [value & 0x7f];
  while ((value >>= 7)) bytes.unshift((value & 0x7f) | 0x80);
  return bytes;
}

function chunk(type: string, data: number[]): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, Buffer.from(data)]);
}

// One MIDI track: setup messages, then note on/off messages in time order.
function trackChunk(setup: number[][], events: Event[], channel: number): Buffer {
  const messages: { tick: number; bytes: number[]; order: number }[] = setup.map((bytes) => ({ tick: 0, bytes, order: 0 }));
  for (const e of events) {
    const on = Math.round(e.beat * TICKS);
    const off = Math.max(on + 1, Math.round((e.beat + e.length) * TICKS));
    const velocity = Math.max(1, Math.min(127, Math.round(e.velocity)));
    messages.push({ tick: on, bytes: [0x90 | channel, e.pitch, velocity], order: 2 });
    messages.push({ tick: off, bytes: [0x80 | channel, e.pitch, 0], order: 1 }); // note-offs before note-ons at the same time
  }
  messages.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const data: number[] = [];
  let last = 0;
  for (const m of messages) {
    data.push(...variableLength(m.tick - last), ...m.bytes);
    last = m.tick;
  }
  data.push(0, 0xff, 0x2f, 0x00); // end of track
  return chunk("MTrk", data);
}

// Build a complete MIDI file from a score. Returns the file bytes and the length in beats.
export function scoreToMidi(score: Score): { midi: Buffer; beats: number } {
  const tempo = score.tempo ?? 120;
  const beatsPerBar = score.beatsPerBar ?? 4;
  const parts = (score.tracks ?? []).map((part) => partEvents(part, beatsPerBar));
  const partBeats = Math.max(0, ...parts.flat().map((e) => e.beat + e.length));
  const bars = score.bars ?? Math.max(1, Math.ceil(partBeats / beatsPerBar));
  const drums = score.drums ? drumEvents(score.drums, beatsPerBar, bars) : [];
  const beats = Math.max(bars * beatsPerBar, partBeats);
  if (!parts.flat().length && !drums.length) throw new Error('The score has no notes. Add "tracks" (notes, melody or chords) or "drums".');

  // Track 0: tempo and time signature.
  const microseconds = Math.round(60_000_000 / tempo);
  const tempoTrack = trackChunk(
    [
      [0xff, 0x51, 0x03, (microseconds >> 16) & 0xff, (microseconds >> 8) & 0xff, microseconds & 0xff],
      [0xff, 0x58, 0x04, beatsPerBar, 2, 24, 8],
    ],
    [],
    0,
  );
  const tracks = [tempoTrack];
  (score.tracks ?? []).forEach((part, n) => {
    const channel = n >= 9 ? n + 1 : n; // channel 10 (index 9) is for drums
    if (channel > 15) throw new Error("A score can have at most 15 tracks plus drums.");
    const setup = [
      [0xc0 | channel, instrumentNumber(part.instrument)],
      [0xb0 | channel, 7, Math.round((part.volume ?? 0.8) * 127)],
      [0xb0 | channel, 10, Math.round(64 + (part.pan ?? 0) * 63)],
    ];
    tracks.push(trackChunk(setup, parts[n], channel));
  });
  if (drums.length) tracks.push(trackChunk([[0xb9, 7, Math.round((score.drums?.volume ?? 0.9) * 127)]], drums, 9));

  const header = Buffer.alloc(6);
  header.writeUInt16BE(1, 0); // format 1: several tracks played together
  header.writeUInt16BE(tracks.length, 2);
  header.writeUInt16BE(TICKS, 4);
  return { midi: Buffer.concat([chunk("MThd", [...header]), ...tracks]), beats };
}

// ---------- Commands ----------

function soundfont(): string {
  const file = join(ASSETS, "instruments", "GeneralUser-GS.sf2");
  if (!existsSync(file)) throw new Error("Music needs instrument sounds. Run: node joedit.ts install instruments");
  return file;
}

let soundBank: any; // the instrument sounds, read once

// Play MIDI with the instrument sounds (SoundFont) and return the left and right channels.
// Uses spessasynth, a SoundFont synthesizer written in JavaScript (no outside program needed).
async function synthesize(midiBytes: Uint8Array, seconds: number, sampleRate = 48000): Promise<Float32Array[]> {
  const { BasicMIDI, SoundBankLoader, SpessaSynthProcessor, SpessaSynthSequencer } = need("spessasynth_core");
  if (!soundBank) {
    const font = readFileSync(soundfont());
    soundBank = SoundBankLoader.fromArrayBuffer(font.buffer.slice(font.byteOffset, font.byteOffset + font.length));
  }
  const synth = new SpessaSynthProcessor(sampleRate, { eventsEnabled: false });
  synth.soundBankManager.addSoundBank(soundBank, "main");
  await synth.ready;
  synth.setSystemParameter("autoAllocateVoices", true); // no limit on notes playing at once
  const sequencer = new SpessaSynthSequencer(synth);
  sequencer.loadNewSongList([BasicMIDI.fromArrayBuffer(midiBytes.buffer.slice(midiBytes.byteOffset, midiBytes.byteOffset + midiBytes.length))]);
  sequencer.play();
  const total = Math.ceil(sampleRate * seconds);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  // Small steps keep vibrato and other slow changes smooth.
  for (let done = 0; done < total; done += 128) {
    sequencer.processTick();
    synth.process(left, right, done, Math.min(128, total - done));
  }
  return [left, right];
}

// ---------- Plucked strings and part effects ----------

const RATE = 48000;

// A plucked string (Karplus-Strong): a burst of noise goes round a short loop as long as one wave of the note,
// softened a little each time round, which is how a real string rings and dies away.
// Notes shorter than half a beat are palm-muted: they die quickly and sound darker (the "chug" of metal guitars).
function pluck(events: Event[], tempo: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.ceil(seconds * RATE));
  const secondsPerBeat = 60 / tempo;
  for (const e of events) {
    const start = Math.round(e.beat * secondsPerBeat * RATE);
    const period = Math.max(2, Math.round(RATE / (440 * 2 ** ((e.pitch - 69) / 12))));
    const muted = e.length < 0.5;
    const held = Math.round(e.length * secondsPerBeat * RATE); // until the note is let go
    const release = Math.round((muted ? 0.03 : 0.15) * RATE); // then it stops quickly
    const keep = muted ? 0.986 : 0.998; // how much of the sound is kept each time round
    const loop = new Float32Array(period);
    let soft = 0;
    for (let i = 0; i < period; i++) {
      soft = (muted ? 0.75 : 0.35) * soft + (Math.random() * 2 - 1) * (muted ? 0.25 : 0.65); // the pick: softer for a mute
      loop[i] = soft * (e.velocity / 127);
    }
    for (let i = 0, at = 0; i < held + release && start + i < out.length; i++) {
      const value = loop[at];
      const next = (at + 1) % period;
      loop[at] = keep * 0.5 * (value + loop[next]);
      at = next;
      out[start + i] += i < held ? value : value * (1 - (i - held) / release);
    }
  }
  return out;
}

// A mono sound placed left or right (equal loudness wherever it is).
function placed(mono: Float32Array, pan = 0): Float32Array[] {
  const angle = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
  return [mono.map((v) => v * Math.cos(angle)), mono.map((v) => v * Math.sin(angle))];
}

// Average loudness (root mean square).
function rms(channels: Float32Array[]): number {
  let sum = 0;
  for (const channel of channels) for (const v of channel) sum += v * v;
  return Math.sqrt(sum / Math.max(1, channels.length * channels[0].length));
}

// Run one part through its amp, distortion, EQ and reverb (Web Audio). Keeps the part's loudness, so the score's
// volumes still set the balance between parts.
async function partEffects(channels: Float32Array[], fx: PartFx | string, seconds: number): Promise<Float32Array[]> {
  const { BiquadFilterNode } = need("node-web-audio-api");
  const effects: PartFx = typeof fx === "string" ? { amp: fx } : fx; // "fx": "metal" is short for {"amp": "metal"}
  const amp = effects.amp ? AMPS[effects.amp] : undefined;
  if (effects.amp && !amp) throw new Error(`Unknown amp "${effects.amp}". Amps: ${Object.keys(AMPS).join(", ")}`);
  for (const [band, gain] of Object.entries(effects.eq ?? {})) {
    if (!["low", "mid", "high"].includes(band) || typeof gain !== "number" || Math.abs(gain) > 24) {
      throw new Error(`fx.eq takes "low", "mid" and "high" in dB, from -24 to 24 (got ${band}: ${gain}).`);
    }
  }
  if (effects.reverb && !sound.ROOMS[effects.reverb]) throw new Error(`Unknown reverb "${effects.reverb}". Rooms: ${Object.keys(sound.ROOMS).join(", ")}`);
  const extra = Math.max(0, Math.min(1, effects.drive ?? 0));
  const result = await sound.renderAudio(seconds, (ctx) => {
    const source = ctx.createBufferSource();
    source.buffer = sound.audioBuffer(ctx, channels);
    let last: any = source;
    const filters = (list: Filter[]) => {
      for (const [type, frequency, gain = 0, q = 0.7] of list) last = last.connect(new BiquadFilterNode(ctx, { type, frequency, gain, Q: q }));
    };
    const distort = (drive: number) => {
      const shaper = ctx.createWaveShaper();
      shaper.curve = sound.driveCurve(drive);
      shaper.oversample = "4x"; // less harsh fizz
      last = last.connect(shaper);
    };
    if (amp) {
      filters(amp.before);
      distort(amp.drive * (1 + extra * 3));
      if (amp.second) distort(amp.second);
      filters(amp.cabinet);
    } else if (extra) {
      distort(1 + extra * 30);
    }
    if (effects.eq) {
      filters([
        ["lowshelf", 200, effects.eq.low ?? 0],
        ["peaking", 1000, effects.eq.mid ?? 0, 0.8],
        ["highshelf", 4000, effects.eq.high ?? 0],
      ]);
    }
    last.connect(ctx.destination);
    if (effects.reverb) {
      const room = ctx.createConvolver();
      room.buffer = sound.roomEcho(ctx, effects.reverb);
      const wet = ctx.createGain();
      wet.gain.value = effects.mix ?? 0.2;
      last.connect(room).connect(wet).connect(ctx.destination);
    }
    source.start(0);
  });
  const gain = rms(channels) / Math.max(1e-9, rms(result));
  for (const channel of result) for (let i = 0; i < channel.length; i++) channel[i] *= gain;
  return result;
}

// Each part (and the drums) on its own, with its effects: these add up to the song, and are the --stems files.
async function renderStems(score: Score, seconds: number): Promise<{ name: string; channels: Float32Array[] }[]> {
  const tempo = score.tempo ?? 120;
  const beatsPerBar = score.beatsPerBar ?? 4;
  const bars = Math.ceil(scoreToMidi(score).beats / beatsPerBar);
  const stems: { name: string; channels: Float32Array[] }[] = [];
  for (const [n, part] of (score.tracks ?? []).entries()) {
    let channels: Float32Array[];
    if (isPluck(part)) {
      const events = partEvents(part, beatsPerBar);
      const volume = part.volume ?? 0.8;
      // Doubled: two separate takes (each pluck is a little different), one hard left and one hard right.
      channels = part.double
        ? [pluck(events, tempo, seconds).map((v) => v * volume), pluck(events, tempo, seconds).map((v) => v * volume)]
        : placed(pluck(events, tempo, seconds).map((v) => v * volume), part.pan);
    } else {
      channels = await synthesize(scoreToMidi({ ...score, bars, tracks: [part], drums: undefined }).midi, seconds);
      if (part.double) {
        // The same part, a moment later on the other side.
        const late = Math.round(0.018 * RATE);
        const mono = channels[0].map((v, i) => (v + channels[1][i]) / 2);
        channels = [mono, mono.map((_, i) => (i >= late ? mono[i - late] : 0))];
      }
    }
    if (part.fx) channels = await partEffects(channels, part.fx, seconds);
    const name = typeof part.instrument === "string" ? part.instrument.replace(/[^a-z0-9]+/gi, "-") : `instrument-${part.instrument ?? 0}`;
    stems.push({ name: `${n + 1}-${name}`, channels });
  }
  if (score.drums) stems.push({ name: "drums", channels: await synthesize(scoreToMidi({ ...score, bars, tracks: [] }).midi, seconds) });
  return stems;
}

// Play a score with real instrument sounds. Output .mid writes just the MIDI file (for other music apps).
// stems: also save each part (and the drums) as its own .wav in this folder, for mixing.
export async function compose(scoreFile: string, output: string, options: { stems?: string } = {}) {
  const score: Score = readJson(scoreFile);
  if (options.stems && existsSync(options.stems) && !statSync(options.stems).isDirectory()) throw new Error(`--stems is a folder for the part files; ${options.stems} is a file.`);
  const { midi, beats } = scoreToMidi(score);
  const tempo = score.tempo ?? 120;
  const result = { tempo, beats: round(beats), seconds: round((beats * 60) / tempo, 2) };
  if (/\.midi?$/i.test(output)) {
    writeFileSync(output, midi);
    return result;
  }
  // The musical length plus a moment for the last notes to ring, faded out, then standard loudness.
  const length = result.seconds + 1.5;
  const separate = options.stems || (score.tracks ?? []).some((p) => p.fx || p.double || isPluck(p));
  let channels: Float32Array[];
  let stemFiles: string[] = [];
  if (!separate) {
    channels = await synthesize(midi, length); // everything in one go (fastest)
  } else {
    const stems = await renderStems(score, length);
    channels = [new Float32Array(Math.ceil(length * RATE)), new Float32Array(Math.ceil(length * RATE))];
    for (const stem of stems) for (const c of [0, 1]) stem.channels[c].forEach((v, i) => (channels[c][i] += v));
    if (options.stems) {
      mkdirSync(options.stems, { recursive: true });
      stemFiles = stems.map((stem) => join(options.stems!, `${stem.name}.wav`));
      stems.forEach((stem, k) => sound.writeWav(stemFiles[k], stem.channels, RATE));
    }
  }
  const fadeStart = Math.floor((result.seconds + 0.5) * RATE);
  for (const channel of channels) for (let i = fadeStart; i < channel.length; i++) channel[i] *= 1 - (i - fadeStart) / (channel.length - fadeStart);
  await withTempDir(async (folder) => {
    const raw = join(folder, "raw.wav");
    sound.writeWav(raw, channels, RATE);
    sound.normalize(raw, output);
  });
  return { ...result, ...(stemFiles.length ? { stems: stemFiles } : {}) };
}

// A whole song (with singing if there are lyrics) from a description, using ACE-Step (song pack).
// steps: diffusion steps, 1..20 (the turbo model is tuned for 8).
// The result says how it ran: the GPU memory tier, language model, offload, seconds and (on NVIDIA) peak GPU memory.
export function song(output: string, prompt: string, options: { lyrics?: string; duration?: number; seed?: number; bpm?: number; steps?: number } = {}) {
  if (!prompt.trim()) throw new Error('Describe the music with --prompt, e.g. --prompt "upbeat indie pop, female vocals, guitar".');
  if (options.steps !== undefined && !(Number.isInteger(options.steps) && options.steps >= 1 && options.steps <= 20)) {
    throw new Error("--steps is a whole number from 1 to 20 (the turbo model is tuned for 8).");
  }
  return withTempDir((folder) => {
    const args = [folder, "--prompt", prompt, "--duration", String(options.duration ?? 30)];
    if (options.lyrics) args.push("--lyrics", options.lyrics);
    if (options.seed !== undefined) args.push("--seed", String(options.seed));
    if (options.bpm) args.push("--bpm", String(options.bpm));
    if (options.steps) args.push("--steps", String(options.steps));
    const { file, ...result } = runPack("song", args);
    sound.normalize(file, output);
    return result;
  });
}

export const commands: Record<string, Command> = {
  compose: {
    usage: "compose <score.json> <output.wav|.mp3|.mid> [--stems folder]  (needs: install instruments)",
    run: (a) => {
      if (a.positional.length < 2) throw new Error("Give the score file and the output.");
      return compose(a.positional[0], a.positional[1], { stems: a.flags.stems });
    },
  },
  instruments: {
    usage: "instruments  → instrument names, drum sounds, drum styles, chord rhythms and amps",
    run: () => ({
      aliases: Object.keys(INSTRUMENT_ALIASES),
      instruments: [...INSTRUMENTS, "pluck"],
      drums: Object.keys(DRUM_SOUNDS),
      drumStyles: Object.keys(DRUM_STYLES),
      rhythms: RHYTHMS,
      chords: Object.keys(CHORD_SHAPES).map((shape) => `C${shape}`),
      amps: Object.keys(AMPS),
      reverbs: Object.keys(sound.ROOMS),
    }),
  },
  song: {
    usage: 'song <output.wav> --prompt "style, mood, instruments, voice" [--lyrics lyrics.txt] [--duration 30] [--bpm N] [--seed N] [--steps 8]  (needs: install song)',
    run: (a) => {
      if (!a.positional[0]) throw new Error("Missing output path.");
      const lyrics = a.flags.lyrics ? readFileSync(requireFile(a.flags.lyrics), "utf8") : undefined;
      return song(a.positional[0], a.flags.prompt ?? "", {
        lyrics,
        duration: optionalNumberFlag(a, "duration", 30),
        seed: a.flags.seed === undefined ? undefined : Number(a.flags.seed),
        bpm: a.flags.bpm === undefined ? undefined : Number(a.flags.bpm),
        steps: a.flags.steps === undefined ? undefined : numberFlag(a, "steps"),
      });
    },
  },
};

// Only run the CLI when this file is executed directly (not when imported).
if (import.meta.main) {
  runCli("joEdit music: node joedit.ts music <command> ...", commands, process.argv.slice(2));
}

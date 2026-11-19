// Music: write songs as a score (notes, chords, drum patterns) and play them with real instrument sounds,
// or generate whole songs with vocals from a description (song pack).
// CLI:     node joedit.ts music <command> ...
// Library: import { compose } from "./joEdit/music.ts"
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ASSETS, ffmpeg, hasProgram, optionalNumberFlag, requireFile, round, run, runCli, runPack, withTempDir, type Command } from "./shared.ts";
import * as sound from "./sound.ts";

// ---------- The score ----------

export type Note = [pitch: string | number, beat: number, length: number, velocity?: number];

export type Part = {
  instrument?: string | number; // a General MIDI name ("piano", "strings", "synth bass") or number 0-127
  notes?: Note[]; // exact notes: ["C4", beat, lengthInBeats, velocity 1-127]
  melody?: string; // quick melody: "E4 D4 C4:2 - G4:0.5" (each note 1 beat unless :length, "-" is a rest)
  chords?: string; // "Am F C G" (each chord lasts one bar unless beatsPerChord)
  rhythm?: string; // how chords are played: pad, block, arp, strum, pulse, bass
  octave?: number; // octave for chords (default 4, bass 2)
  beatsPerChord?: number;
  start?: number; // beat where this part starts
  repeat?: number; // play the chords/melody this many times
  volume?: number; // 0..1
  pan?: number; // -1 (left) .. 1 (right)
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
  m9: [0, 3, 7, 10, 14], maj9: [0, 4, 7, 11, 14], "5": [0, 7],
};

export const RHYTHMS = ["pad", "block", "arp", "strum", "pulse", "bass"];

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

function instrumentNumber(instrument: string | number = "piano"): number {
  if (typeof instrument === "number") return instrument;
  const name = instrument.toLowerCase().trim();
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

// Play a score with real instrument sounds. Output .mid writes just the MIDI file (for other music apps).
export function compose(scoreFile: string, output: string) {
  const score: Score = JSON.parse(readFileSync(requireFile(scoreFile), "utf8"));
  const { midi, beats } = scoreToMidi(score);
  const tempo = score.tempo ?? 120;
  const result = { tempo, beats: round(beats), seconds: round((beats * 60) / tempo, 2) };
  if (/\.midi?$/i.test(output)) {
    writeFileSync(output, midi);
    return result;
  }
  if (!hasProgram("fluidsynth")) throw new Error("Music needs fluidsynth. Install it: brew install fluid-synth (macOS) or apt install fluidsynth (Linux)");
  const font = soundfont();
  withTempDir((folder) => {
    const midiFile = join(folder, "score.mid");
    const raw = join(folder, "raw.wav");
    writeFileSync(midiFile, midi);
    run("fluidsynth", ["-ni", "-q", "-g", "0.7", "-r", "44100", "-F", raw, font, midiFile]);
    // Keep the musical length (plus a moment for the last notes to ring), then set standard loudness.
    const trimmed = join(folder, "trimmed.wav");
    ffmpeg(["-i", raw, "-af", `atrim=end=${result.seconds + 1.5},afade=t=out:st=${result.seconds + 0.5}:d=1`, trimmed]);
    sound.normalize(trimmed, output);
  });
  return result;
}

// A whole song (with singing if there are lyrics) from a description, using ACE-Step (song pack).
export function song(output: string, prompt: string, options: { lyrics?: string; duration?: number; seed?: number; bpm?: number } = {}) {
  if (!prompt.trim()) throw new Error('Describe the music with --prompt, e.g. --prompt "upbeat indie pop, female vocals, guitar".');
  return withTempDir((folder) => {
    const args = [folder, "--prompt", prompt, "--duration", String(options.duration ?? 30)];
    if (options.lyrics) args.push("--lyrics", options.lyrics);
    if (options.seed !== undefined) args.push("--seed", String(options.seed));
    if (options.bpm) args.push("--bpm", String(options.bpm));
    const result = runPack("song", args);
    sound.normalize(result.file, output);
    return { duration: result.duration, seed: result.seed, device: result.device };
  });
}

export const commands: Record<string, Command> = {
  compose: {
    usage: "compose <score.json> <output.wav|.mp3|.mid>  (needs: install instruments, and fluidsynth)",
    run: (a) => {
      if (a.positional.length < 2) throw new Error("Give the score file and the output.");
      return compose(a.positional[0], a.positional[1]);
    },
  },
  instruments: {
    usage: "instruments  → instrument names, drum sounds, drum styles and chord rhythms",
    run: () => ({
      aliases: Object.keys(INSTRUMENT_ALIASES),
      instruments: INSTRUMENTS,
      drums: Object.keys(DRUM_SOUNDS),
      drumStyles: Object.keys(DRUM_STYLES),
      rhythms: RHYTHMS,
      chords: Object.keys(CHORD_SHAPES).map((shape) => `C${shape}`),
    }),
  },
  song: {
    usage: 'song <output.wav> --prompt "style, mood, instruments, voice" [--lyrics lyrics.txt] [--duration 30] [--bpm N] [--seed N]  (needs: install song)',
    run: (a) => {
      if (!a.positional[0]) throw new Error("Missing output path.");
      const lyrics = a.flags.lyrics ? readFileSync(requireFile(a.flags.lyrics), "utf8") : undefined;
      return song(a.positional[0], a.flags.prompt ?? "", {
        lyrics,
        duration: optionalNumberFlag(a, "duration", 30),
        seed: a.flags.seed === undefined ? undefined : Number(a.flags.seed),
        bpm: a.flags.bpm === undefined ? undefined : Number(a.flags.bpm),
      });
    },
  },
};

// Only run the CLI when this file is executed directly (not when imported).
if (import.meta.main) {
  runCli("joEdit music: node joedit.ts music <command> ...", commands, process.argv.slice(2));
}

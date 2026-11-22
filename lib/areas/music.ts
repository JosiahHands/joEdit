// Music: write songs as a score (notes, chords, drum patterns) and play them with real instrument sounds,
// or generate whole songs with vocals from a description (song pack).
// CLI:     node joedit.ts music <command> ...
// Library: import { compose } from "./joEdit/areas/music.ts"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ASSETS, ffmpeg, need, numberFlag, optionalNumberFlag, readJson, requireFile, round, runCli, runPack, withTempDir, type Args, type Command } from "../core/shared.ts";
import * as listen from "./listen.ts";
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
  feel?: Feel; // this part's own feel (default: the score's)
  sections?: string[]; // with score "sections": the sections this part plays in (default all); it starts again at each one
};

// One section of a song. The parts and drums loop to fill it; the change into it gets a fill, build, riser or stop.
export type Section = {
  name: string; // intro, verse, chorus, bridge, drop, outro... (parts pick sections by name)
  bars: number;
  drums?: string | Record<string, string> | false; // this section's groove: a style, a pattern, or false for none (default: the score's drums)
  energy?: number; // 1 (quiet) to 5 (full out): how hard everything plays (default 3)
  into?: "fill" | "build" | "riser" | "stop" | "none"; // how the end of the section before leads into this one
};
const INTOS = ["fill", "build", "riser", "stop", "none"];

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
  sections?: Section[]; // the song's form, e.g. intro 4 bars, verse 8, chorus 8 (then "bars" is their total)
  sounds?: string; // the instrument sounds: "generaluser" (default), "musescore", or a .sf2/.sf3 file
  master?: string | (Partial<Master> & { preset?: string }) | false; // the finishing stage: a preset (default "balanced"), tweaks, or false (just loudness)
  feel?: Feel; // how human the playing is (default "natural")
  swing?: number; // 0.5 = straight; 0.54-0.58 subtle, 0.6-0.62 groove, 0.66 = triplet shuffle
  swingNote?: 8 | 16; // swing the off-beat 8th notes (default) or 16th notes (hip-hop, funk)
  seed?: number; // the same seed plays the same human feel again (default 1)
};

// The master stage, the last step of a record: the music ducks under each kick ("duck" dB, the pumping of dance music),
// a gentle compressor glues the mix together, shelves set the tone (dB at 100 Hz and 8 kHz),
// then a limiter brings it up to "lufs" loudness without its peaks going over -1 dB.
export type Master = { duck: number; ratio: number; threshold: number; low: number; high: number; lufs: number };
export const MASTERS: Record<string, Master> = {
  balanced: { duck: 1.5, ratio: 1.8, threshold: -20, low: 0, high: 0.5, lufs: -14 },
  pop: { duck: 2, ratio: 2, threshold: -18, low: 1, high: 1.5, lufs: -14 },
  edm: { duck: 6, ratio: 2.5, threshold: -18, low: 1.5, high: 1, lufs: -14 },
  hiphop: { duck: 3, ratio: 2, threshold: -18, low: 2, high: 0.5, lufs: -14 },
  rock: { duck: 0, ratio: 3, threshold: -16, low: 0.5, high: 1, lufs: -14 },
  lofi: { duck: 4, ratio: 3, threshold: -20, low: 1, high: -3, lufs: -14 },
  acoustic: { duck: 0, ratio: 1.5, threshold: -22, low: 0, high: 1, lufs: -16 },
  jazz: { duck: 0, ratio: 1.5, threshold: -22, low: 0.5, high: 0.5, lufs: -16 },
  cinematic: { duck: 0, ratio: 1.5, threshold: -24, low: 1, high: 0.5, lufs: -16 },
  ambient: { duck: 0, ratio: 1.3, threshold: -24, low: 0, high: 0, lufs: -16 },
};

// How human the playing is: "tight" (almost on the grid), "natural" (a good session player), "loose" (laid back, live),
// or "exact" (the grid itself, like the MIDI file you wrote).
export type Feel = "exact" | "tight" | "natural" | "loose";
const FEELS: Record<Feel, number> = { exact: 0, tight: 0.4, natural: 1, loose: 2 };

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

// Turn one part into timed notes (on the grid; humanize() adds the feel).
function partEvents(part: Part, beatsPerBar: number, tempo = 120): Event[] {
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
          // A guitar-like pattern: down, down-up, up-down. A down strum sweeps low to high (12 ms a string);
          // an up strum sweeps high to low, faster and softer, catching only the top strings.
          const string = (ms: number) => (ms / 1000) * (tempo / 60); // milliseconds in beats
          for (const at of [0, 1.5, 2.5, 3].filter((t) => t < span)) {
            const down = at % 1 === 0;
            const strings = down ? notes : [...notes].reverse().slice(0, 3);
            strings.forEach((p, k) => add(at + k * string(down ? 12 : 8), 0.9, p, at === 0 ? 92 : down ? 80 : 66));
          }
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

// ---------- Sections: the song's form ----------

type Span = Section & { start: number; beats: number; into: NonNullable<Section["into"]>; energy: number; hasDrums: boolean };

// Where each section starts (in beats) and how it is led into. Undefined when the score has no sections.
function arrangement(score: Score): Span[] | undefined {
  if (!score.sections) return undefined;
  const beatsPerBar = score.beatsPerBar ?? 4;
  if (!Array.isArray(score.sections) || !score.sections.length) throw new Error('"sections" is a list, e.g. [{"name": "verse", "bars": 8}, {"name": "chorus", "bars": 8}].');
  const spans: Span[] = [];
  let start = 0;
  for (const [k, section] of score.sections.entries()) {
    if (!section.name || !(Number.isInteger(section.bars) && section.bars > 0)) throw new Error(`Section ${k + 1} needs a "name" and a whole number of "bars".`);
    if (section.into && !INTOS.includes(section.into)) throw new Error(`Unknown "into" "${section.into}". Use: ${INTOS.join(", ")}`);
    const energy = Math.max(1, Math.min(5, section.energy ?? 3));
    const hasDrums = section.drums === undefined ? !!score.drums : section.drums !== false;
    // By default the drums play a fill into the next section, when they play on both sides of the change.
    const into = section.into ?? (k > 0 && hasDrums && spans[k - 1].hasDrums ? "fill" : "none");
    spans.push({ ...section, start, beats: section.bars * beatsPerBar, into, energy, hasDrums });
    start += section.bars * beatsPerBar;
  }
  return spans;
}

// How hard a section plays: energy 3 as written, 1 softer (×0.8), 5 harder (×1.2).
const energyScale = (events: Event[], energy: number) => events.map((e) => ({ ...e, velocity: Math.min(127, e.velocity * (0.7 + 0.1 * energy)) }));

// "stop": everything is silent for the last beat before the section (the gap before a drop).
function stopGaps(events: Event[], spans: Span[] | undefined): Event[] {
  const gaps = (spans ?? []).filter((s) => s.into === "stop" && s.start > 0).map((s) => [s.start - 1, s.start]);
  if (!gaps.length) return events;
  return events
    .filter((e) => !gaps.some(([from, to]) => e.beat >= from - 1e-6 && e.beat < to - 1e-6))
    .map((e) => {
      const gap = gaps.find(([from]) => e.beat < from && e.beat + e.length > from);
      return gap ? { ...e, length: gap[0] - e.beat } : e;
    });
}

// A part's notes laid out over the song: on its own, or looped through each section it plays in.
function arrangedPart(score: Score, part: Part, tempo: number): Event[] {
  const beatsPerBar = score.beatsPerBar ?? 4;
  const spans = arrangement(score);
  const loop = partEvents(part, beatsPerBar, tempo);
  if (!spans) return loop;
  const names = spans.map((s) => s.name);
  for (const name of part.sections ?? []) if (!names.includes(name)) throw new Error(`A part plays in section "${name}", but the sections are: ${names.join(", ")}`);
  // The part repeats every whole number of bars it takes.
  const loopBeats = Math.max(1, Math.ceil(Math.max(0, ...loop.map((e) => e.beat + e.length)) / beatsPerBar - 1e-6)) * beatsPerBar;
  const events: Event[] = [];
  for (const span of spans) {
    if (part.sections && !part.sections.includes(span.name)) continue;
    const end = span.start + span.beats;
    const here: Event[] = [];
    for (let offset = 0; offset < span.beats; offset += loopBeats) {
      for (const e of loop) {
        const beat = span.start + offset + e.beat;
        if (beat < end - 1e-6) here.push({ ...e, beat, length: Math.min(e.length, end - beat) });
      }
    }
    events.push(...energyScale(here, span.energy));
  }
  return stopGaps(events, spans);
}

// The drums over the song: each section's groove, a crash at each new section, and the fills and builds between them.
function arrangedDrums(score: Score, bars: number): Event[] {
  const beatsPerBar = score.beatsPerBar ?? 4;
  const spans = arrangement(score);
  if (!spans) return score.drums ? drumEvents(score.drums, beatsPerBar, bars) : [];
  let events: Event[] = [];
  const hit = (beat: number, drum: string, velocity: number) => events.push({ beat, length: 0.25, pitch: DRUM_SOUNDS[drum], velocity });
  // Clear a stretch of the groove for a fill, keeping the kick on the beat.
  const clear = (from: number, to: number) => {
    events = events.filter((e) => e.beat < from - 1e-6 || e.beat >= to - 1e-6 || (e.pitch === DRUM_SOUNDS.kick && e.beat % 1 === 0));
  };
  for (const span of spans) {
    if (!span.hasDrums) continue;
    const groove = span.drums; // a style name, a pattern, or (undefined) the score's own drums
    const drums: Drums = { ...score.drums, ...(typeof groove === "string" ? { style: groove, pattern: undefined } : groove ? { pattern: groove } : {}) };
    const here = drumEvents({ ...drums, start: span.start, bars: span.bars, crash: false }, beatsPerBar, span.bars);
    events.push(...energyScale(here, span.energy));
    if (span.start > 0 || score.drums?.crash !== false) hit(span.start, "crash", Math.min(127, 90 + 6 * span.energy));
  }
  for (const [k, span] of spans.entries()) {
    const before = spans[k - 1];
    if (!before?.hasDrums) continue;
    const end = span.start;
    if (span.into === "fill") {
      if (span.energy > before.energy) {
        // Going up: a two-beat fill down the toms.
        clear(end - 2, end);
        ["hightom", "hightom", "midtom", "midtom", "lowtom", "lowtom", "snare", "snare"].forEach((drum, i) => hit(end - 2 + i / 4, drum, 88 + i * 4));
      } else {
        // Otherwise: four snare 16ths, getting louder.
        clear(end - 1, end);
        [72, 84, 96, 110].forEach((velocity, i) => hit(end - 1 + i / 4, "snare", velocity));
      }
    }
    if (span.into === "build") {
      // A snare roll over the last bar: 8ths, then 16ths, louder and louder.
      const from = end - beatsPerBar;
      clear(from, end);
      for (let at = from, i = 0; at < end - 1e-6; at += at < end - beatsPerBar / 2 ? 0.5 : 0.25, i++) hit(at, "snare", 50 + (70 * (at - from)) / beatsPerBar);
    }
  }
  return stopGaps(events, spans);
}

// Turn a sound up or down section by section to match its energy (3 = as is), gliding over 50 ms at each change.
function sectionVolume(channels: Float32Array[], score: Score) {
  const spans = arrangement(score);
  if (!spans) return;
  const samplesPerBeat = (60 * RATE) / (score.tempo ?? 120);
  const glide = 0.05 * RATE;
  const level = (span: Span) => 0.7 + 0.1 * span.energy;
  for (const [k, span] of spans.entries()) {
    const from = Math.round(span.start * samplesPerBeat);
    const to = k + 1 < spans.length ? Math.round(spans[k + 1].start * samplesPerBeat) : channels[0].length;
    const before = k > 0 ? level(spans[k - 1]) : level(span);
    for (const channel of channels) {
      for (let i = from; i < Math.min(to, channel.length); i++) channel[i] *= before + (level(span) - before) * Math.min(1, (i - from) / glide);
    }
  }
}

// Section start times for the result (so a movie can cut on them).
function sectionTimes(score: Score) {
  const spans = arrangement(score);
  const tempo = score.tempo ?? 120;
  return spans?.map((s) => ({ name: s.name, start: round((s.start * 60) / tempo, 3), bars: s.bars }));
}

// A noise "riser" before each section led into with "riser" or "build": white noise that brightens and swells
// over the last two bars and stops right on the downbeat. Returns a stereo sound, or nothing.
function risers(score: Score, seconds: number): Float32Array[] | undefined {
  const spans = (arrangement(score) ?? []).filter((s) => (s.into === "riser" || s.into === "build") && s.start > 0);
  if (!spans.length) return undefined;
  const secondsPerBeat = 60 / (score.tempo ?? 120);
  const out = [new Float32Array(Math.ceil(seconds * RATE)), new Float32Array(Math.ceil(seconds * RATE))];
  for (const span of spans) {
    const end = Math.round(span.start * secondsPerBeat * RATE);
    const length = Math.min(end, Math.round(2 * (score.beatsPerBar ?? 4) * secondsPerBeat * RATE));
    for (const channel of out) {
      let low = 0, band = 0; // a simple resonant filter (state variable), swept from 300 Hz up to 9 kHz
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const f = 2 * Math.sin((Math.PI * 300 * 30 ** t) / RATE);
        const high = Math.random() * 2 - 1 - low - 0.6 * band;
        band += f * high;
        low += f * band;
        const fade = Math.min(1, (length - i) / (0.005 * RATE)); // 5 ms off at the very end, no click
        if (end - length + i < channel.length) channel[end - length + i] += band * t * t * fade;
      }
    }
  }
  return out;
}

// ---------- Feel: playing like a person ----------

// A repeatable random number generator: the same seed gives the same "performance" every time.
function randomFrom(seed: number) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // A bell curve (most values near 0, a few further out), spread `spread`.
  const bell = (spread: number) => spread * Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next());
  return { next, bell };
}

const DRUM_PITCHES = new Set(Object.values(DRUM_SOUNDS));
const HATS = new Set([DRUM_SOUNDS.hat, DRUM_SOUNDS.pedalhat, DRUM_SOUNDS.openhat, DRUM_SOUNDS.ride, DRUM_SOUNDS.shaker, DRUM_SOUNDS.tambourine]);
const BACKBEAT = new Set([DRUM_SOUNDS.snare, DRUM_SOUNDS.clap, DRUM_SOUNDS.rim]);

// Play notes like a person: swing, small timing drifts, uneven velocities, hi-hats that lean on the beat,
// a snare that sits a hair late, and the kick that stays locked (the beat everything else follows).
// The numbers are what good session players do: timing spread of a few milliseconds, velocity ±5 or so.
function humanize(events: Event[], o: { tempo: number; feel: Feel; swing: number; swingNote: number; seed: number; drums?: boolean }): Event[] {
  const amount = FEELS[o.feel];
  if (amount === undefined) throw new Error(`Unknown feel "${o.feel}". Feels: ${Object.keys(FEELS).join(", ")}`);
  const swing = o.swing;
  if (!(swing >= 0.5 && swing <= 0.75)) throw new Error("swing is from 0.5 (straight) to 0.75 (hard shuffle); 0.58 is a light swing.");
  const random = randomFrom(o.seed);
  const beats = (ms: number) => (ms / 1000) * (o.tempo / 60);
  const step = o.swingNote === 16 ? 0.5 : 1; // the swing pair: two 16ths (half a beat) or two 8ths (a beat)
  const together = new Map<number, number>(); // the notes of one chord or strum drift together
  return events.map((e) => {
    let beat = e.beat;
    // Swing: the second note of each pair comes later (a strum that starts there moves with it).
    const late = (((beat - step / 2) % step) + step) % step;
    if (swing > 0.5 && (late < 0.15 * step || late > step - 0.01)) beat += (swing - 0.5) * step;
    let velocity = e.velocity;
    if (amount > 0) {
      const drum = o.drums && DRUM_PITCHES.has(e.pitch);
      const kick = drum && e.pitch === DRUM_SOUNDS.kick;
      // Timing: drums are tighter than other parts, the kick tightest of all. Each drum is its own limb;
      // the notes of a chord move as one hand, with only a hair between them.
      if (drum) beat += beats(random.bell((kick ? 1.5 : 3) * amount));
      else {
        const slot = Math.floor((e.beat + 0.05) * 4);
        if (!together.has(slot)) together.set(slot, random.bell(6 * amount));
        beat += beats(together.get(slot)! + random.bell(1.5 * amount));
      }
      if (drum && BACKBEAT.has(e.pitch)) beat += beats(4 * Math.min(amount, 1.5)); // the snare sits back a little
      // Velocity: a little uneven; hi-hats louder on the beat than between beats.
      velocity += random.bell(4 * amount);
      if (drum && HATS.has(e.pitch) && e.velocity === 100) {
        const position = ((e.beat % 1) + 1) % 1;
        velocity *= position < 0.01 ? 1 : Math.abs(position - 0.5) < 0.01 ? 0.82 : 0.68;
      }
    }
    return { ...e, beat: Math.max(0, beat), velocity: Math.max(1, Math.min(127, velocity)) };
  });
}

// A soft "ghost" snare now and then, a 16th before a backbeat: what makes a groove sound played, not programmed.
function ghostNotes(events: Event[], seed: number): Event[] {
  const random = randomFrom(seed + 7);
  const ghosts = events
    .filter((e) => e.pitch === DRUM_SOUNDS.snare && e.velocity >= 100)
    .filter(() => random.next() < 0.35)
    .map((e) => ({ beat: e.beat - 0.25, length: 0.25, pitch: DRUM_SOUNDS.snare, velocity: 30 + random.next() * 14 }))
    .filter((g) => g.beat >= 0 && !events.some((e) => e.pitch === DRUM_SOUNDS.snare && Math.abs(e.beat - g.beat) < 0.01));
  return [...events, ...ghosts];
}

// The notes of a part as played (with the score's feel).
function playedPart(score: Score, part: Part, n: number): Event[] {
  const tempo = score.tempo ?? 120;
  return humanize(arrangedPart(score, part, tempo), {
    tempo, feel: part.feel ?? score.feel ?? "natural", swing: score.swing ?? 0.5, swingNote: score.swingNote ?? 8, seed: (score.seed ?? 1) * 101 + n,
  });
}

// The drum hits as played.
function playedDrums(score: Score, bars: number): Event[] {
  const feel = score.feel ?? "natural";
  const hits = arrangedDrums(score, bars);
  if (!hits.length) return [];
  const seed = (score.seed ?? 1) * 101 + 99;
  return humanize(feel === "exact" || feel === "tight" ? hits : ghostNotes(hits, seed), {
    tempo: score.tempo ?? 120, feel, swing: score.swing ?? 0.5, swingNote: score.swingNote ?? 8, seed, drums: true,
  });
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
// A stem renders one track alone: firstPart is that track's number (so it keeps its own feel), and drums: false leaves the drums out.
export function scoreToMidi(score: Score, options: { firstPart?: number; drums?: boolean } = {}): { midi: Buffer; beats: number } {
  const tempo = score.tempo ?? 120;
  const beatsPerBar = score.beatsPerBar ?? 4;
  // The length comes from the notes on the grid (or the sections), so the small human drifts never add a bar.
  const sectionBars = score.sections?.reduce((sum, s) => sum + (s.bars || 0), 0);
  const partBeats = sectionBars ? sectionBars * beatsPerBar : Math.max(0, ...(score.tracks ?? []).flatMap((part) => partEvents(part, beatsPerBar, tempo)).map((e) => e.beat + e.length));
  const bars = score.bars ?? Math.max(1, Math.ceil(partBeats / beatsPerBar));
  const parts = (score.tracks ?? []).map((part, n) => playedPart(score, part, (options.firstPart ?? 0) + n));
  const drums = options.drums === false ? [] : playedDrums(score, bars);
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

// The instrument sounds a score plays with: "generaluser" (GeneralUser GS, default), "musescore" (MuseScore General:
// fuller orchestra, piano and drums) or the path of any SoundFont (.sf2 or .sf3) you have.
export const SOUND_BANKS: Record<string, string> = { generaluser: "GeneralUser-GS.sf2", musescore: "MuseScore_General.sf3" };
function soundfont(sounds = "generaluser"): string {
  if (/\.sf[23]$/i.test(sounds)) return requireFile(sounds);
  if (!SOUND_BANKS[sounds]) throw new Error(`Unknown sounds "${sounds}". Use ${Object.keys(SOUND_BANKS).join(" or ")}, or the path of a .sf2/.sf3 file.`);
  const file = join(ASSETS, "instruments", SOUND_BANKS[sounds]);
  if (!existsSync(file)) throw new Error("Music needs instrument sounds. Run: node joedit.ts install instruments");
  return file;
}

const soundBanks = new Map<string, any>(); // the instrument sounds, read once per file

// Play MIDI with the instrument sounds (SoundFont) and return the left and right channels.
// Uses spessasynth, a SoundFont synthesizer written in JavaScript (no outside program needed).
async function synthesize(midiBytes: Uint8Array, seconds: number, sounds?: string, sampleRate = 48000): Promise<Float32Array[]> {
  const { BasicMIDI, SoundBankLoader, SpessaSynthProcessor, SpessaSynthSequencer } = need("spessasynth_core");
  const file = soundfont(sounds);
  if (!soundBanks.has(file)) {
    const font = readFileSync(file);
    soundBanks.set(file, SoundBankLoader.fromArrayBuffer(font.buffer.slice(font.byteOffset, font.byteOffset + font.length)));
  }
  const synth = new SpessaSynthProcessor(sampleRate, { eventsEnabled: false });
  synth.soundBankManager.addSoundBank(soundBanks.get(file), "main");
  await synth.ready;
  synth.setSystemParameter("autoAllocateVoices", true); // no limit on notes playing at once
  const sequencer = new SpessaSynthSequencer(synth);
  sequencer.skipToFirstNoteOn = false; // keep the silence before the first note (a part that comes in later stays in time)
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
      const events = playedPart(score, part, n);
      const volume = part.volume ?? 0.8;
      // Doubled: two separate takes (each pluck is a little different), one hard left and one hard right.
      channels = part.double
        ? [pluck(events, tempo, seconds).map((v) => v * volume), pluck(events, tempo, seconds).map((v) => v * volume)]
        : placed(pluck(events, tempo, seconds).map((v) => v * volume), part.pan);
    } else {
      channels = await synthesize(scoreToMidi({ ...score, bars, tracks: [part] }, { firstPart: n, drums: false }).midi, seconds, score.sounds);
      if (part.double) {
        // The same part, a moment later on the other side.
        const late = Math.round(0.018 * RATE);
        const mono = channels[0].map((v, i) => (v + channels[1][i]) / 2);
        channels = [mono, mono.map((_, i) => (i >= late ? mono[i - late] : 0))];
      }
    }
    if (part.fx) channels = await partEffects(channels, part.fx, seconds);
    // Distortion evens out how hard notes are played, so a driven part also gets each section's energy as volume.
    const fx = typeof part.fx === "string" ? { amp: part.fx } : part.fx;
    if (fx?.amp || fx?.drive) sectionVolume(channels, score);
    const name = typeof part.instrument === "string" ? part.instrument.replace(/[^a-z0-9]+/gi, "-") : `instrument-${part.instrument ?? 0}`;
    stems.push({ name: `${n + 1}-${name}`, channels });
  }
  if (playedDrums(score, bars).length) stems.push({ name: "drums", channels: await synthesize(scoreToMidi({ ...score, bars, tracks: [] }).midi, seconds, score.sounds) });
  return stems;
}

// ---------- Starter scores: one per genre, to change rather than start from nothing ----------

// Each is a finished arrangement (form, groove, feel, master). Change the chords, melody, tempo and sections to make it yours.
export const STARTERS: Record<string, { description: string; score: Score }> = {
  pop: {
    description: "Bright pop: piano, bass, strings lift into the chorus, a hook melody (104 BPM, 72 s)",
    score: {
      tempo: 104, master: "pop",
      sections: [
        { name: "intro", bars: 4, drums: false, energy: 2 },
        { name: "verse", bars: 8, drums: "halftime", energy: 3 },
        { name: "chorus", bars: 8, drums: "rock", energy: 4 },
        { name: "verse2", bars: 8, drums: "halftime", energy: 3 },
        { name: "chorus2", bars: 8, drums: "rock", energy: 5, into: "build" },
        { name: "outro", bars: 4, drums: false, energy: 2 },
      ],
      tracks: [
        { instrument: "piano", chords: "C G Am F", rhythm: "block", volume: 0.7 },
        { instrument: "synth bass", chords: "C G Am F", rhythm: "bass", sections: ["verse", "chorus", "verse2", "chorus2"] },
        { instrument: "strings", chords: "C G Am F", octave: 3, volume: 0.5, sections: ["chorus", "chorus2", "outro"] },
        { instrument: "lead", melody: "E5 E5 D5 C5 D5:2 G4:2 C5 C5 B4 A4 C5:3 -", volume: 0.6, pan: 0.2, sections: ["chorus", "chorus2"] },
      ],
      drums: { style: "rock" },
    },
  },
  lofi: {
    description: "Lo-fi hip-hop: dusty electric piano, swung 16ths, warm pumping master (78 BPM, 80 s)",
    score: {
      tempo: 78, swing: 0.6, swingNote: 16, feel: "loose", master: "lofi",
      sections: [
        { name: "intro", bars: 4, drums: false, energy: 2 },
        { name: "beat", bars: 8, energy: 3 },
        { name: "break", bars: 4, drums: false, energy: 2 },
        { name: "beat2", bars: 8, energy: 3, into: "stop" },
        { name: "outro", bars: 2, drums: false, energy: 1 },
      ],
      tracks: [
        { instrument: "rhodes", chords: "Dm9 G9 Cmaj9 Am7", rhythm: "block", volume: 0.6, pan: -0.4, fx: { eq: { high: -4 }, reverb: "room", mix: 0.25 } },
        { instrument: "finger bass", chords: "Dm9 G9 Cmaj9 Am7", rhythm: "bass", sections: ["beat", "beat2"] },
        { instrument: "vibraphone", melody: "A4:2 C5 D5 E5:2 C5:2 - - D5:2 B4:2 G4:2", volume: 0.5, pan: 0.5, sections: ["beat", "break", "beat2"] },
      ],
      drums: { style: "hiphop", volume: 0.8 },
    },
  },
  rock: {
    description: "Rock: doubled crunch guitars, pick bass, a lead line in the chorus (132 BPM, 62 s)",
    score: {
      tempo: 132, master: "rock",
      sections: [
        { name: "intro", bars: 4, drums: false, energy: 2 },
        { name: "verse", bars: 8, drums: "halftime", energy: 3 },
        { name: "chorus", bars: 8, energy: 5 },
        { name: "bridge", bars: 4, drums: "halftime", energy: 3 },
        { name: "chorus2", bars: 8, energy: 5, into: "stop" },
       ],
      tracks: [
        { instrument: "pluck", chords: "E5 C5 G5 D5", rhythm: "chug", octave: 2, double: true, volume: 0.45, fx: { amp: "crunch", eq: { mid: -3, high: -6 } } },
        { instrument: "pick bass", chords: "E5 C5 G5 D5", rhythm: "bass", sections: ["verse", "chorus", "bridge", "chorus2"] },
        { instrument: "pluck", melody: "B4:2 A4:2 G4:2 F#4:2 E4:2 D4:2 E4:4", volume: 0.55, fx: { amp: "crunch", eq: { mid: -2, high: -6 }, reverb: "room" }, sections: ["chorus", "chorus2"] },
      ],
      drums: { style: "rock" },
    },
  },
  cinematic: {
    description: "Cinematic build: strings and piano, horns and taiko-like toms, a climax (70 BPM, 82 s)",
    score: {
      tempo: 70, master: "cinematic", sounds: "musescore",
      sections: [
        { name: "open", bars: 4, drums: false, energy: 1 },
        { name: "rise", bars: 8, drums: { lowtom: "x.......x...x..." }, energy: 3 },
        { name: "climax", bars: 8, drums: { kick: "x.......x.......", lowtom: "x...x...x.x.x..." }, energy: 5, into: "build" },
        { name: "end", bars: 4, drums: false, energy: 2 },
      ],
      tracks: [
        { instrument: "strings", chords: "Dm Bb F C", octave: 3, volume: 0.7 },
        { instrument: "piano", chords: "Dm Bb F C", rhythm: "arp", volume: 0.5, sections: ["open", "rise", "end"] },
        { instrument: "french horn", melody: "A4:2 F4:2 D5:4 C5:2 A4:2 G4:4", sections: ["rise", "climax"] },
        { instrument: "choir", chords: "Dm Bb F C", volume: 0.5, sections: ["climax"] },
        { instrument: "timpani", melody: "D2 D2 D2:2 A1 A1 A1:2 F2 F2 F2:2 C2 C2 C2:2", volume: 0.6, sections: ["climax"] },
      ],
    },
  },
  edm: {
    description: "EDM: filtered intro, a build with snare roll and riser, a pumping drop, a breakdown, a second drop (126 BPM, 122 s)",
    score: {
      tempo: 126, master: "edm",
      sections: [
        { name: "intro", bars: 8, drums: { kick: "x...x...x...x...", hat: "..x...x...x...x." }, energy: 2 },
        { name: "build", bars: 8, drums: "halftime", energy: 3 },
        { name: "drop", bars: 16, energy: 5, into: "build" },
        { name: "break", bars: 8, drums: false, energy: 2 },
        { name: "drop2", bars: 16, energy: 5, into: "stop" },
        { name: "outro", bars: 8, drums: { kick: "x...x...x...x..." }, energy: 2 },
      ],
      tracks: [
        { instrument: "warm pad", chords: "Am F C G", volume: 0.5 },
        { instrument: "synth bass", chords: "Am F C G", rhythm: "pulse", octave: 2, sections: ["build", "drop", "drop2", "outro"] },
        { instrument: "saw lead", chords: "Am F C G", rhythm: "pulse", octave: 4, volume: 0.6, sections: ["drop", "drop2"] },
        { instrument: "saw lead", melody: "E5:1.5 C5:1.5 A4 C5:1.5 D5:1.5 E5 G5:2 E5:2 D5:4", volume: 0.5, pan: 0.2, sections: ["drop", "break", "drop2"] },
      ],
      drums: { style: "four-on-floor" },
    },
  },
  hiphop: {
    description: "Hip-hop: swung 16th hats, electric piano chords, deep bass, a bell hook (90 BPM, 75 s)",
    score: {
      tempo: 90, swing: 0.56, swingNote: 16, master: "hiphop",
      sections: [
        { name: "intro", bars: 4, drums: false, energy: 2 },
        { name: "verse", bars: 16, energy: 3 },
        { name: "hook", bars: 8, energy: 4 },
        { name: "outro", bars: 4, drums: { hat: "x.x.x.x.x.x.x.x." }, energy: 2 },
      ],
      tracks: [
        { instrument: "electric piano", chords: "Cm7 Abmaj7 Ebmaj7 Bb", rhythm: "block", volume: 0.6, pan: -0.4 },
        { instrument: "synth bass", chords: "Cm7 Abmaj7 Ebmaj7 Bb", rhythm: "bass", octave: 1, sections: ["verse", "hook"] },
        { instrument: "bells", melody: "G5 - Eb5 - C5:2 - - Ab5 - G5 - Eb5:2 - - G5 - F5 - Eb5:2 D5:2 Bb4:4 - - - -", volume: 0.4, pan: 0.5, sections: ["hook"] },
      ],
      drums: { style: "hiphop" },
    },
  },
  jazz: {
    description: "Jazz trio plus sax: a ii-V-I with walking bass, swung ride, loose feel (120 BPM, 48 s)",
    score: {
      tempo: 120, swing: 0.66, feel: "loose", master: "jazz",
      sections: [
        { name: "head", bars: 8, energy: 2 },
        { name: "solo", bars: 8, energy: 4 },
        { name: "head2", bars: 8, energy: 3 },
      ],
      tracks: [
        { instrument: "piano", chords: "Dm7 G7 Cmaj7 Cmaj7 Em7 A7 Dm7 G7", rhythm: "block", volume: 0.5, pan: -0.5 },
        { instrument: "acoustic bass", melody: "D2 F2 A2 C3 B1 D2 F2 A2 C2 E2 G2 B2 C2 E2 G2 E2 E2 G2 B2 D3 A1 C#2 E2 G2 D2 F2 A2 C3 G1 B1 D2 F2", volume: 0.8 },
        { instrument: "tenor sax", melody: "A4 C5 E5 D5:2 B4 G4 C5:4 - E4 G4 B4 D5:2 C#5:2 F5 E5 D5 C5 B4:4 - - - - -", sections: ["head", "head2"], pan: 0.45 },
        { instrument: "tenor sax", melody: "F5 E5 D5 C5 B4 D5 F5 A5 G5:2 E5 C5 B4:2 - G4 B4 D5 G5 F5 E5 C#5 A4:2 D5 F5 A5 G5 F5 D5 B4:2", sections: ["solo"], pan: 0.45 },
      ],
      drums: { pattern: { ride: "x...x.x.x...x.x.", pedalhat: "....x.......x...", kick: "o..............." }, volume: 0.6 },
    },
  },
  folk: {
    description: "Folk: strummed acoustic guitar, upright bass, a fiddle tune in the chorus, light shaker groove (96 BPM, 80 s)",
    score: {
      tempo: 96, feel: "loose", master: "acoustic",
      sections: [
        { name: "intro", bars: 4, drums: false, energy: 2 },
        { name: "verse", bars: 8, energy: 3 },
        { name: "chorus", bars: 8, energy: 4 },
        { name: "verse2", bars: 8, energy: 3 },
        { name: "chorus2", bars: 8, energy: 4 },
      ],
      tracks: [
        { instrument: "acoustic guitar", chords: "G D Em C", rhythm: "strum", volume: 0.8, double: true },
        { instrument: "acoustic bass", chords: "G D Em C", rhythm: "bass", sections: ["verse", "chorus", "verse2", "chorus2"] },
        { instrument: "fiddle", melody: "B4 D5 G5:2 F#5 E5 D5:2 E5 G5 B4:2 C5 B4 A4 G4", pan: 0.5, volume: 0.6, sections: ["chorus", "chorus2"] },
      ],
      drums: { pattern: { kick: "x.......x.......", rim: "....x.......x...", shaker: "xoxoxoxoxoxoxoxo" }, volume: 0.7 },
    },
  },
  orchestral: {
    description: "Orchestral: strings, pizzicato, woodwinds and horns in an A-B-A form, no drums (96 BPM, 70 s)",
    score: {
      tempo: 96, master: { preset: "cinematic", high: 2.5 }, sounds: "musescore",
      sections: [
        { name: "A", bars: 8, energy: 3 },
        { name: "B", bars: 8, energy: 4 },
        { name: "A2", bars: 8, energy: 3 },
        { name: "coda", bars: 4, energy: 2 },
      ],
      tracks: [
        { instrument: "strings", chords: "C G Am Em F C F G", rhythm: "block", octave: 3, volume: 0.6 },
        { instrument: "cello", chords: "C G Am Em F C F G", octave: 2, volume: 0.6, pan: 0.2 },
        { instrument: "contrabass", chords: "C G Am Em F C F G", rhythm: "bass", octave: 1, volume: 0.6 },
        { instrument: "pizzicato strings", chords: "C G Am Em F C F G", rhythm: "pulse", pan: -0.3, sections: ["A", "A2"], volume: 0.5 },
        { instrument: "flute", melody: "E5 G5 C6:2 B5 G5 E5:2 A5 G5 F5 E5 D5:4 F5 A5 C6:2 B5 G5 D5:2 E5 F5 G5 E5 C5:4", sections: ["A", "A2"], pan: 0.3 },
        { instrument: "french horn", melody: "C4:4 B3:4 A3:4 G3:4 F3:4 E3:4 F3:4 G3:4", sections: ["B"] },
        { instrument: "oboe", melody: "G5:2 E5:2 D5:4 C5:2 B4:2 C5:4", sections: ["B", "coda"], pan: -0.3 },
      ],
    },
  },
  ambient: {
    description: "Ambient: slow pads that drift and bloom, sparse bells, no drums (70 BPM, 82 s)",
    score: {
      tempo: 70, feel: "loose", master: { preset: "ambient", high: 3 },
      sections: [
        { name: "drift", bars: 8, energy: 2 },
        { name: "bloom", bars: 8, energy: 3 },
        { name: "drift2", bars: 8, energy: 2 },
      ],
      tracks: [
        { instrument: "warm pad", chords: "Cmaj7 Am7 Fmaj7 G", beatsPerChord: 8, volume: 0.7, fx: { reverb: "hall", mix: 0.4 } },
        { instrument: "halo pad", chords: "Cmaj7 Am7 Fmaj7 G", beatsPerChord: 8, octave: 5, volume: 0.4, sections: ["bloom"] },
        { instrument: "fretless bass", melody: "C2:8 A1:8 F1:8 G1:8", volume: 0.5 },
        { instrument: "music box", melody: "E5:3 G5 B5:4 - - A5:2 C6:4 G5:6 - - E5:2 D5:4 - -", volume: 0.5, pan: 0.3, fx: { reverb: "hall", mix: 0.5 } },
      ],
    },
  },
};

// ---------- Master stage ----------

// The score's "master": a preset name, a preset with tweaks ({"preset": "edm", "duck": 8}), or false (none).
function masterSettings(master: Score["master"]): Master | undefined {
  if (master === false) return undefined;
  const { preset = "balanced", ...tweaks } = typeof master === "string" ? { preset: master } : (master ?? {});
  if (!MASTERS[preset]) throw new Error(`Unknown master "${preset}". Presets: ${Object.keys(MASTERS).join(", ")}, or false for none.`);
  for (const [key, value] of Object.entries(tweaks)) {
    if (!(key in MASTERS.balanced) || typeof value !== "number") throw new Error(`master takes "preset" and the numbers ${Object.keys(MASTERS.balanced).join(", ")} (got ${key}).`);
  }
  return { ...MASTERS[preset], ...tweaks };
}

// Sidechain: turn the music down by `db` the moment each kick hits, coming back up over about a third of a beat,
// so the kick punches through and the music breathes with it.
function duckUnder(music: Float32Array[], kicks: number[], db: number, tempo: number) {
  const depth = 1 - 10 ** (-db / 20);
  const attack = 0.004 * RATE;
  const recover = (0.3 * 60 * RATE) / tempo;
  const gain = new Float32Array(music[0].length).fill(1);
  for (const kick of kicks) {
    const at = Math.round(kick * RATE);
    for (let i = Math.max(0, at - attack); i < Math.min(gain.length, at + 5 * recover); i++) {
      const duck = i < at ? depth * (1 - (at - i) / attack) : depth * Math.exp(-(i - at) / recover);
      gain[i] = Math.min(gain[i], 1 - duck);
    }
  }
  for (const channel of music) for (let i = 0; i < channel.length; i++) channel[i] *= gain[i];
}

// Glue, tone and loudness: shelves, a slow compressor, then a limiter that runs at 4× the sample rate
// (so peaks between samples are caught too) and brings the song to the target loudness.
function masterMix(raw: string, output: string, master: Master, folder: string) {
  const glued = join(folder, "glued.wav");
  ffmpeg(["-i", raw, "-af", [
    `lowshelf=g=${master.low}:f=100:w=0.7`,
    `highshelf=g=${master.high}:f=8000:w=0.7`,
    `acompressor=threshold=${10 ** (master.threshold / 20)}:ratio=${master.ratio}:attack=30:release=250:knee=4:detection=rms`,
  ].join(","), glued]);
  // The limiter takes off a little loudness when it works, so measure and correct once.
  let gain = master.lufs - listen.loudness(glued).lufs;
  for (let pass = 0; pass < 2; pass++) {
    ffmpeg(["-i", glued, "-af", `volume=${gain.toFixed(2)}dB,aresample=192000,alimiter=limit=${10 ** (-1.2 / 20)}:attack=2:release=60:level=false,aresample=48000`, output]);
    const off = master.lufs - listen.loudness(output).lufs;
    if (Math.abs(off) < 0.4) break;
    gain += off;
  }
}

// Play a score with real instrument sounds. Output .mid writes just the MIDI file (for other music apps).
// stems: also save each part (and the drums) as its own .wav in this folder, for mixing.
export async function compose(scoreFile: string, output: string, options: { stems?: string } = {}) {
  const score: Score = readJson(scoreFile);
  if (options.stems && existsSync(options.stems) && !statSync(options.stems).isDirectory()) throw new Error(`--stems is a folder for the part files; ${options.stems} is a file.`);
  const { midi, beats } = scoreToMidi(score);
  const tempo = score.tempo ?? 120;
  const sections = sectionTimes(score);
  const result = { tempo, beats: round(beats), seconds: round((beats * 60) / tempo, 2), ...(sections ? { sections } : {}) };
  if (/\.midi?$/i.test(output)) {
    writeFileSync(output, midi);
    return result;
  }
  // The musical length plus a moment for the last notes to ring, faded out, then mastered.
  const length = result.seconds + 1.5;
  const master = masterSettings(score.master);
  const bars = Math.ceil(beats / (score.beatsPerBar ?? 4));
  const kicks = playedDrums(score, bars).filter((e) => e.pitch === DRUM_SOUNDS.kick).map((e) => (e.beat * 60) / tempo);
  // The music ducks under the kick, so it needs the drums on their own (a drums-only score has nothing to duck).
  const duck = master && master.duck > 0 && kicks.length > 0 && (score.tracks ?? []).length > 0;
  const separate = options.stems || (score.tracks ?? []).some((p) => p.fx || p.double || isPluck(p));
  let music: Float32Array[]; // everything but the drums (or everything, when it does not duck)
  let drums: Float32Array[] | undefined;
  let stemFiles: string[] = [];
  if (!separate && !duck) {
    music = await synthesize(midi, length, score.sounds); // everything in one go (fastest)
  } else if (!separate) {
    music = await synthesize(scoreToMidi(score, { drums: false }).midi, length, score.sounds);
    drums = await synthesize(scoreToMidi({ ...score, tracks: [] }).midi, length, score.sounds);
  } else {
    const stems = await renderStems(score, length);
    music = [new Float32Array(Math.ceil(length * RATE)), new Float32Array(Math.ceil(length * RATE))];
    for (const stem of stems) {
      if (stem.name === "drums") drums = stem.channels;
      else for (const c of [0, 1]) stem.channels[c].forEach((v, i) => (music[c][i] += v));
    }
    if (options.stems) {
      mkdirSync(options.stems, { recursive: true });
      stemFiles = stems.map((stem) => join(options.stems!, `${stem.name}.wav`));
      stems.forEach((stem, k) => sound.writeWav(stemFiles[k], stem.channels, RATE));
    }
  }
  if (duck) duckUnder(music, kicks, master.duck, tempo);
  const channels = music;
  if (drums) for (const c of [0, 1]) drums[c].forEach((v, i) => (channels[c][i] += v));
  const riser = risers(score, length);
  if (riser) {
    // At its peak the riser is about as loud as the song (a swell grows as time², so its peak is √5 × its average).
    const sounding = riser.map((c) => c.filter((v) => v !== 0));
    const level = (0.8 * rms(channels)) / Math.max(1e-9, Math.sqrt(5) * rms(sounding));
    for (const c of [0, 1]) riser[c].forEach((v, i) => (channels[c][i] += v * level));
    if (options.stems) {
      stemFiles.push(join(options.stems, "riser.wav"));
      sound.writeWav(stemFiles.at(-1)!, riser.map((c) => c.map((v) => v * level)), RATE);
    }
  }
  // "stop": cut the whole mix for the beat before the section, ringing notes and echoes too (10 ms fades, no clicks).
  for (const span of arrangement(score) ?? []) {
    if (span.into !== "stop" || span.start === 0) continue;
    const from = Math.round(((span.start - 1) * 60 * RATE) / tempo);
    const to = Math.round((span.start * 60 * RATE) / tempo);
    const fade = Math.round(0.01 * RATE);
    for (const channel of channels) {
      for (let i = from; i < to && i < channel.length; i++) channel[i] *= Math.max(0, Math.min(1, Math.max((from + fade - i) / fade, (i - (to - fade)) / fade)));
    }
  }
  const fadeStart = Math.floor((result.seconds + 0.5) * RATE);
  for (const channel of channels) for (let i = fadeStart; i < channel.length; i++) channel[i] *= 1 - (i - fadeStart) / (channel.length - fadeStart);
  await withTempDir(async (folder) => {
    const raw = join(folder, "raw.wav");
    sound.writeWav(raw, channels, RATE);
    if (master) masterMix(raw, output, master, folder);
    else sound.normalize(raw, output);
  });
  return { ...result, ...(stemFiles.length ? { stems: stemFiles } : {}) };
}

// A whole song (with singing if there are lyrics) from a description, using ACE-Step (song pack).
// steps: diffusion steps, 1..20 (the turbo model is tuned for 8).
// The result says how it ran: the GPU memory tier, language model, offload, seconds and (on NVIDIA) peak GPU memory.
export const SONG_MODELS = ["turbo", "sft", "base", "xl"];

type SongOptions = { lyrics?: string; duration?: number; seed?: number; bpm?: number; steps?: number; model?: string; guidance?: number; takes?: number; language?: string };

// The song pack's arguments that every task shares.
function songArgs(folder: string, prompt: string, options: SongOptions): string[] {
  const model = options.model ?? "";
  if (model && !SONG_MODELS.includes(model)) throw new Error(`--model must be one of: ${SONG_MODELS.join(", ")}`);
  const most = model === "" || model === "turbo" ? 20 : 100;
  if (options.steps !== undefined && !(Number.isInteger(options.steps) && options.steps >= 1 && options.steps <= most)) {
    throw new Error(`--steps is a whole number from 1 to ${most} (turbo is tuned for 8, the other models for 32).`);
  }
  const args = [folder, "--prompt", prompt];
  if (options.lyrics) args.push("--lyrics", options.lyrics);
  if (options.bpm) args.push("--bpm", String(options.bpm));
  if (options.steps) args.push("--steps", String(options.steps));
  if (model) args.push("--model", model);
  if (options.guidance !== undefined) args.push("--guidance", String(options.guidance));
  if (options.language) args.push("--language", options.language);
  return args;
}

// Make `takes` versions (seeds seed, seed+1, … or random ones), listen to each with review, keep the best.
// make(seed) runs one take and returns the pack's result with its file; finish(file) writes the output.
async function bestTake(takes: number, seed: number | undefined, make: (seed?: number) => Promise<any>, finish: (file: string) => void | Promise<void>) {
  if (!(Number.isInteger(takes) && takes >= 1 && takes <= 8)) throw new Error("--takes is 1 to 8.");
  const heard: { seed: number; score: number; file: string; result: any }[] = [];
  for (let n = 0; n < takes; n++) {
    const { file, ...result } = await make(seed === undefined ? undefined : seed + n);
    const score = takes > 1 ? review(file).score : 0;
    heard.push({ seed: result.seed, score, file, result });
  }
  const best = heard.reduce((a, b) => (b.score > a.score ? b : a));
  await finish(best.file);
  return { ...best.result, ...(takes > 1 ? { takes: heard.map(({ seed, score }) => ({ seed, score })), kept: best.seed } : {}) };
}

// A whole song from a description (song pack, ACE-Step 1.5). model: turbo (fast, default), sft or xl (guided,
// closer to the prompt, slower), base. takes: make several and keep the one review scores best.
export function song(output: string, prompt: string, options: SongOptions = {}) {
  if (!prompt.trim()) throw new Error('Describe the music with --prompt, e.g. --prompt "upbeat indie pop, female vocals, guitar".');
  return withTempDir(async (folder) => {
    const args = [...songArgs(folder, prompt, options), "--duration", String(options.duration ?? 30)];
    return bestTake(
      options.takes ?? 1,
      options.seed,
      (seed) => runPack("song", seed === undefined ? args : [...args, "--seed", String(seed)]),
      (file) => void sound.normalize(file, output),
    );
  });
}

// Sing lyrics over an instrumental you made (a composed score, or any track): ACE-Step's base model writes a lead
// vocal that fits the music it hears, so the beat, chords and length stay exactly yours.
// prompt describes the voice and style ("warm female pop vocal, breathy, close mic"). vocals: also save the voice alone.
export function sing(instrumental: string, output: string, lyrics: string, prompt: string, options: SongOptions & { vocals?: string } = {}) {
  requireFile(instrumental);
  if (!lyrics.trim()) throw new Error("sing needs --lyrics (a text file; [verse], [chorus] tags help).");
  if (!prompt.trim()) throw new Error('Describe the voice with --prompt, e.g. --prompt "soulful male vocal, warm, close mic".');
  return withTempDir(async (folder) => {
    const source = join(folder, "instrumental.wav");
    sound.normalize(instrumental, source);
    const args = [...songArgs(folder, prompt, { ...options, lyrics, model: "base" }), "--task", "sing", "--source", source];
    return bestTake(
      options.takes ?? 1,
      options.seed,
      async (seed) => {
        const take = await runPack("song", seed === undefined ? args : [...args, "--seed", String(seed)]);
        // The voice, sat on the instrumental: the instrumental a little under, then the whole mix to standard loudness.
        const mixed = join(folder, `mix-${take.seed}.wav`);
        ffmpeg(["-i", source, "-i", take.file, "-filter_complex", "[0:a]volume=0.8[m];[m][1:a]amix=inputs=2:duration=first:normalize=0", "-ar", "48000", mixed]);
        return { ...take, voice: take.file, file: mixed };
      },
      (file) => void sound.normalize(file, output),
    ).then((result) => {
      if (options.vocals) sound.normalize(result.voice, options.vocals);
      const { voice, ...rest } = result;
      return { ...rest, ...(options.vocals ? { vocals: options.vocals } : {}) };
    });
  });
}

// Make one part of a song again (start..end seconds) to a new description or lyrics; the rest stays as it was.
// Good for fixing a weak chorus, a wrong word, or a bad ending without losing the take you like.
export function repaint(input: string, output: string, start: number, end: number, prompt: string, options: SongOptions = {}) {
  requireFile(input);
  if (!(end > start && start >= 0)) throw new Error("--end must be after --start (seconds).");
  if (!prompt.trim()) throw new Error("Describe the new part with --prompt (the song's style, plus what to change).");
  return withTempDir(async (folder) => {
    const source = join(folder, "source.wav");
    sound.normalize(input, source);
    const args = [...songArgs(folder, prompt, options), "--task", "repaint", "--source", source, "--start", String(start), "--end", String(end)];
    return bestTake(
      options.takes ?? 1,
      options.seed,
      (seed) => runPack("song", seed === undefined ? args : [...args, "--seed", String(seed)]),
      (file) => void sound.normalize(file, output),
    );
  });
}

// The flags song, sing and repaint share.
function songFlags(a: Args): SongOptions {
  const number = (name: string) => (a.flags[name] === undefined ? undefined : numberFlag(a, name));
  return {
    lyrics: a.flags.lyrics ? readFileSync(requireFile(a.flags.lyrics), "utf8") : undefined,
    seed: number("seed"), bpm: number("bpm"), steps: number("steps"), guidance: number("guidance"), takes: number("takes"),
    model: a.flags.model, language: a.flags.language,
  };
}

// ---------- review: what a mixing engineer would say ----------

// A rough tonal balance of a finished pop mix: each octave band in dB against the whole sound
// (31 Hz ... 16 kHz, like listen bands). Genres differ (lo-fi is darker, EDM has more low end),
// so a reference track in the style you want (--reference) is the better yardstick.
const TYPICAL_MIX = [-14, -7, -6, -8, -10, -12, -15, -18, -22, -30];

// Listen to a song like a mixing engineer and say what to fix: loudness, tonal balance (muddy, thin, dull, harsh),
// stereo width, how much the energy builds and drops, the start and the ending. A score from 0 to 10 sums it up.
// Each problem comes with a fix (a command, or what to change in a score).
// reference: a finished track in the style you want; the tonal balance is then compared with it.
export function review(input: string, reference?: string) {
  requireFile(input);
  const target = reference ? sound.bandLevels(sound.monoOf(requireFile(reference))) : TYPICAL_MIX;
  const than = reference ? "the reference" : "a typical pop mix";
  const tone = reference ? 2 : 1; // how much tonal problems count: less against the rough built-in balance
  const issues: { problem: string; fix: string; weight: number }[] = [];
  const add = (weight: number, problem: string, fix: string) => issues.push({ problem, fix, weight });
  const file = JSON.stringify(input);
  const channels = sound.decode(input);
  const length = channels[0].length / sound.RATE;
  if (length < 3) throw new Error("A review needs at least 3 seconds of sound.");

  // Loudness: the level online video aims for, without clipping.
  const level = listen.loudness(input);
  for (const issue of level.issues) add(2, issue.problem, issue.fix);
  if (level.lufs > -60 && level.range < 2) add(1, `squashed: hardly any loud and quiet parts (range ${level.range} LU)`, "let the verses be quieter than the choruses (lower part volumes, or fewer parts) instead of everything at full level");

  // Tonal balance, against the reference (or a typical pop mix).
  const measured = sound.bandLevels(sound.monoOf(input));
  const off = (from: number, to: number) => measured.slice(from, to + 1).reduce((s, v, k) => s + v - target[from + k], 0) / (to - from + 1);
  const low = off(0, 2), mud = off(3, 4), presence = off(6, 7), air = off(8, 9);
  if (low < -8) add(tone, `thin low end (${round(low, 1)} dB under ${than} below 150 Hz)`, `node joedit.ts sound eq ${file} fuller.wav --bass 4   (or a louder bass part / kick)`);
  if (low > 6) add(tone, `boomy low end (${round(low, 1)} dB over ${than} below 150 Hz)`, `node joedit.ts sound eq ${file} tighter.wav --bass -4`);
  if (mud > 5) add(tone, `muddy low-mids (${round(mud, 1)} dB over ${than} at 250-500 Hz)`, 'cut 250-500 Hz on pads, keys and guitars: "fx": {"eq": {"low": -4}} on those parts, or fewer parts playing in the same octave');
  if (presence < -7) add(tone, `dull: little bite at 2-4 kHz (${round(presence, 1)} dB under ${than})`, `node joedit.ts sound eq ${file} brighter.wav --treble 4   (or "fx": {"eq": {"high": 3}} on the lead)`);
  if (presence > 6) add(tone, `harsh 2-4 kHz (${round(presence, 1)} dB over ${than})`, `node joedit.ts sound eq ${file} softer.wav --treble -3`);
  if (air < -10) add(1, `no air: little above 8 kHz (${round(air, 1)} dB under ${than})`, "add hi-hats, shakers or a brighter reverb; or: sound eq --treble 3");
  if (reference && Math.max(Math.abs(low), Math.abs(mud), Math.abs(presence), Math.abs(air)) > 4) {
    add(0, "the tonal balance differs from the reference", `node joedit.ts sound match ${file} matched.wav --reference ${JSON.stringify(reference)}`);
  }

  // Stereo width: how alike the left and right sides are (1 = the same, mono).
  if (channels.length > 1) {
    let both = 0, left = 0, right = 0;
    for (let i = 0; i < channels[0].length; i += 4) {
      both += channels[0][i] * channels[1][i];
      left += channels[0][i] ** 2;
      right += channels[1][i] ** 2;
    }
    const alike = both / Math.sqrt(left * right + 1e-12);
    if (alike > 0.97) add(1, "mono: left and right are the same, so it sounds small", 'pan parts apart ("pan": -0.4 / 0.4), "double": true on guitars or keys, or a wider reverb');
    if (alike < 0.3) add(1, "very wide or out of phase: it may sound hollow, and parts vanish on a phone speaker", "pan parts closer to the middle; keep bass and kick centred");
  }

  // Energy over the song (2-second steps): does it build and drop, or stay the same all the way?
  const { full } = listen.energy(input, 0.5);
  const smooth = full.map((_, i) => full.slice(Math.max(0, i - 2), i + 2).reduce((s, v) => s + v, 0) / (Math.min(full.length, i + 2) - Math.max(0, i - 2)));
  const sorted = [...smooth].filter((v) => v > -60).sort((a, b) => a - b);
  const contrast = sorted.length ? round(sorted[Math.floor(sorted.length * 0.9)] - sorted[Math.floor(sorted.length * 0.1)], 1) : 0;
  if (length >= 20 && contrast < 3) add(2, `flat: the energy stays the same all the way (${contrast} dB between the quiet and loud parts)`, "give it sections: a sparser intro and verse, a fuller chorus, a break; bring parts in and out every 8 bars");
  // The start and the ending.
  const quietStart = full.findIndex((v) => v > -50) * 0.5;
  if (quietStart > 1) add(1, `${quietStart} s of silence before the music starts`, `node joedit.ts sound trim ${file} trimmed.wav --start ${quietStart} --end ${round(length)}`);
  const end = full.slice(-2).reduce((s, v) => s + v, 0) / 2;
  const middle = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : -60;
  if (length >= 10 && end > middle - 3) add(1, "it stops abruptly at full level", `end on a held chord or let it ring out; or: node joedit.ts sound fade ${file} ending.wav --out 2`);

  const score = Math.max(0, 10 - issues.reduce((s, i) => s + i.weight, 0));
  return {
    score,
    verdict: score >= 9 ? "ready to use" : score >= 6 ? "good, with a few fixes" : "needs work",
    measured: { lufs: level.lufs, peak: level.peak, range: level.range, contrast, low: round(low, 1), lowMids: round(mud, 1), presence: round(presence, 1), air: round(air, 1) },
    issues: issues.map(({ problem, fix }) => ({ problem, fix })),
  };
}

export const commands: Record<string, Command> = {
  compose: {
    usage: "compose <score.json> <output.wav|.mp3|.mid> [--stems folder]  (needs: install instruments)",
    run: (a) => {
      if (a.positional.length < 2) throw new Error("Give the score file and the output.");
      return compose(a.positional[0], a.positional[1], { stems: a.flags.stems });
    },
  },
  starters: {
    usage: "starters  → a finished starting score for each genre (pop, lofi, rock, cinematic, edm, hiphop, jazz, folk, orchestral, ambient)",
    run: () => ({ starters: Object.entries(STARTERS).map(([name, s]) => ({ name, description: s.description })) }),
  },
  starter: {
    usage: `starter <${Object.keys(STARTERS).join("|")}> <score.json>  (writes a starting score to change and compose)`,
    run: (a) => {
      const [name, output] = a.positional;
      if (!STARTERS[name]) throw new Error(`Unknown starter "${name}". Starters: ${Object.keys(STARTERS).join(", ")}`);
      if (!output) throw new Error("Give the score file to write, e.g. starter pop score.json");
      writeFileSync(output, JSON.stringify(STARTERS[name].score, null, 2));
      return { output, description: STARTERS[name].description, next: `node joedit.ts music compose ${JSON.stringify(output)} song.wav` };
    },
  },
  instruments: {
    usage: "instruments  → instrument names, drum sounds, drum styles, chord rhythms, amps, feels, section changes and master presets",
    run: () => ({
      aliases: Object.keys(INSTRUMENT_ALIASES),
      instruments: [...INSTRUMENTS, "pluck"],
      drums: Object.keys(DRUM_SOUNDS),
      drumStyles: Object.keys(DRUM_STYLES),
      rhythms: RHYTHMS,
      chords: Object.keys(CHORD_SHAPES).map((shape) => `C${shape}`),
      amps: Object.keys(AMPS),
      reverbs: Object.keys(sound.ROOMS),
      feels: Object.keys(FEELS),
      into: INTOS,
      masters: MASTERS,
    }),
  },
  review: {
    usage: "review <song> [--reference track.mp3]  → score 0-10, what a mixing engineer would fix (loudness, muddy/thin/dull/harsh, width, build and drops, ending) and how",
    run: (a) => review(requireFile(a.positional[0]), a.flags.reference),
  },
  song: {
    usage:
      'song <output.wav> --prompt "style, mood, instruments, voice" [--lyrics lyrics.txt] [--duration 30] [--bpm N] [--seed N] [--steps N] [--model turbo|sft|base|xl] [--guidance 7] [--takes 1]  (needs: install song)',
    run: (a) => {
      if (!a.positional[0]) throw new Error("Missing output path.");
      return song(a.positional[0], a.flags.prompt ?? "", { ...songFlags(a), duration: optionalNumberFlag(a, "duration", 30) });
    },
  },
  sing: {
    usage: 'sing <instrumental> <output.wav> --lyrics lyrics.txt --prompt "the voice and style" [--vocals voice.wav] [--language en] [--seed N] [--steps 32] [--guidance 7] [--takes 1]  (needs: install song --extra base)',
    run: (a) => {
      const [instrumental, output] = a.positional;
      if (!instrumental || !output) throw new Error("Give the instrumental and the output: sing beat.wav song.wav --lyrics lyrics.txt --prompt ...");
      const { lyrics, ...options } = songFlags(a);
      return sing(instrumental, output, lyrics ?? "", a.flags.prompt ?? "", { ...options, vocals: a.flags.vocals });
    },
  },
  repaint: {
    usage: 'repaint <song> <output.wav> --start S --end S --prompt "style, and what to change" [--lyrics lyrics.txt] [--language en] [--model turbo|sft|base|xl] [--seed N] [--steps N] [--guidance 7] [--takes 1]  (needs: install song)',
    run: (a) => {
      const [input, output] = a.positional;
      if (!input || !output) throw new Error("Give the song and the output.");
      return repaint(input, output, numberFlag(a, "start"), numberFlag(a, "end"), a.flags.prompt ?? "", songFlags(a));
    },
  },
};

// Only run the CLI when this file is executed directly (not when imported).
if (import.meta.main) {
  runCli("joEdit music: node joedit.ts music <command> ...", commands, process.argv.slice(2));
}

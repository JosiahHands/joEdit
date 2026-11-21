// Hearing for AI agents: turn sound into numbers, text and pictures.
// Works on audio files and on the sound of video files.
// CLI:     node joedit.ts listen <command> ...
// Library: import { beats } from "./joEdit/areas/listen.ts"
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FFMPEG,
  analyze,
  drawText,
  saveCanvas,
  skia,
  ffmpeg,
  formatTime,
  inOut,
  numberFlag,
  optionalNumberFlag,
  readJson,
  requireFile,
  round,
  runCli,
  withTempDir,
  AI_MODELS,
  loadModel,
  requireModel,
  transformers,
  type Command,
} from "../core/shared.ts";
import * as sound from "./sound.ts";

// ---------- Pictures of sound ----------

// Waveform picture with a time ruler underneath. Loud parts are tall, silence is flat.
export async function wave(input: string, output: string, width = 1200, height = 240): Promise<void> {
  const { duration } = sound.info(input);
  await withTempDir(async (folder) => {
    const plain = join(folder, "wave.png");
    ffmpeg([
      "-i", input,
      "-filter_complex", `aformat=channel_layouts=mono,showwavespic=s=${width}x${height}:colors=0x4FC3F7`,
      "-frames:v", "1",
      plain,
    ]);
    // The wave on a dark background, with time labels at the start, 1/4, 1/2, 3/4 and end.
    const { createCanvas, loadImage } = await skia();
    const canvas = createCanvas(width, height + 24);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#202020";
    ctx.fillRect(0, 0, width, height + 24);
    ctx.drawImage(await loadImage(plain), 0, 0);
    for (const part of [0, 0.25, 0.5, 0.75, 1]) {
      const align = part === 0 ? "left" : part === 1 ? "right" : "center";
      drawText(ctx, formatTime(part * duration), part * width + (part === 0 ? 4 : part === 1 ? -4 : 0), height + 4, { size: 14, weight: 500, align });
    }
    await saveCanvas(canvas, output);
  });
}

// Spectrogram picture: time left to right, pitch bottom to top, brightness = loudness.
// Good for seeing hum, hiss, music vs speech, and where sounds start.
export function spectrum(input: string, output: string): void {
  sound.info(input); // fails early with a clear message if there is no sound
  ffmpeg(["-i", input, "-lavfi", "showspectrumpic=s=1200x400:legend=1", "-frames:v", "1", output]);
}

// ---------- Numbers about sound ----------

export type Issue = { problem: string; fix: string };

export type Loudness = {
  lufs: number; // average loudness. Online video aims for about -14
  peak: number; // loudest moment in dB. Above -1 may distort
  range: number; // how much the loudness changes (LU)
  verdict: string;
  issues: Issue[];
};

// Measure loudness the way broadcasters and YouTube do (EBU R128).
export function loudness(input: string): Loudness {
  const log = analyze(input, "audio", "ebur128=peak=true");
  const summary = log.slice(log.lastIndexOf("Summary:"));
  const lufs = Number(summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1] ?? -70);
  const range = Number(summary.match(/LRA:\s+([\d.]+) LU/)?.[1] ?? 0);
  const peakText = summary.match(/Peak:\s+(-?[\d.]+|-inf) dBFS/)?.[1] ?? "-inf";
  const peak = peakText === "-inf" ? -100 : Number(peakText);

  const issues: Issue[] = [];
  const file = JSON.stringify(input);
  if (lufs <= -60) {
    issues.push({ problem: "the sound is silent", fix: "add sound: node joedit.ts video add-audio, or remove it: node joedit.ts video mute" });
  } else {
    if (lufs < -20) issues.push({ problem: `too quiet (${lufs} LUFS, online video aims for -14)`, fix: `node joedit.ts sound normalize ${file} fixed-sound.wav` });
    if (lufs > -9) issues.push({ problem: `too loud (${lufs} LUFS, online video aims for -14)`, fix: `node joedit.ts sound normalize ${file} fixed-sound.wav` });
    if (peak > -1) issues.push({ problem: `peaks at ${peak} dB may distort (clip)`, fix: `node joedit.ts sound normalize ${file} fixed-sound.wav` });
  }
  const verdict = issues.length ? issues.map((i) => i.problem).join("; ") : "good";
  return { lufs, peak, range, verdict, issues };
}

export type Silence = { start: number; end: number; duration: number };

// Find quiet parts. db: how quiet counts as silence (-35 is good for speech). min: shortest gap in seconds.
export function silences(input: string, db = -35, min = 0.5): { silences: Silence[]; count: number; total: number } {
  const { duration } = sound.info(input);
  const log = analyze(input, "audio", `silencedetect=n=${db}dB:d=${min}`);
  const starts = [...log.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Math.max(0, Number(m[1])));
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  // If the file ends while silent, there is no silence_end, so the end of the file is used.
  const list = starts.map((start, n) => {
    const end = ends[n] ?? duration;
    return { start: round(start), end: round(end), duration: round(end - start) };
  });
  const total = round(list.reduce((sum, s) => sum + s.duration, 0));
  return { silences: list, count: list.length, total };
}

// ---------- Beats ----------

const RATE = 11025; // samples per second used for beat finding (plenty for drums and clicks)
const HOP = 128; // samples between measurements (about 12 ms)
const WINDOW = 256; // samples in each loudness measurement

// Decode any sound to mono numbers between -1 and 1.
function samples(input: string): Float32Array {
  sound.info(input); // a clear message when the file has no sound
  const bytes = execFileSync(
    FFMPEG,
    ["-hide_banner", "-loglevel", "error", "-i", input, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"],
    { maxBuffer: 1024 * 1024 * 1024 },
  );
  // Copy into a fresh buffer so the numbers line up in memory.
  return new Float32Array(new Uint8Array(bytes).buffer);
}

// Loudness of each video frame, from 0 (silent) to 1 (loudest moment). Used for audio-reactive graphics.
export function levels(input: string, fps: number): number[] {
  const data = samples(input);
  const perFrame = RATE / fps;
  const frames = Math.floor(data.length / perFrame);
  const values: number[] = [];
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = Math.floor(f * perFrame);
    const end = Math.floor((f + 1) * perFrame);
    for (let i = start; i < end; i++) sum += data[i] * data[i];
    values.push(Math.sqrt(sum / (end - start))); // RMS = average strength
  }
  const loudest = Math.max(...values, 1e-9);
  return values.map((v) => round(v / loudest, 3));
}

// How much the sound suddenly gets louder at each moment. Peaks are drum hits, notes and claps.
function onsetStrength(data: Float32Array): number[] {
  const frames = Math.floor((data.length - WINDOW) / HOP);
  const strength: number[] = [];
  let previous = 0;
  for (let f = 0; f < frames; f++) {
    let energy = 0;
    for (let i = f * HOP; i < f * HOP + WINDOW; i++) energy += data[i] * data[i];
    const level = Math.log(1 + 1000 * energy); // log makes quiet and loud songs comparable
    strength.push(Math.max(0, level - previous)); // only count sound getting louder
    previous = level;
  }
  return strength;
}

// Find the beat length (in frames) by checking which spacing lines the hits up best.
function beatPeriod(strength: number[], framesPerSecond: number): number {
  let bestLag = 0;
  let bestScore = -1;
  // Try every tempo from 60 to 200 BPM.
  const minLag = Math.floor((framesPerSecond * 60) / 200);
  const maxLag = Math.ceil((framesPerSecond * 60) / 60);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let i = 0; i + lag < strength.length; i++) score += strength[i] * strength[i + lag];
    score /= strength.length - lag;
    // Prefer tempos near 120 BPM, so a song is not reported at half or double speed.
    const bpm = (framesPerSecond * 60) / lag;
    score *= Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return bestLag;
}

// How well a beat grid (period and first beat, in frames) lines up with the hits: the strength under each beat.
function gridScore(strength: number[], period: number, offset: number): number {
  let score = 0;
  for (let f = offset; f < strength.length; f += period) score += strength[Math.round(f)] ?? 0;
  return score;
}

// Find where the first beat is, so the beat grid lines up with the actual hits.
function beatOffset(strength: number[], period: number): number {
  let bestOffset = 0;
  let bestScore = -1;
  for (let offset = 0; offset < period; offset++) {
    const score = gridScore(strength, period, offset);
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  return bestOffset;
}

// The beat length in whole frames is only roughly right (140 BPM would read as 139.7). Try lengths between
// the neighbouring frames, in small steps, and keep the one that lines up best over the whole song.
function finePeriod(strength: number[], period: number): { period: number; offset: number } {
  let best = { period, offset: beatOffset(strength, period), score: -1 };
  for (let p = period - 1; p <= period + 1; p += 0.01) {
    const offset = beatOffset(strength, p);
    const score = gridScore(strength, p, offset);
    if (score > best.score) best = { period: p, offset, score };
  }
  return best;
}

// Tempo (BPM), the time of every beat, and the downbeats (the first beat of each bar, where the kick drum lands).
// Use the times to cut video on the beat, and the downbeats for the big cuts.
export function beats(input: string, beatsPerBar = 4): { bpm: number; beats: number[]; count: number; downbeats: number[]; bars: number } {
  const data = samples(input);
  if (data.length < RATE * 3) throw new Error("The sound is too short to find a beat (needs 3+ seconds).");
  const framesPerSecond = RATE / HOP;
  const strength = onsetStrength(data);
  const { period, offset } = finePeriod(strength, beatPeriod(strength, framesPerSecond));
  // The grid may start a beat late (the very first hit has nothing before it to compare with): step back while a beat fits.
  let first = offset;
  while (first - period > -2) first -= period;
  const frames: number[] = [];
  for (let f = Math.max(0, first); f < strength.length; f += period) frames.push(f);
  // Each strength value describes the sound at the end of its measurement window.
  const time = (f: number) => round((f * HOP + WINDOW) / RATE);
  // Downbeats: of the beatsPerBar ways to group the beats into bars, the one whose first beats have the most low end
  // (the kick and bass land on beat 1), helped by how big the hit is (chords change and cymbals crash on beat 1).
  const low = lowPass(data, 150);
  const lowEnergy = (f: number) => {
    const start = Math.round(f * HOP + WINDOW / 2);
    let sum = 0;
    for (let i = start; i < Math.min(low.length, start + Math.round(0.06 * RATE)); i++) sum += low[i] * low[i];
    return sum;
  };
  const hitSize = (f: number) => Math.max(...[-2, -1, 0, 1, 2].map((d) => strength[Math.round(f) + d] ?? 0));
  const phaseAverage = (measure: (f: number) => number) =>
    Array.from({ length: beatsPerBar }, (_, k) => {
      const values = frames.filter((_, n) => n % beatsPerBar === k).map(measure);
      return values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
    });
  const lows = phaseAverage(lowEnergy);
  const hits = phaseAverage(hitSize);
  const share = (values: number[], k: number) => values[k] / Math.max(1e-12, values.reduce((s, v) => s + v, 0));
  // Most music starts on beat 1, so the first beat with sound gets a small bonus. It only decides near-ties,
  // e.g. rock with the kick on beats 1 and 3, or a kick on every beat.
  const loudestHit = Math.max(...frames.map(hitSize));
  const firstSounding = Math.max(0, frames.findIndex((f) => hitSize(f) > 0.3 * loudestHit)) % beatsPerBar;
  const scores = lows.map((_, k) => share(lows, k) + 0.5 * share(hits, k) + (k === firstSounding ? 0.05 : 0));
  const phase = scores.indexOf(Math.max(...scores));
  const downbeats = frames.filter((_, n) => n % beatsPerBar === phase).map(time);
  return { bpm: round((framesPerSecond * 60) / period, 1), beats: frames.map(time), count: frames.length, downbeats, bars: downbeats.length };
}

// Keep only the low sound (below `hz`): two simple smoothing passes.
function lowPass(data: Float32Array, hz: number, rate = RATE): Float32Array {
  const a = Math.exp((-2 * Math.PI * hz) / rate);
  const out = new Float32Array(data.length);
  let one = 0;
  let two = 0;
  for (let i = 0; i < data.length; i++) {
    one = a * one + (1 - a) * data[i];
    two = a * two + (1 - a) * one;
    out[i] = two;
  }
  return out;
}

// ---------- Tonal balance and energy ----------

// How much bass, middle and treble a sound has: each octave band in dB compared with the whole sound.
// With a reference, also how far each band is from it (positive = this sound has more there).
export function bands(input: string, reference?: string) {
  const named = (values: number[]) => Object.fromEntries(sound.BAND_CENTERS.map((c, k) => [sound.bandName(c), values[k]]));
  const levels = sound.bandLevels(sound.monoOf(requireFile(input)));
  const strongest = sound.BAND_CENTERS[levels.indexOf(Math.max(...levels))];
  if (!reference) return { bands: named(levels), strongest: sound.bandName(strongest) };
  const target = sound.bandLevels(sound.monoOf(requireFile(reference)));
  const difference = levels.map((v, k) => round(v - target[k], 1));
  return { bands: named(levels), strongest: sound.bandName(strongest), reference: named(target), difference: named(difference) };
}

// The loudness over time (dB), for the whole sound and for the low end (below 150 Hz: kick and bass),
// plus the biggest jumps: the moments the sound gets much louder (drops), to check that they land on cuts.
export function energy(input: string, every = 0.1) {
  const data = samples(input);
  const low = lowPass(data, 150);
  const size = Math.max(1, Math.round(every * RATE));
  const db = (values: Float32Array, start: number) => {
    let sum = 0;
    for (let i = start; i < start + size; i++) sum += values[i] * values[i];
    return round(10 * Math.log10(sum / size + 1e-10), 1);
  };
  const full: number[] = [];
  const bass: number[] = [];
  for (let start = 0; start + size <= data.length; start += size) {
    full.push(db(data, start));
    bass.push(db(low, start));
  }
  // A jump: the half second after is much louder than the half second before.
  const reach = Math.max(1, Math.round(0.5 / every));
  const average = (from: number, to: number) => full.slice(Math.max(0, from), to).reduce((s, v) => s + v, 0) / Math.max(1, Math.min(to, full.length) - Math.max(0, from));
  const rises = full.map((_, i) => (i < reach || i + reach > full.length ? 0 : average(i, i + reach) - average(i - reach, i)));
  const jumps = rises
    .map((rise, i) => ({ time: round(i * every, 2), rise: round(rise, 1) }))
    .filter((j, i) => j.rise >= 6 && rises[i] === Math.max(...rises.slice(Math.max(0, i - reach), i + reach + 1)))
    .sort((a, b) => b.rise - a.rise)
    .slice(0, 10)
    .sort((a, b) => a.time - b.time);
  return { every, full, low: bass, jumps };
}

// ---------- Words ----------

export type Word = { word: string; start: number; end: number };

export type Transcript = {
  language: string;
  text: string;
  words: Word[];
  segments: { start: number; end: number; text: string }[];
};

// Mono sound as numbers at `rate` per second (AI models want 16000 or 48000). Works on video files too.
export function monoSamples(input: string, rate: number, from = 0, to?: number): Float32Array {
  requireFile(input);
  const bytes = execFileSync(FFMPEG, [
    "-hide_banner", "-loglevel", "error", ...(from ? ["-ss", String(from)] : []), "-i", input,
    ...(to !== undefined ? ["-t", String(Math.max(0.01, to - from))] : []),
    "-vn", "-ac", "1", "-ar", String(rate), "-f", "f32le", "-",
  ], { maxBuffer: 4 * 1024 * 1024 * 1024 });
  return new Float32Array(new Uint8Array(bytes).buffer);
}

// Whisper sizes (each is an AI model to install): bigger is more accurate but slower. All understand about 100 languages.
export const WHISPER_MODELS: Record<string, string> = { tiny: "whisper-tiny", base: "whisper", small: "whisper-small", turbo: "whisper-turbo" };

function whisper(size: string): Promise<any> {
  const name = WHISPER_MODELS[size];
  if (!name) throw new Error(`Unknown model "${size}". Models: ${Object.keys(WHISPER_MODELS).join(", ")}`);
  requireModel(name);
  // The encoder stays exact (good word times, except turbo, which is huge); the decoder is compressed (fast, same words).
  const dtype = { encoder_model: size === "turbo" ? "q4" : "fp32", decoder_model_merged: "q4" };
  return loadModel(`whisper:${size}`, () => transformers().pipeline("automatic-speech-recognition", AI_MODELS[name].repo, { dtype }));
}

// Which language is spoken (e.g. "en", "fr"): Whisper's first guess after hearing up to 30 seconds.
async function detectLanguage(transcriber: any, audio: Float32Array): Promise<string> {
  const { Tensor } = transformers();
  const { input_features } = await transcriber.processor(audio.subarray(0, 16000 * 30));
  const config = transcriber.model.generation_config;
  const start = new Tensor("int64", [BigInt(config.decoder_start_token_id)], [1, 1]);
  const { logits } = await transcriber.model({ input_features, decoder_input_ids: start });
  const vocabulary = logits.dims.at(-1);
  let best = "en";
  let score = -Infinity;
  for (const [token, id] of Object.entries(config.lang_to_id as Record<string, number>)) {
    const value = logits.data[logits.data.length - vocabulary + id];
    if (value > score) [best, score] = [token.slice(2, -2), value]; // "<|fr|>" -> "fr"
  }
  return best;
}

// Whisper's word times can be off by a tenth of a second or more, so they are lined up with the sound itself (16 kHz).
// The real pauses are found (quiet for 40 ms or more); every gap between words is matched, in order, to the nearest
// pause within 0.3 s, and the words around it are moved to the pause's edges. Gaps with no pause near (words that
// run together) stay as Whisper heard them.
// Pauses in speech (16 kHz numbers): [start, end] of every stretch quieter than -30 dB of the loudest moment for 40 ms or more.
export function speechPauses(audio: Float32Array): [number, number][] {
  const steps = Math.ceil(audio.length / 160); // 10 ms each
  const level = new Float32Array(steps);
  for (let f = 0; f < steps; f++) {
    let sum = 0;
    for (let i = f * 160; i < Math.min(audio.length, (f + 1) * 160); i++) sum += audio[i] * audio[i];
    level[f] = Math.sqrt(sum / 160);
  }
  const quiet = level.reduce((a, b) => Math.max(a, b), 0) * 0.03;
  const pauses: [number, number][] = [];
  let from = -1;
  for (let f = 0; f <= steps; f++) {
    const silent = f < steps && level[f] <= quiet;
    if (silent && from < 0) from = f;
    if (!silent && from >= 0) {
      if (f - from >= 4) pauses.push([from / 100, f / 100]);
      from = -1;
    }
  }
  return pauses;
}

function alignWords(words: Word[], audio: Float32Array): Word[] {
  if (!words.length) return words;
  // 1. The real pauses.
  const pauses = speechPauses(audio);
  const steps = Math.ceil(audio.length / 160);
  const n = words.length;
  const aligned = words.map((w) => ({ ...w }));
  // 2. Speech starts where the silence at the start ends, and stops where the silence at the end starts.
  const first = pauses.find(([start]) => start === 0);
  if (first && Math.abs(first[1] - aligned[0].start) <= 0.3) aligned[0].start = first[1];
  const last = pauses.findLast(([, end]) => end >= steps / 100 - 0.01);
  if (last && Math.abs(last[0] - aligned[n - 1].end) <= 0.3) aligned[n - 1].end = last[0];
  const inner = pauses.filter((p) => p !== first && p !== last);
  // 3. Gap k is between word k-1 and word k. Distance: from the middle of Whisper's gap to the pause (0 if inside it).
  const distance = (k: number, [start, end]: [number, number]) => {
    const at = (words[k - 1].end + words[k].start) / 2;
    return at < start ? start - at : at > end ? at - end : 0;
  };
  // Best matching in order (each pause used once): cost = how far each match is, plus 0.12 for a gap left unmatched.
  // States: the last pause used -> [cost, matches so far]. Old states that can no longer differ are merged.
  let states = new Map<number, { cost: number; matches: [number, number][] }>([[-1, { cost: 0, matches: [] }]]);
  for (let k = 1; k < n; k++) {
    const candidates = inner.map((p, j) => ({ j, d: distance(k, p) })).filter((c) => c.d <= 0.3);
    const next = new Map<number, { cost: number; matches: [number, number][] }>();
    const keep = (last: number, cost: number, matches: [number, number][]) => {
      const old = next.get(last);
      if (!old || cost < old.cost) next.set(last, { cost, matches });
    };
    for (const [last, state] of states) {
      keep(last, state.cost + 0.12, state.matches);
      for (const { j, d } of candidates) if (j > last) keep(j, state.cost + d, [...state.matches, [k, j]]);
    }
    // States whose last pause is before every candidate of the next gaps behave the same: keep only the cheapest.
    const lowest = Math.min(...candidates.map((c) => c.j), Infinity);
    let early: [number, { cost: number; matches: [number, number][] }] | undefined;
    for (const entry of next) if (entry[0] < lowest && (!early || entry[1].cost < early[1].cost)) early = entry;
    states = new Map([...next].filter(([last]) => last >= lowest));
    if (early) states.set(early[0], early[1]);
  }
  const best = [...states.values()].sort((a, b) => a.cost - b.cost)[0];
  // 4. Move the words on both sides of each matched pause onto its edges.
  for (const [k, j] of best.matches) {
    aligned[k - 1].end = inner[j][0];
    aligned[k].start = inner[j][1];
  }
  return aligned.map((w) => ({ word: w.word, start: round(w.start), end: round(Math.max(w.start + 0.03, w.end)) }));
}

// Group words into sentences: a new one after . ? ! or a pause longer than 0.8 s.
function sentences(words: Word[]): Transcript["segments"] {
  const segments: Transcript["segments"] = [];
  let current: Word[] = [];
  words.forEach((word, n) => {
    current.push(word);
    const next = words[n + 1];
    if (!next || /[.?!]$/.test(word.word) || next.start - word.end > 0.8 || current.length >= 30) {
      segments.push({ start: current[0].start, end: word.end, text: current.map((w) => w.word).join(" ") });
      current = [];
    }
  });
  return segments;
}

// Speech to text with the time of every word, with Whisper running inside Node.
// model: tiny, base, small or turbo (bigger = better but slower). language: a code or name ("fr", "french"), or found automatically.
// ---------- Subtitle files ----------

// Split words into short groups that fit on screen: at most maxChars, a new group after a pause or a sentence end.
// Used for subtitle files here and for burned-in captions (graphics).
export function wordGroups<T extends Word>(words: T[], maxChars: number): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  for (const word of words) {
    const length = current.map((w) => w.word).join(" ").length + word.word.length + 1;
    const previous = current[current.length - 1];
    const pause = previous ? word.start - previous.end : 0;
    const sentenceEnded = previous ? /[.!?]$/.test(previous.word) : false;
    if (current.length && (length > maxChars || pause > 0.7 || sentenceEnded)) {
      groups.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length) groups.push(current);
  return groups;
}

// "srt" or "vtt" from a file name, or "" for other files.
function subtitleFormat(file: string): "srt" | "vtt" | "" {
  const type = file.split(".").pop()?.toLowerCase();
  return type === "srt" || type === "vtt" ? type : "";
}

// Subtitle file text: numbered lines (srt) or a WebVTT file, each line on screen while it is said.
export function subtitleText(words: Word[], format: "srt" | "vtt", maxChars = 42): string {
  const stamp = (seconds: number) => {
    const ms = Math.round(seconds * 1000);
    const pad = (n: number, size = 2) => String(n).padStart(size, "0");
    const time = `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}`;
    return `${time}${format === "srt" ? "," : "."}${pad(ms % 1000, 3)}`;
  };
  const groups = wordGroups(words, maxChars);
  const cues = groups.map((group, n) => {
    const start = group[0].start;
    // Stay a moment after the last word (at least 0.8 s on screen), but never past the next line's start.
    const next = groups[n + 1]?.[0].start ?? Infinity;
    const end = Math.min(Math.max(group[group.length - 1].end + 0.3, start + 0.8), next);
    const text = group.map((w) => w.word).join(" ");
    return `${format === "srt" ? `${n + 1}\n` : ""}${stamp(start)} --> ${stamp(end)}\n${text}\n`;
  });
  return (format === "vtt" ? "WEBVTT\n\n" : "") + cues.join("\n");
}

// Turn a transcript (words.json from transcribe or speakers, or voice speak --words) into a .srt or .vtt file,
// for players and platforms that show subtitles themselves (YouTube, Vimeo, video players, the web).
export function subtitles(transcript: string, output: string, maxChars = 42) {
  const format = subtitleFormat(output);
  if (!format) throw new Error("The output must be a .srt or .vtt file.");
  const words: Word[] = readJson(transcript).words ?? [];
  if (!words.length) throw new Error(`${transcript} has no words. Make one with: node joedit.ts listen transcribe <sound> words.json`);
  writeFileSync(output, subtitleText(words, format, maxChars));
  return { lines: wordGroups(words, maxChars).length, format };
}

export async function transcribe(input: string, output: string, model = "base", language = ""): Promise<{ language: string; words: number; text: string }> {
  const audio = monoSamples(input, 16000);
  const transcriber = await whisper(model);
  const spoken = language || (await detectLanguage(transcriber, audio));
  const result = await transcriber(audio, { return_timestamps: "word", chunk_length_s: 30, language: spoken, task: "transcribe" });
  let words: Word[] = [];
  for (const chunk of result.chunks ?? []) {
    const text: string = chunk.text;
    const start = round(chunk.timestamp[0] ?? 0);
    const end = round(chunk.timestamp[1] ?? chunk.timestamp[0] ?? 0);
    if (!text.trim()) continue;
    // A piece without a space in front continues the word before it ("word" + "-level", "aujourd" + "'hui").
    const last = words.at(-1);
    if (last && !/^\s/.test(text)) {
      last.word += text.trim();
      last.end = end;
    } else words.push({ word: text.trim(), start, end });
  }
  words = alignWords(words, audio);
  const transcript: Transcript = { language: spoken, text: words.map((w) => w.word).join(" "), words, segments: sentences(words) };
  // A .srt or .vtt output is a subtitle file; anything else gets the full transcript as JSON.
  const format = subtitleFormat(output);
  writeFileSync(output, format ? subtitleText(words, format) : JSON.stringify(transcript, null, 2));
  const preview = transcript.text.length > 200 ? `${transcript.text.slice(0, 200)}...` : transcript.text;
  return { language: transcript.language, words: transcript.words.length, text: preview };
}

// ---------- Search sounds by meaning (CLAP) ----------
// Sounds and descriptions become vectors; a sound and a description that mean the same thing point the same way.

function soundModel(): Promise<any> {
  requireModel("sounds");
  const library = transformers();
  const repo = AI_MODELS.sounds.repo;
  return loadModel("sounds", async () => ({
    features: await library.ClapFeatureExtractor.from_pretrained(repo),
    tokenizer: await library.AutoTokenizer.from_pretrained(repo),
    sounds: await library.ClapAudioModelWithProjection.from_pretrained(repo, { dtype: "fp32" }),
    words: await library.ClapTextModelWithProjection.from_pretrained(repo, { dtype: "q8" }),
  }));
}

function unit(vector: Float32Array): Float32Array {
  const length = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / length);
}

// A vector for every `window` seconds of sound (48 kHz numbers), stepping by half a window.
// Near-silent windows get no vector: silence looks like anything to CLAP.
export async function soundVectors(audio: Float32Array, window = 4): Promise<{ start: number; end: number; vector: Float32Array }[]> {
  const model = await soundModel();
  const size = Math.min(window * 48000, audio.length);
  const starts: number[] = [];
  for (let from = 0; from + size < audio.length; from += size / 2) starts.push(Math.round(from));
  starts.push(audio.length - size); // the last window ends exactly at the end
  const loudness = (from: number) => {
    let sum = 0;
    for (let i = from; i < from + size; i++) sum += audio[i] * audio[i];
    return Math.sqrt(sum / size);
  };
  const loudest = Math.max(...starts.map(loudness));
  const result: { start: number; end: number; vector: Float32Array }[] = [];
  for (const from of starts) {
    if (loudness(from) < loudest * 0.03) continue; // 30 dB quieter than the loudest part
    const { audio_embeds } = await model.sounds(await model.features(audio.subarray(from, from + size)));
    result.push({ start: round(from / 48000), end: round((from + size) / 48000), vector: unit(audio_embeds.data) });
  }
  return result;
}

// The vector of a description of a sound.
export async function soundWordsVector(text: string): Promise<Float32Array> {
  const model = await soundModel();
  const { text_embeds } = await model.words(model.tokenizer([text], { padding: true, truncation: true }));
  return unit(text_embeds.data);
}

// Find the moments that sound like a description. Short sound labels work best: "speech", "dog barking",
// "applause", "explosion", "laughter", "music", "bell". Scores: about 0.3 or more is a clear match, under 0.1 is not there.
export async function find(input: string, query: string, options: { top?: number; window?: number } = {}) {
  if (!query.trim()) throw new Error('Describe the sound with --query, e.g. --query "dog barking".');
  const { top = 5, window = 4 } = options;
  const pieces = await soundVectors(monoSamples(input, 48000), window);
  const words = await soundWordsVector(query);
  const scored = pieces.map((p, n) => ({ ...p, n, score: p.vector.reduce((sum, v, i) => sum + v * words[i], 0) }));
  // Best first; a match grows over the neighbouring windows that also match well. Overlapping matches are skipped.
  const matches: { start: number; end: number; score: number }[] = [];
  const taken = (w: { start: number; end: number }) => matches.some((m) => w.start < m.end && w.end > m.start);
  for (const piece of [...scored].sort((a, b) => b.score - a.score)) {
    if (matches.length === top) break;
    if (taken(piece)) continue;
    let first = piece.n;
    let last = piece.n;
    // (a neighbour only counts when it touches in time, since silent windows were skipped, and is not in another match)
    const grows = (from: number, to: number) =>
      scored[to] && scored[to].start < scored[from].end && scored[to].end > scored[from].start &&
      scored[to].score >= piece.score * 0.85 && !taken(scored[to]);
    while (grows(first, first - 1)) first--;
    while (grows(last, last + 1)) last++;
    matches.push({ start: scored[first].start, end: scored[last].end, score: round(piece.score, 3) });
  }
  return { query, searched: pieces.length, matches };
}

// Everyday sounds that soundTags names.
export const SOUND_LABELS = [
  "speech", "music", "singing", "laughter", "applause", "crowd", "dog barking", "birds", "car engine", "siren",
  "wind", "rain", "water", "explosion", "gunshot", "footsteps", "door knock", "bell", "phone ringing", "typing",
];

// What can be heard when: the best-fitting SOUND_LABELS name for every few seconds, joined into moments.
export async function soundTags(input: string, window = 4): Promise<{ label: string; moments: [number, number][] }[]> {
  const pieces = await soundVectors(monoSamples(input, 48000), window);
  const labels = await Promise.all(SOUND_LABELS.map((l) => soundWordsVector(l)));
  const tags: Record<string, [number, number][]> = {};
  for (const piece of pieces) {
    const scores = labels.map((l) => l.reduce((sum, v, i) => sum + v * piece.vector[i], 0));
    const best = scores.indexOf(Math.max(...scores));
    if (scores[best] < 0.2) continue; // nothing on the list fits
    const moments = (tags[SOUND_LABELS[best]] ??= []);
    const last = moments.at(-1);
    if (last && piece.start <= last[1]) last[1] = piece.end;
    else moments.push([piece.start, piece.end]);
  }
  return Object.entries(tags).map(([label, moments]) => ({ label, moments }));
}

// ---------- Who speaks when ----------

// One voice fingerprint (WavLM x-vector, length 1) for a stretch of 16 kHz speech.
async function voicePrint(audio: Float32Array): Promise<Float32Array> {
  requireModel("speakers");
  const library = transformers();
  const repo = AI_MODELS.speakers.repo;
  const model = await loadModel<any>("speakers", async () => ({
    features: await library.AutoProcessor.from_pretrained(repo),
    net: await library.WavLMForXVector.from_pretrained(repo, { dtype: "fp32" }),
  }));
  const { embeddings } = await model.net(await model.features(audio));
  const vector = embeddings.data as Float32Array;
  const length = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / length);
}

// Label who speaks each sentence (S1, S2 ... in order of first appearance), from voice fingerprints.
// Sentences whose voices are alike (similarity above 0.6, or until `count` speakers are left) are joined.
// The transcript (from transcribe; made here if not given) is saved with a speaker on every segment and word.
export async function speakers(input: string, output: string, options: { transcript?: string; count?: number; model?: string } = {}) {
  const audio = monoSamples(input, 16000);
  let transcript: Transcript;
  if (options.transcript) transcript = readJson(options.transcript);
  else {
    await transcribe(input, output, options.model ?? "base");
    transcript = readJson(output);
  }
  // Long sentences are split into pieces of up to 8 s (a speaker can change inside a long run of words).
  const pieces: { start: number; end: number; words: Word[] }[] = [];
  for (const segment of transcript.segments) {
    const words = transcript.words.filter((w) => w.start >= segment.start - 0.01 && w.end <= segment.end + 0.01);
    let current: Word[] = [];
    for (const word of words) {
      if (current.length && word.end - current[0].start > 8) {
        pieces.push({ start: current[0].start, end: current.at(-1)!.end, words: current });
        current = [];
      }
      current.push(word);
    }
    if (current.length) pieces.push({ start: current[0].start, end: current.at(-1)!.end, words: current });
  }
  if (!pieces.length) throw new Error("No speech was found.");
  // A fingerprint for each piece long enough to tell voices apart (0.6 s or more).
  const prints: (Float32Array | null)[] = [];
  for (const piece of pieces) {
    prints.push(piece.end - piece.start >= 0.6 ? await voicePrint(audio.subarray(Math.floor(piece.start * 16000), Math.ceil(piece.end * 16000))) : null);
  }
  // Join groups of pieces, the most alike first (average similarity between their fingerprints).
  const similar = (a: Float32Array, b: Float32Array) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  let groups = prints.flatMap((p, n) => (p ? [[n]] : []));
  const likeness = (a: number[], b: number[]) => {
    let sum = 0;
    for (const i of a) for (const j of b) sum += similar(prints[i]!, prints[j]!);
    return sum / (a.length * b.length);
  };
  while (groups.length > 1) {
    let best = { a: 0, b: 1, value: -Infinity };
    for (let a = 0; a < groups.length; a++) for (let b = a + 1; b < groups.length; b++) {
      const value = likeness(groups[a], groups[b]);
      if (value > best.value) best = { a, b, value };
    }
    // The same voice scores about 0.7-0.95 and different voices about 0.25-0.5, so 0.6 sits in the gap.
    if (options.count ? groups.length <= options.count : best.value < 0.6) break;
    groups[best.a] = [...groups[best.a], ...groups[best.b]];
    groups.splice(best.b, 1);
  }
  // Name speakers in the order they first speak. Short pieces get the speaker of the nearest piece in time.
  groups.sort((a, b) => Math.min(...a) - Math.min(...b));
  const who: string[] = [];
  groups.forEach((group, g) => group.forEach((n) => (who[n] = `S${g + 1}`)));
  pieces.forEach((piece, n) => {
    if (who[n]) return;
    const nearest = pieces.map((p, m) => ({ m, gap: Math.abs(p.start - piece.start) })).filter(({ m }) => who[m]).sort((a, b) => a.gap - b.gap)[0];
    who[n] = nearest ? who[nearest.m] : "S1";
  });
  // Save: every piece becomes a segment with its speaker, and every word knows its speaker.
  const segments = pieces.map((p, n) => ({ start: p.start, end: p.end, speaker: who[n], text: p.words.map((w) => w.word).join(" ") }));
  const words = pieces.flatMap((p, n) => p.words.map((w) => ({ ...w, speaker: who[n] })));
  writeFileSync(output, JSON.stringify({ ...transcript, words, segments }, null, 2));
  const names = [...new Set(who)];
  return {
    speakers: names.map((name) => ({
      name,
      seconds: round(segments.filter((s) => s.speaker === name).reduce((sum, s) => sum + s.end - s.start, 0), 1),
      turns: segments.filter((s, n) => s.speaker === name && segments[n - 1]?.speaker !== name).length,
    })),
    segments: segments.length,
  };
}

export const commands: Record<string, Command> = {
  wave: {
    usage: "wave <sound> <output.png> [--width 1200] [--height 240]",
    run: (a) => {
      const { input, output } = inOut(a);
      return wave(input, output, optionalNumberFlag(a, "width", 1200), optionalNumberFlag(a, "height", 240));
    },
  },
  spectrum: {
    usage: "spectrum <sound> <output.png>",
    run: (a) => {
      const { input, output } = inOut(a);
      spectrum(input, output);
    },
  },
  loudness: {
    usage: "loudness <sound>",
    run: (a) => loudness(requireFile(a.positional[0])),
  },
  silences: {
    usage: "silences <sound> [--db -35] [--min 0.5]",
    run: (a) => silences(requireFile(a.positional[0]), optionalNumberFlag(a, "db", -35), optionalNumberFlag(a, "min", 0.5)),
  },
  beats: {
    usage: "beats <sound> [--beats-per-bar 4]  (beat times, downbeats and bars)",
    run: (a) => {
      const perBar = optionalNumberFlag(a, "beats-per-bar", 4);
      if (!Number.isInteger(perBar) || perBar < 1 || perBar > 16) throw new Error("--beats-per-bar is a whole number from 1 to 16 (4 for most music, 3 for a waltz).");
      return beats(requireFile(a.positional[0]), perBar);
    },
  },
  bands: {
    usage: "bands <sound> [--reference ref.wav]  (bass/middle/treble balance per octave, in dB; with a reference: the difference)",
    run: (a) => bands(requireFile(a.positional[0]), a.flags.reference),
  },
  energy: {
    usage: "energy <sound> [--every 0.1]  (loudness over time, full and low end, and the biggest jumps)",
    run: (a) => {
      const every = optionalNumberFlag(a, "every", 0.1);
      if (!(every >= 0.02 && every <= 10)) throw new Error("--every is seconds between measurements, from 0.02 to 10.");
      return energy(requireFile(a.positional[0]), every);
    },
  },
  transcribe: {
    usage: `transcribe <sound> <output.json|.srt|.vtt> [--model ${Object.keys(WHISPER_MODELS).join("|")}] [--language en]  (language is found automatically if not given; .srt/.vtt = a subtitle file)`,
    run: (a) => {
      const { input, output } = inOut(a);
      return transcribe(input, output, a.flags.model ?? "base", a.flags.language ?? "");
    },
  },
  subtitles: {
    usage: "subtitles <words.json> <output.srt|.vtt> [--max-chars 42]  (a subtitle file from a transcript, for players and platforms)",
    run: (a) => {
      const { input, output } = inOut(a);
      return subtitles(input, output, optionalNumberFlag(a, "max-chars", 42));
    },
  },
  find: {
    usage: 'find <sound|video> --query "dog barking" (short labels work best) [--top 5] [--window 4]  (search sounds by meaning; needs: install sounds)',
    run: (a) =>
      find(requireFile(a.positional[0]), a.flags.query ?? "", { top: optionalNumberFlag(a, "top", 5), window: optionalNumberFlag(a, "window", 4) }),
  },
  speakers: {
    usage: "speakers <sound> <output.json> [--transcript words.json] [--speakers N] [--model base]  (who speaks when; needs: install speakers)",
    run: (a) => {
      const { input, output } = inOut(a);
      return speakers(input, output, {
        transcript: a.flags.transcript,
        count: a.flags.speakers === undefined ? undefined : numberFlag(a, "speakers"),
        model: a.flags.model,
      });
    },
  },
};

// Only run the CLI when this file is executed directly (not when imported).
if (import.meta.main) {
  runCli("joEdit listen: node joedit.ts listen <command> ...", commands, process.argv.slice(2));
}

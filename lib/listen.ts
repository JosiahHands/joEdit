// Hearing for AI agents: turn sound into numbers, text and pictures.
// Works on audio files and on the sound of video files.
// CLI:     node joedit.ts listen <command> ...
// Library: import { beats } from "./joEdit/listen.ts"
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_FONT,
  analyze,
  ffmpeg,
  formatTime,
  inOut,
  optionalNumberFlag,
  requireFile,
  round,
  runPack,
  run,
  runCli,
  withTempDir,
  type Command,
} from "./shared.ts";
import * as sound from "./sound.ts";

// ---------- Pictures of sound ----------

// Waveform picture with a time ruler underneath. Loud parts are tall, silence is flat.
export function wave(input: string, output: string, width = 1200, height = 240): void {
  const { duration } = sound.info(input);
  withTempDir((folder) => {
    const plain = join(folder, "wave.png");
    ffmpeg([
      "-i", input,
      "-filter_complex", `aformat=channel_layouts=mono,showwavespic=s=${width}x${height}:colors=0x4FC3F7`,
      "-frames:v", "1",
      plain,
    ]);
    // Time labels at the start, 1/4, 1/2, 3/4 and end.
    const labels = [0, 0.25, 0.5, 0.75, 1].flatMap((part) => {
      const x = Math.round(part * (width - 50));
      return ["-annotate", `+${x}+${height + 4}`, formatTime(part * duration)];
    });
    run("magick", [
      plain,
      "-background", "#202020",
      "-flatten",
      "-extent", `${width}x${height + 24}`,
      "-font", DEFAULT_FONT,
      "-pointsize", "14",
      "-fill", "white",
      "-gravity", "NorthWest",
      ...labels,
      output,
    ]);
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
  requireFile(input);
  const bytes = execFileSync(
    "ffmpeg",
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

// Find where the first beat is, so the beat grid lines up with the actual hits.
function beatOffset(strength: number[], period: number): number {
  let bestOffset = 0;
  let bestScore = -1;
  for (let offset = 0; offset < period; offset++) {
    let score = 0;
    for (let f = offset; f < strength.length; f += period) score += strength[Math.round(f)];
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  return bestOffset;
}

// Tempo (BPM) and the time of every beat. Use the times to cut video on the beat.
export function beats(input: string): { bpm: number; beats: number[]; count: number } {
  const data = samples(input);
  if (data.length < RATE * 3) throw new Error("The sound is too short to find a beat (needs 3+ seconds).");
  const framesPerSecond = RATE / HOP;
  const strength = onsetStrength(data);
  const period = beatPeriod(strength, framesPerSecond);
  const offset = beatOffset(strength, period);
  const times: number[] = [];
  // Each strength value describes the sound at the end of its measurement window.
  for (let f = offset; f < strength.length; f += period) times.push(round((f * HOP + WINDOW) / RATE));
  return { bpm: round((framesPerSecond * 60) / period, 1), beats: times, count: times.length };
}

// ---------- Words ----------

export type Word = { word: string; start: number; end: number };

export type Transcript = {
  language: string;
  text: string;
  words: Word[];
  segments: { start: number; end: number; text: string }[];
};

// Speech to text with the time of every word. Needs the whisper pack: node joedit.ts install whisper
// model: tiny, base, small, medium or large-v3 (bigger = better but slower).
export function transcribe(input: string, output: string, model = "base", language = ""): { language: string; words: number; text: string } {
  requireFile(input);
  const transcript: Transcript = withTempDir((folder) => {
    // Whisper wants 16 kHz mono sound. This also makes video files work.
    const speech = join(folder, "speech.wav");
    ffmpeg(["-i", input, "-vn", "-ac", "1", "-ar", "16000", speech]);
    const options = language ? ["--language", language] : [];
    return runPack("whisper", [speech, "--model", model, ...options]);
  });
  writeFileSync(output, JSON.stringify(transcript, null, 2));
  const preview = transcript.text.length > 200 ? `${transcript.text.slice(0, 200)}...` : transcript.text;
  return { language: transcript.language, words: transcript.words.length, text: preview };
}

export const commands: Record<string, Command> = {
  wave: {
    usage: "wave <sound> <output.png> [--width 1200] [--height 240]",
    run: (a) => {
      const { input, output } = inOut(a);
      wave(input, output, optionalNumberFlag(a, "width", 1200), optionalNumberFlag(a, "height", 240));
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
    usage: "beats <sound>",
    run: (a) => beats(requireFile(a.positional[0])),
  },
  transcribe: {
    usage: "transcribe <sound> <output.json> [--model base] [--language en]  (needs: install whisper)",
    run: (a) => {
      const { input, output } = inOut(a);
      return transcribe(input, output, a.flags.model ?? "base", a.flags.language ?? "");
    },
  },
};

// Only run the CLI when this file is executed directly (not when imported).
if (import.meta.main) {
  runCli("joEdit listen: node listen.ts <command> ...", commands, process.argv.slice(2));
}

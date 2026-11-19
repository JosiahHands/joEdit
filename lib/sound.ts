// Music and sound editing, built on ffmpeg / ffprobe.
// CLI:     node sound.ts <command> <input> <output> [--flags]
// Library: import { fade } from "./joEdit/sound.ts"
import {
  analyze,
  ffmpeg,
  inOut,
  numberFlag,
  optionalNumberFlag,
  probe,
  requireFile,
  runCli,
  type Command,
} from "./shared.ts";

export type SoundInfo = {
  duration: number; // seconds
  sampleRate: number; // e.g. 44100
  channels: number; // 1 = mono, 2 = stereo
  codec: string; // e.g. "mp3"
};

// Duration, sample rate, channels and codec of the first audio stream.
export function info(input: string): SoundInfo {
  const data = probe(input);
  const audio = data.streams.find((s: any) => s.codec_type === "audio");
  if (!audio) throw new Error(`No audio in ${input}.`);
  return {
    duration: Number(data.format.duration ?? audio.duration ?? 0),
    sampleRate: Number(audio.sample_rate),
    channels: audio.channels,
    codec: audio.codec_name,
  };
}

// Keep only the part between start and end (in seconds).
export function trim(input: string, output: string, start: number, end: number): void {
  if (end <= start) throw new Error("--end must be bigger than --start.");
  ffmpeg(["-i", input, "-ss", String(start), "-to", String(end), output]);
}

// Change loudness. 2 = twice as loud, 0.5 = half as loud.
export function volume(input: string, output: string, factor: number): void {
  if (factor < 0) throw new Error("--factor must be 0 or more.");
  ffmpeg(["-i", input, "-filter:a", `volume=${factor}`, output]);
}

// Fade in at the start and/or fade out at the end (in seconds).
export function fade(input: string, output: string, fadeIn = 0, fadeOut = 0): void {
  if (!fadeIn && !fadeOut) throw new Error("Give --in, --out, or both.");
  const filters: string[] = [];
  if (fadeIn) filters.push(`afade=t=in:st=0:d=${fadeIn}`);
  if (fadeOut) {
    const start = Math.max(0, info(input).duration - fadeOut);
    filters.push(`afade=t=out:st=${start}:d=${fadeOut}`);
  }
  ffmpeg(["-i", input, "-filter:a", filters.join(","), output]);
}

// Change tempo without changing pitch. 2 = twice as fast, 0.5 = half speed.
export function speed(input: string, output: string, factor: number): void {
  if (factor < 0.5 || factor > 100) throw new Error("--factor must be between 0.5 and 100.");
  ffmpeg(["-i", input, "-filter:a", `atempo=${factor}`, output]);
}

// Change pitch without changing length. 12 semitones = one octave up, -12 = one octave down.
export function pitch(input: string, output: string, semitones: number): void {
  if (semitones < -12 || semitones > 12) throw new Error("--semitones must be between -12 and 12.");
  const rate = info(input).sampleRate;
  const ratio = Math.pow(2, semitones / 12);
  // Play faster/slower (changes pitch and length), then fix the length back with atempo.
  const filter = `asetrate=${Math.round(rate * ratio)},aresample=${rate},atempo=${1 / ratio}`;
  ffmpeg(["-i", input, "-filter:a", filter, output]);
}

// Play backwards.
export function reverse(input: string, output: string): void {
  ffmpeg(["-i", input, "-filter:a", "areverse", output]);
}

// Make the loudness even and standard for online video: -14 LUFS, peaks below -1.5 dB.
// Two passes: first measure the sound, then apply one exact correction (accurate even for short clips).
export function normalize(input: string, output: string): void {
  const target = "I=-14:TP=-1.5:LRA=11";
  // Pass 1: measure. loudnorm prints its measurements as JSON at the end of the log.
  const log = analyze(input, "audio", `loudnorm=${target}:print_format=json`);
  const measured = JSON.parse(log.slice(log.lastIndexOf("{"), log.lastIndexOf("}") + 1));
  // Pass 2: correct, using the measurements.
  const filter =
    `loudnorm=${target}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}` +
    `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`;
  // loudnorm works at a very high sample rate inside, so set a normal one (48000) for the output.
  ffmpeg(["-i", input, "-filter:a", filter, "-ar", "48000", output]);
}

// Repeat the sound `times` times in a row.
export function loop(input: string, output: string, times: number): void {
  if (times < 1 || !Number.isInteger(times)) throw new Error("--times must be a whole number, 1 or more.");
  ffmpeg(["-stream_loop", String(times - 1), "-i", input, output]);
}

// Play sounds one after another.
export function concat(inputs: string[], output: string): void {
  if (inputs.length < 2) throw new Error("Give at least 2 inputs.");
  inputs.forEach(requireFile);
  // Give every input the same sample rate and channels so they can be joined.
  const parts = inputs.map((_, n) => `[${n}:a]aresample=44100,aformat=channel_layouts=stereo[a${n}]`);
  const labels = inputs.map((_, n) => `[a${n}]`).join("");
  parts.push(`${labels}concat=n=${inputs.length}:v=0:a=1[out]`);
  const args = inputs.flatMap((file) => ["-i", file]);
  ffmpeg([...args, "-filter_complex", parts.join(";"), "-map", "[out]", output]);
}

// Play sounds at the same time (e.g. voice over music). Lasts as long as the longest input.
export function mix(inputs: string[], output: string): void {
  if (inputs.length < 2) throw new Error("Give at least 2 inputs.");
  inputs.forEach(requireFile);
  const labels = inputs.map((_, n) => `[${n}:a]`).join("");
  const filter = `${labels}amix=inputs=${inputs.length}:duration=longest[out]`;
  const args = inputs.flatMap((file) => ["-i", file]);
  ffmpeg([...args, "-filter_complex", filter, "-map", "[out]", output]);
}

// Make a simple beep/tone. frequency in Hz (440 = note A), duration in seconds.
export function tone(output: string, frequency = 440, duration = 1): void {
  if (duration <= 0) throw new Error("--duration must be more than 0.");
  ffmpeg(["-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${duration}`, output]);
}

// Change format based on the output file extension (e.g. .wav -> .mp3).
export function convert(input: string, output: string): void {
  ffmpeg(["-i", input, output]);
}

// For commands that take many inputs: all positional values except the last are inputs.
function manyInputs(positional: string[]): { inputs: string[]; output: string } {
  if (positional.length < 3) throw new Error("Give at least 2 inputs and 1 output.");
  return { inputs: positional.slice(0, -1), output: positional[positional.length - 1] };
}

export const commands: Record<string, Command> = {
  info: {
    usage: "info <input>",
    run: (a) => info(requireFile(a.positional[0])),
  },
  trim: {
    usage: "trim <input> <output> --start SECONDS --end SECONDS",
    run: (a) => {
      const { input, output } = inOut(a);
      trim(input, output, numberFlag(a, "start"), numberFlag(a, "end"));
    },
  },
  volume: {
    usage: "volume <input> <output> --factor N (2 = louder, 0.5 = quieter)",
    run: (a) => {
      const { input, output } = inOut(a);
      volume(input, output, numberFlag(a, "factor"));
    },
  },
  fade: {
    usage: "fade <input> <output> [--in SECONDS] [--out SECONDS]",
    run: (a) => {
      const { input, output } = inOut(a);
      fade(input, output, optionalNumberFlag(a, "in", 0), optionalNumberFlag(a, "out", 0));
    },
  },
  speed: {
    usage: "speed <input> <output> --factor 0.5..100 (pitch stays the same)",
    run: (a) => {
      const { input, output } = inOut(a);
      speed(input, output, numberFlag(a, "factor"));
    },
  },
  pitch: {
    usage: "pitch <input> <output> --semitones -12..12 (length stays the same)",
    run: (a) => {
      const { input, output } = inOut(a);
      pitch(input, output, numberFlag(a, "semitones"));
    },
  },
  reverse: {
    usage: "reverse <input> <output>",
    run: (a) => {
      const { input, output } = inOut(a);
      reverse(input, output);
    },
  },
  normalize: {
    usage: "normalize <input> <output>",
    run: (a) => {
      const { input, output } = inOut(a);
      normalize(input, output);
    },
  },
  loop: {
    usage: "loop <input> <output> --times N",
    run: (a) => {
      const { input, output } = inOut(a);
      loop(input, output, numberFlag(a, "times"));
    },
  },
  concat: {
    usage: "concat <input1> <input2> [more inputs...] <output>",
    run: (a) => {
      const { inputs, output } = manyInputs(a.positional);
      concat(inputs, output);
    },
  },
  mix: {
    usage: "mix <input1> <input2> [more inputs...] <output>",
    run: (a) => {
      const { inputs, output } = manyInputs(a.positional);
      mix(inputs, output);
    },
  },
  tone: {
    usage: "tone <output> [--frequency HZ] [--duration SECONDS]",
    run: (a) => {
      const output = a.positional[0];
      if (!output) throw new Error("Missing output path.");
      tone(output, optionalNumberFlag(a, "frequency", 440), optionalNumberFlag(a, "duration", 1));
    },
  },
  convert: {
    usage: "convert <input> <output>",
    run: (a) => {
      const { input, output } = inOut(a);
      convert(input, output);
    },
  },   
};

// Only run the CLI when this file is executed directly (not when imported).
if (import.meta.main) {    
  runCli("Sound editor: node sound.ts <command> ...", commands, process.argv.slice(2));
}

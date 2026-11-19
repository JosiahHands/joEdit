// Music and sound editing, built on ffmpeg / ffprobe.
// CLI:     node sound.ts <command> <input> <output> [--flags]
// Library: import { fade } from "./joEdit/sound.ts"
import { join } from "node:path";
import {
  analyze,
  ffmpeg,
  inOut,
  numberFlag,
  optionalNumberFlag,
  probe,
  requireFile,
  round,
  runCli,
  stringFlag,
  withTempDir,
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

// ---------- Sound effects (made from scratch, no downloads) ----------

// Each effect is an ffmpeg graph of sound generators and filters that ends in [out]. D is the duration.
const SFX: Record<string, { duration: number; graph: (D: number) => string }> = {
  whoosh: {
    duration: 1,
    graph: (D) => `anoisesrc=d=${D}:c=pink:a=0.7,bandpass=f=900:width_type=q:w=0.8,volume='sin(PI*t/${D})^2':eval=frame,aecho=0.6:0.5:40:0.3[out]`,
  },
  swoosh: {
    duration: 0.45,
    graph: (D) => `anoisesrc=d=${D}:c=white:a=0.6,highpass=f=2000,bandpass=f=4000:width_type=q:w=1,volume='sin(PI*t/${D})^3':eval=frame[out]`,
  },
  hit: {
    duration: 0.6,
    graph: (D) =>
      `aevalsrc='0.9*sin(2*PI*(55+140*exp(-t*25))*t)*exp(-t*7)':d=${D}[a];` +
      `anoisesrc=d=0.15:c=brown:a=0.8,lowpass=f=3000,afade=t=out:d=0.15[b];` +
      `[a][b]amix=inputs=2:normalize=0:duration=longest[out]`,
  },
  boom: {
    duration: 2,
    graph: (D) =>
      `aevalsrc='0.9*sin(2*PI*(35+50*exp(-t*6))*t)*exp(-t*2)':d=${D}[a];` +
      `anoisesrc=d=${D}:c=brown:a=0.5,lowpass=f=400,volume='exp(-t*3)':eval=frame[b];` +
      `[a][b]amix=inputs=2:normalize=0,aecho=0.8:0.7:60|120:0.4|0.25[out]`,
  },
  riser: {
    duration: 3,
    graph: (D) =>
      `aevalsrc='0.5*sin(2*PI*(150*t+${round(400 / D, 3)}*t*t))*(t/${D})':d=${D}[a];` +
      `anoisesrc=d=${D}:c=white:a=0.3,highpass=f=1500,volume='(t/${D})^2':eval=frame[b];` +
      `[a][b]amix=inputs=2:normalize=0[out]`,
  },
  pop: {
    duration: 0.15,
    graph: (D) => `aevalsrc='0.8*sin(2*PI*(350+900*exp(-t*45))*t)*exp(-t*30)':d=${D}[out]`,
  },
  click: {
    duration: 0.05,
    graph: (D) => `aevalsrc='(random(0)*2-1)*exp(-t*250)':d=${D},highpass=f=1500[out]`,
  },
  typewriter: {
    duration: 1.5,
    // A key strike every 0.11 s: a noise tick plus a low thump.
    graph: (D) =>
      `aevalsrc='(random(0)*2-1)*exp(-mod(t,0.11)*220)*0.7+0.4*sin(2*PI*180*t)*exp(-mod(t,0.11)*60)':d=${D},highpass=f=300[out]`,
  },
  ding: {
    duration: 1.5,
    // A bell: a note and two overtones that fade at different speeds.
    graph: (D) =>
      `aevalsrc='0.5*sin(2*PI*1318*t)*exp(-t*2.5)+0.25*sin(2*PI*2637*t)*exp(-t*4)+0.15*sin(2*PI*3955*t)*exp(-t*7)':d=${D}[out]`,
  },
  glitch: {
    duration: 0.6,
    // Square-wave bursts that jump between pitches, then crushed to a low bit depth.
    graph: (D) =>
      `aevalsrc='0.3*sgn(sin(2*PI*(110+440*floor(mod(t*23,4)))*t))*lt(mod(t,0.075),0.04)*(1-0.7*t/${D})':d=${D},acrusher=bits=6:mix=0.6,lowpass=f=6000[out]`,
  },
};

export const SFX_TYPES = Object.keys(SFX);

// Make a sound effect. Each type has a good default duration.
export function sfx(output: string, type: string, duration?: number): { type: string; duration: number } {
  const effect = SFX[type];
  if (!effect) throw new Error(`Unknown sound effect "${type}". Types: ${SFX_TYPES.join(", ")}`);
  const length = duration ?? effect.duration;
  if (length <= 0) throw new Error("--duration must be more than 0.");
  withTempDir((folder) => {
    const raw = join(folder, "raw.wav");
    ffmpeg(["-filter_complex", effect.graph(length), "-map", "[out]", "-ar", "44100", "-ac", "2", "-t", String(length), raw]);
    // Make every effect equally loud: its loudest moment lands at -3 dB.
    const log = analyze(raw, "audio", "volumedetect");
    const peak = Number(log.match(/max_volume: (-?[\d.]+) dB/)?.[1] ?? 0);
    ffmpeg(["-i", raw, "-filter:a", `volume=${round(-3 - peak, 2)}dB`, output]);
  });
  return { type, duration: length };
}

// ---------- Mixing helpers ----------

// Mix music under a voice and turn the music down whenever the voice speaks ("ducking").
// amount: how strongly the music is turned down (2 = a little, 20 = a lot).
export function duck(music: string, voice: string, output: string, amount = 8): void {
  requireFile(music);
  requireFile(voice);
  const format = "aformat=sample_rates=44100:channel_layouts=stereo";
  const graph =
    `[0:a]${format}[m];[1:a]${format},asplit=2[v1][v2];` +
    `[m][v1]sidechaincompress=threshold=0.03:ratio=${amount}:attack=20:release=400[d];` +
    `[d][v2]amix=inputs=2:duration=longest:normalize=0[out]`;
  ffmpeg(["-i", music, "-i", voice, "-filter_complex", graph, "-map", "[out]", output]);
}

// Reduce steady background noise (hiss, hum, fan). amount: 1 (gentle) to 40 (strong), in dB.
// A video input keeps its picture.
export function denoise(input: string, output: string, amount = 20): { noiseFloor: number } {
  // The quietest 50 ms of the file (the gaps between words) tells how loud the noise is.
  const log = analyze(input, "audio", "aformat=channel_layouts=mono,astats=length=0.05");
  const quietest = Number(log.match(/RMS (?:through|trough) dB: (-?[\d.]+)/)?.[1] ?? -50);
  const noiseFloor = round(Math.min(-20, Math.max(-80, quietest)), 1);
  ffmpeg(["-i", input, "-af", `afftdn=nr=${amount}:nf=${noiseFloor}:tn=1`, "-c:v", "copy", output]);
  return { noiseFloor };
}

// Turn bass and treble up or down, in dB (e.g. bass 4, treble -2). A video input keeps its picture.
export function eq(input: string, output: string, bass = 0, treble = 0): void {
  if (!bass && !treble) throw new Error("Give --bass, --treble, or both (in dB, e.g. 4 or -3).");
  ffmpeg(["-i", input, "-af", `bass=g=${bass},treble=g=${treble}`, "-c:v", "copy", output]);
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
  sfx: {
    usage: `sfx <output.wav> --type ${SFX_TYPES.join("|")} [--duration SECONDS]`,
    run: (a) => {
      if (!a.positional[0]) throw new Error("Missing output path.");
      const duration = a.flags.duration === undefined ? undefined : numberFlag(a, "duration");
      return sfx(a.positional[0], stringFlag(a, "type"), duration);
    },
  },
  duck: {
    usage: "duck <music> <voice> <output> [--amount 8]  (music turns down while the voice speaks)",
    run: (a) => {
      if (a.positional.length < 3) throw new Error("Give music, voice and output.");
      const [music, voice, output] = a.positional;
      duck(music, voice, output, optionalNumberFlag(a, "amount", 8));
    },
  },
  denoise: {
    usage: "denoise <input> <output> [--amount 1..40]",
    run: (a) => {
      const { input, output } = inOut(a);
      return denoise(input, output, optionalNumberFlag(a, "amount", 20));
    },
  },
  eq: {
    usage: "eq <input> <output> [--bass DB] [--treble DB]",
    run: (a) => {
      const { input, output } = inOut(a);
      eq(input, output, optionalNumberFlag(a, "bass", 0), optionalNumberFlag(a, "treble", 0));
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

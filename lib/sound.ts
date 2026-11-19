// Music and sound editing, built on ffmpeg (edits, loudness) and Web Audio (mixing, effects, sound design).
// CLI:     node joedit.ts sound <command> <input> <output> [--flags]
// Library: import { fade } from "./joEdit/sound.ts"
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FFMPEG,
  analyze,
  ffmpeg,
  inOut,
  need,
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

// ---------- Sound as numbers ----------
// Web Audio works on channels of numbers between -1 and 1. joEdit always uses stereo at 48000 per second.

export const RATE = 48000;

// Decode any sound (or a video's sound) into [left, right], from `from` to `to` seconds.
export function decode(input: string, from = 0, to?: number): Float32Array[] {
  requireFile(input);
  const bytes = execFileSync(FFMPEG, [
    "-hide_banner", "-loglevel", "error", ...(from ? ["-ss", String(from)] : []), "-i", input,
    ...(to !== undefined ? ["-t", String(Math.max(0.01, to - from))] : []),
    "-vn", "-ac", "2", "-ar", String(RATE), "-f", "f32le", "-",
  ], { maxBuffer: 4 * 1024 * 1024 * 1024 });
  const both = new Float32Array(new Uint8Array(bytes).buffer); // left, right, left, right ...
  const left = new Float32Array(both.length / 2);
  const right = new Float32Array(both.length / 2);
  for (let i = 0; i < left.length; i++) {
    left[i] = both[2 * i];
    right[i] = both[2 * i + 1];
  }
  return [left, right];
}

// Write channels as a 32-bit float WAV file (no clipping before the final loudness step).
export function writeWav(output: string, channels: Float32Array[], rate = RATE): void {
  const frames = channels[0].length;
  const count = channels.length;
  const data = Buffer.alloc(44 + frames * count * 4);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + frames * count * 4, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(3, 20); // 3 = float numbers
  data.writeUInt16LE(count, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * count * 4, 28);
  data.writeUInt16LE(count * 4, 32);
  data.writeUInt16LE(32, 34);
  data.write("data", 36);
  data.writeUInt32LE(frames * count * 4, 40);
  for (let i = 0; i < frames; i++) for (let c = 0; c < count; c++) data.writeFloatLE(channels[c][i], 44 + (i * count + c) * 4);
  writeFileSync(output, data);
}

// Save channels in the output's format (.wav, .mp3, .m4a ...).
export function saveSound(channels: Float32Array[], output: string): void {
  withTempDir((folder) => {
    const raw = join(folder, "sound.wav");
    writeWav(raw, channels);
    ffmpeg(["-i", raw, ...(output.toLowerCase().endsWith(".wav") ? ["-c:a", "pcm_s16le"] : []), output]);
  });
}

// Build a Web Audio graph with `build(ctx)` and render `seconds` of it, faster than real time.
export async function renderAudio(seconds: number, build: (ctx: any) => void | Promise<void>): Promise<Float32Array[]> {
  const { OfflineAudioContext } = need("node-web-audio-api");
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.max(1, Math.ceil(seconds * RATE)), sampleRate: RATE });
  await build(ctx);
  const rendered = await ctx.startRendering();
  return [0, 1].map((c) => {
    const channel = new Float32Array(rendered.length);
    rendered.copyFromChannel(channel, c);
    return channel;
  });
}

// Channels as a Web Audio buffer.
export function audioBuffer(ctx: any, channels: Float32Array[]): any {
  const buffer = ctx.createBuffer(2, Math.max(1, channels[0].length), RATE);
  buffer.copyToChannel(channels[0], 0);
  buffer.copyToChannel(channels[1] ?? channels[0], 1);
  return buffer;
}

// Scale so the loudest sample is at `peak` (0.89 = -1 dB).
function setPeak(channels: Float32Array[], peak = 0.89): Float32Array[] {
  let loudest = 0;
  for (const channel of channels) for (const v of channel) loudest = Math.max(loudest, Math.abs(v));
  if (loudest > 0) for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] *= peak / loudest;
  return channels;
}

// Noise for sound design: white (hiss), pink (rain, wind) or brown (rumble).
export function noise(ctx: any, seconds: number, color = "white"): any {
  const length = Math.max(1, Math.round(seconds * RATE));
  const channels = [new Float32Array(length), new Float32Array(length)];
  for (const channel of channels) {
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      if (color === "pink") {
        // Paul Kellet's quick pink noise filter.
        b0 = 0.99765 * b0 + white * 0.099046;
        b1 = 0.963 * b1 + white * 0.2965164;
        b2 = 0.57 * b2 + white * 1.0526913;
        channel[i] = (b0 + b1 + b2 + white * 0.1848) * 0.2;
      } else if (color === "brown") {
        last = (last + 0.02 * white) / 1.02;
        channel[i] = last * 3.5;
      } else channel[i] = white * 0.5;
    }
  }
  return audioBuffer(ctx, channels);
}

// ---------- Rooms (reverb) ----------

// seconds: how long the echo lasts. dark: how fast high sounds die away (0 = bright, 1 = dark).
export const ROOMS: Record<string, { seconds: number; predelay: number; dark: number }> = {
  room: { seconds: 0.7, predelay: 0.008, dark: 0.5 },
  studio: { seconds: 0.35, predelay: 0.004, dark: 0.4 },
  hall: { seconds: 2.4, predelay: 0.025, dark: 0.6 },
  plate: { seconds: 1.6, predelay: 0, dark: 0.15 },
  cathedral: { seconds: 5.5, predelay: 0.05, dark: 0.75 },
};

// The echo of a room, made from decaying noise (left and right differ, which gives width).
function roomEcho(ctx: any, name: string): any {
  const room = ROOMS[name];
  if (!room) throw new Error(`Unknown reverb "${name}". Rooms: ${Object.keys(ROOMS).join(", ")}`);
  const length = Math.round((room.seconds + room.predelay) * RATE);
  const start = Math.round(room.predelay * RATE);
  const channels = [new Float32Array(length), new Float32Array(length)];
  for (const channel of channels) {
    let smooth = 0;
    for (let i = start; i < length; i++) {
      const t = (i - start) / RATE;
      // Softer as time goes on (-60 dB at the end), and duller: more smoothing later.
      const keep = room.dark * Math.min(0.95, t / room.seconds + 0.2);
      smooth = keep * smooth + (1 - keep) * (Math.random() * 2 - 1);
      channel[i] = smooth * Math.exp((-6.9 * t) / room.seconds);
    }
  }
  return audioBuffer(ctx, channels);
}

// ---------- Voice styles ----------

type Filter = [type: string, frequency: number, gain?: number, q?: number];

export const VOICES: Record<string, { filters: Filter[]; drive?: number; compress: [threshold: number, ratio: number]; mono?: boolean }> = {
  podcast: { filters: [["highpass", 80], ["peaking", 300, -3, 1], ["peaking", 4500, 3, 0.9], ["highshelf", 10000, 1.5]], compress: [-24, 3.5] },
  warm: { filters: [["highpass", 70], ["lowshelf", 220, 3], ["peaking", 3500, 1.5, 0.8], ["highshelf", 9000, -2.5]], compress: [-20, 2.5] },
  radio: { filters: [["highpass", 250], ["lowpass", 4500], ["peaking", 1800, 6, 1]], drive: 3, compress: [-28, 6] },
  telephone: { filters: [["highpass", 400], ["lowpass", 3200], ["peaking", 1500, 4, 1.2]], drive: 2, compress: [-30, 8], mono: true },
  megaphone: { filters: [["highpass", 600], ["lowpass", 3000], ["peaking", 1300, 9, 2]], drive: 12, compress: [-30, 10], mono: true },
};

// How loud on average (root mean square).
function rms(channels: Float32Array[]): number {
  let sum = 0;
  let count = 0;
  for (const channel of channels) for (const v of channel) {
    sum += v * v;
    count++;
  }
  return Math.sqrt(sum / Math.max(1, count));
}

// Room, voice style, position and width for a sound (a video keeps its picture).
// mix: how much room you hear (0..1). pan: -1 (left) .. 1 (right). width: 0 (mono) .. 2 (extra wide).
export async function fx(input: string, output: string, options: { reverb?: string; mix?: number; voice?: string; pan?: number; width?: number } = {}) {
  const { reverb, voice, pan = 0, width = 1, mix = 0.25 } = options;
  if (!reverb && !voice && !pan && width === 1) throw new Error("Give at least one of --reverb, --voice, --pan or --width.");
  const style = voice ? VOICES[voice] : undefined;
  if (voice && !style) throw new Error(`Unknown voice style "${voice}". Styles: ${Object.keys(VOICES).join(", ")}`);
  const hasPicture = probe(input).streams.some((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const dry = decode(input);
  // A sound file gets room for the echo to ring out; a video keeps its length.
  const tail = reverb && !hasPicture ? ROOMS[reverb]?.seconds ?? 0 : 0;
  const result = await renderAudio(dry[0].length / RATE + tail, (ctx) => {
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer(ctx, dry);
    let last: any = source;
    if (style) {
      if (style.mono) {
        const mono = ctx.createGain();
        mono.channelCount = 1;
        mono.channelCountMode = "explicit";
        last = last.connect(mono);
      }
      for (const [type, frequency, gain = 0, q = 0.7] of style.filters) {
        last = last.connect(new (need("node-web-audio-api").BiquadFilterNode)(ctx, { type, frequency, gain, Q: q }));
      }
      if (style.drive) {
        // Soft clipping: the harder the drive, the more crunch.
        const curve = new Float32Array(1024);
        for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(style.drive * (i / 511.5 - 1)) / Math.tanh(style.drive);
        const shaper = ctx.createWaveShaper();
        shaper.curve = curve;
        last = last.connect(shaper);
      }
      const squash = ctx.createDynamicsCompressor();
      squash.threshold.value = style.compress[0];
      squash.ratio.value = style.compress[1];
      squash.attack.value = 0.005;
      squash.release.value = 0.15;
      last = last.connect(squash);
    }
    if (pan) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      last = last.connect(panner);
    }
    last.connect(ctx.destination);
    if (reverb) {
      const room = ctx.createConvolver();
      room.buffer = roomEcho(ctx, reverb);
      const wet = ctx.createGain();
      wet.gain.value = mix;
      last.connect(room).connect(wet).connect(ctx.destination);
    }
    source.start(0);
  });
  // Width: turn the difference between left and right up or down.
  if (width !== 1) {
    for (let i = 0; i < result[0].length; i++) {
      const middle = (result[0][i] + result[1][i]) / 2;
      const side = ((result[0][i] - result[1][i]) / 2) * width;
      result[0][i] = middle + side;
      result[1][i] = middle - side;
    }
  }
  // Keep the same average loudness as before, without clipping.
  const gain = rms(dry) / Math.max(1e-9, rms(result));
  for (const channel of result) for (let i = 0; i < channel.length; i++) channel[i] = Math.max(-0.99, Math.min(0.99, channel[i] * gain));
  if (!hasPicture) {
    saveSound(result, output);
  } else {
    withTempDir((folder) => {
      const sound = join(folder, "sound.wav");
      writeWav(sound, result);
      ffmpeg(["-i", input, "-i", sound, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", output]);
    });
  }
  return { reverb, voice, pan, width };
}

// Sound design: run an agent-written script that builds a Web Audio graph, and render it.
// The script: export default ({ ctx, duration, noise }) => { const o = ctx.createOscillator(); ... o.connect(ctx.destination); o.start(0); }
// ctx is a Web Audio OfflineAudioContext; noise(seconds, "white"|"pink"|"brown") gives a noise buffer.
export async function design(script: string, output: string, duration = 2) {
  requireFile(script);
  if (duration <= 0 || duration > 600) throw new Error("--duration must be between 0 and 600 seconds.");
  // Load the script fresh every time (so an edited script is never stale).
  const module = await import(`${pathToFileURL(resolve(script)).href}?t=${Date.now()}`);
  if (typeof module.default !== "function") {
    throw new Error("The script must export a function: export default ({ ctx, duration, noise }) => { ... connect to ctx.destination ... }");
  }
  const channels = await renderAudio(duration, (ctx) => module.default({ ctx, duration, noise: (seconds: number, color?: string) => noise(ctx, seconds, color) }));
  if (rms(channels) === 0) throw new Error("The script made silence. Connect your sounds to ctx.destination and start() them.");
  saveSound(setPeak(channels), output);
  return { duration };
}

// ---------- The mixer ----------

// One sound placed on a timeline.
export type Clip = {
  file: string;
  at?: number; // when it starts (seconds)
  from?: number; // start time in the file
  to?: number; // end time in the file
  volume?: number; // 1 = as it is
  fadeIn?: number;
  fadeOut?: number;
  loop?: boolean; // repeat until the mix ends
  pan?: number; // -1 (left) .. 1 (right)
  reverb?: string; // a room from ROOMS
  role?: "voice" | "music" | "effect"; // music turns down while a voice speaks; effects never change it
};

// When people speak, from the voices' loudness every 50 ms: [start, end] in seconds.
// Pauses shorter than 1.2 s count as speech, so the music does not pump up and down between sentences.
function speechTimes(voices: { data: Float32Array[]; at: number; volume: number }[], length: number): [number, number][] {
  const STEP = 0.05;
  const energy = new Float64Array(Math.ceil(length / STEP) + 1);
  const counts = new Float64Array(energy.length);
  for (const voice of voices) {
    const [left, right] = voice.data;
    for (let i = 0; i < left.length; i += 4) {
      const bin = Math.floor((voice.at + i / RATE) / STEP);
      if (bin >= energy.length) break;
      const v = ((left[i] + right[i]) / 2) * voice.volume;
      energy[bin] += v * v;
      counts[bin]++;
    }
  }
  const times: [number, number][] = [];
  for (let bin = 0; bin < energy.length; bin++) {
    // About -34 dB: quiet room tone stays under it, speech goes over it.
    if (!counts[bin] || Math.sqrt(energy[bin] / counts[bin]) < 0.02) continue;
    const start = bin * STEP;
    const last = times.at(-1);
    if (last && start - last[1] < 1.2) last[1] = start + STEP;
    else times.push([start, start + STEP]);
  }
  return times.filter(([start, end]) => end - start >= 0.1);
}

// Mix sounds on a timeline with Web Audio. Music clips dip smoothly a moment before people speak
// and come back after (look-ahead ducking), by `duck` dB. length: the mix's length (default: until the last sound ends).
export async function mixClips(clips: Clip[], output: string, options: { length?: number; duck?: number } = {}) {
  if (clips.length === 0) throw new Error("Nothing to mix.");
  const decoded = clips.map((clip) => decode(clip.file, clip.from ?? 0, clip.to));
  const length = options.length ?? Math.max(...clips.map((clip, n) => (clip.at ?? 0) + decoded[n][0].length / RATE));
  const voices = clips.flatMap((clip, n) => ((clip.role ?? "voice") === "voice" ? [{ data: decoded[n], at: clip.at ?? 0, volume: clip.volume ?? 1 }] : []));
  const speech = speechTimes(voices, length);
  const low = Math.pow(10, -(options.duck ?? 12) / 20);

  const channels = await renderAudio(length, (ctx) => {
    // The music bus: everything with role "music" goes through one volume that the speech times move.
    const music = ctx.createGain();
    music.gain.setValueAtTime(1, 0);
    for (const [start, end] of speech) {
      music.gain.setValueAtTime(1, Math.max(0, start - 0.35));
      music.gain.linearRampToValueAtTime(low, Math.max(0, start - 0.05));
      music.gain.setValueAtTime(low, end + 0.15);
      music.gain.linearRampToValueAtTime(1, end + 0.75);
    }
    music.connect(ctx.destination);

    clips.forEach((clip, n) => {
      const at = clip.at ?? 0;
      const plays = clip.loop ? length - at : Math.min(decoded[n][0].length / RATE, length - at);
      if (plays <= 0) return;
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer(ctx, decoded[n]);
      source.loop = clip.loop ?? false;
      // Volume with fades in and out.
      const volume = clip.volume ?? 1;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(clip.fadeIn ? 0 : volume, at);
      if (clip.fadeIn) gain.gain.linearRampToValueAtTime(volume, at + clip.fadeIn);
      if (clip.fadeOut) {
        gain.gain.setValueAtTime(volume, Math.max(at, at + plays - clip.fadeOut));
        gain.gain.linearRampToValueAtTime(0, at + plays);
      }
      let last = source.connect(gain);
      if (clip.pan) {
        const panner = ctx.createStereoPanner();
        panner.pan.value = clip.pan;
        last = last.connect(panner);
      }
      const target = clip.role === "music" ? music : ctx.destination;
      last.connect(target);
      if (clip.reverb) {
        const room = ctx.createConvolver();
        room.buffer = roomEcho(ctx, clip.reverb);
        const wet = ctx.createGain();
        wet.gain.value = 0.3;
        last.connect(room).connect(wet).connect(target);
      }
      source.start(at);
      source.stop(at + plays);
    });
  });
  // Many loud sounds together can go over the top: bring the whole mix down just enough.
  let loudest = 0;
  for (const channel of channels) for (const v of channel) loudest = Math.max(loudest, Math.abs(v));
  if (loudest > 0.97) setPeak(channels, 0.97);
  saveSound(channels, output);
  return { length: round(length), speech: speech.map(([s, e]) => [round(s), round(e)]) };
}

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
export async function mix(inputs: string[], output: string) {
  if (inputs.length < 2) throw new Error("Give at least 2 inputs.");
  return mixClips(inputs.map((file) => ({ file, role: "effect" as const })), output);
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
// The music starts dipping just before each sentence and stays down through short pauses.
// amount: how many dB the music goes down (6 = a little, 20 = a lot).
export async function duck(music: string, voice: string, output: string, amount = 12) {
  return mixClips([{ file: music, role: "music" }, { file: voice, role: "voice" }], output, { duck: amount });
}

// Mix a timeline from a JSON file: [{ "file": "music.mp3", "role": "music", "loop": true }, { "file": "voice.wav", "at": 1.5 }, ...]
// Paths are relative to the JSON file.
export async function timeline(json: string, output: string, options: { length?: number; duck?: number } = {}) {
  const clips: Clip[] = JSON.parse(readFileSync(requireFile(json), "utf8"));
  if (!Array.isArray(clips)) throw new Error("The timeline must be a JSON list of clips: [{ \"file\": \"a.wav\", \"at\": 0 }, ...]");
  const folder = dirname(resolve(json));
  return mixClips(clips.map((clip) => ({ ...clip, file: resolve(folder, clip.file) })), output, options);
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
    run: async (a) => {
      const { inputs, output } = manyInputs(a.positional);
      await mix(inputs, output);
    },
  },
  timeline: {
    usage:
      'timeline <clips.json> <output> [--duck DB] [--length SECONDS]  (clips: [{"file","at","from","to","volume","fadeIn","fadeOut","loop","pan","reverb","role":"voice|music|effect"}])',
    run: async (a) => {
      const { input, output } = inOut(a);
      return timeline(input, output, { duck: optionalNumberFlag(a, "duck", 12), length: a.flags.length === undefined ? undefined : numberFlag(a, "length") });
    },
  },
  fx: {
    usage: `fx <input> <output> [--reverb ${Object.keys(ROOMS).join("|")}] [--mix 0..1] [--voice ${Object.keys(VOICES).join("|")}] [--pan -1..1] [--width 0..2]`,
    run: async (a) => {
      const { input, output } = inOut(a);
      const reverb = a.flags.reverb === undefined ? undefined : stringFlag(a, "reverb");
      const voice = a.flags.voice === undefined ? undefined : stringFlag(a, "voice");
      return fx(input, output, {
        reverb,
        voice,
        mix: optionalNumberFlag(a, "mix", 0.25),
        pan: optionalNumberFlag(a, "pan", 0),
        width: optionalNumberFlag(a, "width", 1),
      });
    },
  },
  design: {
    usage: "design <script.js> <output> [--duration SECONDS]  (script: export default ({ ctx, duration, noise }) => { ...Web Audio nodes → ctx.destination })",
    run: async (a) => {
      const { input, output } = inOut(a);
      return design(input, output, optionalNumberFlag(a, "duration", 2));
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
    usage: "duck <music> <voice> <output> [--amount DB]  (music dips 12 dB while the voice speaks)",
    run: async (a) => {
      if (a.positional.length < 3) throw new Error("Give music, voice and output.");
      const [music, voice, output] = a.positional;
      return duck(music, voice, output, optionalNumberFlag(a, "amount", 12));
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

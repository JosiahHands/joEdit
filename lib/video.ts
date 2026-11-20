// Video editing, built on ffmpeg / ffprobe.
// CLI:     node video.ts <command> <input> <output> [--flags]
// Library: import { trim } from "./joEdit/video.ts"
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  concatLine,
  drawText,
  even,
  ffmpeg,
  inOut,
  need,
  saveCanvas,
  skia,
  TEXT_FLAGS,
  textStyle,
  type TextStyle,
  numberFlag,
  optionalNumberFlag,
  probe,
  readFrames,
  readJson,
  requireFile,
  round,
  runCli,
  runPack,
  stringFlag,
  withTempDir,
  writeVideo,
  loadBrand,
  type Args,
  type Command,
} from "./shared.ts";
import * as graphics from "./graphics.ts";
import * as listen from "./listen.ts";

export type VideoInfo = {
  duration: number; // seconds
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
};

// Duration, size, frame rate and whether there is sound.
export function info(input: string): VideoInfo {
  const data = probe(input);
  const video = data.streams.find((s: any) => s.codec_type === "video");
  const audio = data.streams.find((s: any) => s.codec_type === "audio");
  // Frame rate comes as a fraction like "30000/1001".
  const [num, den] = (video?.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    duration: Number(data.format.duration ?? 0),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: den ? Math.round((num / den) * 100) / 100 : 0,
    hasAudio: Boolean(audio),
  };
}

// Keep only the part between start and end (in seconds).
export function trim(input: string, output: string, start: number, end: number): void {
  if (end <= start) throw new Error("--end must be bigger than --start.");
  // Starting past the end would make an empty file, so say so instead.
  const length = info(input).duration;
  if (start >= length) throw new Error(`--start ${start} is after the end of the input (${round(length)}s).`);
  ffmpeg(["-i", input, "-ss", String(start), "-to", String(end), output]);
}

// Resize. Give width, height, or both. With one, the aspect ratio is kept.
export function resize(input: string, output: string, width?: number, height?: number): void {
  if (!width && !height) throw new Error("Give --width, --height, or both.");
  // -2 means "keep aspect ratio, rounded to an even number" (needed by most codecs).
  ffmpeg(["-i", input, "-vf", `scale=${width || -2}:${height || -2}`, "-c:a", "copy", output]);
}

// Cut out a rectangle starting at (x, y).
export function crop(input: string, output: string, x: number, y: number, width: number, height: number): void {
  ffmpeg(["-i", input, "-vf", `crop=${width}:${height}:${x}:${y}`, "-c:a", "copy", output]);
}

// Rotate clockwise by 90, 180 or 270 degrees.
export function rotate(input: string, output: string, degrees: number): void {
  const filters: Record<number, string> = {
    90: "transpose=clock",
    180: "hflip,vflip",
    270: "transpose=cclock",
  };
  const filter = filters[degrees];
  if (!filter) throw new Error("--degrees must be 90, 180 or 270.");
  ffmpeg(["-i", input, "-vf", filter, "-c:a", "copy", output]);
}

// Mirror the video. direction: "horizontal" (left-right) or "vertical" (top-bottom).
export function flip(input: string, output: string, direction: string): void {
  const filters: Record<string, string> = { horizontal: "hflip", vertical: "vflip" };
  const filter = filters[direction];
  if (!filter) throw new Error('--direction must be "horizontal" or "vertical".');
  ffmpeg(["-i", input, "-vf", filter, "-c:a", "copy", output]);
}

// Change playback speed. 2 = twice as fast, 0.5 = half speed.
export function speed(input: string, output: string, factor: number): void {
  if (factor < 0.5 || factor > 100) throw new Error("--factor must be between 0.5 and 100.");
  const args = ["-i", input, "-filter:v", `setpts=PTS/${factor}`];
  if (info(input).hasAudio) args.push("-filter:a", `atempo=${factor}`);
  ffmpeg([...args, output]);
}

// Remove the sound.
export function mute(input: string, output: string): void {
  ffmpeg(["-i", input, "-an", "-c:v", "copy", output]);
}

// Save only the sound (format from the output extension, e.g. .mp3 or .wav).
export function extractAudio(input: string, output: string): void {
  if (!info(input).hasAudio) throw new Error("Input has no audio.");
  ffmpeg(["-i", input, "-vn", output]);
}

// Replace the video's sound with an audio file. Output stops at the shorter of the two.
export function addAudio(input: string, audio: string, output: string): void {
  requireFile(audio);
  ffmpeg(["-i", input, "-i", audio, "-map", "0:v", "-map", "1:a:0", "-c:v", "copy", "-shortest", output]);
}

// Join videos one after another. All are scaled to the size of the first one.
// Sound is kept only if every input has sound.
export function concat(inputs: string[], output: string): void {
  if (inputs.length < 2) throw new Error("Give at least 2 inputs.");
  const infos = inputs.map(requirePicture);
  // Everything takes the first clip's size and frame rate. A clip of another shape fits inside with black
  // bars (never stretched). If any clip has sound, clips without sound get silence, so no sound is lost.
  const width = even(infos[0].width);
  const height = even(infos[0].height);
  const fps = infos[0].fps || 30;
  const withAudio = infos.some((i) => i.hasAudio);

  const args = inputs.flatMap((file) => ["-i", file]);
  const parts: string[] = [];
  let joined = "";
  infos.forEach((clip, n) => {
    parts.push(`[${n}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${n}]`);
    joined += `[v${n}]`;
    if (withAudio) {
      let source = `${n}:a`;
      if (!clip.hasAudio) {
        source = `${args.length / 2}:a`;
        args.push("-f", "lavfi", "-t", String(clip.duration), "-i", "anullsrc=r=48000:cl=stereo");
      }
      // Same sound format, and exactly as long as the clip's picture, so picture and sound stay together.
      parts.push(`[${source}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end=${clip.duration},asetpts=PTS-STARTPTS[a${n}]`);
      joined += `[a${n}]`;
    }
  });
  parts.push(`${joined}concat=n=${inputs.length}:v=1:a=${withAudio ? 1 : 0}${withAudio ? "[v][a]" : "[v]"}`);
  args.push("-filter_complex", parts.join(";"), "-map", "[v]");
  if (withAudio) args.push("-map", "[a]");
  ffmpeg([...args, output]);
}

// The details of a file that must have a picture (a clear error for a sound file).
function requirePicture(input: string): VideoInfo {
  const details = info(requireFile(input));
  if (!details.width) throw new Error(`"${input}" has no picture (it is sound only). For sound, use the sound and listen commands.`);
  return details;
}

// Save a single frame at `time` seconds as a picture.
export function frame(input: string, output: string, time: number): void {
  const { duration } = requirePicture(input);
  if (time < 0 || time > duration) throw new Error(`--time ${time} is outside the video (0 to ${round(duration)}s).`);
  ffmpeg(["-ss", String(time), "-i", input, "-frames:v", "1", "-update", "1", output]);
}

// Fade in from a color at the start and/or out to it at the end, picture and sound together.
export function fade(input: string, output: string, fadeIn = 0, fadeOut = 0, color = "black"): void {
  if (fadeIn <= 0 && fadeOut <= 0) throw new Error("Give --in and/or --out (seconds).");
  const { duration, hasAudio } = requirePicture(input);
  if (fadeIn + fadeOut > duration) throw new Error(`The fades (${fadeIn + fadeOut}s) are longer than the video (${round(duration)}s).`);
  const picture: string[] = [];
  const sound: string[] = [];
  if (fadeIn > 0) {
    picture.push(`fade=t=in:st=0:d=${fadeIn}:color=${color}`);
    sound.push(`afade=t=in:st=0:d=${fadeIn}`);
  }
  if (fadeOut > 0) {
    const start = round(duration - fadeOut, 3);
    picture.push(`fade=t=out:st=${start}:d=${fadeOut}:color=${color}`);
    sound.push(`afade=t=out:st=${start}:d=${fadeOut}`);
  }
  ffmpeg(["-i", input, "-vf", picture.join(","), ...(hasAudio ? ["-af", sound.join(",")] : []), output]);
}

// Play backwards, picture and sound. Long videos are reversed 5 seconds at a time, so memory stays small.
export function reverse(input: string, output: string): void {
  const { duration, hasAudio, fps } = requirePicture(input);
  const sound = hasAudio ? ["-af", "areverse"] : [];
  if (duration <= 10) {
    ffmpeg(["-i", input, "-vf", "reverse", ...sound, output]);
    return;
  }
  withTempDir((folder) => {
    // Each piece reversed (near-lossless, so the final encode is the only real one), then joined last piece first.
    const pieces: string[] = [];
    for (let start = 0, n = 0; start < duration; start += 5, n++) {
      const piece = join(folder, `piece-${n}.mkv`);
      ffmpeg(["-ss", String(start), "-t", "5", "-i", input, "-vf", "reverse", ...sound, "-c:v", "libx264", "-crf", "10", "-preset", "veryfast", ...(hasAudio ? ["-c:a", "pcm_s16le"] : []), piece]);
      pieces.push(piece);
    }
    const list = join(folder, "list.txt");
    writeFileSync(list, pieces.reverse().map(concatLine).join("\n"));
    ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-vf", `fps=${fps || 30}`, output]);
  });
}

// Calm down shaky handheld video. strength 0..1: how big a shake to remove. zoom: how much to enlarge to
// hide the moving edges (0 keeps the edges, filled in by mirroring).
export function stabilize(input: string, output: string, strength = 0.5, zoom = 0.05): void {
  const { width, height } = requirePicture(input);
  if (strength < 0 || strength > 1) throw new Error("--strength is 0..1.");
  const search = 16 * Math.round(1 + strength * 3); // pixels of shake to look for: 16, 32, 48 or 64 (deshake's steps)
  const crop = zoom > 0 ? `,crop=iw/${1 + zoom}:ih/${1 + zoom},scale=${even(width)}:${even(height)}` : "";
  ffmpeg(["-i", input, "-vf", `deshake=rx=${search}:ry=${search}:edge=mirror${crop},setsar=1`, "-c:a", "copy", output]);
}

// Put a picture (a logo, a sticker, a see-through PNG) or a video on top of a video.
// x, y: the centre of the layer as fractions of the frame (0..1). width: a fraction of the frame width.
// at / duration: when it shows (seconds). fade: seconds to fade in and out. The main video's sound is kept.
export function overlay(
  input: string,
  layer: string,
  output: string,
  o: { x?: number; y?: number; width?: number; at?: number; duration?: number; opacity?: number; fade?: number } = {},
): void {
  const main = requirePicture(input);
  requireFile(layer);
  const isPicture = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(layer);
  const at = o.at ?? 0;
  const end = Math.min(main.duration, o.duration ? at + o.duration : main.duration);
  if (at >= main.duration) throw new Error(`--at ${at} is after the end of the video (${round(main.duration)}s).`);
  const opacity = o.opacity ?? 1;
  if (opacity <= 0 || opacity > 1) throw new Error("--opacity is more than 0, up to 1.");
  const fade = Math.min(o.fade ?? 0, (end - at) / 2);
  // A picture is repeated for the whole video; a video layer starts at `at`.
  const source = isPicture ? ["-loop", "1", "-t", String(main.duration), "-i", layer] : ["-itsoffset", String(at), "-i", layer];
  const look = [
    `scale=${even(main.width * (o.width ?? 0.3))}:-2`,
    "format=rgba",
    ...(opacity < 1 ? [`colorchannelmixer=aa=${opacity}`] : []),
    ...(fade > 0 ? [`fade=t=in:st=${at}:d=${fade}:alpha=1`, `fade=t=out:st=${round(end - fade, 3)}:d=${fade}:alpha=1`] : []),
  ].join(",");
  const x = `${main.width * (o.x ?? 0.5)}-w/2`;
  const y = `${main.height * (o.y ?? 0.5)}-h/2`;
  const graph = `[1:v]${look}[layer];[0:v][layer]overlay=x=${x}:y=${y}:enable='between(t,${at},${end})':eof_action=pass,format=yuv420p[v]`;
  ffmpeg(["-i", input, ...source, "-filter_complex", graph, "-map", "[v]", "-map", "0:a:0?", "-c:a", "copy", "-t", String(main.duration), output]);
}

// Make an animated GIF.
export function gif(input: string, output: string, fps = 10, width = 480): void {
  requirePicture(input);
  const base = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  // Build a color palette first so the GIF looks good.
  const filter = `${base},split[a][b];[a]palettegen[p];[b][p]paletteuse`;
  ffmpeg(["-i", input, "-filter_complex", filter, output]);
}

// Put text on the whole video. (x, y) is the top of the text, and its left edge (or centre / right edge with align).
// The text is drawn with Skia into a see-through picture the size of the video, then laid over it.
export async function text(input: string, output: string, words: string, x = 10, y = 10, style: TextStyle = {}): Promise<void> {
  const { width, height } = info(input);
  const { createCanvas } = await skia();
  const canvas = createCanvas(width, height);
  drawText(canvas.getContext("2d"), words, x, y, { size: 32, ...style });
  await withTempDir(async (folder) => {
    const picture = join(folder, "text.png");
    await saveCanvas(canvas, picture);
    ffmpeg(["-i", input, "-i", picture, "-filter_complex", "[0:v][1:v]overlay=0:0", "-c:a", "copy", output]);
  });
}

// ---------- Looks and film effects (these also work on pictures) ----------

// Color grades. Each is a chain of ffmpeg color filters.
export const LOOKS: Record<string, string> = {
  cinematic: "curves=preset=medium_contrast,colorbalance=rs=-0.05:bs=0.08:rh=0.08:gh=0.02:bh=-0.06,eq=saturation=0.9",
  "teal-orange": "colorbalance=rs=-0.15:gs=-0.02:bs=0.15:rh=0.15:gh=0.03:bh=-0.15,eq=saturation=1.15:contrast=1.08",
  noir: "hue=s=0,curves=preset=strong_contrast,eq=brightness=-0.03",
  vintage: "curves=preset=vintage,eq=saturation=0.8",
  warm: "colorbalance=rm=0.08:gm=0.02:bm=-0.08,eq=saturation=1.05",
  cool: "colorbalance=rm=-0.06:bm=0.1",
  bleach: "eq=saturation=0.45:contrast=1.25",
  vivid: "eq=saturation=1.4:contrast=1.08",
};

const PICTURE_TYPES = /\.(png|jpe?g|webp|bmp|tiff?)$/i;

// Run a filter graph that starts at [0:v] and ends at [out]. Works for videos and pictures.
function applyGraph(input: string, output: string, graph: string): void {
  requireFile(input);
  const picture = PICTURE_TYPES.test(output);
  const extra = picture
    ? ["-frames:v", "1", "-update", "1"]
    : ["-map", "0:a:0?", "-c:a", "copy", "-pix_fmt", "yuv420p"];
  ffmpeg(["-i", input, "-filter_complex", graph, "-map", "[out]", ...extra, output]);
}

// The filter graph for a color grade, from label `from` to label `to` (used by grade and by movie.ts).
export function gradeGraph(look: string, strength: number, from: string, to: string): string {
  const filter = LOOKS[look];
  if (!filter) throw new Error(`Unknown look "${look}". Looks: ${Object.keys(LOOKS).join(", ")}`);
  const amount = Math.min(1, Math.max(0, strength));
  return amount >= 1
    ? `[${from}]${filter}[${to}]`
    : `[${from}]format=gbrp,split[ga][gb];[gb]${filter},format=gbrp[gg];[ga][gg]blend=all_mode=normal:all_opacity=${amount}[${to}]`;
}

// Apply a color grade. strength 0..1 mixes it with the original.
export function grade(input: string, output: string, look: string, strength = 1): void {
  applyGraph(input, output, gradeGraph(look, strength, "0:v", "out"));
}

export type Effects = {
  grain?: number; // 0..1 film grain
  vignette?: number; // 0..1 darker corners
  letterbox?: number; // e.g. 2.39 for black cinema bars
  glow?: number; // 0..1 soft bloom on bright parts
  chromatic?: number; // pixels of red/blue color split
  sharpen?: number; // 0..1
};

// The filter graph for film effects, from label `from` to label `to` (used by effects and by movie.ts).
export function effectsGraph(chosen: Effects, from: string, to: string): string {
  const steps: string[] = [];
  let label = from;
  let n = 0;
  const add = (filter: string) => {
    steps.push(`[${label}]${filter}[e${n}]`);
    label = `e${n++}`;
  };
  if (chosen.glow) {
    steps.push(`[${label}]format=gbrp,split[ga${n}][gb${n}];[gb${n}]gblur=sigma=18[gc${n}];[ga${n}][gc${n}]blend=all_mode=screen:all_opacity=${chosen.glow}[e${n}]`);
    label = `e${n++}`;
  }
  if (chosen.chromatic) add(`format=gbrp,rgbashift=rh=-${Math.round(chosen.chromatic)}:bh=${Math.round(chosen.chromatic)}`);
  if (chosen.sharpen) add(`unsharp=5:5:${chosen.sharpen * 2}`);
  if (chosen.vignette) add(`vignette=angle=${0.2 + chosen.vignette * 0.8}`);
  if (chosen.grain) add(`noise=alls=${Math.round(chosen.grain * 40)}:allf=t+u`);
  if (chosen.letterbox) {
    const bar = `max(0\\,(ih-iw/${chosen.letterbox})/2)`;
    add(`drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill,drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`);
  }
  if (!steps.length) throw new Error("Give at least one effect: --grain, --vignette, --letterbox, --glow, --chromatic, --sharpen");
  steps.push(`[${label}]null[${to}]`);
  return steps.join(";");
}

// Add film effects. Each effect is only applied if given.
export function effects(input: string, output: string, chosen: Effects): void {
  applyGraph(input, output, effectsGraph(chosen, "0:v", "out"));
}

// ---------- Captions ----------

// Burn animated captions into a video. Uses a transcript from `listen transcribe`, or makes one (whisper model).
export async function captions(
  input: string,
  output: string,
  options: { transcript?: string; style?: graphics.CaptionStyle; position?: string; model?: string; brand?: string; speakers?: boolean } = {},
): Promise<{ words: number; groups: number }> {
  const details = info(input);
  if (!details.width) throw new Error("This file has no picture to put captions on.");
  return withTempDir(async (folder) => {
    let transcript = options.transcript;
    if (!transcript) {
      transcript = join(folder, "words.json");
      await listen.transcribe(input, transcript, options.model ?? "base");
    }
    const words = readJson(transcript).words ?? [];
    if (!words.length) throw new Error("The transcript has no words.");
    const overlay = join(folder, "captions.mov");
    const made = await graphics.captionsOverlay(words, overlay, {
      width: details.width,
      height: details.height,
      fps: details.fps || 30,
      duration: details.duration,
      style: options.style,
      position: options.position,
      brand: loadBrand(options.brand),
      speakerColors: options.speakers,
    });
    ffmpeg([
      "-i", input, "-i", overlay,
      "-filter_complex", "[0:v][1:v]overlay=0:0:eof_action=pass[v]",
      "-map", "[v]", "-map", "0:a:0?", "-c:a", "copy", "-pix_fmt", "yuv420p",
      output,
    ]);
    return { words: words.length, groups: made.groups };
  });
}

// ---------- Cutting and framing ----------

// Automatic jump cuts: remove every pause longer than `min` seconds.
// db: how quiet counts as a pause. pad: seconds of pause kept on each side so words are not clipped.
export function removeSilence(input: string, output: string, min = 0.6, db = -35, pad = 0.1) {
  const details = info(input);
  if (!details.hasAudio) throw new Error("This video has no sound to find pauses in.");
  const { silences } = listen.silences(input, db, min);
  // Keep everything except the middle of each pause.
  const keep: [number, number][] = [];
  let start = 0;
  for (const s of silences) {
    const cutFrom = s.start <= 0 ? 0 : s.start + pad;
    const cutTo = s.end >= details.duration ? details.duration : s.end - pad;
    if (cutTo - cutFrom < 0.05) continue;
    if (cutFrom > start) keep.push([start, cutFrom]);
    start = cutTo;
  }
  if (start < details.duration) keep.push([start, details.duration]);
  if (!keep.length) throw new Error("The whole file is silent. Try a lower --db (e.g. -50).");
  const kept = keepOnly(input, output, keep);
  return { cuts: silences.length, before: round(details.duration), after: round(kept), removed: round(details.duration - kept) };
}

// Keep only these [start, end] parts of a video (or sound) and join them. Returns the new length.
export function keepOnly(input: string, output: string, keep: [number, number][]): number {
  // select keeps the frames inside the ranges; setpts closes the gaps.
  const ranges = keep.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join("+");
  const filters = info(input).width
    ? ["-vf", `select='${ranges}',setpts=N/FRAME_RATE/TB`, "-af", `aselect='${ranges}',asetpts=N/SR/TB`]
    : ["-af", `aselect='${ranges}',asetpts=N/SR/TB`];
  ffmpeg(["-i", input, ...filters, output]);
  return keep.reduce((sum, [a, b]) => sum + b - a, 0);
}

// Filler sounds people say while thinking. Whisper writes some of them down; those get cut.
export const FILLERS = ["um", "umm", "uh", "uhh", "uhm", "erm", "er", "ah", "hmm", "mm", "mhm"];

// Cut filler words ("um", "uh") and stutters ("I I think" → "I think") out of speech, using the word times.
// transcript: from listen transcribe (made here if not given). words: your own list of words to cut instead of FILLERS.
export async function removeFillers(input: string, output: string, options: { transcript?: string; words?: string[]; repeats?: boolean; model?: string } = {}) {
  const details = info(input);
  if (!details.hasAudio) throw new Error("This file has no sound to find words in.");
  const cut = (options.words ?? FILLERS).map((w) => w.toLowerCase());
  const words: listen.Word[] = await withTempDir(async (folder) => {
    let transcript = options.transcript;
    if (!transcript) {
      transcript = join(folder, "words.json");
      await listen.transcribe(input, transcript, options.model ?? "base");
    }
    return readJson(transcript).words ?? [];
  });
  const plain = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  const pauses = listen.speechPauses(listen.monoSamples(input, 16000));
  // A word goes when it is a filler, or (repeats) when the next word is the same word right after it.
  // The cut runs from the word to the end of the first real pause after it (word times can be a little off;
  // pauses are exact), or to the next word when the speaker runs straight on.
  const removed: { word: string; at: number }[] = [];
  const gaps: [number, number][] = [];
  words.forEach((word, n) => {
    const next = words[n + 1];
    const filler = cut.includes(plain(word.word));
    const stutter = (options.repeats ?? true) && next && plain(word.word) && plain(word.word) === plain(next.word) && next.start - word.end < 0.6;
    if (!filler && !stutter) return;
    removed.push({ word: word.word, at: word.start });
    const pause = pauses.find(([start]) => start >= word.start + 0.05 && start <= word.end + 0.3);
    gaps.push([word.start, pause ? Math.max(pause[0], pause[1] - 0.03) : next ? next.start : word.end]);
  });
  if (!removed.length) {
    ffmpeg(["-i", input, "-c", "copy", output]);
    return { removed, count: 0, before: round(details.duration), after: round(details.duration) };
  }
  const keep: [number, number][] = [];
  let start = 0;
  for (const [from, to] of gaps) {
    if (from > start) keep.push([start, from]);
    start = Math.max(start, to);
  }
  if (start < details.duration) keep.push([start, details.duration]);
  const kept = keepOnly(input, output, keep);
  return { removed, count: removed.length, before: round(details.duration), after: round(kept) };
}

// Blur every face in a video (privacy). Faces are found every `every` seconds (faces model);
// each frame blurs the faces seen just before and just after it, so moving faces stay covered.
// strength: 1 = strong blur, 2 = stronger. pad: how much bigger than the face the blur is (0.3 = 30%).
export async function blurFaces(input: string, output: string, options: { every?: number; strength?: number; pad?: number; min?: number } = {}) {
  const { every = 0.2, strength = 1, pad = 0.3 } = options;
  const details = info(input);
  if (!details.width) throw new Error("This file has no picture.");
  const look = await import("./look.ts");
  const checks = await look.thingsOverTime(input, ["face"], every, options.min);
  const sharp = need("sharp");
  const { width, height } = details;
  const writer = writeVideo(output, { width, height, fps: details.fps || 30, audio: details.hasAudio ? input : undefined });
  let blurred = 0;
  for await (const frame of readFrames(input)) {
    // The checks just before and just after this frame.
    const after = checks.findIndex((c) => c.time >= frame.time);
    const near = after < 0 ? [checks.at(-1)] : [checks[after], checks[after - 1]];
    const faces = near.flatMap((c) => c?.things ?? []);
    for (const face of faces) {
      // The blurred area: the face plus padding, kept inside the picture.
      const x = Math.max(0, Math.floor(face.x - face.width * pad));
      const y = Math.max(0, Math.floor(face.y - face.height * pad));
      const w = Math.min(width - x, Math.ceil(face.width * (1 + 2 * pad)));
      const h = Math.min(height - y, Math.ceil(face.height * (1 + 2 * pad)));
      if (w < 2 || h < 2) continue;
      const region = Buffer.alloc(w * h * 4);
      for (let row = 0; row < h; row++) frame.pixels.copy(region, row * w * 4, ((y + row) * width + x) * 4, ((y + row) * width + x + w) * 4);
      const soft: Buffer = await sharp(region, { raw: { width: w, height: h, channels: 4 } }).blur(Math.max(4, (w / 6) * strength)).raw().toBuffer();
      // Only inside an oval (faces are round), so the blur does not look like a box.
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const dx = (col + 0.5) / w - 0.5;
          const dy = (row + 0.5) / h - 0.5;
          if (dx * dx + dy * dy > 0.25) continue;
          soft.copy(frame.pixels, ((y + row) * width + x + col) * 4, (row * w + col) * 4, (row * w + col) * 4 + 4);
        }
      }
    }
    if (faces.length) blurred++;
    await writer.write(frame.pixels);
  }
  await writer.finish();
  return { checks: checks.length, mostFaces: Math.max(0, ...checks.map((c) => c.things.length)), framesBlurred: blurred };
}

// Parse "9:16" or "1.78" into a number (width / height).
export function parseAspect(aspect: string): number {
  const [w, h] = aspect.split(":").map(Number);
  const value = h ? w / h : w;
  if (!value || value <= 0) throw new Error(`Aspect "${aspect}" should look like 9:16, 1:1, 16:9 or 1.78.`);
  return value;
}

// Crop to a new shape, e.g. 9:16 for phones. x: where to crop across, 0 = left, 0.5 = middle, 1 = right.
export function reframe(input: string, output: string, aspect: string, x = 0.5, y = 0.5): void {
  const a = parseAspect(aspect);
  // The largest even-sized box of that shape that fits.
  const w = `trunc(min(iw\\,ih*${a})/2)*2`;
  const h = `trunc(min(ih\\,iw/${a})/2)*2`;
  const filter = `crop=${w}:${h}:(iw-${w})*${x}:(ih-${h})*${y},setsar=1`;
  if (PICTURE_TYPES.test(output)) return void ffmpeg(["-i", input, "-vf", filter, "-frames:v", "1", "-update", "1", output]);
  ffmpeg(["-i", input, "-vf", filter, "-c:a", "copy", output]);
}

// Crop to a new shape while following the main subject (a person, a product) as it moves (cutout model).
// The subject is found every `every` seconds, its path is smoothed like a camera operator would,
// and the crop glides along it. smooth: seconds of smoothing (bigger = calmer camera).
export async function reframeFollow(input: string, output: string, aspect: string, every = 0.5, smooth = 2) {
  const { duration } = requirePicture(input);
  return withTempDir(async (folder) => {
    const follow = await followFilter(input, aspect, folder, { every, smooth, from: 0, to: duration });
    // ffmpeg runs inside the temp folder, so the filter names its command file without a "C:" path.
    ffmpeg(["-i", resolve(input), "-vf", `${follow.filter},setsar=1`, "-map", "0:v", "-map", "0:a:0?", "-c:a", "copy", resolve(output)], folder);
    return { width: follow.width, height: follow.height, samples: follow.path.length, cached: follow.cached, path: follow.path };
  });
}

// Where the subject is (0..1 across and down) at times on a grid of `every` seconds, for a range of a video.
// Saved per video in .joedit-cache/follow/ next to it: a retimed or re-trimmed shot reuses the samples it already has,
// and only the missing part of the range is looked at (the cutout model is the slow part).
export async function subjectPath(input: string, from: number, to: number, every = 0.5): Promise<{ centres: { time: number; x: number; y: number }[]; cached: number }> {
  const stat = statSync(input);
  const key = createHash("sha256").update(`${resolve(input)}|${stat.size}|${stat.mtimeMs}|${every}`).digest("hex").slice(0, 16);
  const cacheFile = join(dirname(resolve(input)), ".joedit-cache", "follow", `${key}.json`);
  let saved: Record<string, number[] | null> = {};
  try {
    saved = JSON.parse(readFileSync(cacheFile, "utf8"));
  } catch {} // no samples yet (or a broken file): start fresh

  // Grid times that cover the range, one step either side so the smoothing has context.
  const first = Math.max(0, Math.floor(from / every) - 1);
  const last = Math.ceil(to / every) + 1;
  const times: number[] = [];
  for (let k = first; k <= last; k++) times.push(round(k * every, 3));
  const missing = times.filter((t) => !(String(t) in saved));
  const cached = times.length - missing.length;

  if (missing.length) {
    // One pass over the missing span: small frames, one every `every` seconds, starting on the grid.
    await withTempDir(async (folder) => {
      const start = missing[0];
      const span = missing[missing.length - 1] - start + every / 2;
      ffmpeg(["-ss", String(start), "-t", String(span), "-i", input, "-vf", `fps=1/${every}:round=near,scale=384:-2`, join(folder, "%05d.png")]);
      const frames = readdirSync(folder).filter((name) => name.endsWith(".png")).sort();
      const { subjectMask } = await import("./picture.ts");
      for (const [n, name] of frames.entries()) {
        const { mask, width: w, height: h } = await subjectMask(join(folder, name)); // 255 = subject
        let total = 0, sumX = 0, sumY = 0;
        for (let i = 0; i < mask.length; i++) {
          total += mask[i];
          sumX += (mask[i] * ((i % w) + 0.5)) / w;
          sumY += (mask[i] * (Math.floor(i / w) + 0.5)) / h;
        }
        // null = no subject here (it covers less than 0.2% of the frame)
        saved[String(round(start + n * every, 3))] = total > 255 * w * h * 0.002 ? [round(sumX / total, 4), round(sumY / total, 4)] : null;
      }
    });
    for (const t of missing) if (!(String(t) in saved)) saved[String(t)] = null; // past the end of the video
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(saved));
    } catch {} // a folder we cannot write to (a camera card, a shared drive): it works, just without the cache
  }

  // Frames with no subject keep the last centre (or the middle, before the subject first shows up).
  let held = [0.5, 0.5];
  const centres = times.map((time) => {
    held = saved[String(time)] ?? held;
    return { time, x: held[0], y: held[1] };
  });
  return { centres, cached };
}

// An ffmpeg filter that crops to `aspect` and follows the subject over from..to of the input.
// Times in the filter start at 0 = `from` (the input is expected to be trimmed to from..to).
// It writes follow.txt into `folder`: run ffmpeg with that folder as its working folder.
export async function followFilter(input: string, aspect: string, folder: string, o: { from: number; to: number; every?: number; smooth?: number }) {
  const { width, height, fps } = info(input);
  const every = o.every ?? 0.5;
  const a = parseAspect(aspect);
  const cropW = Math.floor(Math.min(width, height * a) / 2) * 2;
  const cropH = Math.floor(Math.min(height, width / a) / 2) * 2;
  const { centres, cached } = await subjectPath(input, o.from, o.to, every);

  // Smooth the path with a moving average (like a calm camera operator), then keep the crop inside the frame.
  const reach = Math.max(1, Math.round((o.smooth ?? 2) / every / 2));
  const corners = centres.map((c, k) => {
    const near = centres.slice(Math.max(0, k - reach), k + reach + 1);
    const cx = near.reduce((s, n) => s + n.x, 0) / near.length;
    const cy = near.reduce((s, n) => s + n.y, 0) / near.length;
    return {
      time: c.time - o.from,
      x: Math.min(Math.max(cx * width - cropW / 2, 0), width - cropW),
      y: Math.min(Math.max(cy * height - cropH / 2, 0), height - cropH),
    };
  });

  // A crop position for every frame (straight lines between the samples), sent to ffmpeg's crop filter.
  const lines: string[] = [];
  for (let frame = 0; frame < Math.ceil((o.to - o.from) * fps); frame++) {
    const t = frame / fps;
    const after = corners.findIndex((c) => c.time >= t);
    const b = corners[after === -1 ? corners.length - 1 : after];
    const p = corners[Math.max(0, (after === -1 ? corners.length : after) - 1)];
    const mix = b.time === p.time ? 0 : Math.min(Math.max((t - p.time) / (b.time - p.time), 0), 1);
    lines.push(`${t.toFixed(4)} crop@follow x ${Math.round(p.x + (b.x - p.x) * mix)}, crop@follow y ${Math.round(p.y + (b.y - p.y) * mix)};`);
  }
  writeFileSync(join(folder, "follow.txt"), lines.join("\n"));
  const start = lines.length ? corners.find((c) => c.time >= 0) ?? corners[0] : corners[0];
  return {
    filter: `sendcmd=f=follow.txt,crop@follow=${cropW}:${cropH}:${Math.round(start.x)}:${Math.round(start.y)}`,
    width: cropW,
    height: cropH,
    cached,
    path: corners.filter((c) => c.time >= 0 && c.time <= o.to - o.from).map((c) => ({ time: round(c.time), x: Math.round(c.x), y: Math.round(c.y) })),
  };
}

// Make a short clip from a description, or bring a picture to life (videogen pack: Wan 2.2 TI2V-5B).
// Needs a big GPU (24 GB+ of video memory) and takes minutes per clip; fewer steps = faster, rougher.
export function generate(output: string, prompt: string, options: { image?: string; seconds?: number; width?: number; height?: number; steps?: number; seed?: number } = {}) {
  if (!prompt.trim()) throw new Error('Describe the clip with --prompt, e.g. --prompt "waves rolling onto a beach at sunset, slow camera push".');
  if (options.image) requireFile(options.image);
  return withTempDir((folder) => {
    const frames = join(folder, "frames");
    const args = [frames, "--prompt", prompt, "--seconds", String(options.seconds ?? 5), "--width", String(options.width ?? 1280),
      "--height", String(options.height ?? 704), "--steps", String(options.steps ?? 50)];
    if (options.image) args.push("--image", options.image);
    if (options.seed !== undefined) args.push("--seed", String(options.seed));
    const result = runPack("videogen", args);
    ffmpeg(["-framerate", String(result.fps), "-i", join(frames, "%05d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", output]);
    return { ...result, seconds: round(result.frames / result.fps) };
  });
}

// Picture-in-picture: a small video in a corner of the main one. Sound comes from the main video.
// size: width of the small video as a part of the main width. corner: top-left|top-right|bottom-left|bottom-right.
export function pip(main: string, small: string, output: string, corner = "bottom-right", size = 0.3, margin = 0.03): void {
  requireFile(small);
  const { width, height } = info(main);
  const w = Math.round((width * size) / 2) * 2;
  const m = Math.round(Math.min(width, height) * margin);
  const positions: Record<string, string> = {
    "top-left": `${m}:${m}`,
    "top-right": `W-w-${m}:${m}`,
    "bottom-left": `${m}:H-h-${m}`,
    "bottom-right": `W-w-${m}:H-h-${m}`,
  };
  const position = positions[corner];
  if (!position) throw new Error(`--corner must be one of: ${Object.keys(positions).join(", ")}`);
  const graph = `[1:v]scale=${w}:-2,setsar=1[s];[0:v][s]overlay=${position}:eof_action=pass[v]`;
  ffmpeg(["-i", main, "-i", small, "-filter_complex", graph, "-map", "[v]", "-map", "0:a:0?", "-c:a", "copy", "-pix_fmt", "yuv420p", output]);
}

// Smooth slow motion or higher frame rates by inventing in-between frames (motion interpolation).
export function interpolate(input: string, output: string, fps = 60): void {
  ffmpeg(["-i", input, "-vf", `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`, "-c:a", "copy", output]);
}

// Change format based on the output file extension (e.g. .mov -> .mp4).
export function convert(input: string, output: string): void {
  ffmpeg(["-i", input, output]);
}

// Read the effect flags (used by video effects and picture effects).
export function effectFlags(a: Args): Effects {
  const value = (name: string) => (a.flags[name] === undefined ? undefined : numberFlag(a, name));
  return {
    grain: value("grain"),
    vignette: value("vignette"),
    letterbox: value("letterbox"),
    glow: value("glow"),
    chromatic: value("chromatic"),
    sharpen: value("sharpen"),
  };
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
  resize: {
    usage: "resize <input> <output> [--width N] [--height N]",
    run: (a) => {
      const { input, output } = inOut(a);
      resize(input, output, optionalNumberFlag(a, "width", 0), optionalNumberFlag(a, "height", 0));
    },
  },
  crop: {
    usage: "crop <input> <output> --x N --y N --width N --height N",
    run: (a) => {
      const { input, output } = inOut(a);
      crop(input, output, numberFlag(a, "x"), numberFlag(a, "y"), numberFlag(a, "width"), numberFlag(a, "height"));
    },
  },
  rotate: {
    usage: "rotate <input> <output> --degrees 90|180|270",
    run: (a) => {
      const { input, output } = inOut(a);
      rotate(input, output, numberFlag(a, "degrees"));
    },
  },
  flip: {
    usage: "flip <input> <output> --direction horizontal|vertical",
    run: (a) => {
      const { input, output } = inOut(a);
      flip(input, output, stringFlag(a, "direction"));
    },
  },
  speed: {
    usage: "speed <input> <output> --factor 0.5..100",
    run: (a) => {
      const { input, output } = inOut(a);
      speed(input, output, numberFlag(a, "factor"));
    },
  },
  mute: {
    usage: "mute <input> <output>",
    run: (a) => {
      const { input, output } = inOut(a);
      mute(input, output);
    },
  },
  "extract-audio": {
    usage: "extract-audio <input> <output.mp3|.wav|.m4a>",
    run: (a) => {
      const { input, output } = inOut(a);
      extractAudio(input, output);
    },
  },
  "add-audio": {
    usage: "add-audio <input> <output> --audio FILE",
    run: (a) => {
      const { input, output } = inOut(a);
      addAudio(input, stringFlag(a, "audio"), output);
    },
  },
  concat: {
    usage: "concat <input1> <input2> [more inputs...] <output>",
    run: (a) => {
      const files = a.positional;
      if (files.length < 3) throw new Error("Give at least 2 inputs and 1 output.");
      concat(files.slice(0, -1), files[files.length - 1]);
    },
  },
  fade: {
    usage: "fade <input> <output> [--in SECONDS] [--out SECONDS] [--color black|white]  (picture and sound)",
    run: (a) => {
      const { input, output } = inOut(a);
      fade(input, output, optionalNumberFlag(a, "in", 0), optionalNumberFlag(a, "out", 0), a.flags.color ?? "black");
    },
  },
  reverse: {
    usage: "reverse <input> <output>  (plays backwards, picture and sound)",
    run: (a) => {
      const { input, output } = inOut(a);
      reverse(input, output);
    },
  },
  stabilize: {
    usage: "stabilize <input> <output> [--strength 0..1] [--zoom 0.05]  (calms shaky handheld video; zoom hides the moving edges)",
    run: (a) => {
      const { input, output } = inOut(a);
      stabilize(input, output, optionalNumberFlag(a, "strength", 0.5), optionalNumberFlag(a, "zoom", 0.05));
    },
  },
  overlay: {
    usage: "overlay <input> <picture|video> <output> [--x 0..1] [--y 0..1] [--width 0..1] [--at S] [--duration S] [--opacity 0..1] [--fade S]  (logo, watermark, sticker; x/y = its centre)",
    run: (a) => {
      if (a.positional.length < 3) throw new Error("Give the video, the picture or video to put on top, and the output.");
      const [input, layer, output] = a.positional;
      overlay(input, layer, output, {
        x: a.flags.x === undefined ? undefined : numberFlag(a, "x"),
        y: a.flags.y === undefined ? undefined : numberFlag(a, "y"),
        width: a.flags.width === undefined ? undefined : numberFlag(a, "width"),
        at: a.flags.at === undefined ? undefined : numberFlag(a, "at"),
        duration: a.flags.duration === undefined ? undefined : numberFlag(a, "duration"),
        opacity: a.flags.opacity === undefined ? undefined : numberFlag(a, "opacity"),
        fade: a.flags.fade === undefined ? undefined : numberFlag(a, "fade"),
      });
    },
  },
  frame: {
    usage: "frame <input> <output.png|.jpg> --time SECONDS",
    run: (a) => {
      const { input, output } = inOut(a);
      frame(input, output, numberFlag(a, "time"));
    },
  },
  gif: {
    usage: "gif <input> <output.gif> [--fps N] [--width N]",
    run: (a) => {
      const { input, output } = inOut(a);
      gif(input, output, optionalNumberFlag(a, "fps", 10), optionalNumberFlag(a, "width", 480));
    },
  },
  text: {
    usage: `text <input> <output> --text "words" [--x N] [--y N] ${TEXT_FLAGS}`,
    run: (a) => {
      const { input, output } = inOut(a);
      return text(input, output, stringFlag(a, "text"), optionalNumberFlag(a, "x", 10), optionalNumberFlag(a, "y", 10), textStyle(a));
    },
  },
  grade: {
    usage: "grade <input> <output> --look cinematic|teal-orange|noir|vintage|warm|cool|bleach|vivid [--strength 0..1]",
    run: (a) => {
      const { input, output } = inOut(a);
      grade(input, output, stringFlag(a, "look"), optionalNumberFlag(a, "strength", 1));
    },
  },
  effects: {
    usage: "effects <input> <output> [--grain 0..1] [--vignette 0..1] [--letterbox 2.39] [--glow 0..1] [--chromatic PX] [--sharpen 0..1]",
    run: (a) => {
      const { input, output } = inOut(a);
      effects(input, output, effectFlags(a));
    },
  },
  captions: {
    usage: "captions <input> <output> [--transcript words.json] [--style karaoke|pop|bold|minimal] [--position bottom|center|top] [--speakers] [--brand brand.json] [--model base]  (--speakers: a color per speaker; use a transcript from listen speakers)",
    run: (a) => {
      const { input, output } = inOut(a);
      return captions(input, output, {
        transcript: a.flags.transcript,
        style: a.flags.style as graphics.CaptionStyle | undefined,
        position: a.flags.position,
        model: a.flags.model,
        brand: a.flags.brand,
        speakers: a.flags.speakers === "true",
      });
    },
  },
  "remove-fillers": {
    usage: `remove-fillers <input> <output> [--transcript words.json] [--words ${FILLERS.slice(0, 3).join(",")},...] [--repeats true|false] [--model base]  (cuts um, uh and stutters)`,
    run: async (a) => {
      const { input, output } = inOut(a);
      return removeFillers(input, output, {
        transcript: a.flags.transcript,
        words: a.flags.words ? a.flags.words.split(",").map((w) => w.trim()) : undefined,
        repeats: a.flags.repeats !== "false",
        model: a.flags.model,
      });
    },
  },
  "blur-faces": {
    usage: "blur-faces <input> <output> [--every 0.2] [--strength 1] [--pad 0.3] [--min 0.6]  (needs: install faces)",
    run: async (a) => {
      const { input, output } = inOut(a);
      return blurFaces(input, output, {
        every: optionalNumberFlag(a, "every", 0.2),
        strength: optionalNumberFlag(a, "strength", 1),
        pad: optionalNumberFlag(a, "pad", 0.3),
        min: a.flags.min === undefined ? undefined : numberFlag(a, "min"),
      });
    },
  },
  "remove-silence": {
    usage: "remove-silence <input> <output> [--min 0.6] [--db -35] [--pad 0.1]  (automatic jump cuts)",
    run: (a) => {
      const { input, output } = inOut(a);
      return removeSilence(input, output, optionalNumberFlag(a, "min", 0.6), optionalNumberFlag(a, "db", -35), optionalNumberFlag(a, "pad", 0.1));
    },
  },
  reframe: {
    usage: "reframe <input> <output> --aspect 9:16|1:1|4:5|16:9 [--x 0..1] [--y 0..1]  (0.5 = centre)  |  --follow [--smooth 2] [--every 0.5]  (follows the subject; needs: install cutout)",
    run: (a) => {
      const { input, output } = inOut(a);
      if (a.flags.follow === "true") {
        return reframeFollow(input, output, stringFlag(a, "aspect"), optionalNumberFlag(a, "every", 0.5), optionalNumberFlag(a, "smooth", 2));
      }
      reframe(input, output, stringFlag(a, "aspect"), optionalNumberFlag(a, "x", 0.5), optionalNumberFlag(a, "y", 0.5));
    },
  },
  generate: {
    usage: 'generate <output.mp4> --prompt "what happens, camera move, style" [--image start.png] [--seconds 5] [--width 1280] [--height 704] [--steps 50] [--seed N]  (needs: install videogen, a big GPU)',
    run: (a) => {
      if (!a.positional[0]) throw new Error("Missing output path.");
      return generate(a.positional[0], a.flags.prompt ?? "", {
        image: a.flags.image,
        seconds: optionalNumberFlag(a, "seconds", 5),
        width: optionalNumberFlag(a, "width", 1280),
        height: optionalNumberFlag(a, "height", 704),
        steps: optionalNumberFlag(a, "steps", 50),
        seed: a.flags.seed === undefined ? undefined : numberFlag(a, "seed"),
      });
    },
  },
  pip: {
    usage: "pip <main> <small> <output> [--corner bottom-right] [--size 0.3]",
    run: (a) => {
      if (a.positional.length < 3) throw new Error("Give the main video, the small video and the output.");
      const [main, small, output] = a.positional;
      pip(requireFile(main), small, output, a.flags.corner ?? "bottom-right", optionalNumberFlag(a, "size", 0.3));
    },
  },
  interpolate: {
    usage: "interpolate <input> <output> [--fps 60]  (smooth motion by inventing in-between frames)",
    run: (a) => {
      const { input, output } = inOut(a);
      interpolate(input, output, optionalNumberFlag(a, "fps", 60));
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
  runCli("Video editor: node video.ts <command> ...", commands, process.argv.slice(2));
}

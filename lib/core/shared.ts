// Shared helpers used by every joEdit module: running programs, reading arguments, the CLI,
// the native libraries (in node_modules), packs (local AI tools), assets (downloaded fonts and tools) and the brand kit.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, createWriteStream, openSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { freemem, tmpdir, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The folder joEdit lives in, where downloaded assets go, and where AI models are kept.
export const LIB = dirname(dirname(fileURLToPath(import.meta.url))); // lib/ (this file is lib/core/shared.ts)
export const ASSETS = join(LIB, ".assets");
export const MODELS = join(LIB, ".models");

// ---------- Native libraries ----------
// joEdit's engine is a set of npm libraries kept in libs/ (libs/package.json, installed by `npm install` in lib/):
// node-av (FFmpeg), sharp (pictures), @napi-rs/canvas (Skia drawing), node-web-audio-api (sound),
// @huggingface/transformers + onnxruntime-node (AI models), kokoro-js (voices) and koffi (loads raylib for GPU effects).
// They are loaded only when a command needs them, so a missing one only breaks its own commands.
export const LIBS = join(LIB, "libs");
const requireLibrary = createRequire(join(LIBS, "package.json"));
// Free fonts that come with joEdit (SIL Open Font License, see libs/fonts/OFL-*.txt).
export const FONTS = join(LIBS, "fonts");

// Load a library from libs/ by name, with a clear message if it is missing.
export function need(name: string): any {
  try {
    return requireLibrary(name);
  } catch (error: any) {
    if (error.code === "MODULE_NOT_FOUND") throw new Error(`The "${name}" library is missing. Run: cd ${LIB} && npm install`);
    throw error;
  }
}

// The ffmpeg program: the full build that comes with joEdit (FFmpeg 8 with x264/x265, VideoToolbox/NVENC,
// libass, drawtext and whisper), or else one installed on this computer.
export const FFMPEG: string = (() => {
  try {
    return requireLibrary("node-av/ffmpeg").ffmpegPath();
  } catch {
    return "ffmpeg";
  }
})();

// The default font file (Inter, included with joEdit).
export const DEFAULT_FONT = join(FONTS, "Inter.ttf");

// Parsed command line: plain values go in `positional`, `--name value` pairs go in `flags`.
export type Args = {
  positional: string[];
  flags: Record<string, string>;
};

// Extra facts a command can report back (printed as JSON next to "ok": true).
export type Result = Record<string, unknown>;

// A CLI command: a short usage line and the function that runs it (it may be async).
export type Command = {
  usage: string;
  run: (args: Args) => Result | void | Promise<Result | void>;
};

// Run a program (ffmpeg, uv, blender ...) and return its stdout. "ffmpeg" means joEdit's own ffmpeg.
// Throws an Error containing stderr if the program fails.
// cwd: the folder to run in (lets ffmpeg filters use short file names, with no "C:" to escape).
export function run(program: string, args: string[], env?: Record<string, string>, cwd?: string): string {
  try {
    return execFileSync(program === "ffmpeg" ? FFMPEG : program, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024, // transcripts and analysis output can be large
      env: env ? { ...process.env, ...env } : process.env,
      cwd,
      shell: isWindowsScript(program), // Windows runs .cmd files (npx.cmd) only through a shell
    });
  } catch (error: any) {
    if (error.code === "ENOENT") throw new Error(`"${program}" is not installed. Run: node joedit.ts doctor`);
    const details = (error.stderr || error.message || "").toString().trim();
    throw new Error(`${program} failed: ${details}`);
  }
}

// True if a program can be found on this computer.
// Windows has `where` instead of `which`.
export function hasProgram(program: string): boolean {
  return spawnSync(process.platform === "win32" ? "where" : "which", [program]).status === 0;
}

// On Windows, npx and npm are .cmd scripts: their name gets ".cmd" and they run through a shell.
export const isWindowsScript = (program: string) => process.platform === "win32" && /\.cmd$/i.test(program);
export const npx = process.platform === "win32" ? "npx.cmd" : "npx";

// Run ffmpeg quietly, always overwriting the output. Used by video.ts and sound.ts.
// cwd: see run().
export function ffmpeg(args: string[], cwd?: string): void {
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...bt709(args)], undefined, cwd);
}

// Every video joEdit writes is BT.709, the colors players assume for video, and says so in the file.
// Given these tags, ffmpeg converts whatever comes in (BT.601, full-range phone video, RGB pictures and frames)
// with the right math; without them, RGB became BT.601 and colors shifted by up to 35/255 when played.
// Copies (-c:v copy) and files that already choose their colors are left alone.
const VIDEO_FILE = /\.(mp4|m4v|mov|mkv|webm|avi)$/i;
export function bt709(args: string[]): string[] {
  const output = args[args.length - 1] ?? "";
  const codecAt = Math.max(args.lastIndexOf("-c:v"), args.lastIndexOf("-c"));
  const codec = codecAt >= 0 ? args[codecAt + 1] : undefined;
  if (!VIDEO_FILE.test(output) || codec === "copy" || args.includes("-vn") || args.includes("-colorspace")) return args;
  // H.264 (chosen, or ffmpeg's default for these files) also needs the tags inside the stream.
  const h264 = codec ? codec === "libx264" : !/\.webm$/i.test(output);
  const tags = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
  if (h264 && !args.includes("-x264-params")) tags.push("-x264-params", "colorprim=bt709:transfer=bt709");
  return [...args.slice(0, -1), ...tags, output];
}

// Read a JSON file. A byte-order mark (Windows PowerShell adds one) is ignored, and a mistake names the file.
export function readJson(path: string): any {
  const text = readFileSync(requireFile(path), "utf8").replace(/^﻿/, "");
  try {
    return JSON.parse(text);
  } catch (error: any) {
    throw new Error(`${path} is not valid JSON (${error.message}).`);
  }
}

// One line of an ffmpeg concat list. Quotes in the path are escaped, so "O'Brien/clip.mp4" works.
export function concatLine(path: string): string {
  return `file '${path.replace(/'/g, "'\\''")}'`;
}

// The same, without waiting: other work (more scenes, Chrome renders) keeps going while ffmpeg runs. cwd: see run().
export function ffmpegAsync(args: string[], cwd?: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...bt709(args)], { stdio: ["ignore", "ignore", "pipe"], cwd });
    let errors = "";
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.on("error", (error: any) => fail(error.code === "ENOENT" ? new Error('"ffmpeg" is not installed. Run: node joedit.ts doctor') : error));
    child.on("close", (code) => (code === 0 ? done() : fail(new Error(`ffmpeg failed: ${errors.trim()}`))));
  });
}

// Run an ffmpeg analysis filter over a file and return ffmpeg's log text.
// Detection filters (silencedetect, blackdetect, ebur128, ...) report their findings in this log.
// kind: "video" uses -vf, "audio" uses -af.
export function analyze(input: string, kind: "video" | "audio", filter: string): string {
  requireFile(input);
  // Only the stream being measured is decoded (-an / -vn): reading a big video's picture for a sound check is slow.
  const only = kind === "video" ? ["-an", "-vf"] : ["-vn", "-af"];
  const result = spawnSync(FFMPEG, ["-hide_banner", "-nostats", "-i", input, ...only, filter, "-f", "null", "-"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr.trim().split("\n").slice(-3).join(" ")}`);
  return result.stderr;
}

// Create a temporary folder, give it to `work`, and always delete it afterwards.
// `work` may be async: the folder is then deleted when its promise finishes.
export function withTempDir<T>(work: (folder: string) => T): T {
  const folder = mkdtempSync(join(tmpdir(), "joedit-"));
  const remove = () => rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  let result: T;
  try {
    result = work(folder);
  } catch (error) {
    remove();
    throw error;
  }
  if (result instanceof Promise) return result.finally(remove) as T;
  remove();
  return result;
}

// Seconds as a readable timestamp: 75.5 -> "1:15.5".
export function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = (seconds - minutes * 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${rest}`;
}

// Round a number to a few decimals so JSON output stays short and readable.
export function round(value: number, decimals = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

// The nearest even number (at least 2): video sizes must be even.
export function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

// Read a media file's streams and format, in the same shape ffprobe prints (read in-process by node-av).
// Width and height are as shown: a phone video recorded upright (rotated 90°) reports a tall size.
export function probe(input: string): { streams: any[]; format: any } {
  requireFile(input);
  const av = need("node-av");
  av.Log.setLevel(av.AV_LOG_QUIET); // no stray warnings (e.g. iPhone spatial-audio tracks); errors are thrown below
  let demuxer: any;
  try {
    demuxer = av.Demuxer.openSync(input);
  } catch (error: any) {
    throw new Error(`Cannot read "${input}" as a picture, video or sound (${error.message}).`);
  }
  try {
    const streams = demuxer.streams.map((stream: any) => {
      const p = stream.codecpar;
      const rate = stream.rFrameRate ?? { num: 0, den: 1 };
      // Rotation is stored as a 3x3 matrix; the first two numbers give the angle.
      const matrix = p.getCodedSideData?.(av.AV_PKT_DATA_DISPLAYMATRIX);
      const rotation = matrix ? Math.round((-Math.atan2(matrix.readInt32LE(4), matrix.readInt32LE(0)) * 180) / Math.PI) : 0;
      const sideways = Math.abs(rotation) % 180 === 90;
      return {
        index: stream.index,
        codec_type: av.avGetMediaTypeString(p.codecType),
        codec_name: av.avGetCodecName(p.codecId),
        pix_fmt: p.codecType === av.AVMEDIA_TYPE_VIDEO ? av.avGetPixFmtName(p.format) : undefined,
        width: sideways ? p.height : p.width,
        height: sideways ? p.width : p.height,
        rotation,
        r_frame_rate: `${rate.num}/${rate.den}`,
        sample_rate: p.sampleRate ? String(p.sampleRate) : undefined,
        channels: p.channels ?? p.channelLayout?.nbChannels,
        disposition: { attached_pic: stream.disposition & av.AV_DISPOSITION_ATTACHED_PIC ? 1 : 0 },
      };
    });
    const duration = Number(demuxer.duration);
    return { streams, format: { duration: duration > 0 ? duration : undefined, format_name: demuxer.formatName } };
  } finally {
    demuxer.closeSync();
  }
}

// ---------- Frames: raw pixels in and out ----------
// Native drawing (Skia), GPU effects (raylib) and AI models work on raw RGBA pixels:
// 4 bytes per pixel (red, green, blue, alpha), row after row. ffmpeg turns video into those and back.

export type Frame = { time: number; pixels: Buffer; width: number; height: number };

// Read a video's frames as RGBA pixels, one at a time (memory stays small for long videos).
// fps: take this many frames per second (default: every frame). width: scale to this width.
// width + height: exactly this size, filling the frame (the middle is kept, extra edges are cut).
// start / duration / count: only part of the video (count = at most this many frames).
// graph: an ffmpeg filter graph run first, from [0:v] to [pre] (e.g. a color grade); inputs: more files it uses ([1:v] ...).
export async function* readFrames(
  input: string,
  options: { fps?: number; width?: number; height?: number; start?: number; duration?: number; count?: number; graph?: string; inputs?: string[] } = {},
): AsyncGenerator<Frame> {
  const video = probe(input).streams.find((s) => s.codec_type === "video");
  if (!video) throw new Error(`"${input}" has no picture.`);
  const width = options.width ? Math.round(options.width / 2) * 2 : video.width;
  const height = options.height ?? (options.width ? Math.round((video.height * width) / video.width / 2) * 2 : video.height);
  const [num, den] = video.r_frame_rate.split("/").map(Number);
  const fps = options.fps ?? (den ? num / den : 30);
  const scale = options.height ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}` : `scale=${width}:${height}`;
  const filters = [...(options.fps ? [`fps=${options.fps}`] : []), scale, "format=rgba"];
  const filterArgs = options.graph
    ? ["-filter_complex", `${options.graph};[pre]${filters.join(",")}[out]`, "-map", "[out]"]
    : ["-vf", filters.join(",")];
  const child = spawn(FFMPEG, [
    "-hide_banner", "-loglevel", "error",
    ...(options.start ? ["-ss", String(options.start)] : []), "-i", input,
    ...(options.inputs ?? []).flatMap((file) => ["-i", file]),
    ...(options.duration ? ["-t", String(options.duration)] : []),
    ...(options.count ? ["-frames:v", String(options.count)] : []),
    ...filterArgs, "-f", "rawvideo", "-",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stderr.on("data", (chunk) => (errors += chunk));
  const closed = new Promise<number>((done) => child.on("close", (code) => done(code ?? 1)));
  // Pipe chunks are copied straight into the frame being filled (one copy per byte, no joining of chunks).
  const size = width * height * 4;
  let frame = Buffer.allocUnsafe(size);
  let filled = 0;
  let index = 0;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      let offset = 0;
      while (offset < chunk.length) {
        const take = Math.min(size - filled, chunk.length - offset);
        chunk.copy(frame, filled, offset, offset + take);
        filled += take;
        offset += take;
        if (filled === size) {
          yield { time: (options.start ?? 0) + index / fps, pixels: frame, width, height };
          index++;
          frame = Buffer.allocUnsafe(size);
          filled = 0;
        }
      }
    }
    if ((await closed) !== 0) throw new Error(`ffmpeg failed: ${errors.trim()}`);
  } finally {
    // Stopped early (only part of the frames were wanted): stop ffmpeg too, or it waits forever.
    if (child.exitCode === null) child.kill();
  }
}

// One frame of a video at `time` seconds, as RGBA pixels (null if there is no frame there).
export async function grabFrame(input: string, time: number, width?: number): Promise<Frame | null> {
  for await (const frame of readFrames(input, { start: time, width, count: 1 })) return frame;
  return null;
}

// Write RGBA frames into a video. Returns a writer: await write(pixels) for every frame, then await finish().
// audio: a sound file to mux in. The encoder settings come from the output's extension (see videoEncoder).
export function writeVideo(output: string, options: { width: number; height: number; fps: number; audio?: string; transparent?: boolean; draft?: boolean }) {
  const { width, height, fps } = options;
  const child = spawn(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps), "-i", "-",
    // Only the first sound track (iPhones add a second, spatial one that other tools can't play).
    ...bt709([
      // Working copies (.mkv) keep the sound uncompressed, so it is only compressed once, in the finished file.
      ...(options.audio ? ["-i", options.audio, "-map", "0:v", "-map", "1:a:0?", ...(output.endsWith(".mkv") ? ["-c:a", "pcm_s16le"] : ["-c:a", "aac", "-b:a", "192k"]), "-shortest"] : []),
      ...videoEncoder(output, { transparent: options.transparent, draft: options.draft }),
      output,
    ]),
  ], { stdio: ["pipe", "ignore", "pipe"] });
  let errors = "";
  child.stderr.on("data", (chunk) => (errors += chunk));
  const closed = new Promise<number>((done) => child.on("close", (code) => done(code ?? 1)));
  child.stdin.on("error", () => {}); // a failed encoder is reported by finish()
  return {
    async write(pixels: Buffer | Uint8Array | Uint8ClampedArray): Promise<void> {
      if (!child.stdin.write(pixels)) await new Promise((done) => child.stdin.once("drain", done));
    },
    async finish(): Promise<void> {
      child.stdin.end();
      if ((await closed) !== 0) throw new Error(`ffmpeg failed: ${errors.trim()}`);
    },
  };
}

// Encoder settings for an output file. Transparent .mov is ProRes 4444, transparent .webm is VP9 with alpha;
// .gif makes its own palette; everything else is H.264 (draft: fast and small; else high quality).
// .mkv is a working copy for more editing (movie render's scenes): near-lossless and about 6x faster to write.
export function videoEncoder(output: string, options: { transparent?: boolean; draft?: boolean } = {}): string[] {
  const type = output.split(".").pop()?.toLowerCase();
  if (type === "gif") return ["-vf", "split[a][b];[a]palettegen[p];[b][p]paletteuse", "-loop", "0"];
  if (type === "mov" && options.transparent) return ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"];
  if (type === "webm") return ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30", "-pix_fmt", options.transparent ? "yuva420p" : "yuv420p"];
  if (type === "png") return ["-frames:v", "1"];
  const [preset, crf] = options.draft ? ["ultrafast", "28"] : type === "mkv" ? ["ultrafast", "8"] : ["medium", "18"];
  const h264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", preset, "-crf", crf];
  // faststart lets a video start playing on the web before it has fully downloaded.
  return type === "mp4" || type === "m4v" || type === "mov" ? [...h264, "-movflags", "+faststart"] : h264;
}

// ---------- Pictures (sharp) ----------

// Save a sharp picture in the format of the output's extension. quality: 1..100 for jpg, webp and avif.
// Formats sharp cannot write (like .bmp) are converted by ffmpeg.
export async function savePicture(image: any, output: string, quality?: number): Promise<void> {
  const type = output.split(".").pop()?.toLowerCase() ?? "";
  if (type === "jpg" || type === "jpeg") image = image.flatten({ background: "#ffffff" }).jpeg({ quality: quality || 90, mozjpeg: true });
  else if (type === "png") image = image.png();
  else if (type === "webp") image = image.webp({ quality: quality || 90 });
  else if (type === "avif") image = image.avif({ quality: quality || 60 });
  else if (type === "tif" || type === "tiff") image = image.tiff();
  else if (type === "gif") image = image.gif();
  else {
    await withTempDir(async (folder) => {
      const png = join(folder, "picture.png");
      await image.png().toFile(png);
      ffmpeg(["-i", png, output]);
    });
    return;
  }
  await image.toFile(output);
}

// Open a picture with sharp, turned upright (phone photos store their rotation separately).
// iPhone photos (.heic, .heif) are decoded by ffmpeg first: sharp's ready-made build cannot read them.
export async function openPicture(input: string): Promise<any> {
  requireFile(input);
  if (/\.(mp4|mov|m4v|webm|mkv|avi|mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(input)) {
    throw new Error(`"${input}" is a video or sound file, not a picture. Use the video commands (same names), or take a still first: node joedit.ts video frame <video> still.png --time S`);
  }
  if (/\.(heic|heif)$/i.test(input)) {
    const png = execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-i", input, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"], {
      maxBuffer: 1024 * 1024 * 1024,
    });
    return need("sharp")(png);
  }
  return need("sharp")(input).autoOrient();
}

// ---------- Drawing (Skia, via @napi-rs/canvas) ----------
// Skia draws text, titles, captions and labels natively: fast, with color emoji, strokes and shadows.

let canvasLibrary: any;

// Load Skia with joEdit's fonts registered under their family names (system fonts work too).
export async function skia(): Promise<any> {
  if (canvasLibrary) return canvasLibrary;
  canvasLibrary = need("@napi-rs/canvas");
  for (const [file, family] of Object.entries(FONT_FAMILIES)) {
    const path = join(FONTS, file);
    if (existsSync(path)) canvasLibrary.GlobalFonts.registerFromPath(path, family);
  }
  return canvasLibrary;
}

export type TextStyle = {
  size?: number; // font size in pixels (default 48)
  font?: string; // font family, e.g. "Inter", "Bebas Neue", "Georgia" (default Inter)
  weight?: number | string; // 100..900 or "bold" (default 700)
  italic?: boolean;
  color?: string; // fill color (default white)
  stroke?: string; // outline color
  strokeWidth?: number; // outline thickness in pixels (default size / 8)
  shadow?: number; // soft shadow blur in pixels
  shadowColor?: string; // default half-black
  box?: string; // color of a rounded box behind the text, e.g. "#000000AA"
  padding?: number; // space inside the box (default size / 3)
  align?: "left" | "center" | "right";
  maxWidth?: number; // wrap lines longer than this
  lineHeight?: number; // line spacing as a multiple of size (default 1.2)
  letterSpacing?: number; // extra pixels between letters
};

// The text style flags of picture text and video text, and how they become a TextStyle.
export const TEXT_FLAGS = "[--size 32] [--color white] [--font Inter] [--weight 700] [--stroke black] [--stroke-width N] [--shadow N] [--box \"#000000AA\"] [--align left|center|right] [--max-width N]";

export function textStyle(a: Args, size = 32): TextStyle {
  const number = (name: string) => (a.flags[name] === undefined ? undefined : numberFlag(a, name));
  return {
    size: number("size") ?? size,
    color: a.flags.color,
    font: a.flags.font,
    weight: a.flags.weight,
    stroke: a.flags.stroke,
    strokeWidth: number("stroke-width"),
    shadow: number("shadow"),
    box: a.flags.box,
    align: a.flags.align as TextStyle["align"],
    maxWidth: number("max-width"),
  };
}

// Split text into lines that fit maxWidth (words are never cut).
function wrapLines(ctx: any, text: string, maxWidth?: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!maxWidth) {
      lines.push(paragraph);
      continue;
    }
    let line = "";
    for (const word of paragraph.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

// Set the canvas font for a style.
export function setFont(ctx: any, style: TextStyle): void {
  ctx.font = `${style.italic ? "italic " : ""}${style.weight ?? 700} ${style.size ?? 48}px "${style.font ?? "Inter"}"`;
  ctx.letterSpacing = `${style.letterSpacing ?? 0}px`;
}

// The size of a block of text (with its box padding) before drawing it.
export function measureText(ctx: any, text: string, style: TextStyle = {}): { width: number; height: number; lines: string[] } {
  setFont(ctx, style);
  const size = style.size ?? 48;
  const lines = wrapLines(ctx, text, style.maxWidth);
  const pad = style.box ? (style.padding ?? size / 3) : 0;
  const stroke = style.stroke ? (style.strokeWidth ?? size / 8) : 0;
  const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) + 2 * pad + stroke;
  const height = (lines.length - 1) * size * (style.lineHeight ?? 1.2) + size * 1.15 + 2 * pad + stroke;
  return { width, height, lines };
}

// Draw a block of text. (x, y) is the top of the block, and its left edge, centre or right edge
// depending on align. Returns the block's size.
export function drawText(ctx: any, text: string, x: number, y: number, style: TextStyle = {}): { width: number; height: number } {
  const size = style.size ?? 48;
  const align = style.align ?? "left";
  const { width, height, lines } = measureText(ctx, text, style);
  const left = align === "center" ? x - width / 2 : align === "right" ? x - width : x;
  const pad = style.box ? (style.padding ?? size / 3) : 0;
  const strokeWidth = style.stroke ? (style.strokeWidth ?? size / 8) : 0;
  ctx.save();
  if (style.box) {
    ctx.fillStyle = style.box;
    ctx.beginPath();
    ctx.roundRect(left, y, width, height, Math.min(pad, size / 3));
    ctx.fill();
  }
  ctx.textBaseline = "top";
  ctx.textAlign = align;
  ctx.lineJoin = "round";
  const anchor = align === "center" ? left + width / 2 : align === "right" ? left + width - pad - strokeWidth / 2 : left + pad + strokeWidth / 2;
  lines.forEach((line, n) => {
    const lineY = y + pad + strokeWidth / 2 + n * size * (style.lineHeight ?? 1.2) + size * 0.05;
    // The shadow goes with the first thing drawn only, so it is not doubled.
    ctx.shadowColor = style.shadowColor ?? "rgba(0,0,0,0.5)";
    ctx.shadowBlur = style.shadow ?? 0;
    if (strokeWidth) {
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = strokeWidth;
      ctx.strokeText(line, anchor, lineY);
      ctx.shadowBlur = 0;
    }
    ctx.fillStyle = style.color ?? "#FFFFFF";
    ctx.fillText(line, anchor, lineY);
  });
  ctx.restore();
  return { width, height };
}

// A canvas holding a picture file (any format sharp reads).
export async function pictureCanvas(input: string): Promise<{ canvas: any; ctx: any; width: number; height: number }> {
  const { createCanvas, ImageData } = await skia();
  const { data, info } = await (await openPicture(input)).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true }); // always RGBA, even for grey pictures
  const canvas = createCanvas(info.width, info.height);
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height), 0, 0);
  return { canvas, ctx, width: info.width, height: info.height };
}

// Save a canvas as a picture file (any format: png, jpg, webp, avif ...).
export async function saveCanvas(canvas: any, output: string, quality?: number): Promise<void> {
  const sharp = need("sharp");
  const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  await savePicture(sharp(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.length), { raw: { width: canvas.width, height: canvas.height, channels: 4 } }), output, quality);
}

// Turn ["a.png", "--width", "100"] into { positional: ["a.png"], flags: { width: "100" } }.
export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item.startsWith("--") && item.includes("=")) {
      // --width=100 works the same as --width 100.
      const [name, ...value] = item.slice(2).split("=");
      flags[name] = value.join("=");
    } else if (item.startsWith("--")) {
      const name = item.slice(2);
      const next = argv[i + 1];
      // A flag with no value (or followed by another flag) counts as "true".
      if (next === undefined || next.startsWith("--")) {
        flags[name] = "true";
      } else {
        flags[name] = next;
        i++;
      }
    } else {
      positional.push(item);
    }
  }
  return { positional, flags };
}

// Throw if the file does not exist.
export function requireFile(path: string | undefined): string {
  if (!path) throw new Error("Missing file path.");
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  return path;
}

// Get the input and output paths (first two positional values).
export function inOut(args: Args): { input: string; output: string } {
  const input = requireFile(args.positional[0]);
  const output = args.positional[1];
  if (!output) throw new Error("Missing output path.");
  return { input, output };
}

// Read a required numeric flag.
export function numberFlag(args: Args, name: string): number {
  const value = args.flags[name];
  if (value === undefined) throw new Error(`Missing --${name}.`);
  const number = Number(value);
  if (Number.isNaN(number)) throw new Error(`--${name} must be a number, got "${value}".`);
  return number;
}

// Read an optional numeric flag, using `fallback` when it is not given.
export function optionalNumberFlag(args: Args, name: string, fallback: number): number {
  return args.flags[name] === undefined ? fallback : numberFlag(args, name);
}

// Read a required text flag.
export function stringFlag(args: Args, name: string): string {
  const value = args.flags[name];
  if (value === undefined || value === "true") throw new Error(`Missing --${name}.`);
  return value;
}

// The closest name to a typo ("trimm" → "trim"), or undefined when nothing is close.
export function closest(word: string, names: string[]): string | undefined {
  // Edit distance: how many letters to add, remove or change to turn one word into the other.
  const distance = (a: string, b: string) => {
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      row = next;
    }
    return row[b.length];
  };
  const ranked = names.map((name) => ({ name, d: distance(word.toLowerCase(), name.toLowerCase()) })).sort((x, y) => x.d - y.d);
  const best = ranked[0];
  return best && best.d <= Math.max(2, Math.floor(word.length / 3)) ? best.name : undefined;
}

// Facts about a media file that was just made, so the result shows what came out without another command.
function describeMade(file: string): Record<string, unknown> | undefined {
  if (!/\.(mp4|mov|m4v|mkv|webm|gif|avi|mp3|wav|m4a|aac|flac|ogg|opus|png|jpe?g|webp|tiff?|bmp)$/i.test(file)) return undefined;
  if (!existsSync(file) || !statSync(file).isFile()) return undefined;
  try {
    const { streams, format } = probe(file);
    const picture = streams.find((s: any) => s.codec_type === "video");
    const sound = streams.some((s: any) => s.codec_type === "audio");
    const still = /\.(png|jpe?g|webp|tiff?|bmp)$/i.test(file);
    const made: Record<string, unknown> = {};
    if (!still && format.duration) made.duration = round(Number(format.duration));
    if (picture) Object.assign(made, { width: picture.width, height: picture.height });
    if (!still) made.hasAudio = sound;
    const bytes = statSync(file).size;
    made.size = bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${round(bytes / 1024 / 1024, 1)} MB`;
    return made;
  } catch {
    return undefined;
  }
}

// Run the command named in argv[0], or print help. Exits with code 1 on error.
// On success it prints one line of JSON, e.g. {"ok":true,"output":"out.mp4","made":{"duration":8,...}}.
// For commands whose usage has an <output...> argument (always the last file):
//   - "output" is added to the result, plus "made": the length, size and sound of the new file;
//   - missing folders in the output path are created;
//   - the output may be the same file as the input: the edit goes to a temporary file that then replaces it.
// Flags not in the usage are refused (with a suggestion), so a typo never fails silently.
export async function runCli(title: string, commands: Record<string, Command>, argv: string[]): Promise<void> {
  const [name, ...given] = argv;
  // --background (anywhere, for any command) runs the command as a job and answers at once with its id.
  const background = given.includes("--background");
  const rest = given.filter((item) => item !== "--background");
  const command = name ? commands[name] : undefined;
  if (!command) {
    if (name && name !== "help") {
      const guess = closest(name, Object.keys(commands));
      console.error(`Unknown command: ${name}.${guess ? ` Did you mean "${guess}"?` : ""}\n`);
    }
    console.log(`${title}\n\nCommands:`);
    for (const c of Object.values(commands)) console.log(`  ${c.usage}`);
    process.exitCode = name && name !== "help" ? 1 : 0;
    return;
  }
  const args = parseArgs(rest);
  if (args.flags.help !== undefined) {
    console.log(`Usage: ${command.usage}`);
    return;
  }
  const producesFile = command.usage.includes("<output");
  const output = producesFile ? args.positional[args.positional.length - 1] : undefined;
  let temporary: string | undefined;
  try {
    // Refuse flags this command does not have.
    const known = new Set([...command.usage.matchAll(/--([A-Za-z][\w-]*)/g)].map((m) => m[1]));
    for (const flag of Object.keys(args.flags)) {
      if (known.has(flag)) continue;
      const guess = closest(flag, [...known]);
      const all = known.size ? ` This command's flags: ${[...known].map((k) => `--${k}`).join(" ")}` : " This command has no flags.";
      throw new Error(`Unknown flag --${flag}.${guess ? ` Did you mean --${guess}?` : ""}${all}`);
    }
    if (background) {
      // The same command line again (area included, e.g. "music song ..."), without --background.
      console.log(JSON.stringify({ ok: true, ...startJob([process.argv[1], ...process.argv.slice(2).filter((item) => item !== "--background")]) }));
      return;
    }
    if (output) {
      mkdirSync(dirname(resolve(output)), { recursive: true });
      // Editing a file in place: write to a temporary file next to it, then swap.
      const inputs = args.positional.slice(0, -1).map((p) => resolve(p));
      if (inputs.includes(resolve(output))) {
        temporary = join(dirname(output), `.joedit-${Date.now()}-${basename(output)}`);
        args.positional[args.positional.length - 1] = temporary;
      }
    }
    const result = (await command.run(args)) ?? {};
    if (temporary && existsSync(temporary)) renameSync(temporary, output!);
    const made = output ? describeMade(output) : undefined;
    const answer = { ok: true, ...(output ? { output } : {}), ...result, ...(made ? { made } : {}) };
    finishJob({ state: "done", result: answer });
    console.log(JSON.stringify(answer));
  } catch (error: any) {
    if (temporary && existsSync(temporary)) rmSync(temporary, { force: true });
    finishJob({ state: "failed", error: error.message });
    console.error(`Error: ${error.message}`);
    console.error(`Usage: ${command.usage}`);
    process.exitCode = 1;
  }
}

// ---------- Background jobs ----------
// A command run with --background starts again as its own program (with JOEDIT_JOB set) and answers at once.
// Each job is a file in .jobs/<id>.json: { id, command, state: running | done | failed | cancelled, started,
// finished, progress, result (the command's JSON answer), error, pid }. `jobs list | wait | cancel` read it.

export const JOBS = join(LIB, ".jobs");
const jobFile = (id: string) => join(JOBS, `${id}.json`);

// Start a command (its node arguments) as a background job.
function startJob(nodeArgs: string[]): Result {
  mkdirSync(JOBS, { recursive: true });
  // Jobs finished over a week ago are forgotten.
  for (const name of readdirSync(JOBS)) {
    const path = join(JOBS, name);
    if (Date.now() - statSync(path).mtimeMs > 7 * 24 * 3600 * 1000) rmSync(path, { force: true });
  }
  const id = `${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 7)}`;
  const log = openSync(join(JOBS, `${id}.log`), "w");
  const child = spawn(process.execPath, nodeArgs, {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, JOEDIT_JOB: id },
    windowsHide: true,
  });
  child.unref();
  closeSync(log);
  writeJsonFile(jobFile(id), { id, command: nodeArgs.slice(1).join(" "), state: "running", started: new Date().toISOString(), pid: child.pid });
  return { job: id, state: "running", next: `node joedit.ts jobs wait ${id}` };
}

// The job this program is (when it was started with --background).
function updateJob(change: Record<string, unknown>): void {
  const id = process.env.JOEDIT_JOB;
  if (!id) return;
  const job = readJsonQuietly(jobFile(id));
  if (job && job.state === "running") writeJsonFile(jobFile(id), { ...job, ...change });
}

function finishJob(change: Record<string, unknown>): void {
  updateJob({ ...change, finished: new Date().toISOString(), progress: undefined });
}

// What a background job is doing now, e.g. "song: making 40/100, about 20 s left". Saved at most once a second.
let progressSavedAt = 0;
export function jobProgress(text: string): void {
  if (!process.env.JOEDIT_JOB || Date.now() - progressSavedAt < 1000) return;
  progressSavedAt = Date.now();
  updateJob({ progress: text });
}

// Every job, newest first. A job whose program is gone without finishing is reported as failed.
export function listJobs(): any[] {
  if (!existsSync(JOBS)) return [];
  return readdirSync(JOBS)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJsonQuietly(join(JOBS, name)))
    .filter(Boolean)
    .map((job) => (job.state === "running" && !isRunning(job.pid) ? { ...job, state: "failed", error: "it stopped without finishing (see its .log)" } : job))
    .sort((a, b) => String(b.started).localeCompare(String(a.started)));
}

export function getJob(id: string): any {
  const job = listJobs().find((j) => j.id === id);
  if (!job) throw new Error(`No job "${id}". See: node joedit.ts jobs list`);
  return job;
}

// Wait until a job finishes (or `timeout` seconds pass) and return it.
export async function waitJob(id: string, timeout = 3600): Promise<any> {
  const until = Date.now() + timeout * 1000;
  for (;;) {
    const job = getJob(id);
    if (job.state !== "running" || Date.now() > until) return job;
    await sleep(500);
  }
}

// Stop a job: its program, and any pack work it handed to a worker.
export function cancelJob(id: string): any {
  const job = getJob(id);
  if (job.state !== "running") return job;
  if (existsSync(QUEUE)) {
    // Pack jobs carry the id of the program that asked for them: tell the worker to stop, or drop a waiting request.
    for (const name of readdirSync(QUEUE).filter((n) => n.includes(`-${job.pid}-`) && /\.(json|running)$/.test(n))) {
      const base = join(QUEUE, name.replace(/\.(json|running)$/, ""));
      if (name.endsWith(".running")) writeFileSync(`${base}.cancel`, "");
      else rmSync(join(QUEUE, name), { force: true });
    }
  }
  try {
    process.kill(job.pid);
  } catch {}
  const cancelled = { ...job, state: "cancelled", finished: new Date().toISOString(), progress: undefined };
  writeJsonFile(jobFile(id), cancelled);
  return cancelled;
}

// ---------- Packs ----------
// Packs are optional AI tools (open models) that run on this computer, no API keys needed.
// Each pack is a folder in packs/ with a pyproject.toml (its Python needs) and a run.py (prints JSON).
// `uv` installs each pack into its own private environment in .packs/<name>, so packs never clash.

const PACK_RECIPES = join(LIB, "packs"); // pack recipes (part of joEdit)
const PACK_ENVIRONMENTS = join(LIB, ".packs"); // installed packs (created by `install`)

export type PackInfo = { name: string; description: string; installed: boolean };

// Every available pack, and whether it is installed.
export function listPacks(): PackInfo[] {
  if (!existsSync(PACK_RECIPES)) return [];
  return readdirSync(PACK_RECIPES)
    .filter((name) => existsSync(join(PACK_RECIPES, name, "pyproject.toml")))
    .map((name) => {
      const toml = readFileSync(join(PACK_RECIPES, name, "pyproject.toml"), "utf8");
      const description = toml.match(/^description\s*=\s*"(.*)"/m)?.[1] ?? "";
      return { name, description, installed: isPackInstalled(name) };
    });
}

// Installed = its Python environment is set up and its models were added (marked by models-ready).
function isPackInstalled(name: string): boolean {
  return existsSync(join(PACK_ENVIRONMENTS, name, "pyvenv.cfg")) && existsSync(join(PACK_ENVIRONMENTS, name, "models-ready"));
}

// The pack's recipe folder. Throws a helpful error for unknown names.
function packRecipe(name: string): string {
  const folder = join(PACK_RECIPES, name);
  if (!name || !existsSync(join(folder, "pyproject.toml"))) {
    const names = listPacks().map((p) => p.name).join(", ");
    throw new Error(`Unknown pack "${name}". Available packs: ${names}`);
  }
  return folder;
}

// The pack's environment lives in .packs/<name>, and its models in .packs/<name>/models (not in a cache elsewhere).
// Packs also get this computer's memory (JOEDIT_VRAM_GB, JOEDIT_RAM_GB) to pick their settings from.
function packEnvironment(name: string): Record<string, string> {
  const home = join(PACK_ENVIRONMENTS, name);
  const { vramGB, ramGB } = hardware();
  return { UV_PROJECT_ENVIRONMENT: home, HF_HOME: join(home, "models"), TORCH_HOME: join(home, "models"), JOEDIT_VRAM_GB: String(vramGB), JOEDIT_RAM_GB: String(ramGB) };
}

// ---------- Hardware ----------

export type Hardware = { gpu: string; vramGB: number; freeVramGB?: number; unified: boolean; ramGB: number; freeRamGB?: number; diskFreeGB: number };
let hardwareFound: Hardware | undefined;

// What this computer has for AI work: the graphics chip and its memory, RAM, and free disk where joEdit lives.
// vramGB is 0 without a usable GPU. On Apple Silicon the GPU shares the RAM (unified), so vramGB is the RAM.
// RAM matters as much as GPU memory: models wait in RAM while parts of them run on a small GPU.
export function hardware(): Hardware {
  if (hardwareFound) return hardwareFound;
  const gb = (bytes: number) => round(bytes / 1024 ** 3, 1);
  const ramGB = gb(totalmem());
  const disk = statfsSync(LIB);
  // Free RAM is left out on macOS, where it counts only never-used memory (the system frees cache as needed).
  const common = { ramGB, ...(process.platform === "darwin" ? {} : { freeRamGB: gb(freemem()) }), diskFreeGB: gb(disk.bavail * disk.bsize) };
  if (process.platform === "darwin" && process.arch === "arm64") {
    hardwareFound = { gpu: "Apple Silicon", vramGB: ramGB, unified: true, ...common };
    return hardwareFound;
  }
  // NVIDIA: "NVIDIA GeForce RTX 4060, 8188, 7421" (name, total MiB, free MiB) for the first GPU.
  let line = "";
  try {
    line = run("nvidia-smi", ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"]).trim().split("\n")[0];
  } catch {} // no NVIDIA GPU (or its driver)
  const [name, total, free] = line.split(",").map((part) => part.trim());
  hardwareFound = name && Number(total)
    ? { gpu: name, vramGB: gb(Number(total) * 1024 ** 2), freeVramGB: gb(Number(free) * 1024 ** 2), unified: false, ...common }
    : { gpu: "none found", vramGB: 0, unified: false, ...common };
  return hardwareFound;
}

// How to install uv on this system.
export const UV_INSTALL =
  process.platform === "win32" ? "winget install astral-sh.uv" : process.platform === "darwin" ? "brew install uv   (or: curl -LsSf https://astral.sh/uv/install.sh | sh)" : "curl -LsSf https://astral.sh/uv/install.sh | sh";

// Install a pack: its Python libraries, then its models (`run.py --download`). This is the only time it goes online.
// The first install can take a while (libraries and models are big).
// extra: optional models the pack adds on request (e.g. the song pack's "sft,xl"), passed as JOEDIT_EXTRA.
export function installPack(name: string, extra = ""): { pack: string; installed: boolean } {
  const folder = packRecipe(name);
  if (!hasProgram("uv")) {
    throw new Error(`Packs need uv (a Python installer). Install it with: ${UV_INSTALL}`);
  }
  const env = { ...process.env, ...packEnvironment(name), JOEDIT_EXTRA: extra };
  try {
    // Progress is shown on stderr so the person waiting can see something is happening.
    execFileSync("uv", ["sync", "--project", folder], { stdio: ["ignore", "ignore", "inherit"], env });
    execFileSync("uv", ["run", "--project", folder, "--no-sync", "python", join(folder, "run.py"), "--download"], { stdio: ["ignore", "ignore", "inherit"], env });
  } catch {
    throw new Error(`Installing the "${name}" pack failed. See the messages above.`);
  }
  writeFileSync(join(PACK_ENVIRONMENTS, name, "models-ready"), new Date().toISOString());
  return { pack: name, installed: true };
}

// ---------- Pack workers ----------
// A pack runs as a worker (packs/joedit_pack.py): it loads its models once and keeps them for 10 minutes,
// so the next song or picture skips the loading. runPack hands it a job through files in .packs/queue/ and waits.
// Only one pack's models use the GPU at a time: a worker waiting for another pack's GPU starts after it leaves.

const QUEUE = join(PACK_ENVIRONMENTS, "queue");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// True if a program with this process id is running.
export function isRunning(pid: unknown): boolean {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 only checks
    return true;
  } catch (error: any) {
    return error.code === "EPERM";
  }
}

// Write a JSON file in one step (a reader never sees half of it).
export function writeJsonFile(path: string, data: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(data));
  renameSync(temporary, path);
}

function readJsonQuietly(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined; // missing, or being written this moment
  }
}

// The pack's worker: { pid, state ("waiting for the GPU", "loading", "ready", "working"), loadSeconds }, if one is running.
// While it starts, only the id of the program that starts it (uv) is known: { starter, state: "starting" }.
export function packWorker(name: string): any {
  const worker = readJsonQuietly(join(PACK_ENVIRONMENTS, name, "worker.json"));
  return worker && isRunning(worker.pid ?? worker.starter) ? worker : undefined;
}

// Start the pack's worker unless one is running. Its messages go to .packs/<name>/worker.log.
function startWorker(name: string): void {
  if (packWorker(name)) return;
  const folder = packRecipe(name);
  const home = join(PACK_ENVIRONMENTS, name);
  const log = openSync(join(home, "worker.log"), "a");
  const offline = { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_DATASETS_OFFLINE: "1" };
  const child = spawn("uv", ["run", "--project", folder, "--no-sync", "python", join(folder, "run.py"), "--serve"], {
    detached: true, // it keeps running after this command ends
    stdio: ["ignore", log, log],
    env: { ...process.env, ...packEnvironment(name), ...offline },
    windowsHide: true,
  });
  child.unref();
  closeSync(log);
  // The worker replaces this with its own id once Python has started.
  writeJsonFile(join(home, "worker.json"), { starter: child.pid, state: "starting" });
}

// The end of a worker's log, to explain a failure.
function workerLog(name: string): string {
  try {
    return readFileSync(join(PACK_ENVIRONMENTS, name, "worker.log"), "utf8").trim().split("\n").slice(-12).join("\n");
  } catch {
    return "";
  }
}

// What a job is doing, for people waiting: "loading the models", "making 3/8, about 20 s left".
function describeProgress(worker: any, progress: any): string {
  if (!progress) return worker?.state === "ready" || !worker ? "starting" : worker.state === "working" ? "working" : `${worker.state}${worker.state === "loading" ? " the models" : ""}`;
  const step = progress.step && progress.total ? ` ${progress.step}/${progress.total}` : "";
  const left = progress.eta ? `, about ${formatSeconds(progress.eta)} left` : "";
  return `${progress.phase ?? "working"}${step}${left}`;
}
const formatSeconds = (seconds: number) => (seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds)} s`);

// Run a job in a pack (its run.py arguments) and return its JSON result. Packs run offline: their models are in .packs/.
// While it works, progress is printed to stderr every few seconds (and saved for `jobs` when this is a background job).
export async function runPack(name: string, args: string[]): Promise<any> {
  packRecipe(name);
  if (!isPackInstalled(name)) throw new Error(`The "${name}" pack is not installed (or its models are missing). Run: node joedit.ts install ${name}`);
  mkdirSync(QUEUE, { recursive: true });
  const id = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const base = join(QUEUE, id);
  writeJsonFile(`${base}.json`, { pack: name, args });
  // Ctrl+C (or `jobs cancel`) stops the pack's job too, not only this command.
  const stop = () => {
    if (existsSync(`${base}.json`)) rmSync(`${base}.json`, { force: true }); // not taken yet: never start it
    else writeFileSync(`${base}.cancel`, ""); // taken: the worker stops at its next progress report
    process.exit(130);
  };
  process.once("SIGINT", stop).once("SIGTERM", stop);
  let starts = 0;
  let said = "";
  let saidAt = 0;
  try {
    for (;;) {
      const outcome = readJsonQuietly(`${base}.result.json`);
      if (outcome) {
        rmSync(`${base}.result.json`, { force: true });
        if (!outcome.ok) throw new Error(`The ${name} pack: ${outcome.error}`);
        return outcome.result;
      }
      const worker = packWorker(name);
      if (!worker) {
        const waiting = existsSync(`${base}.json`);
        // The job was taken and its worker stopped (crashed, or ran out of memory) without an answer.
        if (!waiting && !existsSync(`${base}.result.json`)) throw new Error(`The ${name} pack stopped while working.\n${workerLog(name)}`);
        if (waiting && starts >= 2) throw new Error(`The ${name} pack could not start.\n${workerLog(name)}`);
        if (waiting) {
          startWorker(name);
          starts++;
        }
      }
      const now = describeProgress(worker, readJsonQuietly(`${base}.progress.json`));
      jobProgress(`${name}: ${now}`);
      if (now !== said && Date.now() - saidAt > 5000) {
        process.stderr.write(`${name}: ${now}\n`);
        [said, saidAt] = [now, Date.now()];
      }
      await sleep(250);
    }
  } finally {
    process.off("SIGINT", stop).off("SIGTERM", stop);
    for (const leftover of [`${base}.json`, `${base}.cancel`]) rmSync(leftover, { force: true });
  }
}

// Stop every pack worker now (frees their memory), and say which were stopped.
export function stopWorkers(): string[] {
  const stopped: string[] = [];
  for (const { name } of listPacks()) {
    const worker = packWorker(name);
    if (!worker) continue;
    try {
      process.kill(worker.pid ?? worker.starter);
      stopped.push(name);
    } catch {}
    rmSync(join(PACK_ENVIRONMENTS, name, "worker.json"), { force: true });
  }
  return stopped;
}

// ---------- AI models ----------
// Open AI models that run inside Node (Transformers.js and ONNX Runtime): no Python, no API keys, no internet.
// Models live in .models/<repo>/ inside joEdit. Each one is added once, when a task needs it, with
// `node joedit.ts install <name>`; after that every command runs fully offline.

export type AiModel = { repo: string; files: string[]; does: string; license: string };

// The files of a Whisper model (the encoder hears, the decoder writes the words).
const whisperFiles = (encoder: string) => [
  "config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json",
  `onnx/${encoder}.onnx`, "onnx/decoder_model_merged_q4.onnx",
];

export const AI_MODELS: Record<string, AiModel> = {
  whisper: {
    repo: "onnx-community/whisper-base_timestamped",
    files: whisperFiles("encoder_model"),
    does: "listen transcribe, captions: speech to text with the time of every word (~100 languages). 210 MB",
    license: "MIT",
  },
  "whisper-tiny": { repo: "onnx-community/whisper-tiny_timestamped", files: whisperFiles("encoder_model"), does: "transcribe --model tiny: fastest, rougher. 120 MB", license: "MIT" },
  "whisper-small": { repo: "onnx-community/whisper-small_timestamped", files: whisperFiles("encoder_model"), does: "transcribe --model small: more accurate. 590 MB", license: "MIT" },
  "whisper-turbo": { repo: "onnx-community/whisper-large-v3-turbo_timestamped", files: whisperFiles("encoder_model_q4"), does: "transcribe --model turbo: most accurate. 760 MB", license: "MIT" },
  kokoro: {
    repo: "onnx-community/Kokoro-82M-v1.0-ONNX",
    files: ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model.onnx"],
    does: "voice speak, movie voiceover: natural voices in English, Spanish, French, Italian and Portuguese. 330 MB",
    license: "Apache-2.0",
  },
  cutout: {
    repo: "onnx-community/BiRefNet_lite-ONNX",
    files: ["config.json", "onnx/model.onnx"],
    does: "picture cutout, video reframe --follow: remove the background. 225 MB",
    license: "MIT",
  },
  depth: {
    repo: "onnx-community/depth-anything-v2-small",
    files: ["config.json", "preprocessor_config.json", "onnx/model.onnx"],
    does: "picture depth, picture parallax: how far away everything is. 100 MB",
    license: "Apache-2.0",
  },
  vision: {
    repo: "onnx-community/siglip2-base-patch16-224-ONNX",
    files: [
      "config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json",
      "onnx/vision_model.onnx", "onnx/text_model_quantized.onnx",
    ],
    does: "look find, look index: search pictures and video by meaning (SigLIP 2). 660 MB",
    license: "Apache-2.0",
  },
  objects: {
    repo: "onnx-community/dfine_s_coco-ONNX",
    files: ["config.json", "preprocessor_config.json", "onnx/model.onnx"],
    does: "look objects, look track: find and follow 80 kinds of things (people, cars, dogs, cups ...) (D-FINE). 42 MB",
    license: "Apache-2.0",
  },
  sounds: {
    repo: "Xenova/clap-htsat-unfused",
    files: [
      "config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json",
      "onnx/audio_model.onnx", "onnx/text_model_quantized.onnx",
    ],
    does: "listen find, look index: search sounds by description (\"dog barking\", \"applause\") (CLAP). 245 MB",
    license: "Apache-2.0",
  },
  read: {
    repo: "onnx-community/Florence-2-base-ft",
    files: [
      "config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json",
      "special_tokens_map.json", "added_tokens.json", "vocab.json", "merges.txt",
      "onnx/vision_encoder.onnx", "onnx/embed_tokens.onnx", "onnx/encoder_model_q4.onnx", "onnx/decoder_model_merged_q4.onnx",
    ],
    does: "look read, look index: read the text in pictures and video, with where it is (Florence-2). 620 MB",
    license: "MIT",
  },
  speakers: {
    repo: "Xenova/wavlm-base-plus-sv",
    files: ["config.json", "preprocessor_config.json", "onnx/model.onnx"],
    does: "listen speakers: who speaks when, from voice fingerprints (WavLM). 400 MB",
    license: "MIT",
  },
  faces: {
    repo: "opencv/face_detection_yunet",
    files: ["face_detection_yunet_2023mar.onnx"],
    does: "look faces, look track --what face, video blur-faces: find faces (YuNet). 0.2 MB",
    license: "MIT",
  },
};

// The folder a model lives in.
export function modelFolder(name: string): string {
  const model = AI_MODELS[name];
  if (!model) throw new Error(`Unknown AI model "${name}". Models: ${Object.keys(AI_MODELS).join(", ")}`);
  return join(MODELS, model.repo);
}

export function isModelInstalled(name: string): boolean {
  return AI_MODELS[name].files.every((file) => existsSync(join(modelFolder(name), file)));
}

// The model's folder, or a clear message saying how to add it.
export function requireModel(name: string): string {
  if (!isModelInstalled(name)) throw new Error(`This needs the "${name}" AI model. Add it once with: node joedit.ts install ${name}`);
  return modelFolder(name);
}

export function listModels() {
  return Object.entries(AI_MODELS).map(([name, m]) => ({ name, does: m.does, license: m.license, installed: isModelInstalled(name) }));
}

// Download a file for an install (models and assets; commands never do this).
// It streams to <target>.part and only gets its real name when complete. A dropped connection
// is tried again up to 3 times, carrying on from where it stopped.
export async function download(url: string, target: string): Promise<void> {
  mkdirSync(dirname(target), { recursive: true });
  const part = `${target}.part`;
  for (let attempt = 1; ; attempt++) {
    try {
      const have = existsSync(part) ? statSync(part).size : 0;
      const response = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {} });
      if (!response.ok || !response.body) throw new Error(`the server answered ${response.status}`);
      const carryOn = have > 0 && response.status === 206; // 206 = the rest of the file
      await pipeline(Readable.fromWeb(response.body as any), createWriteStream(part, { flags: carryOn ? "a" : "w" }));
      renameSync(part, target);
      return;
    } catch (error: any) {
      if (attempt === 3) throw new Error(`Downloading ${basename(target)} failed: ${error.message}. Run the same install again to carry on.`);
      process.stderr.write(`  connection dropped (${error.message}), trying again...\n`);
    }
  }
}

// Add a model to .models/ (the only step that goes online).
export async function installModel(name: string): Promise<{ model: string; installed: boolean }> {
  const folder = modelFolder(name);
  for (const file of AI_MODELS[name].files) {
    const target = join(folder, file);
    if (existsSync(target)) continue;
    process.stderr.write(`Adding ${name}: ${file}\n`);
    await download(`https://huggingface.co/${AI_MODELS[name].repo}/resolve/main/${file}`, target);
  }
  return { model: name, installed: true };
}

// Transformers.js, set to read models only from .models/ (never from the internet).
export function transformers(): any {
  const library = need("@huggingface/transformers");
  library.env.allowRemoteModels = false;
  library.env.allowLocalModels = true;
  library.env.localModelPath = MODELS;
  return library;
}

// Load each model once per run, even when many frames or files use it.
const loadedModels = new Map<string, Promise<any>>();
export function loadModel<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (!loadedModels.has(key)) loadedModels.set(key, load());
  return loadedModels.get(key)!;
}

// One ONNX file of an installed model, ready to run with ONNX Runtime.
export function onnxModel(name: string, file = "onnx/model.onnx"): Promise<any> {
  const path = join(requireModel(name), file);
  return loadModel(`onnx:${path}`, () => need("onnxruntime-node").InferenceSession.create(path));
}

// ---------- Assets ----------
// Assets are free downloads (fonts, instrument sounds, helper programs) saved in .assets/<name>.
// Install one with: node joedit.ts install <name>

export type Asset = {
  name: string;
  description: string;
  license: string;
  files?: { url: string; path: string; unzip?: boolean }[]; // downloaded into .assets/<name>/<path> (zips are unpacked)
  command?: string[]; // or: a command that installs it into .assets/<name>
};

// Optional downloads, added only by `node joedit.ts install <name>`. (Fonts and Three.js come with joEdit in libs/.)
export const ASSET_LIST: Asset[] = [
  {
    name: "instruments",
    description: "Instrument sounds for music compose: GeneralUser GS (259 instruments) and MuseScore General (fuller orchestra, piano and drums). 72 MB.",
    license: "GeneralUser GS License v2.0 (free for any use); MuseScore General: MIT",
    files: [
      { url: "https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main/GeneralUser-GS.sf2", path: "GeneralUser-GS.sf2" },
      { url: "https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General.sf3", path: "MuseScore_General.sf3" },
    ],
  },
  {
    name: "upscaler",
    description: "Real-ESRGAN: makes pictures and video frames 2-4x bigger with AI-sharpened detail (runs on the GPU via Vulkan/Metal). 50 MB.",
    license: "BSD-3-Clause",
    files: [
      {
        url: `https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-${process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "ubuntu"}.zip`,
        path: "upscaler.zip",
        unzip: true,
      },
    ],
  },
  {
    name: "interpolator",
    description: "RIFE: invents in-between video frames with AI (smooth slow motion, 24 → 48/60 fps; runs on the GPU via Vulkan/Metal). 440 MB.",
    license: "MIT",
    files: [
      {
        url: `https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-${process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "ubuntu"}.zip`,
        path: "interpolator.zip",
        unzip: true,
      },
    ],
  },
  {
    name: "browser",
    description: "A headless Chrome for HTML pages (graphics render and still), only needed if Google Chrome or Chromium is not installed.",
    license: "BSD (Chromium)",
    command: [npx, "-y", "@puppeteer/browsers", "install", "chrome-headless-shell@stable", "--path"],
  },
];

// Font family names for the font files in the fonts asset (used by graphics pages).
export const FONT_FAMILIES: Record<string, string> = {
  "Inter.ttf": "Inter",
  "Montserrat.ttf": "Montserrat",
  "BebasNeue.ttf": "Bebas Neue",
  "PlayfairDisplay.ttf": "Playfair Display",
  "JetBrainsMono.ttf": "JetBrains Mono",
};

export function isAssetInstalled(name: string): boolean {
  const folder = join(ASSETS, name);
  return existsSync(folder) && readdirSync(folder).length > 0;
}

export function listAssets() {
  return ASSET_LIST.map((a) => ({ name: a.name, description: a.description, license: a.license, installed: isAssetInstalled(a.name) }));
}

// Download an asset into .assets/<name>.
export async function installAsset(name: string): Promise<{ asset: string; installed: boolean }> {
  const asset = ASSET_LIST.find((a) => a.name === name);
  if (!asset) throw new Error(`Unknown asset "${name}".`);
  const folder = join(ASSETS, name);
  mkdirSync(folder, { recursive: true });
  if (asset.command) {
    const [program, ...args] = asset.command;
    try {
      execFileSync(program, [...args, folder], { stdio: ["ignore", "ignore", "inherit"], shell: isWindowsScript(program) });
    } catch {
      throw new Error(`Installing "${name}" failed. See the messages above (it needs Node's npx).`);
    }
  }
  for (const file of asset.files ?? []) {
    const target = join(folder, file.path); // paths may include sub-folders
    if (!file.unzip && existsSync(target)) continue; // already here (installing again only adds what is new)
    await download(file.url, target);
    if (file.unzip) {
      // Windows 10+ has tar (it unpacks zips too); macOS and Linux have unzip.
      if (process.platform === "win32") run("tar", ["-xf", target, "-C", folder]);
      else run("unzip", ["-o", "-q", target, "-d", folder]);
      rmSync(target);
      // A zip that holds one folder: move what is inside it up, so the programs are always at .assets/<name>/.
      const inside = readdirSync(folder);
      if (inside.length === 1 && statSync(join(folder, inside[0])).isDirectory()) {
        const top = join(folder, inside[0]);
        for (const item of readdirSync(top)) renameSync(join(top, item), join(folder, item));
        rmSync(top, { recursive: true });
      }
      // Zips do not always keep the "can run" flag, so set it on the programs inside.
      for (const name of readdirSync(folder)) {
        const path = join(folder, name);
        if (!name.includes(".") && statSync(path).isFile()) chmodSync(path, 0o755);
      }
    }
  }
  return { asset: name, installed: true };
}

// Install an AI model, an asset or a pack by name.
export async function install(name: string, extra = ""): Promise<Result> {
  if (AI_MODELS[name]) return installModel(name);
  if (ASSET_LIST.some((a) => a.name === name)) return installAsset(name);
  if (!existsSync(join(PACK_RECIPES, name, "pyproject.toml"))) {
    throw new Error(
      `Nothing to install called "${name}". AI models: ${Object.keys(AI_MODELS).join(", ")}. ` +
        `Assets: ${ASSET_LIST.map((a) => a.name).join(", ")}. Packs: ${listPacks().map((p) => p.name).join(", ")}`,
    );
  }
  return installPack(name, extra);
}

// ---------- Brand kit ----------
// A brand.json file keeps colors and fonts the same across titles, captions and movies.
// Every field is optional: { "colors": { "primary": "#7C5CFF" }, "fonts": { "heading": "Bebas Neue" }, "logo": "logo.png" }

export type Brand = {
  colors: { background: string; text: string; primary: string; accent: string };
  fonts: { heading: string; body: string };
  logo?: string;
};

export const DEFAULT_BRAND: Brand = {
  colors: { background: "#0B0B0F", text: "#FFFFFF", primary: "#7C5CFF", accent: "#FFD166" },
  fonts: { heading: "Montserrat", body: "Inter" },
};

// Read a brand.json file (if given) on top of the defaults.
export function loadBrand(path?: string): Brand {
  if (!path) return DEFAULT_BRAND;
  let custom;
  try {
    custom = readJson(path);
  } catch (error: any) {
    if (error.message.startsWith("File not found")) throw error;
    throw new Error(`${error.message} Example: {"colors": {"primary": "#7C5CFF"}, "fonts": {"heading": "Montserrat"}}`);
  }
  const brand: Brand = {
    colors: { ...DEFAULT_BRAND.colors, ...custom.colors },
    fonts: { ...DEFAULT_BRAND.fonts, ...custom.fonts },
    logo: custom.logo ? join(dirname(path), custom.logo) : undefined,
  };
  return brand;
}

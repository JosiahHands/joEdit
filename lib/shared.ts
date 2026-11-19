// Shared helpers used by every joEdit module: running programs, reading arguments, the CLI,
// the native libraries (in node_modules), packs (local AI tools), assets (downloaded fonts and tools) and the brand kit.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The folder joEdit lives in, where downloaded assets go, and where AI models are kept.
export const LIB = dirname(fileURLToPath(import.meta.url));
export const ASSETS = join(LIB, ".assets");
export const MODELS = join(LIB, ".models");

// ---------- Native libraries ----------
// joEdit's engine is a set of npm libraries kept in libs/ (libs/package.json, installed by `npm install` in lib/):
// node-av (FFmpeg), sharp (pictures), @napi-rs/canvas (Skia drawing), node-web-audio-api (sound),
// @huggingface/transformers + onnxruntime-node (AI models), kokoro-js (voices) and koffi (loads raylib for GPU effects).
// They are loaded only when a command needs them, so a missing one only breaks its own commands.
export const LIBS = join(LIB, "libs");
const requireLibrary = createRequire(join(LIBS, "package.json"));

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

// Font file used when ImageMagick draws text: a system font if there is one, else a downloaded one.
export const DEFAULT_FONT =
  [
    "/System/Library/Fonts/Supplemental/Arial.ttf", // macOS
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", // Debian / Ubuntu
    "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf", // Fedora
    join(ASSETS, "fonts", "Inter.ttf"), // node joedit.ts install fonts
  ].find((path) => existsSync(path)) ?? "";

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
export function run(program: string, args: string[], env?: Record<string, string>): string {
  try {
    return execFileSync(program === "ffmpeg" ? FFMPEG : program, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024, // transcripts and analysis output can be large
      env: env ? { ...process.env, ...env } : process.env,
    });
  } catch (error: any) {
    if (error.code === "ENOENT") throw new Error(`"${program}" is not installed. Run: node joedit.ts doctor`);
    const details = (error.stderr || error.message || "").toString().trim();
    throw new Error(`${program} failed: ${details}`);
  }
}

// True if a program can be found on this computer.
export function hasProgram(program: string): boolean {
  return spawnSync("which", [program]).status === 0;
}

// Run ffmpeg quietly, always overwriting the output. Used by video.ts and sound.ts.
export function ffmpeg(args: string[]): void {
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

// The same, without waiting: other work (more scenes, Chrome renders) keeps going while ffmpeg runs.
export function ffmpegAsync(args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
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
  const option = kind === "video" ? "-vf" : "-af";
  const result = spawnSync(FFMPEG, ["-hide_banner", "-nostats", "-i", input, option, filter, "-f", "null", "-"], {
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

// Read a media file's streams and format, in the same shape ffprobe prints (read in-process by node-av).
// Width and height are as shown: a phone video recorded upright (rotated 90°) reports a tall size.
export function probe(input: string): { streams: any[]; format: any } {
  requireFile(input);
  const av = need("node-av");
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
// fps: take this many frames per second (default: every frame). width: scale down to this width.
// start / duration / count: only part of the video (count = at most this many frames).
export async function* readFrames(
  input: string,
  options: { fps?: number; width?: number; start?: number; duration?: number; count?: number } = {},
): AsyncGenerator<Frame> {
  const video = probe(input).streams.find((s) => s.codec_type === "video");
  if (!video) throw new Error(`"${input}" has no picture.`);
  const width = options.width ? Math.round(options.width / 2) * 2 : video.width;
  const height = options.width ? Math.round((video.height * width) / video.width / 2) * 2 : video.height;
  const [num, den] = video.r_frame_rate.split("/").map(Number);
  const fps = options.fps ?? (den ? num / den : 30);
  const filters = [...(options.fps ? [`fps=${options.fps}`] : []), `scale=${width}:${height}`, "format=rgba"];
  const child = spawn(FFMPEG, [
    "-hide_banner", "-loglevel", "error",
    ...(options.start ? ["-ss", String(options.start)] : []), "-i", input,
    ...(options.duration ? ["-t", String(options.duration)] : []),
    ...(options.count ? ["-frames:v", String(options.count)] : []),
    "-vf", filters.join(","), "-f", "rawvideo", "-",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stderr.on("data", (chunk) => (errors += chunk));
  const closed = new Promise<number>((done) => child.on("close", (code) => done(code ?? 1)));
  const size = width * height * 4;
  let waiting: Buffer[] = [];
  let buffered = 0;
  let index = 0;
  for await (const chunk of child.stdout) {
    waiting.push(chunk);
    buffered += chunk.length;
    while (buffered >= size) {
      const all = Buffer.concat(waiting);
      yield { time: (options.start ?? 0) + index / fps, pixels: all.subarray(0, size), width, height };
      index++;
      waiting = [all.subarray(size)];
      buffered -= size;
    }
  }
  if ((await closed) !== 0) throw new Error(`ffmpeg failed: ${errors.trim()}`);
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
    ...(options.audio ? ["-i", options.audio, "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "192k", "-shortest"] : []),
    ...videoEncoder(output, { transparent: options.transparent, draft: options.draft }),
    output,
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
export function videoEncoder(output: string, options: { transparent?: boolean; draft?: boolean } = {}): string[] {
  const type = output.split(".").pop()?.toLowerCase();
  if (type === "gif") return ["-vf", "split[a][b];[a]palettegen[p];[b][p]paletteuse", "-loop", "0"];
  if (type === "mov" && options.transparent) return ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"];
  if (type === "webm") return ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30", "-pix_fmt", options.transparent ? "yuva420p" : "yuv420p"];
  if (type === "png") return ["-frames:v", "1"];
  const h264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", options.draft ? "ultrafast" : "medium", "-crf", options.draft ? "28" : "18"];
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
export async function openPicture(input: string): Promise<any> {
  requireFile(input);
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
    const path = join(ASSETS, "fonts", file);
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
  const { data, info } = await (await openPicture(input)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
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
  const [name, ...rest] = argv;
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
    console.log(JSON.stringify({ ok: true, ...(output ? { output } : {}), ...result, ...(made ? { made } : {}) }));
  } catch (error: any) {
    if (temporary && existsSync(temporary)) rmSync(temporary, { force: true });
    console.error(`Error: ${error.message}`);
    console.error(`Usage: ${command.usage}`);
    process.exitCode = 1;
  }
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

function isPackInstalled(name: string): boolean {
  return existsSync(join(PACK_ENVIRONMENTS, name, "pyvenv.cfg"));
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

// Tells uv to put this pack's environment in .packs/<name>.
function packEnvironment(name: string): Record<string, string> {
  return { UV_PROJECT_ENVIRONMENT: join(PACK_ENVIRONMENTS, name) };
}

// Install a pack. The first install can take a few minutes (it downloads Python libraries).
export function installPack(name: string): { pack: string; installed: boolean } {
  const folder = packRecipe(name);
  if (!hasProgram("uv")) {
    throw new Error("Packs need uv (a Python installer). Install it with: brew install uv   (or: curl -LsSf https://astral.sh/uv/install.sh | sh)");
  }
  try {
    // Progress is shown on stderr so the person waiting can see something is happening.
    execFileSync("uv", ["sync", "--project", folder], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, ...packEnvironment(name) },
    });
  } catch {
    throw new Error(`Installing the "${name}" pack failed. See the messages above.`);
  }
  return { pack: name, installed: true };
}

// Run a pack's run.py with arguments and return the JSON it prints.
export function runPack(name: string, args: string[]): any {
  const folder = packRecipe(name);
  if (!isPackInstalled(name)) throw new Error(`The "${name}" pack is not installed. Run: node joedit.ts install ${name}`);
  const output = run("uv", ["run", "--project", folder, "--no-sync", "python", join(folder, "run.py"), ...args], packEnvironment(name));
  // The JSON result is always the last line printed.
  const lastLine = output.trim().split("\n").pop() ?? "";
  return JSON.parse(lastLine);
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

const GOOGLE_FONTS = "https://github.com/google/fonts/raw/main/ofl";
const THREE = "https://cdn.jsdelivr.net/npm/three@0.180.0";

export const ASSET_LIST: Asset[] = [
  {
    name: "fonts",
    description: "Free fonts for titles and captions: Inter, Montserrat, Bebas Neue, Playfair Display, JetBrains Mono.",
    license: "SIL Open Font License",
    files: [
      { url: `${GOOGLE_FONTS}/inter/Inter%5Bopsz,wght%5D.ttf`, path: "Inter.ttf" },
      { url: `${GOOGLE_FONTS}/montserrat/Montserrat%5Bwght%5D.ttf`, path: "Montserrat.ttf" },
      { url: `${GOOGLE_FONTS}/bebasneue/BebasNeue-Regular.ttf`, path: "BebasNeue.ttf" },
      { url: `${GOOGLE_FONTS}/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf`, path: "PlayfairDisplay.ttf" },
      { url: `${GOOGLE_FONTS}/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf`, path: "JetBrainsMono.ttf" },
    ],
  },
  {
    name: "instruments",
    description: "GeneralUser GS: 259 instrument sounds (piano, strings, drums, synths …) for music compose. 32 MB.",
    license: "GeneralUser GS License v2.0 (free for any use)",
    files: [{ url: "https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main/GeneralUser-GS.sf2", path: "GeneralUser-GS.sf2" }],
  },
  {
    name: "three",
    description: "Three.js 0.180 (real-time 3D for graphics pages) with the glTF model loader. 2 MB.",
    license: "MIT",
    files: [
      { url: `${THREE}/build/three.module.js`, path: "three.module.js" },
      { url: `${THREE}/build/three.core.js`, path: "three.core.js" },
      { url: `${THREE}/examples/jsm/loaders/GLTFLoader.js`, path: "addons/loaders/GLTFLoader.js" },
      { url: `${THREE}/examples/jsm/utils/BufferGeometryUtils.js`, path: "addons/utils/BufferGeometryUtils.js" },
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
    name: "browser",
    description: "A headless Chrome for graphics, only needed if Google Chrome or Chromium is not installed.",
    license: "BSD (Chromium)",
    command: ["npx", "-y", "@puppeteer/browsers", "install", "chrome-headless-shell@stable", "--path"],
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
    execFileSync(program, [...args, folder], { stdio: ["ignore", "ignore", "inherit"] });
  }
  for (const file of asset.files ?? []) {
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${file.url}`);
    const target = join(folder, file.path);
    mkdirSync(dirname(target), { recursive: true }); // paths may include sub-folders
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
    if (file.unzip) {
      run("unzip", ["-o", "-q", target, "-d", folder]);
      rmSync(target);
      // Zips do not always keep the "can run" flag, so set it on the programs inside.
      for (const name of readdirSync(folder)) {
        const path = join(folder, name);
        if (!name.includes(".") && statSync(path).isFile()) chmodSync(path, 0o755);
      }
    }
  }
  return { asset: name, installed: true };
}

// Install a pack or an asset by name.
export async function install(name: string): Promise<Result> {
  if (ASSET_LIST.some((a) => a.name === name)) return installAsset(name);
  return installPack(name);
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
  const custom = JSON.parse(readFileSync(requireFile(path), "utf8"));
  const brand: Brand = {
    colors: { ...DEFAULT_BRAND.colors, ...custom.colors },
    fonts: { ...DEFAULT_BRAND.fonts, ...custom.fonts },
    logo: custom.logo ? join(dirname(path), custom.logo) : undefined,
  };
  return brand;
}

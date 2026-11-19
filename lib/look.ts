// Sight for AI agents: turn videos into pictures you can look at.
// An agent cannot watch a video, but it can read a contact sheet.
// CLI:     node joedit.ts look <command> ...
// Library: import { sheet } from "./joEdit/look.ts"
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  AI_MODELS,
  loadModel,
  requireModel,
  transformers,
  analyze,
  drawText,
  ffmpeg,
  formatTime,
  grabFrame,
  inOut,
  measureText,
  need,
  numberFlag,
  openPicture,
  optionalNumberFlag,
  requireFile,
  round,
  runCli,
  saveCanvas,
  skia,
  type Command,
  type Frame,
} from "./shared.ts";
import * as video from "./video.ts";

// A picture to put on a board: RGBA pixels and a label.
type Tile = { pixels: Buffer; width: number; height: number; label: string };

// Lay tiles out in a grid on a dark background, each labelled underneath, with a title on top.
async function board(tiles: Tile[], columns: number, output: string, title?: string): Promise<void> {
  const { createCanvas, ImageData } = await skia();
  const gap = 8;
  const labelHeight = 22;
  const cellWidth = Math.max(...tiles.map((t) => t.width));
  const cellHeight = Math.max(...tiles.map((t) => t.height)) + labelHeight;
  const rows = Math.ceil(tiles.length / columns);
  const width = columns * cellWidth + (columns + 1) * gap;
  // The title wraps onto more lines when the grid is narrow.
  const titleStyle = { size: 16, weight: 600, align: "center" as const, maxWidth: width - 16 };
  const titleHeight = title ? measureText(createCanvas(1, 1).getContext("2d"), title, titleStyle).height + 12 : 0;
  const canvas = createCanvas(width, titleHeight + rows * cellHeight + (rows + 1) * gap);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#202020";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (title) drawText(ctx, title, width / 2, 8, titleStyle);
  tiles.forEach((tile, n) => {
    const x = gap + (n % columns) * (cellWidth + gap) + (cellWidth - tile.width) / 2;
    const y = titleHeight + gap + Math.floor(n / columns) * (cellHeight + gap);
    const pixels = new Uint8ClampedArray(tile.pixels.buffer, tile.pixels.byteOffset, tile.width * tile.height * 4);
    ctx.putImageData(new ImageData(pixels, tile.width, tile.height), Math.round(x), y);
    drawText(ctx, tile.label, x + tile.width / 2, y + tile.height + 3, { size: 14, weight: 500, align: "center" });
  });
  await saveCanvas(canvas, output);
}

// A picture file as a tile, scaled to `width`.
async function pictureTile(file: string, width: number, label: string): Promise<Tile> {
  const { data, info } = await (await openPicture(file)).resize(width).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { pixels: data, width: info.width, height: info.height, label };
}

// One frame at each time (8 read at once), as labelled tiles.
async function frameTiles(input: string, times: number[], width: number): Promise<Tile[]> {
  const frames: (Frame | null)[] = [];
  for (let i = 0; i < times.length; i += 8) frames.push(...(await Promise.all(times.slice(i, i + 8).map((t) => grabFrame(input, t, width)))));
  return frames.map((frame, n) => {
    if (!frame) throw new Error(`Could not read a frame at ${formatTime(times[n])}.`);
    return { ...frame, label: formatTime(times[n]) };
  });
}

// Grab one frame at each time and arrange them in a grid, each labelled with its timestamp.
async function frameGrid(input: string, output: string, times: number[], columns: number, width: number, title: string): Promise<void> {
  await board(await frameTiles(input, times, width), columns, output, title);
}

// Throw a helpful error if the file has no picture (for example an mp3).
function requireVideo(input: string): video.VideoInfo {
  const details = video.info(input);
  if (!details.width) throw new Error("This file has no picture. For sound, use: listen wave");
  return details;
}

// Contact sheet: `count` frames spread evenly over the whole video, in one picture.
// This is the main way for an agent to "watch" a video.
export async function sheet(input: string, output: string, count = 12, width = 320): Promise<{ times: number[] }> {
  if (count < 1) throw new Error("--count must be 1 or more.");
  const details = requireVideo(input);
  // Take each frame from the middle of its slice of the video.
  const times = Array.from({ length: count }, (_, n) => ((n + 0.5) * details.duration) / count);
  const columns = Math.ceil(Math.sqrt(count));
  const title = `${basename(input)}   ${formatTime(details.duration)}   ${details.width}x${details.height}`;
  await frameGrid(input, output, times, columns, width, title);
  return { times: times.map((t) => round(t)) };
}

// Filmstrip: `count` frames from a short part of the video, in one row.
// Use it to check a cut, a transition or a moment closely.
export async function strip(input: string, output: string, start: number, end: number, count = 8, width = 240): Promise<{ times: number[] }> {
  if (end <= start) throw new Error("--end must be bigger than --start.");
  if (count < 2) throw new Error("--count must be 2 or more.");
  const details = requireVideo(input);
  // Stay a little before the very end, where there may be no frame to read.
  const last = Math.min(end, details.duration - 0.05);
  const times = Array.from({ length: count }, (_, n) => start + (n * (last - start)) / (count - 1));
  await frameGrid(input, output, times, count, width, `${basename(input)}   ${formatTime(start)} - ${formatTime(end)}`);
  return { times: times.map((t) => round(t)) };
}

// Find the moments where the picture suddenly changes (cuts between shots).
// threshold: 0.1 (very sensitive) to 0.6 (only hard cuts).
export function scenes(input: string, threshold = 0.3): { cuts: number[]; count: number } {
  requireVideo(input);
  const log = analyze(input, "video", `select='gt(scene,${threshold})',showinfo`);
  const cuts = [...log.matchAll(/pts_time:([\d.]+)/g)].map((match) => round(Number(match[1])));
  return { cuts, count: cuts.length };
}

// Compare two pictures: saves them side by side with a third panel showing the differences in red.
// difference: 0 = identical, 1 = completely different.
export async function compare(first: string, second: string, output: string): Promise<{ difference: number; same: boolean }> {
  // Both as RGBA pixels at the first picture's size (so pictures of different sizes can be compared).
  const a = await (await openPicture(first)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = a.info;
  const b = await (await openPicture(second)).resize(width, height, { fit: "fill" }).ensureAlpha().raw().toBuffer();

  // Root-mean-square difference of red, green and blue, from 0 to 1.
  // The differences panel is the first picture faded out, with changed pixels in red.
  let sum = 0;
  const diff = Buffer.alloc(width * height * 4);
  for (let i = 0; i < a.data.length; i += 4) {
    let changed = false;
    for (let c = 0; c < 3; c++) {
      const d = a.data[i + c] - b[i + c];
      sum += d * d;
      if (Math.abs(d) > 8) changed = true;
    }
    const faded = 255 - (255 - (a.data[i] + a.data[i + 1] + a.data[i + 2]) / 3) * 0.2;
    diff.set(changed ? [230, 30, 30, 255] : [faded, faded, faded, 255], i);
  }
  const difference = round(Math.sqrt(sum / (width * height * 3)) / 255, 4);

  // Panels are shown at most 480 pixels wide.
  const scale = Math.min(1, 480 / width);
  const sharp = need("sharp");
  const panel = async (pixels: Buffer, label: string): Promise<Tile> => {
    const { data, info } = await sharp(pixels, { raw: { width, height, channels: 4 } }).resize(Math.round(width * scale)).raw().toBuffer({ resolveWithObject: true });
    return { pixels: data, width: info.width, height: info.height, label };
  };
  await board([await panel(a.data, "first"), await panel(b, "second"), await panel(diff, "differences")], 3, output);
  return { difference, same: difference < 0.01 };
}

const PICTURE_FILE = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic)$/i;
const VIDEO_FILE = /\.(mp4|mov|m4v|mkv|webm|avi)$/i;

// time: the best frame; start / end: the whole moment that matches (videos only).
export type Match = { file: string; time?: number; start?: number; end?: number; score: number };

// ---------- Meaning (SigLIP 2) ----------
// Pictures and words become vectors (lists of 768 numbers); a picture and a description that mean
// the same thing point the same way. score = sigmoid(similarity * SCALE + BIAS), SigLIP 2's own trained values.
const SIGLIP_SCALE = 112.6689;
const SIGLIP_BIAS = -16.7717;

function visionModel(): Promise<any> {
  requireModel("vision");
  const library = transformers();
  const repo = AI_MODELS.vision.repo;
  return loadModel("vision", async () => ({
    processor: await library.AutoProcessor.from_pretrained(repo),
    tokenizer: await library.AutoTokenizer.from_pretrained(repo),
    pictures: await library.SiglipVisionModel.from_pretrained(repo, { dtype: "fp32" }),
    words: await library.SiglipTextModel.from_pretrained(repo, { dtype: "q8" }),
  }));
}

// Make a vector length 1, so comparing two is just multiplying.
function unit(vector: Float32Array): Float32Array {
  let length = 0;
  for (const v of vector) length += v * v;
  length = Math.sqrt(length) || 1;
  return vector.map((v) => v / length);
}

// One vector per picture. With cacheFile, vectors are saved and reused when the same pictures are searched again.
export async function pictureVectors(pictures: string[], cacheFile?: string): Promise<Float32Array[]> {
  const names = pictures.map((p) => basename(p));
  if (cacheFile && existsSync(cacheFile)) {
    const saved = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (JSON.stringify(saved.names) === JSON.stringify(names)) {
      const all = new Float32Array(new Uint8Array(Buffer.from(saved.vectors, "base64")).buffer);
      return names.map((_, n) => all.subarray(n * saved.size, (n + 1) * saved.size));
    }
  }
  const model = await visionModel();
  const { RawImage } = transformers();
  const vectors: Float32Array[] = [];
  for (let start = 0; start < pictures.length; start += 16) {
    const batch = await Promise.all(pictures.slice(start, start + 16).map((p) => RawImage.read(p)));
    const { pooler_output } = await model.pictures(await model.processor(batch));
    const size = pooler_output.dims[1];
    for (let n = 0; n < batch.length; n++) vectors.push(unit(pooler_output.data.slice(n * size, (n + 1) * size)));
  }
  if (cacheFile && vectors.length) {
    const all = new Float32Array(vectors.length * vectors[0].length);
    vectors.forEach((v, n) => all.set(v, n * v.length));
    writeFileSync(cacheFile, JSON.stringify({ names, size: vectors[0].length, vectors: Buffer.from(all.buffer).toString("base64") }));
  }
  return vectors;
}

// The vector of a description. SigLIP 2 was trained on lowercase text padded to 64 tokens.
export async function wordsVector(text: string): Promise<Float32Array> {
  const model = await visionModel();
  const inputs = model.tokenizer([text.toLowerCase()], { padding: "max_length", max_length: 64, truncation: true });
  const { pooler_output } = await model.words(inputs);
  return unit(pooler_output.data);
}

// How well a picture matches a description, 0..1.
export function matchScore(picture: Float32Array, words: Float32Array): number {
  let similarity = 0;
  for (let i = 0; i < picture.length; i++) similarity += picture[i] * words[i];
  return 1 / (1 + Math.exp(-(similarity * SIGLIP_SCALE + SIGLIP_BIAS)));
}

// Search pictures and videos by meaning: "a dog on a beach", "close-up of hands typing" (vision model).
// input: a video, a picture or a folder of them. Videos are sampled every `every` seconds.
// Frames and their embeddings are cached in .joedit-cache/ next to the input, so the next search is fast.
export async function find(input: string, query: string, options: { top?: number; every?: number; sheet?: string } = {}) {
  requireFile(input);
  if (!query.trim()) throw new Error('Describe what to find with --query, e.g. --query "a red car".');
  const { top = 5, every = 1 } = options;
  const files = statSync(input).isDirectory()
    ? readdirSync(input).filter((name) => PICTURE_FILE.test(name) || VIDEO_FILE.test(name)).sort().map((name) => join(input, name))
    : [input];
  if (files.length === 0) throw new Error("No pictures or videos in this folder.");
  const cacheRoot = join(statSync(input).isDirectory() ? input : dirname(input), ".joedit-cache", "find");

  // Every candidate is one picture on disk: a picture file, or one frame of a video.
  const candidates: { picture: string; file: string; time?: number }[] = [];
  for (const file of files) {
    if (PICTURE_FILE.test(file)) {
      candidates.push({ picture: file, file });
      continue;
    }
    const length = video.info(file).duration;
    const key = createHash("sha256").update(`${resolve(file)}|${statSync(file).mtimeMs}|${every}`).digest("hex").slice(0, 16);
    const folder = join(cacheRoot, key);
    if (!existsSync(join(folder, "done"))) {
      mkdirSync(folder, { recursive: true });
      // One small frame from the middle of every `every` seconds.
      ffmpeg(["-i", file, "-vf", `fps=1/${every},scale=384:-2`, "-q:v", "3", join(folder, "%05d.jpg")]);
      writeFileSync(join(folder, "done"), "");
    }
    readdirSync(folder).filter((name) => name.endsWith(".jpg")).sort().forEach((name, n) => {
      const time = round((n + 0.5) * every);
      if (time < length) candidates.push({ picture: join(folder, name), file, time });
    });
  }

  mkdirSync(cacheRoot, { recursive: true });
  const cacheKey = createHash("sha256").update(candidates.map((c) => resolve(c.picture)).join("|")).digest("hex").slice(0, 16);
  const vectors = await pictureVectors(candidates.map((c) => c.picture), join(cacheRoot, `${cacheKey}.json`));
  const words = await wordsVector(query);
  const scores = vectors.map((vector) => matchScore(vector, words));

  // Best first. For a video, a match grows into a moment (start - end) over the neighbouring frames
  // that also match well, and frames inside a moment already found are skipped.
  // Matches far weaker than the best one (under a tenth of its score) are left out.
  const scored = candidates.map((c, n) => ({ ...c, n, score: scores[n] as number }));
  const best = Math.max(...scored.map((c) => c.score));
  const chosen: (typeof scored[number] & { start?: number; end?: number })[] = [];
  for (const candidate of [...scored].sort((a, b) => b.score - a.score)) {
    if (chosen.length === top || candidate.score < best * 0.1) break;
    if (candidate.time === undefined) {
      chosen.push(candidate);
      continue;
    }
    if (chosen.some((c) => c.file === candidate.file && candidate.time! >= c.start! && candidate.time! <= c.end!)) continue;
    const sameMoment = (c: (typeof scored)[number] | undefined) => c && c.file === candidate.file && c.score >= candidate.score * 0.5;
    let first = candidate.n;
    let last = candidate.n;
    while (sameMoment(scored[first - 1])) first--;
    while (sameMoment(scored[last + 1])) last++;
    chosen.push({ ...candidate, start: round(Math.max(0, scored[first].time! - every / 2)), end: round(scored[last].time! + every / 2) });
  }
  const matches: Match[] = chosen.map((c) => ({
    file: c.file,
    ...(c.time === undefined ? {} : { time: c.time, start: c.start, end: c.end }),
    score: round(c.score, 4),
  }));

  // Optional picture of the matches, best first, labelled with the file, time and score.
  if (options.sheet && chosen.length) {
    const tiles = await Promise.all(chosen.map((c) =>
      pictureTile(c.picture, 320, `${basename(c.file)}${c.time === undefined ? "" : ` ${formatTime(c.start!)}-${formatTime(c.end!)}`}  ${round(c.score, 3)}`),
    ));
    await board(tiles, Math.min(chosen.length, 5), options.sheet, query);
  }
  return { query, searched: candidates.length, matches, ...(options.sheet ? { sheet: options.sheet } : {}) };
}

// The main colors of a picture or video, biggest share first, as hex codes.
// Useful to match text, titles and brand colors to the footage. swatch: optional picture of the palette.
export async function colors(input: string, count = 6, swatch?: string) {
  requireFile(input);
  // The pixels to read: a small copy of the picture, or 6 frames from across a video.
  let pixels: Buffer[] = [];
  if (PICTURE_FILE.test(input)) {
    pixels.push(await (await openPicture(input)).resize(200, 200, { fit: "inside" }).removeAlpha().ensureAlpha().raw().toBuffer());
  } else {
    const length = requireVideo(input).duration;
    const times = Array.from({ length: 6 }, (_, n) => ((n + 0.5) * length) / 6);
    pixels = (await Promise.all(times.map((t) => grabFrame(input, t, 160)))).filter((f) => f !== null).map((f) => f!.pixels);
  }
  const points: number[][] = [];
  for (const buffer of pixels) for (let i = 0; i < buffer.length; i += 4) points.push([buffer[i], buffer[i + 1], buffer[i + 2]]);

  // k-means: start from colors far apart from each other, then move each to the average of its pixels.
  const distance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const centres: number[][] = [points[0]];
  while (centres.length < count) {
    let far = points[0];
    let best = -1;
    for (const p of points) {
      const d = Math.min(...centres.map((c) => distance(c, p)));
      if (d > best) [best, far] = [d, p];
    }
    if (best < 1) break; // fewer different colors than asked for
    centres.push(far);
  }
  let sizes: number[] = [];
  for (let step = 0; step < 10; step++) {
    const sums = centres.map(() => [0, 0, 0]);
    sizes = centres.map(() => 0);
    for (const p of points) {
      let nearest = 0;
      for (let c = 1; c < centres.length; c++) if (distance(centres[c], p) < distance(centres[nearest], p)) nearest = c;
      sizes[nearest]++;
      for (let k = 0; k < 3; k++) sums[nearest][k] += p[k];
    }
    for (let n = 0; n < centres.length; n++) if (sizes[n]) centres[n] = sums[n].map((s) => s / sizes[n]);
  }
  const hex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  // Merge colors that look the same (soft edges make near-copies) into the bigger one.
  const merged: { color: number[]; pixels: number }[] = [];
  for (const [n, c] of centres.entries()) {
    if (!sizes[n]) continue;
    const same = merged.find((m) => distance(m.color, c) < 20);
    if (same) same.pixels += sizes[n];
    else merged.push({ color: c, pixels: sizes[n] });
  }
  merged.sort((a, b) => b.pixels - a.pixels);
  const palette = merged.map((m) => ({ hex: hex(m.color), share: round(m.pixels / points.length, 3) }));

  if (swatch) {
    const tiles = palette.map((c) => {
      const tile = Buffer.alloc(160 * 120 * 4);
      const rgb = [1, 3, 5].map((i) => parseInt(c.hex.slice(i, i + 2), 16));
      for (let i = 0; i < tile.length; i += 4) tile.set([...rgb, 255], i);
      return { pixels: tile, width: 160, height: 120, label: `${c.hex}  ${Math.round(c.share * 100)}%` };
    });
    await board(tiles, tiles.length, swatch);
  }
  return { colors: palette, ...(swatch ? { swatch } : {}) };
}

export const commands: Record<string, Command> = {
  find: {
    usage: 'find <video|picture|folder> --query "what to find" [--top 5] [--every 1] [--sheet matches.png]  (needs: install vision)',
    run: (a) =>
      find(requireFile(a.positional[0]), a.flags.query ?? "", {
        top: optionalNumberFlag(a, "top", 5),
        every: optionalNumberFlag(a, "every", 1),
        sheet: a.flags.sheet,
      }),
  },
  colors: {
    usage: "colors <picture|video> [--count 6] [--swatch palette.png]",
    run: (a) => colors(requireFile(a.positional[0]), optionalNumberFlag(a, "count", 6), a.flags.swatch),
  },
  sheet: {
    usage: "sheet <video> <output.png> [--count 12] [--width 320]",
    run: (a) => {
      const { input, output } = inOut(a);
      return sheet(input, output, optionalNumberFlag(a, "count", 12), optionalNumberFlag(a, "width", 320));
    },
  },
  strip: {
    usage: "strip <video> <output.png> --start SECONDS --end SECONDS [--count 8] [--width 240]",
    run: (a) => {
      const { input, output } = inOut(a);
      return strip(
        input,
        output,
        numberFlag(a, "start"),
        numberFlag(a, "end"),
        optionalNumberFlag(a, "count", 8),
        optionalNumberFlag(a, "width", 240),
      );
    },
  },
  scenes: {
    usage: "scenes <video> [--threshold 0.1..0.6]",
    run: (a) => scenes(requireFile(a.positional[0]), optionalNumberFlag(a, "threshold", 0.3)),
  },
  compare: {
    usage: "compare <picture1> <picture2> <output.png>",
    run: (a) => {
      if (a.positional.length < 3) throw new Error("Give 2 pictures and 1 output.");
      return compare(a.positional[0], a.positional[1], a.positional[2]);
    },
  },
};

// Only run the CLI when this file is executed directly (not when imported).
if (import.meta.main) {
  runCli("joEdit look: node look.ts <command> ...", commands, process.argv.slice(2));
}

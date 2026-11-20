// Sight for AI agents: turn videos into pictures you can look at.
// An agent cannot watch a video, but it can read a contact sheet.
// CLI:     node joedit.ts look <command> ...
// Library: import { sheet } from "./joEdit/look.ts"
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  AI_MODELS,
  isModelInstalled,
  loadModel,
  onnxModel,
  pictureCanvas,
  readFrames,
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
  readJson,
  requireFile,
  round,
  runCli,
  saveCanvas,
  skia,
  type Command,
  type Frame,
} from "./shared.ts";
import * as listen from "./listen.ts";
import * as video from "./video.ts";

// A picture to put on a board: RGBA pixels and a label.
export type Tile = { pixels: Buffer; width: number; height: number; label: string };

// Lay tiles out in a grid on a dark background, each labelled underneath, with a title on top.
export async function board(tiles: Tile[], columns: number, output: string, title?: string): Promise<void> {
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
  const { data, info } = await (await openPicture(file)).resize(width).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
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
  const a = await (await openPicture(first)).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = a.info;
  const b = await (await openPicture(second)).resize(width, height, { fit: "fill" }).toColourspace("srgb").ensureAlpha().raw().toBuffer();

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
    let saved: any = {};
    try {
      saved = JSON.parse(readFileSync(cacheFile, "utf8"));
    } catch {} // a broken cache file is made again below
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
    pixels.push(await (await openPicture(input)).resize(200, 200, { fit: "inside" }).removeAlpha().toColourspace("srgb").ensureAlpha().raw().toBuffer());
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

// ---------- Things and faces ----------

// Something found in a picture or a frame: what it is, how sure (0..1), and its box in pixels of the
// original picture or video (x, y = top-left corner).
export type Thing = { label: string; score: number; x: number; y: number; width: number; height: number };

// RGB pixels (what the models want) from RGBA pixels.
function rgbFrom(rgba: Buffer | Uint8Array, width: number, height: number): Buffer {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < width * height * 4; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return rgb;
}

function objectModel(): Promise<any> {
  requireModel("objects");
  const library = transformers();
  return loadModel("objects", () => library.pipeline("object-detection", AI_MODELS.objects.repo));
}

// The 80 kinds of things the objects model knows ("person", "car", "dog", "cup" ...).
export async function objectLabels(): Promise<string[]> {
  return Object.values((await objectModel()).model.config.id2label as Record<string, string>);
}

// Things in a picture (RGB pixels), at least `min` sure. what: only these kinds.
async function detectObjects(rgb: Buffer, width: number, height: number, min: number, what?: string[]): Promise<Thing[]> {
  const detect = await objectModel();
  const found = await detect(new (transformers().RawImage)(rgb, width, height, 3), { threshold: min });
  return found
    .filter((f: any) => !what || what.includes(f.label))
    .map((f: any) => ({
      label: f.label,
      score: round(f.score, 3),
      x: round(f.box.xmin, 1),
      y: round(f.box.ymin, 1),
      width: round(f.box.xmax - f.box.xmin, 1),
      height: round(f.box.ymax - f.box.ymin, 1),
    }));
}

// How much two boxes overlap: 0 = not at all, 1 = the same box.
function overlap(a: Thing, b: Thing): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const shared = w * h;
  return shared / (a.width * a.height + b.width * b.height - shared || 1);
}

// Faces in a picture (RGB pixels), with YuNet (OpenCV's face finder). min: how sure, 0..1.
async function detectFaces(rgb: Buffer, width: number, height: number, min = 0.6): Promise<Thing[]> {
  const SIZE = 640;
  const session = await onnxModel("faces", "face_detection_yunet_2023mar.onnx");
  // YuNet looks at a 640x640 picture: scale ours to fit in the top-left corner. It wants B, G, R planes, 0..255.
  const scale = Math.min(SIZE / width, SIZE / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const small: Buffer = await need("sharp")(rgb, { raw: { width, height, channels: 3 } }).resize(w, h, { fit: "fill" }).raw().toBuffer();
  const planes = new Float32Array(3 * SIZE * SIZE);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const from = (y * w + x) * 3;
      const to = y * SIZE + x;
      planes[to] = small[from + 2];
      planes[SIZE * SIZE + to] = small[from + 1];
      planes[2 * SIZE * SIZE + to] = small[from];
    }
  }
  const ort = need("onnxruntime-node");
  const out = await session.run({ input: new ort.Tensor("float32", planes, [1, 3, SIZE, SIZE]) });
  // Every cell of three grids (8, 16 and 32 pixels apart) guesses one face: how sure, and its box.
  const faces: Thing[] = [];
  for (const step of [8, 16, 32]) {
    const columns = SIZE / step;
    const sure = out[`cls_${step}`].data;
    const there = out[`obj_${step}`].data;
    const box = out[`bbox_${step}`].data;
    for (let cell = 0; cell < sure.length; cell++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, sure[cell])) * Math.min(1, Math.max(0, there[cell])));
      if (score < min) continue;
      const cx = ((cell % columns) + box[cell * 4]) * step;
      const cy = (Math.floor(cell / columns) + box[cell * 4 + 1]) * step;
      const bw = Math.exp(box[cell * 4 + 2]) * step;
      const bh = Math.exp(box[cell * 4 + 3]) * step;
      faces.push({ label: "face", score: round(score, 3), x: round((cx - bw / 2) / scale, 1), y: round((cy - bh / 2) / scale, 1), width: round(bw / scale, 1), height: round(bh / scale, 1) });
    }
  }
  // Many cells see the same face: keep the surest box and drop the ones that overlap it.
  const kept: Thing[] = [];
  for (const face of faces.sort((a, b) => b.score - a.score)) if (kept.every((k) => overlap(k, face) < 0.3)) kept.push(face);
  return kept;
}

// Things or faces in RGB pixels. what: "face", or kinds of things (empty = all).
async function detect(rgb: Buffer, width: number, height: number, what: string[], min?: number): Promise<Thing[]> {
  if (what.includes("face")) return detectFaces(rgb, width, height, min ?? 0.6);
  return detectObjects(rgb, width, height, min ?? 0.5, what.length ? what : undefined);
}

// Check that every name in --what is something the models know.
async function checkWhat(what: string[]): Promise<void> {
  if (what.includes("face")) {
    if (what.length > 1) throw new Error('Look for faces on their own: --what face');
    return;
  }
  const known = await objectLabels();
  for (const name of what) {
    if (!known.includes(name)) throw new Error(`"${name}" is not something the objects model knows. It knows: face, ${known.join(", ")}`);
  }
}

// Draw labelled boxes on a canvas. scale: canvas pixels per original pixel. showScore: add "87%" to the label.
function drawThings(ctx: any, things: Thing[], scale: number, showScore = true): void {
  const colors = ["#FFD400", "#00E5FF", "#FF4FD8", "#7CFF4F", "#FF8A00"];
  const kinds = [...new Set(things.map((t) => t.label))];
  for (const thing of things) {
    const color = colors[kinds.indexOf(thing.label) % colors.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, ctx.canvas.width / 300);
    ctx.strokeRect(thing.x * scale, thing.y * scale, thing.width * scale, thing.height * scale);
    const size = Math.max(11, Math.round(ctx.canvas.width / 45));
    drawText(ctx, showScore ? `${thing.label} ${Math.round(thing.score * 100)}%` : thing.label, thing.x * scale, Math.max(0, thing.y * scale - size - 6), { size, weight: 700, color: "#000", box: color, padding: 3 });
  }
}

// Frames of a video every `every` seconds, scaled to at most 640 wide (enough for the models).
async function* sampleFrames(input: string, every: number): AsyncGenerator<Frame & { scale: number }> {
  const { width } = requireVideo(input);
  const size = Math.min(width, 640);
  for await (const frame of readFrames(input, { fps: 1 / every, width: size })) yield { ...frame, time: round(frame.time, 3), scale: width / frame.width };
}

// The same box measured in the original video's pixels.
function scaleThing(thing: Thing, scale: number): Thing {
  return { ...thing, x: round(thing.x * scale, 1), y: round(thing.y * scale, 1), width: round(thing.width * scale, 1), height: round(thing.height * scale, 1) };
}

// Find things (or faces) in a picture or a video.
// Picture: every thing with its box. Video: when each kind is seen (moments), how many at most, checked every `every` seconds.
// draw: a picture with the boxes drawn on (for a video, a sheet of the frames that have the most).
export async function objects(input: string, options: { what?: string[]; min?: number; every?: number; draw?: string } = {}) {
  requireFile(input);
  const what = options.what ?? [];
  await checkWhat(what);
  if (PICTURE_FILE.test(input)) {
    const { canvas, ctx, width, height } = await pictureCanvas(input);
    const rgb = rgbFrom(ctx.getImageData(0, 0, width, height).data, width, height);
    const things = await detect(rgb, width, height, what, options.min);
    if (options.draw) {
      drawThings(ctx, things, 1);
      await saveCanvas(canvas, options.draw);
    }
    return { count: things.length, things, ...(options.draw ? { draw: options.draw } : {}) };
  }
  const every = options.every ?? 1;
  const frames: { time: number; things: Thing[] }[] = [];
  const drawn: Tile[] = []; // frames with their boxes drawn on (only with draw)
  const { createCanvas, ImageData } = await skia();
  for await (const frame of sampleFrames(input, every)) {
    const found = await detect(rgbFrom(frame.pixels, frame.width, frame.height), frame.width, frame.height, what, options.min);
    frames.push({ time: frame.time, things: found.map((t) => scaleThing(t, frame.scale)) });
    if (options.draw && found.length) {
      const canvas = createCanvas(frame.width, frame.height);
      const ctx = canvas.getContext("2d");
      ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height), 0, 0);
      drawThings(ctx, found, 1);
      const small = await need("sharp")(Buffer.from(ctx.getImageData(0, 0, frame.width, frame.height).data), { raw: { width: frame.width, height: frame.height, channels: 4 } })
        .resize(320)
        .raw()
        .toBuffer({ resolveWithObject: true });
      drawn.push({ pixels: small.data, width: small.info.width, height: small.info.height, label: `${formatTime(frame.time)}  ${found.length} found` });
    }
  }
  // Moments: when each kind is in view (gaps shorter than 1.5 checks are joined).
  const seen: { label: string; most: number; moments: [number, number][] }[] = [];
  for (const label of [...new Set(frames.flatMap((f) => f.things.map((t) => t.label)))].sort()) {
    const moments: [number, number][] = [];
    let most = 0;
    for (const frame of frames) {
      const count = frame.things.filter((t) => t.label === label).length;
      most = Math.max(most, count);
      if (!count) continue;
      const last = moments.at(-1);
      if (last && frame.time - last[1] <= every * 1.5) last[1] = round(frame.time + every);
      else moments.push([frame.time, round(frame.time + every)]);
    }
    seen.push({ label, most, moments });
  }
  if (options.draw && drawn.length) {
    // Up to 12 of the frames where something was found, spread over the video.
    const tiles = drawn.length <= 12 ? drawn : Array.from({ length: 12 }, (_, k) => drawn[Math.round((k * (drawn.length - 1)) / 11)]);
    await board(tiles, Math.min(4, tiles.length), options.draw, what.length ? what.join(", ") : "everything found");
  }
  return { every, checked: frames.length, seen, ...(options.draw ? { draw: options.draw } : {}) };
}

// A box at one moment of a track.
export type TrackPoint = { time: number; x: number; y: number; width: number; height: number };

// Follow one thing through a video (the main person, the dog, a face) and save where it is every `every` seconds.
// The box path is joined across short gaps and smoothed, so it can steer crops, follow-text and blur.
// The main thing is the one seen the longest (then the biggest). Saved as JSON: { label, width, height, every, points }.
export async function track(input: string, output: string, what = "person", options: { every?: number; min?: number; draw?: string } = {}) {
  const every = options.every ?? 0.2;
  const { width, height, duration } = requireVideo(input);
  await checkWhat([what]);
  // 1. Things in every checked frame, joined into paths: each box continues the path it overlaps most.
  type Path = { points: TrackPoint[] };
  const paths: Path[] = [];
  for await (const frame of sampleFrames(input, every)) {
    const found = (await detect(rgbFrom(frame.pixels, frame.width, frame.height), frame.width, frame.height, [what], options.min)).map((t) => scaleThing(t, frame.scale));
    const used = new Set<Path>();
    for (const thing of found.sort((a, b) => b.score - a.score)) {
      let best: Path | undefined;
      let bestOverlap = 0.1;
      for (const path of paths) {
        const last = path.points.at(-1)!;
        if (used.has(path) || frame.time - last.time > 1.5) continue; // a path ends after 1.5 s unseen
        const shared = overlap({ ...last, label: what, score: 1 }, thing);
        if (shared > bestOverlap) [best, bestOverlap] = [path, shared];
      }
      const point = { time: frame.time, x: thing.x, y: thing.y, width: thing.width, height: thing.height };
      if (best) best.points.push(point);
      else paths.push((best = { points: [point] }));
      used.add(best);
    }
  }
  if (!paths.length) throw new Error(`No ${what} was found in this video. Try --min 0.3, or look first: node joedit.ts look objects ${JSON.stringify(input)}`);
  const size = (p: Path) => p.points.reduce((sum, q) => sum + q.width * q.height, 0) / p.points.length;
  const main = paths.sort((a, b) => b.points.length - a.points.length || size(b) - size(a))[0];

  // 2. A point at every check from the first sighting to the last (gaps filled in a straight line), then smoothed.
  const filled: TrackPoint[] = [];
  for (let n = 0; n < main.points.length; n++) {
    const a = main.points[n];
    filled.push(a);
    const b = main.points[n + 1];
    if (!b) break;
    const steps = Math.round((b.time - a.time) / every);
    for (let k = 1; k < steps; k++) {
      const f = k / steps;
      const mix = (key: keyof TrackPoint) => a[key] + (b[key] - a[key]) * f;
      filled.push({ time: round(a.time + k * every, 3), x: mix("x"), y: mix("y"), width: mix("width"), height: mix("height") });
    }
  }
  const points = filled.map((point, n) => {
    const near = filled.slice(Math.max(0, n - 2), n + 3); // an average of 5 checks: steady, like a camera operator
    const average = (key: keyof TrackPoint) => round(near.reduce((sum, q) => sum + q[key], 0) / near.length, 1);
    return { time: point.time, x: average("x"), y: average("y"), width: average("width"), height: average("height") };
  });
  writeFileSync(output, JSON.stringify({ label: what, width, height, every, points }, null, 1));

  // 3. Optional sheet: 8 frames along the track with its box drawn on.
  if (options.draw) {
    const chosen = Array.from({ length: Math.min(8, points.length) }, (_, k) => points[Math.round((k * (points.length - 1)) / Math.max(1, Math.min(8, points.length) - 1))]);
    const tiles = await frameTiles(input, chosen.map((p) => p.time), 320);
    const { createCanvas, ImageData } = await skia();
    const drawn = tiles.map((tile, k) => {
      const canvas = createCanvas(tile.width, tile.height);
      const ctx = canvas.getContext("2d");
      ctx.putImageData(new ImageData(new Uint8ClampedArray(tile.pixels), tile.width, tile.height), 0, 0);
      drawThings(ctx, [{ ...chosen[k], label: what, score: 1 }], tile.width / width);
      return { ...tile, pixels: Buffer.from(ctx.getImageData(0, 0, tile.width, tile.height).data) };
    });
    await board(drawn, 4, options.draw, `track: ${what}`);
  }
  const start = points[0].time;
  const end = points.at(-1)!.time;
  return { label: what, points: points.length, start, end, coverage: round((end - start + every) / Math.max(duration, every), 2), others: paths.length - 1 };
}

// Things (or faces) found every `every` seconds through a video, with boxes in the video's own pixels.
export async function thingsOverTime(input: string, what: string[], every: number, min?: number): Promise<{ time: number; things: Thing[] }[]> {
  await checkWhat(what);
  const checks: { time: number; things: Thing[] }[] = [];
  for await (const frame of sampleFrames(input, every)) {
    const found = await detect(rgbFrom(frame.pixels, frame.width, frame.height), frame.width, frame.height, what, min);
    checks.push({ time: frame.time, things: found.map((t) => scaleThing(t, frame.scale)) });
  }
  return checks;
}

// ---------- Read text (OCR) ----------

// A line of text and its box in pixels of the original picture or video.
export type TextLine = { text: string; x: number; y: number; width: number; height: number };

function readModel(): Promise<any> {
  requireModel("read");
  const library = transformers();
  const repo = AI_MODELS.read.repo;
  return loadModel("read", async () => ({
    processor: await library.AutoProcessor.from_pretrained(repo),
    model: await library.Florence2ForConditionalGeneration.from_pretrained(repo, {
      dtype: { embed_tokens: "fp32", vision_encoder: "fp32", encoder_model: "q4", decoder_model_merged: "q4" },
    }),
  }));
}

// The lines of text in RGB pixels, top to bottom, with Florence-2.
async function readLines(rgb: Buffer, width: number, height: number): Promise<TextLine[]> {
  const { processor, model } = await readModel();
  const task = "<OCR_WITH_REGION>";
  const image = new (transformers().RawImage)(rgb, width, height, 3);
  const inputs = await processor(image, processor.construct_prompts(task));
  const ids = await model.generate({ ...inputs, max_new_tokens: 512 });
  const answer = processor.post_process_generation(processor.batch_decode(ids, { skip_special_tokens: false })[0], task, image.size)[task];
  // Each line comes with 4 corners (x1, y1, ... x4, y4): keep the box around them.
  return answer.labels
    .map((label: string, n: number) => {
      const corners: number[] = answer.quad_boxes[n];
      const xs = corners.filter((_, k) => k % 2 === 0);
      const ys = corners.filter((_, k) => k % 2 === 1);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { text: label.replace(/<\/?s>|<pad>/g, "").trim(), x: round(x, 1), y: round(y, 1), width: round(Math.max(...xs) - x, 1), height: round(Math.max(...ys) - y, 1) };
    })
    .filter((line: TextLine) => line.text && line.width >= 4 && line.height >= 4) // a box too thin to hold text is a misread
    .sort((a: TextLine, b: TextLine) => a.y - b.y || a.x - b.x);
}

// Read the text in a picture or video: signs, titles, slides, screens, labels.
// Picture: every line with its box (draw: the boxes drawn on). Video: each text and when it is on screen, checked every `every` seconds.
export async function read(input: string, options: { every?: number; draw?: string } = {}) {
  requireFile(input);
  if (PICTURE_FILE.test(input)) {
    const { canvas, ctx, width, height } = await pictureCanvas(input);
    const lines = await readLines(rgbFrom(ctx.getImageData(0, 0, width, height).data, width, height), width, height);
    if (options.draw) {
      drawThings(ctx, lines.map((l) => ({ ...l, label: l.text, score: 1 })), 1, false);
      await saveCanvas(canvas, options.draw);
    }
    return { text: lines.map((l) => l.text).join("\n"), lines, ...(options.draw ? { draw: options.draw } : {}) };
  }
  if (options.draw) throw new Error("--draw works on pictures. For a video, take a frame first: node joedit.ts video frame <video> frame.png --time S");
  const every = options.every ?? 1;
  const { width, duration } = requireVideo(input);
  const until = (time: number) => round(Math.min(duration, time + every)); // a check covers until the next one
  // Text that stays on screen is one entry; it ends when a check no longer sees it.
  const texts: (TextLine & { start: number; end: number })[] = [];
  let showing = new Map<string, TextLine & { start: number; end: number }>();
  let checked = 0;
  for await (const frame of readFrames(input, { fps: 1 / every, width: Math.min(width, 1280) })) {
    checked++;
    const scale = width / frame.width;
    const time = round(frame.time, 3);
    const next = new Map<string, TextLine & { start: number; end: number }>();
    for (const line of await readLines(rgbFrom(frame.pixels, frame.width, frame.height), frame.width, frame.height)) {
      const key = line.text.toLowerCase();
      const entry = showing.get(key) ?? next.get(key);
      if (entry) entry.end = until(time);
      else {
        const box = { x: round(line.x * scale, 1), y: round(line.y * scale, 1), width: round(line.width * scale, 1), height: round(line.height * scale, 1) };
        const created = { text: line.text, ...box, start: time, end: until(time) };
        texts.push(created);
        next.set(key, created);
        continue;
      }
      next.set(key, entry);
    }
    showing = next;
  }
  return { every, checked, texts };
}

// ---------- Index: one log of all the footage ----------

const SOUND_FILE = /\.(wav|mp3|m4a|aac|flac|ogg|opus|aiff?)$/i;

// The parts of an index entry, each one switched on or off with --only.
export const INDEX_PARTS = ["cuts", "colors", "things", "faces", "text", "speech", "sounds"];

// Text worth keeping: at least 3 letters (the text model also "reads" patterns in gravel or leaves).
const looksLikeText = (text: string) => (text.match(/\p{L}/gu) ?? []).length >= 3;

// Everything joEdit can tell about one file, using the AI models that are installed.
// Guesses the models make on weak evidence are left out: text seen in only one check of a video, things seen
// in only one check, and speech in sound that is too quiet (or, with the sounds model, does not sound like speech).
async function indexFile(file: string, every: number, cache: string, parts: string[]): Promise<Record<string, any>> {
  const want = (part: string, model?: string) => parts.includes(part) && (!model || isModelInstalled(model));
  const kind = PICTURE_FILE.test(file) ? "picture" : VIDEO_FILE.test(file) ? "video" : "sound";
  const entry: Record<string, any> = { kind };
  const details = kind === "picture" ? null : video.info(file);
  if (kind === "picture") {
    const { width, height } = await (await openPicture(file)).metadata();
    Object.assign(entry, { width, height });
  } else {
    entry.duration = round(details!.duration, 2);
    if (kind === "video") Object.assign(entry, { width: details!.width, height: details!.height, fps: details!.fps });
    if (kind === "video" && want("cuts")) entry.cuts = scenes(file).cuts;
  }
  // A moment that lasts more than one check (one check alone is often a false alarm).
  const steady = (moments: [number, number][]) => moments.filter(([start, end]) => end - start > every * 1.5);
  // What it looks like.
  if (kind !== "sound") {
    if (want("colors")) entry.colors = (await colors(file, 5)).colors.map((c) => c.hex);
    if (want("things", "objects")) {
      const found: any = await objects(file, { every });
      entry.things = kind === "picture"
        ? count(found.things.map((t: Thing) => t.label))
        : found.seen.map((s: any) => ({ label: s.label, most: s.most, moments: steady(s.moments) })).filter((s: any) => s.moments.length);
    }
    if (want("faces", "faces")) {
      const found: any = await faces(file, { every });
      entry.faces = kind === "picture" ? found.count : { most: found.seen[0]?.most ?? 0, moments: steady(found.seen[0]?.moments ?? []) };
    }
    if (want("text", "read")) {
      const found: any = await read(file, { every });
      entry.text = kind === "picture"
        ? found.lines.map((l: any) => l.text).filter(looksLikeText).join("\n")
        : found.texts.filter((t: any) => looksLikeText(t.text) && t.end - t.start > every * 1.5).map((t: any) => ({ text: t.text, start: t.start, end: t.end }));
    }
  }
  // What it sounds like.
  if (kind === "sound" || details?.hasAudio) {
    entry.lufs = listen.loudness(file).lufs;
    const sounds = want("sounds", "sounds") ? await listen.soundTags(file) : undefined;
    if (sounds) entry.sounds = sounds;
    if (want("speech", "whisper")) {
      // Speech-to-text "hears" words in wind and hum, so it only runs when there can be speech.
      const heardSpeech = !sounds || sounds.some((s) => ["speech", "singing"].includes(s.label));
      if (entry.lufs < -40) entry.speech = { skipped: `too quiet for speech (${entry.lufs} LUFS)` };
      else if (!heardSpeech) entry.speech = { skipped: "no speech heard (sounds model)" };
      else {
        const words = join(cache, `${basename(file)}.words.json`);
        const said = await listen.transcribe(file, words);
        entry.speech = { language: said.language, words: said.words, text: said.text, transcript: words };
      }
    }
  }
  return entry;
}

// How many of each: ["person", "person", "dog"] -> { person: 2, dog: 1 }
function count(labels: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const label of labels) counts[label] = (counts[label] ?? 0) + 1;
  return counts;
}

// One JSON log of every picture, video and sound in a folder: size, length, cuts, colors, things, faces,
// text on screen, loudness, what is said and what can be heard. Read it to know the footage without opening each file.
// Files that did not change since the last index are not looked at again. Each AI part runs only when its model is installed.
// only: some of INDEX_PARTS (default all). Progress is printed to stderr, one line per file.
export async function index(folder: string, output?: string, options: { every?: number; only?: string[] } = {}) {
  requireFile(folder);
  if (!statSync(folder).isDirectory()) throw new Error("index looks at a folder. For one file, use look objects, look read or listen transcribe.");
  const every = options.every ?? 2;
  const parts = options.only ?? INDEX_PARTS;
  const unknown = parts.filter((p) => !INDEX_PARTS.includes(p));
  if (unknown.length) throw new Error(`Unknown part "${unknown[0]}" for --only. Parts: ${INDEX_PARTS.join(", ")}.`);
  const target = output ?? join(folder, "index.json");
  const cache = join(folder, ".joedit-cache", "index");
  mkdirSync(cache, { recursive: true });
  // Files already in the index are skipped when unchanged. A broken index.json is simply made again.
  let before: Record<string, any> = {};
  try {
    if (existsSync(target)) before = readJson(target).files ?? {};
  } catch {}
  const names = readdirSync(folder).filter((n) => PICTURE_FILE.test(n) || VIDEO_FILE.test(n) || SOUND_FILE.test(n)).sort();
  if (!names.length) throw new Error("No pictures, videos or sounds in this folder.");
  const files: Record<string, any> = {};
  let looked = 0;
  const partsKey = parts.join(",");
  for (const [n, name] of names.entries()) {
    const path = join(folder, name);
    const { size, mtimeMs } = statSync(path);
    const old = before[name];
    if (old && old.bytes === size && old.modified === Math.round(mtimeMs) && old.every === every && (old.parts ?? INDEX_PARTS.join(",")) === partsKey) {
      files[name] = old;
      continue;
    }
    looked++;
    const started = Date.now();
    process.stderr.write(`index: ${n + 1}/${names.length} ${name} ...`);
    try {
      files[name] = { bytes: size, modified: Math.round(mtimeMs), every, parts: partsKey, ...(await indexFile(path, every, cache, parts)) };
    } catch (error) {
      files[name] = { bytes: size, modified: Math.round(mtimeMs), every, parts: partsKey, error: (error as Error).message };
    }
    process.stderr.write(` ${round((Date.now() - started) / 1000, 1)}s\n`);
    writeFileSync(target, JSON.stringify({ folder: resolve(folder), files }, null, 1)); // saved after each file, so a stop loses little
  }
  writeFileSync(target, JSON.stringify({ folder: resolve(folder), files }, null, 1));
  const modelOf: Record<string, string> = { things: "objects", faces: "faces", text: "read", speech: "whisper", sounds: "sounds" };
  const missing = parts.map((p) => modelOf[p]).filter((m) => m && !isModelInstalled(m));
  return {
    output: target,
    files: names.length,
    looked,
    reused: names.length - looked,
    ...(missing.length ? { notUsed: `Models not installed (their parts are left out): ${missing.join(", ")}. Add with: node joedit.ts install <name>` } : {}),
  };
}

// Faces in a picture or video (the same as objects --what face).
export function faces(input: string, options: { min?: number; every?: number; draw?: string } = {}) {
  return objects(input, { ...options, what: ["face"] });
}

export const commands: Record<string, Command> = {
  objects: {
    usage: "objects <picture|video> [--what person,car] [--min 0.5] [--every 1] [--draw boxes.png]  (needs: install objects)",
    run: (a) =>
      objects(requireFile(a.positional[0]), {
        what: a.flags.what ? a.flags.what.split(",").map((w) => w.trim()) : undefined,
        min: a.flags.min === undefined ? undefined : numberFlag(a, "min"),
        every: optionalNumberFlag(a, "every", 1),
        draw: a.flags.draw,
      }),
  },
  faces: {
    usage: "faces <picture|video> [--min 0.6] [--every 1] [--draw boxes.png]  (needs: install faces)",
    run: (a) =>
      faces(requireFile(a.positional[0]), {
        min: a.flags.min === undefined ? undefined : numberFlag(a, "min"),
        every: optionalNumberFlag(a, "every", 1),
        draw: a.flags.draw,
      }),
  },
  index: {
    usage: "index <folder> [--output index.json] [--every 2] [--only cuts,colors,things,faces,text,speech,sounds]  (one JSON log of all the footage; uses the AI models that are installed)",
    run: (a) =>
      index(requireFile(a.positional[0]), a.flags.output, {
        every: optionalNumberFlag(a, "every", 2),
        only: a.flags.only ? a.flags.only.split(",").map((p) => p.trim()).filter(Boolean) : undefined,
      }),
  },
  read: {
    usage: "read <picture|video> [--every 1] [--draw boxes.png]  (the text in it, with boxes; video: when each text shows; needs: install read)",
    run: (a) => read(requireFile(a.positional[0]), { every: optionalNumberFlag(a, "every", 1), draw: a.flags.draw }),
  },
  track: {
    usage: "track <video> <track.json> [--what person|face|car|dog|...] [--every 0.2] [--min 0.5] [--draw track.png]  (needs: install objects or faces)",
    run: (a) => {
      const { input, output } = inOut(a);
      return track(input, output, a.flags.what ?? "person", {
        every: optionalNumberFlag(a, "every", 0.2),
        min: a.flags.min === undefined ? undefined : numberFlag(a, "min"),
        draw: a.flags.draw,
      });
    },
  },
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

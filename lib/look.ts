// Sight for AI agents: turn videos into pictures you can look at.
// An agent cannot watch a video, but it can read a contact sheet.
// CLI:     node joedit.ts look <command> ...
// Library: import { sheet } from "./joEdit/look.ts"
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  DEFAULT_FONT,
  analyze,
  ffmpeg,
  formatTime,
  inOut,
  numberFlag,
  optionalNumberFlag,
  requireFile,
  round,
  run,
  runCli,
  runPack,
  withTempDir,
  type Command,
} from "./shared.ts";
import * as picture from "./picture.ts";
import * as video from "./video.ts";

// Grab one frame at each time and arrange them in a grid, each labelled with its timestamp.
function frameGrid(input: string, output: string, times: number[], columns: number, width: number, title: string): void {
  withTempDir((folder) => {
    const labelled: string[] = [];
    times.forEach((time, n) => {
      const frame = join(folder, `frame${n}.png`);
      ffmpeg(["-ss", String(time), "-i", input, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-update", "1", frame]);
      if (!existsSync(frame)) throw new Error(`Could not read a frame at ${formatTime(time)}.`);
      labelled.push("-label", formatTime(time), frame);
    });
    run("magick", [
      "montage",
      "-font", DEFAULT_FONT,
      "-pointsize", "14",
      "-fill", "white",
      "-background", "#202020",
      ...labelled,
      "-tile", `${columns}x`,
      "-geometry", "+4+4",
      "-title", title,
      output,
    ]);
  });
}

// Throw a helpful error if the file has no picture (for example an mp3).
function requireVideo(input: string): video.VideoInfo {
  const details = video.info(input);
  if (!details.width) throw new Error("This file has no picture. For sound, use: listen wave");
  return details;
}

// Contact sheet: `count` frames spread evenly over the whole video, in one picture.
// This is the main way for an agent to "watch" a video.
export function sheet(input: string, output: string, count = 12, width = 320): { times: number[] } {
  if (count < 1) throw new Error("--count must be 1 or more.");
  const details = requireVideo(input);
  // Take each frame from the middle of its slice of the video.
  const times = Array.from({ length: count }, (_, n) => ((n + 0.5) * details.duration) / count);
  const columns = Math.ceil(Math.sqrt(count));
  const title = `${basename(input)}   ${formatTime(details.duration)}   ${details.width}x${details.height}`;
  frameGrid(input, output, times, columns, width, title);
  return { times: times.map((t) => round(t)) };
}

// Filmstrip: `count` frames from a short part of the video, in one row.
// Use it to check a cut, a transition or a moment closely.
export function strip(input: string, output: string, start: number, end: number, count = 8, width = 240): { times: number[] } {
  if (end <= start) throw new Error("--end must be bigger than --start.");
  if (count < 2) throw new Error("--count must be 2 or more.");
  const details = requireVideo(input);
  // Stay a little before the very end, where there may be no frame to read.
  const last = Math.min(end, details.duration - 0.05);
  const times = Array.from({ length: count }, (_, n) => start + (n * (last - start)) / (count - 1));
  frameGrid(input, output, times, count, width, `${basename(input)}   ${formatTime(start)} - ${formatTime(end)}`);
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
export function compare(first: string, second: string, output: string): { difference: number; same: boolean } {
  requireFile(first);
  requireFile(second);
  const { width, height } = picture.info(first);
  return withTempDir((folder) => {
    // Make the second picture the same size as the first so they can be compared.
    const resized = join(folder, "second.png");
    run("magick", [second, "-resize", `${width}x${height}!`, resized]);

    // `magick compare` exits with code 1 when the pictures differ, so it is run directly here.
    const scored = spawnSync("magick", ["compare", "-metric", "RMSE", first, resized, "null:"], { encoding: "utf8" });
    const match = scored.stderr.match(/\(([\d.e-]+)\)/);
    if (!match) throw new Error(`Could not compare the pictures: ${scored.stderr.trim()}`);
    const difference = round(Number(match[1]), 4);

    const diff = join(folder, "diff.png");
    spawnSync("magick", ["compare", first, resized, diff]);
    run("magick", [
      "montage",
      "-font", DEFAULT_FONT,
      "-pointsize", "14",
      "-fill", "white",
      "-background", "#202020",
      "-label", "first", first,
      "-label", "second", resized,
      "-label", "differences", diff,
      "-tile", "3x",
      "-geometry", "+4+4",
      output,
    ]);
    return { difference, same: difference < 0.01 };
  });
}

const PICTURE_FILE = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic)$/i;
const VIDEO_FILE = /\.(mp4|mov|m4v|mkv|webm|avi)$/i;

// time: the best frame; start / end: the whole moment that matches (videos only).
export type Match = { file: string; time?: number; start?: number; end?: number; score: number };

// Search pictures and videos by meaning: "a dog on a beach", "close-up of hands typing" (vision pack).
// input: a video, a picture or a folder of them. Videos are sampled every `every` seconds.
// Frames and their embeddings are cached in .joedit-cache/ next to the input, so the next search is fast.
export function find(input: string, query: string, options: { top?: number; every?: number; sheet?: string } = {}) {
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
  const { scores } = runPack("vision", ["--query", query, "--cache", join(cacheRoot, `${cacheKey}.npz`), ...candidates.map((c) => c.picture)]);

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
  if (options.sheet) {
    const labelled = chosen.flatMap((c) => [
      "-label", `${basename(c.file)}${c.time === undefined ? "" : ` ${formatTime(c.start!)}-${formatTime(c.end!)}`}  ${round(c.score, 3)}`, c.picture,
    ]);
    run("magick", [
      "montage", "-font", DEFAULT_FONT, "-pointsize", "14", "-fill", "white", "-background", "#202020",
      ...labelled, "-tile", `${Math.min(chosen.length, 5)}x`, "-geometry", "320x+4+4", "-title", query, options.sheet,
    ]);
  }
  return { query, searched: candidates.length, matches, ...(options.sheet ? { sheet: options.sheet } : {}) };
}

// The main colors of a picture or video, biggest share first, as hex codes.
// Useful to match text, titles and brand colors to the footage. swatch: optional picture of the palette.
export function colors(input: string, count = 6, swatch?: string) {
  requireFile(input);
  return withTempDir((folder) => {
    let source = input;
    if (!PICTURE_FILE.test(input)) {
      // A video: put 6 frames from across it side by side and read the colors of all of them.
      const length = requireVideo(input).duration;
      const frames = Array.from({ length: 6 }, (_, n) => {
        const frame = join(folder, `frame${n}.png`);
        ffmpeg(["-ss", String(((n + 0.5) * length) / 6), "-i", input, "-frames:v", "1", "-vf", "scale=240:-2", "-update", "1", frame]);
        return frame;
      }).filter((frame) => existsSync(frame));
      source = join(folder, "frames.png");
      run("magick", [...frames, "+append", source]);
    }
    // Shrink, then let ImageMagick pick `count` representative colors and count their pixels.
    const histogram = run("magick", [source, "-resize", "200x200", "-alpha", "off", "+dither", "-colors", String(count), "-format", "%c", "histogram:info:-"]);
    const found = [...histogram.matchAll(/^\s*(\d+):.*?(#[0-9A-F]{6})/gim)].map((m) => ({ hex: m[2].toUpperCase(), pixels: Number(m[1]) }));
    const total = found.reduce((sum, c) => sum + c.pixels, 0);
    // Merge colors that look the same (soft edges make near-copies) into the bigger one.
    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const distance = (a: string, b: string) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));
    const merged: typeof found = [];
    for (const c of found.sort((a, b) => b.pixels - a.pixels)) {
      const same = merged.find((m) => distance(m.hex, c.hex) < 20);
      if (same) same.pixels += c.pixels;
      else merged.push({ ...c });
    }
    const palette = merged.map((c) => ({ hex: c.hex, share: round(c.pixels / total, 3) }));
    if (swatch) {
      run("magick", [
        ...palette.flatMap((c) => ["(", "-size", "160x120", `xc:${c.hex}`, "-gravity", "south", "-background", "#202020",
          "-fill", "white", "-font", DEFAULT_FONT, "-pointsize", "16", "-splice", "0x28", "-annotate", "+0+4", c.hex, ")"]),
        "+append", swatch,
      ]);
    }
    return { colors: palette, ...(swatch ? { swatch } : {}) };
  });
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

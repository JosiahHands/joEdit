// Sight for AI agents: turn videos into pictures you can look at.
// An agent cannot watch a video, but it can read a contact sheet.
// CLI:     node joedit.ts look <command> ...
// Library: import { sheet } from "./joEdit/look.ts"
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
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

export const commands: Record<string, Command> = {
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

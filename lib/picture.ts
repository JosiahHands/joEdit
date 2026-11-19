// Picture editing, built on ImageMagick (`magick`).
// CLI:     node picture.ts <command> <input> <output> [--flags]
// Library: import { resize } from "./joEdit/picture.ts"
import {
  DEFAULT_FONT,
  ffmpeg,
  inOut,
  numberFlag,
  optionalNumberFlag,
  requireFile,
  run,
  runCli,
  stringFlag,
  type Command,
} from "./shared.ts";
import * as video from "./video.ts";

export type PictureInfo = { width: number; height: number; format: string };

// Width, height and format of a picture.
export function info(input: string): PictureInfo {
  requireFile(input);
  const text = run("magick", ["identify", "-format", "%w %h %m\n", input]);
  const [width, height, format] = text.trim().split("\n")[0].split(" ");
  return { width: Number(width), height: Number(height), format };
}

// Resize. Give width, height, or both. With one, the aspect ratio is kept.
export function resize(input: string, output: string, width?: number, height?: number): void {
  if (!width && !height) throw new Error("Give --width, --height, or both.");
  const size = width && height ? `${width}x${height}!` : width ? `${width}x` : `x${height}`;
  run("magick", [input, "-resize", size, output]);
}

// Cut out a rectangle starting at (x, y).
export function crop(input: string, output: string, x: number, y: number, width: number, height: number): void {
  run("magick", [input, "-crop", `${width}x${height}+${x}+${y}`, "+repage", output]);
}

// Rotate clockwise by any number of degrees.
export function rotate(input: string, output: string, degrees: number): void {
  run("magick", [input, "-rotate", String(degrees), output]);
}

// Mirror the picture. direction: "horizontal" (left-right) or "vertical" (top-bottom).
export function flip(input: string, output: string, direction: string): void {
  if (direction === "horizontal") run("magick", [input, "-flop", output]);
  else if (direction === "vertical") run("magick", [input, "-flip", output]);
  else throw new Error('--direction must be "horizontal" or "vertical".');
}

// Make the picture black and white.
export function grayscale(input: string, output: string): void {
  run("magick", [input, "-colorspace", "Gray", output]);
}

// Change brightness. amount: -100 (darker) to 100 (brighter).
export function brightness(input: string, output: string, amount: number): void {
  run("magick", [input, "-brightness-contrast", `${amount}x0`, output]);
}

// Change contrast. amount: -100 (less) to 100 (more).
export function contrast(input: string, output: string, amount: number): void {
  run("magick", [input, "-brightness-contrast", `0x${amount}`, output]);
}

// Blur. Bigger radius = more blur.
export function blur(input: string, output: string, radius: number): void {
  run("magick", [input, "-blur", `0x${radius}`, output]);
}

// Write text with its top-left corner at (x, y).
export function text(
  input: string,
  output: string,
  words: string,
  x = 10,
  y = 10,
  size = 32,
  color = "white",
): void {
  run("magick", [
    input,
    "-font", DEFAULT_FONT,
    "-pointsize", String(size),
    "-fill", color,
    "-gravity", "NorthWest",
    "-annotate", `+${x}+${y}`, words,
    output,
  ]);
}

export const MOTIONS = ["zoom-in", "zoom-out", "pan-left", "pan-right", "pan-up", "pan-down", "none"];

// Turn a still picture into a video with a slow camera move (the "Ken Burns" effect).
// amount: how far it zooms or pans (0.15 = 15%). The picture is cropped to fill width x height.
export function animate(
  input: string,
  output: string,
  options: { duration?: number; motion?: string; width?: number; height?: number; fps?: number; amount?: number } = {},
): { frames: number } {
  requireFile(input);
  const { duration = 5, motion = "zoom-in", width = 1920, height = 1080, fps = 30, amount = 0.15 } = options;
  const frames = Math.max(1, Math.round(duration * fps));
  // p goes from 0 to 1, starting and ending gently (ease in and out).
  const p = `(0.5-0.5*cos(PI*on/${Math.max(1, frames - 1)}))`;
  const zoomed = `${1 + amount}`;
  const center = { x: "(iw-iw/zoom)/2", y: "(ih-ih/zoom)/2" };
  const moves: Record<string, { z: string; x: string; y: string }> = {
    "zoom-in": { z: `1+${amount}*${p}`, ...center },
    "zoom-out": { z: `1+${amount}*(1-${p})`, ...center },
    "pan-left": { z: zoomed, x: `(iw-iw/zoom)*(1-${p})`, y: center.y },
    "pan-right": { z: zoomed, x: `(iw-iw/zoom)*${p}`, y: center.y },
    "pan-up": { z: zoomed, x: center.x, y: `(ih-ih/zoom)*(1-${p})` },
    "pan-down": { z: zoomed, x: center.x, y: `(ih-ih/zoom)*${p}` },
    none: { z: "1", x: "0", y: "0" },
  };
  const move = moves[motion];
  if (!move) throw new Error(`Unknown motion "${motion}". Motions: ${MOTIONS.join(", ")}`);
  // Work at 4x size so the slow movement is smooth (no 1-pixel jumps).
  const big = `scale=${width * 4}:${height * 4}:force_original_aspect_ratio=increase,crop=${width * 4}:${height * 4},setsar=1`;
  const zoompan = `zoompan=z='${move.z}':x='${move.x}':y='${move.y}':d=${frames}:s=${width}x${height}:fps=${fps}`;
  ffmpeg(["-i", input, "-vf", `${big},${zoompan},format=yuv420p`, "-frames:v", String(frames), "-c:v", "libx264", "-crf", "18", output]);
  return { frames };
}

// Change format based on the output file extension (e.g. .png -> .jpg).
export function convert(input: string, output: string, quality?: number): void {
  const options = quality ? ["-quality", String(quality)] : [];
  run("magick", [input, ...options, output]);
}

export const commands: Record<string, Command> = {
  info: {
    usage: "info <input>",
    run: (a) => info(requireFile(a.positional[0])),
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
    usage: "rotate <input> <output> --degrees N",
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
  grayscale: {
    usage: "grayscale <input> <output>",
    run: (a) => {
      const { input, output } = inOut(a);
      grayscale(input, output);
    },
  },
  brightness: {
    usage: "brightness <input> <output> --amount -100..100",
    run: (a) => {
      const { input, output } = inOut(a);
      brightness(input, output, numberFlag(a, "amount"));
    },
  },
  contrast: {
    usage: "contrast <input> <output> --amount -100..100",
    run: (a) => {
      const { input, output } = inOut(a);
      contrast(input, output, numberFlag(a, "amount"));
    },
  },
  blur: {
    usage: "blur <input> <output> --radius N",
    run: (a) => {
      const { input, output } = inOut(a);
      blur(input, output, numberFlag(a, "radius"));
    },
  },
  text: {
    usage: "text <input> <output> --text \"words\" [--x N] [--y N] [--size N] [--color name]",
    run: (a) => {
      const { input, output } = inOut(a);
      text(
        input,
        output,
        stringFlag(a, "text"),
        optionalNumberFlag(a, "x", 10),
        optionalNumberFlag(a, "y", 10),
        optionalNumberFlag(a, "size", 32),
        a.flags.color ?? "white",
      );
    },
  },
  animate: {
    usage: `animate <picture> <output.mp4> [--duration 5] [--motion ${MOTIONS.join("|")}] [--amount 0.15] [--width 1920] [--height 1080] [--fps 30]`,
    run: (a) => {
      const { input, output } = inOut(a);
      return animate(input, output, {
        duration: optionalNumberFlag(a, "duration", 5),
        motion: a.flags.motion ?? "zoom-in",
        amount: optionalNumberFlag(a, "amount", 0.15),
        width: optionalNumberFlag(a, "width", 1920),
        height: optionalNumberFlag(a, "height", 1080),
        fps: optionalNumberFlag(a, "fps", 30),
      });
    },
  },
  // Looks and effects are shared with video.ts (ffmpeg works on single pictures too).
  grade: {
    usage: "grade <input> <output> --look cinematic|teal-orange|noir|vintage|warm|cool|bleach|vivid [--strength 0..1]",
    run: (a) => {
      const { input, output } = inOut(a);
      video.grade(input, output, stringFlag(a, "look"), optionalNumberFlag(a, "strength", 1));
    },
  },
  effects: {
    usage: "effects <input> <output> [--grain 0..1] [--vignette 0..1] [--letterbox 2.39] [--glow 0..1] [--chromatic PX] [--sharpen 0..1]",
    run: (a) => {
      const { input, output } = inOut(a);
      video.effects(input, output, video.effectFlags(a));
    },
  },
  convert: {
    usage: "convert <input> <output> [--quality 1..100]",
    run: (a) => {
      const { input, output } = inOut(a);
      convert(input, output, optionalNumberFlag(a, "quality", 0));
    },
  },
};

// Only run the CLI when this file is executed directly (not when imported).
if (import.meta.main) {
  runCli("Picture editor: node picture.ts <command> ...", commands, process.argv.slice(2));
}

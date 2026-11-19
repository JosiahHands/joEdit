// Video editing, built on ffmpeg / ffprobe.
// CLI:     node video.ts <command> <input> <output> [--flags]
// Library: import { trim } from "./joEdit/video.ts"
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_FONT,
  ffmpeg,
  inOut,
  numberFlag,
  optionalNumberFlag,
  probe,
  requireFile,
  run,
  runCli,
  stringFlag,
  withTempDir,
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
  ffmpeg(["-i", input, "-i", audio, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-shortest", output]);
}

// Join videos one after another. All are scaled to the size of the first one.
// Sound is kept only if every input has sound.
export function concat(inputs: string[], output: string): void {
  if (inputs.length < 2) throw new Error("Give at least 2 inputs.");
  inputs.forEach(requireFile);
  const infos = inputs.map(info);
  const { width, height } = infos[0];
  const withAudio = infos.every((i) => i.hasAudio);

  const parts: string[] = [];
  let joined = "";
  inputs.forEach((_, n) => {
    // Make every clip the same size and frame shape so they can be joined.
    parts.push(`[${n}:v]scale=${width}:${height},setsar=1,fps=${infos[0].fps || 30}[v${n}]`);
    joined += withAudio ? `[v${n}][${n}:a]` : `[v${n}]`;
  });
  const audioCount = withAudio ? 1 : 0;
  const outLabels = withAudio ? "[v][a]" : "[v]";
  parts.push(`${joined}concat=n=${inputs.length}:v=1:a=${audioCount}${outLabels}`);

  const args = inputs.flatMap((file) => ["-i", file]);
  args.push("-filter_complex", parts.join(";"), "-map", "[v]");
  if (withAudio) args.push("-map", "[a]");
  ffmpeg([...args, output]);
}

// Save a single frame at `time` seconds as a picture.
export function frame(input: string, output: string, time: number): void {
  ffmpeg(["-ss", String(time), "-i", input, "-frames:v", "1", "-update", "1", output]);
}

// Make an animated GIF.
export function gif(input: string, output: string, fps = 10, width = 480): void {
  const base = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  // Build a color palette first so the GIF looks good.
  const filter = `${base},split[a][b];[a]palettegen[p];[b][p]paletteuse`;
  ffmpeg(["-i", input, "-filter_complex", filter, output]);
}

// Put text on the whole video with its top-left corner at (x, y).
// The text is drawn into a see-through PNG with ImageMagick, then laid over the video.
export function text(
  input: string,
  output: string,
  words: string,
  x = 10,
  y = 10,
  size = 32,
  color = "white",
): void {
  withTempDir((folder) => {
    const picture = join(folder, "text.png");
    run("magick", [
      "-background", "none",
      "-font", DEFAULT_FONT,
      "-pointsize", String(size),
      "-fill", color,
      `label:${words}`,
      picture,
    ]);
    ffmpeg(["-i", input, "-i", picture, "-filter_complex", `[0:v][1:v]overlay=${x}:${y}`, "-c:a", "copy", output]);
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
    : ["-map", "0:a?", "-c:a", "copy", "-pix_fmt", "yuv420p"];
  ffmpeg(["-i", input, "-filter_complex", graph, "-map", "[out]", ...extra, output]);
}

// Apply a color grade. strength 0..1 mixes it with the original.
export function grade(input: string, output: string, look: string, strength = 1): void {
  const filter = LOOKS[look];
  if (!filter) throw new Error(`Unknown look "${look}". Looks: ${Object.keys(LOOKS).join(", ")}`);
  const amount = Math.min(1, Math.max(0, strength));
  const graph =
    amount >= 1
      ? `[0:v]${filter}[out]`
      : `[0:v]format=gbrp,split[a][b];[b]${filter},format=gbrp[g];[a][g]blend=all_mode=normal:all_opacity=${amount}[out]`;
  applyGraph(input, output, graph);
}

export type Effects = {
  grain?: number; // 0..1 film grain
  vignette?: number; // 0..1 darker corners
  letterbox?: number; // e.g. 2.39 for black cinema bars
  glow?: number; // 0..1 soft bloom on bright parts
  chromatic?: number; // pixels of red/blue color split
  sharpen?: number; // 0..1
};

// Add film effects. Each effect is only applied if given.
export function effects(input: string, output: string, chosen: Effects): void {
  const steps: string[] = [];
  let label = "0:v";
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
  steps.push(`[${label}]null[out]`);
  applyGraph(input, output, steps.join(";"));
}

// ---------- Captions ----------

// Burn animated captions into a video. Uses a transcript from `listen transcribe`, or makes one (whisper pack).
export async function captions(
  input: string,
  output: string,
  options: { transcript?: string; style?: graphics.CaptionStyle; position?: string; model?: string; brand?: string } = {},
): Promise<{ words: number; groups: number }> {
  const details = info(input);
  if (!details.width) throw new Error("This file has no picture to put captions on.");
  return withTempDir(async (folder) => {
    let transcript = options.transcript;
    if (!transcript) {
      transcript = join(folder, "words.json");
      listen.transcribe(input, transcript, options.model ?? "base");
    }
    const words = JSON.parse(readFileSync(requireFile(transcript), "utf8")).words ?? [];
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
    });
    ffmpeg([
      "-i", input, "-i", overlay,
      "-filter_complex", "[0:v][1:v]overlay=0:0:eof_action=pass[v]",
      "-map", "[v]", "-map", "0:a?", "-c:a", "copy", "-pix_fmt", "yuv420p",
      output,
    ]);
    return { words: words.length, groups: made.groups };
  });
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
    usage: "captions <input> <output> [--transcript words.json] [--style karaoke|pop|bold|minimal] [--position bottom|center|top] [--brand brand.json]",
    run: (a) => {
      const { input, output } = inOut(a);
      return captions(input, output, {
        transcript: a.flags.transcript,
        style: a.flags.style as graphics.CaptionStyle | undefined,
        position: a.flags.position,
        model: a.flags.model,
        brand: a.flags.brand,
      });
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

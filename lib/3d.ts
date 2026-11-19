// 3D: real 3D scenes rendered by Blender (free, runs headless), from short Python scene scripts.
// A scene script uses joEdit's kit (packs/blender/kit.py): shapes, 3D text, models, materials, lights, cameras, keyframes.
// CLI:     node joedit.ts 3d <command> ...
// Library: import { render } from "./joEdit/3d.ts"
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ASSETS,
  LIB,
  ffmpeg,
  inOut,
  loadBrand,
  numberFlag,
  optionalNumberFlag,
  requireFile,
  round,
  runCli,
  withTempDir,
  type Command,
} from "./shared.ts";
import { encoderArgs } from "./graphics.ts";

// Blender: on the PATH, or in the usual app folder on macOS / Windows.
export function findBlender(): string {
  const places = [
    process.env.JOEDIT_BLENDER ?? "",
    "/Applications/Blender.app/Contents/MacOS/Blender",
    "C:\\Program Files\\Blender Foundation\\Blender\\blender.exe",
  ];
  const onPath = spawnSync("blender", ["--version"], { encoding: "utf8" });
  if (onPath.status === 0) return "blender";
  const found = places.find((place) => place && existsSync(place));
  if (!found) {
    const fix = process.platform === "darwin" ? "brew install --cask blender" : "install Blender from https://www.blender.org/download/";
    throw new Error(`3D needs Blender. Install it: ${fix}`);
  }
  return found;
}

export const ENGINES = ["eevee", "cycles"];

export type RenderOptions = {
  duration?: number; // seconds of animation (video outputs)
  frame?: number; // which frame to render for a picture output (starts at 1)
  fps?: number;
  width?: number;
  height?: number;
  engine?: string; // eevee: fast, good-looking; cycles: slower, true light (reflections, glass, soft shadows)
  samples?: number; // quality: more = cleaner and slower
  draft?: boolean; // half size and few samples, for quick checks
  transparent?: boolean; // see-through background (.png, .mov or .webm)
};

const PICTURE = /\.(png|jpe?g|webp)$/i;

// Render a scene script to a video or (for .png/.jpg outputs) one picture.
export function render(script: string, output: string, options: RenderOptions = {}) {
  requireFile(script);
  const engine = options.engine ?? "eevee";
  if (!ENGINES.includes(engine)) throw new Error(`Unknown engine "${engine}". Engines: ${ENGINES.join(", ")}`);
  const draft = options.draft ?? false;
  const fps = options.fps ?? 30;
  const still = PICTURE.test(output);
  const frames = still ? Math.max(options.frame ?? 1, 1) : Math.max(1, Math.round((options.duration ?? 4) * fps));
  const scale = draft ? 0.5 : 1;
  const even = (n: number) => Math.round((n * scale) / 2) * 2;
  const width = even(options.width ?? 1920);
  const height = even(options.height ?? 1080);
  const samples = options.samples ?? (draft ? 8 : engine === "cycles" ? 128 : 64);
  const started = Date.now();

  return withTempDir((folder) => {
    const settings = join(folder, "settings.json");
    const frameFolder = join(folder, "frames");
    writeFileSync(settings, JSON.stringify({
      script: resolve(script), folder: frameFolder, width, height, fps, frames, engine, samples,
      transparent: options.transparent ?? false, fonts: join(ASSETS, "fonts"), still: still ? frames : 0,
    }));
    const blender = spawnSync(
      findBlender(),
      ["-b", "--factory-startup", "--python-exit-code", "1", "--python", join(LIB, "packs", "blender", "run.py"), "--", settings],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    if (blender.status !== 0) {
      // Show the scene script's own error when there is one, otherwise the end of Blender's log.
      const log = `${blender.stdout}\n${blender.stderr}`;
      const scriptError = log.match(/Error in the scene script:[\s\S]*/)?.[0];
      throw new Error(scriptError ?? `Blender failed:\n${log.trim().split("\n").slice(-15).join("\n")}`);
    }
    if (still) {
      ffmpeg(["-i", join(frameFolder, "still.png"), "-frames:v", "1", "-update", "1", output]);
    } else {
      const count = readdirSync(frameFolder).filter((name) => name.endsWith(".png")).length;
      if (count === 0) throw new Error("Blender rendered no frames.");
      ffmpeg(["-framerate", String(fps), "-start_number", "1", "-i", join(frameFolder, "%04d.png"), ...encoderArgs(output, options.transparent ?? false), output]);
    }
    return { width, height, frames: still ? 1 : frames, engine, samples, draft, seconds: round((Date.now() - started) / 1000, 1) };
  });
}

// A scene script written by joEdit (turntable, title) is rendered like any other.
function renderGenerated(code: string, output: string, options: RenderOptions) {
  return withTempDir((folder) => {
    const script = join(folder, "scene.py");
    writeFileSync(script, code);
    return render(script, output, options);
  });
}

// Spin a 3D model on a turntable in a studio: for products, characters, generated models.
export function turntable(model: string, output: string, options: RenderOptions & { background?: string; turns?: number } = {}) {
  requireFile(model);
  const code = `
model = load(${JSON.stringify(resolve(model))}, size=2.0)
sky(${JSON.stringify(options.background ?? "#15151A")})
ground(${JSON.stringify(options.background ?? "#15151A")}, reflect=0.25)
studio_light("soft", target=(0, 0, 1))
camera(location=(0, -6.5, 2.2), target=(0, 0, 0.9), lens=50)
# Turn exactly ${options.turns ?? 1} time(s); the frame after the last is the start again, so it loops seamlessly.
keyframe(model, "rotation_euler", {1: (0, 0, 0), FRAMES + 1: (0, 0, ${360 * (options.turns ?? 1)})}, ease=False)
`;
  return renderGenerated(code, output, { duration: 6, ...options });
}

// An extruded 3D title that swings into place under studio light, with a slow camera push.
export function title(
  output: string,
  options: RenderOptions & { text: string; subtitle?: string; color?: string; background?: string; font?: string; brand?: string },
) {
  if (!options.text?.trim()) throw new Error('Give the title with --text "...".');
  const brand = loadBrand(options.brand);
  const color = options.color ?? brand.colors.primary;
  const background = options.background ?? brand.colors.background;
  const code = `
import math
sky(${JSON.stringify(background)})
ground(${JSON.stringify(background)}, reflect=0.15)
studio_light("dramatic", target=(0, 0, 1))
cam = camera(location=(0, -9, 1.6), target=(0, 0, 1.1), lens=50)
keyframe(cam, "location", {1: (0, -9, 1.6), FRAMES: (0, -7.6, 1.35)})

title = text3d(${JSON.stringify(options.text)}, size=1.4, depth=0.35, bevel=0.03, font=${JSON.stringify(options.font ?? "BebasNeue")},
               material=material(${JSON.stringify(color)}, metal=0.6, rough=0.25))
# Fit the title in about 80% of the frame width at the camera's distance.
bpy.context.view_layer.update()
fov = 2 * math.atan(18 / 50)
visible = 2 * 7.6 * math.tan(fov / 2) * min(1, WIDTH / HEIGHT)
scale = min(1, 0.8 * visible / max(title.dimensions.x, 0.01))
title.scale = (scale, scale, scale)
landed = seconds(1.2)
keyframe(title, "location", {1: (0, 2.5, 1.15), landed: (0, 0, 1.15)})
keyframe(title, "rotation_euler", {1: (90, 0, -40), landed: (90, 0, 0)})
${options.subtitle ? `
sub = text3d(${JSON.stringify(options.subtitle)}, size=0.32 * scale, depth=0.04, bevel=0.005, font="Montserrat",
             material=material("#FFFFFF", rough=0.5))
keyframe(sub, "location", {seconds(0.9): (0, -0.2, -0.5), seconds(1.7): (0, -0.2, 0.32)})` : ""}
`;
  return renderGenerated(code, output, { duration: 4, ...options });
}

// Shared flags for every render command.
function renderFlags(a: Parameters<Command["run"]>[0], duration: number): RenderOptions {
  return {
    duration: optionalNumberFlag(a, "duration", duration),
    frame: optionalNumberFlag(a, "frame", 1),
    fps: optionalNumberFlag(a, "fps", 30),
    width: optionalNumberFlag(a, "width", 1920),
    height: optionalNumberFlag(a, "height", 1080),
    engine: a.flags.engine ?? "eevee",
    samples: a.flags.samples === undefined ? undefined : numberFlag(a, "samples"),
    draft: a.flags.draft === "true",
    transparent: a.flags.transparent === "true",
  };
}

const RENDER_FLAGS = "[--width 1920] [--height 1080] [--fps 30] [--engine eevee|cycles] [--samples N] [--draft] [--transparent]";

export const commands: Record<string, Command> = {
  render: {
    usage: `render <scene.py> <output.mp4|.mov|.webm|.png> [--duration 4] [--frame 1] ${RENDER_FLAGS}  (needs Blender)`,
    run: (a) => {
      const { input, output } = inOut(a);
      return render(input, output, renderFlags(a, 4));
    },
  },
  turntable: {
    usage: `turntable <model.glb|.obj|.fbx|.stl> <output.mp4> [--duration 6] [--turns 1] [--background "#15151A"] ${RENDER_FLAGS}`,
    run: (a) => {
      const { input, output } = inOut(a);
      return turntable(input, output, { ...renderFlags(a, 6), background: a.flags.background, turns: optionalNumberFlag(a, "turns", 1) });
    },
  },
  title: {
    usage: `title <output.mp4|.png> --text "TITLE" [--subtitle "..."] [--color "#7C5CFF"] [--background "#0B0B0F"] [--font BebasNeue] [--brand brand.json] [--duration 4] ${RENDER_FLAGS}`,
    run: (a) => {
      if (!a.positional[0]) throw new Error("Missing output path.");
      return title(a.positional[0], {
        ...renderFlags(a, 4),
        frame: optionalNumberFlag(a, "frame", 60),
        text: a.flags.text ?? "",
        subtitle: a.flags.subtitle,
        color: a.flags.color,
        background: a.flags.background,
        font: a.flags.font,
        brand: a.flags.brand,
      });
    },
  },
};

// Only run the CLI when this file is executed directly (not when imported).
if (import.meta.main) {
  runCli("joEdit 3d: node 3d.ts <command> ...", commands, process.argv.slice(2));
}

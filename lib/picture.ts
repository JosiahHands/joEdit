// Picture editing, built on ImageMagick (`magick`).
// CLI:     node picture.ts <command> <input> <output> [--flags]
// Library: import { resize } from "./joEdit/picture.ts"
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ASSETS,
  DEFAULT_FONT,
  ffmpeg,
  inOut,
  numberFlag,
  optionalNumberFlag,
  requireFile,
  run,
  runCli,
  runPack,
  stringFlag,
  withTempDir,
  type Command,
} from "./shared.ts";
import * as graphics from "./graphics.ts";
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
  const { args, frames } = animateArgs(input, output, options);
  ffmpeg(args);
  return { frames };
}

// The ffmpeg arguments for animate (movie.ts runs them in the background, several scenes at once).
export function animateArgs(
  input: string,
  output: string,
  options: { duration?: number; motion?: string; width?: number; height?: number; fps?: number; amount?: number } = {},
): { args: string[]; frames: number } {
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
  return { args: ["-i", input, "-vf", `${big},${zoompan},format=yuv420p`, "-frames:v", String(frames), "-c:v", "libx264", "-crf", "18", output], frames };
}

// ---------- AI: make, enlarge, cut out, measure depth ----------

// Make a picture from a description (image pack: Z-Image Turbo). Same seed + prompt = same picture.
export function generate(output: string, prompt: string, options: { width?: number; height?: number; steps?: number; seed?: number } = {}) {
  if (!prompt.trim()) throw new Error('Describe the picture with --prompt, e.g. --prompt "a lighthouse at dawn, film photo".');
  return withTempDir((folder) => {
    const made = join(folder, "made.png");
    const args = [made, "--prompt", prompt, "--width", String(options.width ?? 1024), "--height", String(options.height ?? 1024), "--steps", String(options.steps ?? 9)];
    if (options.seed !== undefined) args.push("--seed", String(options.seed));
    const result = runPack("image", args);
    run("magick", [made, output]);
    return result;
  });
}

// Make a picture bigger with AI-restored detail (upscaler asset, Real-ESRGAN). scale: 2, 3 or 4.
// style: "photo" for real-world pictures, "art" for drawings, anime and graphics.
export function upscale(input: string, output: string, scale = 4, style = "photo") {
  requireFile(input);
  const program = join(ASSETS, "upscaler", process.platform === "win32" ? "realesrgan-ncnn-vulkan.exe" : "realesrgan-ncnn-vulkan");
  if (!existsSync(program)) throw new Error("Upscaling needs the upscaler. Run: node joedit.ts install upscaler");
  if (![2, 3, 4].includes(scale)) throw new Error("--scale must be 2, 3 or 4.");
  const model = style === "art" ? "realesrgan-x4plus-anime" : "realesrgan-x4plus";
  const { width, height } = info(input);
  withTempDir((folder) => {
    const source = join(folder, "in.png");
    const big = join(folder, "big.png");
    run("magick", [input, source]);
    // The models make 4x; smaller scales are resized down from that, which keeps the restored detail.
    run(program, ["-i", source, "-o", big, "-n", model, "-s", "4", "-m", join(ASSETS, "upscaler", "models")]);
    run("magick", [big, "-resize", `${width * scale}x${height * scale}!`, output]);
  });
  return { width: width * scale, height: height * scale, model };
}

// Remove the background (cutout pack). Output is a PNG with a see-through background,
// or with mask = true a black and white picture (white = the subject).
export function cutout(input: string, output: string, mask = false) {
  requireFile(input);
  if (!/\.(png|webp)$/i.test(output) && !mask) throw new Error("Use a .png (or .webp) output so the background can be see-through.");
  return withTempDir((folder) => {
    const result = runPack("cutout", [folder, input, ...(mask ? ["--mask"] : [])]);
    run("magick", [result.files[0], output]);
    return { model: result.model };
  });
}

// Depth map (depth pack): near = white, far = black. Useful for parallax, fog, focus effects and masks.
export function depth(input: string, output: string) {
  requireFile(input);
  return withTempDir((folder) => {
    const made = join(folder, "depth.png");
    const result = runPack("depth", [made, input]);
    run("magick", [made, output]);
    return result;
  });
}

export const PARALLAX_MOTIONS = ["dolly", "orbit", "pan-left", "pan-right", "rise", "fall"];

// 2.5D camera move: the picture is split into layers by its depth map and the "camera" moves,
// so near things move more than far things. Rendered with WebGL in Chrome.
export async function parallax(
  input: string,
  output: string,
  options: { duration?: number; motion?: string; amount?: number; width?: number; height?: number; fps?: number; depthMap?: string } = {},
) {
  requireFile(input);
  const { duration = 5, motion = "dolly", amount = 1, width = 1920, height = 1080, fps = 30 } = options;
  if (!PARALLAX_MOTIONS.includes(motion)) throw new Error(`Unknown motion "${motion}". Motions: ${PARALLAX_MOTIONS.join(", ")}`);
  return withTempDir(async (folder) => {
    let map = options.depthMap;
    if (!map) {
      map = join(folder, "depth.png");
      depth(input, map);
    }
    // Pictures go into the page as data URLs: WebGL may not read pictures from local files.
    const asDataUrl = (file: string, format: string) => {
      const out = join(folder, `page-${format}-${Math.random().toString(36).slice(2)}.${format}`);
      run("magick", [file, "-resize", "2560x2560>", ...(format === "jpg" ? ["-quality", "92"] : ["-colorspace", "Gray"]), out]);
      return `data:image/${format === "jpg" ? "jpeg" : "png"};base64,${readFileSync(out).toString("base64")}`;
    };
    const page = join(folder, "parallax.html");
    writeFileSync(page, parallaxHtml(asDataUrl(input, "jpg"), asDataUrl(map, "png"), motion, amount));
    const result = await graphics.render(page, output, { duration, width, height, fps });
    return { ...result, motion };
  });
}

// The WebGL page for parallax. For every pixel it finds which part of the picture lands there
// after the camera moves (a few refinement steps), so near and far parts move by different amounts.
function parallaxHtml(image: string, depthImage: string, motion: string, amount: number): string {
  return `<!doctype html><html><body style="margin:0;background:#000;overflow:hidden">
<img id="image" src="${image}" style="display:none"><img id="depth" src="${depthImage}" style="display:none">
<canvas id="c"></canvas>
<script>
const canvas = document.getElementById("c");
const W = window.joedit.width, H = window.joedit.height;
canvas.width = W; canvas.height = H;
const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true });
const vertex = "attribute vec2 p; varying vec2 uv; void main(){ uv = p * 0.5 + 0.5; uv.y = 1.0 - uv.y; gl_Position = vec4(p, 0.0, 1.0); }";
const fragment = \`precision highp float;
varying vec2 uv;
uniform sampler2D image, depth;
uniform vec2 offset, cover;
uniform float zoom, focus;
void main() {
  vec2 screen = 0.5 + (uv - 0.5) * cover;      // fill the frame, keeping the picture's shape
  vec2 s = screen;
  for (int k = 0; k < 8; k++) {
    float d = texture2D(depth, s).r;             // 1 = near, 0 = far
    float z = 1.0 + zoom * (0.25 + 0.75 * d);    // near things grow more when the camera moves in
    s = 0.5 + (screen - 0.5) / z - offset * (d - focus);
  }
  gl_FragColor = texture2D(image, clamp(s, 0.001, 0.999));
}\`;
function shader(type, source) { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); return s; }
const program = gl.createProgram();
gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex));
gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment));
gl.linkProgram(program); gl.useProgram(program);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
const p = gl.getAttribLocation(program, "p");
gl.enableVertexAttribArray(p); gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
function texture(unit, element, name) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, element);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(program, name), unit);
}
const img = document.getElementById("image");
texture(0, img, "image");
texture(1, document.getElementById("depth"), "depth");
// "cover": show the middle of the picture at the frame's shape.
const frame = W / H, picture = img.naturalWidth / img.naturalHeight;
gl.uniform2f(gl.getUniformLocation(program, "cover"), frame > picture ? 1 : frame / picture, frame > picture ? picture / frame : 1);
const motion = ${JSON.stringify(motion)}, amount = ${amount};
window.joedit.render = (time) => {
  const t = Math.min(1, time / window.joedit.duration);
  const ease = 0.5 - 0.5 * Math.cos(Math.PI * t);
  let ox = 0, oy = 0, zoom = 0.06 * amount, focus = 0.5;   // a little zoom hides the picture's edges
  if (motion === "dolly") { zoom = 0.06 * amount + 0.16 * amount * ease; focus = 0.2; }
  if (motion === "orbit") { ox = 0.03 * amount * Math.sin(2 * Math.PI * t); oy = 0.015 * amount * Math.cos(2 * Math.PI * t); }
  if (motion === "pan-left") ox = 0.035 * amount * (1 - 2 * ease);
  if (motion === "pan-right") ox = -0.035 * amount * (1 - 2 * ease);
  if (motion === "rise") oy = 0.03 * amount * (1 - 2 * ease);
  if (motion === "fall") oy = -0.03 * amount * (1 - 2 * ease);
  gl.uniform2f(gl.getUniformLocation(program, "offset"), ox, oy);
  gl.uniform1f(gl.getUniformLocation(program, "zoom"), zoom);
  gl.uniform1f(gl.getUniformLocation(program, "focus"), focus);
  gl.viewport(0, 0, W, H);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
};
</script></body></html>`;
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
  generate: {
    usage: 'generate <output.png> --prompt "what to show, style, light" [--width 1024] [--height 1024] [--seed N] [--steps 9]  (needs: install image)',
    run: (a) => {
      if (!a.positional[0]) throw new Error("Missing output path.");
      return generate(a.positional[0], a.flags.prompt ?? "", {
        width: optionalNumberFlag(a, "width", 1024),
        height: optionalNumberFlag(a, "height", 1024),
        steps: optionalNumberFlag(a, "steps", 9),
        seed: a.flags.seed === undefined ? undefined : numberFlag(a, "seed"),
      });
    },
  },
  upscale: {
    usage: "upscale <input> <output> [--scale 2|3|4] [--style photo|art]  (needs: install upscaler)",
    run: (a) => {
      const { input, output } = inOut(a);
      return upscale(input, output, optionalNumberFlag(a, "scale", 4), a.flags.style ?? "photo");
    },
  },
  cutout: {
    usage: "cutout <input> <output.png> [--mask]  (removes the background; needs: install cutout)",
    run: (a) => {
      const { input, output } = inOut(a);
      return cutout(input, output, a.flags.mask === "true");
    },
  },
  depth: {
    usage: "depth <input> <output.png>  (near = white, far = black; needs: install depth)",
    run: (a) => {
      const { input, output } = inOut(a);
      return depth(input, output);
    },
  },
  parallax: {
    usage: `parallax <picture> <output.mp4> [--motion ${PARALLAX_MOTIONS.join("|")}] [--duration 5] [--amount 1] [--depth depth.png] [--width 1920] [--height 1080] [--fps 30]  (needs: install depth, Chrome)`,
    run: (a) => {
      const { input, output } = inOut(a);
      return parallax(input, output, {
        duration: optionalNumberFlag(a, "duration", 5),
        motion: a.flags.motion ?? "dolly",
        amount: optionalNumberFlag(a, "amount", 1),
        width: optionalNumberFlag(a, "width", 1920),
        height: optionalNumberFlag(a, "height", 1080),
        fps: optionalNumberFlag(a, "fps", 30),
        depthMap: a.flags.depth,
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

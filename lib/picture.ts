// Picture editing, built on sharp (libvips: fast, any format) and Skia (text and design).
// CLI:     node joedit.ts picture <command> <input> <output> [--flags]
// Library: import { resize } from "./joEdit/picture.ts"
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import {
  AI_MODELS,
  ASSETS,
  drawText,
  loadModel,
  onnxModel,
  requireModel,
  transformers,
  ffmpeg,
  inOut,
  loadBrand,
  measureText,
  need,
  numberFlag,
  openPicture,
  optionalNumberFlag,
  pictureCanvas,
  probe,
  readJson,
  requireFile,
  run,
  runCli,
  runPack,
  saveCanvas,
  savePicture,
  videoEncoder,
  skia,
  stringFlag,
  TEXT_FLAGS,
  textStyle,
  withTempDir,
  writeVideo,
  type Brand,
  type Command,
  type TextStyle,
} from "./shared.ts";
import * as fx from "./fx.ts";
import * as video from "./video.ts";

export type PictureInfo = { width: number; height: number; format: string };

// Format names for the codecs pictures are stored in.
const FORMATS: Record<string, string> = { png: "PNG", mjpeg: "JPEG", webp: "WEBP", gif: "GIF", tiff: "TIFF", bmp: "BMP", av1: "AVIF", hevc: "HEIC" };

// Width, height and format of a picture.
export function info(input: string): PictureInfo {
  const picture = probe(input).streams.find((s) => s.codec_type === "video");
  if (!picture) throw new Error(`"${input}" is not a picture.`);
  return { width: picture.width, height: picture.height, format: FORMATS[picture.codec_name] ?? String(picture.codec_name).toUpperCase() };
}

// Resize. Give width, height, or both. With one, the aspect ratio is kept.
export async function resize(input: string, output: string, width?: number, height?: number): Promise<void> {
  if (!width && !height) throw new Error("Give --width, --height, or both.");
  const image = await openPicture(input);
  // Both sizes: stretch to exactly that. One size: the other follows the picture's shape.
  await savePicture(width && height ? image.resize(width, height, { fit: "fill" }) : image.resize(width || null, height || null), output);
}

// Cut out a rectangle starting at (x, y). Parts outside the picture are left out.
export async function crop(input: string, output: string, x: number, y: number, width: number, height: number): Promise<void> {
  const { width: w, height: h } = info(input);
  const left = Math.max(0, Math.min(x, w - 1));
  const top = Math.max(0, Math.min(y, h - 1));
  const image = await openPicture(input);
  await savePicture(image.extract({ left, top, width: Math.min(width, w - left), height: Math.min(height, h - top) }), output);
}

// Rotate clockwise by any number of degrees. Corners that open up are see-through (black in a jpg).
export async function rotate(input: string, output: string, degrees: number): Promise<void> {
  const sharp = need("sharp");
  // Turn upright first, then rotate (two steps, so phone photos rotate from how they look).
  const upright = await (await openPicture(input)).png().toBuffer();
  await savePicture(sharp(upright).rotate(degrees, { background: { r: 0, g: 0, b: 0, alpha: 0 } }), output);
}

// Mirror the picture. direction: "horizontal" (left-right) or "vertical" (top-bottom).
export async function flip(input: string, output: string, direction: string): Promise<void> {
  if (direction !== "horizontal" && direction !== "vertical") throw new Error('--direction must be "horizontal" or "vertical".');
  const image = await openPicture(input);
  await savePicture(direction === "horizontal" ? image.flop() : image.flip(), output);
}

// Make the picture black and white.
export async function grayscale(input: string, output: string): Promise<void> {
  await savePicture((await openPicture(input)).grayscale(), output);
}

// Change brightness. amount: -100 (darker) to 100 (brighter).
export async function brightness(input: string, output: string, amount: number): Promise<void> {
  await savePicture((await openPicture(input)).linear(1, (amount / 100) * 255), output);
}

// Change contrast. amount: -100 (flat gray) to 100 (more), around middle gray.
export async function contrast(input: string, output: string, amount: number): Promise<void> {
  const slope = Math.max(0, Math.tan((Math.PI * (amount / 100 + 1)) / 4));
  await savePicture((await openPicture(input)).linear(slope, 127.5 * (1 - slope)), output);
}

// Blur. Bigger radius = more blur.
export async function blur(input: string, output: string, radius: number): Promise<void> {
  const image = await openPicture(input);
  await savePicture(radius >= 0.3 ? image.blur(radius) : image, output);
}

// Write text on a picture. (x, y) is the top of the text, and its left edge (or centre / right edge with align).
// Any font family, color emoji, outline (stroke), shadow, a box behind it, and wrapping at maxWidth.
export async function text(input: string, output: string, words: string, x = 10, y = 10, style: TextStyle = {}): Promise<{ width: number; height: number }> {
  const { canvas, ctx } = await pictureCanvas(input);
  const size = drawText(ctx, words, x, y, { size: 32, ...style });
  await saveCanvas(canvas, output);
  return { width: Math.round(size.width), height: Math.round(size.height) };
}

// Parse "9:16" (or "1.5") into a width / height ratio.
export function parseAspect(aspect: string): number {
  const [w, h] = aspect.split(":").map(Number);
  const ratio = h ? w / h : w;
  if (!ratio || ratio <= 0) throw new Error(`--aspect must look like 9:16 or 1.5, not "${aspect}".`);
  return ratio;
}

export const FOCUS = ["smart", "center", "top", "bottom", "left", "right"];

// Crop and resize to an exact shape without stretching: 9:16 for phones, 1:1 for posts, 16:9 for YouTube.
// focus "smart" keeps the most interesting part (faces, detail, saturated color); others keep that side.
export async function fit(input: string, output: string, options: { aspect?: string; width?: number; height?: number; focus?: string } = {}) {
  const sharp = need("sharp");
  const { width: w, height: h } = info(input);
  const focus = options.focus ?? "smart";
  if (!FOCUS.includes(focus)) throw new Error(`--focus must be one of: ${FOCUS.join(", ")}`);
  let { width, height } = options;
  if (options.aspect) {
    const ratio = parseAspect(options.aspect);
    if (width && !height) height = Math.round(width / ratio);
    else if (height && !width) width = Math.round(height * ratio);
    else if (!width && !height) {
      // No size given: the biggest part of the picture with that shape.
      width = Math.min(w, Math.round(h * ratio));
      height = Math.min(h, Math.round(w / ratio));
    }
  }
  if (!width || !height) throw new Error("Give --aspect (e.g. 9:16), or both --width and --height.");
  const position = focus === "smart" ? sharp.strategy.attention : focus === "center" ? "centre" : focus;
  await savePicture((await openPicture(input)).resize(width, height, { fit: "cover", position }), output);
  return { width, height, focus };
}

// ---------- Compose: a designed picture from layers (thumbnails, posters, slides) ----------

// One layer of a design. Exactly one of image, text or color says what it is (color alone = a rectangle).
// x, y: top-left in pixels (for text: the anchor point, see align). width/height: the box to fill.
export type Layer = TextStyle & {
  image?: string;
  text?: string;
  color?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fit?: "cover" | "contain" | "fill"; // how an image fills its box (default cover)
  opacity?: number; // 0..1
  blend?: string; // normal, multiply, screen, overlay, darken, lighten, soft-light, hard-light, difference, color-dodge ...
  rotate?: number; // degrees clockwise, around the layer's centre
  radius?: number; // rounded corners for images and rectangles
  // Images: shadow, glow and outline follow the picture's own shape (a cutout PNG gets a cutout-shaped edge).
  outline?: number; // outline thickness in pixels around the picture's shape
  outlineColor?: string; // default white
  glow?: number; // soft glow size in pixels
  glowColor?: string; // default white
};

export type Design = { width?: number; height?: number; background?: string; layers: Layer[] };

const BLENDS = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"];

// Brand names ("primary", "accent", "text", "background", "heading", "body") turn into the brand's colors and fonts.
function branded(value: string | undefined, brand?: Brand): string | undefined {
  if (!value || !brand) return value;
  return (brand.colors as Record<string, string>)[value] ?? (brand.fonts as Record<string, string>)[value] ?? value;
}

// Load a picture file for drawing on a canvas.
export async function loadPicture(path: string): Promise<any> {
  const { loadImage } = await skia();
  try {
    return await loadImage(requireFile(path));
  } catch {
    // Formats Skia cannot read are turned into PNG first.
    return loadImage(await (await openPicture(path)).png().toBuffer());
  }
}

// Draw one layer. `folder` is where relative image paths start from.
export async function drawLayer(ctx: any, layer: Layer, folder = ".", brand?: Brand): Promise<void> {
  const blend = layer.blend ?? "normal";
  if (!BLENDS.includes(blend)) throw new Error(`Unknown blend "${blend}". Blends: ${BLENDS.join(", ")}`);
  for (const key of ["shadow", "glow", "outline"] as const) {
    const value = layer[key];
    if (value !== undefined && !(typeof value === "number" && value >= 0)) throw new Error(`A layer's "${key}" is a size in pixels (0 or more), got ${JSON.stringify(value)}.`);
  }
  const x = layer.x ?? 0;
  const y = layer.y ?? 0;
  ctx.save();
  ctx.globalAlpha = layer.opacity ?? 1;
  ctx.globalCompositeOperation = blend === "normal" ? "source-over" : blend;
  const style: TextStyle = { ...layer, color: branded(layer.color, brand), stroke: branded(layer.stroke, brand), box: branded(layer.box, brand), font: branded(layer.font, brand), maxWidth: layer.maxWidth ?? layer.width };

  // The layer's box, for rotation and shadows.
  let box = { x, y, width: layer.width ?? 0, height: layer.height ?? 0 };
  let picture: any;
  if (layer.text !== undefined) {
    const size = measureText(ctx, layer.text, style);
    const left = style.align === "center" ? x - size.width / 2 : style.align === "right" ? x - size.width : x;
    box = { x: left, y, width: size.width, height: size.height };
  } else if (layer.image) {
    picture = await loadPicture(resolve(folder, layer.image));
    // A missing width or height keeps the picture's shape.
    const width = layer.width ?? (layer.height ? (picture.width * layer.height) / picture.height : picture.width);
    const height = layer.height ?? (picture.height * width) / picture.width;
    box = { x, y, width, height };
  }
  if (layer.rotate) {
    ctx.translate(box.x + box.width / 2, box.y + box.height / 2);
    ctx.rotate((layer.rotate * Math.PI) / 180);
    ctx.translate(-(box.x + box.width / 2), -(box.y + box.height / 2));
  }

  if (layer.text !== undefined) {
    drawText(ctx, layer.text, x, y, style);
  } else {
    if (picture) {
      // Draw the fitted picture once on its own canvas, then use that for shadow, glow, outline and the picture itself.
      const { createCanvas } = await skia();
      const sprite = createCanvas(Math.max(1, Math.ceil(box.width)), Math.max(1, Math.ceil(box.height)));
      const s = sprite.getContext("2d");
      s.beginPath();
      s.roundRect(0, 0, box.width, box.height, layer.radius ?? 0);
      s.clip();
      const fitMode = layer.fit ?? "cover";
      // cover: crop the picture to the box's shape. contain: show all of it inside the box. fill: stretch.
      const scale = fitMode === "contain" ? Math.min(box.width / picture.width, box.height / picture.height) : Math.max(box.width / picture.width, box.height / picture.height);
      if (fitMode === "fill") s.drawImage(picture, 0, 0, box.width, box.height);
      else s.drawImage(picture, (box.width - picture.width * scale) / 2, (box.height - picture.height * scale) / 2, picture.width * scale, picture.height * scale);
      if (layer.shadow) {
        ctx.save();
        ctx.shadowColor = branded(layer.shadowColor, brand) ?? "rgba(0,0,0,0.5)";
        ctx.shadowBlur = layer.shadow;
        ctx.shadowOffsetY = layer.shadow / 4;
        ctx.drawImage(sprite, box.x, box.y);
        ctx.restore();
      }
      if (layer.glow) {
        // Two passes make the glow visible around thin shapes too.
        ctx.save();
        ctx.shadowColor = branded(layer.glowColor, brand) ?? "#FFFFFF";
        ctx.shadowBlur = layer.glow;
        ctx.drawImage(sprite, box.x, box.y);
        ctx.drawImage(sprite, box.x, box.y);
        ctx.restore();
      }
      if (layer.outline) {
        // The picture's shape in one color, drawn in a ring around the picture, makes an outline that follows its edge.
        const shape = createCanvas(sprite.width, sprite.height);
        const c = shape.getContext("2d");
        c.drawImage(sprite, 0, 0);
        c.globalCompositeOperation = "source-in";
        c.fillStyle = branded(layer.outlineColor, brand) ?? "#FFFFFF";
        c.fillRect(0, 0, shape.width, shape.height);
        const steps = Math.max(16, Math.ceil(layer.outline * 4));
        for (let i = 0; i < steps; i++) {
          const angle = (i / steps) * Math.PI * 2;
          ctx.drawImage(shape, box.x + Math.cos(angle) * layer.outline, box.y + Math.sin(angle) * layer.outline);
        }
      }
      ctx.drawImage(sprite, box.x, box.y);
    } else if (style.color) {
      // A rectangle. Its shadow is drawn from its shape, so it also works with rounded corners.
      if (layer.shadow) {
        ctx.shadowColor = branded(layer.shadowColor, brand) ?? "rgba(0,0,0,0.5)";
        ctx.shadowBlur = layer.shadow;
        ctx.shadowOffsetY = layer.shadow / 4;
      }
      ctx.fillStyle = style.color;
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.width, box.height, layer.radius ?? 0);
      ctx.fill();
    } else {
      throw new Error("Every layer needs an image, a text or a color.");
    }
  }
  ctx.restore();
}

// Make a picture from a design (JSON): a background and layers of pictures, text and shapes.
export async function compose(designFile: string, output: string, brandFile?: string) {
  const design: Design = readJson(designFile);
  if (!Array.isArray(design.layers)) throw new Error('A design needs "layers": [ ... ].');
  const brand = loadBrand(brandFile); // the default brand when no file is given
  const folder = dirname(resolve(designFile));
  const background = branded(design.background, brand) ?? "#000000";
  const isPicture = /\.(png|jpe?g|webp|avif|gif|bmp|tiff?|heic)$/i.test(background);
  // The size comes from the design, else from a background picture, else 1920x1080.
  const backgroundPicture = isPicture ? await loadPicture(resolve(folder, background)) : undefined;
  const width = design.width ?? backgroundPicture?.width ?? 1920;
  const height = design.height ?? backgroundPicture?.height ?? 1080;
  const { createCanvas } = await skia();
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (backgroundPicture) await drawLayer(ctx, { image: resolve(folder, background), width, height });
  else if (background !== "none") {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }
  for (const layer of design.layers) await drawLayer(ctx, layer, folder, brand);
  await saveCanvas(canvas, output);
  return { width, height, layers: design.layers.length };
}

const PICTURE_FILE = /\.(png|jpe?g|webp|avif|gif|bmp|tiff?|heic)$/i;

// Do the same thing to every picture in a folder: fit a shape, resize, change format.
export async function batch(
  folder: string,
  outFolder: string,
  options: { width?: number; height?: number; aspect?: string; format?: string; quality?: number } = {},
) {
  requireFile(folder);
  const files = readdirSync(folder).filter((name) => PICTURE_FILE.test(name)).sort();
  if (files.length === 0) throw new Error("No pictures in this folder.");
  mkdirSync(outFolder, { recursive: true });
  const made: string[] = [];
  // A few at a time: sharp already uses several cores for each picture.
  for (let i = 0; i < files.length; i += 4) {
    await Promise.all(files.slice(i, i + 4).map(async (name) => {
      const input = join(folder, name);
      const output = join(outFolder, `${parse(name).name}.${options.format ?? parse(name).ext.slice(1)}`);
      if (options.aspect) {
        await fit(input, output, { aspect: options.aspect, width: options.width, height: options.height });
      } else {
        let image = await openPicture(input);
        if (options.width || options.height) image = image.resize(options.width || null, options.height || null, { fit: "inside", withoutEnlargement: true });
        await savePicture(image, output, options.quality);
      }
      made.push(output);
    }));
  }
  return { count: made.length, folder: outFolder };
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
  // A .gif's encoder brings its own filter (the palette): it joins the camera move's filter, as one -vf.
  const encoder = videoEncoder(output);
  const own = encoder[0] === "-vf" ? encoder.splice(0, 2)[1] : "format=yuv420p";
  return { args: ["-i", input, "-vf", `${big},${zoompan},${own}`, "-frames:v", String(frames), ...encoder, output], frames };
}

// ---------- AI: make, enlarge, cut out, measure depth ----------

// Make a picture from a description (image pack: Z-Image Turbo). Same seed + prompt = same picture.
export function generate(output: string, prompt: string, options: { width?: number; height?: number; steps?: number; seed?: number } = {}) {
  if (!prompt.trim()) throw new Error('Describe the picture with --prompt, e.g. --prompt "a lighthouse at dawn, film photo".');
  return withTempDir(async (folder) => {
    const made = join(folder, "made.png");
    const args = [made, "--prompt", prompt, "--width", String(options.width ?? 1024), "--height", String(options.height ?? 1024), "--steps", String(options.steps ?? 9)];
    if (options.seed !== undefined) args.push("--seed", String(options.seed));
    const result = runPack("image", args);
    await convert(made, output);
    return result;
  });
}

// Make a picture bigger with AI-restored detail (upscaler asset, Real-ESRGAN). scale: 2, 3 or 4.
// style: "photo" for real-world pictures, "art" for drawings, anime and graphics.
export async function upscale(input: string, output: string, scale = 4, style = "photo") {
  requireFile(input);
  const program = join(ASSETS, "upscaler", process.platform === "win32" ? "realesrgan-ncnn-vulkan.exe" : "realesrgan-ncnn-vulkan");
  if (!existsSync(program)) throw new Error("Upscaling needs the upscaler. Run: node joedit.ts install upscaler");
  if (![2, 3, 4].includes(scale)) throw new Error("--scale must be 2, 3 or 4.");
  const model = style === "art" ? "realesrgan-x4plus-anime" : "realesrgan-x4plus";
  const { width, height } = info(input);
  await withTempDir(async (folder) => {
    const source = join(folder, "in.png");
    const big = join(folder, "big.png");
    await convert(input, source);
    // The models make 4x; smaller scales are resized down from that, which keeps the restored detail.
    run(program, ["-i", source, "-o", big, "-n", model, "-s", "4", "-m", join(ASSETS, "upscaler", "models")]);
    await resize(big, output, width * scale, height * scale);
  });
  return { width: width * scale, height: height * scale, model };
}

// A picture's pixels, upright, as RGB bytes.
async function rgbPixels(input: string): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await (await openPicture(requireFile(input))).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// Where the subject is: one byte per pixel, 255 = subject, 0 = background, soft in between.
// Uses BiRefNet (the cutout model), prepared the same way rembg does it.
export async function subjectMask(input: string): Promise<{ mask: Buffer; width: number; height: number }> {
  const SIZE = 1024;
  const sharp = need("sharp");
  const ort = need("onnxruntime-node");
  const session = await onnxModel("cutout");
  const { data, width, height } = await rgbPixels(input);
  // The model sees 1024x1024, scaled by the brightest value, minus the ImageNet averages, as planes of R, G and B.
  const small = await sharp(data, { raw: { width, height, channels: 3 } }).resize(SIZE, SIZE, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer();
  let brightest = 1;
  for (const v of small) brightest = Math.max(brightest, v);
  const mean = [0.485, 0.456, 0.406];
  const spread = [0.229, 0.224, 0.225];
  const pixels = new Float32Array(3 * SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) for (let c = 0; c < 3; c++) pixels[c * SIZE * SIZE + i] = (small[i * 3 + c] / brightest - mean[c]) / spread[c];
  const result = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", pixels, [1, 3, SIZE, SIZE]) });
  const scores = result[session.outputNames[0]].data as Float32Array;
  // Scores become 0..1 (sigmoid), stretched to the full range, then sized back to the picture.
  const chance = new Float32Array(SIZE * SIZE);
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < chance.length; i++) {
    chance[i] = 1 / (1 + Math.exp(-scores[i]));
    low = Math.min(low, chance[i]);
    high = Math.max(high, chance[i]);
  }
  const bytes = Buffer.alloc(SIZE * SIZE);
  for (let i = 0; i < chance.length; i++) bytes[i] = Math.round(((chance[i] - low) / Math.max(1e-6, high - low)) * 255);
  const mask = await sharp(bytes, { raw: { width: SIZE, height: SIZE, channels: 1 } })
    .resize(width, height, { fit: "fill", kernel: "lanczos3" })
    .extractChannel(0)
    .raw()
    .toBuffer();
  return { mask, width, height };
}

// Remove the background. Output is a PNG with a see-through background,
// or with mask = true a black and white picture (white = the subject).
export async function cutout(input: string, output: string, mask = false) {
  requireFile(input);
  if (!/\.(png|webp)$/i.test(output) && !mask) throw new Error("Use a .png (or .webp) output so the background can be see-through.");
  const sharp = need("sharp");
  const { mask: alpha, width, height } = await subjectMask(input);
  const gray = { raw: { width, height, channels: 1 } };
  if (mask) {
    await savePicture(sharp(alpha, gray), output);
  } else {
    const { data } = await rgbPixels(input);
    await savePicture(sharp(data, { raw: { width, height, channels: 3 } }).joinChannel(alpha, gray), output);
  }
  return { model: "cutout (BiRefNet lite)", width, height };
}

// Depth map (Depth Anything V2): near = white, far = black. Useful for parallax, fog, focus effects and masks.
export async function depth(input: string, output: string) {
  requireModel("depth");
  const library = transformers();
  const estimate = await loadModel<any>("depth", () => library.pipeline("depth-estimation", AI_MODELS.depth.repo));
  const { data, width, height } = await rgbPixels(input);
  const { depth: map } = await estimate(new library.RawImage(data, width, height, 3));
  const image = need("sharp")(Buffer.from(map.data), { raw: { width: map.width, height: map.height, channels: 1 } }).resize(width, height, { fit: "fill" });
  await savePicture(image, output);
  return { width, height };
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
      await depth(input, map);
    }
    // The picture and its depth map on the GPU (at most 2560 px), drawn by the parallax shader for every frame.
    const load = async (file: string) => {
      const image = (await openPicture(file)).resize(2560, 2560, { fit: "inside", withoutEnlargement: true });
      const { data, info } = await image.toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true }); // always RGBA
      return { pixels: data, width: info.width, height: info.height };
    };
    const picture = await load(input);
    const depthPicture = await load(map); // grey: the shader reads its red
    // "cover": show the middle of the picture at the frame's shape.
    const frameShape = width / height;
    const pictureShape = picture.width / picture.height;
    const cover = frameShape > pictureShape ? [1, pictureShape / frameShape] : [frameShape / pictureShape, 1];
    const writer = writeVideo(output, { width, height, fps });
    const frames = Math.max(1, Math.round(duration * fps));
    for (let n = 0; n < frames; n++) {
      const t = Math.min(1, n / fps / duration);
      const ease = 0.5 - 0.5 * Math.cos(Math.PI * t);
      let [ox, oy, zoom, focus] = [0, 0, 0.06 * amount, 0.5]; // a little zoom hides the picture's edges
      if (motion === "dolly") [zoom, focus] = [0.06 * amount + 0.16 * amount * ease, 0.2];
      if (motion === "orbit") [ox, oy] = [0.03 * amount * Math.sin(2 * Math.PI * t), 0.015 * amount * Math.cos(2 * Math.PI * t)];
      if (motion === "pan-left") ox = 0.035 * amount * (1 - 2 * ease);
      if (motion === "pan-right") ox = -0.035 * amount * (1 - 2 * ease);
      if (motion === "rise") oy = 0.03 * amount * (1 - 2 * ease);
      if (motion === "fall") oy = -0.03 * amount * (1 - 2 * ease);
      await writer.write(fx.shaderFrame(PARALLAX_SHADER, width, height, { offset: [ox, oy], cover, zoom, focus }, { image: picture, depth: depthPicture }));
    }
    await writer.finish();
    return { frames, motion };
  });
}

// For every pixel, find which part of the picture lands there after the camera moves
// (a few refinement steps), so near and far parts move by different amounts.
const PARALLAX_SHADER = `#version 330
out vec4 finalColor;
uniform sampler2D image;
uniform sampler2D depth;
uniform vec2 resolution;
uniform vec2 offset;
uniform vec2 cover;
uniform float zoom;
uniform float focus;
void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  vec2 screen = 0.5 + (uv - 0.5) * cover;       // fill the frame, keeping the picture's shape
  vec2 s = screen;
  for (int k = 0; k < 8; k++) {
    float d = texture(depth, s).r;               // 1 = near, 0 = far
    float z = 1.0 + zoom * (0.25 + 0.75 * d);    // near things grow more when the camera moves in
    s = 0.5 + (screen - 0.5) / z - offset * (d - focus);
  }
  finalColor = vec4(texture(image, clamp(s, 0.001, 0.999)).rgb, 1.0);
}`;

// Change format based on the output file extension (e.g. .png -> .jpg, .webp, .avif).
export async function convert(input: string, output: string, quality?: number): Promise<void> {
  await savePicture(await openPicture(input), output, quality);
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
      return resize(input, output, optionalNumberFlag(a, "width", 0), optionalNumberFlag(a, "height", 0));
    },
  },
  crop: {
    usage: "crop <input> <output> --x N --y N --width N --height N",
    run: (a) => {
      const { input, output } = inOut(a);
      return crop(input, output, numberFlag(a, "x"), numberFlag(a, "y"), numberFlag(a, "width"), numberFlag(a, "height"));
    },
  },
  rotate: {
    usage: "rotate <input> <output> --degrees N",
    run: (a) => {
      const { input, output } = inOut(a);
      return rotate(input, output, numberFlag(a, "degrees"));
    },
  },
  flip: {
    usage: "flip <input> <output> --direction horizontal|vertical",
    run: (a) => {
      const { input, output } = inOut(a);
      return flip(input, output, stringFlag(a, "direction"));
    },
  },
  grayscale: {
    usage: "grayscale <input> <output>",
    run: (a) => {
      const { input, output } = inOut(a);
      return grayscale(input, output);
    },
  },
  brightness: {
    usage: "brightness <input> <output> --amount -100..100",
    run: (a) => {
      const { input, output } = inOut(a);
      return brightness(input, output, numberFlag(a, "amount"));
    },
  },
  contrast: {
    usage: "contrast <input> <output> --amount -100..100",
    run: (a) => {
      const { input, output } = inOut(a);
      return contrast(input, output, numberFlag(a, "amount"));
    },
  },
  blur: {
    usage: "blur <input> <output> --radius N",
    run: (a) => {
      const { input, output } = inOut(a);
      return blur(input, output, numberFlag(a, "radius"));
    },
  },
  text: {
    usage: `text <input> <output> --text "words" [--x N] [--y N] ${TEXT_FLAGS}`,

    run: (a) => {
      const { input, output } = inOut(a);
      return text(input, output, stringFlag(a, "text"), optionalNumberFlag(a, "x", 10), optionalNumberFlag(a, "y", 10), textStyle(a));
    },
  },
  fit: {
    usage: `fit <input> <output> [--aspect 9:16] [--width N] [--height N] [--focus ${FOCUS.join("|")}]`,
    run: (a) => {
      const { input, output } = inOut(a);
      return fit(input, output, {
        aspect: a.flags.aspect,
        width: a.flags.width ? numberFlag(a, "width") : undefined,
        height: a.flags.height ? numberFlag(a, "height") : undefined,
        focus: a.flags.focus,
      });
    },
  },
  compose: {
    usage: "compose <design.json> <output> [--brand brand.json]  (layers of pictures, text and shapes)",
    run: (a) => {
      const { input, output } = inOut(a);
      return compose(input, output, a.flags.brand);
    },
  },
  batch: {
    usage: "batch <folder> <out-folder> [--width N] [--height N] [--aspect 1:1] [--format webp|jpg|png|avif] [--quality 1..100]",
    run: (a) => {
      const [folder, outFolder] = a.positional;
      if (!folder || !outFolder) throw new Error("Give a folder of pictures and an output folder.");
      return batch(folder, outFolder, {
        width: a.flags.width ? numberFlag(a, "width") : undefined,
        height: a.flags.height ? numberFlag(a, "height") : undefined,
        aspect: a.flags.aspect,
        format: a.flags.format,
        quality: a.flags.quality ? numberFlag(a, "quality") : undefined,
      });
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
    usage: `parallax <picture> <output.mp4> [--motion ${PARALLAX_MOTIONS.join("|")}] [--duration 5] [--amount 1] [--depth depth.png] [--width 1920] [--height 1080] [--fps 30]  (3D camera move from a depth map, on the GPU; needs: install depth)`,
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
      return convert(input, output, optionalNumberFlag(a, "quality", 0));
    },
  },
};

// Only run the CLI when this file is executed directly (not when imported).
if (import.meta.main) {
  runCli("Picture editor: node picture.ts <command> ...", commands, process.argv.slice(2));
}

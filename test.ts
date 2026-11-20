/// <reference path="./lib/node_modules/@types/node/index.d.ts" />
// Tests for every joEdit CLI: picture, video, sound, look, listen and joedit (doctor, check, packs).
// Run with: node --test test.ts   (run `npm install` in lib/ first, for editor types)
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import * as picture from "./lib/picture.ts";
import * as video from "./lib/video.ts";
import * as sound from "./lib/sound.ts";
import * as graphics from "./lib/graphics.ts";
import * as threeD from "./lib/3d.ts";
import * as fx from "./lib/fx.ts";
import { FFMPEG, concatLine, isModelInstalled, need, probe, readFrames, readJson, writeVideo } from "./lib/shared.ts";

type Tool = "picture" | "video" | "sound" | "look" | "listen" | "graphics" | "fx" | "movie" | "voice" | "music" | "3d" | "joedit";

// GPU effects need raylib (included in lib/libs/raylib for macOS, Windows x64 and Linux).
const hasRaylib = existsSync(fx.raylibFile());

// Graphics tests need Chrome; they are skipped on machines without it.
const hasChrome = (() => {
  try {
    return Boolean(graphics.findChrome());
  } catch {
    return false;
  }
})();

// Tests that need an AI model or pack are skipped when it is not installed.
function hasPack(name: string): boolean {
  const packs = JSON.parse(ok("joedit", ["packs"])).packs;
  return Boolean(packs.find((p: any) => p.name === name)?.installed);
}
const hasModel = (name: string) => isModelInstalled(name);
const hasWhisper = () => hasModel("whisper");
const hasAsset = (name: string) => existsSync(join("lib", ".assets", name));

// 3D tests need Blender; they are skipped on machines without it.
const hasBlender = (() => {
  try {
    return Boolean(threeD.findBlender());
  } catch {
    return false;
  }
})();

const dir = mkdtempSync(join(tmpdir(), "editor-test-"));
const file = (name: string) => join(dir, name);

// Run a CLI the same way an AI would: node lib/<tool>.ts <command> ...
function cli(tool: Tool, args: string[]) {
  const result = spawnSync("node", [`lib/${tool}.ts`, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Run a CLI and fail the test if it did not succeed.
function ok(tool: Tool, args: string[]): string {
  const result = cli(tool, args);
  assert.equal(result.code, 0, `Command failed: ${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

// RGBA pixels of a picture, or of a region of it ("WIDTHxHEIGHT+X+Y"), read with joEdit's ffmpeg.
function rgba(path: string, region?: string): Buffer {
  const { width, height } = probe(path).streams[0];
  const [w, h, x, y] = region ? region.match(/\d+/g)!.map(Number) : [width, height, 0, 0];
  const args = ["-loglevel", "error", "-i", path, "-frames:v", "1", "-vf", `crop=${w}:${h}:${x}:${y},format=rgba`, "-f", "rawvideo", "-"];
  return execFileSync(FFMPEG, args, { maxBuffer: 1 << 28 });
}

// Color of one pixel, e.g. "srgb(255,0,0)" (or "srgba(255,0,0,0.5)" when see-through).
function pixel(path: string, x: number, y: number): string {
  const [r, g, b, a] = rgba(path, `1x1+${x}+${y}`);
  return a === 255 ? `srgb(${r},${g},${b})` : `srgba(${r},${g},${b},${Math.round((a / 255) * 100) / 100})`;
}

// Average brightness from 0 to 1 (of a region, if given).
function mean(path: string, region?: string): number {
  const data = rgba(path, region);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
  return sum / ((data.length / 4) * 3 * 255);
}

// Make an exact test picture: color(x, y) gives [red, green, blue, alpha] for every pixel.
async function paint(path: string, width: number, height: number, color: (x: number, y: number) => number[]): Promise<void> {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(color(x, y), (y * width + x) * 4);
  await need("sharp")(data, { raw: { width, height, channels: 4 } }).png().toFile(path);
}
const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255], WHITE = [255, 255, 255, 255], BLACK = [0, 0, 0, 255], CLEAR = [0, 0, 0, 0];
const inCircle = (x: number, y: number, cx: number, cy: number, r: number) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r;

// Durations are checked with a small tolerance because of how video frames and audio samples line up.
function near(actual: number, expected: number, tolerance = 0.15): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ~${expected}, got ${actual}`);
}

// Save the video frame at `time` seconds as a picture.
function frameAt(path: string, time: number, output: string): void {
  execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-ss", String(time), "-i", path, "-frames:v", "1", output]);
}

// How different the same region (e.g. "320x100+0+0") is in two pictures: 0 = same, 1 = opposite.
function regionDiff(a: string, b: string, region: string): number {
  const first = rgba(a, region);
  const second = rgba(b, region);
  let sum = 0;
  for (let i = 0; i < first.length; i += 4) for (let c = 0; c < 3; c++) sum += (first[i + c] - second[i + c]) ** 2;
  return Math.sqrt(sum / ((first.length / 4) * 3)) / 255;
}

// Average loudness in dB (closer to 0 = louder). `seconds` limits it to the start of the file.
function loudness(path: string, seconds = 0): number {
  const limit = seconds ? ["-t", String(seconds)] : [];
  const result = spawnSync(FFMPEG, ["-hide_banner", ...limit, "-i", path, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const match = result.stderr.match(/mean_volume: (-?[\d.]+) dB/);
  assert.ok(match, `no loudness found for ${path}`);
  return Number(match[1]);
}

// Sample files are created once before all tests.
before(async () => {
  // 400x300 red picture with a blue top-right corner (so flips can be checked).
  await paint(file("in.png"), 400, 300, (x, y) => (x >= 200 && y < 150 ? BLUE : RED));
  // 3 second 320x240 video with sound.
  execFileSync(FFMPEG, [
    "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", file("in.mp4"),
  ]);
  // 2 second 160x120 video with no sound.
  execFileSync(FFMPEG, [
    "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=30",
    "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", file("silent.mp4"),
  ]);
  // 5 second audio file.
  execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220", "-t", "5", file("sound.mp3")]);
  // 8 second click track at exactly 120 BPM (a click every 0.5s).
  execFileSync(FFMPEG, [
    "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "aevalsrc='0.8*sin(2*PI*1000*t)*lt(mod(t,0.5),0.03)':s=44100:d=8",
    file("click120.wav"),
  ]);
  // 2s tone, 3s silence, 2s tone.
  execFileSync(FFMPEG, [
    "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-filter_complex", "[1]atrim=0:3[s];[0][s][2]concat=n=3:v=0:a=1",
    file("gap.wav"),
  ]);
  // 1.5s of black, then 3s of test picture, with sound.
  execFileSync(FFMPEG, [
    "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=black:s=320x240:d=1.5",
    "-f", "lavfi", "-i", "testsrc=size=320x240:d=3",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=4.5",
    "-filter_complex", "[0][1]concat=n=2:v=1:a=0[v]",
    "-map", "[v]", "-map", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    file("blackstart.mp4"),
  ]);
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe("picture", () => {
  test("info", () => {
    const result = JSON.parse(ok("picture", ["info", file("in.png")]));
    assert.deepEqual(result, { ok: true, width: 400, height: 300, format: "PNG" });
  });

  test("resize keeps aspect ratio with only width", () => {
    ok("picture", ["resize", file("in.png"), file("resize.png"), "--width", "200"]);
    assert.deepEqual(picture.info(file("resize.png")), { width: 200, height: 150, format: "PNG" });
  });

  test("resize to exact size", () => {
    ok("picture", ["resize", file("in.png"), file("resize2.png"), "--width", "100", "--height", "100"]);
    assert.equal(picture.info(file("resize2.png")).width, 100);
    assert.equal(picture.info(file("resize2.png")).height, 100);
  });

  test("crop", () => {
    ok("picture", ["crop", file("in.png"), file("crop.png"), "--x", "10", "--y", "10", "--width", "50", "--height", "40"]);
    const result = picture.info(file("crop.png"));
    assert.equal(result.width, 50);
    assert.equal(result.height, 40);
  });

  test("rotate 90 swaps width and height", () => {
    ok("picture", ["rotate", file("in.png"), file("rotate.png"), "--degrees", "90"]);
    const result = picture.info(file("rotate.png"));
    assert.equal(result.width, 300);
    assert.equal(result.height, 400);
  });

  test("flip horizontal moves blue corner to the left", () => {
    ok("picture", ["flip", file("in.png"), file("flipH.png"), "--direction", "horizontal"]);
    assert.match(pixel(file("flipH.png"), 10, 10), /\(0,0,255\)/);
  });

  test("flip vertical moves blue corner to the bottom", () => {
    ok("picture", ["flip", file("in.png"), file("flipV.png"), "--direction", "vertical"]);
    assert.match(pixel(file("flipV.png"), 390, 290), /\(0,0,255\)/);
  });

  test("grayscale", () => {
    ok("picture", ["grayscale", file("in.png"), file("gray.png")]);
    // In a gray picture red, green and blue are equal.
    const [r, g, b] = pixel(file("gray.png"), 10, 10).match(/[\d.]+/g)!.map(Number);
    assert.ok(r === g && g === b, `not gray: ${r},${g},${b}`);
  });

  test("brightness makes it brighter", () => {
    ok("picture", ["brightness", file("in.png"), file("bright.png"), "--amount", "40"]);
    assert.ok(mean(file("bright.png")) > mean(file("in.png")));
  });

  test("contrast", () => {
    ok("picture", ["contrast", file("in.png"), file("contrast.png"), "--amount", "-50"]);
    assert.ok(existsSync(file("contrast.png")));
  });

  test("blur", () => {
    ok("picture", ["blur", file("in.png"), file("blur.png"), "--radius", "5"]);
    // The sharp edge between red and blue becomes a mix.
    assert.doesNotMatch(pixel(file("blur.png"), 200, 50), /\((255,0,0|0,0,255)\)/);
  });

  test("text changes the picture", () => {
    ok("picture", ["text", file("in.png"), file("text.png"), "--text", "Hello", "--x", "20", "--y", "200", "--size", "40", "--color", "yellow"]);
    assert.ok(mean(file("text.png")) !== mean(file("in.png")));
  });

  test("convert to jpg", () => {
    ok("picture", ["convert", file("in.png"), file("out.jpg"), "--quality", "80"]);
    assert.equal(picture.info(file("out.jpg")).format, "JPEG");
  });

  test("grade noir makes a red picture gray", () => {
    ok("picture", ["grade", file("in.png"), file("noir.png"), "--look", "noir"]);
    const [r, g, b] = pixel(file("noir.png"), 10, 290).match(/[\d.]+/g)!.map(Number);
    assert.ok(Math.abs(r - g) < 3 && Math.abs(g - b) < 3, `not gray: ${r},${g},${b}`);
    assert.equal(cli("picture", ["grade", file("in.png"), file("x.png"), "--look", "disco"]).code, 1);
  });

  test("effects: letterbox bars and vignette corners", () => {
    ok("picture", ["effects", file("in.png"), file("fx.png"), "--letterbox", "2.39", "--vignette", "0.8"]);
    assert.deepEqual(picture.info(file("fx.png")), { width: 400, height: 300, format: "PNG" });
    // 400 wide at 2.39:1 is 167 tall, so the bars are about 66 pixels each.
    assert.equal(pixel(file("fx.png"), 200, 10), "srgb(0,0,0)");
    assert.equal(pixel(file("fx.png"), 200, 290), "srgb(0,0,0)");
    assert.ok(mean(file("fx.png")) < mean(file("in.png")));
    assert.equal(cli("picture", ["effects", file("in.png"), file("x.png")]).code, 1);
  });

  test("animate turns a picture into a video with a camera move", () => {
    const result = JSON.parse(ok("picture", ["animate", file("in.png"), file("kb.mp4"), "--duration", "2", "--motion", "pan-right", "--width", "320", "--height", "180", "--amount", "0.5"]));
    assert.equal(result.frames, 60);
    const details = video.info(file("kb.mp4"));
    assert.deepEqual([details.width, details.height], [320, 180]);
    // Panning moves the edge between red and blue, so the start and end frames differ.
    frameAt(file("kb.mp4"), 0, file("kb-start.png"));
    frameAt(file("kb.mp4"), 1.95, file("kb-end.png"));
    assert.ok(regionDiff(file("kb-start.png"), file("kb-end.png"), "320x180+0+0") > 0.05);
    assert.equal(cli("picture", ["animate", file("in.png"), file("x.mp4"), "--motion", "spin"]).code, 1);
  });

  test("generate makes a picture from a description", (t) => {
    if (!hasPack("image")) return t.skip("image pack not installed");
    const result = JSON.parse(ok("picture", ["generate", file("made.jpg"), "--prompt", "a red apple on a white table", "--width", "512", "--height", "384", "--steps", "4", "--seed", "1"]));
    assert.equal(result.seed, 1);
    assert.deepEqual(picture.info(file("made.jpg")), { width: 512, height: 384, format: "JPEG" });
    assert.equal(cli("picture", ["generate", file("x.png")]).code, 1); // no --prompt
  });

  test("upscale makes a picture bigger", (t) => {
    if (!hasAsset("upscaler")) return t.skip("upscaler asset not installed");
    ok("picture", ["resize", file("in.png"), file("small.png"), "--width", "100"]);
    const result = JSON.parse(ok("picture", ["upscale", file("small.png"), file("big.png"), "--scale", "3"]));
    assert.deepEqual([result.width, result.height], [300, 225]);
    assert.deepEqual(picture.info(file("big.png")), { width: 300, height: 225, format: "PNG" });
    assert.equal(cli("picture", ["upscale", file("small.png"), file("x.png"), "--scale", "5"]).code, 1);
  });

  test("cutout removes the background", async (t) => {
    if (!hasModel("cutout")) return t.skip("cutout model not installed");
    await paint(file("subject.png"), 320, 240, (x, y) => (inCircle(x, y, 160, 120, 70) ? RED : WHITE));
    ok("picture", ["cutout", file("subject.png"), file("cut.png")]);
    // The ball stays, the white around it becomes see-through.
    assert.match(pixel(file("cut.png"), 160, 120), /^srgba?\(25\d,/);
    assert.equal(rgba(file("cut.png"), "1x1+5+5")[3], 0);
    ok("picture", ["cutout", file("subject.png"), file("mask.png"), "--mask"]);
    assert.ok(mean(file("mask.png")) > 0.1 && mean(file("mask.png")) < 0.5);
  });

  test("depth makes a near-white, far-black map", (t) => {
    if (!hasModel("depth")) return t.skip("depth model not installed");
    const result = JSON.parse(ok("picture", ["depth", file("subject.png"), file("depth.png")]));
    assert.deepEqual([result.width, result.height], [320, 240]);
    assert.deepEqual(picture.info(file("depth.png")), { width: 320, height: 240, format: "PNG" });
  });

  test("parallax moves near parts more than far parts", async (t) => {
    if (!hasRaylib) return t.skip("raylib not found");
    // A hand-made depth map: the top half is near (white), the bottom half far (black).
    await paint(file("halves-depth.png"), 400, 300, (_, y) => (y < 150 ? WHITE : BLACK));
    await paint(file("checks.png"), 400, 300, (x, y) => ((Math.floor(x / 32) + Math.floor(y / 32)) % 2 ? WHITE : [128, 128, 128, 255]));
    const result = JSON.parse(ok("picture", ["parallax", file("checks.png"), file("parallax.mp4"), "--depth", file("halves-depth.png"),
      "--motion", "pan-right", "--duration", "1", "--width", "320", "--height", "240"]));
    assert.equal(result.frames, 30);
    frameAt(file("parallax.mp4"), 0, file("px-start.png"));
    frameAt(file("parallax.mp4"), 0.95, file("px-end.png"));
    const nearMove = regionDiff(file("px-start.png"), file("px-end.png"), "320x80+0+20");
    const farMove = regionDiff(file("px-start.png"), file("px-end.png"), "320x80+0+140");
    assert.ok(nearMove > farMove, `near ${nearMove} should move more than far ${farMove}`);
    assert.equal(cli("picture", ["parallax", file("checks.png"), file("x.mp4"), "--motion", "spin"]).code, 1);
  });

  test("fit crops to a shape without stretching", () => {
    ok("picture", ["fit", file("in.png"), file("fit.png"), "--aspect", "9:16", "--focus", "right"]);
    assert.deepEqual(picture.info(file("fit.png")), { width: 169, height: 300, format: "PNG" });
    // Keeping the right side keeps the blue corner.
    assert.equal(pixel(file("fit.png"), 160, 10), "srgb(0,0,255)");
    ok("picture", ["fit", file("in.png"), file("fit-square.jpg"), "--aspect", "1:1", "--width", "100"]);
    assert.deepEqual(picture.info(file("fit-square.jpg")), { width: 100, height: 100, format: "JPEG" });
    assert.equal(cli("picture", ["fit", file("in.png"), file("x.png")]).code, 1); // no shape
  });

  test("text with stroke, box and wrapping", () => {
    const result = JSON.parse(ok("picture", ["text", file("in.png"), file("styled.png"), "--text", "one two three four", "--max-width", "120",
      "--box", "#000000", "--x", "200", "--y", "20", "--align", "center", "--stroke", "white"]));
    assert.ok(result.height > 60, `wrapped onto lines: ${result.height}`);
    assert.equal(pixel(file("styled.png"), 200, 22), "srgb(0,0,0)"); // inside the box
  });

  test("compose draws a design from layers", () => {
    writeFileSync(file("design.json"), JSON.stringify({
      width: 300, height: 200, background: "#FFFFFF",
      layers: [
        { image: "in.png", x: 0, y: 0, width: 150, height: 100 },
        { color: "primary", x: 200, y: 150, width: 50, height: 30 },
        { text: "Hi", x: 150, y: 120, size: 30, color: "#000000", align: "center" },
      ],
    }));
    const result = JSON.parse(ok("picture", ["compose", file("design.json"), file("design.png")]));
    assert.deepEqual([result.width, result.height, result.layers], [300, 200, 3]);
    assert.equal(pixel(file("design.png"), 10, 90), "srgb(255,0,0)"); // the picture
    assert.equal(pixel(file("design.png"), 250, 10), "srgb(255,255,255)"); // background
    assert.equal(pixel(file("design.png"), 225, 165), "srgb(124,92,255)"); // brand primary color
    writeFileSync(file("bad-design.json"), JSON.stringify({ layers: [{ x: 1 }] }));
    assert.match(cli("picture", ["compose", file("bad-design.json"), file("x.png")]).stderr, /needs an image, a text or a color/);
  });

  test("compose outline and glow follow a cutout's shape, not its box", async () => {
    // A red circle (radius 30) on a see-through 100x100 picture.
    await paint(file("dot.png"), 100, 100, (x, y) => (inCircle(x, y, 50, 50, 30) ? RED : CLEAR));
    writeFileSync(file("sticker.json"), JSON.stringify({
      width: 400, height: 200, background: "#000000",
      layers: [
        { image: "dot.png", x: 50, y: 50, outline: 6, outlineColor: "#FFFFFF" },
        { image: "dot.png", x: 250, y: 50, glow: 20, glowColor: "#0000FF" },
      ],
    }));
    ok("picture", ["compose", file("sticker.json"), file("sticker.png")]);
    assert.equal(pixel(file("sticker.png"), 100, 100), "srgb(255,0,0)"); // the circle itself
    assert.equal(pixel(file("sticker.png"), 133, 100), "srgb(255,255,255)"); // outline just outside the circle
    assert.equal(pixel(file("sticker.png"), 56, 56), "srgb(0,0,0)"); // the box corner stays empty
    const [r, , b] = pixel(file("sticker.png"), 336, 100).match(/\d+/g)!.map(Number);
    assert.ok(b > 20 && r < 20, `no blue glow beside the circle: ${r},${b}`);
  });

  test("batch converts a folder of pictures", async () => {
    mkdirSync(file("batch-in"), { recursive: true });
    await paint(file("batch-in/a.png"), 400, 200, () => RED);
    await paint(file("batch-in/b.png"), 200, 400, () => BLUE);
    const result = JSON.parse(ok("picture", ["batch", file("batch-in"), file("batch-out"), "--width", "100", "--format", "webp"]));
    assert.equal(result.count, 2);
    assert.deepEqual(picture.info(file("batch-out/a.webp")), { width: 100, height: 50, format: "WEBP" });
    assert.deepEqual(picture.info(file("batch-out/b.webp")), { width: 100, height: 200, format: "WEBP" });
  });

  test("errors: missing file, missing flag, unknown command", () => {
    assert.equal(cli("picture", ["resize", file("nope.png"), file("x.png"), "--width", "10"]).code, 1);
    assert.equal(cli("picture", ["crop", file("in.png"), file("x.png"), "--x", "1"]).code, 1);
    assert.equal(cli("picture", ["dance"]).code, 1);
    assert.equal(cli("picture", ["help"]).code, 0);
  });
});

describe("video", () => {
  test("info", () => {
    const result = JSON.parse(ok("video", ["info", file("in.mp4")]));
    assert.equal(result.width, 320);
    assert.equal(result.height, 240);
    assert.equal(result.fps, 30);
    assert.equal(result.hasAudio, true);
    near(result.duration, 3);
  });

  test("trim", () => {
    ok("video", ["trim", file("in.mp4"), file("trim.mp4"), "--start", "1", "--end", "2"]);
    near(video.info(file("trim.mp4")).duration, 1);
  });

  test("resize keeps aspect ratio", () => {
    ok("video", ["resize", file("in.mp4"), file("resize.mp4"), "--width", "160"]);
    const result = video.info(file("resize.mp4"));
    assert.equal(result.width, 160);
    assert.equal(result.height, 120);
  });

  test("crop", () => {
    ok("video", ["crop", file("in.mp4"), file("crop.mp4"), "--x", "0", "--y", "0", "--width", "100", "--height", "80"]);
    const result = video.info(file("crop.mp4"));
    assert.equal(result.width, 100);
    assert.equal(result.height, 80);
  });

  test("rotate 90 swaps width and height", () => {
    ok("video", ["rotate", file("in.mp4"), file("rotate.mp4"), "--degrees", "90"]);
    const result = video.info(file("rotate.mp4"));
    assert.equal(result.width, 240);
    assert.equal(result.height, 320);
  });

  test("rotate rejects 45 degrees", () => {
    assert.equal(cli("video", ["rotate", file("in.mp4"), file("x.mp4"), "--degrees", "45"]).code, 1);
  });

  test("flip", () => {
    ok("video", ["flip", file("in.mp4"), file("flip.mp4"), "--direction", "horizontal"]);
    assert.equal(video.info(file("flip.mp4")).width, 320);
  });

  test("speed 2x halves duration", () => {
    ok("video", ["speed", file("in.mp4"), file("fast.mp4"), "--factor", "2"]);
    near(video.info(file("fast.mp4")).duration, 1.5);
  });

  test("speed works on video with no sound", () => {
    ok("video", ["speed", file("silent.mp4"), file("slow.mp4"), "--factor", "0.5"]);
    near(video.info(file("slow.mp4")).duration, 4);
  });

  test("mute", () => {
    ok("video", ["mute", file("in.mp4"), file("mute.mp4")]);
    assert.equal(video.info(file("mute.mp4")).hasAudio, false);
  });

  test("extract-audio", () => {
    ok("video", ["extract-audio", file("in.mp4"), file("audio.mp3")]);
    near(video.info(file("audio.mp3")).duration, 3, 0.2);
  });

  test("extract-audio fails when there is no sound", () => {
    assert.equal(cli("video", ["extract-audio", file("silent.mp4"), file("x.mp3")]).code, 1);
  });

  test("add-audio", () => {
    ok("video", ["add-audio", file("silent.mp4"), file("dub.mp4"), "--audio", file("sound.mp3")]);
    const result = video.info(file("dub.mp4"));
    assert.equal(result.hasAudio, true);
    near(result.duration, 2, 0.2);
  });

  test("concat with sound", () => {
    ok("video", ["concat", file("in.mp4"), file("in.mp4"), file("concat.mp4")]);
    const result = video.info(file("concat.mp4"));
    assert.equal(result.hasAudio, true);
    near(result.duration, 6, 0.2);
  });

  test("concat different sizes, one without sound: the sound is kept", () => {
    ok("video", ["concat", file("in.mp4"), file("silent.mp4"), file("concat2.mp4")]);
    const result = video.info(file("concat2.mp4"));
    assert.equal(result.width, 320);
    assert.equal(result.height, 240);
    assert.equal(result.hasAudio, true); // silence fills in for the silent clip
    near(result.duration, 5, 0.2);
    assert.ok(loudness(file("concat2.mp4")) > -40, "the first clip's sound is lost");
  });

  test("concat fits a clip of another shape inside, without stretching", () => {
    // A tall white clip after a wide one: it keeps its shape, with black bars at the sides.
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=white:size=120x240:rate=30", "-t", "1", "-pix_fmt", "yuv420p", file("tall.mp4")]);
    ok("video", ["concat", file("in.mp4"), file("tall.mp4"), file("concat3.mp4")]);
    frameAt(file("concat3.mp4"), 3.5, file("concat3.png"));
    assert.ok(mean(file("concat3.png"), "40x40+140+100") > 0.9, "the middle should be the white clip");
    assert.ok(mean(file("concat3.png"), "40x40+0+100") < 0.1, "the sides should be black bars");
  });

  test("fade, reverse, stabilize", () => {
    ok("video", ["fade", file("in.mp4"), file("faded.mp4"), "--in", "1", "--out", "1"]);
    frameAt(file("faded.mp4"), 0.02, file("faded-start.png"));
    frameAt(file("faded.mp4"), 1.5, file("faded-middle.png"));
    assert.ok(mean(file("faded-start.png")) < 0.05, "should start from black");
    assert.ok(mean(file("faded-middle.png")) > 0.2);
    assert.ok(loudness(file("faded.mp4"), 0.3) < loudness(file("faded.mp4")) - 6, "the sound fades in too");
    assert.equal(cli("video", ["fade", file("in.mp4"), file("x.mp4")]).code, 1);

    // Reversed: the last frame of the original is the first frame of the result.
    ok("video", ["reverse", file("in.mp4"), file("reversed.mp4")]);
    frameAt(file("in.mp4"), 2.95, file("in-end.png"));
    frameAt(file("reversed.mp4"), 0, file("reversed-start.png"));
    assert.ok(regionDiff(file("in-end.png"), file("reversed-start.png"), "320x240+0+0") < 0.05);
    assert.ok(video.info(file("reversed.mp4")).hasAudio);

    ok("video", ["stabilize", file("in.mp4"), file("stable.mp4"), "--strength", "1"]);
    const stable = video.info(file("stable.mp4"));
    assert.deepEqual([stable.width, stable.height], [320, 240]);
    near(stable.duration, 3, 0.15);
  });

  test("overlay puts a picture on top, only while asked", async () => {
    await paint(file("dot.png"), 50, 50, () => RED);
    ok("video", ["overlay", file("in.mp4"), file("dot.png"), file("dotted.mp4"), "--x", "0.75", "--y", "0.5", "--width", "0.25", "--at", "1", "--duration", "1"]);
    // Is the dot there? Compare its spot with the same moment of the original.
    const shown = (time: number) => {
      frameAt(file("dotted.mp4"), time, file("dotted.png"));
      frameAt(file("in.mp4"), time, file("undotted.png"));
      return regionDiff(file("dotted.png"), file("undotted.png"), "30x30+225+105") > 0.2;
    };
    assert.ok(!shown(0.5), "shown too early");
    assert.ok(shown(1.5), "not shown at 1.5 s");
    assert.ok(!shown(2.5), "shown too late");
  });

  test("a sound file given to video frame says it has no picture", () => {
    const result = cli("video", ["frame", file("sound.mp3"), file("x.png"), "--time", "1"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no picture/);
    assert.match(cli("picture", ["resize", file("in.mp4"), file("x.png"), "--width", "10"]).stderr, /not a picture/);
  });

  test("trim past the end fails instead of making an empty file", () => {
    const result = cli("video", ["trim", file("in.mp4"), file("x.mp4"), "--start", "60", "--end", "70"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /after the end/);
  });

  test("frame", () => {
    ok("video", ["frame", file("in.mp4"), file("frame.png"), "--time", "1.5"]);
    assert.deepEqual(picture.info(file("frame.png")), { width: 320, height: 240, format: "PNG" });
  });

  test("gif", () => {
    ok("video", ["gif", file("in.mp4"), file("anim.gif"), "--fps", "5", "--width", "160"]);
    const result = picture.info(file("anim.gif"));
    assert.equal(result.format, "GIF");
    assert.equal(result.width, 160);
  });

  test("text keeps size and sound", () => {
    ok("video", ["text", file("in.mp4"), file("text.mp4"), "--text", "Hello world", "--x", "20", "--y", "20"]);
    const result = video.info(file("text.mp4"));
    assert.equal(result.width, 320);
    assert.equal(result.hasAudio, true);
    // The text area should look different from the original frame.
    video.frame(file("in.mp4"), file("before.png"), 1);
    video.frame(file("text.mp4"), file("after.png"), 1);
    assert.notEqual(mean(file("before.png")), mean(file("after.png")));
  });

  test("convert to webm", () => {
    ok("video", ["convert", file("in.mp4"), file("out.webm")]);
    near(video.info(file("out.webm")).duration, 3, 0.2);
  });

  test("grade keeps length and sound, half strength mixes with the original", () => {
    ok("video", ["grade", file("in.mp4"), file("graded.mp4"), "--look", "teal-orange"]);
    ok("video", ["grade", file("in.mp4"), file("graded-half.mp4"), "--look", "noir", "--strength", "0.5"]);
    near(video.info(file("graded.mp4")).duration, 3, 0.1);
    assert.ok(video.info(file("graded.mp4")).hasAudio);
    near(video.info(file("graded-half.mp4")).duration, 3, 0.1);
  });

  test("effects letterbox puts black bars on every frame", () => {
    ok("video", ["effects", file("in.mp4"), file("bars.mp4"), "--letterbox", "2.39", "--grain", "0.3"]);
    frameAt(file("bars.mp4"), 2, file("bars.png"));
    assert.ok(mean(file("bars.png")) > 0.1);
    const [r, g, b] = pixel(file("bars.png"), 160, 5).match(/[\d.]+/g)!.map(Number);
    assert.ok(r < 30 && g < 30 && b < 30, `top bar not black: ${r},${g},${b}`);
  });

  test("remove-silence cuts out the pause", () => {
    // 7s video whose sound is: 2s tone, 3s silence, 2s tone.
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-i", file("gap.wav"), "-t", "7", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", file("gap.mp4")]);
    const result = JSON.parse(ok("video", ["remove-silence", file("gap.mp4"), file("tight.mp4"), "--min", "1"]));
    assert.equal(result.cuts, 1);
    // 2s + 2s of tone, plus 0.1s of pause kept on each side.
    near(video.info(file("tight.mp4")).duration, 4.2, 0.2);
  });

  test("remove-fillers cuts um and stutters, with the pause after them", () => {
    // Tones stand in for words: "so" 0-1, "um" 1.3-1.6, "I" 1.9-2.2, "I" 2.4-2.7, "agree" 3-4.
    const on = "lt(t,1)+between(t,1.3,1.6)+between(t,1.9,2.2)+between(t,2.4,2.7)+between(t,3,4)";
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='0.5*sin(2*PI*300*t)*(${on})':d=4.3`, file("filler.wav")]);
    const words = [["so", 0, 1], ["um,", 1.3, 1.6], ["I", 1.9, 2.2], ["I", 2.4, 2.7], ["agree.", 3, 4]].map(([word, start, end]) => ({ word, start, end }));
    writeFileSync(file("filler.json"), JSON.stringify({ language: "en", text: "", words, segments: [] }));
    const result = JSON.parse(ok("video", ["remove-fillers", file("filler.wav"), file("no-filler.wav"), "--transcript", file("filler.json")]));
    assert.deepEqual(result.removed.map((r: any) => r.word), ["um,", "I"]);
    // Each cut runs to the end of the pause after the word: 0.3 + 0.3 and 0.3 + 0.2 seconds (minus a tiny margin).
    near(sound.info(file("no-filler.wav")).duration, 4.3 - 1.04, 0.1);
  });

  test("reframe crops to a phone shape", () => {
    ok("video", ["reframe", file("in.mp4"), file("tall.mp4"), "--aspect", "9:16"]);
    const details = video.info(file("tall.mp4"));
    assert.equal(details.height, 240);
    near(details.width / details.height, 9 / 16, 0.02);
    assert.equal(cli("video", ["reframe", file("in.mp4"), file("x.mp4"), "--aspect", "wide"]).code, 1);
  });

  test("reframe --follow keeps a moving subject in the crop", async (t) => {
    if (!hasModel("cutout")) return t.skip("cutout model not installed");
    // A red ball moving from the left to the right of a wide video.
    await paint(file("ball-small.png"), 100, 100, (x, y) => (inCircle(x, y, 50, 50, 45) ? RED : CLEAR));
    execFileSync(FFMPEG, [
      "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0xDDDDDD:s=640x360:r=30:d=3", "-i", file("ball-small.png"),
      "-filter_complex", "[0][1]overlay=x='20+t*170':y=130,format=yuv420p", file("moving.mp4"),
    ]);
    const result = JSON.parse(ok("video", ["reframe", file("moving.mp4"), file("follow.mp4"), "--aspect", "9:16", "--follow", "--smooth", "1"]));
    assert.deepEqual([result.width, result.height], [202, 360]);
    // The crop moves right with the ball, and the ball is near the middle of the crop halfway through.
    assert.ok(result.path.at(-1).x > result.path[0].x + 200, JSON.stringify(result.path));
    frameAt(file("follow.mp4"), 1.5, file("follow-mid.png"));
    assert.match(pixel(file("follow-mid.png"), 101, 180), /^srgb\(2[0-5]\d,[0-4]?\d,[0-4]?\d\)$/);
    // Where the ball is was cached: the same clip again (another shape) finds it without looking.
    const again = JSON.parse(ok("video", ["reframe", file("moving.mp4"), file("follow-square.mp4"), "--aspect", "1:1", "--follow"]));
    assert.ok(result.cached === 0 && again.cached >= again.samples - 1, JSON.stringify({ first: result.cached, again: again.cached, samples: again.samples }));
  });

  test("paths with quotes work in commands that list files for ffmpeg", () => {
    const folder = file("it's here");
    mkdirSync(folder, { recursive: true });
    ok("video", ["trim", file("in.mp4"), join(folder, "clip.mp4"), "--start", "0", "--end", "2"]);
    ok("video", ["reverse", join(folder, "clip.mp4"), join(folder, "back.mp4")]);
    near(video.info(join(folder, "back.mp4")).duration, 2);
    assert.equal(concatLine("/a/it's.mp4"), "file '/a/it'\\''s.mp4'");
  });

  test("a clip with two sound tracks (like iPhone spatial audio) keeps only the first", () => {
    execFileSync(FFMPEG, [
      "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x240:d=2", "-f", "lavfi", "-i", "sine=f=440:d=2", "-f", "lavfi", "-i", "sine=f=1000:d=2",
      "-map", "0", "-map", "1", "-map", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", file("two-tracks.mp4"),
    ]);
    ok("video", ["grade", file("two-tracks.mp4"), file("two-graded.mp4"), "--look", "warm"]);
    assert.equal(probe(file("two-graded.mp4")).streams.filter((s: any) => s.codec_type === "audio").length, 1);
  });

  test("generate explains what it needs", () => {
    const result = cli("video", ["generate", file("x.mp4")]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--prompt/);
  });

  test("pip puts a small video in a corner", () => {
    ok("video", ["pip", file("in.mp4"), file("silent.mp4"), file("pip.mp4"), "--corner", "top-left", "--size", "0.4"]);
    assert.equal(video.info(file("pip.mp4")).width, 320);
    frameAt(file("in.mp4"), 1, file("pip-before.png"));
    frameAt(file("pip.mp4"), 1, file("pip-after.png"));
    assert.ok(regionDiff(file("pip-before.png"), file("pip-after.png"), "100x60+20+20") > 0.05, "top-left corner unchanged");
    assert.ok(regionDiff(file("pip-before.png"), file("pip-after.png"), "100x60+210+170") < 0.03, "bottom-right corner changed");
  });

  test("interpolate raises the frame rate", () => {
    ok("video", ["interpolate", file("silent.mp4"), file("smooth.mp4"), "--fps", "60"]);
    assert.equal(video.info(file("smooth.mp4")).fps, 60);
  });

  test("captions from a transcript appear at the bottom", () => {
    const words = [
      { word: "Hello", start: 0.2, end: 0.7 },
      { word: "there", start: 0.8, end: 1.3 },
      { word: "friends.", start: 1.4, end: 2.2 },
    ];
    writeFileSync(file("words.json"), JSON.stringify({ words }));
    const result = JSON.parse(ok("video", ["captions", file("in.mp4"), file("captioned.mp4"), "--transcript", file("words.json"), "--style", "bold"]));
    assert.equal(result.words, 3);
    near(video.info(file("captioned.mp4")).duration, 3, 0.1);
    frameAt(file("in.mp4"), 1, file("cap-before.png"));
    frameAt(file("captioned.mp4"), 1, file("cap-after.png"));
    // The top half is untouched, the bottom third has the words.
    assert.ok(regionDiff(file("cap-before.png"), file("cap-after.png"), "320x100+0+0") < 0.03);
    assert.ok(regionDiff(file("cap-before.png"), file("cap-after.png"), "320x80+0+160") > 0.03);
  });

  test("captions --speakers colors each speaker's words", async () => {
    // Two speakers, one word each, on a black clip; minimal style so no word is highlighted.
    writeFileSync(file("speakers.json"), JSON.stringify({ words: [
      { word: "HELLO.", start: 0, end: 1, speaker: "A" }, // the full stop ends the caption
      { word: "HELLO", start: 1.5, end: 2.5, speaker: "B" },
    ] }));
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=black:size=320x240:rate=30", "-t", "3", "-pix_fmt", "yuv420p", file("black.mp4")]);
    ok("video", ["captions", file("black.mp4"), file("spk.mp4"), "--transcript", file("speakers.json"), "--style", "minimal", "--speakers"]);
    frameAt(file("spk.mp4"), 0.5, file("spk-a.png"));
    frameAt(file("spk.mp4"), 2, file("spk-b.png"));
    // The average color of the bright (letter) pixels in the bottom part.
    const colorOf = (path: string) => {
      const pixels = rgba(path, "320x80+0+160");
      let r = 0, b = 0, count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 1] < 150) continue; // not a letter
        r += pixels[i];
        b += pixels[i + 2];
        count++;
      }
      assert.ok(count > 50, "no caption letters found");
      return { r: r / count, b: b / count };
    };
    // Speaker A is white (red and blue alike); speaker B is light blue (much more blue than red).
    const a = colorOf(file("spk-a.png"));
    const b = colorOf(file("spk-b.png"));
    assert.ok(Math.abs(a.r - a.b) < 10, `speaker A not white: ${JSON.stringify(a)}`);
    assert.ok(b.b > b.r + 15, `speaker B not blue: ${JSON.stringify(b)}`);
  });

  test("errors: missing file and help", () => {
    assert.equal(cli("video", ["trim", file("nope.mp4"), file("x.mp4"), "--start", "0", "--end", "1"]).code, 1);
    assert.equal(cli("video", ["trim", file("in.mp4"), file("x.mp4"), "--start", "2", "--end", "1"]).code, 1);
    assert.equal(cli("video", []).code, 0);
  });
});

describe("movie", () => {
  // Movies made only of color, picture and video scenes, so these tests do not need Chrome.
  const write = (name: string, movie: object) => writeFileSync(file(name), JSON.stringify(movie));
  const basic = {
    size: "320x180",
    scenes: [
      { color: "red", duration: 1.5 },
      { image: "in.png", motion: "zoom-in", duration: 1.5, transition: "fade" },
      { video: "in.mp4", from: 0.5, to: 2.5, transition: { type: "wipeleft", duration: 0.5 } },
    ],
    audio: [{ file: "sound.mp3", volume: 0.5, duck: true, fadeOut: 1 }],
    sfx: [{ type: "whoosh", at: 1 }],
    look: "warm",
    effects: { vignette: 0.3 },
  };

  test("validate lists every problem with a hint", () => {
    write("bad.json", {
      size: "big",
      scenes: [
        { color: "red", duration: 1, transition: "fade" },
        { video: "missing.mp4" },
        { image: "in.png", motion: "spin", durration: 2 },
        { title: "x", color: "blue" },
        { color: "blue", transition: "teleport" },
      ],
      sfx: [{ type: "kazoo", at: 1 }],
    });
    const result = JSON.parse(ok("movie", ["validate", file("bad.json")]));
    assert.equal(result.valid, false);
    const all = result.errors.join("\n");
    for (const hint of [/size/, /first scene/, /missing\.mp4/, /motion "spin"/, /parallax-orbit/, /unknown key "durration"/, /exactly one of/, /transition "teleport"/, /kazoo/]) {
      assert.match(all, hint);
    }
    // Rendering a broken movie fails with the same list.
    const render = cli("movie", ["render", file("bad.json"), file("x.mp4")]);
    assert.equal(render.code, 1);
    assert.match(render.stderr, /missing\.mp4/);
  });

  test("layers move by keyframes and follow a tracked thing", async () => {
    await paint(file("square.png"), 40, 40, () => WHITE);
    // A made-up track: a 40x40 box moving from the left to the right of a 320x180 clip in 2 seconds.
    const points = [0, 1, 2].map((t) => ({ time: t, x: 20 + t * 120, y: 70, width: 40, height: 40 }));
    writeFileSync(file("box-track.json"), JSON.stringify({ label: "box", width: 320, height: 180, every: 1, points }));
    write("layers.json", {
      size: "320x180",
      scenes: [
        { color: "black", duration: 2, layers: [
          // Top strip: slides from x 0.25 to 0.75.
          { image: "square.png", width: 0.1, y: 0.15, keys: [{ time: 0, x: 0.25 }, { time: 1.9, x: 0.75 }] },
          // Middle: sits on the tracked box.
          { image: "square.png", width: 0.1, track: "box-track.json", anchor: "center", blend: "screen" },
        ] },
      ],
    });
    ok("movie", ["render", file("layers.json"), file("layers.mp4")]);
    frameAt(file("layers.mp4"), 0.05, file("layers-start.png"));
    frameAt(file("layers.mp4"), 1.95, file("layers-end.png"));
    const bright = (path: string, region: string) => mean(path, region) > 0.5;
    // Keyframes: left at the start, right at the end.
    assert.ok(bright(file("layers-start.png"), "20x10+70+22") && !bright(file("layers-start.png"), "20x10+230+22"));
    assert.ok(bright(file("layers-end.png"), "20x10+230+22") && !bright(file("layers-end.png"), "20x10+70+22"));
    // Tracking: the box centre is at x 40 at the start and x 280 at the end (y 90).
    assert.ok(bright(file("layers-start.png"), "10x10+35+85") && !bright(file("layers-start.png"), "10x10+275+85"));
    assert.ok(bright(file("layers-end.png"), "10x10+275+85"));
  });

  test("scene fx with keyframed amount and a GPU transition", (t) => {
    if (!hasRaylib) return t.skip("raylib not included for this system");
    write("gpu.json", {
      size: "320x180",
      scenes: [
        { color: "#ff0000", duration: 1 },
        // Inverted blue is yellow; the effect fades in over the first 0.4 s of the scene.
        { color: "#0000ff", duration: 1.5, transition: { type: "cube", duration: 0.5 }, fx: { effect: "invert", keys: [{ time: 0, amount: 0 }, { time: 0.4, amount: 1 }] } },
      ],
      fx: "vignette",
    });
    const result = JSON.parse(ok("movie", ["render", file("gpu.json"), file("gpu.mp4")]));
    near(result.duration, 2, 0.05); // 1 + 1.5 - 0.5
    const centre = (time: number) => {
      frameAt(file("gpu.mp4"), time, file("gpu.png"));
      return pixel(file("gpu.png"), 160, 90).match(/[\d.]+/g)!.map(Number);
    };
    const [r0, g0, b0] = centre(0.2);
    assert.ok(r0 > 200 && g0 < 50 && b0 < 50, `not red at the start: ${r0},${g0},${b0}`);
    const [r1, g1, b1] = centre(1.9);
    assert.ok(r1 > 200 && g1 > 200 && b1 < 60, `not yellow (inverted blue) at the end: ${r1},${g1},${b1}`);
  });

  test("validate explains the movie v2 keys", () => {
    write("bad2.json", {
      scenes: [
        { color: "red", fx: "sparkle", layers: [{ text: "hi", blend: "melt", keys: [{ time: 0, color: 1 }] }, { image: "in.png", text: "both" }] },
        { color: "blue", transition: "warp-speed", fx: { effect: "lut" } },
      ],
      voiceover: { text: "hello", reverb: "bathroom" },
    });
    const all = JSON.parse(ok("movie", ["validate", file("bad2.json")])).errors.join("\n");
    for (const hint of [/effect "sparkle"/, /blend "melt"/, /"color" cannot be keyframed/, /exactly one of image, video or text/, /transition "warp-speed"/, /lut effect needs/, /reverb "bathroom"/]) {
      assert.match(all, hint);
    }
  });

  test("templates write starting movies that name their placeholder files", () => {
    const list = JSON.parse(ok("movie", ["templates"])).templates;
    assert.ok(list.length >= 6);
    ok("movie", ["template", "slideshow", file("slides.json")]);
    const result = JSON.parse(ok("movie", ["validate", file("slides.json")]));
    assert.match(result.errors.join("\n"), /photo1\.jpg/);
  });

  test("render joins scenes with transitions, mixes sound, and checks the result", () => {
    write("basic.json", basic);
    const result = JSON.parse(ok("movie", ["render", file("basic.json"), file("movie.mp4")]));
    assert.equal(result.rendered, 3);
    // 1.5 + 1.5 + 2 seconds, minus the two transitions (0.5 each).
    near(result.duration, 4, 0.1);
    const details = video.info(file("movie.mp4"));
    assert.deepEqual([details.width, details.height], [320, 180]);
    assert.ok(details.hasAudio);
    near(details.duration, 4, 0.15);
    // The sound is made the online standard loudness.
    const level = JSON.parse(ok("listen", ["loudness", file("movie.mp4")]));
    assert.ok(Math.abs(level.lufs + 14) < 1.5, `lufs ${level.lufs}`);
    assert.ok("passed" in result.check);
  });

  test("render reuses unchanged scenes and drafts are smaller", () => {
    write("basic.json", basic);
    assert.equal(JSON.parse(ok("movie", ["render", file("basic.json"), file("movie2.mp4")])).cached, 3);
    // Change one scene: only that scene renders again.
    const changed = structuredClone(basic);
    changed.scenes[0].color = "blue";
    write("basic.json", changed);
    const again = JSON.parse(ok("movie", ["render", file("basic.json"), file("movie3.mp4")]));
    assert.deepEqual([again.rendered, again.cached], [1, 2]);
    const draft = JSON.parse(ok("movie", ["render", file("basic.json"), file("draft.mp4"), "--draft"]));
    assert.equal(draft.size, "106x60");
  });

  test("render --sheet, and held-still designed scenes are expected, not problems", () => {
    // A title and a plain color card hold still on purpose; check would call that frozen in any other video.
    write("still.json", { size: "320x180", scenes: [{ title: "Held", duration: 4 }, { color: "#224466", duration: 3, transition: "fade" }] });
    const result = JSON.parse(ok("movie", ["render", file("still.json"), file("still.mp4"), "--sheet", file("still-sheet.png")]));
    assert.equal(result.check.passed, true, JSON.stringify(result.check));
    assert.ok(result.check.expected?.some((e: string) => /frozen/.test(e)), JSON.stringify(result.check));
    assert.ok(existsSync(file("still-sheet.png")));
  });

  test("beatSync moves cuts onto the beat", () => {
    // The click track beats every 0.5s, so cuts at 1.3s and 2.6s move to about 1.5s and 2.5s.
    write("beats.json", {
      size: "160x90",
      beatSync: "click120.wav",
      scenes: [{ color: "red", duration: 1.3 }, { color: "blue", duration: 1.3 }, { color: "lime", duration: 1 }],
    });
    ok("movie", ["render", file("beats.json"), file("beats.mp4")]);
    const cuts = JSON.parse(ok("look", ["scenes", file("beats.mp4")])).cuts;
    assert.equal(cuts.length, 2);
    for (const cut of cuts) {
      const offBeat = Math.abs(cut - Math.round(cut * 2) / 2);
      assert.ok(offBeat < 0.08, `cut at ${cut} is not on a beat`);
    }
  });

  test("exact length with odd transitions, scene speed, film layers, and a sound change reuses the picture", async () => {
    await paint(file("white.png"), 40, 40, () => WHITE);
    const film = {
      size: "160x90",
      scenes: [
        { color: "#ff0000", duration: 1.37 },
        { video: "in.mp4", from: 0, to: 2, speed: 2, transition: { type: "fade", duration: 0.33 } }, // 1 second
        { color: "#0000ff", duration: 1.1, transition: { type: "wipeleft", duration: 0.27 } },
      ],
      layers: [{ image: "white.png", width: 0.2 }], // over the whole film, across the cuts
      audio: [{ file: "sound.mp3", volume: 0.5 }],
    };
    write("exact.json", film);
    const first = JSON.parse(ok("movie", ["render", file("exact.json"), file("exact.mp4")]));
    near(first.duration, 1.37 + 1 + 1.1 - 0.33 - 0.27, 0.05);
    near(video.info(file("exact.mp4")).duration, first.duration, 0.05);
    assert.equal(first.picture, "rendered");
    for (const time of [0.3, 2.7]) {
      frameAt(file("exact.mp4"), time, file("exact.png"));
      assert.ok(mean(file("exact.png"), "8x8+76+41") > 0.9, `no film layer at ${time}s`);
    }
    // Only the music volume changes: the picture comes from the cache and only the sound is mixed again.
    film.audio[0].volume = 0.2;
    write("exact.json", film);
    const again = JSON.parse(ok("movie", ["render", file("exact.json"), file("exact2.mp4")]));
    assert.match(again.picture, /cached/);
    near(again.duration, first.duration, 0.01);
  });

  test("validate explains speed, reframe and film layers", () => {
    write("bad3.json", {
      scenes: [{ color: "red", speed: 2 }, { video: "in.mp4", speed: 50, reframe: "spin" }],
      layers: [{ image: "in.png", track: "box-track.json" }],
    });
    const all = JSON.parse(ok("movie", ["validate", file("bad3.json")])).errors.join("\n");
    for (const hint of [/speed and reframe are for video scenes/, /speed is between 0\.1/, /reframe is "follow"/, /track/]) assert.match(all, hint);
  });
});

describe("voice", () => {
  const sentence = "The quick brown fox jumps over the lazy dog.";

  test("speak with Kokoro says the words, with word times (needs the kokoro and whisper models)", (t) => {
    if (!hasModel("kokoro") || !hasWhisper()) return t.skip("kokoro or whisper model not installed");
    const result = JSON.parse(ok("voice", ["speak", file("spoken.wav"), "--text", sentence, "--voice", "am_michael", "--words", file("spoken.json")]));
    assert.ok(result.duration > 1.5);
    assert.ok(result.words >= 9);
    // The word times use the script's own spelling.
    const words = JSON.parse(readFileSync(file("spoken.json"), "utf8")).words;
    assert.equal(words.at(-1).word, "dog.");
    assert.ok(words.at(-1).end <= result.duration + 0.1);
    const heard = JSON.parse(ok("listen", ["transcribe", file("spoken.wav"), file("heard.json"), "--model", "base"]));
    assert.match(heard.text.toLowerCase(), /quick brown fox/);
    assert.equal(heard.language, "en");
    assert.equal(cli("voice", ["speak", file("x.wav"), "--text", "hi", "--voice", "zz_nobody"]).code, 1);
  });

  test("speak in Spanish (espeak sounds) and transcribe finds the language", (t) => {
    if (!hasModel("kokoro") || !hasWhisper()) return t.skip("kokoro or whisper model not installed");
    ok("voice", ["speak", file("hola.wav"), "--text", "Hola a todos. Bienvenidos a nuestro estudio.", "--voice", "ef_dora"]);
    const heard = JSON.parse(ok("listen", ["transcribe", file("hola.wav"), file("hola.json")]));
    assert.equal(heard.language, "es");
    assert.match(heard.text.toLowerCase(), /bienvenidos/);
  });

  test("speak with macOS say (no pack needed)", (t) => {
    if (process.platform !== "darwin") return t.skip("say is macOS only");
    ok("voice", ["speak", file("say.wav"), "--text", sentence, "--engine", "say"]);
    assert.ok(sound.info(file("say.wav")).duration > 1.5);
  });

  test("clone refuses to run without consent", () => {
    execFileSync("say", ["-o", file("sample.aiff"), "This is a sample of my voice for the test."]);
    const result = cli("voice", ["clone", file("cloned.wav"), "--sample", file("sample.aiff"), "--text", "Hello there."]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--consent/);
  });

  test("clone with consent writes the voice and a consent record (needs the clone pack)", (t) => {
    if (!hasPack("clone")) return t.skip("clone pack not installed");
    const consent = "Test voice made with macOS say by the developer";
    ok("voice", ["clone", file("cloned.wav"), "--sample", file("sample.aiff"), "--text", "A brand new sentence.", "--consent", consent]);
    assert.ok(sound.info(file("cloned.wav")).duration > 0.5);
    const record = execFileSync("cat", [file("cloned.wav.consent.txt")], { encoding: "utf8" });
    assert.match(record, new RegExp(consent));
    assert.match(record, /sha256 [0-9a-f]{64}/);
  });

  test("stems separates a voice from drums (needs the stems pack)", (t) => {
    if (!hasPack("stems")) return t.skip("stems pack not installed");
    // 6s of drums, with speech only from 2s to about 4.5s.
    execFileSync("say", ["-o", file("words.aiff"), "Separate my voice from these drums please."]);
    execFileSync(FFMPEG, [
      "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "aevalsrc='0.7*sin(2*PI*(50+80*exp(-mod(t,0.5)*30))*t)*exp(-mod(t,0.5)*10)':s=44100:d=6",
      "-i", file("words.aiff"),
      "-filter_complex", "[1:a]aresample=44100,adelay=2000|2000[v];[0:a][v]amix=inputs=2:normalize=0:duration=first",
      file("band.wav"),
    ]);
    const result = JSON.parse(ok("voice", ["stems", file("band.wav"), file("stems"), "--only", "vocals"]));
    assert.deepEqual(result.stems, ["vocals", "without-vocals"]);
    // The vocal stem is much louder while the voice speaks than before it starts.
    assert.ok(loudness(join(file("stems"), "vocals.wav"), 1.8) < loudness(join(file("stems"), "vocals.wav")) - 10);
  });

  test("a movie voice-over is spoken, mixed and captioned (needs the kokoro and whisper models)", (t) => {
    if (!hasModel("kokoro") || !hasWhisper()) return t.skip("kokoro/whisper model missing");
    writeFileSync(file("vo.json"), JSON.stringify({
      size: "320x180",
      scenes: [{ color: "#203040", duration: 4 }],
      voiceover: { text: sentence, voice: "af_heart", at: 0.3 },
      captions: { style: "bold" },
    }));
    const result = JSON.parse(ok("movie", ["render", file("vo.json"), file("vo.mp4")]));
    assert.equal(result.warnings, undefined);
    frameAt(file("vo.mp4"), 1.5, file("vo.png"));
    frameAt(file("vo.mp4"), 0.05, file("vo-start.png"));
    assert.ok(regionDiff(file("vo-start.png"), file("vo.png"), "320x60+0+110") > 0.03, "no captions at 1.5s");
    assert.ok(loudness(file("vo.mp4")) > -40);
  });
});

describe("music", () => {
  const hasInstruments = () => JSON.parse(ok("joedit", ["packs"])).assets.find((a: any) => a.name === "instruments")?.installed;
  const score = {
    tempo: 120,
    bars: 4,
    tracks: [
      { instrument: "piano", chords: "C Am F G", rhythm: "block" },
      { instrument: "synth bass", chords: "C Am F G", rhythm: "bass" },
      { instrument: "flute", melody: "E5 D5 C5:2 - G4 C5:2" },
    ],
    drums: { style: "four-on-floor" },
  };

  test("compose writes a MIDI file without needing any sounds", () => {
    writeFileSync(file("score.json"), JSON.stringify(score));
    const result = JSON.parse(ok("music", ["compose", file("score.json"), file("score.mid")]));
    assert.equal(result.seconds, 8); // 4 bars of 4 beats at 120 BPM
    assert.equal(execFileSync("head", ["-c", "4", file("score.mid")], { encoding: "utf8" }), "MThd");
  });

  test("compose plays the score in time (needs the instruments asset)", (t) => {
    if (!hasInstruments()) return t.skip("instruments asset missing");
    writeFileSync(file("score.json"), JSON.stringify(score));
    ok("music", ["compose", file("score.json"), file("score.wav")]);
    near(sound.info(file("score.wav")).duration, 9.5, 0.2); // 8 seconds plus the last notes ringing out
    const beats = JSON.parse(ok("listen", ["beats", file("score.wav")]));
    assert.ok(Math.abs(beats.bpm - 120) <= 3, `bpm ${beats.bpm}`);
    const level = JSON.parse(ok("listen", ["loudness", file("score.wav")]));
    assert.equal(level.verdict, "good");
  });

  test("compose: a plucked guitar through a metal amp has bite, and --stems saves each part", (t) => {
    if (!hasInstruments()) return t.skip("instruments asset missing");
    const metal = {
      tempo: 140, bars: 4,
      tracks: [
        { instrument: "pluck", chords: "E5 E5 G5 A5", rhythm: "chug", octave: 2, double: true, fx: { amp: "metal" } },
        { instrument: "bass", chords: "E5 E5 G5 A5", rhythm: "bass", fx: { amp: "crunch", eq: { low: 3 } } },
      ],
      drums: { style: "rock" },
    };
    writeFileSync(file("metal.json"), JSON.stringify(metal));
    const result = JSON.parse(ok("music", ["compose", file("metal.json"), file("metal.wav"), "--stems", file("metal-stems")]));
    assert.deepEqual(result.stems.map((s: string) => s.split(/[\\/]/).pop()), ["1-pluck.wav", "2-bass.wav", "drums.wav"]);
    // Distorted guitars put real energy at 1-4 kHz (soft generated rock sits near -17 dB there).
    const bands = JSON.parse(ok("listen", ["bands", file("metal.wav")])).bands;
    assert.ok(bands["2 kHz"] > -10, JSON.stringify(bands));
    // In time, and bar 1 starts where the music starts.
    const beats = JSON.parse(ok("listen", ["beats", file("metal.wav")]));
    assert.ok(Math.abs(beats.bpm - 140) < 1, `bpm ${beats.bpm}`);
    assert.ok(beats.downbeats[0] < 0.1, `first downbeat ${beats.downbeats[0]}`);
  });

  test("compose explains bad chords, notes and instruments", () => {
    const bad = (part: object) => {
      writeFileSync(file("bad-score.json"), JSON.stringify({ tracks: [part] }));
      return cli("music", ["compose", file("bad-score.json"), file("x.mid")]);
    };
    assert.match(bad({ chords: "C Hm" }).stderr, /not a chord/);
    assert.match(bad({ melody: "C4 Q9" }).stderr, /not a note/);
    assert.match(bad({ instrument: "kazoo", melody: "C4" }).stderr, /Unknown instrument/);
    const list = JSON.parse(ok("music", ["instruments"]));
    assert.equal(list.instruments.length, 129); // the 128 General MIDI instruments and pluck
    assert.deepEqual(list.amps, ["clean", "crunch", "metal"]);
    assert.ok(list.drumStyles.includes("hiphop"));
  });

  test("a movie can use composed music and cut on its beat", (t) => {
    if (!hasInstruments()) return t.skip("instruments asset missing");
    writeFileSync(file("score.json"), JSON.stringify(score));
    writeFileSync(file("music-movie.json"), JSON.stringify({
      size: "160x90",
      music: { score: "score.json" },
      beatSync: true,
      scenes: [{ color: "red", duration: 1.3 }, { color: "blue", duration: 1.8 }, { color: "lime", duration: 2 }],
    }));
    ok("movie", ["render", file("music-movie.json"), file("music-movie.mp4")]);
    assert.ok(video.info(file("music-movie.mp4")).hasAudio);
    const cuts = JSON.parse(ok("look", ["scenes", file("music-movie.mp4")])).cuts;
    assert.equal(cuts.length, 2);
    for (const cut of cuts) assert.ok(Math.abs(cut - Math.round(cut * 2) / 2) < 0.05, `cut at ${cut} is not on a beat`);
  });

  test("song makes music from a description (needs the song pack)", (t) => {
    if (!hasPack("song")) return t.skip("song pack not installed");
    const result = JSON.parse(ok("music", ["song", file("song.wav"), "--prompt", "calm acoustic guitar instrumental", "--duration", "10", "--seed", "1"]));
    near(sound.info(file("song.wav")).duration, 10, 1);
    assert.equal(JSON.parse(ok("listen", ["loudness", file("song.wav")])).verdict, "good");
    assert.ok(result.seed !== undefined);
  });
});

describe("graphics", () => {
  // A page with a box that slides right by 100px per second (CSS animation) and a canvas
  // that is drawn from window.joedit (time, data and audio).
  const page = `<!doctype html><html><body style="margin:0;background:#000">
<div id="box" style="position:absolute;top:0;left:0;width:40px;height:40px;background:#fff;animation:go 2s linear forwards"></div>
<canvas id="c" width="160" height="40" style="position:absolute;top:50px;left:0"></canvas>
<style>@keyframes go{from{transform:translateX(0)}to{transform:translateX(200px)}}</style>
<script>
  window.joedit.render = () => {
    const c = document.getElementById("c").getContext("2d");
    const data = window.joedit.data || {};
    const fast = (window.joedit.audio || {}).bpm > 100;
    c.fillStyle = data.color || (fast ? "#0f0" : "#f00");
    c.fillRect(0, 0, 160, 40);
  };
</script></body></html>`;

  before(() => writeFileSync(file("page.html"), page));

  test("still is frozen in time: same time = same picture", (t) => {
    if (!hasChrome) return t.skip("Chrome not found");
    const size = ["--width", "320", "--height", "120"];
    ok("graphics", ["still", file("page.html"), file("t0.png"), "--time", "0", ...size]);
    ok("graphics", ["still", file("page.html"), file("t1.png"), "--time", "1", ...size]);
    ok("graphics", ["still", file("page.html"), file("t1-again.png"), "--time", "1", ...size]);
    // At 1 second the box has moved 100px.
    assert.equal(pixel(file("t0.png"), 20, 20), "srgb(255,255,255)");
    assert.equal(pixel(file("t1.png"), 20, 20), "srgb(0,0,0)");
    assert.equal(pixel(file("t1.png"), 120, 20), "srgb(255,255,255)");
    assert.equal(regionDiff(file("t1.png"), file("t1-again.png"), "320x120+0+0"), 0);
  });

  test("render makes a video with the right length and frames", (t) => {
    if (!hasChrome) return t.skip("Chrome not found");
    const result = JSON.parse(ok("graphics", ["render", file("page.html"), file("page.mp4"), "--duration", "1", "--fps", "10", "--width", "320", "--height", "120"]));
    assert.equal(result.frames, 10);
    const details = video.info(file("page.mp4"));
    assert.equal(details.width, 320);
    near(details.duration, 1, 0.15);
  });

  test("render passes --data and --audio to the page", (t) => {
    if (!hasChrome) return t.skip("Chrome not found");
    writeFileSync(file("data.json"), JSON.stringify({ color: "#00f" }));
    ok("graphics", ["still", file("page.html"), file("data.png"), "--time", "0", "--width", "320", "--height", "120", "--data", file("data.json")]);
    assert.equal(pixel(file("data.png"), 80, 70), "srgb(0,0,255)");
    // The click track is 120 BPM, so the page draws green, and the sound is in the video.
    ok("graphics", ["render", file("page.html"), file("beat.mp4"), "--duration", "1", "--fps", "10", "--width", "320", "--height", "120", "--audio", file("click120.wav")]);
    assert.ok(video.info(file("beat.mp4")).hasAudio);
    frameAt(file("beat.mp4"), 0.5, file("beat.png"));
    const [r, g] = pixel(file("beat.png"), 80, 70).match(/[\d.]+/g)!.map(Number);
    assert.ok(g > 200 && r < 50, `canvas not green: ${r},${g}`);
  });

  test("title, lower-third (see-through) and counter templates", () => {
    const size = ["--width", "640", "--height", "360"];
    ok("graphics", ["title", file("title.png"), "--text", "Hello joEdit", "--subtitle", "test", ...size]);
    assert.deepEqual(picture.info(file("title.png")), { width: 640, height: 360, format: "PNG" });
    ok("graphics", ["lower-third", file("lt.mov"), "--text", "Ada Lovelace", "--subtitle", "Engineer", "--duration", "1", ...size]);
    const stream = probe(file("lt.mov")).streams[0];
    assert.match(stream.pix_fmt, /a/, `no alpha: ${stream.pix_fmt}`);
    ok("graphics", ["counter", file("counter.mp4"), "--to", "100", "--duration", "1", ...size]);
    near(video.info(file("counter.mp4")).duration, 1, 0.15);
    assert.equal(cli("graphics", ["title", file("x.png")]).code, 1);
  });

  test("canvas runs the agent's draw code for each frame", () => {
    // A box that moves 100 px per second and is colored from --data.
    writeFileSync(file("draw.mjs"), `export default function draw(ctx, t, info) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, info.width, info.height);
      ctx.fillStyle = info.data.color;
      ctx.fillRect(t * 100, 0, 40, 40);
    }`);
    writeFileSync(file("box.json"), JSON.stringify({ color: "#ff0000" }));
    const size = ["--width", "320", "--height", "120", "--data", file("box.json")];
    ok("graphics", ["canvas", file("draw.mjs"), file("box0.png"), "--time", "0", ...size]);
    ok("graphics", ["canvas", file("draw.mjs"), file("box1.png"), "--time", "1", ...size]);
    assert.equal(pixel(file("box0.png"), 20, 20), "srgb(255,0,0)");
    assert.equal(pixel(file("box1.png"), 20, 20), "srgb(255,255,255)");
    assert.equal(pixel(file("box1.png"), 120, 20), "srgb(255,0,0)");
    const result = JSON.parse(ok("graphics", ["canvas", file("draw.mjs"), file("box.mp4"), "--duration", "1", "--fps", "10", ...size]));
    assert.equal(result.frames, 10);
    // A draw file with a mistake gives a clear error with its line.
    writeFileSync(file("bad.mjs"), "export default function draw(ctx) {\n  ctx.nope();\n}");
    assert.match(cli("graphics", ["canvas", file("bad.mjs"), file("bad.png"), "--time", "0"]).stderr, /nope.*bad\.mjs line 2/);
  });
});

describe("3d", () => {
  test("title renders 3D letters at the asked size", (t) => {
    if (!hasBlender) return t.skip("Blender not found");
    const result = JSON.parse(ok("3d", ["title", file("title3d.png"), "--text", "HELLO", "--width", "320", "--height", "180"]));
    assert.equal(result.output, file("title3d.png"));
    assert.deepEqual(picture.info(file("title3d.png")), { width: 320, height: 180, format: "PNG" });
    // The letters in the middle are brighter than the dark background in the corner.
    assert.ok(mean(file("title3d.png"), "120x40+100+50") > mean(file("title3d.png"), "40x30+0+0") + 0.05);
    assert.equal(cli("3d", ["title", file("x.png")]).code, 1); // no --text
  });

  test("render runs a scene script and animates it", (t) => {
    if (!hasBlender) return t.skip("Blender not found");
    writeFileSync(file("scene.py"), [
      'ball = shape("sphere", size=1, material=material("#FF3B30"))',
      "keyframe(ball, \"location\", {1: (-2, 0, 0.5), FRAMES: (2, 0, 0.5)})",
    ].join("\n"));
    const result = JSON.parse(ok("3d", ["render", file("scene.py"), file("scene.mp4"), "--duration", "0.5", "--width", "320", "--height", "180", "--draft"]));
    assert.equal(result.frames, 15);
    const details = video.info(file("scene.mp4"));
    assert.deepEqual([details.width, details.height], [160, 90]); // draft = half size
    frameAt(file("scene.mp4"), 0, file("scene-start.png"));
    frameAt(file("scene.mp4"), 0.45, file("scene-end.png"));
    assert.ok(regionDiff(file("scene-start.png"), file("scene-end.png"), "160x90+0+0") > 0.02);
  });

  test("--frame renders one moment of the full-length scene, and print() output comes back", (t) => {
    if (!hasBlender) return t.skip("Blender not found");
    writeFileSync(file("frames.py"), 'shape("cube")\nprint("frames", FRAMES)\n');
    const result = JSON.parse(ok("3d", ["render", file("frames.py"), file("frame30.png"), "--duration", "2", "--frame", "30", "--fps", "30", "--width", "160", "--height", "90", "--draft"]));
    assert.deepEqual(result.printed, ["frames 60"]);
  });

  test("Blender is found in the Windows install folders, newest version first", () => {
    const root = file("Blender Foundation");
    for (const version of ["Blender 4.2", "Blender 4.10", "Blender 5.0", "Blender 3.6"]) {
      mkdirSync(join(root, version), { recursive: true });
      if (version !== "Blender 5.0") writeFileSync(join(root, version, "blender.exe"), ""); // 5.0 is half-uninstalled
    }
    const found = threeD.windowsBlenders(root).map((p) => p.split(/[\\/]/).at(-2));
    assert.deepEqual(found, ["Blender 4.10", "Blender 4.2", "Blender 3.6"]);
  });

  test("a broken scene script reports its own line", (t) => {
    if (!hasBlender) return t.skip("Blender not found");
    writeFileSync(file("broken.py"), 'shape("pyramid")\n');
    const result = cli("3d", ["render", file("broken.py"), file("x.png")]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /broken\.py", line 1/);
    assert.match(result.stderr, /Unknown shape 'pyramid'/);
  });

  test("turntable spins a model", (t) => {
    if (!hasBlender) return t.skip("Blender not found");
    // A small pyramid written by hand as an .obj model.
    writeFileSync(file("pyramid.obj"), ["v -1 -1 0", "v 1 -1 0", "v 1 1 0", "v -1 1 0", "v 0 0 1.5", "f 1 2 5", "f 2 3 5", "f 3 4 5", "f 4 1 5", "f 1 4 3 2"].join("\n"));
    const result = JSON.parse(ok("3d", ["turntable", file("pyramid.obj"), file("turn.mp4"), "--duration", "1", "--width", "320", "--height", "180", "--draft"]));
    assert.equal(result.frames, 30);
    near(video.info(file("turn.mp4")).duration, 1, 0.1);
  });
});

describe("sound", () => {
  test("tone creates a sound", () => {
    ok("sound", ["tone", file("tone.wav"), "--frequency", "440", "--duration", "2"]);
    near(sound.info(file("tone.wav")).duration, 2);
  });

  test("info", () => {
    const result = JSON.parse(ok("sound", ["info", file("sound.mp3")]));
    assert.equal(result.codec, "mp3");
    assert.ok(result.sampleRate > 0);
    assert.ok(result.channels >= 1);
    near(result.duration, 5, 0.1);
  });

  test("info works on a video's sound", () => {
    near(sound.info(file("in.mp4")).duration, 3, 0.1);
  });

  test("info fails when there is no sound", () => {
    assert.equal(cli("sound", ["info", file("silent.mp4")]).code, 1);
  });

  test("trim", () => {
    ok("sound", ["trim", file("sound.mp3"), file("trim.mp3"), "--start", "1", "--end", "3"]);
    near(sound.info(file("trim.mp3")).duration, 2, 0.1);
  });

  test("volume makes it louder and quieter", () => {
    ok("sound", ["volume", file("sound.mp3"), file("loud.mp3"), "--factor", "2"]);
    ok("sound", ["volume", file("sound.mp3"), file("quiet.mp3"), "--factor", "0.5"]);
    const base = loudness(file("sound.mp3"));
    assert.ok(loudness(file("loud.mp3")) > base);
    assert.ok(loudness(file("quiet.mp3")) < base);
  });

  test("fade in makes the start quieter", () => {
    ok("sound", ["fade", file("sound.mp3"), file("fade.mp3"), "--in", "2", "--out", "2"]);
    assert.ok(loudness(file("fade.mp3"), 0.5) < loudness(file("sound.mp3"), 0.5) - 6);
    near(sound.info(file("fade.mp3")).duration, 5, 0.1);
  });

  test("fade needs --in or --out", () => {
    assert.equal(cli("sound", ["fade", file("sound.mp3"), file("x.mp3")]).code, 1);
  });

  test("speed 2x halves duration", () => {
    ok("sound", ["speed", file("sound.mp3"), file("fast.mp3"), "--factor", "2"]);
    near(sound.info(file("fast.mp3")).duration, 2.5, 0.1);
  });

  test("pitch keeps duration", () => {
    ok("sound", ["pitch", file("sound.mp3"), file("high.mp3"), "--semitones", "5"]);
    ok("sound", ["pitch", file("sound.mp3"), file("low.mp3"), "--semitones", "-12"]);
    near(sound.info(file("high.mp3")).duration, 5, 0.15);
    near(sound.info(file("low.mp3")).duration, 5, 0.15);
    assert.equal(cli("sound", ["pitch", file("sound.mp3"), file("x.mp3"), "--semitones", "20"]).code, 1);
  });

  test("reverse", () => {
    ok("sound", ["reverse", file("fade.mp3"), file("reverse.mp3")]);
    near(sound.info(file("reverse.mp3")).duration, 5, 0.1);
  });

  test("normalize", () => {
    ok("sound", ["normalize", file("quiet.mp3"), file("norm.wav")]);
    near(sound.info(file("norm.wav")).duration, 5, 0.1);
  });

  test("loop 3 times", () => {
    ok("sound", ["loop", file("tone.wav"), file("loop.wav"), "--times", "3"]);
    near(sound.info(file("loop.wav")).duration, 6);
  });

  test("concat different formats", () => {
    ok("sound", ["concat", file("tone.wav"), file("sound.mp3"), file("concat.mp3")]);
    near(sound.info(file("concat.mp3")).duration, 7, 0.15);
  });

  test("mix lasts as long as the longest input", () => {
    ok("sound", ["mix", file("tone.wav"), file("sound.mp3"), file("mix.mp3")]);
    near(sound.info(file("mix.mp3")).duration, 5, 0.15);
  });

  test("convert to wav", () => {
    ok("sound", ["convert", file("sound.mp3"), file("out.wav")]);
    assert.equal(sound.info(file("out.wav")).codec, "pcm_s16le");
  });

  test("sfx makes every effect type at an even level", () => {
    for (const type of sound.SFX_TYPES) {
      const result = JSON.parse(ok("sound", ["sfx", file(`sfx-${type}.wav`), "--type", type]));
      near(sound.info(file(`sfx-${type}.wav`)).duration, result.duration, 0.05);
      // Every effect is leveled so its loudest moment is -3 dB.
      const log = spawnSync(FFMPEG, ["-hide_banner", "-i", file(`sfx-${type}.wav`), "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
      const peak = Number(log.match(/max_volume: (-?[\d.]+) dB/)?.[1]);
      assert.ok(Math.abs(peak + 3) < 0.6, `${type} peaks at ${peak} dB`);
    }
    ok("sound", ["sfx", file("long-riser.wav"), "--type", "riser", "--duration", "5"]);
    near(sound.info(file("long-riser.wav")).duration, 5, 0.05);
    assert.equal(cli("sound", ["sfx", file("x.wav"), "--type", "kazoo"]).code, 1);
  });

  test("duck turns the music down while the voice speaks", () => {
    // Music: a 6s tone. Voice: a 2s tone from 2s to 4s.
    ok("sound", ["tone", file("duck-music.wav"), "--frequency", "220", "--duration", "6"]);
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=1000:duration=2", "-af", "adelay=2000|2000,apad=whole_dur=6", file("duck-voice.wav")]);
    ok("sound", ["duck", file("duck-music.wav"), file("duck-voice.wav"), file("ducked.wav"), "--amount", "12"]);
    // Measure just the music (low tone) before and during the voice.
    const music = (from: number) => {
      const log = spawnSync(FFMPEG, ["-hide_banner", "-ss", String(from), "-t", "1", "-i", file("ducked.wav"), "-af", "lowpass=f=400,volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
      return Number(log.match(/mean_volume: (-?[\d.]+) dB/)?.[1]);
    };
    assert.ok(music(0.5) - music(2.7) > 6, `music before ${music(0.5)} dB, under voice ${music(2.7)} dB`);
  });

  // Mean level in dB of part of a sound, after an optional filter.
  const level = (path: string, from = 0, length = 60, filter = "anull") => {
    const log = spawnSync(FFMPEG, ["-hide_banner", "-ss", String(from), "-t", String(length), "-i", path, "-af", `${filter},volumedetect`, "-f", "null", "-"], { encoding: "utf8" }).stderr;
    return Number(log.match(/mean_volume: (-?[\d.]+) dB/)?.[1] ?? -91);
  };

  test("duck starts dipping before the voice and reports when people speak", () => {
    const result = JSON.parse(ok("sound", ["duck", file("duck-music.wav"), file("duck-voice.wav"), file("ducked2.wav")]));
    assert.equal(result.speech.length, 1);
    near(result.speech[0][0], 2, 0.1);
    near(result.speech[0][1], 4, 0.1);
    // Already quieter in the 0.15 s right before the voice starts.
    assert.ok(level(file("ducked2.wav"), 0.5, 0.5) - level(file("ducked2.wav"), 1.8, 0.15) > 4, "no look-ahead dip");
  });

  test("timeline places, loops and pans clips from JSON", () => {
    writeFileSync(file("clips.json"), JSON.stringify([
      { file: "duck-music.wav", role: "music", loop: true, volume: 0.5 },
      { file: "tone.wav", at: 3, pan: -1 },
    ]));
    const result = JSON.parse(ok("sound", ["timeline", file("clips.json"), file("timeline.wav"), "--length", "8"]));
    near(sound.info(file("timeline.wav")).duration, 8, 0.05);
    near(result.speech[0][0], 3, 0.1);
    // Looped music is still playing at 7 s; the tone panned left is louder on the left.
    assert.ok(level(file("timeline.wav"), 6.5, 1) > -40, "loop stopped");
    const side = (pan: string) => level(file("timeline.wav"), 3.2, 1, `pan=mono|c0=${pan},highpass=f=300`);
    assert.ok(side("c0") - side("c1") > 20, "pan did not move the tone left");
  });

  test("fx adds a room echo that rings out", () => {
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=600:duration=0.5", file("blip.wav")]);
    ok("sound", ["fx", file("blip.wav"), file("blip-hall.wav"), "--reverb", "hall", "--mix", "0.5"]);
    assert.ok(sound.info(file("blip-hall.wav")).duration > 2.5, "no tail");
    assert.ok(level(file("blip-hall.wav"), 0.7, 0.5) > -60, "no echo after the sound ends");
    assert.equal(cli("sound", ["fx", file("blip.wav"), file("x.wav"), "--reverb", "bathroom"]).code, 1);
    assert.equal(cli("sound", ["fx", file("blip.wav"), file("x.wav")]).code, 1);
  });

  test("fx telephone voice cuts the lows; video keeps its picture", () => {
    // A low hum and a mid tone: the telephone keeps the mid tone and loses the hum.
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=120:duration=3", "-f", "lavfi", "-i", "sine=frequency=1500:duration=3", "-filter_complex", "[0][1]amix=inputs=2", file("two-tones.wav")]);
    ok("sound", ["fx", file("two-tones.wav"), file("phone.wav"), "--voice", "telephone"]);
    const lowShare = (path: string) => level(path, 0, 3, "lowpass=f=250") - level(path, 0, 3, "highpass=f=800");
    assert.ok(lowShare(file("two-tones.wav")) - lowShare(file("phone.wav")) > 15, "lows not cut");
    ok("sound", ["fx", file("in.mp4"), file("fx.mp4"), "--reverb", "room", "--width", "0"]);
    const streams = probe(file("fx.mp4")).streams.map((s: any) => s.codec_type);
    assert.deepEqual(streams.sort(), ["audio", "video"]);
    near(sound.info(file("fx.mp4")).duration, 3, 0.15);
  });

  test("design renders an agent-written Web Audio script", () => {
    writeFileSync(file("laser.js"), [
      "export default ({ ctx, duration, noise }) => {",
      "  const o = ctx.createOscillator();",
      "  o.frequency.setValueAtTime(1200, 0);",
      "  o.frequency.exponentialRampToValueAtTime(100, duration);",
      "  const hiss = ctx.createBufferSource();",
      "  hiss.buffer = noise(duration, 'pink');",
      "  o.connect(ctx.destination); hiss.connect(ctx.destination);",
      "  o.start(0); hiss.start(0);",
      "};",
    ].join("\n"));
    ok("sound", ["design", file("laser.js"), file("laser.wav"), "--duration", "1.5"]);
    near(sound.info(file("laser.wav")).duration, 1.5, 0.05);
    assert.ok(level(file("laser.wav")) > -30);
    writeFileSync(file("silent.js"), "export default () => {};");
    assert.match(cli("sound", ["design", file("silent.js"), file("x.wav")]).stderr, /silence/);
  });

  test("denoise removes hiss and keeps the tone", () => {
    execFileSync(FFMPEG, [
      "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "anoisesrc=d=3:c=white:a=0.05",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-filter_complex", "[0][1]amix=inputs=2:normalize=0", file("hiss.wav"),
    ]);
    ok("sound", ["denoise", file("hiss.wav"), file("no-hiss.wav")]);
    const band = (path: string, filter: string) => {
      const log = spawnSync(FFMPEG, ["-hide_banner", "-i", path, "-af", `${filter},volumedetect`, "-f", "null", "-"], { encoding: "utf8" }).stderr;
      return Number(log.match(/mean_volume: (-?[\d.]+) dB/)?.[1]);
    };
    assert.ok(band(file("hiss.wav"), "highpass=f=2000") - band(file("no-hiss.wav"), "highpass=f=2000") > 6, "hiss not reduced");
    assert.ok(Math.abs(band(file("hiss.wav"), "bandpass=f=440:w=50") - band(file("no-hiss.wav"), "bandpass=f=440:w=50")) < 2, "tone changed");
  });

  test("eq boosts bass and cuts treble", () => {
    ok("sound", ["eq", file("hiss.wav"), file("eq.wav"), "--bass", "8", "--treble", "-8"]);
    assert.ok(loudness(file("eq.wav")) !== loudness(file("hiss.wav")));
    assert.equal(cli("sound", ["eq", file("hiss.wav"), file("x.wav")]).code, 1);
  });

  test("match moves the tonal balance toward a reference", () => {
    // A dull sound (low hum) matched to a bright one (high tone with noise) gets more treble.
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=110:d=4", "-f", "lavfi", "-i", "anoisesrc=d=4:a=0.05", "-filter_complex", "amix=inputs=2", file("dull.wav")]);
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=3000:d=4", "-f", "lavfi", "-i", "anoisesrc=d=4:a=0.3", "-filter_complex", "amix=inputs=2", file("bright.wav")]);
    const result = JSON.parse(ok("sound", ["match", file("dull.wav"), file("matched.wav"), "--reference", file("bright.wav")]));
    const gap = (levels: Record<string, number>) => Math.abs(levels["4 kHz"] - result.reference["4 kHz"]);
    assert.ok(gap(result.after) < gap(result.before), JSON.stringify(result));
    near(sound.info(file("matched.wav")).duration, 4);
  });

  test("errors: missing file and help", () => {
    assert.equal(cli("sound", ["volume", file("nope.mp3"), file("x.mp3"), "--factor", "2"]).code, 1);
    assert.equal(cli("sound", ["mix", file("sound.mp3"), file("x.mp3")]).code, 1);
    assert.equal(cli("sound", ["help"]).code, 0);
  });
});

describe("look", () => {
  test("sheet makes a labelled grid of frames", () => {
    const result = JSON.parse(ok("look", ["sheet", file("in.mp4"), file("sheet.png"), "--count", "4", "--width", "160"]));
    assert.equal(result.times.length, 4);
    // 2x2 grid of 160px frames, plus spacing and a title.
    const size = picture.info(file("sheet.png"));
    assert.ok(size.width >= 320 && size.width < 400, `width ${size.width}`);
    assert.ok(size.height > 240, `height ${size.height}`);
  });

  test("sheet explains that sound files have no picture", () => {
    const result = cli("look", ["sheet", file("sound.mp3"), file("x.png")]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /listen wave/);
  });

  test("strip makes one row of frames", () => {
    const result = JSON.parse(ok("look", ["strip", file("in.mp4"), file("strip.png"), "--start", "1", "--end", "2", "--count", "5", "--width", "100"]));
    assert.deepEqual(result.times, [1, 1.25, 1.5, 1.75, 2]);
    const size = picture.info(file("strip.png"));
    assert.ok(size.width >= 500 && size.width > size.height * 3, `${size.width}x${size.height}`);
  });

  test("scenes finds the cut between two clips", () => {
    ok("video", ["concat", file("in.mp4"), file("silent.mp4"), file("two-shots.mp4")]);
    const result = JSON.parse(ok("look", ["scenes", file("two-shots.mp4")]));
    assert.equal(result.count, 1);
    assert.ok(Math.abs(result.cuts[0] - 3) < 0.1, `cut at ${result.cuts[0]}`);
  });

  test("compare: same picture scores 0, different pictures more", () => {
    ok("picture", ["flip", file("in.png"), file("flipped.png"), "--direction", "horizontal"]);
    const same = JSON.parse(ok("look", ["compare", file("in.png"), file("in.png"), file("same.png")]));
    const different = JSON.parse(ok("look", ["compare", file("in.png"), file("flipped.png"), file("different.png")]));
    assert.equal(same.difference, 0);
    assert.equal(same.same, true);
    assert.ok(different.difference > 0.1);
    assert.equal(different.same, false);
    // Three panels side by side: first, second, differences.
    assert.ok(picture.info(file("different.png")).width > 1200);
  });

  test("colors finds the main colors and their shares", () => {
    // in.png is 3/4 red and 1/4 blue.
    const result = JSON.parse(ok("look", ["colors", file("in.png"), "--count", "4", "--swatch", file("swatch.png")]));
    assert.equal(result.colors.length, 2, JSON.stringify(result.colors));
    // Color reduction may land a step off (e.g. #0100FE), so compare each channel loosely.
    const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const close = (hex: string, expected: string) => channels(hex).every((v, i) => Math.abs(v - channels(expected)[i]) <= 4);
    assert.ok(close(result.colors[0].hex, "#FF0000"), result.colors[0].hex);
    near(result.colors[0].share, 0.75, 0.02);
    assert.ok(close(result.colors[1].hex, "#0000FF"), result.colors[1].hex);
    assert.ok(existsSync(file("swatch.png")));
  });

  test("find locates the moment that matches a description", async (t) => {
    if (!hasModel("vision")) return t.skip("vision model not installed");
    // 2s of blue sky color, 2s of a red ball on white, 2s of green: the ball is at 2-4s.
    await paint(file("ball.png"), 320, 240, (x, y) => (inCircle(x, y, 160, 120, 80) ? RED : WHITE));
    execFileSync(FFMPEG, [
      "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=0x3B82F6:s=320x240:r=30:d=2",
      "-loop", "1", "-t", "2", "-r", "30", "-i", file("ball.png"),
      "-f", "lavfi", "-i", "color=c=0x16A34A:s=320x240:r=30:d=2",
      "-filter_complex", "[0][1][2]concat=n=3:v=1[v]", "-map", "[v]", "-pix_fmt", "yuv420p", file("find.mp4"),
    ]);
    const result = JSON.parse(ok("look", ["find", file("find.mp4"), "--query", "a red ball", "--top", "1", "--sheet", file("found.png")]));
    const best = result.matches[0];
    assert.ok(best.time > 2 && best.time < 4, `best match at ${best.time}`);
    near(best.start, 2, 0.01);
    near(best.end, 4, 0.01);
    assert.ok(existsSync(file("found.png")));
  });

  // A real photo that comes with macOS (an iPhone-style .heic), so no download is needed.
  const ZEBRA = "/Library/User Pictures/Animals/Zebra.heic";

  test("objects finds and boxes things in a photo (needs the objects model)", (t) => {
    if (!hasModel("objects") || !existsSync(ZEBRA)) return t.skip("objects model or macOS sample photo missing");
    const result = JSON.parse(ok("look", ["objects", ZEBRA, "--draw", file("zebra-boxes.png")]));
    const zebra = result.things.find((thing: any) => thing.label === "zebra");
    assert.ok(zebra && zebra.score > 0.8, JSON.stringify(result.things));
    assert.ok(zebra.width > 300 && zebra.height > 300);
    assert.equal(picture.info(file("zebra-boxes.png")).width, 512);
    assert.match(cli("look", ["objects", ZEBRA, "--what", "kazoo"]).stderr, /knows: face, person/);
  });

  test("read finds the text in a picture, and when text shows in a video (needs the read model)", (t) => {
    if (!hasModel("read")) return t.skip("read model not installed");
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x334455:s=1280x720", "-frames:v", "1", file("sign.png")]);
    ok("picture", ["text", file("sign.png"), file("sign.png"), "--text", "GRAND OPENING", "--x", "100", "--y", "150", "--size", "90"]);
    const result = JSON.parse(ok("look", ["read", file("sign.png"), "--draw", file("sign-boxes.png")]));
    assert.equal(result.text, "GRAND OPENING");
    assert.ok(Math.abs(result.lines[0].x - 100) < 15 && Math.abs(result.lines[0].y - 160) < 30, JSON.stringify(result.lines));
    assert.ok(existsSync(file("sign-boxes.png")));
    // A video: the sign for 2 s, then a second line joins it for 2 s.
    ok("picture", ["text", file("sign.png"), file("sign2.png"), "--text", "THANKS FOR COMING", "--x", "100", "--y", "450", "--size", "70"]);
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-loop", "1", "-t", "2", "-i", file("sign.png"), "-loop", "1", "-t", "2", "-i", file("sign2.png"),
      "-filter_complex", "[0][1]concat=n=2:v=1:a=0,format=yuv420p", file("signs.mp4")]);
    const texts = JSON.parse(ok("look", ["read", file("signs.mp4")])).texts;
    assert.deepEqual(texts.map((x: any) => [x.text, x.start, x.end]), [["GRAND OPENING", 0, 4], ["THANKS FOR COMING", 2, 4]]);
  });

  test("index logs a folder of footage, and only looks again at files that changed", () => {
    const folder = file("footage");
    mkdirSync(folder, { recursive: true });
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x334455:s=640x360", "-frames:v", "1", join(folder, "card.png")]);
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x240:d=2", "-f", "lavfi", "-i", "sine=f=440:d=2", "-shortest", "-pix_fmt", "yuv420p", join(folder, "clip.mp4")]);
    const first = JSON.parse(ok("look", ["index", folder]));
    assert.deepEqual([first.files, first.looked, first.reused], [2, 2, 0]);
    const log = JSON.parse(readFileSync(join(folder, "index.json"), "utf8")).files;
    assert.equal(log["card.png"].kind, "picture");
    assert.equal(log["card.png"].colors[0], "#334455");
    assert.equal(log["clip.mp4"].kind, "video");
    assert.ok(Math.abs(log["clip.mp4"].duration - 2) < 0.1 && log["clip.mp4"].lufs < 0);
    const again = JSON.parse(ok("look", ["index", folder]));
    assert.deepEqual([again.looked, again.reused], [0, 2]);
    // --only picks parts; asking for other parts looks again. Progress goes to stderr, the result to stdout.
    const only = cli("look", ["index", folder, "--only", "cuts", "--output", join(folder, "cuts.json")]);
    assert.equal(only.code, 0, only.stderr);
    assert.match(only.stderr, /index: 1\/2/);
    const cuts = JSON.parse(readFileSync(join(folder, "cuts.json"), "utf8")).files;
    assert.ok(!("colors" in cuts["clip.mp4"]) && "cuts" in cuts["clip.mp4"], JSON.stringify(cuts["clip.mp4"]));
    assert.match(cli("look", ["index", folder, "--only", "smells"]).stderr, /smells/);
  });

  test("objects and track follow a thing moving through a video", (t) => {
    if (!hasModel("objects") || !existsSync(ZEBRA)) return t.skip("objects model or macOS sample photo missing");
    // A zebra photo sliding from left to right over a gray background for 3 seconds.
    execFileSync(FFMPEG, [
      "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=640x360:r=25:d=3", "-i", ZEBRA,
      "-filter_complex", "[1]scale=220:220[z];[0][z]overlay=x='20+t*120':y=70", "-pix_fmt", "yuv420p", file("zebra.mp4"),
    ]);
    const seen = JSON.parse(ok("look", ["objects", file("zebra.mp4"), "--every", "0.5", "--draw", file("zebra-sheet.png")]));
    const zebra = seen.seen.find((s: any) => s.label === "zebra");
    assert.ok(zebra, JSON.stringify(seen));
    assert.equal(zebra.most, 1);
    assert.ok(zebra.moments[0][0] <= 0.5 && zebra.moments.at(-1)[1] >= 2.5);
    const result = JSON.parse(ok("look", ["track", file("zebra.mp4"), file("zebra-track.json"), "--what", "zebra", "--every", "0.25"]));
    assert.ok(result.coverage > 0.8, JSON.stringify(result));
    const { points, width } = JSON.parse(readFileSync(file("zebra-track.json"), "utf8"));
    assert.equal(width, 640);
    // The box moves right by about 120 pixels a second.
    const speed = (points.at(-1).x - points[0].x) / (points.at(-1).time - points[0].time);
    assert.ok(speed > 90 && speed < 150, `moves ${speed} px/s`);
  });

  test("faces finds faces, and blur-faces hides them in a moving video (needs the faces model and image pack)", (t) => {
    if (!hasModel("faces") || !hasPack("image")) return t.skip("faces model or image pack missing");
    // A made-up photo of two people (made on this computer), then a 2 s pan across it.
    ok("picture", ["generate", file("people.jpg"), "--prompt", "candid photo of two friends laughing at a cafe table, faces visible", "--width", "768", "--height", "512", "--seed", "7"]);
    const found = JSON.parse(ok("look", ["faces", file("people.jpg")]));
    assert.equal(found.count, 2, JSON.stringify(found));
    execFileSync(FFMPEG, [
      "-loglevel", "error", "-y", "-loop", "1", "-i", file("people.jpg"), "-f", "lavfi", "-i", "sine=frequency=300:duration=2",
      "-filter_complex", "[0]scale=960:-2,crop=640:480:x='80*t':y=40,format=yuv420p[v]", "-map", "[v]", "-map", "1:a", "-t", "2", "-r", "25", file("people.mp4"),
    ]);
    const result = JSON.parse(ok("video", ["blur-faces", file("people.mp4"), file("blurred.mp4")]));
    assert.equal(result.mostFaces, 2);
    assert.ok(video.info(file("blurred.mp4")).hasAudio);
    // The face is now smooth: its detail (difference from a blurred copy) drops a lot; the table below does not change.
    const detail = (path: string, region: string) => {
      const log = spawnSync(FFMPEG, ["-hide_banner", "-ss", "1", "-i", path, "-frames:v", "1", "-vf", `crop=${region},edgedetect,signalstats,metadata=print`, "-f", "null", "-"], { encoding: "utf8" }).stderr;
      return Number(log.match(/YAVG=([\d.]+)/)?.[1] ?? 0);
    };
    assert.ok(detail(file("blurred.mp4"), "60:80:150:90") < detail(file("people.mp4"), "60:80:150:90") * 0.5, "face not blurred");
  });
});

describe("listen", () => {
  test("subtitles turns a transcript into .srt and .vtt files", () => {
    writeFileSync(file("sub-words.json"), JSON.stringify({ words: [
      { word: "Hello", start: 0.5, end: 0.9 }, { word: "there.", start: 1.0, end: 1.4 },
      { word: "Second", start: 3.0, end: 3.5 }, { word: "line", start: 3.6, end: 4.0 },
    ] }));
    const result = JSON.parse(ok("listen", ["subtitles", file("sub-words.json"), file("subs.srt")]));
    assert.equal(result.lines, 2);
    const srt = readFileSync(file("subs.srt"), "utf8");
    assert.match(srt, /^1\n00:00:00,500 --> 00:00:01,700\nHello there\.\n\n2\n00:00:03,000 --> 00:00:04,300\nSecond line\n/);
    ok("listen", ["subtitles", file("sub-words.json"), file("subs.vtt")]);
    assert.match(readFileSync(file("subs.vtt"), "utf8"), /^WEBVTT\n\n00:00:00\.500 --> /);
    assert.equal(cli("listen", ["subtitles", file("sub-words.json"), file("subs.txt")]).code, 1);
  });

  test("wave and spectrum make pictures", () => {
    ok("listen", ["wave", file("gap.wav"), file("wave.png"), "--width", "800", "--height", "200"]);
    ok("listen", ["spectrum", file("in.mp4"), file("spectrum.png")]);
    assert.deepEqual(picture.info(file("wave.png")), { width: 800, height: 224, format: "PNG" });
    assert.ok(picture.info(file("spectrum.png")).width >= 1200);
  });

  test("loudness measures and judges the sound", () => {
    const quiet = JSON.parse(ok("listen", ["loudness", file("gap.wav")]));
    assert.ok(quiet.lufs < -20);
    assert.match(quiet.verdict, /too quiet/);
    assert.match(quiet.issues[0].fix, /sound normalize/);
    // After normalize it should be near -14 LUFS and judged good.
    ok("sound", ["normalize", file("gap.wav"), file("gap-normal.wav")]);
    const normal = JSON.parse(ok("listen", ["loudness", file("gap-normal.wav")]));
    assert.ok(Math.abs(normal.lufs + 14) < 1.5, `lufs ${normal.lufs}`);
    assert.equal(normal.verdict, "good");
  });

  test("silences finds the gap", () => {
    const result = JSON.parse(ok("listen", ["silences", file("gap.wav")]));
    assert.equal(result.count, 1);
    assert.ok(Math.abs(result.silences[0].start - 2) < 0.1);
    assert.ok(Math.abs(result.silences[0].end - 5) < 0.1);
  });

  test("beats finds 120 BPM in a click track", () => {
    const result = JSON.parse(ok("listen", ["beats", file("click120.wav")]));
    assert.ok(Math.abs(result.bpm - 120) <= 3, `bpm ${result.bpm}`);
    assert.ok(result.count >= 14);
    // Beats should land on the clicks (every 0.5s).
    for (const time of result.beats) {
      const offBy = Math.abs(time - Math.round(time * 2) / 2);
      assert.ok(offBy < 0.06, `beat at ${time} is not on a click`);
    }
  });

  test("beats finds downbeats: the click track's loud first click of each bar", () => {
    // 120 BPM, the first click of every 4 is a loud low thump: downbeats every 2 seconds, from the start.
    execFileSync(FFMPEG, [
      "-loglevel", "error", "-y", "-f", "lavfi",
      "-i", "aevalsrc='0.4*sin(2*PI*1000*t)*lt(mod(t,0.5),0.03)+0.9*sin(2*PI*60*t)*lt(mod(t,2),0.08)':s=44100:d=8",
      file("bars120.wav"),
    ]);
    const result = JSON.parse(ok("listen", ["beats", file("bars120.wav")]));
    assert.ok(result.bars >= 3, JSON.stringify(result));
    for (const time of result.downbeats) assert.ok(Math.abs(time - Math.round(time / 2) * 2) < 0.08, `downbeat at ${time}`);
  });

  test("bands and energy describe tonal balance and where it gets loud", () => {
    // Low hum for 3 seconds, then a bright tone joins (a "drop").
    execFileSync(FFMPEG, [
      "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=60:d=6", "-f", "lavfi", "-i", "sine=f=4000:d=3",
      "-filter_complex", "[1]adelay=3000|3000,volume=4[b];[0][b]amix=inputs=2:duration=first", file("drop.wav"),
    ]);
    const bands = JSON.parse(ok("listen", ["bands", file("drop.wav"), "--reference", file("click120.wav")]));
    assert.ok(bands.bands["63 Hz"] > bands.bands["1 kHz"], JSON.stringify(bands));
    assert.ok("difference" in bands && "4 kHz" in bands.difference);
    const energy = JSON.parse(ok("listen", ["energy", file("drop.wav")]));
    assert.ok(energy.jumps.some((j: any) => Math.abs((j.time ?? j) - 3) < 0.3), JSON.stringify(energy.jumps));
  });

  test("beats needs at least 3 seconds", () => {
    ok("sound", ["trim", file("click120.wav"), file("short.wav"), "--start", "0", "--end", "2"]);
    assert.equal(cli("listen", ["beats", file("short.wav")]).code, 1);
  });

  test("speakers tells two voices apart, sentence by sentence (needs the whisper and speakers models)", (t) => {
    if (!hasWhisper() || !hasModel("speakers") || process.platform !== "darwin") return t.skip("whisper/speakers model missing (or not macOS)");
    const lines: [string, string][] = [
      ["Daniel", "Welcome back to the show. Today we are talking about editing video."],
      ["Samantha", "Thanks for having me. I have been looking forward to this."],
      ["Daniel", "Let's start with the basics. What does your workflow look like?"],
    ];
    lines.forEach(([voice, text], n) => execFileSync("say", ["-v", voice, "-o", file(`talk${n}.aiff`), text]));
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", ...lines.flatMap((_, n) => ["-i", file(`talk${n}.aiff`)]), "-filter_complex", "concat=n=3:v=0:a=1", file("talk.wav")]);
    const result = JSON.parse(ok("listen", ["speakers", file("talk.wav"), file("talk.json")]));
    assert.deepEqual(result.speakers.map((s: any) => s.name), ["S1", "S2"]);
    const segments = JSON.parse(readFileSync(file("talk.json"), "utf8")).segments;
    const order = segments.map((s: any) => s.speaker).filter((s: string, n: number, all: string[]) => s !== all[n - 1]);
    assert.deepEqual(order, ["S1", "S2", "S1"]);
    assert.ok(JSON.parse(readFileSync(file("talk.json"), "utf8")).words.every((w: any) => w.speaker));
  });

  test("find hears where a sound is, and skips silence (needs the sounds model)", (t) => {
    if (!hasModel("sounds")) return t.skip("sounds model not installed");
    ok("sound", ["sfx", file("boom.wav"), "--type", "boom"]);
    ok("sound", ["sfx", file("ding.wav"), "--type", "ding"]);
    // boom 0-4 s, silence 4-8 s, ding 8-12 s
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-i", file("boom.wav"), "-i", file("ding.wav"), "-filter_complex",
      "[0]aresample=48000,apad=whole_dur=8[a];[1]aresample=48000,apad=whole_dur=4[b];[a][b]concat=n=2:v=0:a=1", "-ac", "1", file("scene.wav")]);
    const bell = JSON.parse(ok("listen", ["find", file("scene.wav"), "--query", "bell", "--top", "1"]));
    assert.ok(bell.matches[0].start >= 6 && bell.matches[0].score > 0.3, JSON.stringify(bell));
    const boom = JSON.parse(ok("listen", ["find", file("scene.wav"), "--query", "explosion", "--top", "1"]));
    assert.ok(boom.matches[0].end <= 6, JSON.stringify(boom));
    assert.ok(boom.searched < 6, "the silent windows are skipped");
  });

  test("transcribe gives words with times (needs the whisper model)", (t) => {
    if (!hasWhisper() || process.platform !== "darwin") return t.skip("whisper model not installed (or not macOS)");
    execFileSync("say", ["-o", file("speech.aiff"), "Hello world. This is a test."]);
    const result = JSON.parse(ok("listen", ["transcribe", file("speech.aiff"), file("speech.json")]));
    assert.match(result.text.toLowerCase(), /hello/);
    assert.ok(result.words >= 5);
  });
});

describe("fx", () => {
  // A 2 s clip of one color with a tone, to check colors exactly.
  before(() => {
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x204080:s=320x180:r=30:d=2", "-f", "lavfi", "-i", "sine=f=440:d=2",
      "-shortest", "-pix_fmt", "yuv420p", file("fx-a.mp4")]);
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0xE0C020:s=320x180:r=30:d=2", "-pix_fmt", "yuv420p", file("fx-b.mp4")]);
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x204080:s=64x64", "-frames:v", "1", file("fx-still.png")]);
  });
  const near = (actual: string, r: number, g: number, b: number) => {
    const [ar, ag, ab] = actual.match(/\d+/g)!.map(Number);
    assert.ok(Math.abs(ar - r) <= 6 && Math.abs(ag - g) <= 6 && Math.abs(ab - b) <= 6, `${actual} is not near ${r},${g},${b}`);
  };

  test("raylib is included for every system, and missing driver functions are explained", () => {
    for (const [platform, arch] of [["darwin", "arm64"], ["win32", "x64"], ["linux", "x64"], ["linux", "arm64"]]) {
      assert.ok(existsSync(fx.raylibFile(platform as NodeJS.Platform, arch as NodeJS.Architecture)), `${platform} ${arch}`);
    }
    // On Windows the shader functions come from the driver by name; a driver without one says so.
    assert.throws(() => fx.driverFunction(need("koffi"), "uint glCreateShader(uint)", () => null), /graphics driver has no glCreateShader/);
  });

  test("list names the effects and about 80 transitions", (t) => {
    if (!hasRaylib) return t.skip("raylib not included for this system");
    const all = JSON.parse(ok("fx", ["list"]));
    assert.ok(all.count.effects >= 40 && all.count.transitions >= 70, JSON.stringify(all.count));
    assert.ok(all.looks.bloom && all.particles.snow && all.transitions["cross-zoom"] !== undefined && all.transitions["whip-left"] !== undefined);
  });

  test("apply changes every frame and keeps the length and sound", (t) => {
    if (!hasRaylib) return t.skip("raylib not included for this system");
    const result = JSON.parse(ok("fx", ["apply", file("fx-a.mp4"), file("fx-inverted.mp4"), "--effect", "invert"]));
    assert.equal(result.frames, 60);
    assert.ok(Math.abs(result.made.duration - 2) < 0.1 && result.made.hasAudio);
    ok("video", ["frame", file("fx-inverted.mp4"), file("fx-inverted.png"), "--time", "1"]);
    near(pixel(file("fx-inverted.png"), 100, 100), 0xdf, 0xbf, 0x7f);
    // amount 0.5 is halfway between the original and the effect
    ok("fx", ["apply", file("fx-still.png"), file("fx-half.png"), "--effect", "invert", "--amount", "0.5"]);
    near(pixel(file("fx-half.png"), 10, 10), 128, 128, 128);
  });

  test("apply chains effects, takes settings and turns a picture into a clip", (t) => {
    if (!hasRaylib) return t.skip("raylib not included for this system");
    ok("fx", ["apply", file("fx-still.png"), file("fx-tinted.png"), "--effect", "bw,duotone", "--set", "dark=#000000,light=#FF0000"]);
    const [r, g, b] = pixel(file("fx-tinted.png"), 10, 10).match(/\d+/g)!.map(Number);
    assert.ok(r > 20 && r < 40 && g < 5 && b < 5, `${r},${g},${b}`); // dark blue -> gray 0.21 -> red 0.11
    const clip = JSON.parse(ok("fx", ["apply", file("fx-still.png"), file("fx-snow.mp4"), "--effect", "snow", "--duration", "1.5"]));
    assert.ok(Math.abs(clip.made.duration - 1.5) < 0.1);
    assert.match(cli("fx", ["apply", file("fx-still.png"), file("x.png"), "--effect", "bloom", "--set", "speed=2"]).stderr, /bloom.radius/);
    assert.match(cli("fx", ["apply", file("fx-still.png"), file("x.png"), "--effect", "sparkle"]).stderr, /Unknown effect/);
  });

  test("apply runs a .cube LUT and the agent's own GLSL, with line numbers on errors", (t) => {
    if (!hasRaylib) return t.skip("raylib not included for this system");
    // A 2x2x2 LUT that swaps red and blue.
    writeFileSync(file("swap.cube"), "LUT_3D_SIZE 2\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1\n");
    ok("fx", ["apply", file("fx-still.png"), file("fx-lut.png"), "--effect", "lut", "--lut", file("swap.cube")]);
    near(pixel(file("fx-lut.png"), 10, 10), 0x80, 0x40, 0x20);
    writeFileSync(file("green.glsl"), "vec4 effect(vec2 uv) {\n  return vec4(0.0, 1.0, 0.0, 1.0);\n}\n");
    ok("fx", ["apply", file("fx-still.png"), file("fx-green.png"), "--effect", file("green.glsl")]);
    near(pixel(file("fx-green.png"), 10, 10), 0, 255, 0);
    writeFileSync(file("broken.glsl"), "vec4 effect(vec2 uv) {\n  return pixel(uv) * nope;\n}\n");
    assert.match(cli("fx", ["apply", file("fx-still.png"), file("x.png"), "--effect", file("broken.glsl")]).stderr, /line 2.*nope/);
  });

  test("transition overlaps two clips and crossfades the sound", (t) => {
    if (!hasRaylib) return t.skip("raylib not included for this system");
    const result = JSON.parse(ok("fx", ["transition", file("fx-a.mp4"), file("fx-b.mp4"), file("fx-ab.mp4"), "--name", "fade", "--duration", "1"]));
    assert.ok(Math.abs(result.made.duration - 3) < 0.1 && result.made.hasAudio);
    for (const [time, [r, g, b]] of [[0.5, [0x20, 0x40, 0x80]], [2.5, [0xe0, 0xc0, 0x20]]] as const) {
      ok("video", ["frame", file("fx-ab.mp4"), file("fx-ab.png"), "--time", String(time)]);
      near(pixel(file("fx-ab.png"), 100, 100), r, g, b);
    }
    ok("video", ["frame", file("fx-ab.mp4"), file("fx-ab.png"), "--time", "1.5"]); // halfway: a blend of both
    near(pixel(file("fx-ab.png"), 100, 100), 0x80, 0x80, 0x50);
    assert.match(cli("fx", ["transition", file("fx-a.mp4"), file("fx-b.mp4"), file("x.mp4"), "--name", "fade", "--set", "nope=1"]).stderr, /no setting nope/);
  });

  test("gallery shows every effect and every transition", (t) => {
    if (!hasRaylib) return t.skip("raylib not included for this system");
    assert.ok(JSON.parse(ok("fx", ["gallery", file("fx-effects.png")])).count >= 40);
    const transitions = JSON.parse(ok("fx", ["gallery", file("fx-transitions.png"), "--kind", "transitions", "--input", file("fx-a.mp4")]));
    assert.ok(transitions.count >= 70 && transitions.made.width > 1000);
  });
});

describe("engine", () => {
  test("joEdit uses its own full ffmpeg (no system install needed)", () => {
    assert.match(FFMPEG, /node-av-ffmpeg/);
    const filters = execFileSync(FFMPEG, ["-hide_banner", "-filters"], { encoding: "utf8" });
    for (const name of ["drawtext", "subtitles", "lut3d", "xfade", "ebur128"]) assert.match(filters, new RegExp(` ${name} `));
  });

  test("JSON saved by Windows editors (with a byte-order mark) reads fine; broken JSON names the file", () => {
    writeFileSync(file("bom.json"), "﻿" + JSON.stringify({ size: "160x90", scenes: [{ color: "red", duration: 1 }] }));
    assert.equal(readJson(file("bom.json")).size, "160x90");
    assert.equal(JSON.parse(ok("movie", ["validate", file("bom.json")])).valid, true);
    writeFileSync(file("broken.json"), "{ size: ");
    assert.throws(() => readJson(file("broken.json")), /broken\.json is not valid JSON/);
  });

  test("a downloaded headless Chrome is found inside its folder", () => {
    const folder = file("browser-asset");
    mkdirSync(join(folder, "chrome-headless-shell-win64"), { recursive: true });
    mkdirSync(join(folder, "chrome-headless-shell"), { recursive: true }); // a folder with the same name is not the program
    writeFileSync(join(folder, "chrome-headless-shell-win64", "chrome-headless-shell.exe"), "");
    assert.match(graphics.headlessShellIn(folder)!, /chrome-headless-shell-win64[\\/]chrome-headless-shell\.exe$/);
    assert.equal(graphics.headlessShellIn(file("no-such-folder")), undefined);
  });

  test("probe reads streams and shows rotated phone video upright", () => {
    execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-display_rotation", "90", "-i", file("in.mp4"), "-c", "copy", file("rotated.mp4")]);
    const streams = probe(file("rotated.mp4")).streams;
    const picture = streams.find((s) => s.codec_type === "video");
    assert.deepEqual([picture.width, picture.height, picture.rotation, picture.codec_name], [240, 320, 90, "h264"]);
    assert.equal(streams.find((s) => s.codec_type === "audio").codec_name, "aac");
    near(Number(probe(file("in.mp4")).format.duration), 3);
  });

  test("frames go out of and back into a video", async () => {
    const out = writeVideo(file("frames.mp4"), { width: 64, height: 32, fps: 10 });
    for (let i = 0; i < 10; i++) await out.write(Buffer.alloc(64 * 32 * 4, i < 5 ? 0 : 255));
    await out.finish();
    near(video.info(file("frames.mp4")).duration, 1);
    const frames: number[] = [];
    for await (const frame of readFrames(file("frames.mp4"), { width: 32 })) {
      assert.equal(frame.pixels.length, 32 * 16 * 4);
      frames.push(frame.pixels[0]);
    }
    assert.equal(frames.length, 10);
    assert.ok(frames[0] < 30 && frames[9] > 225, `first ${frames[0]}, last ${frames[9]}`);
  });
});

describe("joedit", () => {
  test("runs every area through one entry point", () => {
    const result = JSON.parse(ok("joedit", ["video", "info", file("in.mp4")]));
    assert.equal(result.width, 320);
    ok("joedit", ["picture", "grayscale", file("in.png"), file("gray2.png")]);
    assert.ok(existsSync(file("gray2.png")));
  });

  test("every edit prints JSON with the output path and what was made", () => {
    const result = JSON.parse(ok("joedit", ["sound", "volume", file("sound.mp3"), file("louder2.mp3"), "--factor", "2"]));
    assert.equal(result.output, file("louder2.mp3"));
    near(result.made.duration, 5);
    assert.equal(result.made.hasAudio, true);
    assert.match(result.made.size, /^\d+(\.\d)? (KB|MB)$/);
    const still = JSON.parse(ok("joedit", ["picture", "resize", file("in.png"), file("half.png"), "--width", "200"]));
    assert.deepEqual([still.made.width, still.made.height], [200, 150]);
  });

  test("a mistyped flag is refused with a suggestion, never ignored", () => {
    const result = cli("joedit", ["video", "grade", file("in.mp4"), file("x.mp4"), "--look", "noir", "--strenght", "0.5"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown flag --strenght\. Did you mean --strength\?/);
  });

  test("--name=value works like --name value", () => {
    const result = JSON.parse(ok("joedit", ["picture", "resize", file("in.png"), file("eq.png"), "--width=100"]));
    assert.equal(result.made.width, 100);
  });

  test("missing output folders are created", () => {
    ok("joedit", ["picture", "resize", file("in.png"), file("new/deeper/small.png"), "--width", "50"]);
    assert.ok(existsSync(file("new/deeper/small.png")));
  });

  test("a file can be edited in place", () => {
    execFileSync("cp", [file("in.mp4"), file("inplace.mp4")]);
    const result = JSON.parse(ok("joedit", ["video", "trim", file("inplace.mp4"), file("inplace.mp4"), "--start", "0", "--end", "1"]));
    near(result.made.duration, 1);
    near(video.info(file("inplace.mp4")).duration, 1);
  });

  test("--help shows a command's usage", () => {
    assert.match(ok("joedit", ["video", "trim", "--help"]), /Usage: trim <input> <output> --start/);
  });

  test("wrong areas and typos point to the right command", () => {
    assert.match(cli("joedit", ["video", "sheet", "a.mp4", "b.png"]).stderr, /node joedit\.ts look sheet/);
    assert.match(cli("joedit", ["trim"]).stderr, /node joedit\.ts video trim/);
    assert.match(cli("joedit", ["video", "trimm"]).stderr, /Did you mean "trim"\?/);
    assert.match(cli("joedit", ["vidoe"]).stderr, /Did you mean "video"\?/);
  });

  test("help lists every area, unknown names fail", () => {
    const help = ok("joedit", []);
    for (const area of ["picture", "video", "sound", "look", "listen", "doctor", "check"]) assert.match(help, new RegExp(area));
    assert.equal(cli("joedit", ["dance"]).code, 1);
  });

  test("doctor reports the tools and machine", () => {
    const result = JSON.parse(ok("joedit", ["doctor"]));
    assert.equal(result.ready, true);
    assert.ok(result.tools.find((t: any) => t.name === "ffmpeg").found);
    assert.ok(result.machine.cores > 0);
    assert.ok(Array.isArray(result.packs));
  });

  test("check finds black frames and suggests the exact trim", () => {
    const result = JSON.parse(ok("joedit", ["check", file("blackstart.mp4")]));
    assert.equal(result.passed, false);
    const black = result.problems.find((p: any) => p.problem === "black picture");
    assert.ok(black, "black picture not found");
    assert.match(black.fix, /video trim .* --start 1\.5/);
  });

  test("check does not call a title on a dark card black", () => {
    ok("graphics", ["title", file("dark-title.mp4"), "--text", "Hi", "--duration", "2", "--width", "640", "--height", "360"]);
    const result = JSON.parse(ok("joedit", ["check", file("dark-title.mp4")]));
    assert.equal(result.problems.filter((p: any) => p.problem === "black picture").length, 0, JSON.stringify(result.problems));
  });

  test("check passes a clean, normalized video", () => {
    ok("sound", ["normalize", file("in.mp4"), file("normal.wav")]);
    ok("video", ["add-audio", file("in.mp4"), file("clean.mp4"), "--audio", file("normal.wav")]);
    const result = JSON.parse(ok("joedit", ["check", file("clean.mp4")]));
    assert.equal(result.passed, true, JSON.stringify(result.problems));
  });

  test("install rejects unknown names and lists what there is", () => {
    const result = cli("joedit", ["install", "nope"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /AI models: .*whisper.*Assets: .*Packs: .*song/);
  });

  test("every command of every area is reachable through joedit.ts", async () => {
    const help = ok("joedit", []);
    for (const area of ["picture", "video", "sound", "look", "listen", "graphics", "fx", "movie", "voice", "music", "3d"]) {
      const { commands } = await import(`./lib/${area}.ts`);
      for (const [name, command] of Object.entries(commands) as [string, { usage: string }][]) {
        assert.ok(help.includes(`  ${area} ${command.usage}`), `${area} ${name} is missing from node joedit.ts`);
      }
    }
  });
});

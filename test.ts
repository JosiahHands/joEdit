/// <reference path="./lib/node_modules/@types/node/index.d.ts" />
// Tests for the picture, video and sound CLIs.
// Run with: node --test test.ts   (run `npm install` in lib/ first, for editor types)
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import * as picture from "./lib/picture.ts";
import * as video from "./lib/video.ts";
import * as sound from "./lib/sound.ts";

type Tool = "picture" | "video" | "sound";

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

// Color of one pixel, e.g. "srgb(255,0,0)".
function pixel(path: string, x: number, y: number): string {
  // Convert to sRGB first so gray pictures also print as "srgb(r,g,b)".
  return execFileSync("magick", [path, "-colorspace", "sRGB", "-format", `%[pixel:p{${x},${y}}]`, "info:"], { encoding: "utf8" });
}

// Average brightness from 0 to 1.
function mean(path: string): number {
  return Number(execFileSync("magick", [path, "-format", "%[fx:mean]", "info:"], { encoding: "utf8" }));
}

// Average loudness in dB (closer to 0 = louder). `seconds` limits it to the start of the file.
function loudness(path: string, seconds = 0): number {
  const limit = seconds ? ["-t", String(seconds)] : [];
  const result = spawnSync("ffmpeg", ["-hide_banner", ...limit, "-i", path, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const match = result.stderr.match(/mean_volume: (-?[\d.]+) dB/);
  assert.ok(match, `no loudness found for ${path}`);
  return Number(match[1]);
}

// Sample files are created once before all tests.
before(() => {
  // 400x300 red picture with a blue top-right corner (so flips can be checked).
  execFileSync("magick", ["-size", "400x300", "xc:red", "-fill", "blue", "-draw", "rectangle 200,0 399,149", file("in.png")]);
  // 3 second 320x240 video with sound.
  execFileSync("ffmpeg", [
    "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", file("in.mp4"),
  ]);
  // 2 second 160x120 video with no sound.
  execFileSync("ffmpeg", [
    "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=30",
    "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", file("silent.mp4"),
  ]);
  // 5 second audio file.
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220", "-t", "5", file("sound.mp3")]);
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe("picture", () => {
  test("info", () => {
    const result = JSON.parse(ok("picture", ["info", file("in.png")]));
    assert.deepEqual(result, { width: 400, height: 300, format: "PNG" });
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

  test("errors: missing file, missing flag, unknown command", () => {
    assert.equal(cli("picture", ["resize", file("nope.png"), file("x.png"), "--width", "10"]).code, 1);
    assert.equal(cli("picture", ["crop", file("in.png"), file("x.png"), "--x", "1"]).code, 1);
    assert.equal(cli("picture", ["dance"]).code, 1);
    assert.equal(cli("picture", ["help"]).code, 0);
  });
});

describe("video", () => {
  // Durations are checked with a small tolerance because of how video frames line up.
  const near = (actual: number, expected: number, tolerance = 0.15) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `expected ~${expected}, got ${actual}`);

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

  test("concat different sizes, one without sound", () => {
    ok("video", ["concat", file("in.mp4"), file("silent.mp4"), file("concat2.mp4")]);
    const result = video.info(file("concat2.mp4"));
    assert.equal(result.width, 320);
    assert.equal(result.height, 240);
    assert.equal(result.hasAudio, false);
    near(result.duration, 5, 0.2);
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

  test("errors: missing file and help", () => {
    assert.equal(cli("video", ["trim", file("nope.mp4"), file("x.mp4"), "--start", "0", "--end", "1"]).code, 1);
    assert.equal(cli("video", ["trim", file("in.mp4"), file("x.mp4"), "--start", "2", "--end", "1"]).code, 1);
    assert.equal(cli("video", []).code, 0);
  });
});

describe("sound", () => {
  const near = (actual: number, expected: number, tolerance = 0.15) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `expected ~${expected}, got ${actual}`);

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

  test("errors: missing file and help", () => {
    assert.equal(cli("sound", ["volume", file("nope.mp3"), file("x.mp3"), "--factor", "2"]).code, 1);
    assert.equal(cli("sound", ["mix", file("sound.mp3"), file("x.mp3")]).code, 1);
    assert.equal(cli("sound", ["help"]).code, 0);
  });
});

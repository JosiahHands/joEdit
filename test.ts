/// <reference path="./lib/node_modules/@types/node/index.d.ts" />
// Tests for every joEdit CLI: picture, video, sound, look, listen and joedit (doctor, check, packs).
// Run with: node --test test.ts   (run `npm install` in lib/ first, for editor types)
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import * as picture from "./lib/picture.ts";
import * as video from "./lib/video.ts";
import * as sound from "./lib/sound.ts";
import * as graphics from "./lib/graphics.ts";

type Tool = "picture" | "video" | "sound" | "look" | "listen" | "graphics" | "movie" | "joedit";

// Graphics tests need Chrome; they are skipped on machines without it.
const hasChrome = (() => {
  try {
    return Boolean(graphics.findChrome());
  } catch {
    return false;
  }
})();

// Captions need the whisper pack (to find word times) and Chrome.
function hasWhisper(): boolean {
  const packs = JSON.parse(ok("joedit", ["packs"])).packs;
  return Boolean(packs.find((p: any) => p.name === "whisper")?.installed);
}

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

// Durations are checked with a small tolerance because of how video frames and audio samples line up.
function near(actual: number, expected: number, tolerance = 0.15): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ~${expected}, got ${actual}`);
}

// Save the video frame at `time` seconds as a picture.
function frameAt(path: string, time: number, output: string): void {
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", String(time), "-i", path, "-frames:v", "1", output]);
}

// How different the same region (e.g. "320x100+0+0") is in two pictures: 0 = same, 1 = opposite.
function regionDiff(a: string, b: string, region: string): number {
  const result = spawnSync("magick", ["compare", "-metric", "RMSE", "(", a, "-crop", region, ")", "(", b, "-crop", region, ")", "null:"], { encoding: "utf8" });
  return Number(result.stderr.match(/\(([\d.e-]+)\)/)?.[1] ?? NaN);
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
  // 8 second click track at exactly 120 BPM (a click every 0.5s).
  execFileSync("ffmpeg", [
    "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "aevalsrc='0.8*sin(2*PI*1000*t)*lt(mod(t,0.5),0.03)':s=44100:d=8",
    file("click120.wav"),
  ]);
  // 2s tone, 3s silence, 2s tone.
  execFileSync("ffmpeg", [
    "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-filter_complex", "[1]atrim=0:3[s];[0][s][2]concat=n=3:v=0:a=1",
    file("gap.wav"),
  ]);
  // 1.5s of black, then 3s of test picture, with sound.
  execFileSync("ffmpeg", [
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
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-i", file("gap.wav"), "-t", "7", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", file("gap.mp4")]);
    const result = JSON.parse(ok("video", ["remove-silence", file("gap.mp4"), file("tight.mp4"), "--min", "1"]));
    assert.equal(result.cuts, 1);
    // 2s + 2s of tone, plus 0.1s of pause kept on each side.
    near(video.info(file("tight.mp4")).duration, 4.2, 0.2);
  });

  test("reframe crops to a phone shape", () => {
    ok("video", ["reframe", file("in.mp4"), file("tall.mp4"), "--aspect", "9:16"]);
    const details = video.info(file("tall.mp4"));
    assert.equal(details.height, 240);
    near(details.width / details.height, 9 / 16, 0.02);
    assert.equal(cli("video", ["reframe", file("in.mp4"), file("x.mp4"), "--aspect", "wide"]).code, 1);
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

  test("captions from a transcript appear at the bottom (needs Chrome)", (t) => {
    if (!hasChrome) return t.skip("Chrome not found");
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
    for (const hint of [/size/, /first scene/, /missing\.mp4/, /motion "spin"/, /unknown key "durration"/, /exactly one of/, /transition "teleport"/, /kazoo/]) {
      assert.match(all, hint);
    }
    // Rendering a broken movie fails with the same list.
    const render = cli("movie", ["render", file("bad.json"), file("x.mp4")]);
    assert.equal(render.code, 1);
    assert.match(render.stderr, /missing\.mp4/);
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

  test("title, lower-third (see-through) and counter templates", (t) => {
    if (!hasChrome) return t.skip("Chrome not found");
    const size = ["--width", "640", "--height", "360"];
    ok("graphics", ["title", file("title.png"), "--text", "Hello joEdit", "--subtitle", "test", ...size]);
    assert.deepEqual(picture.info(file("title.png")), { width: 640, height: 360, format: "PNG" });
    ok("graphics", ["lower-third", file("lt.mov"), "--text", "Ada Lovelace", "--subtitle", "Engineer", "--duration", "1", ...size]);
    const stream = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file("lt.mov")], { encoding: "utf8" })).streams[0];
    assert.match(stream.pix_fmt, /a/, `no alpha: ${stream.pix_fmt}`);
    ok("graphics", ["counter", file("counter.mp4"), "--to", "100", "--duration", "1", ...size]);
    near(video.info(file("counter.mp4")).duration, 1, 0.15);
    assert.equal(cli("graphics", ["title", file("x.png")]).code, 1);
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
      const log = spawnSync("ffmpeg", ["-hide_banner", "-i", file(`sfx-${type}.wav`), "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
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
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=1000:duration=2", "-af", "adelay=2000|2000,apad=whole_dur=6", file("duck-voice.wav")]);
    ok("sound", ["duck", file("duck-music.wav"), file("duck-voice.wav"), file("ducked.wav"), "--amount", "12"]);
    // Measure just the music (low tone) before and during the voice.
    const music = (from: number) => {
      const log = spawnSync("ffmpeg", ["-hide_banner", "-ss", String(from), "-t", "1", "-i", file("ducked.wav"), "-af", "lowpass=f=400,volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
      return Number(log.match(/mean_volume: (-?[\d.]+) dB/)?.[1]);
    };
    assert.ok(music(0.5) - music(2.7) > 6, `music before ${music(0.5)} dB, under voice ${music(2.7)} dB`);
  });

  test("denoise removes hiss and keeps the tone", () => {
    execFileSync("ffmpeg", [
      "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "anoisesrc=d=3:c=white:a=0.05",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-filter_complex", "[0][1]amix=inputs=2:normalize=0", file("hiss.wav"),
    ]);
    ok("sound", ["denoise", file("hiss.wav"), file("no-hiss.wav")]);
    const band = (path: string, filter: string) => {
      const log = spawnSync("ffmpeg", ["-hide_banner", "-i", path, "-af", `${filter},volumedetect`, "-f", "null", "-"], { encoding: "utf8" }).stderr;
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
});

describe("listen", () => {
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

  test("beats needs at least 3 seconds", () => {
    ok("sound", ["trim", file("click120.wav"), file("short.wav"), "--start", "0", "--end", "2"]);
    assert.equal(cli("listen", ["beats", file("short.wav")]).code, 1);
  });

  test("transcribe gives words with times (needs the whisper pack)", (t) => {
    if (!hasWhisper()) return t.skip("whisper pack not installed");
    execFileSync("say", ["-o", file("speech.aiff"), "Hello world. This is a test."]);
    const result = JSON.parse(ok("listen", ["transcribe", file("speech.aiff"), file("speech.json"), "--model", "tiny"]));
    assert.match(result.text.toLowerCase(), /hello/);
    assert.ok(result.words >= 5);
  });
});

describe("joedit", () => {
  test("runs every area through one entry point", () => {
    const result = JSON.parse(ok("joedit", ["video", "info", file("in.mp4")]));
    assert.equal(result.width, 320);
    ok("joedit", ["picture", "grayscale", file("in.png"), file("gray2.png")]);
    assert.ok(existsSync(file("gray2.png")));
  });

  test("every edit prints JSON with the output path", () => {
    const result = JSON.parse(ok("joedit", ["sound", "volume", file("sound.mp3"), file("louder2.mp3"), "--factor", "2"]));
    assert.deepEqual(result, { ok: true, output: file("louder2.mp3") });
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

  test("check passes a clean, normalized video", () => {
    ok("sound", ["normalize", file("in.mp4"), file("normal.wav")]);
    ok("video", ["add-audio", file("in.mp4"), file("clean.mp4"), "--audio", file("normal.wav")]);
    const result = JSON.parse(ok("joedit", ["check", file("clean.mp4")]));
    assert.equal(result.passed, true, JSON.stringify(result.problems));
  });

  test("install rejects unknown packs", () => {
    const result = cli("joedit", ["install", "nope"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Available packs: .*whisper/);
  });
});

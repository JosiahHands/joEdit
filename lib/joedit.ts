// joEdit: one entry point for every tool.
// Usage: node joedit.ts <area> <command> ...   (areas: picture, video, sound, look, listen, graphics, fx, movie, voice, music, 3d)
//        node joedit.ts doctor | check <file> | packs | install <model, asset or pack>
//        node joedit.ts            (lists every command)
// This file also holds the top-level commands: doctor and check.
import { cpus, tmpdir } from "node:os";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_FONT,
  FFMPEG,
  LIB,
  LIBS,
  UV_INSTALL,
  analyze,
  closest,
  formatTime,
  cancelJob,
  hardware,
  hasProgram,
  install,
  listAssets,
  listJobs,
  listModels,
  listPacks,
  optionalNumberFlag,
  packWorker,
  stopWorkers,
  waitJob,
  probe,
  readJson,
  requireFile,
  round,
  run,
  runCli,
  type Command,
} from "./core/shared.ts";
import * as fx from "./areas/fx.ts";
import * as graphics from "./areas/graphics.ts";
import * as listen from "./areas/listen.ts";
import * as threeD from "./areas/3d.ts";
import * as look from "./areas/look.ts";
import * as movie from "./areas/movie.ts";
import * as music from "./areas/music.ts";
import * as picture from "./areas/picture.ts";
import * as sound from "./areas/sound.ts";
import * as video from "./areas/video.ts";
import * as voice from "./areas/voice.ts";

// Each area is a group of commands: node joedit.ts <area> <command>.
const areas: Record<string, Record<string, Command>> = {
  picture: picture.commands,
  video: video.commands,
  sound: sound.commands,
  look: look.commands,
  listen: listen.commands,
  graphics: graphics.commands,
  fx: fx.commands,
  movie: movie.commands,
  voice: voice.commands,
  music: music.commands,
  "3d": threeD.commands,
};

// ---------- doctor: is this computer ready? ----------

type Tool = { name: string; found: boolean; version?: string; path?: string; neededFor: string; optional?: boolean; fix?: string };

// First line of a program's version text, or "" if the program is missing.
function versionOf(program: string, args: string[]): string {
  try {
    return run(program, args).trim().split("\n")[0];
  } catch {
    return "";
  }
}

// Describe the graphics chip and memory, which decide how fast (and how big) AI packs can run.
function machine() {
  const h = hardware();
  const note = h.unified
    ? "Apple Silicon: the GPU shares the RAM, fast for AI packs"
    : h.vramGB
      ? `${h.vramGB} GB GPU memory; packs move parts of big models to RAM when they don't fit, so RAM matters too`
      : "no GPU found: AI packs run on the CPU, slower";
  return {
    system: `${process.platform} ${process.arch}`,
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    memoryGB: h.ramGB,
    ...(h.freeRamGB !== undefined ? { freeMemoryGB: h.freeRamGB } : {}),
    gpu: h.gpu,
    gpuMemoryGB: h.vramGB,
    ...(h.freeVramGB !== undefined ? { freeGpuMemoryGB: h.freeVramGB } : {}),
    diskFreeGB: h.diskFreeGB,
    note,
  };
}

// Chrome renders HTML pages (graphics render/still, movie scenes with "html"). Titles, captions and canvas use Skia.
function chrome(): Tool {
  const neededFor = "HTML pages: graphics render and still, movie scenes with \"html\"";
  try {
    return { name: "chrome", found: true, version: graphics.findChrome(), neededFor, optional: true };
  } catch {
    return { name: "chrome", found: false, neededFor, optional: true, fix: "install Google Chrome, or: node joedit.ts install browser" };
  }
}

// Blender renders the 3d area. Found the same way 3d.ts finds it (app folders too, not only the PATH).
function blender(): Tool {
  const neededFor = "3d (Blender scenes, 3D titles, turntables)";
  try {
    const path = threeD.findBlender();
    return { name: "blender", found: true, version: versionOf(path, ["--version"]) || path, path, neededFor, optional: true };
  } catch (error: any) {
    return { name: "blender", found: false, neededFor, optional: true, fix: error.message.replace(/^.*Install it: /, "") };
  }
}

// joEdit's engine: npm libraries that `npm install` puts in libs/.
const LIBRARIES = [
  { name: "node-av", does: "reads media files; its FFmpeg 8 (@seydx/node-av-ffmpeg) encodes and decodes everything" },
  { name: "@seydx/node-av-ffmpeg", does: "the full FFmpeg 8 program (x264, x265, hardware encoders, libass, whisper)" },
  { name: "sharp", does: "fast picture editing (libvips)" },
  { name: "@napi-rs/canvas", does: "Skia drawing: text, titles, captions, motion graphics" },
  { name: "node-web-audio-api", does: "sound mixing, effects and synthesis (Web Audio)" },
  { name: "@huggingface/transformers", does: "local AI models: speech to text, depth, search by meaning" },
  { name: "onnxruntime-node", does: "runs AI models (cutout and more)" },
  { name: "kokoro-js", does: "natural voices" },
  { name: "koffi", does: "loads raylib (libs/raylib) for GPU effects, transitions and shaders" },
  { name: "gl-transitions", does: "transition shaders for fx and movies" },
  { name: "spessasynth_core", does: "plays MIDI scores with the instruments SoundFont (music compose)" },
];

// Is an npm library installed, and which version?
function library(name: string): { name: string; found: boolean; version?: string; does: string } {
  const does = LIBRARIES.find((l) => l.name === name)!.does;
  const file = join(LIBS, "node_modules", name, "package.json");
  if (!existsSync(file)) return { name, found: false, does };
  return { name, found: true, version: readJson(file).version, does };
}

// Check everything joEdit needs and say exactly how to install what is missing.
// Three groups: what joEdit needs (tools + libraries), downloads it makes on first use (assets, packs),
// and optional outside programs that unlock extra areas. Agents install optional ones only when a task needs them.
export function doctor() {
  const tool =(name: string, args: string[], neededFor: string, fix: string): Tool => {
    const version = versionOf(name, args);
    return version ? { name, found: true, version, neededFor } : { name, found: false, neededFor, fix };
  };

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const libraries = LIBRARIES.map((l) => library(l.name));
  const tools: Tool[] = [
    {
      name: "node",
      found: nodeMajor >= 24,
      version: process.versions.node,
      neededFor: "everything",
      fix: nodeMajor >= 24 ? undefined : "install Node.js 24 or newer: https://nodejs.org",
    },
    // joEdit's own ffmpeg: its path is shown so it can be run directly for anything joEdit has no command for.
    { ...tool("ffmpeg", ["-version"], "video, sound, look, listen, check", `cd ${LIB} && npm install`), path: FFMPEG },
    {
      name: "font",
      found: existsSync(DEFAULT_FONT),
      version: DEFAULT_FONT,
      neededFor: "text and labels",
      fix: existsSync(DEFAULT_FONT) ? undefined : `the fonts come with joEdit in ${join(LIBS, "fonts")}: restore that folder`,
    },
    {
      name: "raylib",
      found: existsSync(fx.raylibFile()),
      version: fx.raylibFile(),
      neededFor: "fx (GPU effects, particles, transitions, LUTs)",
      fix: existsSync(fx.raylibFile()) ? undefined : `joEdit includes raylib 6.2 for macOS, Windows x64 and Linux x64/arm64; on this system place it at ${fx.raylibFile()}`,
    },
  ];
  // Outside programs that unlock extra areas. Install one only when a task needs it.
  const optional: Tool[] = [
    chrome(),
    blender(),
    tool("uv", ["--version"], "Python AI packs: song, image, clone, stems, videogen", UV_INSTALL),
  ];

  const missingLibraries = libraries.filter((l) => !l.found);
  const ready = tools.every((t) => t.found) && missingLibraries.length === 0;
  return {
    ready,
    tools,
    libraries: missingLibraries.length
      ? { found: false, missing: missingLibraries.map((l) => l.name), fix: `cd ${LIB} && npm install` }
      : { found: true, list: libraries.map((l) => `${l.name} ${l.version}: ${l.does}`) },
    optional,
    machine: machine(),
    models: listModels(),
    assets: listAssets(),
    packs: listPacks(),
    next: [
      ready ? "Everything needed is installed. Read AGENTS.md to start." : "Install what is missing (see each 'fix'), then run doctor again.",
      "AI models, assets, packs and optional programs unlock extra features. Everything runs offline on this computer;",
      "add one only when a task needs it (node joedit.ts install <name> for models, assets and packs).",
    ].join(" "),
  };
}

// ---------- check: quality control before anyone sees it ----------

export type Problem = { problem: string; at?: string; fix: string };

export type Report = {
  passed: boolean;
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  problems: Problem[];
  notes: string[];
};

// Suggest how to cut out a bad part, depending on where it is.
function cutFix(file: string, start: number, end: number, duration: number): string {
  const name = JSON.stringify(file);
  if (start < 0.1) return `cut the start: node joedit.ts video trim ${name} fixed.mp4 --start ${round(end)} --end ${round(duration)}`;
  if (end > duration - 0.1) return `cut the end: node joedit.ts video trim ${name} fixed.mp4 --start 0 --end ${round(start)}`;
  return `cut it out: video trim the part before ${round(start)}s and after ${round(end)}s, then video concat them`;
}

// Look for black picture, frozen picture, long silence and bad loudness.
// Every problem comes with a joEdit command that fixes it.
// Black and frozen stretches of a video's picture, as [start, end] seconds (the slow part of check: every frame is read).
export type PictureMoments = { black: number[][]; frozen: number[][] };
export function pictureMoments(file: string): PictureMoments {
  const duration = Number(probe(file).format.duration ?? 0);
  // pix_th 0.03: only near-pure black counts, so dark design colors (like #0B0B0F) are not reported.
  // pic_th 0.999: a frame is black only if 99.9% of it is, so a title on a dark card is not reported.
  const log = analyze(file, "video", "blackdetect=d=0.5:pix_th=0.03:pic_th=0.999,freezedetect=n=-60dB:d=2");
  const black = [...log.matchAll(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const freezeEnds = [...log.matchAll(/freeze_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const frozen = [...log.matchAll(/freeze_start: ([\d.]+)/g)].map((m, n) => [Number(m[1]), freezeEnds[n] ?? duration]);
  return { black, frozen };
}

// moments: the picture's black and frozen stretches when already known (movie render reuses them with a cached picture).
export function check(file: string, moments?: PictureMoments): Report {
  const data = probe(file);
  const duration = Number(data.format.duration ?? 0);
  // Cover art inside music files counts as a "video" stream, so it is ignored here.
  const hasVideo = data.streams.some((s: any) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const hasAudio = data.streams.some((s: any) => s.codec_type === "audio");
  const problems: Problem[] = [];
  const notes: string[] = [];

  if (hasVideo) {
    const { black, frozen } = moments ?? pictureMoments(file);
    for (const [start, end] of black) {
      problems.push({ problem: "black picture", at: `${formatTime(start)}-${formatTime(end)}`, fix: cutFix(file, start, end, duration) });
    }
    for (const [start, end] of frozen) {
      problems.push({ problem: "frozen picture (nothing moves)", at: `${formatTime(start)}-${formatTime(end)}`, fix: cutFix(file, start, end, duration) });
    }
  }

  if (hasAudio) {
    const level = listen.loudness(file);
    for (const issue of level.issues) {
      // For a video, the fixed sound also has to be put back into the video.
      const putBack = `, then: node joedit.ts video add-audio ${JSON.stringify(file)} fixed.mp4 --audio fixed-sound.wav`;
      problems.push({ problem: issue.problem, fix: hasVideo && issue.fix.includes("fixed-sound.wav") ? issue.fix + putBack : issue.fix });
    }
    notes.push(`loudness ${level.lufs} LUFS, peak ${level.peak} dB`);
    // Long silences, unless the whole sound is silent (already reported above).
    if (level.lufs > -60) {
      for (const gap of listen.silences(file, -50, 2).silences) {
        problems.push({
          problem: `${gap.duration}s of silence`,
          at: `${formatTime(gap.start)}-${formatTime(gap.end)}`,
          fix: hasVideo ? cutFix(file, gap.start, gap.end, duration) : `node joedit.ts sound trim to remove ${round(gap.start)}s-${round(gap.end)}s`,
        });
      }
    }
  } else if (hasVideo) {
    notes.push("no sound track (add one with: node joedit.ts video add-audio)");
  }

  return { passed: problems.length === 0, duration: round(duration), hasVideo, hasAudio, problems, notes };
}

// ---------- bench: how fast are the AI packs on this computer? ----------

// One fixed job per installed pack, run twice: "cold" (the models load first) and "warm" (the worker has them).
// Reports time, peak RAM and (on NVIDIA) peak GPU memory, so changes and computers can be compared.
export async function bench(only: string[] = [], output = "") {
  const packs = listPacks().filter((p) => p.installed && (!only.length || only.includes(p.name)));
  const unknown = only.filter((name) => !listPacks().some((p) => p.name === name));
  if (unknown.length) throw new Error(`Unknown pack ${unknown.join(", ")}. Packs: ${listPacks().map((p) => p.name).join(", ")}`);
  const folder = mkdtempSync(join(tmpdir(), "joedit-bench-"));
  const file = (name: string) => join(folder, name);
  // A 20-second mix of a tone and noise, for packs that need a sound to work on.
  const mix = file("mix.wav");
  run("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=220:d=20", "-f", "lavfi", "-i", "anoisesrc=d=20:a=0.05", "-filter_complex", "amix=inputs=2", "-ac", "2", mix]);
  const jobs: Record<string, { job: string; run: (n: number) => Promise<any> }> = {
    image: { job: "768x768 picture", run: (n) => picture.generate(file(`picture-${n}.png`), "a lighthouse on a cliff at dawn, film photo", { width: 768, height: 768, seed: n }) },
    song: { job: "30 s instrumental song", run: (n) => music.song(file(`song-${n}.wav`), "upbeat indie pop, guitar, drums, bass", { duration: 30, seed: n }) },
    stems: { job: "split 20 s of sound", run: (n) => voice.stems(mix, file(`stems-${n}`)) },
    clone: {
      job: "one cloned sentence",
      run: async (n) => {
        if (!existsSync(file("voice.wav"))) await voice.speak(file("voice.wav"), "This is a short sample of a speaking voice, used to measure how fast cloning runs.", { engine: hasProgram("say") ? "say" : "kokoro" });
        return voice.clone(file(`clone-${n}.wav`), file("voice.wav"), "Every computer can make something wonderful.", "a synthetic voice made by joEdit bench, no person's voice");
      },
    },
    videogen: { job: "5 s clip, 832x480", run: (n) => video.generate(file(`clip-${n}.mp4`), "waves rolling onto a beach at sunset", { seconds: 5, width: 832, height: 480, seed: n }) },
  };
  stopWorkers(); // start cold
  const results = [];
  try {
    for (const { name } of packs) {
      const bench = jobs[name];
      if (!bench) continue;
      const runs = [];
      for (const [n, kind] of ["cold", "warm"].entries()) {
        const started = Date.now();
        try {
          const result = await bench.run(n + 1);
          runs.push({ kind, seconds: round((Date.now() - started) / 1000, 1), workSeconds: result.seconds, loadSeconds: result.loadSeconds, ramGb: result.ramGb, vramGb: result.vramGb });
        } catch (error: any) {
          runs.push({ kind, error: error.message.split("\n")[0] });
          break;
        }
      }
      results.push({ pack: name, job: bench.job, runs });
      stopWorkers(); // free its memory before the next pack
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  const report = { date: new Date().toISOString(), machine: machine(), results };
  if (output) writeFileSync(output, JSON.stringify(report, null, 2));
  return report;
}

// ---------- the CLI ----------

// Top-level commands: node joedit.ts <command>.
const tools: Record<string, Command> = {
  doctor: { usage: "doctor", run: () => doctor() },
  check: { usage: "check <file>", run: (a) => check(requireFile(a.positional[0])) },
  packs: { usage: "packs  → AI models, assets and packs, and which are installed", run: () => ({ models: listModels(), assets: listAssets(), packs: listPacks() }) },
  install: { usage: "install <model, asset or pack> [--extra sft,base,xl]  (--extra: the song pack's bigger models)", run: (a) => install(a.positional[0] ?? "", a.flags.extra ?? "") },
  bench: {
    usage: "bench [--only image,song] [--save bench.json]  → time, RAM and GPU memory of each installed AI pack (cold and warm)",
    run: (a) => bench(a.flags.only ? a.flags.only.split(",").map((s) => s.trim()) : [], a.flags.save ?? ""),
  },
  jobs: {
    usage: "jobs list | wait <id> [--timeout 3600] | cancel <id> | stop   (commands run with --background; stop frees the AI packs' memory)",
    run: async (a) => {
      const [action, id] = a.positional;
      if (action === "list" || !action) return { jobs: listJobs(), workers: listPacks().map((p) => ({ pack: p.name, ...packWorker(p.name) })).filter((w) => w.state) };
      if (action === "stop") return { stopped: stopWorkers() };
      if (!id) throw new Error(`Give the job id: node joedit.ts jobs ${action} <id>  (see: node joedit.ts jobs list)`);
      if (action === "wait") return { job: await waitJob(id, optionalNumberFlag(a, "timeout", 3600)) };
      if (action === "cancel") return { job: cancelJob(id) };
      throw new Error(`Unknown jobs action "${action}": use list, wait, cancel or stop.`);
    },
  },
};

// The full command list, one line each.
function help(): void {
  console.log("joEdit: pictures, video and sound for AI agents. Read AGENTS.md first.\n");
  console.log("Usage: node joedit.ts <area> <command> ...\n");
  for (const [area, commands] of Object.entries(areas)) {
    for (const command of Object.values(commands)) console.log(`  ${area} ${command.usage}`);
    console.log("");
  }
  for (const command of Object.values(tools)) console.log(`  ${command.usage}`);
}

if (import.meta.main) {
  const [first, ...rest] = process.argv.slice(2);
  // A command asked for in the wrong area, e.g. "video sheet": say where it lives.
  const home = (command: string) => Object.keys(areas).filter((area) => areas[area][command]);
  if (first && areas[first] && rest[0] && !areas[first][rest[0]] && home(rest[0]).length) {
    console.error(`"${rest[0]}" is not a ${first} command. Try: ${home(rest[0]).map((area) => `node joedit.ts ${area} ${rest[0]}`).join("  or  ")}`);
    process.exitCode = 1;
  } else if (first && areas[first]) {
    runCli(`joEdit ${first}: node joedit.ts ${first} <command> ...`, areas[first], rest);
  } else if (first && tools[first]) {
    runCli("joEdit", tools, [first, ...rest]);
  } else if (first && home(first).length) {
    // A command name without its area, e.g. "trim": show the full command.
    console.error(`"${first}" needs its area. Try: ${home(first).map((area) => `node joedit.ts ${area} ${first}`).join("  or  ")}`);
    process.exitCode = 1;
  } else {
    if (first && first !== "help") {
      const guess = closest(first, [...Object.keys(areas), ...Object.keys(tools)]);
      console.error(`Unknown area or command: ${first}.${guess ? ` Did you mean "${guess}"?` : ""}\n`);
      process.exitCode = 1;
    }
    help();
  }
}

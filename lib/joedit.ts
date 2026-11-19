// joEdit: one entry point for every tool.
// Usage: node joedit.ts <area> <command> ...   (areas: picture, video, sound, look, listen, graphics, movie, voice, music, 3d)
//        node joedit.ts doctor | check <file> | packs | install <pack or asset>
//        node joedit.ts            (lists every command)
// This file also holds the top-level commands: doctor and check.
import { cpus, totalmem } from "node:os";
import { existsSync } from "node:fs";
import {
  DEFAULT_FONT,
  analyze,
  formatTime,
  install,
  listAssets,
  listPacks,
  probe,
  requireFile,
  round,
  run,
  runCli,
  type Command,
} from "./shared.ts";
import * as graphics from "./graphics.ts";
import * as listen from "./listen.ts";
import * as threeD from "./3d.ts";
import * as look from "./look.ts";
import * as movie from "./movie.ts";
import * as music from "./music.ts";
import * as picture from "./picture.ts";
import * as sound from "./sound.ts";
import * as video from "./video.ts";
import * as voice from "./voice.ts";

// Each area is a group of commands: node joedit.ts <area> <command>.
const areas: Record<string, Record<string, Command>> = {
  picture: picture.commands,
  video: video.commands,
  sound: sound.commands,
  look: look.commands,
  listen: listen.commands,
  graphics: graphics.commands,
  movie: movie.commands,
  voice: voice.commands,
  music: music.commands,
  "3d": threeD.commands,
};

// ---------- doctor: is this computer ready? ----------

type Tool = { name: string; found: boolean; version?: string; neededFor: string; optional?: boolean; fix?: string };

// First line of a program's version text, or "" if the program is missing.
function versionOf(program: string, args: string[]): string {
  try {
    return run(program, args).trim().split("\n")[0];
  } catch {
    return "";
  }
}

// Describe the graphics chip, which decides how fast AI packs can run.
function gpu(): string {
  if (process.platform === "darwin" && process.arch === "arm64") return "Apple Silicon (fast for AI packs)";
  const nvidia = versionOf("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]);
  return nvidia ? `NVIDIA ${nvidia}` : "none found (AI packs will run on the CPU, slower)";
}

// Chrome draws graphics, titles and captions.
function chrome(): Tool {
  try {
    return { name: "chrome", found: true, version: graphics.findChrome(), neededFor: "graphics, titles, captions, movie" };
  } catch {
    return { name: "chrome", found: false, neededFor: "graphics, titles, captions, movie", fix: "install Google Chrome, or: node joedit.ts install browser" };
  }
}

// Check everything joEdit needs and say exactly how to install what is missing.
export function doctor() {
  const mac = process.platform === "darwin";
  const tool = (name: string, args: string[], neededFor: string, fix: string): Tool => {
    const version = versionOf(name, args);
    return version ? { name, found: true, version, neededFor } : { name, found: false, neededFor, fix };
  };

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const tools: Tool[] = [
    {
      name: "node",
      found: nodeMajor >= 24,
      version: process.versions.node,
      neededFor: "everything",
      fix: nodeMajor >= 24 ? undefined : "install Node.js 24 or newer: https://nodejs.org",
    },
    tool("ffmpeg", ["-version"], "video, sound, look, listen, check", mac ? "brew install ffmpeg" : "sudo apt install ffmpeg"),
    tool("ffprobe", ["-version"], "video, sound, look, listen, check", mac ? "brew install ffmpeg" : "sudo apt install ffmpeg"),
    tool("magick", ["-version"], "picture, look, text", mac ? "brew install imagemagick" : "install ImageMagick 7: https://imagemagick.org/script/download.php"),
    {
      name: "font",
      found: existsSync(DEFAULT_FONT),
      version: DEFAULT_FONT,
      neededFor: "text and labels",
      fix: existsSync(DEFAULT_FONT) ? undefined : "node joedit.ts install fonts",
    },
    chrome(),
    { ...tool("uv", ["--version"], "AI packs", mac ? "brew install uv" : "curl -LsSf https://astral.sh/uv/install.sh | sh"), optional: true },
    { ...tool("fluidsynth", ["--version"], "music compose", mac ? "brew install fluid-synth" : "sudo apt install fluidsynth"), optional: true },
    { ...tool("blender", ["--version"], "3d", mac ? "brew install --cask blender" : "install Blender: https://www.blender.org/download/"), optional: true },
  ];

  const ready = tools.filter((t) => !t.optional).every((t) => t.found);
  return {
    ready,
    tools,
    machine: {
      system: `${process.platform} ${process.arch}`,
      cpu: cpus()[0]?.model ?? "unknown",
      cores: cpus().length,
      memoryGB: round(totalmem() / 1024 ** 3, 1),
      gpu: gpu(),
    },
    packs: listPacks(),
    assets: listAssets(),
    next: [
      ready ? "Everything needed is installed. Read AGENTS.md to start." : "Install the missing tools (see 'fix'), then run doctor again.",
      "Optional tools (marked optional) unlock more areas, e.g. Blender for 3d.",
      "AI packs and assets that are not installed yet: node joedit.ts install <name> (each lists what it is for).",
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
export function check(file: string): Report {
  const data = probe(file);
  const duration = Number(data.format.duration ?? 0);
  // Cover art inside music files counts as a "video" stream, so it is ignored here.
  const hasVideo = data.streams.some((s: any) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const hasAudio = data.streams.some((s: any) => s.codec_type === "audio");
  const problems: Problem[] = [];
  const notes: string[] = [];

  if (hasVideo) {
    // pix_th 0.03: only near-pure black counts, so dark design colors (like #0B0B0F) are not reported.
    const log = analyze(file, "video", "blackdetect=d=0.5:pix_th=0.03,freezedetect=n=-60dB:d=2");
    for (const m of log.matchAll(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g)) {
      const [start, end] = [Number(m[1]), Number(m[2])];
      problems.push({ problem: "black picture", at: `${formatTime(start)}-${formatTime(end)}`, fix: cutFix(file, start, end, duration) });
    }
    const freezeStarts = [...log.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => Number(m[1]));
    const freezeEnds = [...log.matchAll(/freeze_end: ([\d.]+)/g)].map((m) => Number(m[1]));
    freezeStarts.forEach((start, n) => {
      const end = freezeEnds[n] ?? duration;
      problems.push({ problem: "frozen picture (nothing moves)", at: `${formatTime(start)}-${formatTime(end)}`, fix: cutFix(file, start, end, duration) });
    });
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

// ---------- the CLI ----------

// Top-level commands: node joedit.ts <command>.
const tools: Record<string, Command> = {
  doctor: { usage: "doctor", run: () => doctor() },
  check: { usage: "check <file>", run: (a) => check(requireFile(a.positional[0])) },
  packs: { usage: "packs", run: () => ({ packs: listPacks(), assets: listAssets() }) },
  install: { usage: "install <pack or asset>", run: (a) => install(a.positional[0] ?? "") },
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
  if (first && areas[first]) {
    runCli(`joEdit ${first}: node joedit.ts ${first} <command> ...`, areas[first], rest);
  } else if (first && tools[first]) {
    runCli("joEdit", tools, [first, ...rest]);
  } else {
    if (first && first !== "help") {
      console.error(`Unknown area or command: ${first}\n`);
      process.exitCode = 1;
    }
    help();
  }
}

// Shared helpers for picture.ts and video.ts.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// Font used when drawing text (ImageMagick needs a real font file on this system).
export const DEFAULT_FONT = "/System/Library/Fonts/Supplemental/Arial.ttf";

// Parsed command line: plain values go in `positional`, `--name value` pairs go in `flags`.
export type Args = {
  positional: string[];
  flags: Record<string, string>;
};

// A CLI command: a short usage line and the function that runs it.
export type Command = {
  usage: string;
  run: (args: Args) => void;
};

// Run a program (ffmpeg, ffprobe, magick) and return its stdout.
// Throws an Error containing stderr if the program fails.
export function run(program: string, args: string[]): string {
  try {
    return execFileSync(program, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error: any) {
    const details = (error.stderr || error.message || "").toString().trim();
    throw new Error(`${program} failed: ${details}`);
  }
}

// Run ffmpeg quietly, always overwriting the output. Used by video.ts and sound.ts.
export function ffmpeg(args: string[]): void {
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

// Read a media file's streams and format with ffprobe.
export function probe(input: string): { streams: any[]; format: any } {
  requireFile(input);
  return JSON.parse(run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input]));
}

// Turn ["a.png", "--width", "100"] into { positional: ["a.png"], flags: { width: "100" } }.
export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item.startsWith("--")) {
      const name = item.slice(2);
      const next = argv[i + 1];
      // A flag with no value (or followed by another flag) counts as "true".
      if (next === undefined || next.startsWith("--")) {
        flags[name] = "true";
      } else {
        flags[name] = next;
        i++;
      }
    } else {
      positional.push(item);
    }
  }
  return { positional, flags };
}

// Throw if the file does not exist.
export function requireFile(path: string | undefined): string {
  if (!path) throw new Error("Missing file path.");
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  return path;
}

// Get the input and output paths (first two positional values).
export function inOut(args: Args): { input: string; output: string } {
  const input = requireFile(args.positional[0]);
  const output = args.positional[1];
  if (!output) throw new Error("Missing output path.");
  return { input, output };
}

// Read a required numeric flag.
export function numberFlag(args: Args, name: string): number {
  const value = args.flags[name];
  if (value === undefined) throw new Error(`Missing --${name}.`);
  const number = Number(value);
  if (Number.isNaN(number)) throw new Error(`--${name} must be a number, got "${value}".`);
  return number;
}

// Read an optional numeric flag, using `fallback` when it is not given.
export function optionalNumberFlag(args: Args, name: string, fallback: number): number {
  return args.flags[name] === undefined ? fallback : numberFlag(args, name);
}

// Read a required text flag.
export function stringFlag(args: Args, name: string): string {
  const value = args.flags[name];
  if (value === undefined || value === "true") throw new Error(`Missing --${name}.`);
  return value;
}

// Run the command named in argv[0], or print help. Exits with code 1 on error.
export function runCli(title: string, commands: Record<string, Command>, argv: string[]): void {
  const [name, ...rest] = argv;
  const command = name ? commands[name] : undefined;
  if (!command) {
    if (name && name !== "help") console.error(`Unknown command: ${name}\n`);
    console.log(`${title}\n\nCommands:`);
    for (const c of Object.values(commands)) console.log(`  ${c.usage}`);
    process.exitCode = name && name !== "help" ? 1 : 0;
    return;
  }
  try {
    command.run(parseArgs(rest));
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    console.error(`Usage: ${command.usage}`);
    process.exitCode = 1;
  }
}

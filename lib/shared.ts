// Shared helpers used by every joEdit module: running programs, reading arguments, the CLI, and packs.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Font used when drawing text (ImageMagick needs a real font file on this system).
export const DEFAULT_FONT = "/System/Library/Fonts/Supplemental/Arial.ttf";

// Parsed command line: plain values go in `positional`, `--name value` pairs go in `flags`.
export type Args = {
  positional: string[];
  flags: Record<string, string>;
};

// Extra facts a command can report back (printed as JSON next to "ok": true).
export type Result = Record<string, unknown>;

// A CLI command: a short usage line and the function that runs it.
export type Command = {
  usage: string;
  run: (args: Args) => Result | void;
};

// Run a program (ffmpeg, ffprobe, magick, uv) and return its stdout.
// Throws an Error containing stderr if the program fails.
export function run(program: string, args: string[], env?: Record<string, string>): string {
  try {
    return execFileSync(program, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024, // transcripts and analysis output can be large
      env: env ? { ...process.env, ...env } : process.env,
    });
  } catch (error: any) {
    if (error.code === "ENOENT") throw new Error(`"${program}" is not installed. Run: node joedit.ts doctor`);
    const details = (error.stderr || error.message || "").toString().trim();
    throw new Error(`${program} failed: ${details}`);
  }
}

// True if a program can be found on this computer.
export function hasProgram(program: string): boolean {
  return spawnSync("which", [program]).status === 0;
}

// Run ffmpeg quietly, always overwriting the output. Used by video.ts and sound.ts.
export function ffmpeg(args: string[]): void {
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

// Run an ffmpeg analysis filter over a file and return ffmpeg's log text.
// Detection filters (silencedetect, blackdetect, ebur128, ...) report their findings in this log.
// kind: "video" uses -vf, "audio" uses -af.
export function analyze(input: string, kind: "video" | "audio", filter: string): string {
  requireFile(input);
  const option = kind === "video" ? "-vf" : "-af";
  const result = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", input, option, filter, "-f", "null", "-"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr.trim().split("\n").slice(-3).join(" ")}`);
  return result.stderr;
}

// Create a temporary folder, give it to `work`, and always delete it afterwards.
export function withTempDir<T>(work: (folder: string) => T): T {
  const folder = mkdtempSync(join(tmpdir(), "joedit-"));
  try {
    return work(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// Seconds as a readable timestamp: 75.5 -> "1:15.5".
export function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = (seconds - minutes * 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${rest}`;
}

// Round a number to a few decimals so JSON output stays short and readable.
export function round(value: number, decimals = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
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
// On success it prints one line of JSON, e.g. {"ok":true,"output":"out.mp4"}.
// "output" is added automatically for commands whose usage has an <output...> argument (always the last file).
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
    const args = parseArgs(rest);
    const result = command.run(args) ?? {};
    const output = command.usage.includes("<output") ? { output: args.positional[args.positional.length - 1] } : {};
    console.log(JSON.stringify({ ok: true, ...output, ...result }));
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    console.error(`Usage: ${command.usage}`);
    process.exitCode = 1;
  }
}

// ---------- Packs ----------
// Packs are optional AI tools (open models) that run on this computer, no API keys needed.
// Each pack is a folder in packs/ with a pyproject.toml (its Python needs) and a run.py (prints JSON).
// `uv` installs each pack into its own private environment in .packs/<name>, so packs never clash.

const LIB = dirname(fileURLToPath(import.meta.url));
const PACK_RECIPES = join(LIB, "packs"); // pack recipes (part of joEdit)
const PACK_ENVIRONMENTS = join(LIB, ".packs"); // installed packs (created by `install`)

export type PackInfo = { name: string; description: string; installed: boolean };

// Every available pack, and whether it is installed.
export function listPacks(): PackInfo[] {
  if (!existsSync(PACK_RECIPES)) return [];
  return readdirSync(PACK_RECIPES)
    .filter((name) => existsSync(join(PACK_RECIPES, name, "pyproject.toml")))
    .map((name) => {
      const toml = readFileSync(join(PACK_RECIPES, name, "pyproject.toml"), "utf8");
      const description = toml.match(/^description\s*=\s*"(.*)"/m)?.[1] ?? "";
      return { name, description, installed: isPackInstalled(name) };
    });
}

function isPackInstalled(name: string): boolean {
  return existsSync(join(PACK_ENVIRONMENTS, name, "pyvenv.cfg"));
}

// The pack's recipe folder. Throws a helpful error for unknown names.
function packRecipe(name: string): string {
  const folder = join(PACK_RECIPES, name);
  if (!name || !existsSync(join(folder, "pyproject.toml"))) {
    const names = listPacks().map((p) => p.name).join(", ");
    throw new Error(`Unknown pack "${name}". Available packs: ${names}`);
  }
  return folder;
}

// Tells uv to put this pack's environment in .packs/<name>.
function packEnvironment(name: string): Record<string, string> {
  return { UV_PROJECT_ENVIRONMENT: join(PACK_ENVIRONMENTS, name) };
}

// Install a pack. The first install can take a few minutes (it downloads Python libraries).
export function installPack(name: string): { pack: string; installed: boolean } {
  const folder = packRecipe(name);
  if (!hasProgram("uv")) {
    throw new Error("Packs need uv (a Python installer). Install it with: brew install uv   (or: curl -LsSf https://astral.sh/uv/install.sh | sh)");
  }
  try {
    // Progress is shown on stderr so the person waiting can see something is happening.
    execFileSync("uv", ["sync", "--project", folder], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, ...packEnvironment(name) },
    });
  } catch {
    throw new Error(`Installing the "${name}" pack failed. See the messages above.`);
  }
  return { pack: name, installed: true };
}

// Run a pack's run.py with arguments and return the JSON it prints.
export function runPack(name: string, args: string[]): any {
  const folder = packRecipe(name);
  if (!isPackInstalled(name)) throw new Error(`The "${name}" pack is not installed. Run: node joedit.ts install ${name}`);
  const output = run("uv", ["run", "--project", folder, "--no-sync", "python", join(folder, "run.py"), ...args], packEnvironment(name));
  // The JSON result is always the last line printed.
  const lastLine = output.trim().split("\n").pop() ?? "";
  return JSON.parse(lastLine);
}

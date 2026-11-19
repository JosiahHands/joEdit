// Shared helpers used by every joEdit module: running programs, reading arguments, the CLI,
// packs (local AI tools), assets (downloaded fonts and tools) and the brand kit.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The folder joEdit lives in, and where downloaded assets go.
export const LIB = dirname(fileURLToPath(import.meta.url));
export const ASSETS = join(LIB, ".assets");

// Font file used when ImageMagick draws text: a system font if there is one, else a downloaded one.
export const DEFAULT_FONT =
  [
    "/System/Library/Fonts/Supplemental/Arial.ttf", // macOS
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", // Debian / Ubuntu
    "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf", // Fedora
    join(ASSETS, "fonts", "Inter.ttf"), // node joedit.ts install fonts
  ].find((path) => existsSync(path)) ?? "";

// Parsed command line: plain values go in `positional`, `--name value` pairs go in `flags`.
export type Args = {
  positional: string[];
  flags: Record<string, string>;
};

// Extra facts a command can report back (printed as JSON next to "ok": true).
export type Result = Record<string, unknown>;

// A CLI command: a short usage line and the function that runs it (it may be async).
export type Command = {
  usage: string;
  run: (args: Args) => Result | void | Promise<Result | void>;
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
// `work` may be async: the folder is then deleted when its promise finishes.
export function withTempDir<T>(work: (folder: string) => T): T {
  const folder = mkdtempSync(join(tmpdir(), "joedit-"));
  const remove = () => rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  let result: T;
  try {
    result = work(folder);
  } catch (error) {
    remove();
    throw error;
  }
  if (result instanceof Promise) return result.finally(remove) as T;
  remove();
  return result;
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
export async function runCli(title: string, commands: Record<string, Command>, argv: string[]): Promise<void> {
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
    const result = (await command.run(args)) ?? {};
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

// ---------- Assets ----------
// Assets are free downloads (fonts, instrument sounds, helper programs) saved in .assets/<name>.
// Install one with: node joedit.ts install <name>

export type Asset = {
  name: string;
  description: string;
  license: string;
  files?: { url: string; path: string; unzip?: boolean }[]; // downloaded into .assets/<name>/<path> (zips are unpacked)
  command?: string[]; // or: a command that installs it into .assets/<name>
};

const GOOGLE_FONTS = "https://github.com/google/fonts/raw/main/ofl";
const THREE = "https://cdn.jsdelivr.net/npm/three@0.180.0";

export const ASSET_LIST: Asset[] = [
  {
    name: "fonts",
    description: "Free fonts for titles and captions: Inter, Montserrat, Bebas Neue, Playfair Display, JetBrains Mono.",
    license: "SIL Open Font License",
    files: [
      { url: `${GOOGLE_FONTS}/inter/Inter%5Bopsz,wght%5D.ttf`, path: "Inter.ttf" },
      { url: `${GOOGLE_FONTS}/montserrat/Montserrat%5Bwght%5D.ttf`, path: "Montserrat.ttf" },
      { url: `${GOOGLE_FONTS}/bebasneue/BebasNeue-Regular.ttf`, path: "BebasNeue.ttf" },
      { url: `${GOOGLE_FONTS}/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf`, path: "PlayfairDisplay.ttf" },
      { url: `${GOOGLE_FONTS}/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf`, path: "JetBrainsMono.ttf" },
    ],
  },
  {
    name: "instruments",
    description: "GeneralUser GS: 259 instrument sounds (piano, strings, drums, synths …) for music compose. 32 MB.",
    license: "GeneralUser GS License v2.0 (free for any use)",
    files: [{ url: "https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main/GeneralUser-GS.sf2", path: "GeneralUser-GS.sf2" }],
  },
  {
    name: "three",
    description: "Three.js 0.180 (real-time 3D for graphics pages) with the glTF model loader. 2 MB.",
    license: "MIT",
    files: [
      { url: `${THREE}/build/three.module.js`, path: "three.module.js" },
      { url: `${THREE}/build/three.core.js`, path: "three.core.js" },
      { url: `${THREE}/examples/jsm/loaders/GLTFLoader.js`, path: "addons/loaders/GLTFLoader.js" },
      { url: `${THREE}/examples/jsm/utils/BufferGeometryUtils.js`, path: "addons/utils/BufferGeometryUtils.js" },
    ],
  },
  {
    name: "upscaler",
    description: "Real-ESRGAN: makes pictures and video frames 2-4x bigger with AI-sharpened detail (runs on the GPU via Vulkan/Metal). 50 MB.",
    license: "BSD-3-Clause",
    files: [
      {
        url: `https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-${process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "ubuntu"}.zip`,
        path: "upscaler.zip",
        unzip: true,
      },
    ],
  },
  {
    name: "browser",
    description: "A headless Chrome for graphics, only needed if Google Chrome or Chromium is not installed.",
    license: "BSD (Chromium)",
    command: ["npx", "-y", "@puppeteer/browsers", "install", "chrome-headless-shell@stable", "--path"],
  },
];

// Font family names for the font files in the fonts asset (used by graphics pages).
export const FONT_FAMILIES: Record<string, string> = {
  "Inter.ttf": "Inter",
  "Montserrat.ttf": "Montserrat",
  "BebasNeue.ttf": "Bebas Neue",
  "PlayfairDisplay.ttf": "Playfair Display",
  "JetBrainsMono.ttf": "JetBrains Mono",
};

export function isAssetInstalled(name: string): boolean {
  const folder = join(ASSETS, name);
  return existsSync(folder) && readdirSync(folder).length > 0;
}

export function listAssets() {
  return ASSET_LIST.map((a) => ({ name: a.name, description: a.description, license: a.license, installed: isAssetInstalled(a.name) }));
}

// Download an asset into .assets/<name>.
export async function installAsset(name: string): Promise<{ asset: string; installed: boolean }> {
  const asset = ASSET_LIST.find((a) => a.name === name);
  if (!asset) throw new Error(`Unknown asset "${name}".`);
  const folder = join(ASSETS, name);
  mkdirSync(folder, { recursive: true });
  if (asset.command) {
    const [program, ...args] = asset.command;
    execFileSync(program, [...args, folder], { stdio: ["ignore", "ignore", "inherit"] });
  }
  for (const file of asset.files ?? []) {
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${file.url}`);
    const target = join(folder, file.path);
    mkdirSync(dirname(target), { recursive: true }); // paths may include sub-folders
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
    if (file.unzip) {
      run("unzip", ["-o", "-q", target, "-d", folder]);
      rmSync(target);
      // Zips do not always keep the "can run" flag, so set it on the programs inside.
      for (const name of readdirSync(folder)) {
        const path = join(folder, name);
        if (!name.includes(".") && statSync(path).isFile()) chmodSync(path, 0o755);
      }
    }
  }
  return { asset: name, installed: true };
}

// Install a pack or an asset by name.
export async function install(name: string): Promise<Result> {
  if (ASSET_LIST.some((a) => a.name === name)) return installAsset(name);
  return installPack(name);
}

// ---------- Brand kit ----------
// A brand.json file keeps colors and fonts the same across titles, captions and movies.
// Every field is optional: { "colors": { "primary": "#7C5CFF" }, "fonts": { "heading": "Bebas Neue" }, "logo": "logo.png" }

export type Brand = {
  colors: { background: string; text: string; primary: string; accent: string };
  fonts: { heading: string; body: string };
  logo?: string;
};

export const DEFAULT_BRAND: Brand = {
  colors: { background: "#0B0B0F", text: "#FFFFFF", primary: "#7C5CFF", accent: "#FFD166" },
  fonts: { heading: "Montserrat", body: "Inter" },
};

// Read a brand.json file (if given) on top of the defaults.
export function loadBrand(path?: string): Brand {
  if (!path) return DEFAULT_BRAND;
  const custom = JSON.parse(readFileSync(requireFile(path), "utf8"));
  const brand: Brand = {
    colors: { ...DEFAULT_BRAND.colors, ...custom.colors },
    fonts: { ...DEFAULT_BRAND.fonts, ...custom.fonts },
    logo: custom.logo ? join(dirname(path), custom.logo) : undefined,
  };
  return brand;
}

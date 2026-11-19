// Movies from one JSON file: scenes, transitions, text, music, sound effects, captions and a look.
// Each scene is rendered once and cached, so changing one scene only re-renders that scene.
// CLI:     node joedit.ts movie <command> ...
// Library: import { renderMovie } from "./joEdit/movie.ts"
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  drawText,
  ffmpeg,
  ffmpegAsync,
  isModelInstalled,
  listAssets,
  listPacks,
  loadBrand,
  measureText,
  readFrames,
  requireFile,
  round,
  runCli,
  skia,
  withTempDir,
  writeVideo,
  type Brand,
  type Command,
  type TextStyle,
} from "./shared.ts";
import * as fx from "./fx.ts";
import * as graphics from "./graphics.ts";
import * as listen from "./listen.ts";
import * as music from "./music.ts";
import * as picture from "./picture.ts";
import * as sound from "./sound.ts";
import * as video from "./video.ts";
import * as voice from "./voice.ts";

// ---------- The movie file ----------

export type TextOverlay = {
  text: string;
  subtitle?: string;
  at?: number; // seconds from the start of the scene
  duration?: number;
  style?: "lower-third" | "title";
};

// A keyframe: at `time` seconds (from the start of the layer, or of the scene/movie for fx) these values hold.
// Values glide smoothly from one key to the next.
export type Key = { time: number; x?: number; y?: number; width?: number; scale?: number; rotate?: number; opacity?: number; amount?: number };

// Something drawn on top of a scene: a picture, a video or text. Positions are fractions of the frame,
// so a layer looks the same in drafts and finals.
export type Layer = {
  image?: string;
  video?: string;
  text?: string;
  style?: TextStyle; // text: size (pixels at full size), font, weight, color, stroke, shadow, box ...
  from?: number; // video: start time in the clip (layers are silent)
  at?: number; // seconds from the start of the scene (default 0)
  duration?: number; // default: until the scene ends
  x?: number; // centre, 0 = left .. 1 = right (default 0.5; with track: an offset, default 0)
  y?: number; // centre, 0 = top .. 1 = bottom (default 0.5; with track: an offset, default 0)
  width?: number; // image/video: fraction of the frame width (default 0.3)
  scale?: number;
  rotate?: number; // degrees
  opacity?: number; // 0..1
  blend?: string; // normal, multiply, screen, overlay, add, darken, lighten, soft-light, hard-light, difference, color-dodge, color-burn ...
  fadeIn?: number;
  fadeOut?: number;
  keys?: Key[];
  track?: string; // a track.json from `look track` of this scene's video: the layer follows that thing
  anchor?: "top" | "center" | "bottom"; // which part of the tracked box (default top: the layer sits just above it)
};

// GPU effects (fx.ts): names like "bloom,grain" (or my.glsl, or lut), settings, strength (animatable with keys).
export type Fx = { effect: string; set?: string | Record<string, number | string | number[]>; amount?: number; lut?: string; keys?: Key[] };

export type Scene = {
  // What the scene shows (one of these):
  video?: string;
  image?: string;
  title?: string;
  html?: string;
  canvas?: string; // a draw.mjs for graphics canvas
  color?: string;
  // Options:
  duration?: number; // seconds (videos: defaults to from..to or the whole clip)
  from?: number; // video: start time in the clip
  to?: number; // video: end time in the clip
  volume?: number; // video: loudness of the clip's own sound (0 = silent)
  fit?: "cover" | "contain"; // video: fill the frame (crop) or fit inside it (blurred background)
  motion?: string; // image: zoom-in, zoom-out, pan-left, pan-right, pan-up, pan-down, none, or parallax (3D, needs: install depth)
  subtitle?: string; // title: smaller second line
  data?: unknown; // html: window.joedit.data; canvas: info.data
  look?: string; // a color grade for this scene only
  transition?: string | { type?: string; duration?: number; set?: string }; // how this scene appears after the previous one
  text?: TextOverlay[];
  layers?: Layer[];
  fx?: string | Fx;
};

export type Track = {
  file: string;
  at?: number; // when it starts in the movie
  volume?: number;
  from?: number; // start time in the file
  to?: number; // end time in the file
  fadeIn?: number;
  fadeOut?: number;
  loop?: boolean; // repeat until the movie ends
  duck?: boolean; // turn down automatically while people speak (for music)
  pan?: number; // -1 (left) .. 1 (right)
  reverb?: string; // a room: room, studio, hall, plate, cathedral
};

export type Movie = {
  size?: string; // "1920x1080", "1080x1920", "1080x1080"
  fps?: number;
  brand?: string; // brand.json
  look?: string;
  lookStrength?: number;
  effects?: video.Effects;
  fx?: string | Fx; // GPU effects over the whole film
  scenes: Scene[];
  audio?: Track[];
  sfx?: { type: string; at: number; volume?: number; duration?: number }[];
  // speakers: a color per speaker (from the transcript's speakers, or found with the speakers model).
  captions?: boolean | { style?: graphics.CaptionStyle; position?: string; transcript?: string; model?: string; speakers?: boolean };
  voiceover?: { text: string; voice?: string; speed?: number; at?: number; volume?: number; reverb?: string }; // spoken by voice speak
  music?: MusicSpec; // background music: a composed score, an AI song, or a file
  beatSync?: string | boolean; // a sound file (or true = the movie's music): cuts move to its nearest beats
  notes?: string; // free text, ignored when rendering
};

export type MusicSpec = {
  score?: string; // a score file for music compose
  song?: { prompt: string; lyrics?: string; duration?: number; seed?: number; bpm?: number }; // song pack
  file?: string; // any sound file
  volume?: number;
  duck?: boolean; // default true: quieter while people speak
  loop?: boolean;
  fadeIn?: number;
  fadeOut?: number; // default 2
};

// ffmpeg's xfade transitions that work well. Any of these, or any GPU transition from `fx list`, can be a scene's transition type.
export const TRANSITIONS = [
  "fade", "fadeblack", "fadewhite", "dissolve", "wipeleft", "wiperight", "wipeup", "wipedown",
  "slideleft", "slideright", "slideup", "slidedown", "smoothleft", "smoothright", "smoothup", "smoothdown",
  "circleopen", "circleclose", "circlecrop", "rectcrop", "radial", "pixelize", "zoomin", "hblur", "distance",
  "squeezeh", "squeezev", "diagtl", "diagbr", "hlslice", "hrslice", "coverleft", "coverright", "revealleft", "revealright",
];

const SCENE_KINDS = ["video", "image", "title", "html", "canvas", "color"];
// Flat moves (Ken Burns) and 2.5D moves that use the picture's depth.
const IMAGE_MOTIONS = [...picture.MOTIONS, "parallax", ...picture.PARALLAX_MOTIONS.map((m) => `parallax-${m}`)];
const SCENE_KEYS = [...SCENE_KINDS, "duration", "from", "to", "volume", "fit", "motion", "subtitle", "data", "look", "transition", "text", "layers", "fx"];
const MOVIE_KEYS = ["size", "fps", "brand", "look", "lookStrength", "effects", "fx", "scenes", "audio", "sfx", "captions", "voiceover", "music", "beatSync", "notes"];
const TRACK_KEYS = ["file", "at", "volume", "from", "to", "fadeIn", "fadeOut", "loop", "duck", "pan", "reverb"];
const LAYER_KEYS = ["image", "video", "text", "style", "from", "at", "duration", "x", "y", "width", "scale", "rotate", "opacity", "blend", "fadeIn", "fadeOut", "keys", "track", "anchor"];
const KEY_VALUES = ["x", "y", "width", "scale", "rotate", "opacity", "amount"];
const FX_KEYS = ["effect", "set", "amount", "lut", "keys"];
// Layer blend modes, as Skia (canvas) names them. "add" is canvas "lighter".
const BLENDS: Record<string, string> = {
  normal: "source-over", add: "lighter", multiply: "multiply", screen: "screen", overlay: "overlay", darken: "darken",
  lighten: "lighten", "color-dodge": "color-dodge", "color-burn": "color-burn", "hard-light": "hard-light",
  "soft-light": "soft-light", difference: "difference", exclusion: "exclusion", hue: "hue", saturation: "saturation",
  color: "color", luminosity: "luminosity",
};
const DEFAULT_DURATION = 3;
const CACHE_VERSION = 2; // bump to throw away old cached scenes after changing how scenes render
// How many scenes render at the same time (each encode already uses several cores).
const SCENES_AT_ONCE = Math.min(4, Math.max(1, Math.floor(cpus().length / 4)));

// Read a movie file. Paths inside it are relative to the movie file.
export function loadMovie(file: string): { movie: Movie; base: string } {
  let movie: Movie;
  try {
    movie = JSON.parse(readFileSync(requireFile(file), "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  return { movie, base: dirname(resolve(file)) };
}

// A path from the movie file, made absolute.
function pathFrom(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

function transitionOf(scene: Scene): { type: string; duration: number; set?: string } | undefined {
  if (!scene.transition) return undefined;
  if (typeof scene.transition === "string") return { type: scene.transition, duration: 0.5 };
  return { type: scene.transition.type ?? "fade", duration: scene.transition.duration ?? 0.5, set: scene.transition.set };
}

// GPU transitions are the fx ones that are not also ffmpeg xfade names.
function isGpuTransition(type: string): boolean {
  return !TRANSITIONS.includes(type) && fx.allTransitions().has(type);
}

// The fx settings of a scene or movie, always as an object (a plain string is the effect names).
function fxOf(spec: string | Fx | undefined): Fx | undefined {
  return typeof spec === "string" ? { effect: spec } : spec;
}

// Effect names; .glsl files are made absolute (relative to the movie file).
function fxNames(spec: Fx, base: string): string[] {
  return spec.effect.split(",").map((name) => name.trim()).filter(Boolean).map((name) => (name.endsWith(".glsl") ? pathFrom(base, name) : name));
}

// Settings as fx's --set text: "bloom.amount=0.5,grade.tint=#ff8800". An object works too.
function fxSet(set: Fx["set"]): string {
  if (!set || typeof set === "string") return set ?? "";
  return Object.entries(set).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(" ") : value}`).join(",");
}

// A value at time t: glides (smoothly) between the keys that set it; `fallback` when no key sets it.
function valueAt(keys: Key[] | undefined, name: keyof Key, t: number, fallback: number): number {
  const set = (keys ?? []).filter((key) => typeof key[name] === "number").sort((a, b) => a.time - b.time);
  if (!set.length) return fallback;
  if (t <= set[0].time) return set[0][name]!;
  for (let n = 1; n < set.length; n++) {
    const [a, b] = [set[n - 1], set[n]];
    if (t <= b.time) {
      const f = (t - a.time) / Math.max(1e-6, b.time - a.time);
      return a[name]! + (b[name]! - a[name]!) * f * f * (3 - 2 * f);
    }
  }
  return set[set.length - 1][name]!;
}

function sizeOf(movie: Movie): { width: number; height: number } {
  const [width, height] = (movie.size ?? "1920x1080").split("x").map(Number);
  return { width, height };
}

// How long a scene lasts, before beat sync.
function sceneLength(scene: Scene, base: string): number {
  if (scene.duration) return scene.duration;
  if (scene.video) {
    const end = scene.to ?? video.info(pathFrom(base, scene.video)).duration;
    return end - (scene.from ?? 0);
  }
  return DEFAULT_DURATION;
}

// ---------- Checking ----------

// Find every mistake in a movie, each with a hint on how to fix it.
export function validate(movie: Movie, base: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const file = (where: string, path: unknown) => {
    if (typeof path !== "string" || !path) errors.push(`${where}: missing file name.`);
    else if (!existsSync(pathFrom(base, path))) errors.push(`${where}: file not found: ${path} (paths are relative to the movie file).`);
    else return true;
    return false;
  };
  const unknownKeys = (where: string, value: object, known: string[]) => {
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) errors.push(`${where}: unknown key "${key}". Known keys: ${known.join(", ")}.`);
    }
  };

  if (!movie || typeof movie !== "object") return { valid: false, errors: ["The movie must be a JSON object with a \"scenes\" list."] };
  unknownKeys("movie", movie, MOVIE_KEYS);
  if (movie.size !== undefined && !/^\d+x\d+$/.test(movie.size)) errors.push(`size: "${movie.size}" should look like "1920x1080" (wide), "1080x1920" (phone) or "1080x1080" (square).`);
  if (movie.fps !== undefined && !(movie.fps > 0 && movie.fps <= 120)) errors.push("fps: use a number like 24, 30 or 60.");
  if (movie.brand) file("brand", movie.brand);
  if (movie.look && !video.LOOKS[movie.look]) errors.push(`look: unknown look "${movie.look}". Looks: ${Object.keys(video.LOOKS).join(", ")}.`);
  if (typeof movie.beatSync === "string") file("beatSync", movie.beatSync);
  if (movie.beatSync === true && !movie.music) errors.push('beatSync: true means "cut on the beat of the movie\'s music", so add "music" (or give a sound file instead).');
  if (movie.music) {
    const sources = (["score", "song", "file"] as const).filter((k) => movie.music![k]);
    if (sources.length !== 1) errors.push('music: give exactly one of "score" (a score file), "song" ({"prompt": ...}) or "file".');
    if (movie.music.score) file("music", movie.music.score);
    if (movie.music.file) file("music", movie.music.file);
    if (movie.music.score && !listAssets().find((a) => a.name === "instruments")?.installed) errors.push("music: a score needs instrument sounds. Run: node joedit.ts install instruments");
    if (movie.music.song && !movie.music.song.prompt) errors.push('music: a song needs a "prompt" describing the style.');
    if (movie.music.song && !listPacks().find((p) => p.name === "song")?.installed) errors.push("music: a song needs the song pack. Run: node joedit.ts install song");
  }
  if (movie.effects) {
    try {
      video.effectsGraph(movie.effects, "in", "out");
    } catch (error) {
      errors.push(`effects: ${(error as Error).message.replace(/--/g, "")}`);
    }
  }
  // Keyframes: a list of {time, ...values}.
  const checkKeys = (where: string, keys: unknown, allowed: string[]) => {
    if (keys === undefined) return;
    if (!Array.isArray(keys)) return errors.push(`${where}: "keys" is a list like [{"time": 0, "opacity": 0}, {"time": 1, "opacity": 1}].`);
    keys.forEach((key, k) => {
      if (typeof key?.time !== "number") errors.push(`${where}, key ${k + 1}: add "time" (seconds).`);
      for (const name of Object.keys(key ?? {})) {
        if (name !== "time" && !allowed.includes(name)) errors.push(`${where}, key ${k + 1}: "${name}" cannot be keyframed here. Use: ${allowed.join(", ")}.`);
      }
    });
  };
  // GPU effects: known names (or .glsl files) and an optional .cube LUT.
  const checkFx = (where: string, spec: string | Fx | undefined) => {
    const f = fxOf(spec);
    if (!f) return;
    if (typeof f !== "object" || typeof f.effect !== "string") return errors.push(`${where}: give effect names, e.g. "fx": "bloom,grain" or {"effect": "grade", "set": {"grade.saturation": 1.2}}.`);
    unknownKeys(where, f, FX_KEYS);
    for (const name of f.effect.split(",").map((n) => n.trim())) {
      if (name.endsWith(".glsl")) file(where, name);
      else if (!fx.effectNames().includes(name)) errors.push(`${where}: unknown effect "${name}". See: node joedit.ts fx list`);
    }
    if (f.effect.split(",").map((n) => n.trim()).includes("lut") && !f.lut) errors.push(`${where}: the lut effect needs "lut": "look.cube".`);
    if (f.lut) file(where, f.lut);
    checkKeys(where, f.keys, ["amount"]);
  };
  checkFx("fx", movie.fx);

  if (!Array.isArray(movie.scenes) || !movie.scenes.length) {
    errors.push('scenes: add a list of scenes, e.g. "scenes": [{"title": "Hello", "duration": 3}].');
  } else {
    movie.scenes.forEach((scene, n) => {
      const where = `scene ${n + 1}`;
      const kinds = SCENE_KINDS.filter((kind) => scene[kind as keyof Scene] !== undefined);
      if (kinds.length !== 1) {
        errors.push(`${where}: give exactly one of ${SCENE_KINDS.join(", ")} (found ${kinds.length ? kinds.join(" and ") : "none"}).`);
        return;
      }
      unknownKeys(where, scene, SCENE_KEYS);
      if (scene.video && file(where, scene.video)) {
        const length = video.info(pathFrom(base, scene.video)).duration;
        const from = scene.from ?? 0;
        const to = scene.to ?? length;
        if (from < 0 || from >= length) errors.push(`${where}: "from" ${from} is outside the clip (0 to ${round(length)}).`);
        if (to <= from) errors.push(`${where}: "to" (${to}) must be bigger than "from" (${from}).`);
        if (to > length + 0.05) errors.push(`${where}: "to" ${to} is past the end of the clip (${round(length)}s).`);
        if (scene.fit && !["cover", "contain"].includes(scene.fit)) errors.push(`${where}: fit must be "cover" (fill, crop edges) or "contain" (whole clip, blurred background).`);
      }
      if (scene.image) file(where, scene.image);
      if (scene.html) file(where, scene.html);
      if (scene.canvas) file(where, scene.canvas);
      checkFx(`${where}, fx`, scene.fx);
      (scene.layers ?? []).forEach((layer, k) => {
        const at = `${where}, layer ${k + 1}`;
        const kinds = ["image", "video", "text"].filter((kind) => layer[kind as keyof Layer] !== undefined);
        if (kinds.length !== 1) return errors.push(`${at}: give exactly one of image, video or text.`);
        unknownKeys(at, layer, LAYER_KEYS);
        if (layer.image) file(at, layer.image);
        if (layer.video) file(at, layer.video);
        if (layer.track) file(at, layer.track);
        if (layer.blend && !BLENDS[layer.blend]) errors.push(`${at}: unknown blend "${layer.blend}". Blends: ${Object.keys(BLENDS).join(", ")}.`);
        if (layer.anchor && !["top", "center", "bottom"].includes(layer.anchor)) errors.push(`${at}: anchor is "top", "center" or "bottom".`);
        checkKeys(at, layer.keys, KEY_VALUES.filter((v) => v !== "amount"));
      });
      if (scene.motion && !IMAGE_MOTIONS.includes(scene.motion)) errors.push(`${where}: unknown motion "${scene.motion}". Motions: ${IMAGE_MOTIONS.join(", ")}.`);
      if (scene.duration !== undefined && !(scene.duration > 0)) errors.push(`${where}: duration must be more than 0 seconds.`);
      if (scene.look && !video.LOOKS[scene.look]) errors.push(`${where}: unknown look "${scene.look}". Looks: ${Object.keys(video.LOOKS).join(", ")}.`);
      const transition = transitionOf(scene);
      if (transition) {
        if (n === 0) errors.push(`${where}: the first scene has nothing to transition from. Remove its transition.`);
        if (!TRANSITIONS.includes(transition.type) && !fx.allTransitions().has(transition.type)) {
          errors.push(`${where}: unknown transition "${transition.type}". Transitions: ${TRANSITIONS.join(", ")}, or any GPU transition from: node joedit.ts fx list`);
        }
        if (n > 0) {
          try {
            const shortest = Math.min(sceneLength(scene, base), sceneLength(movie.scenes[n - 1], base));
            if (transition.duration >= shortest) errors.push(`${where}: the transition (${transition.duration}s) must be shorter than this scene and the one before (${round(shortest)}s).`);
          } catch {
            // A missing clip is already reported above.
          }
        }
      }
      (scene.text ?? []).forEach((overlay, k) => {
        if (!overlay.text) errors.push(`${where}, text ${k + 1}: add "text".`);
        if (overlay.style && !["lower-third", "title"].includes(overlay.style)) errors.push(`${where}, text ${k + 1}: style must be "lower-third" or "title".`);
      });
    });
  }

  (movie.audio ?? []).forEach((track, n) => {
    const where = `audio ${n + 1}`;
    unknownKeys(where, track, TRACK_KEYS);
    file(where, track.file);
    if (track.reverb && !sound.ROOMS[track.reverb]) errors.push(`${where}: unknown reverb "${track.reverb}". Rooms: ${Object.keys(sound.ROOMS).join(", ")}.`);
  });
  (movie.sfx ?? []).forEach((effect, n) => {
    if (!sound.SFX_TYPES.includes(effect.type)) errors.push(`sfx ${n + 1}: unknown type "${effect.type}". Types: ${sound.SFX_TYPES.join(", ")}.`);
    if (typeof effect.at !== "number") errors.push(`sfx ${n + 1}: add "at" (seconds from the start of the movie).`);
  });
  if (typeof movie.captions === "object" && movie.captions.transcript) file("captions", movie.captions.transcript);
  if (typeof movie.captions === "object" && movie.captions.speakers && !movie.captions.transcript && !movie.voiceover && !isModelInstalled("speakers")) {
    errors.push("captions: speakers needs the speakers model to tell voices apart. Run: node joedit.ts install speakers (or give a transcript from listen speakers).");
  }
  if (movie.voiceover) {
    if (!movie.voiceover.text) errors.push('voiceover: add "text" (the words to speak).');
    if (movie.voiceover.voice && !voice.VOICES[movie.voiceover.voice]) errors.push(`voiceover: unknown voice "${movie.voiceover.voice}". See: node joedit.ts voice voices`);
    if (movie.voiceover.reverb && !sound.ROOMS[movie.voiceover.reverb]) errors.push(`voiceover: unknown reverb "${movie.voiceover.reverb}". Rooms: ${Object.keys(sound.ROOMS).join(", ")}.`);
  }
  return { valid: errors.length === 0, errors };
}

// ---------- Timing ----------

// Scene lengths, rounded to whole frames, with cuts moved onto the beats if any are given.
function planTimes(movie: Movie, base: string, fps: number, beats: number[]): number[] {
  const lengths = movie.scenes.map((scene) => sceneLength(scene, base));
  if (beats.length) {
    let start = 0;
    for (let n = 1; n < lengths.length; n++) {
      const overlap = transitionOf(movie.scenes[n])?.duration ?? 0;
      const cut = start + lengths[n - 1] - overlap;
      // The nearest beat that still leaves the previous scene at least half a second.
      const options = beats.filter((b) => b - start > 0.5 + overlap);
      if (options.length) {
        const beat = options.reduce((best, b) => (Math.abs(b - cut) < Math.abs(best - cut) ? b : best));
        lengths[n - 1] += beat - cut;
      }
      start += lengths[n - 1] - overlap;
    }
  }
  return lengths.map((length) => Math.max(1, Math.round(length * fps)) / fps);
}

// ---------- Scenes ----------

type Context = {
  base: string;
  width: number;
  height: number;
  fps: number;
  draft: boolean;
  unit: number; // this render's size / the movie's full size (1, or 1/3 for drafts)
  brand: Brand;
  cache: string;
  temp: string;
};

const AUDIO_FORMAT = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
const SILENCE = ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"];

// Encoder settings. Drafts are fast and rough, finals are slow and clean.
function encoder(ctx: Context): string[] {
  return ["-c:v", "libx264", "-preset", ctx.draft ? "ultrafast" : "medium", "-crf", ctx.draft ? "28" : "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k"];
}

// Scale and crop (cover) or fit with a blurred background (contain) to the movie size.
function fitFilter(ctx: Context, fit = "cover"): string {
  const { width: W, height: H, fps } = ctx;
  const cover = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
  const end = `setsar=1,fps=${fps},format=yuv420p`;
  if (fit !== "contain") return `${cover},${end}`;
  return `split[fa][fb];[fa]${cover},gblur=sigma=30,eq=brightness=-0.08[bg];[fb]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,${end}`;
}

// A fingerprint of everything that changes how a scene looks, so unchanged scenes can be reused.
function sceneKey(scene: Scene, duration: number, ctx: Context): string {
  const effects = fxOf(scene.fx);
  const used = [
    scene.video, scene.image, scene.html, scene.canvas,
    ...(scene.layers ?? []).flatMap((layer) => [layer.image, layer.video, layer.track]),
    ...(effects ? [effects.lut, ...effects.effect.split(",").map((n) => n.trim()).filter((n) => n.endsWith(".glsl"))] : []),
  ];
  const files = used.filter(Boolean).map((path) => {
    const stats = statSync(pathFrom(ctx.base, path!));
    return `${path}:${stats.size}:${stats.mtimeMs}`;
  });
  const recipe = { scene, duration, files, width: ctx.width, height: ctx.height, fps: ctx.fps, draft: ctx.draft, brand: ctx.brand, CACHE_VERSION };
  return createHash("sha256").update(JSON.stringify(recipe)).digest("hex").slice(0, 16);
}

// Render one scene into a segment: exact size, frame rate, length and stereo sound.
async function renderScene(scene: Scene, n: number, duration: number, ctx: Context): Promise<{ file: string; cached: boolean }> {
  const output = join(ctx.cache, `scene-${sceneKey(scene, duration, ctx)}.mp4`);
  if (existsSync(output)) return { file: output, cached: true };
  const { width, height, fps } = ctx;
  const inputs: string[] = [];
  let graph = "";

  // 1. The picture and sound of the scene.
  if (scene.video) {
    const clip = pathFrom(ctx.base, scene.video);
    const hasAudio = video.info(clip).hasAudio && scene.volume !== 0;
    inputs.push("-ss", String(scene.from ?? 0), "-t", String(duration), "-i", clip);
    if (!hasAudio) inputs.push(...SILENCE);
    // tpad holds the last frame if the clip is shorter than the scene.
    graph += `[0:v]${fitFilter(ctx, scene.fit)},tpad=stop_mode=clone:stop_duration=${duration}[base];`;
    graph += hasAudio ? `[0:a]${AUDIO_FORMAT},volume=${scene.volume ?? 1},apad[a]` : `[1:a]${AUDIO_FORMAT}[a]`;
  } else {
    const made = join(ctx.temp, `scene-${n}.mp4`);
    if (scene.motion?.startsWith("parallax")) {
      // "parallax" is a slow push in; "parallax-orbit", "parallax-pan-left", ... pick another 3D camera move.
      const motion = scene.motion === "parallax" ? "dolly" : scene.motion.slice("parallax-".length);
      await picture.parallax(pathFrom(ctx.base, scene.image!), made, { duration, motion, width, height, fps });
    } else if (scene.image) {
      await ffmpegAsync(picture.animateArgs(pathFrom(ctx.base, scene.image), made, { duration, motion: scene.motion ?? "zoom-in", width, height, fps }).args);
    } else if (scene.title !== undefined) {
      await graphics.title(made, { text: scene.title, subtitle: scene.subtitle, duration, width, height, fps, brand: ctx.brand });
    } else if (scene.html) {
      await graphics.render(pathFrom(ctx.base, scene.html), made, { duration, width, height, fps, data: scene.data });
    } else if (scene.canvas) {
      await graphics.canvas(pathFrom(ctx.base, scene.canvas), made, { duration, width, height, fps, data: scene.data, brand: ctx.brand });
    } else {
      await ffmpegAsync(["-f", "lavfi", "-i", `color=c=${scene.color}:s=${width}x${height}:r=${fps}:d=${duration}`, "-pix_fmt", "yuv420p", made]);
    }
    inputs.push("-i", made, ...SILENCE);
    graph += `[0:v]${fitFilter(ctx)}[base];[1:a]${AUDIO_FORMAT}[a]`;
  }

  // 2. Text on top (rendered as see-through video, shown from `at` seconds into the scene).
  let label = "base";
  const overlays = scene.text ?? [];
  for (const [k, overlay] of overlays.entries()) {
    const file = join(ctx.temp, `text-${n}-${k}.mov`);
    const options = { text: overlay.text, subtitle: overlay.subtitle, duration: overlay.duration ?? DEFAULT_DURATION, width, height, fps, brand: ctx.brand, transparent: true };
    if (overlay.style === "title") await graphics.title(file, options);
    else await graphics.lowerThird(file, options);
    const index = inputs.filter((arg) => arg === "-i").length;
    inputs.push("-itsoffset", String(overlay.at ?? 0), "-i", file);
    graph += `;[${label}][${index}:v]overlay=0:0:eof_action=pass[t${k}]`;
    label = `t${k}`;
  }

  // 3. The scene's own color grade.
  graph += scene.look ? `;${video.gradeGraph(scene.look, 1, label, "v")}` : `;[${label}]null[v]`;

  // Encode to a temporary name first, so a failed or interrupted render never leaves a broken file in the cache.
  const partial = join(ctx.temp, `partial-${n}.mp4`);
  await ffmpegAsync([...inputs, "-filter_complex", graph, "-map", "[v]", "-map", "[a]", ...encoder(ctx), "-r", String(fps), "-t", String(duration), partial]);

  // 4. Layers (Skia) and GPU effects, drawn on every frame.
  if (scene.layers?.length || scene.fx) {
    const drawn = join(ctx.temp, `drawn-${n}.mp4`);
    const clip = scene.video ? { from: scene.from ?? 0, fit: scene.fit } : undefined;
    await framePass(partial, drawn, duration, ctx, scene.layers ?? [], fxOf(scene.fx), clip);
    renameSync(drawn, output);
  } else {
    renameSync(partial, output);
  }
  return { file: output, cached: false };
}

// ---------- Layers and GPU effects ----------

// A track.json from `look track`: boxes in the clip's own pixels.
type TrackFile = { width: number; height: number; points: { time: number; x: number; y: number; width: number; height: number }[] };

// Where a tracked thing is at `time` seconds of its clip, in this render's pixels.
// The track was made on the clip itself, so its box is scaled the way the scene fits the clip into the frame.
function trackedBox(track: TrackFile, time: number, ctx: Context, fit = "cover") {
  const points = track.points;
  let point = points[0];
  for (let k = 1; k < points.length; k++) {
    const [a, b] = [points[k - 1], points[k]];
    if (time >= b.time) point = b;
    else if (time > a.time) {
      const f = (time - a.time) / (b.time - a.time);
      point = { time, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, width: a.width + (b.width - a.width) * f, height: a.height + (b.height - a.height) * f };
      break;
    }
  }
  const s = (fit === "contain" ? Math.min : Math.max)(ctx.width / track.width, ctx.height / track.height);
  const left = (ctx.width - track.width * s) / 2;
  const top = (ctx.height - track.height * s) / 2;
  return { x: left + point.x * s, y: top + point.y * s, width: point.width * s, height: point.height * s };
}

// Get a layer ready to draw: load its picture, open its video, size its text.
// Returns draw(c, t): draw the layer onto canvas context c at `t` seconds into the scene.
async function prepareLayer(layer: Layer, sceneLength: number, ctx: Context, clip?: { from: number; fit?: string }) {
  const { createCanvas, loadImage, ImageData } = await skia();
  const W = ctx.width;
  const H = ctx.height;
  const start = layer.at ?? 0;
  const length = layer.duration ?? sceneLength - start;
  const track: TrackFile | undefined = layer.track ? JSON.parse(readFileSync(pathFrom(ctx.base, layer.track), "utf8")) : undefined;
  if (track && !track.points?.length) throw new Error(`${layer.track} has no points. Make it with: node joedit.ts look track <video> ${layer.track}`);

  // The content: something with a natural width and height, and a way to draw it centred at (0, 0).
  let natural = { width: 1, height: 1 };
  let paint: (c: any, t: number, width: number, height: number) => Promise<void>;
  if (layer.image) {
    const image = await loadImage(readFileSync(pathFrom(ctx.base, layer.image)));
    natural = { width: image.width, height: image.height };
    paint = async (c, _t, w, h) => c.drawImage(image, -w / 2, -h / 2, w, h);
  } else if (layer.video) {
    const file = pathFrom(ctx.base, layer.video);
    const details = video.info(file);
    const frameWidth = Math.max(2, Math.round(((layer.width ?? 0.3) * W) / 2) * 2);
    natural = { width: frameWidth, height: Math.max(2, Math.round((frameWidth * details.height) / details.width / 2) * 2) };
    const frames = readFrames(file, { fps: ctx.fps, start: layer.from ?? 0, width: natural.width, height: natural.height });
    const holder = createCanvas(natural.width, natural.height);
    let shown = -1;
    paint = async (c, t, w, h) => {
      // Step the clip forward to this moment (the last frame stays when the clip runs out).
      const wanted = Math.floor(t * ctx.fps + 1e-6);
      while (shown < wanted) {
        const next = await frames.next();
        if (next.done) break;
        holder.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(next.value.pixels), natural.width, natural.height), 0, 0);
        shown++;
      }
      c.drawImage(holder, -w / 2, -h / 2, w, h);
    };
  } else {
    const style: TextStyle = {
      font: ctx.brand.fonts.heading,
      weight: 800,
      color: "#FFFFFF",
      shadow: 12 * ctx.unit,
      ...layer.style,
      size: (layer.style?.size ?? 72) * ctx.unit,
      align: "center",
    };
    if (style.maxWidth) style.maxWidth *= ctx.unit;
    if (style.strokeWidth) style.strokeWidth *= ctx.unit;
    if (style.padding) style.padding *= ctx.unit;
    const measured = measureText(createCanvas(8, 8).getContext("2d"), layer.text!, style);
    natural = { width: measured.width, height: measured.height };
    paint = async (c) => void drawText(c, layer.text!, 0, -measured.height / 2, style);
  }

  return async (c: any, sceneTime: number) => {
    const t = sceneTime - start;
    if (t < 0 || t >= length) return;
    const keys = layer.keys;
    // Size: pictures and videos by width (a fraction of the frame), text by its own size.
    const scale = valueAt(keys, "scale", t, layer.scale ?? 1);
    const width = layer.text ? natural.width * scale : valueAt(keys, "width", t, layer.width ?? 0.3) * W * scale;
    const height = (width * natural.height) / natural.width;
    // Position: the centre, as fractions of the frame; or offsets from a tracked thing.
    let x = valueAt(keys, "x", t, layer.x ?? (track ? 0 : 0.5)) * W;
    let y = valueAt(keys, "y", t, layer.y ?? (track ? 0 : 0.5)) * H;
    if (track) {
      const box = trackedBox(track, (clip?.from ?? 0) + sceneTime, ctx, clip?.fit);
      const anchor = layer.anchor ?? "top";
      x += box.x + box.width / 2;
      y += anchor === "top" ? box.y - height / 2 - H * 0.02 : anchor === "bottom" ? box.y + box.height + height / 2 + H * 0.02 : box.y + box.height / 2;
    }
    let opacity = valueAt(keys, "opacity", t, layer.opacity ?? 1);
    if (layer.fadeIn) opacity *= Math.min(1, t / layer.fadeIn);
    if (layer.fadeOut) opacity *= Math.min(1, (length - t) / layer.fadeOut);
    if (opacity <= 0) return;
    c.save();
    c.globalAlpha = Math.min(1, opacity);
    c.globalCompositeOperation = BLENDS[layer.blend ?? "normal"];
    c.translate(x, y);
    c.rotate((valueAt(keys, "rotate", t, layer.rotate ?? 0) * Math.PI) / 180);
    await paint(c, t, width, height);
    c.restore();
  };
}

// Draw layers and run GPU effects on every frame of a clip, keeping its sound.
// clip: the scene's video (start and fit), so tracked layers line up with it.
async function framePass(input: string, output: string, length: number, ctx: Context, layers: Layer[], effects?: Fx, clip?: { from: number; fit?: string }) {
  const { width, height, fps } = ctx;
  const drawers = await Promise.all(layers.map((layer) => prepareLayer(layer, length, ctx, clip)));
  const steps = effects ? fx.prepareEffects(fxNames(effects, ctx.base), fx.parseSet(fxSet(effects.set)), effects.lut ? pathFrom(ctx.base, effects.lut) : undefined) : [];
  const { createCanvas, ImageData } = await skia();
  const canvas = createCanvas(width, height);
  const c = canvas.getContext("2d");
  const writer = writeVideo(output, { width, height, fps, audio: input, draft: ctx.draft });
  for await (const frame of readFrames(input, { width, height })) {
    let pixels: Buffer = frame.pixels;
    if (drawers.length) {
      c.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
      for (const draw of drawers) await draw(c, frame.time);
      const data = c.getImageData(0, 0, width, height).data;
      pixels = Buffer.from(data.buffer, data.byteOffset, data.length);
    }
    if (steps.length) {
      const amount = valueAt(effects!.keys, "amount", frame.time, effects!.amount ?? 1);
      pixels = fx.effectFrame(pixels, width, height, steps, { time: frame.time, progress: Math.min(1, frame.time / length), amount });
    }
    await writer.write(pixels);
  }
  await writer.finish();
}

// ---------- Joining, sound and finishing ----------

// Join the scenes, with transitions where asked. Returns the movie length.
// ffmpeg's transitions (xfade) run inside the join. GPU transitions (fx) are rendered first as short
// overlap clips (the end of one scene blending into the start of the next) and put between the trimmed scenes.
async function joinScenes(movie: Movie, files: string[], lengths: number[], output: string, ctx: Context): Promise<number> {
  const transitions = movie.scenes.map(transitionOf);
  if (!transitions.some(Boolean)) {
    // No transitions: join the files directly (very fast, no re-encoding).
    const list = join(ctx.temp, "scenes.txt");
    writeFileSync(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
    ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", output]);
    return lengths.reduce((sum, l) => sum + l, 0);
  }
  // The GPU overlap clips, added as extra inputs after the scenes. Their length is whole frames.
  const inputs = files.flatMap((f) => ["-i", f]);
  const overlaps: Record<number, { input: number; duration: number }> = {};
  for (let n = 1; n < files.length; n++) {
    const t = transitions[n];
    if (!t || !isGpuTransition(t.type)) continue;
    const duration = Math.max(1, Math.round(t.duration * ctx.fps)) / ctx.fps;
    const clip = join(ctx.temp, `overlap-${n}.mp4`);
    const shader = fx.prepareTransition(t.type, fx.parseSet(t.set));
    const writer = writeVideo(clip, { width: ctx.width, height: ctx.height, fps: ctx.fps, draft: ctx.draft });
    for await (const pixels of fx.transitionFrames(shader, files[n - 1], files[n], ctx, lengths[n - 1] - duration, duration)) await writer.write(pixels);
    await writer.finish();
    overlaps[n] = { input: inputs.length / 2, duration };
    inputs.push("-i", clip);
  }
  // Give every clip the same time base and pixel shape, which xfade and concat need to work together.
  let graph = inputs.filter((arg) => arg === "-i").map((_, n) => `[${n}:v]settb=AVTB,setsar=1[in${n}];`).join("");
  let v = "[in0]";
  let a = "[0:a]";
  let length = lengths[0];
  for (let n = 1; n < files.length; n++) {
    const t = transitions[n];
    const overlap = overlaps[n];
    if (overlap) {
      // Everything so far minus its last moment, then the overlap clip, then this scene minus its first moment.
      const d = overlap.duration;
      graph += `${v}trim=end=${round(length - d, 4)},setpts=PTS-STARTPTS[pre${n}];`;
      graph += `[in${n}]trim=start=${round(d, 4)},setpts=PTS-STARTPTS[post${n}];`;
      graph += `[pre${n}][in${overlap.input}][post${n}]concat=n=3:v=1:a=0[v${n}];`;
      graph += `${a}[${n}:a]acrossfade=d=${round(d, 4)}[a${n}];`;
      length += lengths[n] - d;
    } else if (t) {
      graph += `${v}[in${n}]xfade=transition=${t.type}:duration=${t.duration}:offset=${round(length - t.duration, 3)}[v${n}];`;
      graph += `${a}[${n}:a]acrossfade=d=${t.duration}[a${n}];`;
      length += lengths[n] - t.duration;
    } else {
      graph += `${v}[in${n}]concat=n=2:v=1:a=0[v${n}];${a}[${n}:a]concat=n=2:v=0:a=1[a${n}];`;
      length += lengths[n];
    }
    v = `[v${n}]`;
    a = `[a${n}]`;
  }
  ffmpeg([...inputs, "-filter_complex", graph.slice(0, -1), "-map", v, "-map", a, ...encoder(ctx), output]);
  return length;
}

// Mix the scene sound with music, voice-over and sound effects (Web Audio), then make it -14 LUFS.
// Music (duck: true) dips a moment before anyone speaks, in the scenes or the voice-over, and comes back after.
async function mixSound(movie: Movie, tracks: Track[], joined: string, length: number, output: string, ctx: Context) {
  const clips: sound.Clip[] = [{ file: joined, role: "voice" }]; // the scenes' own sound
  for (const track of tracks) {
    const { duck, ...rest } = track;
    clips.push({ ...rest, file: pathFrom(ctx.base, track.file), role: duck ? "music" : "voice" });
  }
  for (const effect of movie.sfx ?? []) {
    const file = join(ctx.cache, `sfx-${effect.type}-${effect.duration ?? "default"}.wav`);
    if (!existsSync(file)) sound.sfx(file, effect.type, effect.duration);
    clips.push({ file, at: effect.at, volume: effect.volume ?? 0.8, role: "effect" });
  }
  const raw = join(ctx.temp, "mix.wav");
  await sound.mixClips(clips, raw, { length });
  // Silent movies stay silent; everything else is set to the online standard loudness.
  if (listen.loudness(raw).lufs > -60) sound.normalize(raw, output);
  else ffmpeg(["-i", raw, "-ar", "48000", output]);
}

// Make the movie's music (cached). Composed scores also give their exact beat times.
async function makeMusic(spec: MusicSpec, ctx: Context): Promise<{ file: string; beats?: number[] }> {
  if (spec.file) return { file: pathFrom(ctx.base, spec.file) };
  if (spec.score) {
    const scoreFile = pathFrom(ctx.base, spec.score);
    const key = createHash("sha256").update(readFileSync(scoreFile)).digest("hex").slice(0, 16);
    const file = join(ctx.cache, `score-${key}.wav`);
    const score = JSON.parse(readFileSync(scoreFile, "utf8"));
    const made = existsSync(file) ? { beats: music.scoreToMidi(score).beats } : await music.compose(scoreFile, file);
    const secondsPerBeat = 60 / (score.tempo ?? 120);
    return { file, beats: Array.from({ length: Math.ceil(made.beats) }, (_, k) => k * secondsPerBeat) };
  }
  const key = createHash("sha256").update(JSON.stringify(spec.song)).digest("hex").slice(0, 16);
  const file = join(ctx.cache, `song-${key}.wav`);
  if (!existsSync(file)) music.song(file, spec.song!.prompt, spec.song!);
  return { file };
}

// Speak the voice-over (cached like scenes). Returns the sound file and the time of every word.
async function makeVoiceover(spec: NonNullable<Movie["voiceover"]>, ctx: Context): Promise<{ file: string; words: graphics.CaptionWord[] }> {
  const key = createHash("sha256").update(JSON.stringify({ text: spec.text, voice: spec.voice, speed: spec.speed })).digest("hex").slice(0, 16);
  const file = join(ctx.cache, `voice-${key}.wav`);
  const wordsFile = join(ctx.cache, `voice-${key}.json`);
  if (!existsSync(file) || !existsSync(wordsFile)) {
    await voice.speak(file, spec.text, { voice: spec.voice, speed: spec.speed, words: wordsFile });
  }
  return { file, words: JSON.parse(readFileSync(wordsFile, "utf8")).words ?? [] };
}

// Render a movie file into a finished video.
export async function renderMovie(file: string, output: string, draft = false) {
  const { movie, base } = loadMovie(file);
  const { valid, errors } = validate(movie, base);
  if (!valid) throw new Error(`The movie has ${errors.length} problem(s):\n- ${errors.join("\n- ")}`);

  const started = Date.now();
  const size = sizeOf(movie);
  // Drafts are a third of the size (kept even, as video needs).
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const width = draft ? even(size.width / 3) : size.width;
  const height = draft ? even(size.height / 3) : size.height;
  const fps = movie.fps ?? 30;
  const cache = join(base, ".joedit-cache");
  mkdirSync(cache, { recursive: true });

  return withTempDir(async (temp) => {
    const brand = loadBrand(movie.brand ? pathFrom(base, movie.brand) : undefined);
    const ctx: Context = { base, width, height, fps, draft, unit: width / size.width, brand, cache, temp };
    // Music first, because beatSync can cut to its beats.
    const backing = movie.music ? await makeMusic(movie.music, ctx) : undefined;
    let beats: number[] = [];
    if (movie.beatSync === true && backing) beats = backing.beats ?? listen.beats(backing.file).beats;
    if (typeof movie.beatSync === "string") beats = listen.beats(pathFrom(base, movie.beatSync)).beats;
    const lengths = planTimes(movie, base, fps, beats);

    // 1. Every scene (reusing cached ones), a few at the same time.
    const results: { file: string; cached: boolean }[] = [];
    let next = 0;
    const worker = async () => {
      while (next < movie.scenes.length) {
        const n = next++;
        results[n] = await renderScene(movie.scenes[n], n, lengths[n], ctx);
      }
    };
    await Promise.all(Array.from({ length: SCENES_AT_ONCE }, worker));
    const segments = results.map((r) => r.file);
    const cached = results.filter((r) => r.cached).length;

    // 2. Join (and GPU effects over the whole film), 3. mix the sound.
    let joined = join(temp, "joined.mp4");
    const length = await joinScenes(movie, segments, lengths, joined, ctx);
    if (movie.fx) {
      const withFx = join(temp, "joined-fx.mp4");
      await framePass(joined, withFx, length, ctx, [], fxOf(movie.fx));
      joined = withFx;
    }
    const tracks = [...(movie.audio ?? [])];
    if (backing) {
      const m = movie.music!;
      tracks.push({ file: backing.file, volume: m.volume ?? 0.8, duck: m.duck ?? true, loop: m.loop, fadeIn: m.fadeIn, fadeOut: m.fadeOut ?? 2 });
    }
    const spoken = movie.voiceover ? await makeVoiceover(movie.voiceover, ctx) : undefined;
    if (spoken) tracks.push({ file: spoken.file, at: movie.voiceover!.at ?? 0, volume: movie.voiceover!.volume ?? 1, reverb: movie.voiceover!.reverb });
    const mixed = join(temp, "mix-final.wav");
    await mixSound(movie, tracks, joined, length, mixed, ctx);
    // Sound that would be cut off by the end of the film (not for looped music, which is meant to be cut).
    const warnings: string[] = [];
    for (const track of tracks) {
      if (track.loop) continue;
      const end = (track.at ?? 0) + (track.to ?? sound.info(pathFrom(base, track.file)).duration) - (track.from ?? 0);
      if (end > length + 0.1) {
        const name = track.file === spoken?.file ? "the voice-over" : track.file;
        warnings.push(`${name} ends at ${round(end)}s but the film is ${round(length)}s, so it is cut off. Make the scenes longer (or start it earlier).`);
      }
    }

    // 4. Captions: from a transcript, from the voice-over's own word times, or by transcribing the final sound.
    let captionFile = "";
    if (movie.captions) {
      const options = typeof movie.captions === "object" ? movie.captions : {};
      let words: graphics.CaptionWord[] = [];
      if (options.transcript) {
        words = JSON.parse(readFileSync(pathFrom(base, options.transcript), "utf8")).words ?? [];
      } else if (spoken) {
        const at = movie.voiceover!.at ?? 0;
        words = spoken.words.map((w) => ({ word: w.word, start: w.start + at, end: w.end + at }));
      } else {
        // Transcribe the film's sound; with speakers, also tell the voices apart.
        const transcript = join(temp, "words.json");
        if (options.speakers) await listen.speakers(mixed, transcript, { model: options.model });
        else await listen.transcribe(mixed, transcript, options.model ?? "base");
        words = JSON.parse(readFileSync(transcript, "utf8")).words ?? [];
      }
      if (words.length) {
        captionFile = join(temp, "captions.mov");
        await graphics.captionsOverlay(words, captionFile, {
          width, height, fps, duration: length, style: options.style, position: options.position, brand, speakerColors: options.speakers,
        });
      }
    }

    // 5. One final pass: look, effects, captions and the mixed sound.
    let graph = "";
    let label = "0:v";
    if (movie.look) {
      graph += `${video.gradeGraph(movie.look, movie.lookStrength ?? 1, label, "graded")};`;
      label = "graded";
    }
    if (movie.effects) {
      graph += `${video.effectsGraph(movie.effects, label, "fx")};`;
      label = "fx";
    }
    const inputs = ["-i", joined, "-i", mixed];
    if (captionFile) {
      inputs.push("-i", captionFile);
      graph += `[${label}][2:v]overlay=0:0:eof_action=pass[cap];`;
      label = "cap";
    }
    const finish = ["-movflags", "+faststart", "-t", String(round(length, 3)), output];
    if (label === "0:v") {
      // Nothing to draw on the picture: keep the joined video as it is (no re-encoding), add the sound.
      ffmpeg([...inputs, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", ...finish]);
    } else {
      graph += `[${label}]format=yuv420p[v]`;
      ffmpeg([...inputs, "-filter_complex", graph, "-map", "[v]", "-map", "1:a", ...encoder(ctx), ...finish]);
    }

    // 6. Quality check (loaded here because joedit.ts also loads this file).
    const { check } = await import("./joedit.ts");
    const report = check(output);
    return {
      duration: round(length),
      size: `${width}x${height}`,
      draft,
      scenes: movie.scenes.length,
      rendered: movie.scenes.length - cached,
      cached,
      seconds: round((Date.now() - started) / 1000, 1),
      check: { passed: report.passed, problems: report.problems },
      ...(warnings.length ? { warnings } : {}),
    };
  });
}

// ---------- Templates ----------

// Starting points. Each one renders after its placeholder files are replaced (validate lists them).
export const TEMPLATES: Record<string, { description: string; movie: Movie }> = {
  short: {
    description: "Vertical social video (9:16): hook title, two clips with a name tag, call to action, ducked music, karaoke captions",
    movie: {
      notes: "Replace clip1.mp4, clip2.mp4 and music.mp3 with your files. Captions transcribe the sound (needs: install whisper).",
      size: "1080x1920",
      fps: 30,
      look: "vivid",
      lookStrength: 0.6,
      scenes: [
        { title: "Wait for it…", duration: 1.5 },
        { video: "clip1.mp4", from: 0, to: 6, transition: "slideup", text: [{ text: "Your Name", subtitle: "@yourhandle", at: 0.5, duration: 3 }] },
        { video: "clip2.mp4", from: 0, to: 6, transition: { type: "smoothleft", duration: 0.4 } },
        { title: "Follow for more", subtitle: "@yourhandle", duration: 2, transition: "fadeblack" },
      ],
      audio: [{ file: "music.mp3", volume: 0.5, duck: true, loop: true, fadeOut: 1.5 }],
      sfx: [{ type: "whoosh", at: 1.2 }],
      captions: { style: "karaoke" },
    },
  },
  ad: {
    description: "Wide product ad (16:9): product photos with camera moves, headline, price counter page, end card, music",
    movie: {
      notes: "Replace product1.jpg, product2.jpg and music.mp3. Put your colors and fonts in brand.json and add \"brand\": \"brand.json\".",
      size: "1920x1080",
      look: "cinematic",
      effects: { vignette: 0.3 },
      scenes: [
        { image: "product1.jpg", motion: "zoom-in", duration: 3.5, text: [{ text: "Meet the new thing", style: "title", at: 0.3, duration: 3 }] },
        { image: "product2.jpg", motion: "pan-right", duration: 3.5, transition: "dissolve", text: [{ text: "Made to last", subtitle: "Lifetime warranty", at: 0.5, duration: 2.8 }] },
        { title: "Available now", subtitle: "example.com", duration: 3, transition: "fadeblack" },
      ],
      audio: [{ file: "music.mp3", volume: 0.8, fadeIn: 0.5, fadeOut: 2 }],
      sfx: [{ type: "boom", at: 0.3 }, { type: "whoosh", at: 3.1 }, { type: "hit", at: 6.6 }],
    },
  },
  explainer: {
    description: "Explainer (16:9): title, an animated chart you draw (canvas), a picture, outro, voice-over with music ducked under it, subtitles",
    movie: {
      notes: "Write chart.mjs (export default function draw(ctx, t, info); info.data holds the values), replace diagram.png, voiceover.wav and music.mp3.",
      size: "1920x1080",
      scenes: [
        { title: "How it works", subtitle: "in 30 seconds", duration: 3 },
        { canvas: "chart.mjs", duration: 6, data: { values: [3, 7, 12] }, transition: "fade" },
        { image: "diagram.png", motion: "zoom-in", duration: 6, transition: "wipeleft" },
        { title: "Thanks for watching", duration: 3, transition: "fadeblack" },
      ],
      audio: [
        { file: "voiceover.wav", at: 0.5 },
        { file: "music.mp3", volume: 0.4, duck: true, loop: true, fadeOut: 2 },
      ],
      captions: { style: "minimal" },
    },
  },
  slideshow: {
    description: "Photo slideshow (16:9): pictures with gentle camera moves and crossfades, cut on the music's beat",
    movie: {
      notes: "Replace photo1.jpg … photo4.jpg and music.mp3. beatSync moves each cut onto the nearest beat.",
      size: "1920x1080",
      look: "warm",
      lookStrength: 0.5,
      scenes: [
        { image: "photo1.jpg", motion: "zoom-in", duration: 4 },
        { image: "photo2.jpg", motion: "pan-left", duration: 4, transition: "fade" },
        { image: "photo3.jpg", motion: "zoom-out", duration: 4, transition: "fade" },
        { image: "photo4.jpg", motion: "pan-right", duration: 4, transition: "fade" },
        { title: "Summer 2026", duration: 3, transition: "fadeblack" },
      ],
      audio: [{ file: "music.mp3", fadeIn: 1, fadeOut: 3 }],
      beatSync: "music.mp3",
    },
  },
  lyric: {
    description: "Lyric video (16:9): background pictures with big centered karaoke words from the song",
    movie: {
      notes: "Replace background1.jpg, background2.jpg and song.mp3. Captions transcribe the song (or set captions.transcript to fixed lyrics with times).",
      size: "1920x1080",
      look: "noir",
      lookStrength: 0.4,
      effects: { grain: 0.2, vignette: 0.5 },
      scenes: [
        { image: "background1.jpg", motion: "zoom-in", duration: 15 },
        { image: "background2.jpg", motion: "zoom-out", duration: 15, transition: { type: "fade", duration: 1.5 } },
      ],
      audio: [{ file: "song.mp3", fadeOut: 2 }],
      captions: { style: "karaoke", position: "center" },
    },
  },
  podcast: {
    description: "Podcast clip (9:16): a wide podcast video reframed for phones, hook title, karaoke captions",
    movie: {
      notes: "Replace podcast.mp4 and set from/to to the best moment. Tip: run video remove-silence on the clip first for tighter pacing.",
      size: "1080x1920",
      scenes: [
        { title: "The best advice I ever got", duration: 2 },
        { video: "podcast.mp4", from: 0, to: 30, fit: "cover", transition: "fade" },
      ],
      captions: { style: "bold" },
    },
  },
};

// ---------- CLI ----------

export const commands: Record<string, Command> = {
  render: {
    usage: "render <movie.json> <output.mp4> [--draft]  (draft = a third of the size, fast, for checking)",
    run: (a) => {
      if (a.positional.length < 2) throw new Error("Give the movie file and the output video.");
      return renderMovie(a.positional[0], a.positional[1], a.flags.draft === "true");
    },
  },
  validate: {
    usage: "validate <movie.json>  → every problem with a hint to fix it",
    run: (a) => {
      const { movie, base } = loadMovie(a.positional[0]);
      return validate(movie, base);
    },
  },
  templates: {
    usage: "templates  → the starting points you can copy",
    run: () => ({ templates: Object.entries(TEMPLATES).map(([name, t]) => ({ name, description: t.description })) }),
  },
  template: {
    usage: `template <${Object.keys(TEMPLATES).join("|")}> <movie.json>  (writes a starting movie file)`,
    run: (a) => {
      const [name, output] = a.positional;
      const template = TEMPLATES[name];
      if (!template) throw new Error(`Unknown template "${name}". Templates: ${Object.keys(TEMPLATES).join(", ")}`);
      if (!output) throw new Error("Give the movie file to write, e.g. movie.json.");
      writeFileSync(output, JSON.stringify(template.movie, null, 2) + "\n");
      return { output, notes: template.movie.notes };
    },
  },
};

// Only run the CLI when this file is executed directly (not when imported).
if (import.meta.main) {
  runCli("joEdit movie: node joedit.ts movie <command> ...", commands, process.argv.slice(2));
}

// Movies from one JSON file: scenes, transitions, text, music, sound effects, captions and a look.
// Each scene is rendered once and cached, so changing one scene only re-renders that scene.
// CLI:     node joedit.ts movie <command> ...
// Library: import { renderMovie } from "./joEdit/movie.ts"
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ffmpeg, listAssets, listPacks, loadBrand, requireFile, round, runCli, withTempDir, type Brand, type Command } from "./shared.ts";
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

export type Scene = {
  // What the scene shows (one of these):
  video?: string;
  image?: string;
  title?: string;
  html?: string;
  color?: string;
  // Options:
  duration?: number; // seconds (videos: defaults to from..to or the whole clip)
  from?: number; // video: start time in the clip
  to?: number; // video: end time in the clip
  volume?: number; // video: loudness of the clip's own sound (0 = silent)
  fit?: "cover" | "contain"; // video: fill the frame (crop) or fit inside it (blurred background)
  motion?: string; // image: zoom-in, zoom-out, pan-left, pan-right, pan-up, pan-down, none
  subtitle?: string; // title: smaller second line
  data?: unknown; // html: given to the page as window.joedit.data
  look?: string; // a color grade for this scene only
  transition?: string | { type?: string; duration?: number }; // how this scene appears after the previous one
  text?: TextOverlay[];
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
};

export type Movie = {
  size?: string; // "1920x1080", "1080x1920", "1080x1080"
  fps?: number;
  brand?: string; // brand.json
  look?: string;
  lookStrength?: number;
  effects?: video.Effects;
  scenes: Scene[];
  audio?: Track[];
  sfx?: { type: string; at: number; volume?: number; duration?: number }[];
  captions?: boolean | { style?: graphics.CaptionStyle; position?: string; transcript?: string; model?: string };
  voiceover?: { text: string; voice?: string; speed?: number; at?: number; volume?: number }; // spoken by the tts pack
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

// ffmpeg's xfade transitions that work well. Any of these can be a scene's transition type.
export const TRANSITIONS = [
  "fade", "fadeblack", "fadewhite", "dissolve", "wipeleft", "wiperight", "wipeup", "wipedown",
  "slideleft", "slideright", "slideup", "slidedown", "smoothleft", "smoothright", "smoothup", "smoothdown",
  "circleopen", "circleclose", "circlecrop", "rectcrop", "radial", "pixelize", "zoomin", "hblur", "distance",
  "squeezeh", "squeezev", "diagtl", "diagbr", "hlslice", "hrslice", "coverleft", "coverright", "revealleft", "revealright",
];

const SCENE_KINDS = ["video", "image", "title", "html", "color"];
const SCENE_KEYS = [...SCENE_KINDS, "duration", "from", "to", "volume", "fit", "motion", "subtitle", "data", "look", "transition", "text"];
const MOVIE_KEYS = ["size", "fps", "brand", "look", "lookStrength", "effects", "scenes", "audio", "sfx", "captions", "voiceover", "music", "beatSync", "notes"];
const TRACK_KEYS = ["file", "at", "volume", "from", "to", "fadeIn", "fadeOut", "loop", "duck"];
const DEFAULT_DURATION = 3;
const CACHE_VERSION = 1; // bump to throw away old cached scenes after changing how scenes render

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

function transitionOf(scene: Scene): { type: string; duration: number } | undefined {
  if (!scene.transition) return undefined;
  if (typeof scene.transition === "string") return { type: scene.transition, duration: 0.5 };
  return { type: scene.transition.type ?? "fade", duration: scene.transition.duration ?? 0.5 };
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
      if (scene.motion && !picture.MOTIONS.includes(scene.motion)) errors.push(`${where}: unknown motion "${scene.motion}". Motions: ${picture.MOTIONS.join(", ")}.`);
      if (scene.duration !== undefined && !(scene.duration > 0)) errors.push(`${where}: duration must be more than 0 seconds.`);
      if (scene.look && !video.LOOKS[scene.look]) errors.push(`${where}: unknown look "${scene.look}". Looks: ${Object.keys(video.LOOKS).join(", ")}.`);
      const transition = transitionOf(scene);
      if (transition) {
        if (n === 0) errors.push(`${where}: the first scene has nothing to transition from. Remove its transition.`);
        if (!TRANSITIONS.includes(transition.type)) errors.push(`${where}: unknown transition "${transition.type}". Transitions: ${TRANSITIONS.join(", ")}.`);
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
  });
  (movie.sfx ?? []).forEach((effect, n) => {
    if (!sound.SFX_TYPES.includes(effect.type)) errors.push(`sfx ${n + 1}: unknown type "${effect.type}". Types: ${sound.SFX_TYPES.join(", ")}.`);
    if (typeof effect.at !== "number") errors.push(`sfx ${n + 1}: add "at" (seconds from the start of the movie).`);
  });
  if (typeof movie.captions === "object" && movie.captions.transcript) file("captions", movie.captions.transcript);
  if (movie.voiceover) {
    if (!movie.voiceover.text) errors.push('voiceover: add "text" (the words to speak).');
    if (movie.voiceover.voice && !voice.VOICES[movie.voiceover.voice]) errors.push(`voiceover: unknown voice "${movie.voiceover.voice}". See: node joedit.ts voice voices`);
    if (!listPacks().find((p) => p.name === "tts")?.installed) errors.push("voiceover: needs the tts pack. Run: node joedit.ts install tts");
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
  const files = [scene.video, scene.image, scene.html].filter(Boolean).map((path) => {
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
    if (scene.image) {
      picture.animate(pathFrom(ctx.base, scene.image), made, { duration, motion: scene.motion ?? "zoom-in", width, height, fps });
    } else if (scene.title !== undefined) {
      await graphics.title(made, { text: scene.title, subtitle: scene.subtitle, duration, width, height, fps, brand: ctx.brand });
    } else if (scene.html) {
      await graphics.render(pathFrom(ctx.base, scene.html), made, { duration, width, height, fps, data: scene.data });
    } else {
      ffmpeg(["-f", "lavfi", "-i", `color=c=${scene.color}:s=${width}x${height}:r=${fps}:d=${duration}`, "-pix_fmt", "yuv420p", made]);
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

  ffmpeg([...inputs, "-filter_complex", graph, "-map", "[v]", "-map", "[a]", ...encoder(ctx), "-r", String(fps), "-t", String(duration), output]);
  return { file: output, cached: false };
}

// ---------- Joining, sound and finishing ----------

// Join the scenes, with transitions where asked. Returns the movie length.
function joinScenes(movie: Movie, files: string[], lengths: number[], output: string, ctx: Context): number {
  const transitions = movie.scenes.map(transitionOf);
  if (!transitions.some(Boolean)) {
    // No transitions: join the files directly (very fast, no re-encoding).
    const list = join(ctx.temp, "scenes.txt");
    writeFileSync(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
    ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", output]);
    return lengths.reduce((sum, l) => sum + l, 0);
  }
  // Give every scene the same time base, which xfade and concat need to work together.
  let graph = files.map((_, n) => `[${n}:v]settb=AVTB[in${n}];`).join("");
  let v = "[in0]";
  let a = "[0:a]";
  let length = lengths[0];
  for (let n = 1; n < files.length; n++) {
    const t = transitions[n];
    if (t) {
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
  const inputs = files.flatMap((f) => ["-i", f]);
  ffmpeg([...inputs, "-filter_complex", graph.slice(0, -1), "-map", v, "-map", a, ...encoder(ctx), output]);
  return length;
}

// Mix the scene sound with music, voice-over and sound effects, then make it -14 LUFS.
function mixSound(movie: Movie, tracks: Track[], joined: string, length: number, output: string, ctx: Context): void {
  const inputs = ["-i", joined];
  const voices = ["[0:a]"]; // scene sound and normal tracks: these make ducked music go quiet
  const music: string[] = []; // tracks with duck: true
  const effects: string[] = [];
  let graph = "";
  let count = 1;

  for (const [n, track] of tracks.entries()) {
    const file = pathFrom(ctx.base, track.file);
    const at = track.at ?? 0;
    const from = track.from ?? 0;
    const fileLength = (track.to ?? sound.info(file).duration) - from;
    const plays = Math.max(0.1, track.loop ? length - at : Math.min(fileLength, length - at));
    if (track.loop) inputs.push("-stream_loop", "-1");
    inputs.push("-i", file);
    let chain = `[${count++}:a]atrim=start=${from}${track.to && !track.loop ? `:end=${track.to}` : ""},asetpts=PTS-STARTPTS,${AUDIO_FORMAT}`;
    chain += `,atrim=end=${round(plays, 3)},volume=${track.volume ?? 1}`;
    if (track.fadeIn) chain += `,afade=t=in:d=${track.fadeIn}`;
    if (track.fadeOut) chain += `,afade=t=out:st=${round(Math.max(0, plays - track.fadeOut), 3)}:d=${track.fadeOut}`;
    chain += `,adelay=${Math.round(at * 1000)}:all=1[t${n}];`;
    graph += chain;
    (track.duck ? music : voices).push(`[t${n}]`);
  }

  for (const [n, effect] of (movie.sfx ?? []).entries()) {
    const file = join(ctx.cache, `sfx-${effect.type}-${effect.duration ?? "default"}.wav`);
    if (!existsSync(file)) sound.sfx(file, effect.type, effect.duration);
    inputs.push("-i", file);
    graph += `[${count++}:a]${AUDIO_FORMAT},volume=${effect.volume ?? 0.8},adelay=${Math.round(effect.at * 1000)}:all=1[s${n}];`;
    effects.push(`[s${n}]`);
  }

  const mix = (labels: string[], out: string) =>
    labels.length === 1 ? `${labels[0]}anull[${out}];` : `${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0[${out}];`;
  graph += mix(voices, "voice");
  const parts = ["[voice]"];
  if (music.length) {
    graph += mix(music, "music");
    // The music gets quieter whenever the voice bus is loud (sidechain compression).
    graph += `[voice]asplit=2[vmix][vkey];[music][vkey]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[ducked];`;
    parts[0] = "[vmix]";
    parts.push("[ducked]");
  }
  parts.push(...effects);
  graph += mix(parts, "all");
  graph += `[all]apad=whole_dur=${round(length, 3)},atrim=end=${round(length, 3)}[out]`;

  const raw = join(ctx.temp, "mix.wav");
  ffmpeg([...inputs, "-filter_complex", graph, "-map", "[out]", raw]);
  // Silent movies stay silent; everything else is set to the online standard loudness.
  if (listen.loudness(raw).lufs > -60) sound.normalize(raw, output);
  else ffmpeg(["-i", raw, "-ar", "48000", output]);
}

// Make the movie's music (cached). Composed scores also give their exact beat times.
function makeMusic(spec: MusicSpec, ctx: Context): { file: string; beats?: number[] } {
  if (spec.file) return { file: pathFrom(ctx.base, spec.file) };
  if (spec.score) {
    const scoreFile = pathFrom(ctx.base, spec.score);
    const key = createHash("sha256").update(readFileSync(scoreFile)).digest("hex").slice(0, 16);
    const file = join(ctx.cache, `score-${key}.wav`);
    const score = JSON.parse(readFileSync(scoreFile, "utf8"));
    const made = existsSync(file) ? { beats: music.scoreToMidi(score).beats } : music.compose(scoreFile, file);
    const secondsPerBeat = 60 / (score.tempo ?? 120);
    return { file, beats: Array.from({ length: Math.ceil(made.beats) }, (_, k) => k * secondsPerBeat) };
  }
  const key = createHash("sha256").update(JSON.stringify(spec.song)).digest("hex").slice(0, 16);
  const file = join(ctx.cache, `song-${key}.wav`);
  if (!existsSync(file)) music.song(file, spec.song!.prompt, spec.song!);
  return { file };
}

// Speak the voice-over (cached like scenes). Returns the sound file and the time of every word.
function makeVoiceover(spec: NonNullable<Movie["voiceover"]>, ctx: Context): { file: string; words: graphics.CaptionWord[] } {
  const key = createHash("sha256").update(JSON.stringify({ text: spec.text, voice: spec.voice, speed: spec.speed })).digest("hex").slice(0, 16);
  const file = join(ctx.cache, `voice-${key}.wav`);
  const wordsFile = join(ctx.cache, `voice-${key}.json`);
  if (!existsSync(file) || !existsSync(wordsFile)) {
    voice.speak(file, spec.text, { voice: spec.voice, speed: spec.speed, words: wordsFile });
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
    const ctx: Context = { base, width, height, fps, draft, brand, cache, temp };
    // Music first, because beatSync can cut to its beats.
    const backing = movie.music ? makeMusic(movie.music, ctx) : undefined;
    let beats: number[] = [];
    if (movie.beatSync === true && backing) beats = backing.beats ?? listen.beats(backing.file).beats;
    if (typeof movie.beatSync === "string") beats = listen.beats(pathFrom(base, movie.beatSync)).beats;
    const lengths = planTimes(movie, base, fps, beats);

    // 1. Every scene (reusing cached ones).
    const segments: string[] = [];
    let cached = 0;
    for (const [n, scene] of movie.scenes.entries()) {
      const result = await renderScene(scene, n, lengths[n], ctx);
      segments.push(result.file);
      if (result.cached) cached++;
    }

    // 2. Join, 3. mix the sound.
    const joined = join(temp, "joined.mp4");
    const length = joinScenes(movie, segments, lengths, joined, ctx);
    const tracks = [...(movie.audio ?? [])];
    if (backing) {
      const m = movie.music!;
      tracks.push({ file: backing.file, volume: m.volume ?? 0.8, duck: m.duck ?? true, loop: m.loop, fadeIn: m.fadeIn, fadeOut: m.fadeOut ?? 2 });
    }
    const spoken = movie.voiceover ? makeVoiceover(movie.voiceover, ctx) : undefined;
    if (spoken) tracks.push({ file: spoken.file, at: movie.voiceover!.at ?? 0, volume: movie.voiceover!.volume ?? 1 });
    const mixed = join(temp, "mix-final.wav");
    mixSound(movie, tracks, joined, length, mixed, ctx);
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
        const transcript = join(temp, "words.json");
        listen.transcribe(mixed, transcript, options.model ?? "base");
        words = JSON.parse(readFileSync(transcript, "utf8")).words ?? [];
      }
      if (words.length) {
        captionFile = join(temp, "captions.mov");
        await graphics.captionsOverlay(words, captionFile, { width, height, fps, duration: length, style: options.style, position: options.position, brand });
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
    graph += `[${label}]format=yuv420p[v]`;
    ffmpeg([...inputs, "-filter_complex", graph, "-map", "[v]", "-map", "1:a", ...encoder(ctx), "-movflags", "+faststart", "-t", String(round(length, 3)), output]);

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
    description: "Explainer (16:9): title, an animated HTML chart, a picture, outro, voice-over with music ducked under it, subtitles",
    movie: {
      notes: "Replace chart.html (any page; it gets window.joedit.data), diagram.png, voiceover.wav and music.mp3.",
      size: "1920x1080",
      scenes: [
        { title: "How it works", subtitle: "in 30 seconds", duration: 3 },
        { html: "chart.html", duration: 6, data: { values: [3, 7, 12] }, transition: "fade" },
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

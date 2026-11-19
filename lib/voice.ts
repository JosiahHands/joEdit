// Voices: speak text, speak in a cloned voice (with consent), and split music into stems.
// Uses the optional packs tts (Kokoro), clone (Chatterbox) and stems (Demucs), or macOS `say`.
// CLI:     node joedit.ts voice <command> ...
// Library: import { speak } from "./joEdit/voice.ts"
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ffmpeg, hasProgram, optionalNumberFlag, requireFile, run, runCli, runPack, withTempDir, type Args, type Command } from "./shared.ts";

// Kokoro voices. The first letter is the language (a = American English, b = British English,
// e = Spanish, f = French, h = Hindi, i = Italian, p = Brazilian Portuguese), the second is f(emale) or m(ale).
export const VOICES: Record<string, string> = {
  af_heart: "American woman, warm (best quality)",
  af_bella: "American woman, bright and lively",
  af_nicole: "American woman, soft and close (ASMR-like)",
  af_sarah: "American woman, clear",
  af_sky: "American woman, light",
  af_nova: "American woman, calm",
  af_river: "American woman, relaxed",
  af_aoede: "American woman, smooth",
  af_kore: "American woman, steady",
  af_alloy: "American woman, neutral",
  af_jessica: "American woman, friendly",
  am_michael: "American man, warm",
  am_fenrir: "American man, deep",
  am_puck: "American man, playful",
  am_echo: "American man, clear",
  am_eric: "American man, confident",
  am_liam: "American man, young",
  am_onyx: "American man, low and serious",
  am_adam: "American man, plain",
  am_santa: "American man, jolly",
  bf_emma: "British woman, polished",
  bf_isabella: "British woman, warm",
  bf_alice: "British woman, crisp",
  bf_lily: "British woman, gentle",
  bm_george: "British man, classic narrator",
  bm_fable: "British man, storyteller",
  bm_lewis: "British man, deep",
  bm_daniel: "British man, calm",
  ef_dora: "Spanish woman",
  em_alex: "Spanish man",
  ff_siwis: "French woman",
  hf_alpha: "Hindi woman",
  hm_omega: "Hindi man",
  if_sara: "Italian woman",
  im_nicola: "Italian man",
  pf_dora: "Brazilian Portuguese woman",
  pm_alex: "Brazilian Portuguese man",
};

export type SpeakOptions = {
  voice?: string;
  speed?: number; // 1 = normal, 0.8 = slower, 1.2 = faster
  engine?: "kokoro" | "say"; // say = the macOS voice, needs no pack
  words?: string; // also save the time of every word here (kokoro), for captions
};

// Turn text into speech. Any sound format works for the output (.wav, .mp3, …).
export function speak(output: string, text: string, options: SpeakOptions = {}) {
  if (!text.trim()) throw new Error("Give the words to say with --text (or --file script.txt).");
  const engine = options.engine ?? "kokoro";
  const speed = options.speed ?? 1;
  return withTempDir((folder) => {
    const raw = join(folder, engine === "say" ? "speech.aiff" : "speech.wav");
    let result: Record<string, unknown> = {};
    if (engine === "say") {
      if (!hasProgram("say")) throw new Error("The say engine is only on macOS. Use the kokoro engine: node joedit.ts install tts");
      const voice = options.voice ? ["-v", options.voice] : [];
      run("say", [...voice, "-r", String(Math.round(180 * speed)), "-o", raw, text]);
      result = { voice: options.voice ?? "default" };
    } else {
      const voice = options.voice ?? "af_heart";
      if (!VOICES[voice]) throw new Error(`Unknown voice "${voice}". See: node joedit.ts voice voices`);
      const words = options.words ? ["--words", options.words] : [];
      result = runPack("tts", [raw, "--text", text, "--voice", voice, "--speed", String(speed), ...words]);
    }
    ffmpeg(["-i", raw, output]);
    return { engine, ...result };
  });
}

// The voices you can use: Kokoro's (tts pack) and, on macOS, the system voices for --engine say.
export function voices() {
  const kokoro = Object.entries(VOICES).map(([name, description]) => ({ name, description }));
  let say: string[] = [];
  if (hasProgram("say")) {
    // Lines look like: "Daniel              en_GB    # Hello! My name is Daniel."
    say = run("say", ["-v", "?"]).trim().split("\n").map((line) => line.split("#")[0].trim().replace(/\s{2,}/g, " "));
  }
  return { kokoro, say };
}

// Say new words in the voice of a short sample (5-20 seconds of clear speech works best).
// consent: a sentence recording that the person whose voice it is agreed to this use.
// The consent is saved next to the output and in its metadata, and Chatterbox watermarks the audio.
export function clone(output: string, sample: string, text: string, consent: string, emotion = 0.5, pace = 0.5) {
  requireFile(sample);
  if (!consent || consent.trim().length < 10) {
    throw new Error('Cloning a voice needs --consent "..." : who the voice belongs to and that they agreed, e.g. --consent "Sam Lee agreed on 2026-11-18 to use their voice for the product video".');
  }
  if (!text.trim()) throw new Error("Give the words to say with --text (or --file script.txt).");
  const result = withTempDir((folder) => {
    const prepared = join(folder, "sample.wav");
    ffmpeg(["-i", sample, "-ac", "1", "-ar", "24000", prepared]);
    const raw = join(folder, "speech.wav");
    const made = runPack("clone", [raw, "--sample", prepared, "--text", text, "--emotion", String(emotion), "--pace", String(pace)]);
    ffmpeg(["-i", raw, "-metadata", `comment=AI voice clone (Chatterbox, watermarked). Consent: ${consent}`, output]);
    return made;
  });
  const record = [
    "joEdit voice clone record",
    `date: ${new Date().toISOString()}`,
    `consent: ${consent}`,
    `voice sample: ${basename(sample)} (sha256 ${createHash("sha256").update(readFileSync(sample)).digest("hex")})`,
    `output: ${basename(output)} (watermarked by Chatterbox/Perth)`,
    `text: ${text}`,
  ].join("\n");
  const consentFile = `${output}.consent.txt`;
  writeFileSync(consentFile, record + "\n");
  return { ...result, consentFile };
}

export const STEMS = ["vocals", "drums", "bass", "other"];

// Split music into vocals, drums, bass and other. `only` keeps one stem plus everything else mixed
// together (e.g. only "vocals" gives vocals.wav and without-vocals.wav: voice isolation and karaoke).
export function stems(input: string, folder: string, only = "", model = "htdemucs") {
  requireFile(input);
  if (only && !STEMS.includes(only)) throw new Error(`--only must be one of: ${STEMS.join(", ")}`);
  const result = withTempDir((temp) => {
    const prepared = join(temp, "music.wav");
    ffmpeg(["-i", input, "-vn", "-ac", "2", "-ar", "44100", prepared]);
    return runPack("stems", [prepared, folder, "--model", model]);
  });
  if (!only) return { folder, stems: Object.keys(result.stems), device: result.device };
  // Mix the other stems into one file, then remove them.
  const others = STEMS.filter((name) => name !== only).map((name) => join(folder, `${name}.wav`));
  const rest = join(folder, `without-${only}.wav`);
  ffmpeg([...others.flatMap((f) => ["-i", f]), "-filter_complex", `amix=inputs=${others.length}:normalize=0`, rest]);
  others.forEach((f) => rmSync(f, { force: true }));
  return { folder, stems: [only, `without-${only}`], device: result.device };
}

// Text from --text, or from a file with --file (good for long scripts).
function textFlag(a: Args): string {
  if (a.flags.file) return readFileSync(requireFile(a.flags.file), "utf8");
  return a.flags.text ?? "";
}

export const commands: Record<string, Command> = {
  speak: {
    usage: 'speak <output.wav> --text "..." [--file script.txt] [--voice af_heart] [--speed 1] [--words words.json] [--engine kokoro|say]',
    run: (a) => {
      if (!a.positional[0]) throw new Error("Missing output path.");
      const engine = (a.flags.engine ?? "kokoro") as SpeakOptions["engine"];
      return speak(a.positional[0], textFlag(a), { voice: a.flags.voice, speed: optionalNumberFlag(a, "speed", 1), engine, words: a.flags.words });
    },
  },
  voices: {
    usage: "voices  → Kokoro voices (tts pack) and macOS say voices",
    run: () => voices(),
  },
  clone: {
    usage: 'clone <output.wav> --sample voice.wav --text "..." --consent "who agreed, and when" [--emotion 0.5] [--pace 0.5]',
    run: (a) => {
      if (!a.positional[0]) throw new Error("Missing output path.");
      if (!a.flags.sample) throw new Error("Give a voice sample with --sample (5-20 seconds of clear speech).");
      return clone(a.positional[0], a.flags.sample, textFlag(a), a.flags.consent ?? "", optionalNumberFlag(a, "emotion", 0.5), optionalNumberFlag(a, "pace", 0.5));
    },
  },
  stems: {
    usage: "stems <input> <output-folder> [--only vocals|drums|bass|other]  (vocals.wav, drums.wav, bass.wav, other.wav)",
    run: (a) => {
      const [input, folder] = a.positional;
      if (!input || !folder) throw new Error("Give the music file and a folder for the stems.");
      return stems(input, folder, a.flags.only ?? "", a.flags.model ?? "htdemucs");
    },
  },
};

// Only run the CLI when this file is executed directly (not when imported).
if (import.meta.main) {
  runCli("joEdit voice: node joedit.ts voice <command> ...", commands, process.argv.slice(2));
}

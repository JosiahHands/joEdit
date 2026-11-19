// Graphics: turn HTML pages into video and pictures, rendered frame by frame by Chrome.
// Write any HTML/CSS/JS animation. joEdit controls the page's clock, so every frame is exact and repeatable.
// CLI:     node joedit.ts graphics <command> ...
// Library: import { render } from "./joEdit/graphics.ts"
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ASSETS,
  FFMPEG,
  FONT_FAMILIES,
  FONTS,
  drawText,
  hasProgram,
  inOut,
  loadBrand,
  measureText,
  numberFlag,
  optionalNumberFlag,
  requireFile,
  round,
  run,
  runCli,
  saveCanvas,
  setFont,
  skia,
  stringFlag,
  videoEncoder,
  withTempDir,
  writeVideo,
  type Args,
  type Brand,
  type Command,
  type TextStyle,
} from "./shared.ts";
import * as listen from "./listen.ts";

// ---------- Chrome ----------

// Find a Chrome or Chromium to render with.
export function findChrome(): string {
  const paths = [
    process.env.JOEDIT_CHROME ?? "",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  const found = paths.find((p) => p && existsSync(p));
  if (found) return found;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    if (hasProgram(name)) return name;
  }
  // A headless Chrome downloaded with: node joedit.ts install browser
  const folder = join(ASSETS, "browser");
  if (existsSync(folder)) {
    const file = readdirSync(folder, { recursive: true }).map(String).find((p) => basename(p) === "chrome-headless-shell");
    if (file) return join(folder, file);
  }
  throw new Error("Graphics needs Chrome. Install Google Chrome, or run: node joedit.ts install browser");
}

type Connection = {
  send: (method: string, params?: object, sessionId?: string) => Promise<any>;
  close: () => Promise<void>;
};

// Start a hidden Chrome and connect to it with the DevTools protocol (a WebSocket).
async function openChrome(profile: string): Promise<Connection> {
  const chrome = spawn(
    findChrome(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--mute-audio",
      "--allow-file-access-from-files",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  // Chrome prints the address to connect to on stderr.
  const address = await new Promise<string>((resolveAddress, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${log.slice(-300)}`)), 30000);
    chrome.stderr.on("data", (chunk) => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolveAddress(match[1]);
      }
    });
    chrome.on("exit", () => reject(new Error(`Chrome stopped: ${log.slice(-300)}`)));
  });

  const socket = new WebSocket(address);
  await new Promise((ready, fail) => {
    socket.onopen = ready;
    socket.onerror = fail;
  });

  // Each request gets a number; the reply with the same number settles its promise.
  let lastId = 0;
  const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const request = waiting.get(message.id);
    if (!request) return;
    waiting.delete(message.id);
    if (message.error) request.reject(new Error(`Chrome: ${message.error.message}`));
    else request.resolve(message.result);
  };
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<any>((resolveReply, reject) => {
      const id = ++lastId;
      waiting.set(id, { resolve: resolveReply, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  // Close Chrome and wait until it has really stopped (so its temporary files can be deleted).
  const close = async () => {
    const stopped = once(chrome, "exit");
    socket.close();
    chrome.kill();
    await Promise.race([stopped, new Promise((r) => setTimeout(r, 3000))]);
  };
  return { send, close };
}

// Script added to every page before it loads. It replaces the page's clock with one joEdit controls,
// and adds the fonts that come with joEdit.
function clockScript(info: object): string {
  const fontFaces = Object.entries(FONT_FAMILIES)
    .filter(([file]) => existsSync(join(FONTS, file)))
    .map(([file, family]) => `@font-face{font-family:'${family}';src:url('${pathToFileURL(join(FONTS, file))}')}`)
    .join("");
  return `(() => {
    let now = 0, queue = [], nextId = 1;
    const start = 1700000000000;
    window.requestAnimationFrame = (cb) => { const id = nextId++; queue.push([id, cb]); return id; };
    window.cancelAnimationFrame = (id) => { queue = queue.filter((q) => q[0] !== id); };
    performance.now = () => now;
    Date.now = () => start + now;
    window.joedit = Object.assign({ time: 0 }, ${JSON.stringify(info)});
    window.__joeditSeek = async (t) => {
      now = t * 1000;
      window.joedit.time = t;
      const callbacks = queue; queue = [];
      for (const [, cb] of callbacks) cb(now);
      for (const a of document.getAnimations()) { a.pause(); a.currentTime = now; }
      if (window.gsap) window.gsap.globalTimeline.seek(t);
      for (const v of document.querySelectorAll('video')) {
        v.pause();
        if (Math.abs(v.currentTime - t) > 0.001) await new Promise((r) => { v.onseeked = r; v.currentTime = Math.min(t, v.duration || t); });
      }
      if (window.joedit.render) await window.joedit.render(t);
    };
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = ${JSON.stringify(fontFaces)};
      document.head.prepend(style);
    });
  })();`;
}

export type Page = {
  seek: (time: number) => Promise<void>;
  evaluate: (expression: string) => Promise<any>;
  screenshot: (format?: "png" | "jpeg") => Promise<Buffer>;
};

export type PageOptions = {
  width: number;
  height: number;
  fps: number;
  duration: number;
  transparent?: boolean;
  data?: unknown; // available to the page as window.joedit.data
  audio?: unknown; // available to the page as window.joedit.audio
};

// Open an HTML file in Chrome at the given size, run `work`, then close everything.
export async function withPage<T>(file: string, options: PageOptions, work: (page: Page) => Promise<T>): Promise<T> {
  requireFile(file);
  const profile = mkdtempSync(join(tmpdir(), "joedit-chrome-"));
  const chrome = await openChrome(profile);
  try {
    const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method: string, params: object = {}) => chrome.send(method, params, sessionId);

    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: options.width, height: options.height, deviceScaleFactor: 1, mobile: false });
    if (options.transparent) await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    const info = { width: options.width, height: options.height, fps: options.fps, duration: options.duration, data: options.data, audio: options.audio };
    await send("Page.addScriptToEvaluateOnNewDocument", { source: clockScript(info) });
    await send("Page.navigate", { url: pathToFileURL(resolve(file)).href });

    const evaluate = async (expression: string) => {
      const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (reply.exceptionDetails) throw new Error(`Page error: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);
      return reply.result?.value;
    };
    // Wait until the page, its pictures and its fonts have loaded.
    await evaluate(`new Promise((r) => document.readyState === 'complete' ? r() : addEventListener('load', () => r()))`);
    await evaluate(`document.fonts.ready.then(() => true)`);

    const page: Page = {
      seek: async (time) => {
        await evaluate(`window.__joeditSeek(${time})`);
      },
      evaluate,
      screenshot: async (format = "png") => {
        const shot = await send("Page.captureScreenshot", format === "png" ? { format } : { format, quality: 92 });
        return Buffer.from(shot.data, "base64");
      },
    };
    return await work(page);
  } finally {
    await chrome.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

// ---------- Rendering ----------

export type RenderOptions = {
  width?: number;
  height?: number;
  fps?: number;
  duration: number;
  transparent?: boolean;
  data?: unknown;
  audio?: string; // a sound file: the page gets its beats and loudness, and the video gets the sound
};

// Render an HTML page into a video, frame by frame.
export async function render(file: string, output: string, options: RenderOptions): Promise<{ frames: number }> {
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const fps = options.fps ?? 30;
  const transparent = options.transparent ?? false;
  const frames = Math.max(1, Math.round(options.duration * fps));

  // For audio-reactive pages: beats and a loudness value for every frame.
  let audio: unknown = undefined;
  if (options.audio) {
    const beat = listen.beats(options.audio);
    audio = { bpm: beat.bpm, beats: beat.beats, levels: listen.levels(options.audio, fps) };
  }

  const format = transparent ? "png" : "jpeg";
  const soundArgs = options.audio ? ["-i", options.audio, "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-shortest"] : [];
  const encoder = spawn(
    FFMPEG,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "image2pipe", "-framerate", String(fps), "-c:v", format === "png" ? "png" : "mjpeg", "-i", "-",
      ...soundArgs,
      // Most video formats need an even width and height.
      ...(output.endsWith(".gif") ? [] : ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"]),
      ...videoEncoder(output, { transparent }),
      output,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let errors = "";
  encoder.stderr.on("data", (chunk) => (errors += chunk));
  const finished = once(encoder, "close");

  await withPage(file, { width, height, fps, duration: options.duration, transparent, data: options.data, audio }, async (page) => {
    for (let n = 0; n < frames; n++) {
      await page.seek(n / fps);
      const image = await page.screenshot(format);
      // Wait if ffmpeg is busy, so memory does not fill up.
      if (!encoder.stdin.write(image)) await once(encoder.stdin, "drain");
    }
  });
  encoder.stdin.end();
  const [code] = await finished;
  if (code !== 0) throw new Error(`ffmpeg failed: ${errors.trim()}`);
  return { frames };
}

// Save one frame of an HTML page as a picture. Quick way to look at an animation at a moment.
export async function still(file: string, output: string, time: number, options: Omit<RenderOptions, "duration"> & { duration?: number }): Promise<void> {
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const fps = options.fps ?? 30;
  const duration = options.duration ?? Math.max(time, 1);
  await withPage(file, { width, height, fps, duration, transparent: options.transparent, data: options.data }, async (page) => {
    await page.seek(time);
    writeFileSync(output, await page.screenshot("png"));
  });
}

// ---------- Skia frames: titles, captions and the agent's own canvas code (no browser) ----------

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
// Fast start and a gentle stop (like CSS cubic-bezier(.2,.8,.2,1)).
const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 4);

type Drawing = (ctx: any, time: number) => void | Promise<void>;

// Draw every frame of a video with Skia, or one picture (at stillTime) when the output is .png/.jpg/.webp.
export async function drawFrames(
  output: string,
  o: { width: number; height: number; fps: number; duration: number; transparent?: boolean; audio?: string },
  draw: Drawing,
  stillTime = 0,
): Promise<{ frames: number }> {
  const { createCanvas } = await skia();
  const width = Math.round(o.width / 2) * 2; // video needs an even size
  const height = Math.round(o.height / 2) * 2;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const paint = async (time: number) => {
    ctx.save();
    ctx.clearRect(0, 0, width, height);
    await draw(ctx, time);
    ctx.restore();
  };
  if (/\.(png|jpe?g|webp)$/i.test(output)) {
    await paint(stillTime);
    await saveCanvas(canvas, output);
    return { frames: 1 };
  }
  const writer = writeVideo(output, { width, height, fps: o.fps, audio: o.audio, transparent: o.transparent });
  const frames = Math.max(1, Math.round(o.duration * o.fps));
  for (let n = 0; n < frames; n++) {
    await paint(n / o.fps);
    const data = ctx.getImageData(0, 0, width, height).data;
    await writer.write(Buffer.from(data.buffer, data.byteOffset, data.length));
  }
  await writer.finish();
  return { frames };
}

// ---------- Built-in templates ----------

export type TemplateOptions = {
  text: string;
  subtitle?: string;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  transparent?: boolean;
  brand?: Brand;
};

type Template = ReturnType<typeof templateDefaults>;

// 1% of the width of a 16:9 frame: sizes scale with the frame.
const unitOf = (o: Template) => Math.min(o.width, o.height * 1.78) / 100;

function background(ctx: any, o: Template): void {
  if (o.transparent) return;
  ctx.fillStyle = o.brand.colors.background;
  ctx.fillRect(0, 0, o.width, o.height);
}

// Big animated title: the words rise into place (each a little later), a colored bar grows,
// the subtitle fades in, then everything fades out.
function drawTitle(ctx: any, t: number, o: Template): void {
  const { colors, fonts } = o.brand;
  const unit = unitOf(o);
  background(ctx, o);
  const out = clamp01((t - Math.max(0, o.duration - 0.6)) / 0.6) ** 2;
  ctx.globalAlpha = 1 - out;
  ctx.translate(o.width / 2, o.height / 2);
  ctx.scale(1 + 0.03 * out, 1 + 0.03 * out);
  ctx.translate(-o.width / 2, -o.height / 2);
  // The words in centred lines.
  const heading: TextStyle = { size: unit * 7.5, font: fonts.heading, weight: 800, color: colors.text };
  setFont(ctx, heading);
  const space = ctx.measureText(" ").width;
  const lines: string[][] = [[]];
  let lineWidth = 0;
  for (const word of o.text.split(/\s+/).filter(Boolean)) {
    const width = ctx.measureText(word).width;
    if (lines.at(-1)!.length && lineWidth + space + width > o.width - unit * 12) {
      lines.push([]);
      lineWidth = 0;
    }
    lineWidth += (lines.at(-1)!.length ? space : 0) + width;
    lines.at(-1)!.push(word);
  }
  const lineHeight = heading.size! * 1.05;
  const subtitle: TextStyle = { size: unit * 2.6, font: fonts.body, weight: 400, color: colors.text, align: "center", maxWidth: o.width - unit * 12 };
  const subtitleHeight = o.subtitle ? measureText(ctx, o.subtitle, subtitle).height : 0;
  let y = (o.height - (lines.length * lineHeight + unit * 4.5 + subtitleHeight)) / 2;
  let index = 0;
  for (const line of lines) {
    setFont(ctx, heading);
    const widths = line.map((word) => ctx.measureText(word).width);
    let x = (o.width - widths.reduce((a, b) => a + b, 0) - space * (line.length - 1)) / 2;
    line.forEach((word, i) => {
      const p = easeOut((t - index++ * 0.12) / 0.9);
      ctx.save();
      ctx.globalAlpha *= p;
      if (p < 1) ctx.filter = `blur(${(unit * 0.6 * (1 - p)).toFixed(2)}px)`;
      drawText(ctx, word, x, y + unit * 3 * (1 - p), heading);
      ctx.restore();
      x += widths[i] + space;
    });
    y += lineHeight;
  }
  y += unit * 2;
  const bar = unit * 12 * easeOut((t - 0.35) / 0.7);
  if (bar > 0) {
    ctx.fillStyle = colors.primary;
    ctx.beginPath();
    ctx.roundRect((o.width - bar) / 2, y, bar, unit * 0.5, unit * 0.25);
    ctx.fill();
  }
  y += unit * 2.5;
  if (o.subtitle) {
    const p = easeOut((t - 0.6) / 0.8);
    ctx.save();
    ctx.globalAlpha *= 0.85 * p;
    drawText(ctx, o.subtitle, o.width / 2, y + unit * (1 - p), subtitle);
    ctx.restore();
  }
}

// Lower third: a name and a role at the bottom left. A colored bar grows, the box slides open, and at the end it all slides away.
function drawLowerThird(ctx: any, t: number, o: Template): void {
  const { colors, fonts } = o.brand;
  const unit = unitOf(o);
  background(ctx, o);
  const out = clamp01((t - Math.max(0, o.duration - 0.5)) / 0.5) ** 2;
  ctx.globalAlpha = 1 - out;
  ctx.translate(-unit * 2 * out, 0);
  const name: TextStyle = { size: unit * 2.6, font: fonts.heading, weight: 700, color: colors.text };
  const role: TextStyle = { size: unit * 1.6, font: fonts.body, weight: 400, color: colors.accent };
  const nameSize = measureText(ctx, o.text, name);
  const roleSize = o.subtitle ? measureText(ctx, o.subtitle, role) : { width: 0, height: 0 };
  const [padX, padY, accent] = [unit * 1.8, unit, unit * 0.6];
  const boxWidth = Math.max(nameSize.width, roleSize.width) + padX * 2;
  const boxHeight = nameSize.height + (o.subtitle ? unit * 0.3 + roleSize.height : 0) + padY * 2;
  const [x, top] = [unit * 5, o.height * 0.76 - boxHeight];
  const grow = easeOut(t / 0.4);
  ctx.fillStyle = colors.primary;
  ctx.fillRect(x, top + boxHeight * (1 - grow), accent, boxHeight * grow);
  const reveal = easeOut((t - 0.15) / 0.7);
  if (reveal <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + accent, top, boxWidth * reveal, boxHeight);
  ctx.clip();
  ctx.fillStyle = "rgba(10,10,15,0.72)";
  ctx.fillRect(x + accent, top, boxWidth, boxHeight);
  drawText(ctx, o.text, x + accent + padX, top + padY, name);
  if (o.subtitle) drawText(ctx, o.subtitle, x + accent + padX, top + padY + nameSize.height + unit * 0.3, role);
  ctx.restore();
}

// Counter: a number that counts up (great for stats), with a label underneath.
function drawCounter(ctx: any, t: number, o: Template & { from: number; to: number; prefix: string; suffix: string }): void {
  const { colors, fonts } = o.brand;
  const unit = unitOf(o);
  background(ctx, o);
  const run = Math.max(0.5, o.duration * 0.7);
  const value = o.from + (o.to - o.from) * (1 - (1 - clamp01(t / run)) ** 3);
  const decimals = Number.isInteger(o.to) && Number.isInteger(o.from) ? 0 : 1;
  const text = o.prefix + value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + o.suffix;
  const number: TextStyle = { size: unit * 11, font: fonts.heading, weight: 800, color: colors.text, align: "center" };
  const label: TextStyle = { size: unit * 2.6, font: fonts.body, weight: 400, color: colors.accent, align: "center", letterSpacing: unit * 0.52 };
  const numberHeight = measureText(ctx, text, number).height;
  const labelHeight = o.text ? measureText(ctx, o.text.toUpperCase(), label).height : 0;
  const y = (o.height - numberHeight - labelHeight) / 2;
  drawText(ctx, text, o.width / 2, y, number);
  if (o.text) drawText(ctx, o.text.toUpperCase(), o.width / 2, y + numberHeight, label);
}

// Fill in template defaults from the options and the brand kit.
function templateDefaults(o: TemplateOptions) {
  return {
    text: o.text,
    subtitle: o.subtitle,
    duration: o.duration ?? 4,
    width: o.width ?? 1920,
    height: o.height ?? 1080,
    fps: o.fps ?? 30,
    transparent: o.transparent ?? false,
    brand: o.brand ?? loadBrand(),
  };
}

// A template becomes a video, or a picture (.png/.jpg) of the moment when everything is on screen.
export async function title(output: string, options: TemplateOptions) {
  const o = templateDefaults(options);
  return drawFrames(output, o, (ctx, t) => drawTitle(ctx, t, o), Math.min(1.6, o.duration / 2));
}

export async function lowerThird(output: string, options: TemplateOptions) {
  const o = templateDefaults({ transparent: true, ...options });
  return drawFrames(output, o, (ctx, t) => drawLowerThird(ctx, t, o), Math.min(1.6, o.duration / 2));
}

export async function counter(output: string, options: TemplateOptions & { from?: number; to: number; prefix?: string; suffix?: string }) {
  const o = { ...templateDefaults(options), from: options.from ?? 0, to: options.to, prefix: options.prefix ?? "", suffix: options.suffix ?? "" };
  return drawFrames(output, o, (ctx, t) => drawCounter(ctx, t, o), o.duration * 0.8);
}

// ---------- Canvas: the agent's own drawing code ----------
// A JavaScript module (.mjs) whose default export draws one frame with the Skia canvas API:
//   export default function draw(ctx, t, info) { ctx.fillStyle = "#123"; ctx.fillRect(0, 0, info.width, info.height); ... }
// info: width, height, fps, duration, frame, data (--data), brand, audio ({ bpm, beats, levels }) and level (loudness now, 0..1),
// plus helpers: text(ctx, text, x, y, style) and measure(ctx, text, style) (style like picture text), image(path) (a picture to drawImage),
// ease(x) (0..1, gentle stop) and clamp(x). draw may be async.
export async function canvas(
  script: string,
  output: string,
  o: { width: number; height: number; fps: number; duration: number; transparent?: boolean; data?: unknown; audio?: string; time?: number; brand?: Brand },
) {
  const module = await import(pathToFileURL(resolve(requireFile(script))).href);
  const draw = module.default ?? module.draw;
  if (typeof draw !== "function") throw new Error(`${script} must export its drawing: export default function draw(ctx, t, info) { ... }`);
  let audio: { bpm: number; beats: number[]; levels: number[] } | undefined;
  if (o.audio) {
    const beat = listen.beats(o.audio);
    audio = { bpm: beat.bpm, beats: beat.beats, levels: listen.levels(o.audio, o.fps) };
  }
  const { loadImage } = await skia();
  const images = new Map<string, any>();
  const info = {
    width: o.width,
    height: o.height,
    fps: o.fps,
    duration: o.duration,
    data: o.data,
    brand: o.brand ?? loadBrand(),
    audio,
    text: drawText,
    measure: measureText,
    ease: easeOut,
    clamp: clamp01,
    image: async (path: string) => {
      const file = resolve(dirname(resolve(script)), path);
      if (!images.has(file)) images.set(file, await loadImage(readFileSync(requireFile(file))));
      return images.get(file);
    },
  };
  return drawFrames(output, o, async (ctx, t) => {
    const frame = Math.round(t * o.fps);
    await draw(ctx, t, { ...info, frame, level: audio?.levels[frame] ?? 0 });
  }, o.time ?? 0);
}

// ---------- Captions ----------

export type CaptionStyle = "karaoke" | "pop" | "bold" | "minimal";
export type CaptionWord = { word: string; start: number; end: number; speaker?: string };

// Word colors for different speakers (with speakerColors on): the first speaker stays white.
const SPEAKER_COLORS = ["#FFFFFF", "#7FDBFF", "#FFD166", "#FF8FAB", "#B5F44A", "#C9A7FF"];

// Split words into short groups that fit on screen, breaking at pauses.
function captionGroups(words: CaptionWord[], maxChars: number): CaptionWord[][] {
  const groups: CaptionWord[][] = [];
  let current: CaptionWord[] = [];
  for (const word of words) {
    const length = current.map((w) => w.word).join(" ").length + word.word.length + 1;
    const previous = current[current.length - 1];
    const pause = previous ? word.start - previous.end : 0;
    const sentenceEnded = previous ? /[.!?]$/.test(previous.word) : false;
    if (current.length && (length > maxChars || pause > 0.7 || sentenceEnded)) {
      groups.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length) groups.push(current);
  return groups;
}

type CaptionLook = { width: number; height: number; style: CaptionStyle; position: string; brand: Brand; speakers: string[] };

// Draw one caption: the words of a group, with word `active` highlighted (-1: none).
// Styles: karaoke (words light up as they are said), pop (the word being said jumps out on a colored tag),
// bold (big outlined capitals), minimal (plain words on a dark box).
function drawCaption(ctx: any, group: CaptionWord[], active: number, o: CaptionLook): void {
  const base = Math.round(Math.min(o.height * 0.07, o.width * 0.085));
  const size = o.style === "bold" ? base * 1.25 : base;
  const capitals = o.style === "pop" || o.style === "bold";
  const font: TextStyle = { size, font: o.brand.fonts.heading, weight: capitals ? 900 : o.style === "minimal" ? 500 : 800 };
  setFont(ctx, font);
  const words = group.map((w) => (capitals ? w.word.toUpperCase() : w.word));
  const space = ctx.measureText(" ").width;
  const extra = (i: number) => (o.style === "pop" && i === active ? size * 0.3 : 0); // the tagged word gets room around it
  const widths = words.map((w, i) => ctx.measureText(w).width + 2 * extra(i));
  // Lines that fit in the middle 88% of the frame.
  const lines: number[][] = [[]];
  let lineWidth = 0;
  words.forEach((_, i) => {
    if (lines.at(-1)!.length && lineWidth + space + widths[i] > o.width * 0.88) {
      lines.push([]);
      lineWidth = 0;
    }
    lineWidth += (lines.at(-1)!.length ? space : 0) + widths[i];
    lines.at(-1)!.push(i);
  });
  const lineHeight = size * 1.25;
  const blockHeight = lines.length * lineHeight;
  const top = o.position === "top" ? o.height * 0.1 : o.position === "center" ? (o.height - blockHeight) / 2 : o.height * 0.88 - blockHeight;
  const widthOf = (line: number[]) => line.reduce((sum, i) => sum + widths[i], 0) + space * (line.length - 1);
  if (o.style === "minimal") {
    const boxWidth = Math.max(...lines.map(widthOf)) + base * 0.9;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.beginPath();
    ctx.roundRect((o.width - boxWidth) / 2, top - base * 0.2, boxWidth, blockHeight + base * 0.4, base * 0.15);
    ctx.fill();
  }
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.lineJoin = "round";
  lines.forEach((line, row) => {
    let x = (o.width - widthOf(line)) / 2;
    const y = top + row * lineHeight + lineHeight / 2;
    for (const i of line) {
      const on = i === active;
      const said = active >= 0 && i < active;
      const speaker = group[i].speaker;
      let color = o.speakers.length > 1 && speaker ? SPEAKER_COLORS[o.speakers.indexOf(speaker) % SPEAKER_COLORS.length] : "#FFFFFF";
      if ((o.style === "karaoke" && (on || said)) || (o.style === "bold" && on)) color = o.brand.colors.accent;
      const centre = x + widths[i] / 2;
      ctx.save();
      setFont(ctx, font);
      if (o.style === "pop" && on) {
        ctx.translate(centre, y);
        ctx.scale(1.12, 1.12);
        ctx.translate(-centre, -y);
        const tag = widths[i] - 2 * extra(i) + size * 0.3;
        ctx.fillStyle = o.brand.colors.accent;
        ctx.beginPath();
        ctx.roundRect(centre - tag / 2, y - lineHeight * 0.42, tag, lineHeight * 0.84, base * 0.18);
        ctx.fill();
        color = "#111111";
      } else {
        ctx.shadowColor = "rgba(0,0,0,0.75)";
        ctx.shadowBlur = size * 0.25;
        ctx.shadowOffsetY = size * 0.05;
      }
      if (o.style === "bold") {
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = size * 0.12;
        ctx.strokeText(words[i], centre, y);
        ctx.shadowColor = "transparent";
      }
      ctx.fillStyle = color;
      ctx.fillText(words[i], centre, y);
      ctx.restore();
      x += widths[i] + space;
    }
  });
}

// Render a see-through caption video (.mov) from word timings, drawn by Skia.
// Only one picture per caption state is drawn (not one per frame), so long videos are quick.
// speakerColors: words that carry a "speaker" (from listen speakers) get a color per speaker.
export async function captionsOverlay(
  words: CaptionWord[],
  output: string,
  options: { width: number; height: number; fps: number; duration: number; style?: CaptionStyle; position?: string; brand?: Brand; speakerColors?: boolean },
): Promise<{ groups: number }> {
  const style = options.style ?? "karaoke";
  if (!["karaoke", "pop", "bold", "minimal"].includes(style)) throw new Error("--style must be karaoke, pop, bold or minimal.");
  const brand = options.brand ?? loadBrand();
  const maxChars = Math.round(Math.min(32, (options.width / options.height) * 18));
  const groups = captionGroups(words, maxChars);

  // A list of (start, end, group, active word). Group -1 means no caption on screen.
  type State = { start: number; end: number; group: number; active: number };
  const states: State[] = [];
  let time = 0;
  groups.forEach((group, g) => {
    const nextStart = groups[g + 1]?.[0].start ?? options.duration;
    const groupEnd = Math.min(group[group.length - 1].end + 0.4, nextStart);
    if (group[0].start > time) states.push({ start: time, end: group[0].start, group: -1, active: -1 });
    group.forEach((word, i) => {
      const start = Math.max(word.start, time);
      const end = i + 1 < group.length ? group[i + 1].start : groupEnd;
      if (end > start) states.push({ start, end, group: g, active: style === "minimal" ? -1 : i });
      time = Math.max(time, end);
    });
  });
  if (time < options.duration) states.push({ start: time, end: options.duration, group: -1, active: -1 });

  const speakers = options.speakerColors ? [...new Set(words.map((w) => w.speaker).filter((s): s is string => Boolean(s)))] : [];
  const look: CaptionLook = { width: options.width, height: options.height, style, position: options.position ?? "bottom", brand, speakers };
  const { createCanvas } = await skia();
  const canvas = createCanvas(options.width, options.height);
  const ctx = canvas.getContext("2d");
  return withTempDir(async (folder) => {
    // One picture per distinct caption state.
    const pictures = new Map<string, string>();
    for (const state of states) {
      const key = `${state.group}_${state.active}`;
      if (pictures.has(key)) continue;
      ctx.clearRect(0, 0, options.width, options.height);
      if (state.group >= 0) drawCaption(ctx, groups[state.group], state.active, look);
      const file = join(folder, `${key}.png`);
      writeFileSync(file, await canvas.encode("png"));
      pictures.set(key, file);
    }
    // An ffmpeg "concat" list: each picture with how long it stays on screen.
    const pictureOf = (s: State) => pictures.get(`${s.group}_${s.active}`);
    const list = states.map((s) => `file '${pictureOf(s)}'\nduration ${round(s.end - s.start, 3)}`);
    list.push(`file '${pictureOf(states[states.length - 1])}'`);
    writeFileSync(join(folder, "list.txt"), list.join("\n"));
    run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", join(folder, "list.txt"),
      "-r", String(options.fps), "-t", String(options.duration),
      "-c:v", "png", "-pix_fmt", "rgba", output,
    ]);
    return { groups: groups.length };
  });
}

// ---------- CLI ----------

// Size, fps and brand flags shared by the commands.
function sizeFlags(a: Args) {
  return {
    width: optionalNumberFlag(a, "width", 1920),
    height: optionalNumberFlag(a, "height", 1080),
    fps: optionalNumberFlag(a, "fps", 30),
    transparent: a.flags.transparent === "true",
    brand: loadBrand(a.flags.brand),
  };
}

// --data file.json is read and given to the page as window.joedit.data.
function dataFlag(a: Args): unknown {
  return a.flags.data ? JSON.parse(readFileSync(requireFile(a.flags.data), "utf8")) : undefined;
}

// The output path for commands that only make something (no input file).
function outputArg(a: Args): string {
  if (!a.positional[0]) throw new Error("Missing output path.");
  return a.positional[0];
}

const SIZE = "[--width 1920] [--height 1080] [--fps 30]";

export const commands: Record<string, Command> = {
  render: {
    usage: `render <page.html> <output.mp4|.mov|.webm|.gif> --duration S ${SIZE} [--transparent] [--data file.json] [--audio sound]`,
    run: async (a) => {
      const { input, output } = inOut(a);
      return render(input, output, { ...sizeFlags(a), duration: numberFlag(a, "duration"), data: dataFlag(a), audio: a.flags.audio });
    },
  },
  still: {
    usage: "still <page.html> <output.png> --time S [--width 1920] [--height 1080] [--transparent] [--data file.json]",    run: async (a) => {
      const { input, output } = inOut(a);
      await still(input, output, numberFlag(a, "time"), { ...sizeFlags(a), data: dataFlag(a) });
    },
  },
  canvas: {
    usage: `canvas <draw.mjs> <output.mp4|.mov|.png> --duration S ${SIZE} [--transparent] [--data file.json] [--audio sound] [--time S] [--brand brand.json]  (your own Skia drawing code, no browser; --time: the moment for a .png)`,
    run: async (a) => {
      const { input, output } = inOut(a);
      return canvas(input, output, { ...sizeFlags(a), duration: optionalNumberFlag(a, "duration", 1), data: dataFlag(a), audio: a.flags.audio, time: optionalNumberFlag(a, "time", 0) });
    },
  },
  title: {
    usage: `title <output.mp4|.png> --text "Big title" [--subtitle "..."] [--duration 4] [--brand brand.json] [--transparent] ${SIZE}`,
    run: (a) => title(outputArg(a), { ...sizeFlags(a), text: stringFlag(a, "text"), subtitle: a.flags.subtitle, duration: optionalNumberFlag(a, "duration", 4) }),
  },
  "lower-third": {
    usage: `lower-third <output.mov|.png> --text "Name" [--subtitle "Role"] [--duration 5] [--brand brand.json] ${SIZE}  (see-through)`,
    run: (a) => lowerThird(outputArg(a), { ...sizeFlags(a), transparent: true, text: stringFlag(a, "text"), subtitle: a.flags.subtitle, duration: optionalNumberFlag(a, "duration", 5) }),
  },
  counter: {
    usage: `counter <output.mp4|.png> --to N [--from 0] [--text "label"] [--prefix "$"] [--suffix "%"] [--duration 3] [--brand brand.json] [--transparent] ${SIZE}`,
    run: (a) =>
      counter(outputArg(a), {
        ...sizeFlags(a),
        text: a.flags.text ?? "",
        to: numberFlag(a, "to"),
        from: optionalNumberFlag(a, "from", 0),
        prefix: a.flags.prefix,
        suffix: a.flags.suffix,
        duration: optionalNumberFlag(a, "duration", 3),
      }),
  },
};

// Only run the CLI when this file is executed directly (not when imported).
if (import.meta.main) {
  runCli("joEdit graphics: node graphics.ts <command> ...", commands, process.argv.slice(2));
}

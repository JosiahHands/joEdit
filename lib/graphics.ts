// Graphics: turn HTML pages into video and pictures, rendered frame by frame by Chrome.
// Write any HTML/CSS/JS animation. joEdit controls the page's clock, so every frame is exact and repeatable.
// CLI:     node joedit.ts graphics <command> ...
// Library: import { render } from "./joEdit/graphics.ts"
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ASSETS,
  FONT_FAMILIES,
  hasProgram,
  inOut,
  loadBrand,
  numberFlag,
  optionalNumberFlag,
  requireFile,
  round,
  run,
  runCli,
  stringFlag,
  type Args,
  type Brand,
  type Command,
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
// and adds the fonts from `install fonts`.
function clockScript(info: object): string {
  const fontsFolder = join(ASSETS, "fonts");
  const fontFaces = existsSync(fontsFolder)
    ? Object.entries(FONT_FAMILIES)
        .filter(([file]) => existsSync(join(fontsFolder, file)))
        .map(([file, family]) => `@font-face{font-family:'${family}';src:url('${pathToFileURL(join(fontsFolder, file))}')}`)
        .join("")
    : "";
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

// ffmpeg settings for the output type. Transparent video needs .mov or .webm.
function encoderArgs(output: string, transparent: boolean): string[] {
  const type = output.toLowerCase().split(".").pop();
  if (type === "mov") return transparent ? ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"] : ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18"];
  if (type === "webm") return ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30", "-pix_fmt", transparent ? "yuva420p" : "yuv420p"];
  if (type === "gif") return ["-filter_complex", "split[a][b];[a]palettegen[p];[b][p]paletteuse"];
  return ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium"];
}

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
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "image2pipe", "-framerate", String(fps), "-c:v", format === "png" ? "png" : "mjpeg", "-i", "-",
      ...soundArgs,
      // Most video formats need an even width and height.
      ...(output.endsWith(".gif") ? [] : ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"]),
      ...encoderArgs(output, transparent),
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

// Write HTML to a temporary file, use it, then delete it.
async function withHtmlFile<T>(html: string, work: (file: string) => Promise<T>): Promise<T> {
  const folder = mkdtempSync(join(tmpdir(), "joedit-page-"));
  try {
    const file = join(folder, "page.html");
    writeFileSync(file, html);
    return await work(file);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// ---------- Built-in templates ----------

// Make text safe to put inside HTML.
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

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

// Big animated title: the words rise into place, a colored bar grows, the subtitle fades in, then all fade out.
export function titleHtml(o: Required<Omit<TemplateOptions, "subtitle">> & { subtitle?: string }): string {
  const { colors, fonts } = o.brand;
  const unit = Math.min(o.width, o.height * 1.78) / 100; // 1% of the width of a 16:9 frame
  const words = escapeHtml(o.text)
    .split(" ")
    .map((word, n) => `<span style="animation-delay:${round(n * 0.12)}s">${word}</span>`)
    .join(" ");
  return `<!doctype html><html><head><style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${o.transparent ? "transparent" : colors.background}}
  .wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;
    animation:out .6s ease-in ${Math.max(0, o.duration - 0.6)}s forwards}
  h1{font-family:'${fonts.heading}',Helvetica,Arial,sans-serif;font-weight:800;font-size:${unit * 7.5}px;line-height:1.05;color:${colors.text};margin:0 ${unit * 6}px;letter-spacing:.01em}
  h1 span{display:inline-block;animation:rise .9s cubic-bezier(.2,.8,.2,1) both}
  .bar{height:${unit * 0.5}px;width:0;background:${colors.primary};margin:${unit * 2}px 0;border-radius:${unit}px;animation:grow .7s .35s cubic-bezier(.2,.8,.2,1) forwards}
  p{font-family:'${fonts.body}',Helvetica,Arial,sans-serif;font-size:${unit * 2.6}px;color:${colors.text};opacity:0;margin:0;animation:fade .8s .6s forwards}
  @keyframes rise{from{opacity:0;transform:translateY(${unit * 3}px);filter:blur(${unit * 0.6}px)}to{opacity:1;transform:none;filter:none}}
  @keyframes grow{to{width:${unit * 12}px}}
  @keyframes fade{from{opacity:0;transform:translateY(${unit}px)}to{opacity:.85;transform:none}}
  @keyframes out{to{opacity:0;transform:scale(1.03)}}
  </style></head><body><div class="wrap"><h1>${words}</h1><div class="bar"></div>${o.subtitle ? `<p>${escapeHtml(o.subtitle)}</p>` : ""}</div></body></html>`;
}

// Lower third: a name and a role that slide in at the bottom left (transparent, for putting over video).
export function lowerThirdHtml(o: Required<Omit<TemplateOptions, "subtitle">> & { subtitle?: string }): string {
  const { colors, fonts } = o.brand;
  const unit = Math.min(o.width, o.height * 1.78) / 100;
  return `<!doctype html><html><head><style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${o.transparent ? "transparent" : colors.background}}
  .box{position:absolute;left:${unit * 5}px;bottom:${o.height * 0.12}px;display:flex;align-items:stretch;
    animation:out .5s ease-in ${Math.max(0, o.duration - 0.5)}s forwards}
  .accent{width:${unit * 0.6}px;background:${colors.primary};transform-origin:bottom;animation:grow .4s cubic-bezier(.2,.8,.2,1) both}
  .text{background:rgba(10,10,15,.72);padding:${unit * 1}px ${unit * 1.8}px;clip-path:inset(0 100% 0 0);animation:reveal .7s .15s cubic-bezier(.2,.8,.2,1) forwards}
  .name{font-family:'${fonts.heading}',Helvetica,Arial,sans-serif;font-weight:700;font-size:${unit * 2.6}px;color:${colors.text}}
  .role{font-family:'${fonts.body}',Helvetica,Arial,sans-serif;font-size:${unit * 1.6}px;color:${colors.accent};margin-top:${unit * 0.3}px}
  @keyframes grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
  @keyframes reveal{to{clip-path:inset(0 0 0 0)}}
  @keyframes out{to{opacity:0;transform:translateX(-${unit * 2}px)}}
  </style></head><body><div class="box"><div class="accent"></div><div class="text">
  <div class="name">${escapeHtml(o.text)}</div>${o.subtitle ? `<div class="role">${escapeHtml(o.subtitle)}</div>` : ""}</div></div></body></html>`;
}

// Counter: a number that counts up (great for stats), with a label underneath.
export function counterHtml(o: Required<Omit<TemplateOptions, "subtitle">> & { subtitle?: string; from: number; to: number; prefix: string; suffix: string }): string {
  const { colors, fonts } = o.brand;
  const unit = Math.min(o.width, o.height * 1.78) / 100;
  const decimals = Number.isInteger(o.to) && Number.isInteger(o.from) ? 0 : 1;
  return `<!doctype html><html><head><style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${o.transparent ? "transparent" : colors.background}}
  .wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
  .n{font-family:'${fonts.heading}',Helvetica,Arial,sans-serif;font-weight:800;font-size:${unit * 11}px;color:${colors.text};font-variant-numeric:tabular-nums}
  .label{font-family:'${fonts.body}',Helvetica,Arial,sans-serif;font-size:${unit * 2.6}px;color:${colors.accent};text-transform:uppercase;letter-spacing:.2em}
  </style></head><body><div class="wrap"><div class="n" id="n"></div><div class="label">${escapeHtml(o.text)}</div></div>
  <script>
    const from = ${o.from}, to = ${o.to}, run = Math.max(0.5, ${o.duration} * 0.7);
    const ease = (x) => 1 - Math.pow(1 - x, 3);
    window.joedit.render = (t) => {
      const value = from + (to - from) * ease(Math.min(1, t / run));
      document.getElementById('n').textContent = ${JSON.stringify(o.prefix)} + value.toLocaleString('en-US', { minimumFractionDigits: ${decimals}, maximumFractionDigits: ${decimals} }) + ${JSON.stringify(o.suffix)};
    };
  </script></body></html>`;
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

// Render a template's HTML to a video (or a still picture if the output is .png/.jpg).
// stillTime: the moment shown when the output is a picture (when everything is fully on screen).
async function renderTemplate(html: string, output: string, o: ReturnType<typeof templateDefaults>, stillTime?: number): Promise<{ frames: number }> {
  return withHtmlFile(html, async (file) => {
    if (/\.(png|jpe?g)$/i.test(output)) {
      await still(file, output, stillTime ?? Math.min(1.6, o.duration / 2), { ...o, duration: o.duration });
      return { frames: 1 };
    }
    return render(file, output, o);
  });
}

export async function title(output: string, options: TemplateOptions) {
  const o = templateDefaults(options);
  return renderTemplate(titleHtml(o), output, o);
}

export async function lowerThird(output: string, options: TemplateOptions) {
  const o = templateDefaults({ transparent: true, ...options });
  return renderTemplate(lowerThirdHtml(o), output, o);
}

export async function counter(output: string, options: TemplateOptions & { from?: number; to: number; prefix?: string; suffix?: string }) {
  const o = templateDefaults(options);
  return renderTemplate(counterHtml({ ...o, from: options.from ?? 0, to: options.to, prefix: options.prefix ?? "", suffix: options.suffix ?? "" }), output, o, o.duration * 0.8);
}

// ---------- Captions ----------

export type CaptionStyle = "karaoke" | "pop" | "bold" | "minimal";
export type CaptionWord = { word: string; start: number; end: number };

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

// The page that draws one caption state: show(group, activeWord).
function captionHtml(groups: CaptionWord[][], width: number, height: number, style: CaptionStyle, position: string, brand: Brand): string {
  const size = Math.round(Math.min(height * 0.07, width * 0.085));
  const place = position === "top" ? `top:${height * 0.1}px` : position === "center" ? "top:50%;transform:translateY(-50%)" : `bottom:${height * 0.12}px`;
  const styles: Record<CaptionStyle, string> = {
    karaoke: `.w{color:#fff}.w.past,.w.on{color:${brand.colors.accent}}`,
    pop: `.line{text-transform:uppercase;font-weight:900}.w{color:#fff;display:inline-block}.w.on{color:#111;background:${brand.colors.accent};border-radius:${size * 0.18}px;padding:0 ${size * 0.15}px;transform:scale(1.12);margin:0 .3em}`,
    bold: `.line{text-transform:uppercase;font-weight:900;font-size:${size * 1.25}px;-webkit-text-stroke:${size * 0.08}px #000;paint-order:stroke fill}.w{color:#fff}.w.on{color:${brand.colors.accent}}`,
    minimal: `.line{background:rgba(0,0,0,.6);padding:${size * 0.2}px ${size * 0.45}px;border-radius:${size * 0.15}px;font-weight:500}.w{color:#fff}`,
  };
  return `<!doctype html><html><head><style>
  html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
  .holder{position:absolute;left:0;right:0;${place};display:flex;justify-content:center;padding:0 ${width * 0.06}px}
  .line{font-family:'${brand.fonts.heading}',Helvetica,Arial,sans-serif;font-weight:800;font-size:${size}px;line-height:1.25;text-align:center;
    text-shadow:0 ${size * 0.05}px ${size * 0.25}px rgba(0,0,0,.75)}
  ${styles[style]}
  </style></head><body><div class="holder"><div class="line" id="line"></div></div><script>
    const groups = ${JSON.stringify(groups.map((g) => g.map((w) => w.word)))};
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    window.show = (g, a) => {
      const line = document.getElementById('line');
      line.style.visibility = g < 0 ? 'hidden' : 'visible';
      if (g < 0) return;
      line.innerHTML = groups[g].map((w, i) => '<span class="w ' + (i < a ? 'past' : i === a ? 'on' : '') + '">' + esc(w) + '</span>').join(' ');
    };
  </script></body></html>`;
}

// Render a see-through caption video (.mov) from word timings.
// Only one picture per caption state is drawn (not one per frame), so long videos are quick.
export async function captionsOverlay(
  words: CaptionWord[],
  output: string,
  options: { width: number; height: number; fps: number; duration: number; style?: CaptionStyle; position?: string; brand?: Brand },
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

  return withHtmlFile(captionHtml(groups, options.width, options.height, style, options.position ?? "bottom", brand), async (page) => {
    const folder = mkdtempSync(join(tmpdir(), "joedit-captions-"));
    try {
      const pictures = new Map<string, string>();
      await withPage(page, { ...options, transparent: true }, async (p) => {
        for (const state of states) {
          const key = `${state.group}_${state.active}`;
          if (pictures.has(key)) continue;
          await p.evaluate(`window.show(${state.group}, ${state.active})`);
          const file = join(folder, `${key}.png`);
          writeFileSync(file, await p.screenshot("png"));
          pictures.set(key, file);
        }
      });
      // An ffmpeg "concat" list: each picture with how long it stays on screen.
      const list = states.map((s) => `file '${pictures.get(`${s.group}_${s.active}`)}'\nduration ${round(s.end - s.start, 3)}`);
      list.push(`file '${pictures.get(`${states[states.length - 1].group}_${states[states.length - 1].active}`)}'`);
      writeFileSync(join(folder, "list.txt"), list.join("\n"));
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", join(folder, "list.txt"),
        "-r", String(options.fps), "-t", String(options.duration),
        "-c:v", "png", "-pix_fmt", "rgba", output,
      ]);
      return { groups: groups.length };
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
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

export const commands: Record<string, Command> = {
  render: {
    usage: "render <page.html> <output.mp4|.mov|.webm|.gif> --duration S [--width 1920] [--height 1080] [--fps 30] [--transparent] [--data file.json] [--audio sound]",
    run: async (a) => {
      const { input, output } = inOut(a);
      return render(input, output, { ...sizeFlags(a), duration: numberFlag(a, "duration"), data: dataFlag(a), audio: a.flags.audio });
    },
  },
  still: {
    usage: "still <page.html> <output.png> --time S [--width 1920] [--height 1080] [--transparent] [--data file.json]",
    run: async (a) => {
      const { input, output } = inOut(a);
      await still(input, output, numberFlag(a, "time"), { ...sizeFlags(a), data: dataFlag(a) });
    },
  },
  title: {
    usage: 'title <output.mp4|.png> --text "Big title" [--subtitle "..."] [--duration 4] [--brand brand.json] [--transparent] [--width --height]',
    run: (a) => title(outputArg(a), { ...sizeFlags(a), text: stringFlag(a, "text"), subtitle: a.flags.subtitle, duration: optionalNumberFlag(a, "duration", 4) }),
  },
  "lower-third": {
    usage: 'lower-third <output.mov|.png> --text "Name" [--subtitle "Role"] [--duration 5] [--brand brand.json]  (see-through)',
    run: (a) => lowerThird(outputArg(a), { ...sizeFlags(a), transparent: true, text: stringFlag(a, "text"), subtitle: a.flags.subtitle, duration: optionalNumberFlag(a, "duration", 5) }),
  },
  counter: {
    usage: 'counter <output.mp4|.png> --to N [--from 0] [--text "label"] [--prefix "$"] [--suffix "%"] [--duration 3]',
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

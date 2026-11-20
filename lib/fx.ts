// GPU effects for AI agents: looks, particles, transitions and LUTs, drawn by the graphics chip.
// raylib (kept in libs/raylib) runs GLSL shaders off-screen; frames go in and out as RGBA pixels.
// The agent can also write its own effect: a .glsl file with `vec4 effect(vec2 uv)`.
// CLI:     node joedit.ts fx <command> ...
// Library: import { effectFrame, transitionFrame } from "./fx.ts"
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  LIBS,
  even,
  ffmpeg,
  need,
  openPicture,
  optionalNumberFlag,
  readFrames,
  requireFile,
  round,
  runCli,
  savePicture,
  stringFlag,
  withTempDir,
  writeVideo,
  type Command,
  type Frame,
} from "./shared.ts";
import { board, type Tile } from "./look.ts";
import * as video from "./video.ts";

const PICTURE_FILE = /\.(png|jpe?g|webp|bmp|tiff?|heic|avif)$/i;

// ---------- The GPU engine (raylib) ----------
// One hidden window gives an OpenGL context. Each effect is a shader drawn over a full-size rectangle
// into an off-screen picture (a render texture), which is then read back as RGBA pixels.
// Texture coordinates: uv (0, 0) is the top-left corner, (1, 1) the bottom-right.

type Texture = { id: number; width: number; height: number; mipmaps: number; format: number };
type Target = { id: number; texture: Texture; depth: Texture };

let g: any; // raylib and OpenGL functions, loaded on first use

// The raylib 6.2 library file for this system. libs/raylib has macOS (Intel and Apple), Windows x64 and Linux x64/arm64.
export function raylibFile(platform = process.platform, arch = process.arch): string {
  const name = platform === "darwin" ? "libraylib.dylib" : platform === "win32" ? "raylib.dll" : arch === "arm64" ? "libraylib-arm64.so" : "libraylib.so";
  return join(LIBS, "raylib", name);
}

function engine(): any {
  if (g) return g;
  const file = raylibFile();
  if (!existsSync(file)) throw new Error(`GPU effects need raylib 6.2 at ${file}. joEdit includes macOS, Windows x64 and Linux builds; for this system place ${basename(file)} there.`);
  const koffi = need("koffi");
  const ray = koffi.load(file);
  const glFile = process.platform === "darwin" ? "/System/Library/Frameworks/OpenGL.framework/OpenGL" : process.platform === "win32" ? "opengl32.dll" : "libGL.so.1";
  const gl = koffi.load(glFile);
  koffi.struct("Texture", { id: "uint", width: "int", height: "int", mipmaps: "int", format: "int" });
  koffi.struct("RenderTexture", { id: "uint", texture: "Texture", depth: "Texture" });
  koffi.struct("Shader", { id: "uint", locs: "int *" });
  koffi.struct("Image", { data: "void *", width: "int", height: "int", mipmaps: "int", format: "int" });
  koffi.struct("Color", { r: "uint8", g: "uint8", b: "uint8", a: "uint8" });
  const functions = [
    "void SetTraceLogLevel(int)", "void SetConfigFlags(uint)", "void InitWindow(int, int, str)", "bool IsWindowReady()",
    "RenderTexture LoadRenderTexture(int, int)", "Shader LoadShaderFromMemory(str, str)", "int GetShaderLocation(Shader, str)",
    "void SetShaderValue(Shader, int, void *, int)", "void SetShaderValueTexture(Shader, int, Texture)",
    "Texture LoadTextureFromImage(Image)", "void UpdateTexture(Texture, void *)", "void SetTextureFilter(Texture, int)", "void SetTextureWrap(Texture, int)",
    "void BeginTextureMode(RenderTexture)", "void EndTextureMode()", "void BeginShaderMode(Shader)", "void EndShaderMode()",
    "void ClearBackground(Color)", "void DrawRectangle(int, int, int, int, Color)", "void rlDisableColorBlend()",
    "void rlEnableFramebuffer(uint)", "void rlDisableFramebuffer()",
    // the live preview window
    "bool WindowShouldClose()", "void BeginDrawing()", "void EndDrawing()", "void SetTargetFPS(int)", "void SetWindowSize(int, int)",
    "void SetWindowState(uint)", "void ClearWindowState(uint)", "void SetWindowTitle(str)", "int GetScreenWidth()", "int GetScreenHeight()",
    "int GetRenderWidth()", "int GetRenderHeight()",
  ];
  const api: any = {};
  for (const signature of functions) api[signature.match(/(\w+)\(/)![1]] = ray.func(signature);
  // OpenGL: read pixels back, and compile shaders to get readable error messages.
  api.glReadPixels = gl.func("void glReadPixels(int, int, int, int, uint, uint, _Out_ uint8 *)");
  const shaderFunctions = [
    "uint glCreateShader(uint)", "void glShaderSource(uint, int, const char **, const int *)", "void glCompileShader(uint)",
    "void glGetShaderiv(uint, uint, _Out_ int *)", "void glGetShaderInfoLog(uint, int, _Out_ int *, _Out_ uint8 *)", "void glDeleteShader(uint)",
  ];
  if (process.platform !== "win32") for (const signature of shaderFunctions) api[signature.match(/(\w+)\(/)![1]] = gl.func(signature);
  api.SetTraceLogLevel(5); // only errors
  api.SetConfigFlags(0x80); // hidden window
  api.InitWindow(320, 180, "joEdit fx");
  if (!api.IsWindowReady()) {
    const linux = process.platform === "linux" ? " On Linux it needs a display (X11 or Wayland with Xwayland; on a server run under xvfb-run)." : "";
    throw new Error(`Could not start the GPU: raylib found no OpenGL 3.3 graphics.${linux}`);
  }
  if (process.platform === "win32") {
    // opengl32.dll only has OpenGL 1.1. The newer functions come from the graphics driver, once the window exists.
    const lookup = gl.func("void *wglGetProcAddress(str)");
    for (const signature of shaderFunctions) Object.assign(api, driverFunction(koffi, signature, lookup));
  }
  api.rlDisableColorBlend(); // shaders write their colors as they are (keeps transparency)
  g = api;
  return g;
}

// A function the graphics driver gives as an address (Windows OpenGL): `lookup(name)` returns the address,
// and koffi turns it into a function with the signature. Returns { name: function }.
export function driverFunction(koffi: any, signature: string, lookup: (name: string) => any): Record<string, any> {
  const name = signature.match(/(\w+)\(/)![1];
  const address = lookup(name);
  // wglGetProcAddress can answer 0, 1, 2, 3 or -1 for "not found".
  const value = address ? BigInt.asIntN(64, koffi.address(address)) : 0n;
  if (value >= -1n && value <= 3n) throw new Error(`The graphics driver has no ${name}. Update the graphics driver (OpenGL 3.3 is needed).`);
  return { [name]: koffi.decode(address, koffi.proto(signature.replace(name, `${name}_driver`))) };
}

const shaders = new Map<string, any>(); // compiled shaders by source
const locations = new Map<string, number>(); // uniform locations by "shader id:name"

// Compile a fragment shader (once). headerLines: lines added before the agent's code, so errors point at its lines.
function compile(source: string, headerLines = 0): any {
  const known = shaders.get(source);
  if (known) return known;
  const gpu = engine();
  const id = gpu.glCreateShader(0x8b30); // GL_FRAGMENT_SHADER
  gpu.glShaderSource(id, 1, [source], null);
  gpu.glCompileShader(id);
  const status = [0];
  gpu.glGetShaderiv(id, 0x8b81, status); // GL_COMPILE_STATUS
  if (!status[0]) {
    const size = [0];
    gpu.glGetShaderiv(id, 0x8b84, size); // GL_INFO_LOG_LENGTH
    const log = Buffer.alloc(Math.max(1, size[0]));
    gpu.glGetShaderInfoLog(id, log.length, [0], log);
    gpu.glDeleteShader(id);
    const text = log.toString("utf8").replace(/\0[\s\S]*$/, "").replace(/0:(\d+)/g, (_, n) => `line ${Number(n) - headerLines}`).trim();
    throw new Error(`The shader did not compile:\n${text}`);
  }
  gpu.glDeleteShader(id);
  const shader = gpu.LoadShaderFromMemory(null, source);
  shaders.set(source, shader);
  return shader;
}

function location(shader: any, name: string): number {
  const key = `${shader.id}:${name}`;
  if (!locations.has(key)) locations.set(key, engine().GetShaderLocation(shader, name));
  return locations.get(key)!;
}

// Smooth sampling, and edges that repeat the last pixel instead of wrapping around.
function smooth(texture: Texture): void {
  engine().SetTextureFilter(texture, 1); // bilinear
  engine().SetTextureWrap(texture, 1); // clamp
}

const textures = new Map<string, Texture>();
const targets = new Map<string, Target>();
const uploaded = new Map<string, Buffer>(); // the pixels each texture holds now

// Put RGBA pixels on the GPU, reusing one texture per slot and size (the same pixels are not sent twice).
function upload(slot: string, pixels: Buffer, width: number, height: number): Texture {
  const key = `${slot}:${width}x${height}`;
  let texture = textures.get(key);
  if (texture && uploaded.get(key) === pixels) return texture;
  uploaded.set(key, pixels);
  if (texture) engine().UpdateTexture(texture, pixels);
  else {
    texture = engine().LoadTextureFromImage({ data: pixels, width, height, mipmaps: 1, format: 7 }) as Texture; // 7 = RGBA, 8 bits each
    smooth(texture);
    textures.set(key, texture);
  }
  return texture;
}

// An off-screen picture to draw into, one per slot and size.
function target(slot: string, width: number, height: number): Target {
  const key = `${slot}:${width}x${height}`;
  let found = targets.get(key);
  if (!found) {
    found = engine().LoadRenderTexture(width, height) as Target;
    smooth(found.texture);
    targets.set(key, found);
  }
  return found;
}

type Uniforms = Record<string, number | number[]>;

// Draw a shader over all of `into`, with these numbers and pictures as its inputs.
function draw(shader: any, into: Target, uniforms: Uniforms, pictures: Record<string, Texture>): void {
  const gpu = engine();
  gpu.BeginTextureMode(into);
  gpu.BeginShaderMode(shader);
  for (const [name, value] of Object.entries(uniforms)) {
    const at = location(shader, name);
    const list = Array.isArray(value) ? value : [value];
    if (at >= 0) gpu.SetShaderValue(shader, at, new Float32Array(list), list.length - 1); // 0 = float, 1 = vec2, 2 = vec3, 3 = vec4
  }
  for (const [name, texture] of Object.entries(pictures)) {
    const at = location(shader, name);
    if (at >= 0) gpu.SetShaderValueTexture(shader, at, texture);
  }
  gpu.DrawRectangle(0, 0, into.texture.width, into.texture.height, { r: 255, g: 255, b: 255, a: 255 });
  gpu.EndShaderMode();
  gpu.EndTextureMode();
}

// The pixels of an off-screen picture, top row first.
function readPixels(from: Target): Buffer {
  const { width, height } = from.texture;
  const pixels = Buffer.alloc(width * height * 4);
  engine().rlEnableFramebuffer(from.id);
  engine().glReadPixels(0, 0, width, height, 0x1908, 0x1401, pixels); // GL_RGBA, GL_UNSIGNED_BYTE
  engine().rlDisableFramebuffer();
  return pixels;
}

// ---------- Effects ----------
// Every effect is GLSL that defines `vec4 effect(vec2 uv)`: the color at uv (0..1, top-left = 0,0).
// It can use pixel(uv) (the source picture), time, progress, amount, resolution, ratio
// and the helpers random, noise, luma, mirrored, blurred and edges. Settings are constants with defaults.

type Value = number | number[];
type Effect = { kind: "look" | "color" | "distort" | "particles"; does: string; settings?: Record<string, Value>; ownAmount?: boolean; glsl: string };

const EFFECT_HEADER = `#version 330
out vec4 finalColor;
uniform sampler2D source;  // the picture or frame
uniform vec2 resolution;   // its size in pixels
uniform float time;        // seconds since the start
uniform float progress;    // 0 at the start of the clip, 1 at the end
uniform float amount;      // strength: 0 = none, 1 = full
#define ratio (resolution.x / resolution.y)
vec4 pixel(vec2 uv) { return texture(source, uv); }
float random(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(random(i), random(i + vec2(1.0, 0.0)), f.x), mix(random(i + vec2(0.0, 1.0)), random(i + vec2(1.0, 1.0)), f.x), f.y);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec2 mirrored(vec2 uv) { return 1.0 - abs(1.0 - mod(uv, 2.0)); }
vec4 blurred(vec2 uv, float radius) {
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int x = -3; x <= 3; x++) for (int y = -3; y <= 3; y++) {
    float w = exp(-float(x * x + y * y) / 6.0);
    sum += texture(source, uv + vec2(x, y) * radius / 3.0 / resolution) * w;
    total += w;
  }
  return sum / total;
}
float edges(vec2 uv) {
  vec2 p = 1.0 / resolution;
  float tl = luma(pixel(uv - p).rgb), t = luma(pixel(uv + vec2(0.0, -p.y)).rgb), tr = luma(pixel(uv + vec2(p.x, -p.y)).rgb);
  float l = luma(pixel(uv + vec2(-p.x, 0.0)).rgb), r = luma(pixel(uv + vec2(p.x, 0.0)).rgb);
  float bl = luma(pixel(uv + vec2(-p.x, p.y)).rgb), b = luma(pixel(uv + vec2(0.0, p.y)).rgb), br = luma(pixel(uv + p).rgb);
  return length(vec2(tr + 2.0 * r + br - tl - 2.0 * l - bl, bl + 2.0 * b + br - tl - 2.0 * t - tr));
}
`;

const EFFECTS: Record<string, Effect> = {
  // ----- looks -----
  bloom: {
    kind: "look",
    does: "bright parts glow (bright footage: lower strength or raise threshold)",
    settings: { threshold: 0.7, radius: 16, strength: 0.8 },
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  vec3 glow = vec3(0.0);
  float total = 0.0;
  for (int x = -4; x <= 4; x++) for (int y = -4; y <= 4; y++) {
    float w = exp(-float(x * x + y * y) / 8.0);
    vec3 s = pixel(uv + vec2(x, y) * radius / 4.0 / resolution).rgb;
    glow += max(s - threshold, 0.0) / (1.0 - threshold) * w;
    total += w;
  }
  return vec4(c.rgb + glow / total * strength, c.a);
}`,
  },
  dream: {
    kind: "look",
    does: "soft glow and lifted shadows, dreamy",
    settings: { radius: 20, strength: 0.6 },
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  vec3 soft = blurred(uv, radius).rgb;
  vec3 screen = 1.0 - (1.0 - c.rgb) * (1.0 - soft * strength);
  return vec4(mix(vec3(luma(screen)), screen, 0.9) + 0.03, c.a);
}`,
  },
  grain: {
    kind: "look",
    does: "moving film grain",
    settings: { size: 1.5, strength: 0.12 },
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  float n = random(floor(gl_FragCoord.xy / size) + fract(time * 7.31) * 113.0) - 0.5;
  return vec4(c.rgb + n * strength * 2.0, c.a);
}`,
  },
  film: {
    kind: "look",
    does: "old film: warm color, grain, flicker, gate weave, scratches, vignette",
    glsl: `vec4 effect(vec2 uv) {
  float frame = floor(time * 24.0);
  vec2 weave = (vec2(random(vec2(frame, 1.0)), random(vec2(frame, 2.0))) - 0.5) * 0.003;
  vec4 c = pixel(uv + weave);
  vec3 col = mix(vec3(luma(c.rgb)), c.rgb, 0.85) * vec3(1.07, 1.0, 0.9);
  col *= 0.95 + 0.05 * random(vec2(frame, 3.0));
  col += (random(gl_FragCoord.xy + frame * 17.0) - 0.5) * 0.1;
  float line = random(vec2(frame, 4.0));
  if (random(vec2(frame, 5.0)) > 0.65) col += 0.3 * (1.0 - smoothstep(0.0, 1.5 / resolution.x, abs(uv.x - line)));
  col *= mix(0.6, 1.0, smoothstep(1.0, 0.45, length(uv - 0.5) * 1.4142));
  return vec4(col, c.a);
}`,
  },
  vignette: {
    kind: "look",
    does: "darker edges",
    settings: { size: 0.85, softness: 0.55, darkness: 0.85 },
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  float v = smoothstep(size, size - softness, length(uv - 0.5) * 1.4142);
  return vec4(c.rgb * mix(1.0 - darkness, 1.0, v), c.a);
}`,
  },
  blur: {
    kind: "look",
    does: "soft focus (radius in pixels)",
    settings: { radius: 8 },
    glsl: `vec4 effect(vec2 uv) { return blurred(uv, radius); }`,
  },
  sharpen: {
    kind: "look",
    does: "crisper detail",
    settings: { strength: 1 },
    glsl: `vec4 effect(vec2 uv) {
  vec2 p = 1.0 / resolution;
  vec4 c = pixel(uv);
  vec3 around = (pixel(uv + vec2(p.x, 0.0)).rgb + pixel(uv - vec2(p.x, 0.0)).rgb + pixel(uv + vec2(0.0, p.y)).rgb + pixel(uv - vec2(0.0, p.y)).rgb) * 0.25;
  return vec4(c.rgb + (c.rgb - around) * strength * 2.0, c.a);
}`,
  },
  chromatic: {
    kind: "look",
    does: "red and blue split apart toward the edges, like a cheap lens (offset in pixels)",
    settings: { offset: 6 },
    glsl: `vec4 effect(vec2 uv) {
  vec2 o = (uv - 0.5) * 2.0 * offset / resolution;
  vec4 c = pixel(uv);
  return vec4(pixel(uv + o).r, c.g, pixel(uv - o).b, c.a);
}`,
  },
  glitch: {
    kind: "look",
    does: "digital glitch: rows jump sideways, colors split",
    settings: { strength: 1, speed: 1 },
    ownAmount: true,
    glsl: `vec4 effect(vec2 uv) {
  float k = strength * amount;
  float t = floor(time * 12.0 * speed);
  float row = floor(uv.y * 24.0);
  float hit = step(1.0 - 0.3 * k, random(vec2(row, t)));
  vec2 u = vec2(uv.x + (random(vec2(t, row)) - 0.5) * 0.15 * hit * k, uv.y);
  float split = 0.008 * k * (0.4 + hit);
  vec4 c = pixel(u);
  vec3 col = vec3(pixel(u + vec2(split, 0.0)).r, c.g, pixel(u - vec2(split, 0.0)).b);
  if (hit > 0.5 && random(vec2(t, row + 9.0)) > 0.7) col = floor(col * 3.0) / 3.0 + vec3(0.1, 0.0, 0.15);
  return vec4(col, c.a);
}`,
  },
  crt: {
    kind: "look",
    does: "old TV: curved glass, scanlines, RGB dots",
    settings: { curvature: 0.15 },
    ownAmount: true,
    glsl: `vec4 effect(vec2 uv) {
  vec2 q = uv * 2.0 - 1.0;
  q *= 1.0 + curvature * amount * q.yx * q.yx;
  vec2 u = q * 0.5 + 0.5;
  if (u.x < 0.0 || u.x > 1.0 || u.y < 0.0 || u.y > 1.0) return vec4(0.0, 0.0, 0.0, 1.0);
  vec3 col = pixel(u).rgb;
  col *= mix(1.0, 0.7 + 0.3 * sin(u.y * resolution.y * 3.14159), amount);
  float m = mod(gl_FragCoord.x, 3.0);
  vec3 mask = m < 1.0 ? vec3(1.0, 0.75, 0.75) : m < 2.0 ? vec3(0.75, 1.0, 0.75) : vec3(0.75, 0.75, 1.0);
  col *= mix(vec3(1.0), mask, amount) * mix(1.0, 1.3, amount);
  float edge = smoothstep(0.0, 0.08, min(min(u.x, 1.0 - u.x), min(u.y, 1.0 - u.y)));
  return vec4(col * mix(1.0, edge, amount), 1.0);
}`,
  },
  vhs: {
    kind: "look",
    does: "VHS tape: wobble, color bleed, noise and a rolling tracking band",
    glsl: `vec4 effect(vec2 uv) {
  float wobble = (noise(vec2(uv.y * 6.0, time * 3.0)) - 0.5) * 0.006;
  float band = 1.0 - smoothstep(0.0, 0.04, abs(uv.y - fract(time * 0.12)));
  vec2 u = vec2(uv.x + wobble + band * (random(vec2(time, uv.y)) - 0.5) * 0.03, uv.y);
  vec4 c = pixel(u);
  vec3 col = vec3(pixel(u + vec2(0.004, 0.0)).r, c.g, pixel(u - vec2(0.004, 0.0)).b);
  col = mix(col, vec3(luma(col)), 0.25) * vec3(1.05, 1.0, 1.1);
  col += (random(gl_FragCoord.xy + fract(time) * 100.0) - 0.5) * 0.08;
  col += band * random(vec2(gl_FragCoord.x, time)) * 0.35;
  col *= 0.93 + 0.07 * sin(gl_FragCoord.y * 1.7);
  return vec4(col, c.a);
}`,
  },
  scanlines: {
    kind: "look",
    does: "dark horizontal lines (spacing in pixels)",
    settings: { spacing: 3, strength: 0.3 },
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  return vec4(c.rgb * (1.0 - strength * step(0.5, fract(gl_FragCoord.y / spacing))), c.a);
}`,
  },
  pixelate: {
    kind: "look",
    does: "big square pixels (size in pixels)",
    settings: { size: 16 },
    ownAmount: true,
    glsl: `vec4 effect(vec2 uv) {
  vec2 cell = max(1.0, size * amount) / resolution;
  return pixel((floor(uv / cell) + 0.5) * cell);
}`,
  },
  posterize: {
    kind: "look",
    does: "few flat color levels, like a poster",
    settings: { levels: 5 },
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  return vec4(floor(c.rgb * (levels - 1.0) + 0.5) / (levels - 1.0), c.a);
}`,
  },
  halftone: {
    kind: "look",
    does: "printed ink dots on paper (size in pixels)",
    settings: { size: 8 },
    glsl: `vec4 effect(vec2 uv) {
  mat2 turn = mat2(0.7071, -0.7071, 0.7071, 0.7071);
  vec2 q = turn * gl_FragCoord.xy;
  vec2 cell = (floor(q / size) + 0.5) * size;
  vec3 col = pixel((transpose(turn) * cell) / resolution).rgb;
  float radius = size * 0.62 * sqrt(1.0 - clamp(luma(col), 0.0, 1.0));
  float ink = 1.0 - smoothstep(radius - 0.8, radius + 0.8, length(q - cell));
  return vec4(mix(vec3(0.97, 0.95, 0.9), vec3(0.08), ink), 1.0);
}`,
  },
  sketch: {
    kind: "look",
    does: "pencil drawing on paper",
    settings: { strength: 1 },
    glsl: `vec4 effect(vec2 uv) {
  float ink = smoothstep(0.05, 0.35, edges(uv) * strength);
  return vec4(mix(vec3(0.97, 0.96, 0.93), vec3(0.12, 0.12, 0.15), ink), pixel(uv).a);
}`,
  },
  neon: {
    kind: "look",
    does: "glowing rainbow outlines on a dark picture",
    settings: { strength: 1 },
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  float e = smoothstep(0.05, 0.4, edges(uv) * strength);
  vec3 hue = 0.5 + 0.5 * cos(6.2831 * (uv.x * 0.5 + time * 0.1 + vec3(0.0, 0.33, 0.67)));
  return vec4(c.rgb * 0.15 + hue * e * 1.5, c.a);
}`,
  },
  "light-leak": {
    kind: "look",
    does: "warm light drifting across the picture (bright footage: lower strength)",
    settings: { speed: 1, strength: 0.4 },
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  vec3 light = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float f = float(i);
    vec2 centre = vec2(0.5 + 0.7 * sin(time * 0.31 * speed + f * 2.1), 0.5 + 0.5 * cos(time * 0.23 * speed + f * 1.7));
    float d = length((uv - centre) * vec2(ratio, 1.0));
    light += mix(vec3(1.0, 0.5, 0.15), vec3(1.0, 0.25, 0.4), f / 2.0) * exp(-d * d * 3.0);
  }
  return vec4(1.0 - (1.0 - c.rgb) * (1.0 - min(light * strength, 1.0)), c.a);
}`,
  },
  letterbox: {
    kind: "look",
    does: "black cinema bars to this aspect (2.39 = widescreen)",
    settings: { aspect: 2.39 },
    ownAmount: true,
    glsl: `vec4 effect(vec2 uv) {
  float bar = max(0.0, 1.0 - resolution.x / aspect / resolution.y) * 0.5 * amount;
  return uv.y < bar || uv.y > 1.0 - bar ? vec4(0.0, 0.0, 0.0, 1.0) : pixel(uv);
}`,
  },
  "tilt-shift": {
    kind: "look",
    does: "miniature look: sharp band (focus 0 = top, 1 = bottom), blurred above and below",
    settings: { focus: 0.55, width: 0.15, radius: 10 },
    glsl: `vec4 effect(vec2 uv) {
  float away = smoothstep(width, width + 0.25, abs(uv.y - focus));
  vec4 c = away > 0.01 ? blurred(uv, radius * away) : pixel(uv);
  return vec4(mix(vec3(luma(c.rgb)), c.rgb, 1.25), c.a);
}`,
  },
  // ----- color -----
  grade: {
    kind: "color",
    does: "exposure (stops), contrast, saturation and warmth (-1 cool .. 1 warm)",
    settings: { exposure: 0, contrast: 1, saturation: 1, warmth: 0 },
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  vec3 col = c.rgb * exp2(exposure);
  col = (col - 0.5) * contrast + 0.5;
  col = mix(vec3(luma(col)), col, saturation);
  col *= vec3(1.0 + warmth * 0.1, 1.0, 1.0 - warmth * 0.1);
  return vec4(col, c.a);
}`,
  },
  duotone: {
    kind: "color",
    does: "two colors: dark parts take one, light parts the other",
    settings: { dark: [0.1, 0.08, 0.3], light: [1, 0.75, 0.3] },
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  return vec4(mix(dark, light, smoothstep(0.0, 1.0, luma(c.rgb))), c.a);
}`,
  },
  tint: {
    kind: "color",
    does: "wash the picture with a color",
    settings: { color: [1, 0.6, 0.3], strength: 0.3 },
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  return vec4(mix(c.rgb, c.rgb * color / max(luma(color), 0.01), strength), c.a);
}`,
  },
  bw: {
    kind: "color",
    does: "black and white",
    settings: { contrast: 1.1 },
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  return vec4(vec3((luma(c.rgb) - 0.5) * contrast + 0.5), c.a);
}`,
  },
  sepia: {
    kind: "color",
    does: "brown old-photo tones",
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  return vec4(dot(c.rgb, vec3(0.393, 0.769, 0.189)), dot(c.rgb, vec3(0.349, 0.686, 0.168)), dot(c.rgb, vec3(0.272, 0.534, 0.131)), c.a);
}`,
  },
  invert: {
    kind: "color",
    does: "negative colors",
    glsl: `vec4 effect(vec2 uv) { vec4 c = pixel(uv); return vec4(1.0 - c.rgb, c.a); }`,
  },
  thermal: {
    kind: "color",
    does: "heat camera colors",
    glsl: `vec4 effect(vec2 uv) {
  float l = clamp(luma(blurred(uv, 2.0).rgb), 0.0, 1.0);
  vec3 col = l < 0.25 ? mix(vec3(0.0, 0.0, 0.15), vec3(0.35, 0.0, 0.7), l / 0.25)
    : l < 0.5 ? mix(vec3(0.35, 0.0, 0.7), vec3(0.95, 0.1, 0.2), (l - 0.25) / 0.25)
    : l < 0.75 ? mix(vec3(0.95, 0.1, 0.2), vec3(1.0, 0.75, 0.0), (l - 0.5) / 0.25)
    : mix(vec3(1.0, 0.75, 0.0), vec3(1.0, 1.0, 0.9), (l - 0.75) / 0.25);
  return vec4(col, pixel(uv).a);
}`,
  },
  "night-vision": {
    kind: "color",
    does: "green night-vision goggles",
    glsl: `vec4 effect(vec2 uv) {
  float l = luma(pixel(uv).rgb) * 1.8 + (random(gl_FragCoord.xy + fract(time) * 50.0) - 0.5) * 0.25;
  l *= smoothstep(0.9, 0.3, length(uv - 0.5) * 1.4142) * (0.9 + 0.1 * sin(gl_FragCoord.y * 2.0));
  return vec4(vec3(0.15, 1.0, 0.25) * l, 1.0);
}`,
  },
  // ----- distort -----
  fisheye: {
    kind: "distort",
    does: "bulging wide lens",
    settings: { strength: 0.5 },
    ownAmount: true,
    glsl: `vec4 effect(vec2 uv) {
  vec2 q = uv - 0.5;
  float k = strength * amount;
  return pixel(0.5 + q * (1.0 - k + k * 2.0 * dot(q, q)));
}`,
  },
  mirror: {
    kind: "distort",
    does: "left half reflected onto the right",
    glsl: `vec4 effect(vec2 uv) { return pixel(vec2(uv.x > 0.5 ? 1.0 - uv.x : uv.x, uv.y)); }`,
  },
  kaleidoscope: {
    kind: "distort",
    does: "turning mirrored slices",
    settings: { segments: 6, speed: 0.1 },
    glsl: `vec4 effect(vec2 uv) {
  vec2 q = (uv - 0.5) * vec2(ratio, 1.0);
  float slice = 6.2831853 / segments;
  float a = mod(atan(q.y, q.x) + time * speed, slice);
  a = abs(a - slice * 0.5);
  vec2 p = length(q) * vec2(cos(a), sin(a));
  return pixel(mirrored(p / vec2(ratio, 1.0) + 0.5));
}`,
  },
  wave: {
    kind: "distort",
    does: "wavy sideways ripple (strength in pixels)",
    settings: { strength: 10, speed: 1 },
    ownAmount: true,
    glsl: `vec4 effect(vec2 uv) { return pixel(vec2(uv.x + sin(uv.y * 18.0 + time * 4.0 * speed) * strength * amount / resolution.x, uv.y)); }`,
  },
  heat: {
    kind: "distort",
    does: "rising heat shimmer (strength in pixels)",
    settings: { strength: 5 },
    ownAmount: true,
    glsl: `vec4 effect(vec2 uv) {
  vec2 n = vec2(noise(uv * vec2(10.0, 40.0) + vec2(0.0, time * 4.0)), noise(uv * vec2(10.0, 40.0) + vec2(7.0, time * 4.0))) - 0.5;
  return pixel(uv + n * 2.0 * strength * amount / resolution);
}`,
  },
  shake: {
    kind: "distort",
    does: "hand-held camera shake (strength in pixels)",
    settings: { strength: 14, speed: 1 },
    ownAmount: true,
    glsl: `vec4 effect(vec2 uv) {
  float t = time * 7.0 * speed;
  vec2 move = (vec2(noise(vec2(t, 1.7)), noise(vec2(t, 9.3))) - 0.5) * 2.0 * strength * amount / resolution;
  float zoom = 1.0 - 2.0 * strength * amount / min(resolution.x, resolution.y);
  return pixel(0.5 + (uv - 0.5) * zoom + move);
}`,
  },
  // ----- particles (drawn over the picture; density 0..2, speed 1 = normal) -----
  snow: {
    kind: "particles",
    does: "falling snow",
    settings: { density: 1, speed: 1 },
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  float flakes = 0.0;
  for (int i = 0; i < 4; i++) {
    float f = float(i);
    float scale = 4.0 + f * 4.0;
    vec2 p = uv * vec2(ratio, 1.0) * scale;
    p.y -= time * speed * (1.2 - f * 0.2);
    p.x += sin(time * 0.8 + f * 2.0 + p.y * 0.5) * 0.3;
    vec2 cell = floor(p);
    if (random(cell + f * 31.0) > 0.55 * density) continue;
    vec2 spot = 0.2 + 0.6 * vec2(random(cell + f * 7.0 + 1.3), random(cell + f * 5.0 + 4.1));
    float size = 0.05 + 0.04 * random(cell + 9.0);
    flakes += smoothstep(size, size * 0.3, length(fract(p) - spot)) * (1.0 - f * 0.18);
  }
  return vec4(mix(c.rgb, vec3(1.0), clamp(flakes, 0.0, 1.0)), c.a);
}`,
  },
  rain: {
    kind: "particles",
    does: "slanted rain streaks and a cooler, darker mood",
    settings: { density: 1, speed: 1 },
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  float drops = 0.0;
  for (int i = 0; i < 3; i++) {
    float f = float(i);
    float scale = 14.0 + f * 10.0;
    vec2 p = vec2((uv.x + uv.y * 0.12) * ratio * scale, uv.y * scale * 0.25);
    p.y -= time * speed * (3.0 + f);
    vec2 cell = floor(p);
    vec2 inCell = fract(p);
    if (random(cell + f * 13.0) > 0.45 * density) continue;
    float x = 0.2 + 0.6 * random(cell + f * 3.0);
    float y = random(cell + f * 5.0 + 2.0) * 0.5;
    drops += (1.0 - smoothstep(0.0, 0.06, abs(inCell.x - x))) * step(y, inCell.y) * step(inCell.y, y + 0.45) * (0.6 - f * 0.15);
  }
  return vec4(c.rgb * vec3(0.85, 0.9, 0.98) + drops * 0.5, c.a);
}`,
  },
  confetti: {
    kind: "particles",
    does: "colorful spinning confetti",
    settings: { density: 1, speed: 1 },
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  vec3 col = c.rgb;
  for (int i = 0; i < 3; i++) {
    float f = float(i);
    float scale = 5.0 + f * 4.0;
    vec2 p = uv * vec2(ratio, 1.0) * scale;
    p.y -= time * speed * (0.8 + f * 0.3);
    p.x += sin(time * 1.5 + p.y + f) * 0.2;
    vec2 cell = floor(p);
    if (random(cell + f * 17.0) > 0.5 * density) continue;
    vec2 spot = 0.25 + 0.5 * vec2(random(cell + 1.7 + f), random(cell + 3.9 + f));
    float spin = time * (2.0 + 4.0 * random(cell + 5.0)) + random(cell) * 6.28;
    vec2 d = mat2(cos(spin), -sin(spin), sin(spin), cos(spin)) * (fract(p) - spot);
    float flip = abs(sin(time * 4.0 + random(cell + 2.0) * 10.0)) * 0.05 + 0.01;
    float inside = step(abs(d.x), 0.1) * step(abs(d.y), flip);
    col = mix(col, 0.55 + 0.45 * cos(6.2831 * (random(cell + 8.0) + vec3(0.0, 0.33, 0.67))), inside);
  }
  return vec4(col, c.a);
}`,
  },
  embers: {
    kind: "particles",
    does: "glowing sparks rising, like from a fire",
    settings: { density: 1, speed: 1 },
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  vec3 light = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float f = float(i);
    float scale = 5.0 + f * 5.0;
    vec2 p = uv * vec2(ratio, 1.0) * scale;
    p.y += time * speed * (0.6 + f * 0.25);
    p.x += sin(time + p.y * 0.8 + f * 3.0) * 0.3;
    vec2 cell = floor(p);
    if (random(cell + f * 23.0) > 0.4 * density) continue;
    vec2 spot = 0.2 + 0.6 * vec2(random(cell + 2.3 + f), random(cell + 6.1 + f));
    float d = length(fract(p) - spot);
    float flicker = 0.6 + 0.4 * sin(time * 9.0 + random(cell) * 40.0);
    light += vec3(1.0, 0.45, 0.1) * (exp(-d * d * 1200.0) * 2.0 + exp(-d * d * 80.0) * 0.15) * flicker;
  }
  return vec4(c.rgb + light, c.a);
}`,
  },
  dust: {
    kind: "particles",
    does: "soft dust motes floating in the light",
    settings: { density: 1, speed: 1 },
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  float light = 0.0;
  for (int i = 0; i < 3; i++) {
    float f = float(i);
    float scale = 6.0 + f * 6.0;
    vec2 p = uv * vec2(ratio, 1.0) * scale + vec2(time * 0.05 * speed * (1.0 + f), -time * 0.03 * speed);
    p += 0.2 * vec2(sin(time * 0.5 + f), cos(time * 0.4 + f * 2.0));
    vec2 cell = floor(p);
    if (random(cell + f * 29.0) > 0.35 * density) continue;
    vec2 spot = 0.2 + 0.6 * vec2(random(cell + 1.1 + f), random(cell + 5.3 + f));
    float d = length(fract(p) - spot);
    light += exp(-d * d * 1500.0) * (0.35 + 0.25 * sin(time * 2.0 + random(cell) * 30.0));
  }
  return vec4(c.rgb + light * vec3(1.0, 0.97, 0.9), c.a);
}`,
  },
  bokeh: {
    kind: "particles",
    does: "big soft out-of-focus lights",
    settings: { density: 1, speed: 1 },
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  vec3 light = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    float f = float(i);
    float scale = 2.5 + f * 2.0;
    vec2 p = uv * vec2(ratio, 1.0) * scale + vec2(time * 0.04 * speed, time * 0.02 * speed * (1.0 + f));
    vec2 cell = floor(p);
    if (random(cell + f * 11.0) > 0.5 * density) continue;
    vec2 spot = 0.32 + 0.36 * vec2(random(cell + 2.9 + f), random(cell + 8.3 + f));
    float r = 0.18 + 0.12 * random(cell + 4.0);
    float disc = smoothstep(r, r * 0.85, length(fract(p) - spot));
    light += mix(vec3(1.0, 0.75, 0.4), vec3(0.6, 0.8, 1.0), random(cell + 7.0)) * disc * (0.25 + 0.1 * sin(time + random(cell) * 20.0));
  }
  return vec4(1.0 - (1.0 - c.rgb) * (1.0 - light), c.a);
}`,
  },
  fireflies: {
    kind: "particles",
    does: "blinking fireflies drifting around",
    settings: { density: 1, speed: 1 },
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  vec3 light = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    float f = float(i);
    vec2 p = uv * vec2(ratio, 1.0) * (4.0 + f * 3.0);
    vec2 cell = floor(p);
    if (random(cell + f * 19.0) > 0.35 * density) continue;
    float r0 = random(cell + f);
    vec2 spot = 0.5 + 0.25 * vec2(sin(time * 0.7 * speed + r0 * 20.0), cos(time * 0.5 * speed + r0 * 13.0));
    float d = length(fract(p) - spot);
    float blink = pow(0.5 + 0.5 * sin(time * 2.0 * speed + r0 * 40.0), 3.0);
    light += vec3(0.85, 1.0, 0.35) * (exp(-d * d * 1500.0) * 1.5 + exp(-d * d * 60.0) * 0.25) * blink;
  }
  return vec4(c.rgb + light, c.a);
}`,
  },
};

// A .cube color look (LUT) as an effect. The table is stored as size*size wide, size high: blue picks the slice.
const LUT_EFFECT = `uniform sampler2D lut;
vec4 effect(vec2 uv) {
  vec4 c = pixel(uv);
  vec3 v = clamp(c.rgb, 0.0, 1.0) * (lutSize - 1.0);
  float b0 = floor(v.b);
  float b1 = min(b0 + 1.0, lutSize - 1.0);
  vec2 rg = (v.rg + 0.5) / vec2(lutSize * lutSize, lutSize);
  vec3 low = texture(lut, rg + vec2(b0 / lutSize, 0.0)).rgb;
  vec3 high = texture(lut, rg + vec2(b1 / lutSize, 0.0)).rgb;
  return vec4(mix(low, high, v.b - b0), c.a);
}`;

// A test picture for galleries: a gradient, a checker and a bright circle (variant 0 or 1 for other colors).
const TEST_CARD = `vec4 effect(vec2 uv) {
  vec2 p = uv * vec2(ratio, 1.0);
  vec3 a = variant < 0.5 ? vec3(0.10, 0.45, 0.85) : vec3(0.90, 0.35, 0.20);
  vec3 b = variant < 0.5 ? vec3(0.95, 0.80, 0.30) : vec3(0.20, 0.75, 0.55);
  vec3 col = mix(a, b, uv.y) * (0.85 + 0.15 * mod(floor(p.x * 8.0) + floor(p.y * 8.0), 2.0));
  float circle = smoothstep(0.205, 0.195, length(p - vec2(ratio * 0.5, 0.5)));
  return vec4(mix(col, vec3(1.0), circle * 0.9), 1.0);
}`;

// ---------- Settings (--set) ----------

// A number as GLSL ("1" -> "1.0").
function glslNumber(n: number): string {
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

function glslConstant(name: string, value: Value): string {
  if (typeof value === "number") return `const float ${name} = ${glslNumber(value)};`;
  return `const vec${value.length} ${name} = vec${value.length}(${value.map(glslNumber).join(", ")});`;
}

// Read one setting: "1.5", "0.5 0.2" (a vector) or "#FF8800" (a color).
function parseValue(text: string): Value {
  const hex = text.trim().match(/^#([0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) return hex[1].match(/../g)!.map((pair) => round(parseInt(pair, 16) / 255, 4));
  if (text.trim() === "true" || text.trim() === "false") return text.trim() === "true" ? 1 : 0;
  const numbers = text.trim().split(/\s+/).map(Number);
  if (!numbers.length || numbers.some(Number.isNaN)) throw new Error(`"${text}" is not a setting value. Use a number, numbers with spaces ("1 0") or a color ("#FF8800").`);
  return numbers.length === 1 ? numbers[0] : numbers;
}

// "strength=1.5, bloom.radius=20, dark=#102030" -> { strength: "1.5", "bloom.radius": "20", dark: "#102030" }
export function parseSet(text = ""): Record<string, string> {
  const set: Record<string, string> = {};
  for (const part of text.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [key, value] = part.split("=");
    if (!key || value === undefined) throw new Error(`--set takes name=value pairs, like --set "strength=1.5,radius=20". Got "${part}".`);
    set[key.trim()] = value.trim();
  }
  return set;
}

// The settings in `set` that belong to one effect or transition (plain "name" or "effect.name").
function settingsFor(owner: string, defaults: Record<string, Value>, set: Record<string, string>, used: Set<string>): Record<string, Value> {
  const values = { ...defaults };
  for (const [key, text] of Object.entries(set)) {
    const [prefix, name] = key.includes(".") ? key.split(".") : [owner, key];
    if (prefix !== owner || !(name in defaults)) continue;
    const value = parseValue(text);
    const wanted = defaults[name];
    const size = (v: Value) => (typeof v === "number" ? 1 : v.length);
    if (size(value) !== size(wanted)) throw new Error(`${owner} ${name} takes ${size(wanted) === 1 ? "a number" : `${size(wanted)} numbers or a color`}.`);
    values[name] = value;
    used.add(key);
  }
  return values;
}

// ---------- Effect chains ----------

type Step = { name: string; shader: any; mixes: boolean; pictures: Record<string, Texture> };

// The full shader for an effect: header, settings as constants, the effect, then main().
function effectSource(code: string, settings: Record<string, Value>, mixes: boolean): { source: string; headerLines: number } {
  const head = EFFECT_HEADER + Object.entries(settings).map(([k, v]) => glslConstant(k, v)).join("\n") + "\n";
  const main = `
void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  vec4 result = effect(uv);
  finalColor = ${mixes ? "mix(pixel(uv), result, amount)" : "result"};
}`;
  return { source: head + code + "\n" + main, headerLines: head.split("\n").length - 1 };
}

// Read a .cube LUT file into a table picture on the GPU.
function loadLut(file: string): { size: number; texture: Texture } {
  const rows: number[][] = [];
  let size = 0;
  let low = [0, 0, 0];
  let high = [1, 1, 1];
  for (const raw of readFileSync(requireFile(file), "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("TITLE")) continue;
    const words = line.split(/\s+/);
    if (words[0] === "LUT_3D_SIZE") size = Number(words[1]);
    else if (words[0] === "DOMAIN_MIN") low = words.slice(1).map(Number);
    else if (words[0] === "DOMAIN_MAX") high = words.slice(1).map(Number);
    else if (/^-?[\d.]/.test(words[0])) rows.push(words.slice(0, 3).map(Number));
  }
  if (!size || rows.length !== size ** 3) throw new Error(`${file} is not a 3D .cube LUT (need LUT_3D_SIZE and size³ rows).`);
  // Rows go red fastest, then green, then blue. Table pixel (blue * size + red, green).
  const table = Buffer.alloc(size * size * size * 4);
  rows.forEach((rgb, n) => {
    const r = n % size;
    const gIndex = Math.floor(n / size) % size;
    const b = Math.floor(n / size / size);
    const at = (gIndex * size * size + b * size + r) * 4;
    for (let k = 0; k < 3; k++) table[at + k] = Math.round(Math.min(1, Math.max(0, (rgb[k] - low[k]) / (high[k] - low[k]))) * 255);
    table[at + 3] = 255;
  });
  return { size, texture: upload(`lut:${file}`, table, size * size, size) };
}

// Every built-in effect name (plus "lut").
export function effectNames(): string[] {
  return [...Object.keys(EFFECTS), "lut"];
}

// Turn effect names (or .glsl files) and --set values into ready shaders, in order.
export function prepareEffects(names: string[], set: Record<string, string> = {}, lut?: string): Step[] {
  if (!names.length) throw new Error(`Name at least one effect with --effect, e.g. --effect bloom,grain. See: node joedit.ts fx list`);
  const used = new Set<string>();
  const steps = names.map((name): Step => {
    if (name.endsWith(".glsl")) {
      const { source, headerLines } = effectSource(readFileSync(requireFile(name), "utf8"), {}, true);
      return { name, shader: compile(source, headerLines), mixes: true, pictures: {} };
    }
    if (name === "lut") {
      if (!lut) throw new Error("The lut effect needs a .cube file: --lut look.cube");
      const table = loadLut(lut);
      const { source } = effectSource(LUT_EFFECT, { lutSize: table.size }, true);
      return { name, shader: compile(source), mixes: true, pictures: { lut: table.texture } };
    }
    const effect = EFFECTS[name];
    if (!effect) throw new Error(`Unknown effect "${name}". Effects: ${[...Object.keys(EFFECTS), "lut"].join(", ")}, or your own file.glsl`);
    const mixes = !effect.ownAmount;
    const { source, headerLines } = effectSource(effect.glsl, settingsFor(name, effect.settings ?? {}, set, used), mixes);
    return { name, shader: compile(source, headerLines), mixes, pictures: {} };
  });
  const unused = Object.keys(set).filter((key) => !used.has(key));
  if (unused.length) {
    const known = names.flatMap((n) => Object.keys(EFFECTS[n]?.settings ?? {}).map((s) => `${n}.${s}`));
    throw new Error(`No effect here has the setting ${unused.join(", ")}. Settings: ${known.join(", ") || "none"}`);
  }
  return steps;
}

// The moment a frame is at: time in seconds, progress 0..1 through the clip, amount 0..1.
export type Moment = { time: number; progress: number; amount?: number };

// Run the effects on a frame; the result stays on the GPU (for the preview window).
function runEffects(pixels: Buffer, width: number, height: number, steps: Step[], moment: Moment): Target {
  let texture = upload("source", pixels, width, height);
  let last = target("a", width, height);
  steps.forEach((step, n) => {
    last = target(n % 2 ? "b" : "a", width, height);
    draw(step.shader, last, { resolution: [width, height], time: moment.time, progress: moment.progress, amount: moment.amount ?? 1 }, { source: texture, ...step.pictures });
    texture = last.texture;
  });
  return last;
}

// Run effects on one frame of RGBA pixels and return the new pixels (movies use this for every frame).
export function effectFrame(pixels: Buffer, width: number, height: number, steps: Step[], moment: Moment): Buffer {
  if (!steps.length) return pixels;
  return readPixels(runEffects(pixels, width, height, steps, moment));
}

// Draw any complete fragment shader (GLSL 330 writing `finalColor`) into a width x height picture.
// uniforms: numbers by name. pictures: RGBA pictures by sampler name. The shader can use
// `gl_FragCoord.xy / resolution` as uv (top-left = 0,0); `resolution` is set for it.
export function shaderFrame(
  source: string,
  width: number,
  height: number,
  uniforms: Uniforms,
  pictures: Record<string, { pixels: Buffer; width: number; height: number }> = {},
): Buffer {
  const shader = compile(source);
  const textures = Object.fromEntries(Object.entries(pictures).map(([name, p]) => [name, upload(`picture:${name}`, p.pixels, p.width, p.height)]));
  const into = target("a", width, height);
  draw(shader, into, { resolution: [width, height], ...uniforms }, textures);
  return readPixels(into);
}

// ---------- Transitions ----------
// From the gl-transitions collection (MIT/BSD, in libs) plus joEdit's own. Each defines
// `vec4 transition(vec2 p)` with getFromColor(p), getToColor(p), progress and ratio (p.y = 0 is the bottom).

type Transition = { glsl: string; settings: Record<string, { type: string; value: Value }> };

const TRANSITION_HEADER = `#version 330
out vec4 finalColor;
uniform sampler2D fromTexture;
uniform sampler2D toTexture;
uniform float progress;
uniform float ratio;
uniform vec2 resolution;
vec4 getFromColor(vec2 p) { return texture(fromTexture, vec2(p.x, 1.0 - p.y)); }
vec4 getToColor(vec2 p) { return texture(toTexture, vec2(p.x, 1.0 - p.y)); }
#define texture2D texture
`;

// joEdit's own transitions (whips move the picture in that direction with motion blur).
const WHIP = `vec4 transition(vec2 p) {
  float blur = sin(3.14159 * progress) * 0.2;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    vec2 q = p - direction * (progress + (float(i) / 15.0 - 0.5) * blur);
    sum += (q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0) ? getFromColor(q) : getToColor(q + direction);
  }
  return sum / 16.0;
}`;
const OWN_TRANSITIONS: Record<string, { glsl: string; settings?: Record<string, Value> }> = {
  "whip-left": { glsl: WHIP, settings: { direction: [-1, 0] } },
  "whip-right": { glsl: WHIP, settings: { direction: [1, 0] } },
  "whip-up": { glsl: WHIP, settings: { direction: [0, 1] } },
  "whip-down": { glsl: WHIP, settings: { direction: [0, -1] } },
  zoom: {
    settings: { zoom: 1.5, strength: 0.3 },
    glsl: `vec4 transition(vec2 p) {
  vec4 a = vec4(0.0), b = vec4(0.0);
  float blur = sin(3.14159 * progress) * strength;
  for (int i = 0; i < 12; i++) {
    float s = 1.0 - blur * float(i) / 11.0;
    a += getFromColor(0.5 + (p - 0.5) * s / (1.0 + progress * zoom));
    b += getToColor(0.5 + (p - 0.5) * s / (1.0 + (1.0 - progress) * zoom));
  }
  return mix(a, b, smoothstep(0.4, 0.6, progress)) / 12.0;
}`,
  },
  flash: {
    settings: { color: [1, 1, 1] },
    glsl: `vec4 transition(vec2 p) {
  vec4 c = progress < 0.5 ? getFromColor(p) : getToColor(p);
  return mix(c, vec4(color, 1.0), pow(1.0 - abs(progress - 0.5) * 2.0, 2.0));
}`,
  },
  blur: {
    settings: { radius: 0.03 },
    glsl: `vec4 transition(vec2 p) {
  float r = sin(3.14159 * progress) * radius;
  vec4 a = vec4(0.0), b = vec4(0.0);
  float total = 0.0;
  for (int x = -3; x <= 3; x++) for (int y = -3; y <= 3; y++) {
    float w = exp(-float(x * x + y * y) / 6.0);
    vec2 o = vec2(x, y) / 3.0 * r * vec2(1.0 / ratio, 1.0);
    a += getFromColor(p + o) * w;
    b += getToColor(p + o) * w;
    total += w;
  }
  return mix(a, b, smoothstep(0.3, 0.7, progress)) / total;
}`,
  },
  spin: {
    settings: { turns: 0.5 },
    glsl: `vec4 transition(vec2 p) {
  float angle = (progress < 0.5 ? progress : progress - 1.0) * turns * 6.2831853;
  vec2 q = (p - 0.5) * vec2(ratio, 1.0) * (1.0 + sin(3.14159 * progress) * 0.6);
  q = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * q;
  vec2 m = 1.0 - abs(1.0 - mod(q / vec2(ratio, 1.0) + 0.5, 2.0));
  return mix(getFromColor(m), getToColor(m), smoothstep(0.45, 0.55, progress));
}`,
  },
  "light-leak": {
    glsl: `vec4 transition(vec2 p) {
  vec4 c = mix(getFromColor(p), getToColor(p), smoothstep(0.35, 0.65, progress));
  float glow = sin(3.14159 * progress);
  float d = length((p - vec2(progress * 1.4 - 0.2, 0.6)) * vec2(ratio, 1.0));
  vec3 light = vec3(1.0, 0.55, 0.2) * exp(-d * d * 1.5) * glow * 1.6 + vec3(1.0, 0.85, 0.6) * glow * 0.25;
  return vec4(1.0 - (1.0 - c.rgb) * (1.0 - min(light, 1.0)), c.a);
}`,
  },
  glitch: {
    glsl: `float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec4 pick(vec2 q) { return progress > 0.5 ? getToColor(q) : getFromColor(q); }
vec4 transition(vec2 p) {
  float k = sin(3.14159 * progress);
  float t = floor(progress * 30.0);
  float row = floor(p.y * 20.0);
  float hit = step(1.0 - 0.6 * k, hash(vec2(row, t)));
  vec2 q = vec2(p.x + (hash(vec2(t, row)) - 0.5) * 0.3 * hit * k, p.y);
  float split = 0.02 * k;
  vec4 c = pick(q);
  return vec4(pick(q + vec2(split, 0.0)).r, c.g, pick(q - vec2(split, 0.0)).b, c.a);
}`,
  },
};

// "CrossZoom" -> "cross-zoom", "wipeLeft" -> "wipe-left", "rotate_scale_fade" -> "rotate-scale-fade"
function kebab(name: string): string {
  return name.replace(/_/g, "-").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

let transitionList: Map<string, Transition> | undefined;

// Every transition by name.
export function allTransitions(): Map<string, Transition> {
  if (transitionList) return transitionList;
  transitionList = new Map();
  const skip = new Set(["luma", "displacement", "cannabisleaf"]); // these need extra pictures, or do not suit a studio
  for (const t of need("gl-transitions/gl-transitions.json") as any[]) {
    if (skip.has(t.name)) continue;
    const settings: Transition["settings"] = {};
    for (const [name, type] of Object.entries(t.paramsTypes as Record<string, string>)) settings[name] = { type, value: t.defaultParams[name] };
    transitionList.set(kebab(t.name), { glsl: t.glsl, settings });
  }
  for (const [name, own] of Object.entries(OWN_TRANSITIONS)) {
    const settings: Transition["settings"] = {};
    for (const [key, value] of Object.entries(own.settings ?? {})) settings[key] = { type: typeof value === "number" ? "float" : `vec${value.length}`, value };
    transitionList.set(name, { glsl: own.glsl, settings });
  }
  return transitionList;
}

// A setting as GLSL of its declared type (gl-transitions use int, bool, ivec2 and vecs too).
function typedLiteral(type: string, value: Value | boolean): string {
  const list = (Array.isArray(value) ? value : [value]).map(Number);
  const one = (n: number) => (type.startsWith("i") || type === "int" ? String(Math.round(n)) : type === "bool" ? (n ? "true" : "false") : glslNumber(n));
  return type === "float" || type === "int" || type === "bool" ? one(list[0]) : `${type}(${list.map(one).join(", ")})`;
}

// Turn a transition name and --set values into a ready shader.
export function prepareTransition(name: string, set: Record<string, string> = {}): any {
  const transition = allTransitions().get(name);
  if (!transition) throw new Error(`Unknown transition "${name}". See them all: node joedit.ts fx list (or fx gallery t.png --kind transitions)`);
  const used = new Set<string>();
  const defaults = Object.fromEntries(Object.entries(transition.settings).map(([k, s]) => [k, s.value as Value]));
  const chosen = settingsFor(name, defaults, set, used);
  const unused = Object.keys(set).filter((key) => !used.has(key));
  if (unused.length) throw new Error(`${name} has no setting ${unused.join(", ")}. Its settings: ${Object.keys(defaults).join(", ") || "none"}`);
  // joEdit's own transitions get their settings as constants on top. gl-transitions declare settings as
  // uniforms: those become constants in place (other uniforms, like progress, come from the header).
  const code =
    name in OWN_TRANSITIONS
      ? Object.entries(chosen).map(([k, v]) => glslConstant(k, v)).join("\n") + "\n" + transition.glsl
      : transition.glsl.replace(/uniform\s+(\w+)\s+(\w+)\s*;[^\n]*/g, (_, type, key) =>
          key in transition.settings ? `const ${type} ${key} = ${typedLiteral(type, chosen[key])};` : "",
        );
  const main = `
void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  finalColor = transition(vec2(uv.x, 1.0 - uv.y));
}`;
  return compile(TRANSITION_HEADER + code + main);
}

// One frame of a transition: `progress` 0 = all first picture, 1 = all second. Eased so it starts and ends gently.
export function transitionFrame(shader: any, from: Buffer, to: Buffer, width: number, height: number, progress: number): Buffer {
  const eased = progress * progress * (3 - 2 * progress);
  const into = target("a", width, height);
  draw(shader, into, { progress: eased, ratio: width / height, resolution: [width, height] }, {
    fromTexture: upload("from", from, width, height),
    toTexture: upload("to", to, width, height),
  });
  return readPixels(into);
}

// ---------- Frames of pictures and videos ----------

// A picture as RGBA pixels at exactly width x height (filling, middle kept).
async function pictureFrame(input: string, width?: number, height?: number): Promise<Frame> {
  let image = await openPicture(input);
  if (width && height) image = image.resize(width, height, { fit: "cover" });
  const { data, info } = await image.toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true }); // always RGBA
  return { time: 0, pixels: data, width: info.width, height: info.height };
}

// Frames of a picture (repeated for `duration` seconds) or a video, at an exact size and frame rate.
async function* clipFrames(input: string, o: { width: number; height: number; fps: number; start?: number; duration?: number }): AsyncGenerator<Frame> {
  if (PICTURE_FILE.test(input)) {
    const still = await pictureFrame(input, o.width, o.height);
    const count = Math.round((o.duration ?? 1) * o.fps);
    for (let n = 0; n < count; n++) yield { ...still, time: (o.start ?? 0) + n / o.fps };
    return;
  }
  yield* readFrames(input, { width: o.width, height: o.height, fps: o.fps, start: o.start, duration: o.duration });
}


// The frames of a transition: the end of `first` (from `head` seconds on) blending into the start of `second`,
// over `duration` seconds. Both clips are read at exactly width x height and fps.
export async function* transitionFrames(
  shader: any,
  first: string,
  second: string,
  size: { width: number; height: number; fps: number },
  head: number,
  duration: number,
): AsyncGenerator<Buffer> {
  const tail = clipFrames(first, { ...size, start: head, duration });
  const start = clipFrames(second, { ...size, duration });
  const count = Math.max(1, Math.round(duration * size.fps));
  let from: Frame | undefined;
  let to: Frame | undefined;
  for (let n = 0; n < count; n++) {
    const nextFrom = await tail.next();
    const nextTo = await start.next();
    if (!nextFrom.done) from = nextFrom.value;
    if (!nextTo.done) to = nextTo.value;
    if (!from || !to) break;
    yield transitionFrame(shader, from.pixels, to.pixels, size.width, size.height, (n + 0.5) / count);
  }
  while (!(await tail.next()).done); // let both readers finish
  while (!(await start.next()).done);
}

// ---------- Commands ----------

// Apply effects to a picture or video. A picture with a video output becomes a clip of `duration` seconds
// (particles over a photo). The sound of a video is kept.
export async function apply(input: string, output: string, options: { effects: string[]; set?: string; amount?: number; lut?: string; duration?: number }) {
  requireFile(input);
  const steps = prepareEffects(options.effects, parseSet(options.set), options.lut);
  const amount = options.amount ?? 1;
  const toPicture = PICTURE_FILE.test(output);
  if (PICTURE_FILE.test(input) && toPicture) {
    const { pixels, width, height } = await pictureFrame(input);
    const result = effectFrame(pixels, width, height, steps, { time: 0, progress: 0, amount });
    await savePicture(need("sharp")(result, { raw: { width, height, channels: 4 } }), output);
    return { effects: options.effects };
  }
  let width: number, height: number, fps: number, duration: number, audio: string | undefined;
  if (PICTURE_FILE.test(input)) {
    const still = await pictureFrame(input);
    [width, height, fps, duration] = [even(still.width), even(still.height), 30, options.duration ?? 5];
  } else {
    const details = video.info(input);
    [width, height, fps, duration] = [even(details.width), even(details.height), details.fps || 30, details.duration];
    if (details.hasAudio) audio = input;
  }
  const writer = writeVideo(output, { width, height, fps, audio });
  let frames = 0;
  for await (const frame of clipFrames(input, { width, height, fps, duration: PICTURE_FILE.test(input) ? duration : undefined })) {
    await writer.write(effectFrame(frame.pixels, width, height, steps, { time: frame.time, progress: Math.min(1, frame.time / duration), amount }));
    frames++;
  }
  await writer.finish();
  return { effects: options.effects, frames };
}

// Join two clips with a transition: the end of the first blends into the start of the second over `duration` seconds.
// Pictures count as stills of duration + 1 seconds. The sound crossfades too.
export async function transition(first: string, second: string, output: string, name: string, options: { duration?: number; set?: string } = {}) {
  requireFile(first);
  requireFile(second);
  const shader = prepareTransition(name, parseSet(options.set));
  const wanted = options.duration ?? 1;
  const describe = async (file: string) => {
    if (PICTURE_FILE.test(file)) {
      const still = await pictureFrame(file);
      return { width: still.width, height: still.height, fps: 0, length: wanted + 1, hasAudio: false };
    }
    const d = video.info(file);
    return { width: d.width, height: d.height, fps: d.fps, length: d.duration, hasAudio: d.hasAudio };
  };
  const a = await describe(first);
  const b = await describe(second);
  const [width, height] = [even(a.width), even(a.height)];
  const fps = a.fps || b.fps || 30;
  const duration = Math.min(wanted, a.length, b.length);
  const head = a.length - duration;

  return withTempDir(async (folder) => {
    // The sound: a crossfade (silence stands in for a clip without sound).
    let audio: string | undefined;
    if (a.hasAudio || b.hasAudio) {
      audio = join(folder, "sound.wav");
      const source = (file: string, has: boolean, length: number) => (has ? ["-i", file] : ["-f", "lavfi", "-t", String(length), "-i", "anullsrc=r=48000:cl=stereo"]);
      ffmpeg([...source(first, a.hasAudio, a.length), ...source(second, b.hasAudio, b.length), "-filter_complex",
        `[0:a]aresample=48000[a];[1:a]aresample=48000[b];[a][b]acrossfade=d=${duration}`, audio]);
    }
    const writer = writeVideo(output, { width, height, fps, audio });
    const size = { width, height, fps };
    // 1. The first clip until the transition starts.
    if (head > 0) for await (const frame of clipFrames(first, { ...size, duration: head })) await writer.write(frame.pixels);
    // 2. The overlap: both clips at once.
    for await (const pixels of transitionFrames(shader, first, second, size, head, duration)) await writer.write(pixels);
    // 3. The rest of the second clip.
    for await (const frame of clipFrames(second, { ...size, start: duration, duration: b.length - duration })) await writer.write(frame.pixels);
    await writer.finish();
    return { transition: name, duration, length: round(a.length + b.length - duration, 2) };
  });
}

// One picture showing every effect (or every transition halfway) on a test card or your own picture.
export async function gallery(output: string, options: { kind?: string; input?: string } = {}) {
  const kind = options.kind ?? "effects";
  if (kind !== "effects" && kind !== "transitions") throw new Error('--kind is "effects" or "transitions".');
  const [width, height] = [320, 180];
  const card = (variant: number) => {
    const { source } = effectSource(TEST_CARD, { variant }, false);
    return effectFrame(Buffer.alloc(width * height * 4), width, height, [{ name: "card", shader: compile(source), mixes: false, pictures: {} }], { time: 0, progress: 0 });
  };
  let first: Buffer;
  if (!options.input) first = card(0);
  else if (PICTURE_FILE.test(requireFile(options.input))) first = (await pictureFrame(options.input, width, height)).pixels;
  else first = (await clipFrames(options.input, { width, height, fps: 1, start: video.info(options.input).duration / 2, duration: 1 }).next()).value!.pixels;
  const tiles: Tile[] = [];
  if (kind === "effects") {
    for (const name of Object.keys(EFFECTS)) {
      tiles.push({ pixels: effectFrame(first, width, height, prepareEffects([name]), { time: 1.5, progress: 0.5 }), width, height, label: name });
    }
  } else {
    const second = card(1);
    for (const name of allTransitions().keys()) {
      tiles.push({ pixels: transitionFrame(prepareTransition(name), first, second, width, height, 0.5), width, height, label: name });
    }
  }
  await board(tiles, kind === "effects" ? 6 : 8, output, kind === "effects" ? "fx effects (at 1.5 s)" : "fx transitions (halfway)");
  return { kind, count: tiles.length };
}

// Show effects live in a window (Esc or closing the window stops). Videos loop. seconds: close after this long.
export async function preview(input: string, options: { effects?: string[]; set?: string; amount?: number; lut?: string; seconds?: number } = {}) {
  requireFile(input);
  const steps = options.effects?.length ? prepareEffects(options.effects, parseSet(options.set), options.lut) : [];
  const picture = PICTURE_FILE.test(input);
  const details = picture ? { ...(await pictureFrame(input)), fps: 30, duration: 3600 } : video.info(input);
  const scale = Math.min(1, 1280 / details.width, 720 / details.height);
  const [width, height] = [even(details.width * scale), even(details.height * scale)];
  const fps = details.fps || 30;
  const gpu = engine();
  const { source } = effectSource(`vec4 effect(vec2 uv) { return pixel(vec2(uv.x, 1.0 - uv.y)); }`, {}, false); // the screen is upside down
  const show = compile(source);
  gpu.SetWindowSize(width, height);
  gpu.SetWindowTitle(`joEdit fx: ${basename(input)}${steps.length ? `  [${options.effects!.join(", ")}]` : ""}  (Esc closes)`);
  gpu.ClearWindowState(0x80);
  gpu.SetTargetFPS(Math.round(fps));
  const started = performance.now();
  const over = () => gpu.WindowShouldClose() || (options.seconds !== undefined && (performance.now() - started) / 1000 >= options.seconds);
  let shown = 0;
  while (!over()) {
    for await (const frame of clipFrames(input, { width, height, fps, duration: picture ? (options.seconds ?? 3600) : undefined })) {
      if (over()) break;
      const frameTime = picture ? (performance.now() - started) / 1000 : frame.time;
      const result = steps.length ? runEffects(frame.pixels, width, height, steps, { time: frameTime, progress: frameTime / details.duration, amount: options.amount }) : null;
      const texture = result ? result.texture : upload("source", frame.pixels, width, height);
      gpu.BeginDrawing();
      gpu.BeginShaderMode(show);
      gpu.SetShaderValue(show, location(show, "resolution"), new Float32Array([gpu.GetRenderWidth(), gpu.GetRenderHeight()]), 1);
      gpu.SetShaderValueTexture(show, location(show, "source"), texture);
      gpu.DrawRectangle(0, 0, gpu.GetScreenWidth(), gpu.GetScreenHeight(), { r: 255, g: 255, b: 255, a: 255 });
      gpu.EndShaderMode();
      gpu.EndDrawing();
      shown++;
    }
  }
  gpu.SetWindowState(0x80); // hide the window again
  return { shown, seconds: round((performance.now() - started) / 1000, 1) };
}

// Everything fx can do, for agents to choose from.
export function list() {
  const describe = (e: Effect) => {
    const settings = Object.entries(e.settings ?? {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(" ") : v}`).join(", ");
    return settings ? `${e.does} (${settings})` : e.does;
  };
  const group = (kind: Effect["kind"]) => Object.fromEntries(Object.entries(EFFECTS).filter(([, e]) => e.kind === kind).map(([n, e]) => [n, describe(e)]));
  const transitions: Record<string, string> = {};
  for (const [name, t] of allTransitions()) {
    transitions[name] = Object.entries(t.settings).map(([k, s]) => `${k}=${Array.isArray(s.value) ? s.value.join(" ") : s.value}`).join(", ");
  }
  return {
    looks: group("look"),
    color: group("color"),
    distort: group("distort"),
    particles: group("particles"),
    lut: "lut: a .cube color look, --effect lut --lut look.cube",
    yourOwn:
      "a .glsl file defining vec4 effect(vec2 uv) (uv 0..1, top-left 0,0). Use pixel(uv), time, progress, amount, resolution, ratio, random, noise, luma, mirrored, blurred(uv, px), edges(uv). Example: vec4 effect(vec2 uv) { vec4 c = pixel(uv); return vec4(c.rgb * (0.8 + 0.2 * sin(time * 6.0)), c.a); }",
    transitions,
    count: { effects: Object.keys(EFFECTS).length + 1, transitions: allTransitions().size },
  };
}

const effectList = (text?: string) => (text ? text.split(",").map((e) => e.trim()).filter(Boolean) : []);

export const commands: Record<string, Command> = {
  list: {
    usage: "list  (every effect, particle and transition, with its settings)",
    run: () => list(),
  },
  apply: {
    usage: 'apply <picture|video> <output> --effect bloom,grain|my.glsl [--set "strength=1.5,bloom.radius=20"] [--amount 1] [--lut look.cube] [--duration 5]  (picture in + video out: a clip of --duration s)',
    run: (a) =>
      apply(requireFile(a.positional[0]), a.positional[1] ?? "", {
        effects: effectList(stringFlag(a, "effect")),
        set: a.flags.set,
        amount: optionalNumberFlag(a, "amount", 1),
        lut: a.flags.lut,
        duration: optionalNumberFlag(a, "duration", 5),
      }),
  },
  transition: {
    usage: 'transition <first> <second> <output> --name fade|cross-zoom|whip-left|... [--duration 1] [--set "k=v"]  (pictures count as stills)',
    run: (a) => {
      if (!a.positional[2]) throw new Error("Give two clips and an output: transition a.mp4 b.mp4 out.mp4 --name fade");
      return transition(a.positional[0], a.positional[1], a.positional[2], stringFlag(a, "name"), { duration: optionalNumberFlag(a, "duration", 1), set: a.flags.set });
    },
  },
  gallery: {
    usage: "gallery <output.png> [--kind effects|transitions] [--input picture|video]  (every effect or transition in one picture)",
    run: (a) => gallery(a.positional[0] ?? "", { kind: a.flags.kind, input: a.flags.input }),
  },
  preview: {
    usage: 'preview <picture|video> [--effect crt] [--set "k=v"] [--amount 1] [--lut look.cube] [--seconds N]  (live window for a person to watch; Esc closes)',
    run: (a) =>
      preview(requireFile(a.positional[0]), {
        effects: effectList(a.flags.effect),
        set: a.flags.set,
        amount: optionalNumberFlag(a, "amount", 1),
        lut: a.flags.lut,
        seconds: a.flags.seconds === undefined ? undefined : optionalNumberFlag(a, "seconds", 0),
      }),
  },
};

// Only run the CLI when this file is executed directly (not when imported).
if (import.meta.main) {
  runCli("joEdit fx: node fx.ts <command> ...", commands, process.argv.slice(2));
}

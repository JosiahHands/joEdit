# Claude
## Overview
In this project (joEdit) we are creating a library that allows AI to easily edit videos, pictures and sound through the command line. lib/ will have all the source code.
Vision: anyone with an AI CLI subscription installs joEdit, tells their agent to read AGENTS.md, and makes studio-quality media. No API keys: the agent is the AI, joEdit is its studio (eyes, ears, hands).
Local only: nothing goes online at runtime. Required libraries and software are vendored in lib/libs (npm libraries pinned in libs/package.json, raylib 6.2 for macOS/Windows x64/Linux x64+arm64, fonts).
Universal: every change must work on macOS, Windows and Linux (Windows: `where`, `tar`, `npx.cmd`, `C:` paths, GL via wglGetProcAddress, CUDA torch in packs). JSON is read with shared readJson (strips a BOM). Optional pieces (AI models, assets, Python packs) are downloaded only by an explicit `node joedit.ts install <name>`.
* AGENTS.md is the one doc agents read: how the library works and every command. It should enable agents, not restrict them.
* joedit.ts is the single entry point (`node joedit.ts <area> <command>`), plus the top-level commands doctor, check, packs and install.
* picture.ts edits pictures with sharp and Skia (text, compose, fit, batch), plus AI generate (image pack), upscale (upscaler asset), cutout and depth (Node models), parallax (GPU shader via fx.ts).
* video.ts and sound.ts use the bundled FFmpeg 8 (node-av); sound mixing, effects and sound design run on Web Audio (node-web-audio-api). Video also has fade, reverse, stabilize, overlay, captions, remove-fillers, blur-faces, reframe --follow and generate (videogen pack, big GPU, not tested here).
* look.ts and listen.ts let the agent see and hear results: sheets, objects, faces, read, track, index, find (vision/sounds models), transcribe (whisper, also straight to .srt/.vtt), subtitles, speakers. AI models run in Node (Transformers.js / onnxruntime) from .models/.
* fx.ts runs GLSL on the GPU through raylib (koffi, hidden window): 41 effects, particles, own .glsl, .cube LUTs, gl-transitions plus own transitions, gallery and a live preview.
* graphics.ts draws titles, lower thirds, counters, captions and `canvas` (agent-written draw modules) with Skia. Chrome (optional) is only for HTML pages: render and still (DevTools protocol, virtual clock).
* movie.ts renders a movie.json (scenes incl. canvas, ffmpeg and GPU transitions, text, layers with keyframes/blend/tracking, fx, audio mix with ducking, sfx, voiceover, music, captions with speaker colors, look, beatSync). Scene speed and reframe "follow", film-level layers. Scenes are cached in .joedit-cache/ next to the movie file, and so is the finished picture (a sound-only change just remixes and muxes); --draft renders at 1/3 size; --sheet writes a contact sheet; the result's check marks held stills and silence that were designed as expected. Templates live in TEMPLATES.
* voice.ts speaks text (kokoro model, or macOS say), clones voices with required --consent (clone pack: Chatterbox), and splits stems (stems pack: Demucs). Movies use it for "voiceover".
* music.ts composes score JSON → MIDI (own writer) → spessasynth with the instruments asset (GeneralUser GS); parts with fx (amps, EQ, reverb), double or the Karplus-Strong "pluck" render as stems. It generates songs with the song pack (ACE-Step 1.5). Movies use it for "music".
* 3d.ts renders Python scene scripts with headless Blender: packs/blender/run.py and packs/blender/kit.py. Plus title and turntable. Not a uv pack.
* shared.ts holds the plumbing used by all files: bundled ffmpeg, probe, frame I/O (readFrames/writeVideo), Skia text, the model/asset/pack installers, and the brand kit (brand.json).
* Structure rule: one file per CLI area, no extra modularity. Optimize for the AI making the fastest and best edits.

lib/ is a fully self-contained library (own package.json, tsconfig.json, .gitignore, LICENSE: GPL-3.0-or-later). It must never import from outside lib/.
Setup: `cd lib && npm install` (installs @types/node, then the pinned libraries into lib/libs).
Run a tool: `node lib/joedit.ts <area> <command> ...` (Node 24+ runs .ts directly, no build step).
Type-check: `cd lib && npx -y -p typescript@5.9.3 tsc -p .`
Run tests: `node --test test.ts` (tests that need a model, pack, asset, Chrome, Blender or raylib are skipped when it is missing).
Roadmap: ~/.claude/plans/i-have-vision-to-zazzy-leaf.md (joEdit 2.1: the Windows report's fixes, universal release).
Every command must stay reachable through joedit.ts (a test checks this).
runCli refuses flags that are not in a command's usage string, so every flag a command reads must appear in its usage. Commands whose usage has `<output…>` get folder creation, safe in-place edits and a `made` summary automatically.
---
The 3 top layer files are for development.
## Core Rules
1. Rely on my explicit instructions and expect semi script prompting.
2. Always write simple and clear code that is easy to understand.
3. Always tell me what you did clearly and concisely.

# Claude
## Overview
In this project (joEdit) we are creating a library that allows AI to easily edit videos, pictures and sound through the command line. lib/ will have all the source code.
Vision: anyone with an AI CLI subscription installs joEdit, tells their agent to read AGENTS.md, and makes studio-quality media. No API keys: the agent is the AI, joEdit is its studio (eyes, ears, hands). Heavy AI runs locally as optional packs.
* AGENTS.md is the one doc agents read: how the library works and every command. It should enable agents, not restrict them.
* joedit.ts is the single entry point (`node joedit.ts <area> <command>`), plus the top-level commands doctor and check.
* picture.ts, video.ts, sound.ts edit pictures (ImageMagick `magick`), video and sound (`ffmpeg` / `ffprobe`). Picture also has AI generate (image pack: Z-Image Turbo), upscale (upscaler asset: Real-ESRGAN), cutout, depth and parallax (WebGL page rendered by graphics.ts); video has reframe --follow (cutout masks) and generate (videogen pack: Wan 2.2, big GPU, not tested here).
* look.ts and listen.ts let the agent see and hear results (contact sheets, waveforms, loudness, silences, beats, transcripts, search by meaning with the vision pack, palettes).
* graphics.ts renders HTML pages to video/PNG through headless Chrome (DevTools protocol, virtual clock), plus templates (title, lower-third, counter) and the caption overlays used by `video captions`. This ffmpeg has no drawtext/libass, so all text art goes through Chrome.
* movie.ts renders a movie.json (scenes, transitions, text, audio mix with ducking, sfx, captions, look, beatSync) into a film. Scenes are cached in .joedit-cache/ next to the movie file; --draft renders at 1/3 size. Templates live in TEMPLATES.
* voice.ts speaks text (tts pack: Kokoro, or macOS say), clones voices with required --consent (clone pack: Chatterbox, watermarked, consent record saved), and splits stems (stems pack: Demucs). Movies use it for "voiceover".
* music.ts composes score JSON → MIDI (own writer) → fluidsynth with the instruments asset (GeneralUser GS), and generates songs with the song pack (ACE-Step 1.5). Movies use it for "music".
* 3d.ts renders Python scene scripts with headless Blender: packs/blender/run.py (bootstrap: default stage, runs the script, renders PNG frames) and packs/blender/kit.py (shapes, text3d, load, material, lights, camera, orbit, keyframe). Plus title and turntable. Not a uv pack (no pyproject.toml).
* shared.ts holds the plumbing used by all files, including the pack system (packs/<name>/ = pyproject.toml + run.py, installed by `uv` into .packs/), downloadable assets (.assets/: fonts, browser) and the brand kit (brand.json).
* Structure rule: one file per CLI area, no extra modularity. Optimize for the AI making the fastest and best edits.

lib/ is a fully self-contained library (own package.json, tsconfig.json, .gitignore). It must never import from outside lib/.
Setup: `cd lib && npm install` (only installs @types/node for editor type checking).
Run a tool: `node lib/joedit.ts <area> <command> ...` (Node 24+ runs .ts directly, no build step).
Run tests: `node --test test.ts` (tests that need a pack, an asset or Chrome are skipped when it is missing).
Roadmap: ~/.claude/plans/i-have-vision-to-zazzy-leaf.md (Phase 1 done: eyes, ears & one CLI. Phase 2 done: graphics, captions, looks, sound effects. Phase 3 done: movie.json, remove-silence, reframe, pip, interpolate, animate. Phase 4 done: voice. Phase 5 done: music. Phase 6 done: generate, upscale, cutout, depth, parallax, look find/colors, reframe --follow, video generate. Phase 7 done: 3d (Blender) and the three asset).
Every command must stay reachable through joedit.ts (a test checks this).
runCli refuses flags that are not in a command's usage string, so every flag a command reads must appear in its usage. Commands whose usage has `<output…>` get folder creation, safe in-place edits and a `made` summary automatically.
---
The 3 top layer files are for development.
## Core Rules
1. Rely on my explicit instructions and expect semi script prompting.
2. Always write simple and clear code that is easy to understand.
3. Always tell me what you did clearly and concisely.
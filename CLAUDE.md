# Claude
## Overview
In this project (joEdit) we are creating a library that allows AI to easily edit videos, pictures and sound through the command line. lib/ will have all the source code.
Vision: anyone with an AI CLI subscription installs joEdit, tells their agent to read AGENTS.md, and makes studio-quality media. No API keys: the agent is the AI, joEdit is its studio (eyes, ears, hands). Heavy AI runs locally as optional packs.
* AGENTS.md is the one doc agents read: how the library works and every command. It should enable agents, not restrict them.
* joedit.ts is the single entry point (`node joedit.ts <area> <command>`), plus the top-level commands doctor and check.
* picture.ts, video.ts, sound.ts edit pictures (ImageMagick `magick`), video and sound (`ffmpeg` / `ffprobe`).
* look.ts and listen.ts let the agent see and hear results (contact sheets, waveforms, loudness, silences, beats, transcripts).
* shared.ts holds the plumbing used by all files, including the pack system (packs/<name>/ = pyproject.toml + run.py, installed by `uv` into .packs/).
* Structure rule: one file per CLI area, no extra modularity. Optimize for the AI making the fastest and best edits.

lib/ is a fully self-contained library (own package.json, tsconfig.json, .gitignore). It must never import from outside lib/.
Setup: `cd lib && npm install` (only installs @types/node for editor type checking).
Run a tool: `node lib/joedit.ts <area> <command> ...` (Node 24+ runs .ts directly, no build step).
Run tests: `node --test test.ts` (the transcribe test is skipped unless `node lib/joedit.ts install whisper` was run).
Roadmap: ~/.claude/plans/i-have-vision-to-zazzy-leaf.md (Phase 1 done: eyes, ears & one CLI).
---
The 3 top layer files are for development.
## Core Rules
1. Rely on my explicit instructions and expect semi script prompting.
2. Always write simple and clear code that is easy to understand.
3. Always tell me what you did clearly and concisely.
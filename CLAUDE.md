# Claude
## Overview
In this project (joEdit) we are creating a library that allows AI to easily edit videos, pictures and sound through the command line. lib/ will have all the source code. 
* AGENTS.md tells the AI how to interact with the library and perform editing tasks.
* picture.ts contains the code for editing pictures (uses ImageMagick `magick`).
* video.ts contains the code for editing videos (uses `ffmpeg` / `ffprobe`).
* sound.ts contains the code for editing music and sound (uses `ffmpeg` / `ffprobe`).
* shared.ts contains code that is shared between picture.ts, video.ts and sound.ts.

lib/ is a fully self-contained library (own package.json, tsconfig.json, .gitignore). It must never import from outside lib/.
Setup: `cd lib && npm install` (only installs @types/node for editor type checking).
Run a tool: `node lib/<picture|video|sound>.ts <command> ...` (Node 24+ runs .ts directly, no build step).
Run tests: `node --test test.ts`
---
The 3 top layer files are for development.
## Core Rules
1. Rely on my explicit instructions and expect semi script prompting.
2. Always write simple and clear code that is easy to understand.
3. Always tell me what you did clearly and concisely.
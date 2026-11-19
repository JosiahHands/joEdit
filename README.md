# joEdit

A studio for AI agents: edit pictures, video and sound, and let the agent see and hear its own work. Everything runs on your computer. No API keys needed, just your AI CLI subscription.

## Install

```bash
npx degit JosiahHands/joEdit/lib joEdit && cd joEdit && npm install && node joedit.ts doctor
```

This copies only the `lib/` folder into `joEdit/`, then `doctor` lists anything still missing. You need Node.js 24+, ffmpeg and ImageMagick (on macOS: `brew install ffmpeg imagemagick`).

## Use

Tell your agent: **"Read joEdit/AGENTS.md, then …"** and describe the video, picture or sound you want.

```bash
node joedit.ts video trim clip.mp4 short.mp4 --start 2 --end 8
node joedit.ts look sheet short.mp4 sheet.png
node joedit.ts listen beats song.mp3
```

For every command, see [lib/AGENTS.md](lib/AGENTS.md).

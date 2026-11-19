# joEdit

A studio for AI agents: edit pictures, video and sound, make motion graphics and animated captions, and let the agent see and hear its own work. Everything runs on your computer. No API keys needed, just your AI CLI subscription.

- **Edit:** trim, join, resize, color grades, film effects, sound mixing, ducking, denoising.
- **Create:** HTML → video motion graphics, titles, lower-thirds, karaoke captions, sound effects.
- **See & hear:** contact sheets, waveforms, loudness, beats, transcripts, and a one-command quality `check`.

## Install

```bash
npx degit JosiahHands/joEdit/lib joEdit && cd joEdit && npm install && node joedit.ts doctor
```

This copies only the `lib/` folder into `joEdit/`, then `doctor` lists anything still missing. You need Node.js 24+, ffmpeg and ImageMagick (on macOS: `brew install ffmpeg imagemagick`). Graphics and captions use Google Chrome, or run `node joedit.ts install browser`.

## Use

Tell your agent: **"Read joEdit/AGENTS.md, then …"** and describe the video, picture or sound you want.

```bash
node joedit.ts video trim clip.mp4 short.mp4 --start 2 --end 8
node joedit.ts look sheet short.mp4 sheet.png
node joedit.ts listen beats song.mp3
node joedit.ts video captions talk.mp4 captioned.mp4 --style karaoke
node joedit.ts graphics title intro.mp4 --text "Hello"
```

For every command, see [lib/AGENTS.md](lib/AGENTS.md).

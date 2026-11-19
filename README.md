# joEdit

A studio for AI agents: edit pictures, video and sound, make motion graphics and animated captions, and let the agent see and hear its own work. Everything runs on your computer. No API keys needed, just your AI CLI subscription.

- **Films from one JSON file:** scenes, transitions, titles, music that ducks under speech, sound effects, captions and a color look, with cached scenes and fast drafts.
- **Edit:** trim, join, jump cuts, reframe for phones, picture-in-picture, color grades, film effects, sound mixing, denoising.
- **Create:** HTML → video motion graphics, titles, lower-thirds, karaoke captions, sound effects.
- **Voice:** natural text-to-speech, consent-based voice cloning, and splitting songs into vocals/drums/bass (open models, run locally).
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
node joedit.ts movie render movie.json film.mp4 --draft
```

For every command, see [lib/AGENTS.md](lib/AGENTS.md).

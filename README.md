# joEdit

Command-line tools that let AI edit pictures, videos and sound. Built on ImageMagick and ffmpeg. Needs Node.js 24+.

## Install

```bash
npx degit JosiahHands/joEdit/lib joEdit && cd joEdit && npm install
```

This copies only the `lib/` folder into `joEdit/`.

You also need ImageMagick and ffmpeg. On macOS: `brew install imagemagick ffmpeg`.

## Use

```bash
node video.ts info clip.mp4
node picture.ts resize photo.jpg small.jpg --width 800
node sound.ts fade song.mp3 song-faded.mp3 --in 2 --out 3
```

For the full command list, see [lib/AGENTS.md](lib/AGENTS.md).

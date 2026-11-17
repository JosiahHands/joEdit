# joEdit: Guide for AI Agents

Use these command-line tools to edit pictures, videos, and sound. Each tool is one file that you run with Node.js (v24 or newer). The tools need no npm packages.

```
node picture.ts <command> <input> <output> [--flags]
node video.ts   <command> <input> <output> [--flags]
node sound.ts   <command> <input> <output> [--flags]
```

These commands are written as if you are inside this folder. From anywhere else, put the folder's path in front, for example `node joEdit/video.ts info clip.mp4`.

**Requirements:** `magick` (ImageMagick 7) for pictures, and `ffmpeg` + `ffprobe` for video and sound. Running `npm install` in this folder only adds type definitions so code editors show no errors.

## Rules
- **Never overwrite the input.** Always write to a new output file.
- **Output format comes from the output file's extension** (`.png`, `.jpg`, `.mp4`, `.webm`, `.gif`, `.mp3`, `.wav`, ...).
- **Run `info` first** to learn the size, duration, or audio details before editing.
- **Chain edits through temporary files:** `a.mp4 → step1.mp4 → step2.mp4 → final.mp4`.
- **Times are in seconds** (decimals are allowed, e.g. `1.5`). **Positions are in pixels** from the top-left corner.
- **Exit code 0** means success. **Exit code 1** means an error: a message starting with `Error:` and the correct usage line are printed to stderr.
- Run a tool with no command (or `help`) to list all its commands.

## Pictures: `node picture.ts`

| Command | Usage | Notes |
|---|---|---|
| info | `info <in>` | Prints JSON `{width, height, format}` |
| resize | `resize <in> <out> [--width N] [--height N]` | Give only one value to keep the aspect ratio |
| crop | `crop <in> <out> --x N --y N --width N --height N` | |
| rotate | `rotate <in> <out> --degrees N` | Clockwise, any angle |
| flip | `flip <in> <out> --direction horizontal\|vertical` | |
| grayscale | `grayscale <in> <out>` | |
| brightness | `brightness <in> <out> --amount -100..100` | |
| contrast | `contrast <in> <out> --amount -100..100` | |
| blur | `blur <in> <out> --radius N` | Bigger means more blur |
| text | `text <in> <out> --text "words" [--x N] [--y N] [--size N] [--color name]` | Defaults: x=10, y=10, size=32, color white |
| convert | `convert <in> <out> [--quality 1..100]` | Example: `.png` → `.jpg` |

## Videos: `node video.ts`

| Command | Usage | Notes |
|---|---|---|
| info | `info <in>` | Prints JSON `{duration, width, height, fps, hasAudio}` |
| trim | `trim <in> <out> --start S --end S` | |
| resize | `resize <in> <out> [--width N] [--height N]` | Give only one value to keep the aspect ratio |
| crop | `crop <in> <out> --x N --y N --width N --height N` | |
| rotate | `rotate <in> <out> --degrees 90\|180\|270` | Clockwise |
| flip | `flip <in> <out> --direction horizontal\|vertical` | |
| speed | `speed <in> <out> --factor 0.5..100` | 2 = twice as fast. The sound is sped up as well |
| mute | `mute <in> <out>` | Removes the sound |
| extract-audio | `extract-audio <in> <out.mp3>` | Fails if the video has no sound |
| add-audio | `add-audio <in> <out> --audio FILE` | Replaces the sound. Output stops at the shorter of the two |
| concat | `concat <in1> <in2> [...] <out>` | Scales every clip to the first clip's size. Sound is kept only if every input has sound |
| frame | `frame <in> <out.png> --time S` | Saves one still picture |
| gif | `gif <in> <out.gif> [--fps N] [--width N]` | Defaults: fps=10, width=480 |
| text | `text <in> <out> --text "words" [--x N] [--y N] [--size N] [--color name]` | Shows on the whole video |
| convert | `convert <in> <out>` | Example: `.mov` → `.mp4` |

## Sound and music: `node sound.ts`

Works on audio files. Commands that read sound also accept a video file and use its sound.

| Command | Usage | Notes |
|---|---|---|
| info | `info <in>` | Prints JSON `{duration, sampleRate, channels, codec}` |
| trim | `trim <in> <out> --start S --end S` | |
| volume | `volume <in> <out> --factor N` | 2 = louder, 0.5 = quieter, 0 = silent |
| fade | `fade <in> <out> [--in S] [--out S]` | Fades in at the start and/or out at the end |
| speed | `speed <in> <out> --factor 0.5..100` | Pitch stays the same |
| pitch | `pitch <in> <out> --semitones -12..12` | Length stays the same. 12 = one octave up |
| reverse | `reverse <in> <out>` | Plays backwards |
| normalize | `normalize <in> <out>` | Evens out the loudness to a standard level |
| loop | `loop <in> <out> --times N` | Plays the sound N times in a row |
| concat | `concat <in1> <in2> [...] <out>` | One after another. Inputs can be in different formats |
| mix | `mix <in1> <in2> [...] <out>` | All at the same time (for example voice over music). Lasts as long as the longest input |
| tone | `tone <out> [--frequency HZ] [--duration S]` | Makes a beep. Defaults: 440 Hz for 1 s |
| convert | `convert <in> <out>` | Example: `.wav` → `.mp3` |

## Examples

Make a 5-second clip from 0:10 of a video, 720 px wide, with a title:
```
node video.ts trim input.mp4 tmp1.mp4 --start 10 --end 15
node video.ts resize tmp1.mp4 tmp2.mp4 --width 720
node video.ts text tmp2.mp4 final.mp4 --text "My Trip" --x 20 --y 20 --size 48
```

Put background music under a video:
```
node video.ts extract-audio clip.mp4 voice.mp3
node sound.ts volume music.mp3 quiet-music.mp3 --factor 0.3
node sound.ts mix voice.mp3 quiet-music.mp3 mixed.mp3
node sound.ts fade mixed.mp3 final-audio.mp3 --out 2
node video.ts add-audio clip.mp4 final.mp4 --audio final-audio.mp3
```

Make a thumbnail from a video:
```
node video.ts frame input.mp4 frame.png --time 3
node picture.ts resize frame.png thumb.jpg --width 320
```

## Use as a library (TypeScript)
Every command is also an exported function with the same name (`extract-audio` → `extractAudio`, `add-audio` → `addAudio`):
```ts
import { trim, info } from "./joEdit/video.ts";
import { fade } from "./joEdit/sound.ts";
trim("in.mp4", "out.mp4", 1, 4);
fade("song.mp3", "song-faded.mp3", 2, 3);
console.log(info("out.mp4"));
```
Functions throw an `Error` on failure.

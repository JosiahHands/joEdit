# joEdit: Guide for AI Agents

joEdit is a toolkit for editing pictures, video and sound, and for **seeing and hearing the results**. It runs entirely on this computer: no API keys, no cost per edit. Use it however suits the job: one command at a time, chained in a script, or imported as TypeScript functions. When joEdit doesn't do something, `ffmpeg`, `ffprobe` and `magick` are installed too, so call them directly or extend joEdit.

```
node joedit.ts <area> <command> ...      areas: picture, video, sound, look, listen
node joedit.ts                           prints every command
node joedit.ts doctor                    shows what this computer has installed
```
Paths here are written as if you are in this folder. From elsewhere, use `node joEdit/joedit.ts ...`.

## How it works
- **Output:** every command prints one line of JSON, e.g. `{"ok":true,"output":"out.mp4"}`, often with extra facts (times, sizes, scores). Errors exit with code 1 and print `Error: ...` and the correct usage to stderr.
- **Files:** each edit reads an input and writes a new output file. The output's extension picks the format (`.mp4 .webm .gif .png .jpg .mp3 .wav`, …).
- **Units:** times are in seconds (`1.5`). Positions are in pixels from the top-left corner.
- **Setup:** `doctor` lists installed tools and gives the install command for anything missing. Optional AI **packs** (open models that run locally) are installed with `install <pack>`.

## Seeing and hearing your work
You can't watch video or hear sound directly, so `look` and `listen` turn them into pictures and text you can read:
- `look sheet` makes a contact sheet of a whole video in one PNG. Reading it is the quickest way to know what a video contains or whether an edit worked.
- `look strip` zooms in on a moment, such as a cut or a transition.
- `listen wave`, `listen loudness`, `listen silences` and `listen beats` describe sound as images and numbers.
- `listen transcribe` turns speech into words with timestamps, so you can find and cut by what is said.
- `check <file>` is a quick quality report: black or frozen picture, long silence, too quiet or too loud. Each problem comes with a suggested fix command.

Looking at results between steps catches most mistakes early. How often you look is up to you.

## Commands
`<in>` is an input file and `<out>` is a new output file.

**picture** (ImageMagick)
```
info <in>                                   → width, height, format
resize <in> <out> [--width N] [--height N]  give one value to keep the shape
crop <in> <out> --x N --y N --width N --height N
rotate <in> <out> --degrees N               clockwise, any angle
flip <in> <out> --direction horizontal|vertical
grayscale | brightness --amount -100..100 | contrast --amount -100..100 | blur --radius N   (all: <in> <out>)
text <in> <out> --text "words" [--x 10] [--y 10] [--size 32] [--color white]
convert <in> <out> [--quality 1..100]       e.g. .png → .jpg
```

**video** (ffmpeg)
```
info <in>                                   → duration, width, height, fps, hasAudio
trim <in> <out> --start S --end S
resize | crop | flip                        same flags as picture
rotate <in> <out> --degrees 90|180|270
speed <in> <out> --factor 0.5..100          2 = twice as fast (sound too)
mute <in> <out>                             remove the sound
extract-audio <in> <out.mp3>
add-audio <in> <out> --audio FILE           replaces the sound; stops at the shorter one
concat <in1> <in2> [...] <out>              one after another, sized to the first clip
frame <in> <out.png> --time S               one still picture
gif <in> <out.gif> [--fps 10] [--width 480]
text <in> <out> --text "words" [--x] [--y] [--size] [--color]   on the whole video
convert <in> <out>
```

**sound** (ffmpeg; also reads the sound of video files)
```
info <in>                                   → duration, sampleRate, channels, codec
trim <in> <out> --start S --end S
volume <in> <out> --factor N                2 = louder, 0.5 = quieter
fade <in> <out> [--in S] [--out S]
speed <in> <out> --factor 0.5..100          pitch stays the same
pitch <in> <out> --semitones -12..12        length stays the same
reverse | normalize | convert               (all: <in> <out>) normalize = -14 LUFS, the online standard
loop <in> <out> --times N
concat <in1> <in2> [...] <out>              one after another
mix <in1> <in2> [...] <out>                 at the same time (e.g. voice over music)
tone <out> [--frequency 440] [--duration 1]
```

**look**: pictures of video, to read
```
sheet <video> <out.png> [--count 12]        frames from the whole video, labelled with times
strip <video> <out.png> --start S --end S [--count 8]   close-up of one moment
scenes <video> [--threshold 0.3]            → times of shot changes (0.1 sensitive … 0.6 hard cuts only)
compare <pic1> <pic2> <out.png>             → difference 0..1, plus a picture marking differences in red
```

**listen**: sound as numbers, text and pictures
```
wave <sound> <out.png>                      waveform with a time ruler (tall = loud, flat = silent)
spectrum <sound> <out.png>                  spectrogram (pitch over time)
loudness <sound>                            → lufs, peak, verdict, suggested fixes
silences <sound> [--db -35] [--min 0.5]     → silent parts (start, end)
beats <sound>                               → bpm and the time of every beat
transcribe <sound> <out.json> [--model base] [--language en]   → every word with its time (whisper pack)
```

**top level**
```
doctor                                      installed tools, machine, packs
check <file>                                quality report with fix commands
packs                                       available AI packs and whether they are installed
install <pack>                              e.g. install whisper (needs uv)
```

## Examples
Ideas for combining commands, not fixed recipes.

**Tighten a talk by removing a long pause**
```
node joedit.ts listen silences talk.mp4 --min 1.5      → silence 12.4–15.9
node joedit.ts video trim talk.mp4 a.mp4 --start 0 --end 12.4
node joedit.ts video trim talk.mp4 b.mp4 --start 15.9 --end 60
node joedit.ts video concat a.mp4 b.mp4 tight.mp4
node joedit.ts look strip tight.mp4 cut.png --start 11.5 --end 13.5
```

**Cut a montage to the music**
```
node joedit.ts listen beats song.mp3                   → bpm 120, beats [0.5, 1.0, 1.5, ...]
(trim clips to lengths that match the beat spacing)
node joedit.ts video concat c1.mp4 c2.mp4 c3.mp4 montage.mp4
node joedit.ts video add-audio montage.mp4 final.mp4 --audio song.mp3
node joedit.ts look sheet final.mp4 sheet.png
```

**Music under a voice**
```
node joedit.ts video extract-audio clip.mp4 voice.wav
node joedit.ts sound volume music.mp3 quiet.mp3 --factor 0.25
node joedit.ts sound mix voice.wav quiet.mp3 mixed.wav
node joedit.ts sound normalize mixed.wav level.wav
node joedit.ts video add-audio clip.mp4 final.mp4 --audio level.wav
```

**Find a moment by what is said**
```
node joedit.ts install whisper
node joedit.ts listen transcribe interview.mp4 words.json
(find the phrase in words.json, then trim from its first word's start to its last word's end)
```

## Use from code
Every command is also an exported TypeScript function (`extract-audio` → `extractAudio`). Functions throw an `Error` on failure. Good for loops and bigger jobs.
```ts
import { trim } from "./joEdit/video.ts";
import { sheet } from "./joEdit/look.ts";
import { check } from "./joEdit/joedit.ts";
trim("in.mp4", "out.mp4", 1, 4);
sheet("out.mp4", "sheet.png");
console.log(check("out.mp4"));
```

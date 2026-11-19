# joEdit: Guide for AI Agents

joEdit is a toolkit for editing pictures, video and sound, making motion graphics, and **seeing and hearing the results**. It runs entirely on this computer: no API keys, no cost per edit. Use it however suits the job: one command at a time, chained in a script, or imported as TypeScript functions. When joEdit doesn't do something, `ffmpeg`, `ffprobe` and `magick` are installed too, so call them directly or extend joEdit.

```
node joedit.ts <area> <command> ...      areas: picture, video, sound, look, listen, graphics
node joedit.ts                           prints every command
node joedit.ts doctor                    shows what this computer has installed
```
Paths here are written as if you are in this folder. From elsewhere, use `node joEdit/joedit.ts ...`.

## How it works
- **Output:** every command prints one line of JSON, e.g. `{"ok":true,"output":"out.mp4"}`, often with extra facts (times, sizes, scores). Errors exit with code 1 and print `Error: ...` and the correct usage to stderr.
- **Files:** each edit reads an input and writes a new output file. The output's extension picks the format (`.mp4 .webm .gif .png .jpg .mp3 .wav`, …).
- **Units:** times are in seconds (`1.5`). Positions are in pixels from the top-left corner.
- **Setup:** `doctor` lists installed tools and gives the install command for anything missing. Optional AI **packs** (open models that run locally) and **assets** (fonts, a headless browser) are installed with `install <name>`.
- **Brand:** commands with `--brand brand.json` (titles, captions, templates) take their colors and fonts from that file. Any part can be left out and gets a default:
  `{"colors": {"background": "#0B0B0F", "text": "#FFFFFF", "primary": "#7C5CFF", "accent": "#FFD166"}, "fonts": {"heading": "Montserrat", "body": "Inter"}}`

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
grade | effects                             same looks and effects as video (below)
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
grade <in> <out> --look cinematic|teal-orange|noir|vintage|warm|cool|bleach|vivid [--strength 0..1]
effects <in> <out> [--grain 0..1] [--vignette 0..1] [--letterbox 2.39] [--glow 0..1] [--chromatic PX] [--sharpen 0..1]
captions <in> <out> [--transcript words.json] [--style karaoke|pop|bold|minimal] [--position bottom|center|top] [--brand brand.json]
```
`captions` makes its own transcript (whisper pack) when none is given. A transcript is any JSON with `{"words": [{"word", "start", "end"}]}`, so you can fix spellings in it, or write one by hand, before burning it in. Styles: `karaoke` lights each word as it is spoken, `pop` grows the spoken word, `bold` is big uppercase lines, `minimal` is plain subtitles.

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
sfx <out.wav> --type whoosh|swoosh|hit|boom|riser|pop|click|typewriter|ding|glitch [--duration S]
duck <music> <voice> <out> [--amount 8]     music turns down whenever the voice speaks
denoise <in> <out> [--amount 20]            removes steady hiss/hum/fan; measures the noise itself
eq <in> <out> [--bass DB] [--treble DB]     e.g. --bass 4 --treble -2
```
Sound effects are made from scratch (no downloads) and all peak at the same level. Ideas: `whoosh`/`swoosh` on transitions, `hit`/`boom` on a title landing, `riser` before a reveal, `pop`/`click` when captions or icons appear. Place them with `video add-audio`, `sound mix`, or a bit of ffmpeg `adelay`.

**graphics**: motion graphics from HTML, rendered frame by frame in headless Chrome
```
render <page.html> <out.mp4|.mov|.webm|.gif> --duration S [--width 1920] [--height 1080] [--fps 30] [--transparent] [--data file.json] [--audio sound]
still <page.html> <out.png> --time S [--width] [--height] [--transparent] [--data file.json]
title <out.mp4|.png> --text "Big title" [--subtitle "..."] [--duration 4] [--brand brand.json] [--transparent]
lower-third <out.mov|.png> --text "Name" [--subtitle "Role"] [--duration 5] [--brand brand.json]   see-through, for overlays
counter <out.mp4|.png> --to N [--from 0] [--text "label"] [--prefix "$"] [--suffix "%"] [--duration 3]
```
Anything a web page can draw can become video: CSS animations and transitions, the Web Animations API, SVG, canvas, WebGL, and GSAP if the page includes it. The page runs on a **virtual clock**: for every frame the time is set exactly, so renders are smooth and identical every time, however slow the page is. What the page can use:
- `window.joedit` = `{time, fps, duration, width, height, data, audio}`. `data` is the `--data` JSON (text, numbers, lists to animate). `audio` (with `--audio`) is `{bpm, beats: [seconds], levels: [0..1 per frame]}`, for visuals that pulse with music. The sound is also put into the video.
- `window.joedit.render = (time) => { ... }` is called on every frame, for canvas and WebGL drawing.
- Fonts: Inter, Montserrat, Bebas Neue, Playfair Display and JetBrains Mono are available by name once `install fonts` has run.
- `--transparent` with a `.mov` (ProRes 4444) or `.webm` output keeps a see-through background, ready to lay over video (`ffmpeg ... overlay`).
- `still` at a few times is a fast way to check a design before rendering the whole thing.

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
packs                                       available AI packs and assets, and whether they are installed
install <name>                              a pack (e.g. whisper, needs uv) or an asset (fonts, browser)
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
node joedit.ts sound denoise voice.wav clean.wav
node joedit.ts sound duck music.mp3 clean.wav mixed.wav
node joedit.ts sound normalize mixed.wav level.wav
node joedit.ts video add-audio clip.mp4 final.mp4 --audio level.wav
```

**Social clip with captions and a film look**
```
node joedit.ts video captions talk.mp4 captioned.mp4 --style karaoke
node joedit.ts video grade captioned.mp4 graded.mp4 --look teal-orange --strength 0.7
node joedit.ts video effects graded.mp4 final.mp4 --grain 0.2 --vignette 0.4
node joedit.ts look sheet final.mp4 sheet.png
```

**Intro title with a sound hit**
```
node joedit.ts graphics title intro.mp4 --text "Summer Trip" --subtitle "2026" --brand brand.json
node joedit.ts sound sfx hit.wav --type boom
node joedit.ts video add-audio intro.mp4 intro-sound.mp4 --audio hit.wav
node joedit.ts video concat intro-sound.mp4 trip.mp4 film.mp4
```

**Your own animated graphic**
```
(write chart.html: bars that grow with CSS animations, values from window.joedit.data)
node joedit.ts graphics still chart.html check.png --time 1.5 --data numbers.json
node joedit.ts graphics render chart.html chart.mp4 --duration 4 --data numbers.json
```

**Name tag over an interview**
```
node joedit.ts video info interview.mp4               → width 1280, height 720
node joedit.ts graphics lower-third tag.mov --text "Ada Lovelace" --subtitle "Engineer" --width 1280 --height 720
ffmpeg -i interview.mp4 -itsoffset 2 -i tag.mov -filter_complex "[0:v][1:v]overlay=eof_action=pass" -c:a copy tagged.mp4
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

# joEdit: Guide for AI Agents

joEdit is a toolkit for editing pictures, video and sound, making motion graphics, and **seeing and hearing the results**. It runs entirely on this computer: no API keys, no cost per edit. Use it however suits the job: one command at a time, chained in a script, or imported as TypeScript functions. When joEdit doesn't do something, `ffmpeg`, `ffprobe` and `magick` are installed too, so call them directly or extend joEdit.

```
node joedit.ts <area> <command> ...      areas: picture, video, sound, look, listen, graphics, movie, voice
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
animate <in> <out.mp4> [--duration 5] [--motion zoom-in|zoom-out|pan-left|pan-right|pan-up|pan-down|none] [--amount 0.15] [--width 1920] [--height 1080]
                                            slow camera move over a still ("Ken Burns")
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
remove-silence <in> <out> [--min 0.6] [--db -35] [--pad 0.1]   automatic jump cuts: removes every pause longer than --min
reframe <in> <out> --aspect 9:16|1:1|4:5|16:9 [--x 0..1] [--y 0..1]   crop to a new shape; --x 0 = keep left, 1 = keep right
pip <main> <small> <out> [--corner bottom-right] [--size 0.3]   picture-in-picture (sound from main)
interpolate <in> <out> [--fps 60]           invents in-between frames: smoother motion, or slow motion with `speed`
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

**voice**: speech, voice cloning and stems (AI packs that run on this computer)
```
speak <out.wav> --text "..." [--file script.txt] [--voice af_heart] [--speed 1] [--words words.json] [--engine kokoro|say]
voices                                      → Kokoro voices (with descriptions) and the macOS say voices
clone <out.wav> --sample voice.wav --text "..." --consent "who agreed, and when" [--emotion 0.5] [--pace 0.5]
stems <music> <folder> [--only vocals|drums|bass|other]   → vocals.wav drums.wav bass.wav other.wav
```
- `speak` uses Kokoro (`install tts`): natural voices in American and British English, plus Spanish, French, Hindi, Italian and Portuguese. Good picks: `af_heart` (warm), `am_michael` (warm male), `bm_george` (classic narrator), `af_bella` (lively). `--words` saves the time of every word, ready for `video captions --transcript`. `--engine say` uses the built-in macOS voices and needs no pack.
- `clone` (`install clone`, Chatterbox) speaks new words in the voice of a 5–20 second sample. It needs `--consent` with a sentence about whose voice it is and that they agreed; that statement is saved in `<out>.consent.txt` (with a fingerprint of the sample) and in the file's metadata, and the speech carries Chatterbox's inaudible watermark. `--emotion` 0.25 (calm) … 1 (very expressive).
- `stems` (`install stems`, Demucs) splits any song or video sound. `--only vocals` gives `vocals.wav` and `without-vocals.wav`: voice isolation from noisy footage, karaoke backing tracks, remixes, or ducking a song's music under new speech.

**movie**: a whole film from one JSON file
```
render <movie.json> <out.mp4> [--draft]     → duration, scenes rendered/cached, time taken, and a quality check
validate <movie.json>                       → every problem, each with a hint to fix it
templates                                   → starting points: short, ad, explainer, slideshow, lyric, podcast
template <name> <movie.json>                writes one; replace its placeholder files (validate lists them)
```
A movie file describes the film; joEdit does the cutting, transitions, text, sound mix, captions and look. Each scene is cached in `.joedit-cache/` next to the movie file, so after changing one scene only that scene renders again. `--draft` renders at a third of the size, quickly, for checking timing and layout before the final render. Paths are relative to the movie file.
```json
{
  "size": "1920x1080",                     // or "1080x1920" (phone), "1080x1080" (square). Default 1920x1080
  "fps": 30,
  "brand": "brand.json",                   // colors and fonts for titles, text and captions
  "look": "cinematic", "lookStrength": 0.8, // color grade for the whole film (see video grade)
  "effects": {"grain": 0.2, "vignette": 0.3},  // see video effects
  "scenes": [
    {"title": "Big title", "subtitle": "small line", "duration": 3},
    {"video": "clip.mp4", "from": 2, "to": 8, "volume": 1, "fit": "cover"},
    {"image": "photo.jpg", "motion": "zoom-in", "duration": 4, "transition": "fade"},
    {"html": "chart.html", "data": {"values": [1, 2]}, "duration": 5, "transition": {"type": "slideleft", "duration": 0.6}},
    {"color": "#000000", "duration": 1},
    {"video": "b.mp4", "look": "noir", "text": [
      {"text": "Ada Lovelace", "subtitle": "Engineer", "at": 0.5, "duration": 3},
      {"text": "Chapter 2", "style": "title", "at": 4}]}
  ],
  "audio": [
    {"file": "voice.wav", "at": 0.5},
    {"file": "music.mp3", "volume": 0.5, "duck": true, "loop": true, "fadeIn": 1, "fadeOut": 2, "from": 10}
  ],
  "sfx": [{"type": "whoosh", "at": 2.9}, {"type": "boom", "at": 0, "volume": 1}],
  "voiceover": {"text": "Every great film starts with a voice.", "voice": "am_michael", "at": 0.5},   // tts pack
  "captions": {"style": "karaoke", "position": "bottom"},   // or {"transcript": "words.json"}; true = defaults
  "beatSync": "music.mp3",                 // move every cut to the nearest beat
  "notes": "free text for yourself"
}
```
(Comments above are explanations; JSON itself has no comments.)
- **Scenes** are one of `title`, `video`, `image`, `html` (any page you write, rendered like `graphics render`) or `color`. Non-video scenes last 3 seconds unless `duration` is given. Video scenes use `from`/`to` (or `duration`) and `fit`: `cover` fills the frame and crops the edges, `contain` shows the whole clip on a blurred copy of itself (good for wide clips in a phone video).
- **Transitions** belong to the scene they lead into: `fade`, `fadeblack`, `fadewhite`, `dissolve`, `wipeleft/right/up/down`, `slideleft/right/up/down`, `smoothleft/right/up/down`, `circleopen`, `circleclose`, `radial`, `pixelize`, `zoomin`, `hblur`, `squeezeh`, `coverleft`, `revealright` and more (`validate` lists them all). Each transition overlaps the two scenes, so the film gets shorter by its duration.
- **Sound:** scene sound, `audio` tracks and `sfx` are mixed together and set to -14 LUFS. Tracks with `"duck": true` go quiet whenever the other sound (speech) is loud. `at` is seconds from the start of the film.
- **Voice-over** is spoken with Kokoro, mixed in like an audio track (music with `duck` goes quiet under it), and cached.
- **Captions** use the transcript if given, else the voice-over's own word times, else they transcribe the final mix (whisper pack).
- After rendering, the result includes `check` (black frames, silence, loudness) and `warnings`, e.g. a voice-over longer than the film. An intended black ending shows up in `check`, which is fine.

**top level**
```
doctor                                      installed tools, machine, packs
check <file>                                quality report with fix commands
packs                                       available AI packs and assets, and whether they are installed
install <name>                              a pack (needs uv) or an asset (fonts, browser)
```
Packs: `whisper` (speech to text), `tts` (speak), `clone` (voice cloning), `stems` (music separation). Each installs once (a few minutes, mostly downloading) and then runs offline; the first use of each also downloads its model.

## Examples
Ideas for combining commands, not fixed recipes.

**Tighten a talk**
```
node joedit.ts video remove-silence talk.mp4 tight.mp4 --min 0.6     (every pause at once)
or by hand, for one pause:
node joedit.ts listen silences talk.mp4 --min 1.5      → silence 12.4–15.9
node joedit.ts video trim talk.mp4 a.mp4 --start 0 --end 12.4
node joedit.ts video trim talk.mp4 b.mp4 --start 15.9 --end 60
node joedit.ts video concat a.mp4 b.mp4 tight.mp4
node joedit.ts look strip tight.mp4 cut.png --start 11.5 --end 13.5
```

**A finished film from a template**
```
node joedit.ts movie template short movie.json
(edit movie.json: your clips, words and music)
node joedit.ts movie validate movie.json
node joedit.ts movie render movie.json draft.mp4 --draft
node joedit.ts look sheet draft.mp4 sheet.png
(adjust, then the full render reuses every unchanged scene)
node joedit.ts movie render movie.json final.mp4
```

**Narrated explainer, no microphone**
```
node joedit.ts voice speak narration.wav --file script.txt --voice bm_george --words words.json
node joedit.ts sound duck music.mp3 narration.wav mix.wav
node joedit.ts video add-audio visuals.mp4 narrated.mp4 --audio mix.wav
node joedit.ts video captions narrated.mp4 final.mp4 --transcript words.json --style minimal
```
(or put `"voiceover"` in a movie file, which does all of this)

**Clean up speech recorded in a noisy place**
```
node joedit.ts voice stems street-interview.mp4 parts --only vocals
node joedit.ts sound denoise parts/vocals.wav clean.wav
node joedit.ts video add-audio street-interview.mp4 fixed.mp4 --audio clean.wav
```

**Podcast to phone clip**
```
node joedit.ts video trim podcast.mp4 part.mp4 --start 754 --end 812
node joedit.ts video remove-silence part.mp4 tight.mp4
node joedit.ts video reframe tight.mp4 tall.mp4 --aspect 9:16 --x 0.3      (keep the speaker on the left)
node joedit.ts video captions tall.mp4 final.mp4 --style karaoke
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

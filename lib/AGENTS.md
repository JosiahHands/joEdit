# joEdit: Guide for AI Agents

joEdit is a studio for editing pictures, video and sound, making motion graphics and films, and **seeing and hearing the results**. Everything runs on this computer: no API keys, no cost per edit, no internet needed. Use it however suits the job: one command at a time, chained in a script, or imported as TypeScript functions. When joEdit has no command for something, run its own ffmpeg directly (`doctor` shows its path) or extend joEdit.

```
node joedit.ts <area> <command> ...      areas: picture, video, sound, look, listen, graphics, fx, movie, voice, music, 3d
node joedit.ts                           prints every command
node joedit.ts doctor                    shows what this computer has and how to add what is missing
```
Paths here are written as if you are in this folder. From elsewhere, use `node joEdit/joedit.ts ...`.

The folders follow who calls whom, top to bottom:
```
joedit.ts        every command starts here, and passes it to its area
areas/           one file per area (picture.ts, video.ts, music.ts …); movie.ts combines the others into films
core/shared.ts   what every area uses: ffmpeg, frames, text, installs, hardware, pack workers, jobs
packs/           the Python side of the AI packs (run by shared.ts as workers; joedit_pack.py is their plumbing)
libs/            the bundled libraries (npm packages, raylib, fonts)
```
To change how a command works, edit its area file; to change something every area shares, edit core/shared.ts.

## How it works
- **Output:** every command prints one line of JSON, often with extra facts (times, sizes, scores). Commands that make a file also describe it under `made`, e.g. `{"ok":true,"output":"out.mp4","made":{"duration":8,"width":1920,"height":1080,"hasAudio":true,"size":"4.1 MB"}}`, so you know what came out without another command. Errors exit with code 1 and print `Error: ...` and the correct usage to stderr.
- **Files:** each edit reads an input and writes an output file. The output's extension picks the format (`.mp4 .mov .webm .gif .png .jpg .webp .mp3 .wav`, …). Missing folders in the output path are created. The output can be the input itself (`video trim a.mp4 a.mp4 ...`): the edit is made safely on a copy that then replaces it.
- **Flags:** `--width 100` or `--width=100`. A flag a command doesn't have is refused with the closest match ("Did you mean --strength?"), so a typo never passes silently. `<area> <command> --help` prints that command's usage; a command in the wrong area says where it lives.
- **Colour:** video is made in BT.709, the HD standard, and tagged as such, so colours stay the same through any number of edits and look right in players and editors.
- **Units:** times are in seconds (`1.5`). Positions are in pixels from the top-left corner (movie layers use fractions of the frame, so drafts and finals match).
- **Engines:** joEdit brings its own FFmpeg 8, sharp (pictures), Skia (text and drawing), Web Audio (mixing and sound design), raylib (GPU effects), AI models that run in Node, fonts and Three.js. `npm install` in this folder is the whole setup.
- **Adding more:** `packs` lists the optional extras and `install <name>` adds one; it is the only time joEdit downloads anything. Once installed, everything runs offline. Install an extra when a task needs it:
  - **AI models** (run in Node): `whisper` (speech to text; `whisper-tiny/small/turbo` for other speeds), `kokoro` (voices), `cutout`, `depth`, `vision` (search pictures by meaning), `objects`, `faces`, `read` (text in pictures), `sounds` (search sounds by meaning), `speakers` (who speaks when).
  - **Assets**: `instruments` (sounds for music compose), `upscaler` (Real-ESRGAN), `interpolator` (RIFE, AI in-between frames), `browser` (a headless Chrome, only if Chrome is not installed and you render HTML pages).
  - **Packs** (Python, need `uv`): `image` (picture generate), `song` (AI songs), `clone` (voice cloning), `stems` (split music), `videogen` (video generate, 8 GB+ GPU).
- **Packs stay loaded:** the first command that uses a pack loads its models, then the pack keeps them for 10 minutes (2 when they hold over 40% of the RAM or of the GPU's memory), so the next song, picture or cloned line starts at once. Only one pack holds the GPU at a time; asking for another pack frees it. Results include `seconds` (the work), `loadSeconds` (when it had to load), `ramGb` and `vramGb` (GPU memory; on Apple Silicon the most seen while it worked). While a pack works, progress and the time left are printed to stderr. `jobs stop` frees the memory now.
- **Background:** add `--background` to any command to get `{"job": id}` back at once and keep working; `jobs wait <id>` returns the command's normal result when it is done, `jobs list` shows every job with its progress, `jobs cancel <id>` stops one. Long work (songs, video generate, movie render) can run while you write the next part.
  - **Programs**: Chrome (HTML pages), Blender (3d). `doctor` gives the install command.
- **Brand:** commands with `--brand brand.json` (titles, captions, templates, canvas, compose) take their colors and fonts from that file. Any part can be left out and gets a default:
  `{"colors": {"background": "#0B0B0F", "text": "#FFFFFF", "primary": "#7C5CFF", "accent": "#FFD166"}, "fonts": {"heading": "Montserrat", "body": "Inter"}}`
- **Fonts** usable by name everywhere: Inter, Montserrat, Bebas Neue, Playfair Display, JetBrains Mono.

## Seeing and hearing your work
You can't watch video or hear sound directly, so `look` and `listen` turn them into pictures and text you can read:
- `look sheet` makes a contact sheet of a whole video in one PNG. Reading it is the quickest way to know what a video contains or whether an edit worked.
- `look strip` zooms in on a moment, such as a cut or a transition.
- `look index` writes one JSON log of a whole folder of footage (lengths, cuts, colors, things, faces, text on screen, speech, sounds) so you know the material without opening each file.
- `listen wave`, `listen loudness`, `listen silences` and `listen beats` describe sound as images and numbers.
- `listen transcribe` turns speech into words with timestamps, so you can find and cut by what is said.
- `check <file>` is a quick quality report: black or frozen picture, long silence, too quiet or too loud. Each problem comes with a suggested fix command.

Looking at results between steps catches most mistakes early. How often you look is up to you.

## Windows, Linux and macOS
Everything works the same on all three; `doctor` shows what this computer has and the install command for anything missing, for this system.
- **Windows:** use `node joedit.ts ...` from PowerShell or cmd. Paths with `C:\`, spaces or quotes are fine. Python packs need `uv` (`winget install astral-sh.uv`) and use the NVIDIA GPU through CUDA when there is one. On GPUs under 20 GB, picture `generate` keeps the model in main memory and moves each layer onto the GPU while it runs. `song` uses ACE-Step's settings for the GPU's memory (what waits in main memory, which language model) and runs its language model on PyTorch. Both report `seconds` and `vramGb` (peak GPU memory). Blender and Chrome/Edge are found in their usual install folders. JSON files saved by Windows editors (with a byte-order mark) read fine.
- **Linux:** GPU effects (`fx`, transitions, `parallax`) need a display; on a server, run under `xvfb-run`.
- **Apple Silicon** runs packs and models on the Metal GPU.

## Commands
`<in>` is an input file and `<out>` is a new output file.

**picture** (sharp and Skia)
```
info <in>                                   → width, height, format
resize <in> <out> [--width N] [--height N]  give one value to keep the shape
crop <in> <out> --x N --y N --width N --height N
rotate <in> <out> --degrees N               clockwise, any angle
flip <in> <out> --direction horizontal|vertical
grayscale | brightness --amount -100..100 | contrast --amount -100..100 | blur --radius N   (all: <in> <out>)
text <in> <out> --text "words" [--x] [--y] [--size 32] [--color white] [--font Inter] [--weight 700] [--stroke black] [--stroke-width N]
     [--shadow N] [--box "#000000AA"] [--align left|center|right] [--max-width N]
fit <in> <out> [--aspect 9:16] [--width N] [--height N] [--focus smart|center|top|bottom|left|right]   crop to a shape, keeping what matters
compose <design.json> <out> [--brand brand.json]   a designed picture from layers (thumbnails, posters, slides)
batch <folder> <out-folder> [--width] [--height] [--aspect 1:1] [--format webp|jpg|png|avif] [--quality]
grade | effects                             same looks and effects as video (below)
animate <in> <out.mp4> [--duration 5] [--motion zoom-in|zoom-out|pan-left|pan-right|pan-up|pan-down|none] [--amount 0.15]   slow camera move over a still
convert <in> <out> [--quality 1..100]       e.g. .png → .jpg
generate <out.png> --prompt "..." [--width 1024] [--height 1024] [--seed N] [--steps 9]   new picture from a description
upscale <in> <out> [--scale 2|3|4] [--style photo|art]   bigger, with AI-restored detail
cutout <in> <out.png> [--mask]              remove the background (see-through PNG), or a white-on-black mask of the subject
depth <in> <out.png>                        depth map: near = white, far = black
parallax <in> <out.mp4> [--motion dolly|orbit|pan-left|pan-right|rise|fall] [--duration 5] [--amount 1] [--depth map.png]
                                            3D camera move inside a still photo, on the GPU: near things move more than far things
```
- `compose` draws a JSON design. Each layer is one of `image`, `text` or `color` (a rectangle), with `x`, `y`, `width`, `height`, `fit` (cover|contain|fill), `opacity`, `blend` (multiply, screen, overlay …), `rotate`, `radius` (rounded corners), `shadow`/`shadowColor`, and text styling (`size`, `font`, `weight`, `color`, `stroke`, `shadow`, `box`, `align`, `maxWidth`). Colors and fonts can be brand names (`"accent"`, `"heading"`):
  `{"width": 1280, "height": 720, "background": "photo.jpg", "layers": [{"color": "#00000088", "x": 0, "y": 560, "width": 1280, "height": 160}, {"text": "Big news", "x": 640, "y": 590, "size": 72, "align": "center", "font": "heading", "color": "accent"}, {"image": "logo.png", "x": 1140, "y": 30, "width": 110, "height": 110, "fit": "contain"}]}`
- On an `image` layer, `shadow`, `glow`/`glowColor` and `outline`/`outlineColor` (pixels) follow the picture's own shape, so a `cutout` gets a sticker edge or a halo: `{"image": "cut.png", "x": 250, "y": 60, "height": 500, "outline": 8, "glow": 30, "glowColor": "#00E0FF"}`.
- `fit --focus smart` keeps the most detailed, eye-catching part when changing shape.
- `generate` (`install image`, Z-Image Turbo) makes photoreal or illustrated pictures in seconds on Apple Silicon or an NVIDIA GPU. Describe the subject, setting, light, lens and style in plain words (`"studio portrait, soft window light, 85mm, film grain"`). The same `--seed` and prompt give the same picture, so you can change one word and compare. It renders short text in the picture well.
- `upscale` (`install upscaler`) restores detail when enlarging: old photos, small web pictures, generated pictures before printing. `--style art` is tuned for drawings, anime and graphics.
- `cutout` (`install cutout`) keeps hair and fine edges. Put the subject on a new background with `compose`, or use `--mask` to grade or blur only the subject or the background.
- `depth` (`install depth`) is the base for parallax, fake depth of field, fog, and near/far masks.
- `parallax` (`install depth`) brings a still to life far more than `animate`: a slow `dolly` push in, an `orbit` sway, or a sideways pan. `--amount` above 1 moves more but starts to stretch the edges of near objects; check a frame. `--depth` reuses a map you already made.

**video** (FFmpeg)
```
info <in>                                   → duration, width, height, fps, hasAudio
trim <in> <out> --start S --end S
resize | crop | flip                        same flags as picture
rotate <in> <out> --degrees 90|180|270
speed <in> <out> --factor 0.5..100          2 = twice as fast (sound too)
mute <in> <out>                             remove the sound
extract-audio <in> <out.mp3|.wav|.m4a>
add-audio <in> <out> --audio FILE           replaces the sound; stops at the shorter one
concat <in1> <in2> [...] <out>              one after another, at the first clip's size (other shapes get bars, never stretched)
fade <in> <out> [--in S] [--out S] [--color black|white]   picture and sound together
reverse <in> <out>                          plays backwards (any length)
stabilize <in> <out> [--strength 0..1] [--zoom 0.05]   calms shaky handheld video
overlay <in> <picture|video> <out> [--x 0..1] [--y 0..1] [--width 0..1] [--at S] [--duration S] [--opacity 0..1] [--fade S]
                                            a logo, watermark, sticker or second video on top; x/y = its centre
frame <in> <out.png> --time S               one still picture
gif <in> <out.gif> [--fps 10] [--width 480]
text <in> <out> --text "words" [same styling flags as picture text]   on the whole video
convert <in> <out>
grade <in> <out> --look cinematic|teal-orange|noir|vintage|warm|cool|bleach|vivid [--strength 0..1]
effects <in> <out> [--grain 0..1] [--vignette 0..1] [--letterbox 2.39] [--glow 0..1] [--chromatic PX] [--sharpen 0..1]
captions <in> <out> [--transcript words.json] [--style karaoke|pop|bold|minimal] [--position bottom|center|top] [--speakers] [--brand brand.json]
remove-silence <in> <out> [--min 0.6] [--db -35] [--pad 0.1]   automatic jump cuts: removes every pause longer than --min
remove-fillers <in> <out> [--transcript words.json] [--words um,uh,...] [--repeats true|false]   cuts um, uh and stutters
blur-faces <in> <out> [--every 0.2] [--strength 1] [--pad 0.3]   follows and blurs every face
reframe <in> <out> --aspect 9:16|1:1|4:5|16:9 [--x 0..1] [--y 0..1]   crop to a new shape; --x 0 = keep left, 1 = keep right
reframe <in> <out> --aspect 9:16 --follow [--smooth 2] [--every 0.5]   the crop follows the main subject as it moves
pip <main> <small> <out> [--corner bottom-right] [--size 0.3]   picture-in-picture (sound from main)
interpolate <in> <out> [--fps 60] [--method auto|ai|motion]   invents in-between frames: smoother motion, or slow motion with `speed`
upscale <in> <out> [--scale 2|3|4] [--width 1920] [--style photo|art|fast]   bigger, with AI-restored detail
generate <out.mp4> --prompt "..." [--image start.png] [--seconds 5] [--width 1280] [--height 720] [--seed N] [--upscale fast|photo|art|none]   AI video clip
```
- `captions` makes its own transcript (`install whisper`) when none is given. A transcript is any JSON with `{"words": [{"word", "start", "end"}]}`, so you can fix spellings in it, or write one by hand, before burning it in. Styles: `karaoke` lights each word as it is spoken, `pop` puts the spoken word on a colored tag, `bold` is big outlined capitals, `minimal` is plain subtitles on a dark box. `--speakers` gives each speaker their own color; use a transcript from `listen speakers` (its words carry a `speaker`).
- `remove-fillers` and `remove-silence` together make a talk tight in two commands.
- `overlay` takes a see-through PNG as it is, so a `picture cutout`, a `graphics lower-third --transparent` still or a logo all sit cleanly on the video. A video on top is silent; the main video's sound is kept.
- `concat` keeps the sound even when some clips have none (they get silence).
- `blur-faces` (`install faces`) is for privacy: bystanders, kids, people who did not agree to be shown.
- `reframe --follow` (`install cutout`) finds the subject every `--every` seconds and glides the crop along its path like a camera operator; `--smooth` is seconds of smoothing (bigger = calmer). The result includes the crop `path`. Where the subject is found is cached per clip (`.joedit-cache/follow/` next to it), so a second reframe of the same clip, or of part of it, takes a moment, and a longer range only looks at the times not seen yet. Each sample is one run of the cutout model (about 2 seconds on a laptop), so `--every 1` halves the time for slow-moving subjects. The subject is the cutout model's main subject; for another thing, use `look track` and steer the crop yourself.
- `generate` (`install videogen`, FastWan 2.2 TI2V-5B, ~24 GB of models) makes a clip from a description, or animates `--image`, in 3 steps. It runs on NVIDIA GPUs from 8 GB and on Apple Silicon: it picks a memory plan from the hardware (`--memory`: `full` 24 GB+, `gpu` 14–24 GB, `offload` 10–14 GB streams the model onto the GPU layer by layer, `small` under 10 GB uses 4-bit models; the result reports the plan as `memory`). Each plan renders as big as it does well (480p on small GPUs, `rendered` in the result), then the clip is upscaled to `--width`x`--height` (`--upscale fast` by default with `install upscaler`; `photo` is slower and sharper; `none` keeps the rendered size). Clips longer than 5 seconds are made in 5-second pieces, each continuing from the last frame of the one before with matched colours; `--prompt "a dog runs to the door | the door opens | it runs outside"` gives each piece its own direction. The same prompt again is quicker (it is remembered), so try several `--seed`s and keep the best. Describe motion and camera (`"slow push in"`, `"handheld follow"`), not only the scene. A subject that rushes into close-up can come back looking different, so keep it at a steady distance, or start the next piece from a picture of it (`--image`). Measured on an M5 Pro Mac with 24 GB: about 4 minutes for a 5 s 720p clip, 7 minutes for 8 s; run it with `--background` and keep working.
- `upscale` (`install upscaler`) works on any video: `photo` for real footage, `art` for drawn and animated, `fast` for a quick pass. `interpolate` uses AI (`install interpolator`, RIFE) when it is installed: smooth 24 → 60 fps, or slow motion when followed by `speed`; `--method motion` uses ffmpeg's motion interpolation instead.

**sound** (FFmpeg and Web Audio; also reads the sound of video files)
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
timeline <clips.json> <out> [--duck DB] [--length S]   a whole mix: clips placed in time, music ducked under voices
fx <in> <out> [--reverb room|studio|hall|plate|cathedral] [--mix 0..1] [--voice podcast|warm|radio|telephone|megaphone] [--pan -1..1] [--width 0..2]
design <script.js> <out> [--duration S]     your own sound, built from Web Audio nodes
tone <out> [--frequency 440] [--duration 1]
sfx <out.wav> --type whoosh|swoosh|hit|boom|riser|pop|click|typewriter|ding|glitch [--duration S]
duck <music> <voice> <out> [--amount 12]    music dips whenever the voice speaks
denoise <in> <out> [--amount 20]            removes steady hiss/hum/fan; measures the noise itself
eq <in> <out> [--bass DB] [--treble DB]     e.g. --bass 4 --treble -2
match <in> <out> --reference ref.wav [--strength 1]   EQ toward the bass/middle/treble balance of a reference track
```
- `match` measures both sounds per octave (`listen bands`), sets an equalizer (at most ±12 dB per band) that moves `<in>` toward the reference, and returns the balance before and after. `--strength 0.5` goes half way. A video keeps its picture.
- `timeline` takes a list of clips: `[{"file": "music.mp3", "role": "music", "loop": true, "fadeOut": 2}, {"file": "voice.wav", "at": 1.5, "reverb": "room"}, {"file": "whoosh.wav", "at": 3, "role": "effect", "pan": -0.5}]`. Keys: `file, at, from, to, volume, fadeIn, fadeOut, loop, pan, reverb, role` (`voice`, `music` or `effect`). Music dips a moment before anyone speaks and comes back after.
- `fx --voice` shapes speech: `podcast` (close and clear), `warm`, `radio`, `telephone`, `megaphone`. A video input keeps its picture.
- `design` runs your script with a Web Audio `OfflineAudioContext`: `export default ({ ctx, duration, noise }) => { const o = ctx.createOscillator(); o.frequency.setValueAtTime(80, 0); o.frequency.exponentialRampToValueAtTime(30, duration); o.connect(ctx.destination); o.start(0); }`. `noise(seconds, "white"|"pink"|"brown")` gives a noise buffer (wind, rain, rumble). Oscillators, filters, gains with automation, delays, convolvers and wave shapers all work: risers, drones, UI sounds, ambiences.
- Sound effects from `sfx` are made from scratch and all peak at the same level. Ideas: `whoosh`/`swoosh` on transitions, `hit`/`boom` on a title landing, `riser` before a reveal, `pop`/`click` when captions or icons appear.

**look**: pictures of video, to read
```
sheet <video> <out.png> [--count 12]        frames from the whole video, labelled with times
strip <video> <out.png> --start S --end S [--count 8]   close-up of one moment
scenes <video> [--threshold 0.3]            → times of shot changes (0.1 sensitive … 0.6 hard cuts only)
compare <pic1> <pic2> <out.png>             → difference 0..1, plus a picture marking differences in red
colors <picture|video> [--count 6] [--swatch out.png]   → main colors (hex) and their share of the picture
find <video|picture|folder> --query "a dog on a beach" [--top 5] [--every 1] [--sheet out.png]   search by meaning
objects <picture|video> [--what person,car] [--min 0.5] [--every 1] [--draw boxes.png]   80 kinds of things, with boxes
faces <picture|video> [--min 0.6] [--every 1] [--draw boxes.png]
read <picture|video> [--every 1] [--draw boxes.png]   the text in it (signs, slides, screens), with boxes and times
track <video> <track.json> [--what person|face|car|dog|...] [--every 0.2] [--draw track.png]   follow one thing through a video
index <folder> [--output index.json] [--every 2] [--only cuts,colors,things,faces,text,speech,sounds]   one JSON log of all the footage
```
- `find` (`install vision`) searches what footage shows, not what it is called: `"close-up of hands typing"`, `"crowd cheering"`, `"logo on a white background"`. Each match has the best `time` and the whole moment (`start`–`end`), ready for `video trim` or a movie scene's `from`/`to`. Scores only mean something relative to each other within one search. Frames are cached in `.joedit-cache/`, so further searches of the same footage take seconds.
- `objects` and `track` need `install objects` (`--what face` needs `install faces`); `read` needs `install read`. `objects` knows the 80 everyday COCO kinds (person, car, dog, cup, laptop …); for anything else (a guitar pick, a logo, a character) use `find` with words, or `video reframe --follow` for the main subject.
- `track` saves `{label, width, height, every, points: [{time, x, y, width, height}]}`: the main thing's box every `--every` seconds, smoothed. Use it in a movie layer's `track` to make text or a picture follow it, or to steer your own crops and effects.
- `index` uses whichever AI models are installed and skips files that have not changed since the last run. It prints progress per file to stderr. `--only` picks parts (e.g. `--only cuts,speech` for a quick pass). Each file gets `steady` moments (long stretches without change). Text that is only a letter or two is left out, and speech is only transcribed where there is sound that is speech or singing, so the log does not invent words.
- `colors` gives a palette to match titles, captions and brand colors to the footage.

**listen**: sound as numbers, text and pictures
```
wave <sound> <out.png>                      waveform with a time ruler (tall = loud, flat = silent)
spectrum <sound> <out.png>                  spectrogram (pitch over time)
loudness <sound>                            → lufs, peak, verdict, suggested fixes
silences <sound> [--db -35] [--min 0.5]     → silent parts (start, end)
beats <sound> [--beats-per-bar 4]          → bpm, the time of every beat, downbeats (beat 1 of each bar) and bars
bands <sound> [--reference ref.wav]         → bass/middle/treble balance per octave in dB; with a reference, the difference
energy <sound> [--every 0.1]                → loudness over time (full and low end) and the biggest jumps (drops, hits)
transcribe <sound> <out.json|.srt|.vtt> [--model tiny|base|small|turbo] [--language en]   → every word with its time
subtitles <words.json> <out.srt|.vtt> [--max-chars 42]   a subtitle file from a transcript
find <sound|video> --query "dog barking" [--top 5] [--window 4]   search sounds by meaning
speakers <sound> <out.json> [--transcript words.json] [--speakers N]   who speaks when
```
- `transcribe` needs `install whisper` (`whisper-small` or `whisper-turbo` for harder audio). The language is found automatically. A `.srt` or `.vtt` output is a subtitle file for YouTube, Vimeo, players and the web (burned-in captions are `video captions`). `subtitles` makes one from any words file, e.g. after you fix spellings, or from `voice speak --words`.
- `beats` finds the downbeat from where the low end (kick, bass) is strongest; music with a kick on every beat (four-on-the-floor, constant double kick) can fool it, so treat `downbeats` there as a best guess and check against `energy`.
- `bands` answers "why does this sound thin or muddy": compare a mix with a reference track you like, then fix with `sound eq`, `sound match` or a part's `fx.eq` in a score. `energy` shows where a song builds and drops, to cut picture to it.
- `find` (`install sounds`) works best with short labels: `"applause"`, `"glass breaking"`, `"siren"`, `"laughter"`.
- `speakers` (`install speakers`) saves the transcript with a `speaker` on every word and segment, plus how long each person talks: ready for `video captions --speakers`, or to cut to whoever is speaking.

**graphics**: titles, motion graphics and your own drawings
```
title <out.mp4|.png> --text "Big title" [--subtitle "..."] [--duration 4] [--brand brand.json] [--transparent]
lower-third <out.mov|.png> --text "Name" [--subtitle "Role"] [--duration 5] [--brand brand.json]   see-through, for overlays
counter <out.mp4|.png> --to N [--from 0] [--text "label"] [--prefix "$"] [--suffix "%"] [--duration 3]
canvas <draw.mjs> <out.mp4|.mov|.png> --duration S [--width 1920] [--height 1080] [--fps 30] [--transparent] [--data file.json] [--audio sound] [--time S]
render <page.html> <out.mp4|.mov|.webm|.gif> --duration S [--width] [--height] [--fps] [--transparent] [--data file.json] [--audio sound]
still <page.html> <out.png> --time S [--width] [--height] [--transparent] [--data file.json]
```
- `title`, `lower-third`, `counter` and `canvas` draw with Skia: fast, and no browser needed.
- `canvas` is for anything you can draw: charts, kinetic type, shapes, maps, generative art. Write a module that draws one frame; it is called for every frame with the time:
  ```js
  export default async function draw(ctx, t, info) {
    ctx.fillStyle = "#0B0B0F"; ctx.fillRect(0, 0, info.width, info.height);
    const grow = info.ease(info.clamp(t / 1.5));              // 0 → 1 over 1.5 s, gentle stop
    info.data.values.forEach((v, i) => { ctx.fillStyle = info.brand.colors.primary; ctx.fillRect(200 + i * 220, 900 - v * 50 * grow, 160, v * 50 * grow); });
    info.text(ctx, "Sales", info.width / 2, 80, { size: 96, font: "Bebas Neue", align: "center" });
  }
  ```
  `ctx` is a full Canvas 2D context (paths, gradients, `ctx.filter = "blur(8px)"`, `letterSpacing`, transforms, blend modes). `info` = `{width, height, fps, duration, frame, data, brand, audio, level, text(ctx, text, x, y, style), measure(ctx, text, style), ease(x), clamp(x), image(path)}`; `await info.image("logo.png")` loads a picture (cached). With `--audio`, `audio` is `{bpm, beats, levels}` and `level` is this frame's loudness 0..1, for visuals that pulse with music; the sound goes into the video. Errors point at your file and line.
- `render` and `still` turn an HTML page into video in headless Chrome (install Chrome, or `install browser`): CSS animations, SVG, WebGL, GSAP if the page includes it. The page runs on a **virtual clock**, so renders are smooth and identical every time. `window.joedit` = `{time, fps, duration, width, height, data, audio}`, and `window.joedit.render = (time) => {...}` is called every frame. The joEdit fonts are available by name.
  Real-time 3D in a page: copy Three.js next to it (`cp -r joEdit/libs/node_modules/three .`), then `<script type="importmap">{"imports": {"three": "./three/build/three.module.js", "three/addons/": "./three/examples/jsm/"}}</script>` and `import * as THREE from "three"` in a `<script type="module">`. Create the renderer with `preserveDrawingBuffer: true` and draw in `window.joedit.render`.
- `--transparent` with a `.mov` (ProRes 4444), `.webm` or `.png` output keeps a see-through background, ready to lay over video.
- A `.png` output (or `still`, or `canvas --time`) is a fast way to check a design before rendering the whole thing.

**fx**: GPU effects, particles and transitions (raylib)
```
list                                        every effect, particle and transition, with its settings
apply <picture|video> <out> --effect bloom,grain|my.glsl [--set "bloom.radius=20,strength=1.5"] [--amount 1] [--lut look.cube] [--duration 5]
transition <first> <second> <out> --name cross-zoom|whip-left|cube|... [--duration 1] [--set "k=v"]
gallery <out.png> [--kind effects|transitions] [--input picture|video]   every effect or transition in one picture, to choose from
preview <picture|video> [--effect crt] [--set] [--amount] [--lut] [--seconds N]   a live window for a person to watch (Esc closes)
```
- Effects: looks (`bloom dream grain film vignette blur sharpen chromatic glitch crt vhs scanlines pixelate posterize halftone sketch neon light-leak letterbox tilt-shift`), color (`grade duotone tint bw sepia invert thermal night-vision`), distort (`fisheye mirror kaleidoscope wave heat shake`) and particles (`snow rain confetti embers dust bokeh fireflies`). Chain them in order with commas. `--amount` mixes the result with the original (0..1).
- `--set` changes settings: `bloom.radius=20` for one effect, `strength=1.5` for every effect that has it. Values are numbers, `"0.2 0.4"` for vectors, or `#ff8800` for colors. `list` shows every setting and its default. On footage that is already bright (snow, sky, white walls), `bloom` and `light-leak` wash out quickly: lower `strength` or raise `bloom.threshold`, and check a frame.
- `--lut look.cube` with `--effect lut` applies any `.cube` color look (from a colorist, a camera maker or a grading app).
- A picture in and a video out makes a clip of `--duration` seconds: snow over a photo, light leaks over a title card.
- Your own effect is a `.glsl` file with `vec4 effect(vec2 uv)` (uv 0..1, top-left is 0,0). Ready to use: `pixel(uv)`, `time`, `progress` (0..1 through the clip), `amount`, `resolution`, `ratio`, `random`, `noise`, `luma`, `mirrored`, `blurred(uv, px)`, `edges(uv)`. Example: `vec4 effect(vec2 uv) { vec4 c = pixel(uv); return vec4(c.rgb * (0.8 + 0.2 * sin(time * 6.0)), c.a); }`. Errors come back with your file's line numbers.
- Transitions: 74, from gl-transitions (`cube`, `cross-zoom`, `dreamy`, `ripple`, `swirl`, `burn`, `doorway`, `page-curl` …) and joEdit's own (`whip-left/right/up/down`, `zoom`, `flash`, `blur`, `spin`, `light-leak`, `glitch`). `gallery --kind transitions` shows them all at their halfway point. The sound crossfades too.

**movie**: a whole film from one JSON file
```
render <movie.json> <out.mp4> [--draft] [--sheet sheet.png]   → duration, scenes rendered/cached, time taken, a quality check, and a contact sheet
validate <movie.json>                       → every problem, each with a hint to fix it
templates                                   → starting points: short, ad, explainer, slideshow, lyric, podcast
template <name> <movie.json>                writes one; replace its placeholder files (validate lists them)
```
A movie file describes the film; joEdit does the cutting, transitions, layers, effects, sound mix, captions and look. Scenes render several at a time and each is cached in `.joedit-cache/` next to the movie file, so after changing one scene only that scene renders again. The finished picture is cached too: changing only sound (music, audio tracks, sfx, volumes) mixes the sound again and reuses the picture, which takes seconds. The film is encoded at full quality once, at the end: scenes, effects and transitions are kept as near-lossless working copies (`.mkv`) until then, so nothing loses quality on the way. `--draft` renders at a third of the size, quickly, for checking timing and layout. Paths are relative to the movie file.
```json
{
  "size": "1920x1080",                     // or "1080x1920" (phone), "1080x1080" (square)
  "fps": 30,
  "brand": "brand.json",
  "look": "cinematic", "lookStrength": 0.8, // color grade for the whole film (see video grade)
  "effects": {"vignette": 0.3},             // see video effects
  "fx": {"effect": "grain", "set": {"grain.strength": 0.08}},   // GPU effects over the whole film
  "scenes": [
    {"title": "Big title", "subtitle": "small line", "duration": 3},
    {"video": "clip.mp4", "from": 2, "to": 8, "volume": 1, "fit": "cover", "transition": "cross-zoom"},
    {"video": "wide.mp4", "from": 0, "to": 4, "speed": 0.5, "reframe": "follow"},   // slow motion, crop follows the subject
    {"image": "photo.jpg", "motion": "parallax", "duration": 4, "transition": {"type": "fade", "duration": 0.8},
     "fx": {"effect": "bloom,light-leak", "keys": [{"time": 0, "amount": 0}, {"time": 2, "amount": 1}]}},
    {"canvas": "chart.mjs", "data": {"values": [3, 7, 12]}, "duration": 5},
    {"html": "page.html", "duration": 4},
    {"color": "#000000", "duration": 1},
    {"video": "interview.mp4", "look": "warm",
     "text": [{"text": "Ada Lovelace", "subtitle": "Engineer", "at": 0.5, "duration": 3}],
     "layers": [
       {"image": "logo.png", "x": 0.9, "y": 0.1, "width": 0.08, "opacity": 0.8},
       {"text": "Ada", "style": {"size": 64, "box": "#000000AA"}, "track": "ada-track.json"},
       {"video": "broll.mp4", "from": 3, "x": 0.8, "y": 0.75, "width": 0.3, "at": 2, "duration": 4, "fadeIn": 0.3,
        "keys": [{"time": 0, "scale": 0.8}, {"time": 0.5, "scale": 1}]},
       {"image": "flare.png", "width": 1, "blend": "screen", "keys": [{"time": 0, "x": 0.2}, {"time": 4, "x": 0.8}]}
     ]}
  ],
  "layers": [{"video": "hud.mov", "width": 1, "at": 2, "duration": 6}],   // over the whole film (times from the film's start)
  "audio": [{"file": "music.mp3", "volume": 0.5, "duck": true, "loop": true, "fadeIn": 1, "fadeOut": 2, "from": 10}],
  "sfx": [{"type": "whoosh", "at": 2.9}, {"type": "boom", "at": 0, "volume": 1}],
  "voiceover": {"text": "Every great film starts with a voice.", "voice": "am_michael", "at": 0.5, "reverb": "room"},
  "music": {"score": "score.json", "volume": 0.7},   // or {"song": {"prompt": "...", "duration": 60}} or {"file": "track.mp3"}
  "captions": {"style": "karaoke", "position": "bottom", "speakers": true},   // or {"transcript": "words.json"}; true = defaults
  "beatSync": true,                        // move every cut to the nearest beat of "music" (or give a sound file)
  "notes": "free text for yourself"
}
```
(Comments above are explanations; JSON itself has no comments.)
- **Scenes** are one of `title`, `video`, `image`, `canvas` (your draw module, like `graphics canvas`), `html` (a page, needs Chrome) or `color`. Non-video scenes last 3 seconds unless `duration` is given. Image `motion` is a flat move (`zoom-in` (default), `zoom-out`, `pan-left/right/up/down`, `none`) or a 3D one: `parallax` (a push in), `parallax-orbit`, `parallax-pan-left/right`, `parallax-rise/fall`. Video scenes use `from`/`to` (or `duration`) and `fit`: `cover` fills the frame and crops the edges, `contain` shows the whole clip on a blurred copy of itself. `speed` (0.1–10) plays a video scene faster or in slow motion (sound too); the scene lasts `(to - from) / speed`. `"reframe": "follow"` crops a clip of another shape to the movie's shape, following the subject (`install cutout`; the subject's path is cached per clip, like `video reframe --follow`).
- **Transitions** belong to the scene they lead into. Any fx transition works (`cube`, `cross-zoom`, `whip-left` …, with `"set"` for its settings), and so do ffmpeg's fast ones: `fade`, `fadeblack`, `fadewhite`, `dissolve`, `wipeleft/right/up/down`, `slideleft/right/up/down`, `smoothleft/right/up/down`, `circleopen`, `radial`, `pixelize`, `zoomin` and more (names that exist in both use ffmpeg's). Each transition overlaps the two scenes, so the film gets shorter by its duration.
- **Layers** go on top of a scene, in order: `image`, `video` (silent) or `text` (with `style`: `size` in pixels at full size, `font`, `weight`, `color`, `stroke`, `shadow`, `box`, `maxWidth`). Positions are fractions of the frame: `x`, `y` is the layer's centre (default 0.5, 0.5), `width` is a fraction of the frame width (default 0.3). Also `scale`, `rotate` (degrees), `opacity`, `blend` (`normal multiply screen overlay add darken lighten soft-light hard-light difference color-dodge color-burn …`), `at`/`duration` (seconds within the scene), `fadeIn`/`fadeOut`. `keys` animate `x, y, width, scale, rotate, opacity`: each key is `{"time": seconds from the layer's start, ...values}` and values glide smoothly between keys. `track` (a `look track` file of this scene's video) makes the layer follow that thing; `x`/`y` then become offsets and `anchor` (`top` (default), `center`, `bottom`) picks where it sits on the box. The movie's own `layers` work the same way but lie over the whole film, across cuts and transitions (a HUD, a logo bug, a frame), with `at` counted from the film's start; they have no `track`.
- **fx** (on a scene or the whole film): `"bloom,grain"` or `{"effect": "...", "set": {...}, "amount": 1, "lut": "look.cube", "keys": [{"time": 0, "amount": 0}, ...]}`. Your own `.glsl` files work here too.
- **Sound:** scene sound, `audio` tracks and `sfx` are mixed together and set to -14 LUFS. Tracks with `"duck": true` go quiet whenever the other sound (speech) is loud. Tracks also take `pan` and `reverb`. `at` is seconds from the start of the film.
- **Music** is made once and cached: a `score` is composed (with exact beat times for `beatSync`), a `song` is generated by the song pack, a `file` is used as it is. It ducks under speech unless `"duck": false`, and fades out over 2 seconds unless `fadeOut` says otherwise.
- **Voice-over** is spoken with Kokoro, mixed in like an audio track (music with `duck` goes quiet under it), and cached. `reverb` puts it in a room.
- **Captions** use the transcript if given, else the voice-over's own word times, else they transcribe the final mix. `"speakers": true` colors each speaker (from the transcript's `speaker` fields, or found with `install speakers`).
- After rendering, the result includes `check` (black frames, frozen picture, silence, loudness) and `warnings`, e.g. a voice-over longer than the film. What the movie file explains (a title or chart holding still, a black color card, a film with no sound sources) is listed under `check.expected` instead of `problems`. `--sheet` saves a contact sheet of the result in the same step.

**voice**: speech, voice cloning and stems
```
speak <out.wav> --text "..." [--file script.txt] [--voice af_heart] [--speed 1] [--words words.json] [--engine kokoro|say]
voices                                      → Kokoro voices (with descriptions) and the macOS say voices
clone <out.wav> --sample voice.wav --text "..." --consent "who agreed, and when" [--emotion 0.5] [--pace 0.5]
stems <music> <folder> [--only vocals|drums|bass|other]   → vocals.wav drums.wav bass.wav other.wav
```
- `speak` uses Kokoro (`install kokoro`): natural voices in American and British English, plus Spanish, French, Italian and Portuguese. Good picks: `af_heart` (warm), `am_michael` (warm male), `bm_george` (classic narrator), `af_bella` (lively). `--words` saves the time of every word, ready for `video captions --transcript`. `--engine say` uses the built-in macOS voices.
- `clone` (`install clone`, Chatterbox) speaks new words in the voice of a 5–20 second sample. It needs `--consent` with a sentence about whose voice it is and that they agreed; that statement is saved in `<out>.consent.txt` (with a fingerprint of the sample) and in the file's metadata, and the speech carries Chatterbox's inaudible watermark. `--emotion` 0.25 (calm) … 1 (very expressive).
- `stems` (`install stems`, Demucs) splits any song or video sound. `--only vocals` gives `vocals.wav` and `without-vocals.wav`: voice isolation from noisy footage, karaoke backing tracks, remixes, or ducking a song's music under new speech.

**music**: write music as a score, or generate whole songs
```
compose <score.json> <out.wav|.mp3|.mid> [--stems folder]   play a score with real instruments (install instruments)
instruments                                 → the 128 instrument names, short names, drum sounds, drum styles, rhythms, chords, amps, feels, master presets
starters / starter <genre> <score.json>     a finished score to start from: pop, lofi, rock, cinematic, edm, hiphop, jazz, folk, orchestral, ambient
song <out.wav> --prompt "style, mood, instruments, voice" [--lyrics lyrics.txt] [--duration 30] [--bpm N] [--seed N] [--model turbo|sft|base|xl] [--takes 1]
sing <instrumental> <out.wav> --lyrics lyrics.txt --prompt "the voice" [--vocals voice.wav] [--language en] [--takes 1]   vocals over your own music
repaint <song> <out.wav> --start S --end S --prompt "..." [--lyrics lyrics.txt]   remake one part of a song, keep the rest
review <song> [--reference track.mp3]       → score 0-10 and what a mixing engineer would fix, with the command for each fix
```
`review` listens to any song (composed, generated or your own) for loudness, squashed dynamics, a thin/boomy/muddy/dull/harsh balance, mono or too-wide stereo, no build between quiet and loud parts, a silent start and an abrupt end. With `--reference` it compares the tonal balance with a track you like instead of a typical mix. Use it to pick the best of several takes.
A score is JSON. You decide every note, so the music fits the film exactly (length, tempo, mood, where it builds):
```json
{
  "tempo": 96, "beatsPerBar": 4, "bars": 16,
  "tracks": [
    {"instrument": "piano", "chords": "Am F C G", "rhythm": "arp", "repeat": 4},
    {"instrument": "strings", "chords": "Am F C G", "rhythm": "pad", "repeat": 4, "volume": 0.5, "octave": 3},
    {"instrument": "synth bass", "chords": "Am F C G", "rhythm": "bass", "repeat": 4, "start": 16},
    {"instrument": "flute", "melody": "E5 D5 C5:2 - A4 C5:2 E5:4", "start": 32, "pan": 0.3},
    {"instrument": "violin", "notes": [["A5", 48, 4, 100], ["G5", 52, 4, 90]]}
  ],
  "drums": {"style": "hiphop", "start": 16}
}
```
- Times are in beats from the start. `melody` notes last 1 beat unless written `C5:2` (2 beats) or `G4:0.5`; `-` is a rest.
- `chords` are names like `C Am F G7 Dm7 Fmaj7 Esus4 Cadd9 C/E`, one per bar unless `beatsPerChord`. `rhythm`: `pad` (held), `block` (each beat), `arp` (broken chord in eighths), `strum` (guitar pattern), `pulse` (eighth-note synth), `bass` (bass line from the chord roots), `chug` (palm-muted eighths, for rock and metal). A chord written `E5` is a power chord.
- `instrument`: any General MIDI name (`acoustic grand piano`, `cello`, `warm pad`, `steel drums` …) or short names: piano, electric piano, organ, guitar, electric guitar, bass, synth bass, strings, violin, cello, harp, choir, trumpet, brass, sax, flute, lead, pad, bells, music box, marimba. `pluck` is a real plucked string (each note a little different, short notes palm-muted): with an amp it is the best rock and metal guitar here.
- Each part can have its own `fx`: `{"amp": "clean|crunch|metal", "drive": 0..1, "eq": {"low": dB, "mid": dB, "high": dB}, "reverb": "room|hall|...", "mix": 0.2}`. `"double": true` plays the part twice, hard left and right (the wide wall of rock guitars). Example rhythm guitar: `{"instrument": "pluck", "chords": "E5 E5 G5 A5", "rhythm": "chug", "octave": 2, "double": true, "fx": {"amp": "metal", "eq": {"mid": -3}}}`. `--stems folder` also saves each part and the drums as its own `.wav` for mixing.
- `drums`: a `style` (`four-on-floor`, `hiphop`, `rock`, `halftime`, `trap`, `bossa`, `waltz`) or your own `pattern`: `{"kick": "x...x...x...x...", "snare": "....x.......x...", "hat": "x.x.x.x.x.x.x.x."}`. Each character is a 16th note: `x` hit, `X` accent, `o` soft, `.` rest. Drums: kick, snare, rim, clap, hat, openhat, pedalhat, crash, ride, hightom, midtom, lowtom, tambourine, cowbell, shaker, conga, bongo.
- **Sections** give a song its form. With `"sections": [{"name": "intro", "bars": 4, "drums": false, "energy": 2}, {"name": "verse", "bars": 8, "drums": "halftime"}, {"name": "drop", "bars": 8, "energy": 5, "into": "build"}]`, each part loops to fill the sections it plays in (`"sections": ["drop"]` on a part; default all), and `bars` is their total. A section can have its own `drums` (a style, a pattern, or `false`) and `energy` (1 quiet to 5 full out, default 3). `into` says how the section before leads into it: `fill` (default when drums play on both sides: four snare 16ths, or a tom fill when the energy goes up), `build` (a snare roll and a noise riser over the last bar), `riser` (just the riser), `stop` (the whole mix drops out for the last beat, the gap before a drop) or `none`. Every new section with drums starts on a crash. The result lists each section's `start` in seconds, to cut picture on.
- **Feel**: the parts are played like people play, not on a rigid grid. Timing drifts a few milliseconds (drums tighter, the kick tightest), velocities vary, hi-hats lean on the beat, the snare sits a hair late, and soft ghost snares appear now and then. `"feel"`: `natural` (default), `tight`, `loose` or `exact` (the grid as written); a part can have its own. `"swing"`: 0.5 straight, 0.55–0.58 a light swing, 0.6–0.62 a groove, 0.66 a triplet shuffle (jazz, blues, lo-fi), with `"swingNote": 16` to swing 16ths (hip-hop, funk). `"seed"` changes the performance; the same seed plays it the same way again.
- **Master** is the last step of every compose: the music ducks under the kick, a compressor glues the mix, shelves set the tone, and a limiter brings it to loudness with peaks under -1 dB. `"master"`: `balanced` (default), `pop`, `edm` (deep pumping), `hiphop`, `rock`, `lofi` (warm, pumping), `acoustic`, `jazz`, `cinematic`, `ambient` (the last four keep more dynamics, at -16 LUFS), a preset with tweaks such as `{"preset": "edm", "duck": 8, "high": 2}` (`duck` dB, `ratio`, `threshold` dB, `low`/`high` shelf dB, `lufs`), or `false` for just standard loudness.
- `"sounds"` picks the instruments: `generaluser` (default) or `musescore` (MuseScore General: a fuller orchestra, piano and drums; both come with `install instruments`), or the path of any SoundFont (`.sf2`/`.sf3`) you have.
- **Starters** are finished arrangements, one per genre (`starter lofi score.json`): sections, groove, feel, master and sounds already set. Change the chords, melody, tempo and sections to make it yours; it is quicker and sounds better than starting from nothing.
- Ideas: start sparse and add parts every 8 bars to build energy; set `tempo` so that 1 bar = a scene length; make the score exactly as long as the film (`bars` = seconds × tempo / 60 / 4). `.mid` output opens in any music app.
- `song` (`install song`, ACE-Step 1.5, ~10 GB of models) makes a full produced song: describe genre, mood, instruments and voice in `--prompt`; lyrics use section tags like `[verse]`, `[chorus]`, `[bridge]`. Without lyrics it is instrumental. Same `--seed` = same song. It is strongest at pop, electronic, hip-hop, ambient, cinematic and singer-songwriter; heavy rock and metal come out soft (little 1–5 kHz bite), and its beat grid is its own. For rock or metal, or music that must hit exact times, `compose` a score (pluck + amp) instead, or check the song with `listen bands` and `listen beats`. `--model`: `turbo` (default, fast: 8 steps, follows the prompt at a fixed strength), `sft` (guided: follows the prompt more closely, `--guidance` 7 by default, 32 steps), `xl` (the bigger sft, best detail) or `base`; add them with `install song --extra sft,xl,base`. Measured on a 24 GB Apple Silicon laptop, 30 s with lyrics: turbo 75 s from cold, sft 155 s (both sang the lyrics almost word for word and reviewed the same); xl needs about 20 GB on its own on Apple Silicon (it runs in 32-bit there, about 10 GB on NVIDIA), so it does not fit a 24 GB Mac and says so. `--takes 3` makes three versions, listens to each with `review` and keeps the best (the result lists every take's seed and score). On a 24 GB Apple Silicon laptop a 30-second song takes about 100 seconds when the pack has to load and about 45 once it is loaded; the result reports `seconds`, the memory `tier` and the language model (`lm`) it used. `sing` (`install song --extra base`) writes a lead vocal over music you made, such as a composed score, so the beat, chords, length and section times stay exactly yours: describe the voice in `--prompt` (`"warm female pop vocal, breathy, close mic"`); `--vocals` also saves the voice alone; `--language` (en, es, ja …) tells it the lyrics' language, which it cannot detect. `sing` follows the lyrics loosely (lines get reordered or changed), while `song` follows them closely: when the exact words matter, use `song`, or make a few `sing` takes and check each with `listen transcribe`. `repaint` remakes `--start`..`--end` seconds of any song to a new description or lyrics (a weak chorus, a wrong word, a better ending) and keeps the rest. To check the singing (or time lyric captions), split it first: `voice stems song.wav stems --only vocals`, then `listen transcribe stems/vocals.wav words.json`.

**Songwriting: what the tools give you**
- **Ways to make it:** `compose` gives exact control (every note, beat and section time), so it suits music cut to picture and any style you can write down. `song` gives a fully produced, sung track from words. Mixing them works too: compose an instrumental and `sing` over it, `repaint` part of a generated song, or use `voice stems` to take a generated song apart and rebuild it in a score.
- **Things that often make music feel alive** (use, bend or ignore them as the piece needs): change something every few bars (a part enters or drops out, the drums switch, the `energy` moves); contrast between sections (sparse against full, low against high, talk-like against sung); a short idea that comes back; a moment of space before a big arrival (`into: "stop"` or `"build"`). Plenty of great music breaks every one of these: a single drone, a through-composed score, a loop that never changes.
- **Lyrics and prompts:** section tags (`[verse] [chorus] [bridge] [break]` …) steer the shape of a `song`; lines of similar length sing more naturally. The `--prompt` takes any description: genre or blend of genres, era, mood, voice, instruments, production ("lo-fi tape hiss", "huge stadium reverb").
- **Listening:** `review` scores a mix and gives the command for each fix. Its targets fit mainstream releases, so a quiet ambient or raw punk track can score lower on purpose. `listen bands --reference` compares the tone with any track you choose. `--takes` and different seeds give you options to choose from.

**3d**: real 3D scenes rendered by Blender (free; `doctor` shows how to install it)
```
render <scene.py> <out.mp4|.mov|.webm|.png> [--duration 4] [--frame 1] [--width 1920] [--height 1080] [--fps 30]
       [--engine eevee|cycles] [--samples N] [--draft] [--transparent]
title <out.mp4|.png> --text "TITLE" [--subtitle "..."] [--color "#hex"] [--background "#hex"] [--font BebasNeue] [--brand brand.json] [--duration 4]
turntable <model.glb|.gltf|.obj|.fbx|.stl|.ply> <out.mp4> [--duration 6] [--turns 1] [--background "#hex"]
```
A scene is a short Python script. It starts with a dark sky, a camera looking at the middle and soft studio lights (each replaced as soon as your script makes its own), and has these ready to use:
```python
shape(kind, location=(0,0,0), size=1, rotation=(0,0,0), material=None, bevel=0)   # cube sphere cylinder cone torus plane monkey
text3d(text, size=1, depth=0.15, bevel=0.02, font="BebasNeue", material=None, location=(0,0,0), rotation=(90,0,0))
load(path, size=2.0, location=(0,0,0))     # import a model, scaled to `size` meters and standing on the ground
material(color="#FFFFFF", metal=0, rough=0.4, glow=0, glass=False)
ground(color, reflect=0, shadow_only=False)   sky(color, top=None, strength=1)
studio_light(style="soft")                 # soft bright dramatic sunset cool
camera(location=(0,-8,2), target=(0,0,0.5), lens=50)
orbit_camera(target, radius=8, height=2, turns=1)
keyframe(obj, "location" | "rotation_euler" | "scale", {1: value, seconds(2): value}, ease=True)
FPS, FRAMES, WIDTH, HEIGHT, seconds(s), hex_color("#hex"), bpy   # bpy = all of Blender's Python API
```
Example scene, a gold ball dropping next to a slowly turning glass cube:
```python
sky("#0E1A2B", top="#2B4C7E")
ground("#0E1A2B", reflect=0.4)
ball = shape("sphere", location=(-1.2, 0, 0.5), material=material("#E8B04A", metal=1, rough=0.2))
cube = shape("cube", location=(1.2, 0, 0.5), material=material("#9AD1FF", glass=True), bevel=0.05)
keyframe(ball, "location", {1: (-1.2, 0, 3), seconds(1): (-1.2, 0, 0.5)})
keyframe(cube, "rotation_euler", {1: (0, 0, 0), FRAMES: (0, 0, 180)}, ease=False)
studio_light("sunset")
orbit_camera(radius=7, height=2.5, turns=0.25)
```
- Units are meters (things about 1–3 m across look right with the default camera), angles are degrees, Z is up, the camera looks toward +Y.
- `eevee` renders in seconds and looks great. `cycles` traces real light (glass, caustics, soft shadows); its first render on a machine compiles GPU code for a few minutes, after that it is quick. `--draft` (half size, few samples) is for checking motion; `render` to a `.png` with `--frame N` checks one moment.
- An error in the script comes back with the script's own line number. What the script `print`s comes back under `printed` (and with the error), handy for measuring a scene from Python.
- `--frame N` with a `.png` renders frame N of a scene that is `--duration` long, so `FRAMES` and `seconds()` mean the same as in the video.
- `--transparent` with `.mov`, `.webm` or `.png` keeps only the objects, ready to lay over video (with `--engine cycles`, `ground(shadow_only=True)` keeps their shadows too).
- Ideas: 3D logo reveals (`title`), product spins from a model (`turntable`), charts as 3D bars (`shape("cube")` scaled by data), a generated picture on a `plane` as a backdrop, exporting what you build (`bpy.ops.export_scene.gltf(filepath=...)`) for Three.js pages.

**top level**
```
doctor                                      tools, libraries, machine (RAM, GPU memory, free disk), and what can be added
check <file>                                quality report with fix commands
packs                                       AI models, assets and packs, and which are installed
install <name>                              add one (the only command that downloads)
bench [--only image,song] [--save bench.json]   time, RAM and GPU memory of each installed pack, cold and warm
jobs list | wait <id> [--timeout 3600] | cancel <id> | stop   background jobs (--background) and loaded packs
```
- `bench` runs one fixed job per pack twice: cold (loading the models) and warm. Use it to see what this computer can do before planning heavy work, and to compare computers. On a 24 GB Apple Silicon laptop: a 768×768 picture 28 s, a 30 s song 98 s cold and 47 s warm, a cloned sentence 30 s cold and 5 s warm.

## Examples
Ideas for combining commands, not fixed recipes.

**Tighten a talk**
```
node joedit.ts video remove-fillers talk.mp4 clean.mp4
node joedit.ts video remove-silence clean.mp4 tight.mp4 --min 0.6
node joedit.ts look strip tight.mp4 cut.png --start 11.5 --end 13.5      (check a cut)
```

**A finished film from a template**
```
node joedit.ts movie template short movie.json
(edit movie.json: your clips, words and music)
node joedit.ts movie validate movie.json
node joedit.ts movie render movie.json draft.mp4 --draft --sheet sheet.png
(read sheet.png, adjust, then the full render reuses every unchanged scene)
node joedit.ts movie render movie.json final.mp4
```

**Know a pile of footage**
```
node joedit.ts look index footage/ --output footage.json      (what is in every file: things, faces, text, speech, sounds)
node joedit.ts look find footage/ --query "sunset over water" --top 3 --sheet found.png
node joedit.ts listen find footage/street.mp4 --query "car horn"
```

**Narrated explainer, no microphone**
```
node joedit.ts voice speak narration.wav --file script.txt --voice bm_george --words words.json
node joedit.ts sound duck music.mp3 narration.wav mix.wav
node joedit.ts video add-audio visuals.mp4 narrated.mp4 --audio mix.wav
node joedit.ts video captions narrated.mp4 final.mp4 --transcript words.json --style minimal
```
(or put `"voiceover"` in a movie file, which does all of this)

**Interview with a name that follows the speaker**
```
node joedit.ts look track interview.mp4 ada.json --what person --draw ada.png
(movie scene: {"video": "interview.mp4", "layers": [{"text": "Ada Lovelace", "style": {"size": 56, "box": "#000000AA"}, "track": "ada.json", "duration": 4, "fadeIn": 0.3, "fadeOut": 0.3}]})
```

**Two-person podcast with a color per speaker**
```
node joedit.ts listen speakers podcast.mp4 words.json --speakers 2
node joedit.ts video reframe podcast.mp4 tall.mp4 --aspect 9:16 --follow
node joedit.ts video captions tall.mp4 final.mp4 --transcript words.json --style pop --speakers
```

**Clean up speech recorded in a noisy place**
```
node joedit.ts voice stems street-interview.mp4 parts --only vocals
node joedit.ts sound denoise parts/vocals.wav clean.wav
node joedit.ts sound fx clean.wav voice.wav --voice podcast
node joedit.ts video add-audio street-interview.mp4 fixed.mp4 --audio voice.wav
```

**Cut a montage to the music**
```
node joedit.ts listen beats song.mp3                   → bpm 120, beats [0.5, 1.0, 1.5, ...]
(movie file with the clips as scenes and "beatSync": "song.mp3", or trim clips to the beat spacing and concat)
```

**A stylized look of your own**
```
node joedit.ts fx gallery effects.png --input clip.mp4             (see every effect on this footage)
node joedit.ts fx apply clip.mp4 styled.mp4 --effect grade,bloom,grain --set "grade.saturation=1.2,bloom.radius=24"
node joedit.ts look strip styled.mp4 check.png --start 2 --end 3
```

**Snow falling on a still photo**
```
node joedit.ts picture parallax cabin.jpg move.mp4 --motion dolly --duration 6
node joedit.ts fx apply move.mp4 snowy.mp4 --effect snow,vignette
```

**Intro title with a sound hit**
```
node joedit.ts graphics title intro.mp4 --text "Summer Trip" --subtitle "2026" --brand brand.json
node joedit.ts sound sfx hit.wav --type boom
node joedit.ts video add-audio intro.mp4 intro-sound.mp4 --audio hit.wav
node joedit.ts fx transition intro-sound.mp4 trip.mp4 film.mp4 --name whip-left --duration 0.4
```

**Your own animated chart**
```
(write chart.mjs: bars that grow, values from info.data)
node joedit.ts graphics canvas chart.mjs check.png --time 1.5 --data numbers.json
node joedit.ts graphics canvas chart.mjs chart.mp4 --duration 4 --data numbers.json
```

**Product shot from one photo**
```
node joedit.ts picture cutout phone.jpg phone.png
node joedit.ts picture generate set.png --prompt "minimal marble table, soft morning light, blurred plants behind" --width 1920 --height 1080
(design.json: background set.png, layer {"image": "phone.png", "x": 660, "y": 140, "width": 600, "height": 800, "fit": "contain"})
node joedit.ts picture compose design.json scene.png
node joedit.ts look colors scene.png                   → pick title colors that fit
node joedit.ts picture parallax scene.png shot.mp4 --motion dolly --duration 5
```

**Branded upload with subtitles**
```
node joedit.ts video stabilize walk.mp4 steady.mp4
node joedit.ts video overlay steady.mp4 logo.png branded.mp4 --x 0.92 --y 0.08 --width 0.1 --opacity 0.85
node joedit.ts video fade branded.mp4 final.mp4 --in 0.5 --out 1
node joedit.ts listen transcribe final.mp4 final.srt                 (upload next to the video)
```

**Privacy before posting**
```
node joedit.ts video blur-faces crowd.mp4 safe.mp4
node joedit.ts look read safe.mp4 --every 2               (any names, plates or screens still readable?)
```

## Use from code
Every command is also an exported TypeScript function (`extract-audio` → `extractAudio`). Functions throw an `Error` on failure. Good for loops and bigger jobs.
```ts
import { trim } from "./joEdit/areas/video.ts";
import { sheet } from "./joEdit/areas/look.ts";
import { check } from "./joEdit/joedit.ts";
trim("in.mp4", "out.mp4", 1, 4);
await sheet("out.mp4", "sheet.png");
console.log(check("out.mp4"));
```
Lower-level building blocks live in `core/shared.ts` (`readFrames`/`writeVideo` for raw RGBA frames, `skia`, `drawText`) and `areas/fx.ts` (`prepareEffects` + `effectFrame`, `prepareTransition` + `transitionFrame`), for frame-by-frame work of your own.

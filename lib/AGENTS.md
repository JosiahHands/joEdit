# joEdit: Guide for AI Agents

joEdit is a toolkit for editing pictures, video and sound, making motion graphics, and **seeing and hearing the results**. It runs entirely on this computer: no API keys, no cost per edit. Use it however suits the job: one command at a time, chained in a script, or imported as TypeScript functions. When joEdit doesn't do something, `ffmpeg`, `ffprobe` and `magick` are installed too, so call them directly or extend joEdit.

```
node joedit.ts <area> <command> ...      areas: picture, video, sound, look, listen, graphics, movie, voice, music, 3d
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
generate <out.png> --prompt "..." [--width 1024] [--height 1024] [--seed N] [--steps 9]   new picture from a description
upscale <in> <out> [--scale 2|3|4] [--style photo|art]   bigger, with AI-restored detail
cutout <in> <out.png> [--mask]              remove the background (see-through PNG), or a white-on-black mask of the subject
depth <in> <out.png>                        depth map: near = white, far = black
parallax <in> <out.mp4> [--motion dolly|orbit|pan-left|pan-right|rise|fall] [--duration 5] [--amount 1] [--depth map.png]
                                            3D camera move inside a still photo: near things move more than far things
```
- `generate` (`install image`, Z-Image Turbo) makes photoreal or illustrated pictures in seconds on Apple Silicon or an NVIDIA GPU. Describe the subject, setting, light, lens and style in plain words (`"studio portrait, soft window light, 85mm, film grain"`). The same `--seed` and prompt give the same picture, so you can change one word and compare. It also renders short text in the picture well.
- `upscale` (`install upscaler`, Real-ESRGAN) restores detail when enlarging: old photos, small web pictures, generated pictures before printing. `--style art` is tuned for drawings, anime and graphics.
- `cutout` (`install cutout`) keeps hair and fine edges. Put the subject on a new background with `magick bg.jpg cut.png -composite out.jpg`, or use `--mask` with ffmpeg/magick to grade or blur only the subject or only the background.
- `depth` (`install depth`) is the base for parallax, fake depth of field (blur by the map), fog, and "near/far" masks.
- `parallax` (`install depth` + Chrome) brings a still to life far more than `animate`: a slow `dolly` push in, an `orbit` sway, or a sideways pan. `--amount` above 1 moves more but starts to stretch the edges of near objects; check a frame. `--depth` reuses a map you already made.

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
reframe <in> <out> --aspect 9:16 --follow [--smooth 2] [--every 0.5]   the crop follows the main subject as it moves
pip <main> <small> <out> [--corner bottom-right] [--size 0.3]   picture-in-picture (sound from main)
interpolate <in> <out> [--fps 60]           invents in-between frames: smoother motion, or slow motion with `speed`
generate <out.mp4> --prompt "..." [--image start.png] [--seconds 5] [--steps 50] [--seed N]   AI video clip
```
- `reframe --follow` (`install cutout`) finds the subject every `--every` seconds and glides the crop along its path like a camera operator; `--smooth` is seconds of smoothing (bigger = calmer). The result includes the crop `path`. It is the quick way to turn landscape footage of a person or product into a phone video.
- `generate` (`install videogen`, Wan 2.2 TI2V-5B) makes a clip from a description, or animates `--image` (for example a `picture generate` result). It needs a big GPU (24 GB+ of video memory, ~30 GB of models) and takes minutes per clip; on smaller machines, `picture parallax` and `picture animate` bring stills to life instead.
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
- Real-time 3D in a page: `install three`, copy it next to the page (`cp -r joEdit/.assets/three .`), then
  `<script type="importmap">{"imports": {"three": "./three/three.module.js", "three/addons/": "./three/addons/"}}</script>` and
  `import * as THREE from "three"` / `import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"` in a `<script type="module">`. Create the renderer with `preserveDrawingBuffer: true` and draw in `window.joedit.render`. Top-level `await` (loading models) finishes before the first frame.

**look**: pictures of video, to read
```
sheet <video> <out.png> [--count 12]        frames from the whole video, labelled with times
strip <video> <out.png> --start S --end S [--count 8]   close-up of one moment
scenes <video> [--threshold 0.3]            → times of shot changes (0.1 sensitive … 0.6 hard cuts only)
compare <pic1> <pic2> <out.png>             → difference 0..1, plus a picture marking differences in red
find <video|picture|folder> --query "a dog on a beach" [--top 5] [--every 1] [--sheet out.png]   search by meaning
colors <picture|video> [--count 6] [--swatch out.png]   → main colors (hex) and their share of the picture
```
- `find` (`install vision`, SigLIP 2) searches what footage shows, not what it is called: `"close-up of hands typing"`, `"crowd cheering"`, `"logo on a white background"`. Each match has the best `time` and the whole moment (`start`–`end`), ready for `video trim` or a movie scene's `from`/`to`. Scores only mean something relative to each other within one search. Frames are cached in `.joedit-cache/`, so further searches of the same footage take seconds.
- `colors` gives a palette to match titles, captions and brand colors to the footage.

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

**music**: write music as a score, or generate whole songs
```
compose <score.json> <out.wav|.mp3|.mid>    play a score with real instruments (install instruments; needs fluidsynth)
instruments                                 → the 128 instrument names, short names, drum sounds, drum styles, rhythms, chords
song <out.wav> --prompt "style, mood, instruments, voice" [--lyrics lyrics.txt] [--duration 30] [--bpm N] [--seed N]
```
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
- `chords` are names like `C Am F G7 Dm7 Fmaj7 Esus4 Cadd9 C/E`, one per bar unless `beatsPerChord`. `rhythm`: `pad` (held), `block` (each beat), `arp` (broken chord in eighths), `strum` (guitar pattern), `pulse` (eighth-note synth), `bass` (bass line from the chord roots).
- `instrument`: any General MIDI name (`acoustic grand piano`, `cello`, `warm pad`, `steel drums` …) or short names: piano, electric piano, organ, guitar, electric guitar, bass, synth bass, strings, violin, cello, harp, choir, trumpet, brass, sax, flute, lead, pad, bells, music box, marimba.
- `drums`: a `style` (`four-on-floor`, `hiphop`, `rock`, `halftime`, `trap`, `bossa`, `waltz`) or your own `pattern`: `{"kick": "x...x...x...x...", "snare": "....x.......x...", "hat": "x.x.x.x.x.x.x.x."}`. Each character is a 16th note: `x` hit, `X` accent, `o` soft, `.` rest. Drums: kick, snare, rim, clap, hat, openhat, pedalhat, crash, ride, hightom, midtom, lowtom, tambourine, cowbell, shaker, conga, bongo.
- Ideas: start sparse and add parts every 8 bars to build energy; set `tempo` so that 1 bar = a scene length; make the score exactly as long as the film (`bars` = seconds × tempo / 60 / 4). `.mid` output opens in any music app.
- `song` (`install song`, ACE-Step 1.5, ~10 GB of models) makes a full produced song: describe genre, mood, instruments and voice in `--prompt`; lyrics use section tags like `[verse]`, `[chorus]`, `[bridge]`. Without lyrics it is instrumental. Same `--seed` = same song. Takes a minute or two on Apple Silicon or an NVIDIA GPU. To check the singing (or time lyric captions), split it first: `voice stems song.wav stems --only vocals`, then `listen transcribe stems/vocals.wav words.json`; speech-to-text hears sung words much better without the band.

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
- An error in the script comes back with the script's own line number.
- `--transparent` with `.mov`, `.webm` or `.png` keeps only the objects, ready to lay over video (with `--engine cycles`, `ground(shadow_only=True)` keeps their shadows too).
- Ideas: 3D logo reveals (`title`), product spins from a model (`turntable`), charts as 3D bars (`shape("cube")` scaled by data), a generated picture on a `plane` as a backdrop, exporting what you build (`bpy.ops.export_scene.gltf(filepath=...)`) for Three.js pages.

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
    {"image": "landscape.jpg", "motion": "parallax", "duration": 4},   // 3D move, depth pack
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
  "music": {"score": "score.json", "volume": 0.7},    // or {"song": {"prompt": "...", "duration": 60}} or {"file": "track.mp3"}
  "captions": {"style": "karaoke", "position": "bottom"},   // or {"transcript": "words.json"}; true = defaults
  "beatSync": true,                        // move every cut to the nearest beat of "music" (or give a sound file)
  "notes": "free text for yourself"
}
```
(Comments above are explanations; JSON itself has no comments.)
- **Scenes** are one of `title`, `video`, `image`, `html` (any page you write, rendered like `graphics render`) or `color`. Non-video scenes last 3 seconds unless `duration` is given. Image `motion` is a flat move (`zoom-in` (default), `zoom-out`, `pan-left/right/up/down`, `none`) or a 3D one: `parallax` (a push in), `parallax-orbit`, `parallax-pan-left/right`, `parallax-rise/fall`. Video scenes use `from`/`to` (or `duration`) and `fit`: `cover` fills the frame and crops the edges, `contain` shows the whole clip on a blurred copy of itself (good for wide clips in a phone video).
- **Transitions** belong to the scene they lead into: `fade`, `fadeblack`, `fadewhite`, `dissolve`, `wipeleft/right/up/down`, `slideleft/right/up/down`, `smoothleft/right/up/down`, `circleopen`, `circleclose`, `radial`, `pixelize`, `zoomin`, `hblur`, `squeezeh`, `coverleft`, `revealright` and more (`validate` lists them all). Each transition overlaps the two scenes, so the film gets shorter by its duration.
- **Sound:** scene sound, `audio` tracks and `sfx` are mixed together and set to -14 LUFS. Tracks with `"duck": true` go quiet whenever the other sound (speech) is loud. `at` is seconds from the start of the film.
- **Music** is made once and cached: a `score` is composed (with exact beat times for `beatSync`), a `song` is generated by the song pack, a `file` is used as it is. It ducks under speech unless `"duck": false`, and fades out over 2 seconds unless `fadeOut` says otherwise.
- **Voice-over** is spoken with Kokoro, mixed in like an audio track (music with `duck` goes quiet under it), and cached.
- **Captions** use the transcript if given, else the voice-over's own word times, else they transcribe the final mix (whisper pack).
- After rendering, the result includes `check` (black frames, silence, loudness) and `warnings`, e.g. a voice-over longer than the film. An intended black ending shows up in `check`, which is fine.

**top level**
```
doctor                                      installed tools, machine, packs
check <file>                                quality report with fix commands
packs                                       available AI packs and assets, and whether they are installed
install <name>                              a pack (needs uv) or an asset (fonts, instruments, upscaler, three, browser)
```
Packs: `whisper` (speech to text), `tts` (speak), `clone` (voice cloning), `stems` (music separation), `song` (AI songs), `image` (picture generate), `cutout` (backgrounds, follow), `depth` (depth maps, parallax), `vision` (look find), `videogen` (video generate, big GPU). Assets: `fonts`, `instruments` (sounds for music compose), `upscaler`, `three` (Three.js for 3D pages), `browser`. Each installs once (a few minutes, mostly downloading) and then runs offline; the first use of each also downloads its model.

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
node joedit.ts video reframe tight.mp4 tall.mp4 --aspect 9:16 --x 0.3      (keep the speaker on the left; or --follow if they move)
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

**Find a moment by what is shown**
```
node joedit.ts look find holiday/ --query "kids jumping into a pool" --top 3 --sheet found.png
                                                      → holiday/day2.mp4 start 41 end 47, ...
node joedit.ts video trim holiday/day2.mp4 splash.mp4 --start 41 --end 47
```

**Product shot from one photo**
```
node joedit.ts picture cutout phone.jpg phone.png
node joedit.ts picture generate set.png --prompt "minimal marble table, soft morning light, blurred plants behind" --width 1920 --height 1080
magick set.png ( phone.png -resize 45% ) -gravity center -composite scene.png
node joedit.ts look colors scene.png                   → pick title colors that fit
node joedit.ts picture parallax scene.png shot.mp4 --motion dolly --duration 5
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

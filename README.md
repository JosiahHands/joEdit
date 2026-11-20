# joEdit

**A media studio for AI agents.** Your coding agent (Claude Code, Codex, Gemini CLI, …) edits and creates video, pictures, sound, music and 3D, and checks its own work by looking at contact sheets and reading loudness, beats and transcripts. Everything runs on your computer: no API keys, no per-use cost, no internet needed after setup, just your AI subscription.

## Quick start

1. **Install** on macOS, Windows or Linux (needs Node.js 24+; nothing else: joEdit brings its own FFmpeg, picture, drawing, audio, GPU and AI engines):
   ```bash
   npx degit JosiahHands/joEdit/lib joEdit && cd joEdit && npm install
   ```
2. **Let your agent set it up.** Paste this into your AI CLI, from the folder that holds `joEdit/`:
   ```text
   Read joEdit/AGENTS.md. Then run `node joEdit/joedit.ts doctor` to check this computer, and tell me which optional AI models, assets and programs would be useful for what I make (`node joEdit/joedit.ts packs` lists them). Ask me before large downloads.
   ```
3. **Ask for what you want:**
   - "Turn `talk.mp4` into a 9:16 clip with the ums and pauses cut and karaoke captions."
   - "Make a 30 second explainer about our app with a voice-over, music, an animated chart and a 3D title."
   - "Find every shot of the dog in `holiday/` and cut them to the beat of `song.mp3`."
   - "Remove the background from `product.jpg` and make a slow 3D parallax shot of it with falling snow."

## What's inside

- **Films from one JSON file:** scenes, 100+ transitions, layers with keyframes and blend modes, text that follows people, titles, voice-over, music that ducks under speech, sound effects, captions colored by speaker, GPU effects and color looks, slow motion and subject-following reframes per scene, film-wide overlays. Scenes and the finished picture are cached, so a music change re-renders in seconds.
- **Edit:** trim, join any mix of clips (bars, never stretched), jump cuts, filler-word removal, phone reframes that follow the subject, face blurring, stabilizing, reversing, fades, logos and picture-in-picture, color grades, mixing, reverb, voice styles, denoising.
- **Create:** titles, captions and motion graphics drawn with Skia, your own canvas animations, 40+ GPU effects and particles (or your own GLSL), `.cube` LUTs, designed pictures from layers (cutouts with outlines and glow), sound design with Web Audio, scores played on real instruments (plus a plucked-string guitar through clean, crunch or metal amps), 3D scenes in Blender.
- **AI, run locally (optional, installed one at a time):** speech-to-text, natural voices, speaker detection, object and face tracking, reading text on screen, search footage and sounds by meaning, background removal, depth and parallax, upscaling; Python packs for picture generation, songs with vocals, consent-based voice cloning, stem splitting and video generation.
- **See & hear:** contact sheets, a one-file index of all your footage, waveforms, loudness, beats and downbeats, tonal balance against a reference (and EQ matching), energy over time, transcripts and .srt/.vtt subtitles, and a one-command quality `check` with fix suggestions (movie renders check themselves and can write a contact sheet).

Everything runs through one file: `node joedit.ts <area> <command>` (areas: picture, video, sound, look, listen, graphics, fx, movie, voice, music, 3d). Every command prints one line of JSON, and typos get a "did you mean". The full guide, written for agents, is [lib/AGENTS.md](lib/AGENTS.md).

## License

GPL-3.0-or-later (joEdit includes a GPL build of FFmpeg). Bundled fonts are under the SIL Open Font License, raylib under zlib; each optional model, asset and pack shows its own license in `packs`.

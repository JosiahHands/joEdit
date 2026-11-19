# joEdit

**A media studio for AI agents.** Your coding agent (Claude Code, Codex, Gemini CLI, …) edits and creates video, pictures, sound, music and 3D, and checks its own work by looking at contact sheets and reading loudness, beats and transcripts. Everything runs on your computer: no API keys, no per-use cost, just your AI subscription.

## Quick start

1. **Install** (needs Node.js 24+, ffmpeg and ImageMagick; on macOS `brew install node ffmpeg imagemagick`):
   ```bash
   npx degit JosiahHands/joEdit/lib joEdit && cd joEdit && npm install
   ```
2. **Let your agent set it up.** Paste this into your AI CLI, from the folder that holds `joEdit/`:
   ```text
   Read joEdit/AGENTS.md. Then run `node joEdit/joedit.ts doctor` to see what this computer is missing, and install it: the required tools first (follow each "fix" command), then the optional tools, AI packs and assets I'll need (`node joEdit/joedit.ts install <name>`). Ask me before large downloads. When doctor is happy, tell me what joEdit can now do here.
   ```
3. **Ask for what you want:**
   - "Turn `talk.mp4` into a 9:16 clip with the pauses cut and karaoke captions."
   - "Make a 30 second explainer about our app with a voice-over, music and a 3D title."
   - "Find every shot of the dog in `holiday/` and cut them to the beat of `song.mp3`."
   - "Remove the background from `product.jpg` and make a slow 3D parallax shot of it."

## What's inside

- **Films from one JSON file:** scenes, transitions, titles, voice-over, music that ducks under speech, sound effects, captions and a color look. Scenes are cached and render in parallel; drafts take seconds.
- **Edit:** trim, join, jump cuts, phone reframes that follow the subject, picture-in-picture, color grades, film effects, mixing, denoising.
- **Create:** HTML → video motion graphics, titles, captions, sound effects, scores played on real instruments, 3D scenes in Blender.
- **AI, run locally (optional packs):** speech-to-text, natural voices, consent-based voice cloning, stem splitting, songs with vocals, picture generation, upscaling, background removal, depth and parallax, search footage by meaning.
- **See & hear:** contact sheets, waveforms, loudness, beats, transcripts, and a one-command quality `check` with fix suggestions.

Everything runs through one file: `node joedit.ts <area> <command>` (areas: picture, video, sound, look, listen, graphics, movie, voice, music, 3d). Every command prints one line of JSON, and typos get a "did you mean". The full guide, written for agents, is [lib/AGENTS.md](lib/AGENTS.md).

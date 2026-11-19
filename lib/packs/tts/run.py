# Text to speech with Kokoro-82M.
# Usage: python run.py <out.wav> --text "..." [--voice af_heart] [--speed 1] [--words words.json]
# Prints one line of JSON: {"duration", "voice", "words"}.
# --words also saves the time of every spoken word (same format as listen transcribe), for captions.
import argparse
import json
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import soundfile as sf
from kokoro import KPipeline

parser = argparse.ArgumentParser()
parser.add_argument("output")
parser.add_argument("--text", required=True)
parser.add_argument("--voice", default="af_heart")
parser.add_argument("--speed", type=float, default=1.0)
parser.add_argument("--words", default=None)
args = parser.parse_args()

RATE = 24000
# The first letter of a voice is its language: a = American English, b = British English, e = Spanish,
# f = French, h = Hindi, i = Italian, p = Portuguese, j = Japanese, z = Chinese.
pipeline = KPipeline(lang_code=args.voice[0], repo_id="hexgrad/Kokoro-82M")

pieces = []
words = []
offset = 0.0
# Kokoro speaks long text in chunks; blank lines also start a new chunk.
for result in pipeline(args.text, voice=args.voice, speed=args.speed, split_pattern=r"\n+"):
    audio = result.audio.numpy() if hasattr(result.audio, "numpy") else np.asarray(result.audio)
    for token in result.tokens or []:
        if token.start_ts is None or token.end_ts is None or not token.text.strip():
            continue
        # Punctuation belongs to the word before it.
        if words and not any(c.isalnum() for c in token.text):
            words[-1]["word"] += token.text
            continue
        words.append({"word": token.text, "start": round(offset + token.start_ts, 2), "end": round(offset + token.end_ts, 2)})
    pieces.append(audio)
    offset += len(audio) / RATE

speech = np.concatenate(pieces) if pieces else np.zeros(1, dtype=np.float32)
sf.write(args.output, speech, RATE)
if args.words:
    text = " ".join(w["word"] for w in words)
    with open(args.words, "w") as f:
        json.dump({"language": args.voice[0], "text": text, "words": words, "segments": []}, f, indent=2)
print(json.dumps({"duration": round(len(speech) / RATE, 2), "voice": args.voice, "words": len(words)}))

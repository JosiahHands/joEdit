# Speech to text with word timestamps, using faster-whisper.
# Usage: python run.py <audio.wav> [--model base] [--language en]
# Prints one line of JSON: {"language", "text", "words": [{word, start, end}], "segments": [...]}
import argparse
import json

from faster_whisper import WhisperModel

parser = argparse.ArgumentParser()
parser.add_argument("audio")
parser.add_argument("--model", default="base")
parser.add_argument("--language", default=None)
args = parser.parse_args()

# int8 on CPU works on every computer and is fast enough for most clips.
# The model is downloaded the first time it is used.
model = WhisperModel(args.model, device="cpu", compute_type="int8")
pieces, info = model.transcribe(args.audio, language=args.language, word_timestamps=True)

words = []
segments = []
for piece in pieces:
    segments.append({"start": round(piece.start, 2), "end": round(piece.end, 2), "text": piece.text.strip()})
    for word in piece.words or []:
        words.append({"word": word.word.strip(), "start": round(word.start, 2), "end": round(word.end, 2)})

text = " ".join(segment["text"] for segment in segments)
print(json.dumps({"language": info.language, "text": text, "words": words, "segments": segments}))

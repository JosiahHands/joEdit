# Voice cloning with Chatterbox: say new words in the voice of a short sample (5-20 seconds is best).
# Usage: python run.py <out.wav> --sample voice.wav --text "..." [--emotion 0.5] [--pace 0.5]
# Prints one line of JSON: {"duration", "device"}.
# Chatterbox adds an inaudible watermark (Perth) to everything it makes, so it can be identified as AI speech.
import argparse
import json
import warnings

warnings.filterwarnings("ignore")

import torch
import torchaudio

parser = argparse.ArgumentParser()
parser.add_argument("output")
parser.add_argument("--sample", required=True)
parser.add_argument("--text", required=True)
parser.add_argument("--emotion", type=float, default=0.5)  # 0.25 calm ... 1.0 very expressive
parser.add_argument("--pace", type=float, default=0.5)  # lower = slower, more deliberate
args = parser.parse_args()

# Apple GPU (mps), NVIDIA GPU (cuda), or the processor.
device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"

# The model files were saved on an NVIDIA GPU; load them onto whatever this computer has.
original_load = torch.load
torch.load = lambda *a, **k: original_load(*a, **{**k, "map_location": torch.device(device)})

from chatterbox.tts import ChatterboxTTS

model = ChatterboxTTS.from_pretrained(device=device)
speech = model.generate(args.text, audio_prompt_path=args.sample, exaggeration=args.emotion, cfg_weight=args.pace)
torchaudio.save(args.output, speech.cpu(), model.sr)
print(json.dumps({"duration": round(speech.shape[-1] / model.sr, 2), "device": device}))

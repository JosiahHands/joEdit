# Split music into stems with Demucs (htdemucs): vocals, drums, bass and other.
# Usage: python run.py <in.wav> <out-folder> [--model htdemucs] [--device auto|cpu|mps|cuda]
# The input should be a 44.1 kHz stereo wav (voice.ts prepares it). Prints one line of JSON: {"stems": {name: path}}.
import argparse
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")  # run any missing Apple GPU steps on the processor

import soundfile as sf
import torch
from demucs.api import Separator

# `node joedit.ts install stems` runs this once to add the model; after that every run is offline.
if "--download" in sys.argv:
    Separator(model="htdemucs", device="cpu")  # loading the model fetches it into joEdit's pack folder
    print(json.dumps({"downloaded": "htdemucs"}))
    sys.exit(0)

parser = argparse.ArgumentParser()
parser.add_argument("input")
parser.add_argument("folder")
parser.add_argument("--model", default="htdemucs")
parser.add_argument("--device", default="auto")
args = parser.parse_args()

device = args.device
if device == "auto":
    device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"

data, rate = sf.read(args.input, dtype="float32", always_2d=True)
wav = torch.from_numpy(data.T.copy())  # channels first, as Demucs expects

separator = Separator(model=args.model, device=device)
_, stems = separator.separate_tensor(wav, rate)

os.makedirs(args.folder, exist_ok=True)
paths = {}
for name, audio in stems.items():
    audio = audio.cpu()
    peak = audio.abs().max().item()
    if peak > 0.99:
        audio = audio * (0.99 / peak)  # avoid clipping
    path = os.path.join(args.folder, f"{name}.wav")
    sf.write(path, audio.numpy().T, separator.samplerate)
    paths[name] = path
print(json.dumps({"stems": paths, "device": device}))

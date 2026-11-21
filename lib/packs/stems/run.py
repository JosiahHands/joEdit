# Split music into stems with Demucs (htdemucs): vocals, drums, bass and other.
# Usage: python run.py <in.wav> <out-folder> [--model htdemucs] [--device auto|cpu|mps|cuda]
# The input should be a 44.1 kHz stereo wav (voice.ts prepares it).
# Prints one line of JSON: {"stems": {name: path}, "device", "seconds", "ramGb"}.
# Runs as a joEdit worker too (see ../joedit_pack.py): the model stays loaded between songs.
import argparse
import os
import sys
import warnings

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import joedit_pack

warnings.filterwarnings("ignore")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")  # run any missing Apple GPU steps on the processor

parser = argparse.ArgumentParser()
parser.add_argument("input")
parser.add_argument("folder")
parser.add_argument("--model", default="htdemucs")
parser.add_argument("--device", default="auto")


# `node joedit.ts install stems` runs this once to add the model; after that every run is offline.
def download():
    from demucs.api import Separator

    Separator(model="htdemucs", device="cpu")  # loading the model fetches it into joEdit's pack folder
    return {"downloaded": "htdemucs"}


def load():
    return {}  # the model is chosen per job (--model, --device), and kept once loaded


def make(models, args, progress):
    import soundfile as sf
    import torch
    from demucs.api import Separator

    device = args.device
    if device == "auto":
        device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
    key = (args.model, device)
    if key not in models:
        models.clear()  # one model in memory at a time
        models[key] = Separator(model=args.model, device=device)
    separator = models[key]

    data, rate = sf.read(args.input, dtype="float32", always_2d=True)
    wav = torch.from_numpy(data.T.copy())  # channels first, as Demucs expects
    progress(phase="separating")
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
    return {"stems": paths, "device": device}


if __name__ == "__main__":
    joedit_pack.main("stems", parser, download, load, make)

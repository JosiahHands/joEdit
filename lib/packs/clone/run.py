# Voice cloning with Chatterbox: say new words in the voice of a short sample (5-20 seconds is best).
# Usage: python run.py <out.wav> --sample voice.wav --text "..." [--emotion 0.5] [--pace 0.5]
# Prints one line of JSON: {"duration", "device", "seconds", "ramGb"}.
# Runs as a joEdit worker too (see ../joedit_pack.py): the model stays loaded between lines.
# Chatterbox adds an inaudible watermark (Perth) to everything it makes, so it can be identified as AI speech.
import argparse
import os
import sys
import warnings

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import joedit_pack

warnings.filterwarnings("ignore")

parser = argparse.ArgumentParser()
parser.add_argument("output")
parser.add_argument("--sample", required=True)
parser.add_argument("--text", required=True)
parser.add_argument("--emotion", type=float, default=0.5)  # 0.25 calm ... 1.0 very expressive
parser.add_argument("--pace", type=float, default=0.5)  # lower = slower, more deliberate


# `node joedit.ts install clone` runs this once to add the model; after that every run is offline.
def download():
    from huggingface_hub import snapshot_download

    snapshot_download("ResembleAI/chatterbox")
    return {"downloaded": "ResembleAI/chatterbox"}


def load():
    import torch

    # Apple GPU (mps), NVIDIA GPU (cuda), or the processor.
    device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
    # The model files were saved on an NVIDIA GPU; load them onto whatever this computer has.
    original_load = torch.load
    torch.load = lambda *a, **k: original_load(*a, **{**k, "map_location": torch.device(device)})
    from chatterbox.tts import ChatterboxTTS

    return {"model": ChatterboxTTS.from_pretrained(device=device), "device": device}


def make(models, args, progress):
    import torchaudio

    model = models["model"]
    progress(phase="speaking")
    speech = model.generate(args.text, audio_prompt_path=args.sample, exaggeration=args.emotion, cfg_weight=args.pace)
    torchaudio.save(args.output, speech.cpu(), model.sr)
    return {"duration": round(speech.shape[-1] / model.sr, 2), "device": models["device"]}


if __name__ == "__main__":
    joedit_pack.main("clone", parser, download, load, make)

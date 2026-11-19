# Depth maps with Depth Anything V2 Small: near = white, far = black.
# Usage: python run.py <out.png> <picture>
# Prints one line of JSON: {"width", "height", "device"}.
import argparse
import json
import warnings

warnings.filterwarnings("ignore")

import torch
from PIL import Image
from transformers import pipeline

parser = argparse.ArgumentParser()
parser.add_argument("output")
parser.add_argument("picture")
args = parser.parse_args()

device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
estimate = pipeline("depth-estimation", model="depth-anything/Depth-Anything-V2-Small-hf", device=device)
picture = Image.open(args.picture).convert("RGB")
depth = estimate(picture)["depth"]  # a grayscale picture, already scaled to the input size
depth = depth.resize(picture.size, Image.BICUBIC)
depth.save(args.output)
print(json.dumps({"width": picture.width, "height": picture.height, "device": device}))

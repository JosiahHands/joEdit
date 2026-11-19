# Video clips from a description, or from a starting picture plus a description, with Wan 2.2 TI2V-5B.
# Usage: python run.py <frames-folder> --prompt "..." [--image start.png] [--seconds 5] [--width 1280] [--height 704] [--steps 50] [--seed N]
# Writes <frames-folder>/00000.png, 00001.png, ... (24 frames a second; joEdit turns them into a video).
# Prints one line of JSON: {"frames", "fps", "width", "height", "seed", "device"}.
import argparse
import json
import os
import random
import sys
import warnings

warnings.filterwarnings("ignore")

parser = argparse.ArgumentParser()
parser.add_argument("folder")
parser.add_argument("--prompt", required=True)
parser.add_argument("--image", default=None)
parser.add_argument("--seconds", type=float, default=5)
parser.add_argument("--width", type=int, default=1280)
parser.add_argument("--height", type=int, default=704)
parser.add_argument("--steps", type=int, default=50)
parser.add_argument("--seed", type=int, default=-1)
args = parser.parse_args()

# Model progress goes to stderr so the last stdout line is our JSON.
real_stdout = sys.stdout
sys.stdout = sys.stderr

import torch
from diffusers import AutoencoderKLWan, WanImageToVideoPipeline, WanPipeline
from PIL import Image

MODEL = "Wan-AI/Wan2.2-TI2V-5B-Diffusers"
FPS = 24
seed = args.seed if args.seed >= 0 else random.randint(0, 2**31 - 1)
# The model works in blocks of 32 pixels, and with 4n + 1 frames.
width = max(256, round(args.width / 32) * 32)
height = max(256, round(args.height / 32) * 32)
frames = int(round(args.seconds * FPS / 4)) * 4 + 1

device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
dtype = torch.bfloat16 if device != "cpu" else torch.float32
vae = AutoencoderKLWan.from_pretrained(MODEL, subfolder="vae", torch_dtype=torch.float32)
Pipeline = WanImageToVideoPipeline if args.image else WanPipeline
pipe = Pipeline.from_pretrained(MODEL, vae=vae, torch_dtype=dtype)
if device == "cuda":
    pipe.enable_model_cpu_offload()  # keeps only the part that is working on the GPU
else:
    pipe.to(device)

options = dict(
    prompt=args.prompt,
    negative_prompt="blurry, low quality, distorted, watermark, text, static, still picture",
    height=height,
    width=width,
    num_frames=frames,
    guidance_scale=5.0,
    num_inference_steps=args.steps,
    generator=torch.Generator("cpu").manual_seed(seed),
)
if args.image:
    options["image"] = Image.open(args.image).convert("RGB").resize((width, height))
video = pipe(**options).frames[0]  # a list of frames, values 0..1

os.makedirs(args.folder, exist_ok=True)
for n, frame in enumerate(video):
    Image.fromarray((frame * 255).round().clip(0, 255).astype("uint8")).save(os.path.join(args.folder, f"{n:05d}.png"))

sys.stdout = real_stdout
print(json.dumps({"frames": len(video), "fps": FPS, "width": width, "height": height, "seed": seed, "device": device}))

# Pictures from a text description with Z-Image Turbo.
# Usage: python run.py <out.png> --prompt "..." [--width 1024] [--height 1024] [--steps 9] [--seed N]
# Prints one line of JSON: {"seed", "width", "height", "engine"}.
import argparse
import json
import os
import platform
import random
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument("output")
parser.add_argument("--prompt", required=True)
parser.add_argument("--width", type=int, default=1024)
parser.add_argument("--height", type=int, default=1024)
parser.add_argument("--steps", type=int, default=9)
parser.add_argument("--seed", type=int, default=-1)
args = parser.parse_args()

seed = args.seed if args.seed >= 0 else random.randint(0, 2**31 - 1)
# The model works in blocks of 16 pixels.
width = max(256, round(args.width / 16) * 16)
height = max(256, round(args.height / 16) * 16)

if sys.platform == "darwin" and platform.machine() == "arm64":
    # Apple Silicon: MLX through mflux, with the ready-made 4-bit model (small download, fast).
    engine = "mflux"
    command = os.path.join(os.path.dirname(sys.executable), "mflux-generate-z-image-turbo")
    subprocess.run(
        [command, "--model", "filipstrand/Z-Image-Turbo-mflux-4bit", "--prompt", args.prompt,
         "--width", str(width), "--height", str(height), "--steps", str(args.steps), "--seed", str(seed),
         "--output", args.output],
        check=True,
        stdout=sys.stderr,  # keep stdout for the JSON result
    )
else:
    import torch
    from diffusers import ZImagePipeline

    engine = "diffusers"
    device = "cuda" if torch.cuda.is_available() else "cpu"
    pipe = ZImagePipeline.from_pretrained("Tongyi-MAI/Z-Image-Turbo", torch_dtype=torch.bfloat16).to(device)
    image = pipe(
        prompt=args.prompt, width=width, height=height, num_inference_steps=args.steps,
        guidance_scale=0.0, generator=torch.Generator(device).manual_seed(seed),
    ).images[0]
    image.save(args.output)

print(json.dumps({"seed": seed, "width": width, "height": height, "engine": engine}))

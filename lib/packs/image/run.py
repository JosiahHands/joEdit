# Pictures from a text description with Z-Image Turbo.
# Usage: python run.py <out.png> --prompt "..." [--width 1024] [--height 1024] [--steps 9] [--seed N]
# Prints one line of JSON: {"seed", "width", "height", "engine", "seconds", "ramGb"}, plus "vramGb" (peak GPU memory) on NVIDIA.
# Runs as a joEdit worker too (see ../joedit_pack.py): the model stays loaded between pictures.
import argparse
import os
import platform
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import joedit_pack

APPLE = sys.platform == "darwin" and platform.machine() == "arm64"
MODEL = "filipstrand/Z-Image-Turbo-mflux-4bit" if APPLE else "Tongyi-MAI/Z-Image-Turbo"

parser = argparse.ArgumentParser()
parser.add_argument("output")
parser.add_argument("--prompt", required=True)
parser.add_argument("--width", type=int, default=1024)
parser.add_argument("--height", type=int, default=1024)
parser.add_argument("--steps", type=int, default=9)
parser.add_argument("--seed", type=int, default=-1)


# `node joedit.ts install image` runs this once to add the model; after that every run is offline.
def download():
    from huggingface_hub import snapshot_download

    snapshot_download(MODEL)
    return {"downloaded": MODEL}


def mflux_options(flags):
    """mflux's own options for these flags (its parser only reads sys.argv)."""
    from mflux.models.z_image.cli.z_image_turbo_generate import build_parser

    saved, sys.argv = sys.argv, ["mflux", "--model", MODEL, *flags]
    try:
        return build_parser().parse_args()
    finally:
        sys.argv = saved


def load():
    if APPLE:
        # Apple Silicon: MLX through mflux, with the ready-made 4-bit model (small, fast).
        from mflux.models.z_image.cli.z_image_turbo_generate import ZImageTurboCommand

        return {"engine": "mflux", "model": ZImageTurboCommand.load(mflux_options(["--prompt", "-"]))}
    import torch
    from diffusers import ZImagePipeline

    device = "cuda" if torch.cuda.is_available() else "cpu"
    pipe = ZImagePipeline.from_pretrained(MODEL, torch_dtype=torch.bfloat16)
    if device == "cuda" and torch.cuda.get_device_properties(0).total_memory < 20 * 1024**3:
        # Cards under 20 GB (8-16 GB is common) can't hold the whole model: the weights stay in RAM and each layer
        # moves onto the GPU only while it runs. Layer by layer fits where whole parts (enable_model_cpu_offload) spill over.
        pipe.enable_group_offload(onload_device="cuda", offload_device="cpu", offload_type="leaf_level", use_stream=False)
    else:
        pipe = pipe.to(device)
    return {"engine": "diffusers", "pipe": pipe, "device": device}


def make(models, args, progress):
    seed = args.seed if args.seed >= 0 else random.randint(0, 2**31 - 1)
    # The model works in blocks of 16 pixels.
    width = max(256, round(args.width / 16) * 16)
    height = max(256, round(args.height / 16) * 16)
    if models["engine"] == "mflux":
        from mflux.models.z_image.cli.z_image_turbo_generate import ZImageTurboCommand

        options = mflux_options(["--prompt", args.prompt, "--width", str(width), "--height", str(height), "--steps", str(args.steps), "--output", args.output])
        progress(phase="drawing")
        ZImageTurboCommand.generate(models["model"], options, seed, args.prompt).save(path=args.output)
    else:
        import torch

        def step_done(pipe, step, timestep, values):
            progress(step + 1, args.steps)
            return values

        image = models["pipe"](
            prompt=args.prompt, width=width, height=height, num_inference_steps=args.steps, guidance_scale=0.0,
            generator=torch.Generator(models["device"]).manual_seed(seed), callback_on_step_end=step_done,
        ).images[0]
        image.save(args.output)
    return {"seed": seed, "width": width, "height": height, "engine": models["engine"]}


if __name__ == "__main__":
    joedit_pack.main("image", parser, download, load, make)

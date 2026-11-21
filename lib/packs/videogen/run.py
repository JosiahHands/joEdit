# Video clips from a description, or from a starting picture plus a description, with FastWan 2.2 TI2V-5B
# (Wan 2.2 TI2V-5B distilled to 3 steps by FastVideo, Apache-2.0).
# Usage: python run.py <frames-folder> --prompt "..." [--image start.png] [--seconds 5] [--width 0] [--height 0]
#                      [--steps 3] [--seed N] [--memory auto|full|gpu|offload|small]
# Writes <frames-folder>/00000.png, 00001.png, ... (24 frames a second; joEdit turns them into a video).
# Prints one line of JSON: {"frames", "fps", "width", "height", "pieces", "memory", "seed", "device", "seconds", "ramGb"}, plus "vramGb" on NVIDIA.
# Runs as a joEdit worker too (see ../joedit_pack.py): the model stays loaded between clips.
#
# How it fits on small computers (the --memory plan, picked from the GPU and RAM unless given):
#   full     24 GB+ NVIDIA: everything on the GPU, up to 1280x704.
#   gpu      14-24 GB: the video model on the GPU, the text model only while reading the prompt; up to 960x544.
#   offload  10-14 GB: the video model streams onto the GPU layer by layer; up to 832x480.
#   small    under 10 GB: 4-bit video and text models (saved once, then loaded quickly); up to 832x480.
#   mps      Apple Silicon: shared memory; up to 1280x704 with 48 GB+, else 832x480.
# The text model (11 GB) is never in memory at the same time as the video model when RAM is tight; prompts are
# remembered, so more takes of the same prompt skip it. The VAE (which turns the result into pictures) works in tiles.
# Longer clips are made in pieces of up to 5 seconds: each piece starts from the last frame of the one before,
# and its colours are matched to the first piece, so the joins do not jump.
import argparse
import gc
import math
import os
import random
import sys
import warnings

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import joedit_pack

warnings.filterwarnings("ignore")

MODEL = "FastVideo/FastWan2.2-TI2V-5B-FullAttn-Diffusers"
DMD_STEPS = [1000, 757, 522]  # the noise levels FastWan was distilled for (out of 1000)
FPS = 24
PIECE_SECONDS = 5  # the model makes up to 121 frames (5 seconds) at a time
# The biggest picture each memory plan renders (width x height); joEdit upscales to the size asked for.
MAX_SIZE = {"full": (1280, 704), "gpu": (960, 544), "offload": (832, 480), "small": (832, 480), "mps": (832, 480), "cpu": (512, 288)}

parser = argparse.ArgumentParser()
parser.add_argument("folder")
parser.add_argument("--prompt", required=True)  # one description, or "first | then | then" for each 5-second piece
parser.add_argument("--image", default=None)
parser.add_argument("--seconds", type=float, default=5)
parser.add_argument("--width", type=int, default=0)  # 0 = the biggest this computer renders well
parser.add_argument("--height", type=int, default=0)
parser.add_argument("--steps", type=int, default=3)
parser.add_argument("--seed", type=int, default=-1)
parser.add_argument("--memory", default="auto", choices=["auto", "full", "gpu", "offload", "small", "mps", "cpu"])


# `node joedit.ts install videogen` runs this once to add the model; after that every run is offline.
def download():
    from huggingface_hub import snapshot_download

    snapshot_download(MODEL, allow_patterns=["model_index.json", "scheduler/*", "text_encoder/*", "tokenizer/*", "transformer/*", "vae/*"])
    return {"downloaded": MODEL}


def memory_plan(device, wanted):
    """Which way to run, from the GPU memory and RAM joEdit measured (JOEDIT_VRAM_GB, JOEDIT_RAM_GB)."""
    import torch

    if wanted != "auto":
        return wanted
    ram = float(os.environ.get("JOEDIT_RAM_GB") or 0)
    if device == "mps":
        return "mps"
    if device != "cuda":
        return "cpu"
    vram = torch.cuda.get_device_properties(0).total_memory / 1e9
    return "full" if vram >= 22 else "gpu" if vram >= 14 else "offload" if vram >= 10 and ram >= 24 else "small"


def load():
    import torch

    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    ram = float(os.environ.get("JOEDIT_RAM_GB") or 0)
    # The models are loaded by the first clip (the plan can change per clip with --memory).
    return {"device": device, "ram": ram, "embeds": {}}


def saved_4bit(part):
    """Where the 4-bit copy of a model part is kept (made the first time the "small" plan runs)."""
    home = os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface")
    return os.path.join(home, "fastwan-4bit", part)


def free(models, *names):
    import torch

    for name in names:
        models.pop(name, None)
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    if torch.backends.mps.is_available():
        torch.mps.empty_cache()


def tight_ram(models, plan):
    """True when the text model (11 GB) and the video model (10 GB) should not be in memory together."""
    return plan == "small" or models["ram"] < 48


def encode(models, plan, prompts, progress):
    """The prompt as numbers the video model reads (umT5). Loads the text model only when a prompt is new."""
    import torch
    from transformers import T5TokenizerFast, UMT5EncoderModel

    new = [p for p in prompts if p not in models["embeds"]]
    if not new:
        return
    progress(phase="reading the prompt")
    device = models["device"]
    if "text" not in models:
        if tight_ram(models, plan):
            free(models, "transformer", "pipes")  # make room: the video model is loaded again after this
        if plan == "small":
            from transformers import BitsAndBytesConfig

            if not os.path.exists(saved_4bit("text_encoder")):
                quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16)
                text = UMT5EncoderModel.from_pretrained(MODEL, subfolder="text_encoder", quantization_config=quant, torch_dtype=torch.bfloat16)
                text.save_pretrained(saved_4bit("text_encoder"))
            else:
                text = UMT5EncoderModel.from_pretrained(saved_4bit("text_encoder"), torch_dtype=torch.bfloat16)
        else:
            text = UMT5EncoderModel.from_pretrained(MODEL, subfolder="text_encoder", torch_dtype=torch.bfloat16)
            # The text model runs where there is room: on the GPU when it is big, else on the CPU (slower, but only once per prompt).
            text.to(device if plan in ("full", "mps") else "cpu")
        models["text"] = text
        models["tokenizer"] = T5TokenizerFast.from_pretrained(MODEL, subfolder="tokenizer")  # (AutoTokenizer wants a config.json this repo lacks)
    text, tokenizer = models["text"], models["tokenizer"]
    for prompt in new:
        tokens = tokenizer([prompt], padding="max_length", max_length=512, truncation=True, add_special_tokens=True, return_attention_mask=True, return_tensors="pt")
        with torch.no_grad():
            at = next(text.parameters()).device
            hidden = text(tokens.input_ids.to(at), tokens.attention_mask.to(at)).last_hidden_state
        # Like diffusers' Wan pipeline: keep the real tokens, then zeros up to 512.
        length = int(tokens.attention_mask.sum())
        embed = torch.zeros(1, 512, hidden.shape[-1], dtype=torch.bfloat16)
        embed[0, :length] = hidden[0, :length].to("cpu", torch.bfloat16)
        models["embeds"][prompt] = embed
    if tight_ram(models, plan):
        free(models, "text", "tokenizer")


class DMDScheduler:
    """FastWan's 3-step sampler (distribution matching distillation): at each noise level the model predicts the clean
    clip; it is then noised again to the next, lower level with fresh noise, and the last prediction is the result."""

    order = 1

    def __init__(self, generator):
        import torch

        self.generator = generator
        self.config = type("Config", (), {"num_train_timesteps": 1000})()
        self.timesteps = torch.tensor(DMD_STEPS, dtype=torch.float32)
        self.sigmas = torch.tensor([s / 1000 for s in DMD_STEPS] + [0.0])

    def set_timesteps(self, num_inference_steps=None, device=None, **kwargs):
        import torch

        steps = DMD_STEPS[: max(1, min(len(DMD_STEPS), num_inference_steps or len(DMD_STEPS)))]
        self.timesteps = torch.tensor(steps, dtype=torch.float32, device=device)
        self.sigmas = torch.tensor([s / 1000 for s in steps] + [0.0], device=device)

    def set_begin_index(self, begin_index=0):
        pass

    def step(self, model_output, timestep, sample, return_dict=False, **kwargs):
        import torch

        i = int((self.timesteps - timestep).abs().argmin())
        sigma, after = float(self.sigmas[i]), float(self.sigmas[i + 1])
        clean = sample.float() - sigma * model_output.float()  # flow models predict (noise - clean)
        if after > 0:
            noise = torch.randn(clean.shape, generator=self.generator, dtype=torch.float32).to(clean.device)
            clean = (1 - after) * clean + after * noise
        return (clean.to(sample.dtype),)


def pipelines(models, plan, progress):
    """The text-to-video and picture-to-video pipelines; they share one video model and one VAE."""
    import torch
    from diffusers import AutoencoderKLWan, WanImageToVideoPipeline, WanPipeline, WanTransformer3DModel

    if models.get("plan") != plan:
        free(models, "transformer", "pipes", "vae")
        models["plan"] = plan
    if "pipes" in models:
        return models["pipes"]
    progress(phase="loading the video model")
    device = models["device"]
    dtype = torch.bfloat16 if device != "cpu" else torch.float32
    if plan == "small":
        from diffusers import BitsAndBytesConfig

        if not os.path.exists(saved_4bit("transformer")):
            quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16)
            transformer = WanTransformer3DModel.from_pretrained(MODEL, subfolder="transformer", quantization_config=quant, torch_dtype=torch.bfloat16)
            transformer.save_pretrained(saved_4bit("transformer"))
        else:
            transformer = WanTransformer3DModel.from_pretrained(saved_4bit("transformer"), torch_dtype=torch.bfloat16)
    else:
        transformer = WanTransformer3DModel.from_pretrained(MODEL, subfolder="transformer", torch_dtype=dtype)
        if plan == "offload":
            # Keep the weights in RAM and stream two blocks at a time onto the GPU, while the one before is working.
            transformer.enable_group_offload(onload_device=torch.device("cuda"), offload_device=torch.device("cpu"),
                                             offload_type="block_level", num_blocks_per_group=2, use_stream=True)
        else:
            transformer.to(device)
    if "vae" not in models:
        # The VAE turns the result into pictures. On NVIDIA: full precision, in overlapping tiles below 24 GB (much less
        # memory, same picture). On Apple Silicon tiles are slow (200 s instead of 110 s for 5 seconds at 832x480), so it
        # decodes whole frames in half precision, with the video model set aside first when RAM is tight (see decode).
        half = plan in ("small", "mps")
        vae = AutoencoderKLWan.from_pretrained(MODEL, subfolder="vae", torch_dtype=torch.bfloat16 if half else torch.float32).to(device)
        if plan not in ("full", "mps"):
            vae.enable_tiling()
        models["vae"] = vae
    vae = models["vae"]
    scheduler = DMDScheduler(torch.Generator("cpu"))
    shared = dict(tokenizer=None, text_encoder=None, transformer=transformer, vae=vae, scheduler=scheduler)
    text_pipe = WanPipeline(**shared, expand_timesteps=True)
    picture_pipe = WanImageToVideoPipeline(**shared, image_processor=None, image_encoder=None, expand_timesteps=True)
    models.update(transformer=transformer, pipes=(text_pipe, picture_pipe))
    return models["pipes"]


def decode(models, plan, latents, progress):
    """The finished latents as frames (frames x height x width x 3, values 0..1)."""
    import numpy
    import torch

    progress(phase="turning it into pictures")
    if plan == "mps" and tight_ram(models, plan):
        free(models, "transformer", "pipes")  # whole-frame decoding needs ~17 GB; the video model is loaded again next time
    vae = models["vae"]
    latents = latents.to(vae.device, vae.dtype)
    mean = torch.tensor(vae.config.latents_mean).view(1, vae.config.z_dim, 1, 1, 1).to(latents.device, latents.dtype)
    spread = torch.tensor(vae.config.latents_std).view(1, vae.config.z_dim, 1, 1, 1).to(latents.device, latents.dtype)
    with torch.no_grad():
        video = vae.decode(latents * spread + mean, return_dict=False)[0]  # batch x 3 x frames x height x width, -1..1
    frames = ((video[0].float().clamp(-1, 1) + 1) / 2).permute(1, 2, 3, 0).cpu().numpy()
    del video, latents
    free(models)
    return numpy.asarray(frames, dtype=numpy.float32)


def render_size(plan, width, height):
    """The size to render: the one asked for, made smaller (same shape) when it is bigger than this plan renders well.
    The model works in blocks of 32 pixels."""
    most_w, most_h = MAX_SIZE[plan]
    if not width or not height:
        width, height = most_w, most_h
    scale = min(1.0, math.sqrt((most_w * most_h) / (width * height)))
    return max(256, round(width * scale / 32) * 32), max(256, round(height * scale / 32) * 32)


def match_colours(frames, reference):
    """Shift each colour channel's average and spread to the reference piece's (so a long clip does not drift)."""
    import numpy

    mean, spread = frames.mean(axis=(0, 1, 2)), frames.std(axis=(0, 1, 2)) + 1e-6
    ref_mean, ref_spread = reference
    return numpy.clip((frames - mean) / spread * ref_spread + ref_mean, 0, 1)


def make(models, args, progress):
    import numpy
    import torch
    from PIL import Image

    plan = memory_plan(models["device"], args.memory)
    if plan == "small" and models["device"] != "cuda":
        raise ValueError("--memory small needs an NVIDIA GPU (its 4-bit models run with CUDA).")
    seed = args.seed if args.seed >= 0 else random.randint(0, 2**31 - 1)
    if not 1 <= args.steps <= len(DMD_STEPS):
        raise ValueError(f"--steps is 1 to {len(DMD_STEPS)} for FastWan (3 is the best).")
    if not 0.5 <= args.seconds <= 60:
        raise ValueError("--seconds is 0.5 to 60.")
    width, height = render_size(plan, args.width, args.height)
    prompts = [p.strip() for p in args.prompt.split("|") if p.strip()]
    pieces = math.ceil(args.seconds / PIECE_SECONDS - 1e-9)
    piece_prompts = [prompts[min(k, len(prompts) - 1)] for k in range(pieces)]

    encode(models, plan, list(dict.fromkeys(piece_prompts)), progress)
    generator = torch.Generator("cpu").manual_seed(seed)

    start = Image.open(args.image).convert("RGB").resize((width, height), Image.LANCZOS) if args.image else None
    clip, reference = [], None
    for k in range(pieces):
        seconds = args.seconds / pieces
        frames = int(round(seconds * FPS / 4)) * 4 + 1  # the model makes 4n + 1 frames
        if k > 0:
            frames += 1  # the first frame repeats the last one of the piece before, and is dropped

        def step_done(pipe, step, timestep, values, k=k):
            progress(k * args.steps + step + 1, pieces * args.steps, phase=f"piece {k + 1} of {pieces}" if pieces > 1 else None)
            return values

        options = dict(prompt=None, prompt_embeds=models["embeds"][piece_prompts[k]].to(models["device"]), negative_prompt_embeds=None, height=height, width=width,
                       num_frames=frames, guidance_scale=1.0, num_inference_steps=args.steps, generator=generator,
                       callback_on_step_end=step_done, output_type="latent")
        progress(k * args.steps, pieces * args.steps, phase=f"piece {k + 1} of {pieces}" if pieces > 1 else "making the clip")
        # (Loaded again if the last decode set it aside. No reference is kept here, so decode can free it.)
        pipe = pipelines(models, plan, progress)[0 if start is None else 1]
        pipe.scheduler.generator = generator
        latents = (pipe(**options) if start is None else pipe(image=start, **options)).frames
        del pipe
        video = decode(models, plan, latents, progress)
        if reference is None:
            reference = (video.mean(axis=(0, 1, 2)), video.std(axis=(0, 1, 2)) + 1e-6)
        else:
            video = match_colours(video, reference)[1:]
        clip.extend(video)
        start = Image.fromarray((video[-1] * 255).round().astype("uint8"))
        free(models)  # give back the memory the piece used

    os.makedirs(args.folder, exist_ok=True)
    for n, frame in enumerate(clip):
        Image.fromarray((frame * 255).round().clip(0, 255).astype("uint8")).save(os.path.join(args.folder, f"{n:05d}.png"))
    return {"frames": len(clip), "fps": FPS, "width": width, "height": height, "pieces": pieces, "memory": plan, "seed": seed, "device": models["device"]}


if __name__ == "__main__":
    joedit_pack.main("videogen", parser, download, load, make)

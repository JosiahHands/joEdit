# Whole songs from a description (and lyrics) with ACE-Step 1.5.
# Usage: python run.py <work-folder> --prompt "..." [--lyrics "..."] [--duration 30] [--bpm N] [--seed N] [--steps 8]
# Prints one line of JSON: {"file", "duration", "seed", "device", "tier", "lm", "backend", "offload", "seconds"}, plus "vramGb" on NVIDIA.
# The models (several GB) download into checkpoints/ next to this pack's environment the first time.
import argparse
import json
import os
import sys
import time
import warnings

warnings.filterwarnings("ignore")

parser = argparse.ArgumentParser()
parser.add_argument("folder", nargs="?")
parser.add_argument("--prompt", default="")
# `node joedit.ts install song` runs this once with --download: loading the models adds them; after that every run is offline.
parser.add_argument("--download", action="store_true")
parser.add_argument("--lyrics", default="")
parser.add_argument("--duration", type=float, default=30)
parser.add_argument("--bpm", type=int, default=None)
parser.add_argument("--seed", type=int, default=-1)
# Diffusion steps. The turbo model is tuned for 8 and takes at most 20 (more are clamped). It ignores guidance (fixed at 1).
parser.add_argument("--steps", type=int, default=8)
args = parser.parse_args()
started = time.time()

# Keep ACE-Step's models inside joEdit's pack folder (lib/.packs/song/checkpoints).
home = os.path.dirname(os.path.dirname(sys.executable))
os.environ.setdefault("ACESTEP_PROJECT_ROOT", home)
os.environ.setdefault("ACESTEP_CHECKPOINTS_DIR", os.path.join(home, "checkpoints"))

# ACE-Step writes progress to stdout; send it to stderr so the last stdout line is our JSON.
real_stdout = sys.stdout
sys.stdout = sys.stderr

import torch
from acestep.gpu_config import find_best_lm_model_on_disk, get_gpu_config, resolve_lm_backend
from acestep.handler import AceStepHandler
from acestep.inference import GenerationConfig, GenerationParams, generate_music
from acestep.llm_inference import LLMHandler

apple = torch.backends.mps.is_available()
device = "mps" if apple else "cuda" if torch.cuda.is_available() else "cpu"

# A fixed seed seeds every random source: ACE-Step only seeds its language model when it makes several songs at once.
if args.seed >= 0:
    import random

    import numpy

    random.seed(args.seed)
    numpy.random.seed(args.seed)
    torch.manual_seed(args.seed)  # also seeds CUDA and MPS
    if apple:
        import mlx.core

        mlx.core.random.seed(args.seed)

# ACE-Step's own settings for this GPU's memory (tiers: <=4, 4-6, 6-8, 8-12, 12-16, 16-20, 20-24 GB, more):
# whether parts wait in RAM until they run (offload), and which language model fits.
gpu = get_gpu_config()
offload = gpu.offload_to_cpu_default
checkpoints = os.environ["ACESTEP_CHECKPOINTS_DIR"]
on_disk = sorted(name for name in os.listdir(checkpoints) if name.startswith("acestep-5Hz-lm-")) if os.path.isdir(checkpoints) else []
# The tier's language model if it is on disk, else the 1.7B that `install song` adds. Tiers under 6 GB skip it (no "thinking").
use_lm = args.download or gpu.init_lm_default
lm_model = (find_best_lm_model_on_disk(gpu.recommended_lm_model, on_disk) or "acestep-5Hz-lm-1.7B") if use_lm else None
# vLLM is the fast engine on Linux NVIDIA; Windows has no vLLM, so it uses plain PyTorch ("pt"); Macs use MLX.
backend = "pt" if sys.platform == "win32" else resolve_lm_backend(None, gpu)

dit = AceStepHandler()
status, ok = dit.initialize_service(
    project_root=home, config_path="acestep-v15-turbo", device="auto",
    offload_to_cpu=offload, offload_dit_to_cpu=gpu.offload_dit_to_cpu_default,
)
if not ok:
    raise SystemExit(f"ACE-Step music model failed to load: {status}")

llm = LLMHandler()
if lm_model:
    status, ok = llm.initialize(
        checkpoint_dir=checkpoints, lm_model_path=lm_model, backend=backend, device="auto", offload_to_cpu=offload, dtype=None,
    )
    if not ok:
        raise SystemExit(f"ACE-Step language model failed to load: {status}")
if args.download:
    sys.stdout = real_stdout
    print(json.dumps({"downloaded": "ACE-Step 1.5"}))
    sys.exit(0)
if not args.folder or not args.prompt:
    raise SystemExit("Give a work folder and --prompt.")

lyrics = args.lyrics.strip()
params = GenerationParams(
    task_type="text2music",
    thinking=bool(lm_model),  # the language model plans the song first when there is one
    caption=args.prompt,
    lyrics=lyrics or "[Instrumental]",
    instrumental=not lyrics,
    bpm=args.bpm,
    duration=args.duration,
    inference_steps=args.steps,
    seed=args.seed,
)
# A fixed seed (>= 0) makes the same song again; -1 picks a new random one.
fixed = args.seed >= 0
config = GenerationConfig(batch_size=1, audio_format="wav", use_random_seed=not fixed, seeds=[args.seed] if fixed else None)
result = generate_music(dit, llm, params=params, config=config, save_dir=args.folder)
if not result.success:
    raise SystemExit(f"Song generation failed: {result.status_message}")

audio = result.audios[0]
sys.stdout = real_stdout
seed = audio.get("params", {}).get("seed", args.seed)
report = {
    "file": audio["path"], "duration": args.duration, "seed": seed, "device": device,
    "tier": gpu.tier, "lm": lm_model, "backend": backend if lm_model else None, "offload": offload,
    "seconds": round(time.time() - started, 1),
}
if device == "cuda":
    report["vramGb"] = round(torch.cuda.max_memory_allocated() / 1024**3, 1)  # the most GPU memory the run used
print(json.dumps(report))

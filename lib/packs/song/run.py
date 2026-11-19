# Whole songs from a description (and lyrics) with ACE-Step 1.5.
# Usage: python run.py <work-folder> --prompt "..." [--lyrics "..."] [--duration 30] [--bpm N] [--seed N]
# Prints one line of JSON: {"file", "duration", "seed", "device"}.
# The models (several GB) download into checkpoints/ next to this pack's environment the first time.
import argparse
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")

parser = argparse.ArgumentParser()
parser.add_argument("folder")
parser.add_argument("--prompt", required=True)
parser.add_argument("--lyrics", default="")
parser.add_argument("--duration", type=float, default=30)
parser.add_argument("--bpm", type=int, default=None)
parser.add_argument("--seed", type=int, default=-1)
args = parser.parse_args()

# Keep ACE-Step's models inside joEdit's pack folder (lib/.packs/song/checkpoints).
home = os.path.dirname(os.path.dirname(sys.executable))
os.environ.setdefault("ACESTEP_PROJECT_ROOT", home)
os.environ.setdefault("ACESTEP_CHECKPOINTS_DIR", os.path.join(home, "checkpoints"))

# ACE-Step writes progress to stdout; send it to stderr so the last stdout line is our JSON.
real_stdout = sys.stdout
sys.stdout = sys.stderr

import torch
from acestep.handler import AceStepHandler
from acestep.inference import GenerationConfig, GenerationParams, generate_music
from acestep.llm_inference import LLMHandler

apple = torch.backends.mps.is_available()
device = "mps" if apple else "cuda" if torch.cuda.is_available() else "cpu"

dit = AceStepHandler()
status, ok = dit.initialize_service(project_root=home, config_path="acestep-v15-turbo", device="auto", offload_to_cpu=False)
if not ok:
    raise SystemExit(f"ACE-Step music model failed to load: {status}")

llm = LLMHandler()
status, ok = llm.initialize(
    checkpoint_dir=os.environ["ACESTEP_CHECKPOINTS_DIR"],
    lm_model_path="acestep-5Hz-lm-1.7B",  # downloaded together with the main model
    backend="mlx" if apple else "vllm" if torch.cuda.is_available() else "pt",
    device="auto",
    offload_to_cpu=False,
    dtype=None,
)
if not ok:
    raise SystemExit(f"ACE-Step language model failed to load: {status}")

lyrics = args.lyrics.strip()
params = GenerationParams(
    task_type="text2music",
    thinking=True,
    caption=args.prompt,
    lyrics=lyrics or "[Instrumental]",
    instrumental=not lyrics,
    bpm=args.bpm,
    duration=args.duration,
    inference_steps=8,
    guidance_scale=1.0,
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
print(json.dumps({"file": audio["path"], "duration": args.duration, "seed": seed, "device": device}))

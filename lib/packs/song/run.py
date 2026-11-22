# Whole songs from a description (and lyrics) with ACE-Step 1.5, plus singing over an instrumental and
# remaking one part of a song.
# Usage: python run.py <work-folder> --prompt "..." [--lyrics "..."] [--duration 30] [--bpm N] [--seed N] [--steps N]
#                      [--model turbo|sft|base|xl] [--task song|sing|repaint] [--source song.wav] [--start S] [--end S]
#                      [--guidance 7]
#   song     a new song from the description (and lyrics).
#   sing     a vocal track sung over --source (an instrumental), from --lyrics; the base model's "lego" task.
#   repaint  remakes --start..--end seconds of --source to the description (and lyrics), keeping the rest.
# Prints one line of JSON: {"file", "duration", "seed", "model", "device", "tier", "lm", "backend", "offload", "seconds", "ramGb"}, plus "vramGb" on NVIDIA.
# Runs as a joEdit worker too (see ../joedit_pack.py): the models stay loaded between songs.
# The models (several GB) download into checkpoints/ next to this pack's environment when it is installed;
# `install song --extra sft,base,xl` adds the bigger models (JOEDIT_EXTRA).
import argparse
import os
import sys
import warnings

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import joedit_pack

warnings.filterwarnings("ignore")

# The music models: turbo is fast (8 steps, no guidance); sft follows the prompt more closely (guided, ~32 steps);
# base can also add a track to existing music (sing); xl is the 4-billion-parameter sft (best, biggest).
MODELS = {"turbo": "acestep-v15-turbo", "sft": "acestep-v15-sft", "base": "acestep-v15-base", "xl": "acestep-v15-xl-sft"}
STEPS = {"turbo": 8, "sft": 32, "base": 32, "xl": 32}

parser = argparse.ArgumentParser()
parser.add_argument("folder")
parser.add_argument("--prompt", required=True)
parser.add_argument("--lyrics", default="")
parser.add_argument("--duration", type=float, default=30)
parser.add_argument("--bpm", type=int, default=None)
parser.add_argument("--seed", type=int, default=-1)
parser.add_argument("--steps", type=int, default=0)  # 0 = the model's own (turbo 8, the others 32); turbo takes at most 20
parser.add_argument("--model", default="", choices=["", *MODELS])  # "" = turbo (base for sing)
parser.add_argument("--task", default="song", choices=["song", "sing", "repaint"])
parser.add_argument("--source", default=None)
parser.add_argument("--start", type=float, default=0)
parser.add_argument("--end", type=float, default=-1)
parser.add_argument("--language", default="unknown")  # the lyrics' language (en, es, ja …): sing and repaint can't detect it
parser.add_argument("--guidance", type=float, default=7.0)  # how closely the guided models follow the prompt (turbo ignores it)

# Keep ACE-Step's models inside joEdit's pack folder (lib/.packs/song/checkpoints).
home = os.path.dirname(os.path.dirname(sys.executable))
os.environ.setdefault("ACESTEP_PROJECT_ROOT", home)
os.environ.setdefault("ACESTEP_CHECKPOINTS_DIR", os.path.join(home, "checkpoints"))
CHECKPOINTS = os.environ["ACESTEP_CHECKPOINTS_DIR"]


def load(downloading=False):
    import torch
    from acestep.gpu_config import find_best_lm_model_on_disk, get_gpu_config, resolve_lm_backend
    from acestep.handler import AceStepHandler
    from acestep.llm_inference import LLMHandler

    apple = torch.backends.mps.is_available()
    # ACE-Step's own settings for this GPU's memory (tiers: <=4, 4-6, 6-8, 8-12, 12-16, 16-20, 20-24 GB, more):
    # whether parts wait in RAM until they run (offload), and which language model fits.
    gpu = get_gpu_config()
    offload = gpu.offload_to_cpu_default
    on_disk = sorted(name for name in os.listdir(CHECKPOINTS) if name.startswith("acestep-5Hz-lm-")) if os.path.isdir(CHECKPOINTS) else []
    # The tier's language model if it is on disk, else the 1.7B that `install song` adds. Tiers under 6 GB skip it (no "thinking").
    use_lm = downloading or gpu.init_lm_default
    lm_model = (find_best_lm_model_on_disk(gpu.recommended_lm_model, on_disk) or "acestep-5Hz-lm-1.7B") if use_lm else None
    # vLLM is the fast engine on Linux NVIDIA; Windows has no vLLM, so it uses plain PyTorch ("pt"); Macs use MLX.
    backend = "pt" if sys.platform == "win32" else resolve_lm_backend(None, gpu)

    llm = LLMHandler()
    if lm_model:
        status, ok = llm.initialize(
            checkpoint_dir=CHECKPOINTS, lm_model_path=lm_model, backend=backend, device="auto", offload_to_cpu=offload, dtype=None,
        )
        if not ok:
            raise SystemExit(f"ACE-Step language model failed to load: {status}")
    device = "mps" if apple else "cuda" if torch.cuda.is_available() else "cpu"
    models = {"dit": AceStepHandler(), "model": None, "llm": llm, "lm": lm_model, "backend": backend if lm_model else None,
              "offload": offload, "offload_dit": gpu.offload_dit_to_cpu_default, "tier": gpu.tier, "device": device}
    use_model(models, "turbo")
    return models


def use_model(models, name):
    """Load this music model (one at a time: switching swaps it, the language model stays)."""
    if models["model"] == name:
        return
    if not os.path.isdir(os.path.join(CHECKPOINTS, MODELS[name])):
        raise ValueError(f'The "{name}" song model is not installed. Run: node joedit.ts install song --extra {name}')
    # Free the model in use first (ACE-Step only does this on NVIDIA), so two never share the memory.
    if models["model"]:
        import gc
        import torch
        dit = models["dit"]
        dit.model = None
        dit.mlx_decoder = None
        models["model"] = None
        gc.collect()
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
    status, ok = models["dit"].initialize_service(
        project_root=home, config_path=MODELS[name], device="auto",
        offload_to_cpu=models["offload"], offload_dit_to_cpu=models["offload_dit"],
    )
    if not ok and "out of memory" in status:
        # The worker stays usable: the next request loads its own model.
        models["dit"].model = None
        import gc
        gc.collect()
        raise ValueError(f'The "{name}" song model does not fit in this computer\'s free memory '
                         "(xl needs about 20 GB on Apple Silicon, where it runs in 32-bit, and about 10 GB on NVIDIA). "
                         "Use --model turbo or sft, or close other programs.")
    if not ok:
        raise SystemExit(f"ACE-Step music model {name} failed to load: {status}")
    models["model"] = name


# `node joedit.ts install song` runs this once: it downloads the models, then loads them to check; after that every run is offline.
# JOEDIT_EXTRA (from `install song --extra sft,xl`) adds the bigger music models.
def download():
    from acestep.model_downloader import ensure_main_model
    from huggingface_hub import snapshot_download

    extra = [name.strip() for name in os.environ.get("JOEDIT_EXTRA", "").split(",") if name.strip()]
    for name in extra:
        if name not in MODELS:
            raise SystemExit(f"Unknown song model {name}. Models: {', '.join(MODELS)}")
    # The main download first: turbo, the VAE, the text encoder and the 1.7B language model, which load() needs.
    ok, status = ensure_main_model(CHECKPOINTS)
    if not ok:
        raise SystemExit(f"ACE-Step download failed: {status}")
    for name in extra:
        snapshot_download("ACE-Step/" + MODELS[name], local_dir=os.path.join(CHECKPOINTS, MODELS[name]))
    load(downloading=True)
    return {"downloaded": "ACE-Step 1.5", "extra": extra}


def seed_everything(seed, device):
    """A fixed seed seeds every random source: ACE-Step only seeds its language model when it makes several songs at once."""
    import random

    import numpy
    import torch

    random.seed(seed)
    numpy.random.seed(seed)
    torch.manual_seed(seed)  # also seeds CUDA and MPS
    if device == "mps":
        import mlx.core

        mlx.core.random.seed(seed)


def make(models, args, progress):
    from acestep.constants import TASK_INSTRUCTIONS
    from acestep.inference import GenerationConfig, GenerationParams, generate_music

    name = args.model or ("base" if args.task == "sing" else "turbo")
    if args.task == "sing" and name != "base":
        raise ValueError("sing uses the base model (the only one that adds a track to existing music).")
    if args.task != "song" and not args.source:
        raise ValueError(f"{args.task} needs --source (the music to work on).")
    if models["model"] != name:
        progress(phase=f"loading the {name} model")
        use_model(models, name)
    if args.seed >= 0:
        seed_everything(args.seed, models["device"])

    lyrics = args.lyrics.strip()
    common = dict(caption=args.prompt, bpm=args.bpm, inference_steps=args.steps or STEPS[name], seed=args.seed, guidance_scale=args.guidance)
    if args.task == "song":
        params = GenerationParams(
            task_type="text2music", thinking=bool(models["lm"]),  # the language model plans the song first when there is one
            lyrics=lyrics or "[Instrumental]", instrumental=not lyrics, duration=args.duration, **common,
        )
    elif args.task == "sing":
        # "lego": the base model writes one new track (here the lead vocal) that fits the music it hears.
        params = GenerationParams(
            task_type="lego", instruction=TASK_INSTRUCTIONS["lego"].format(TRACK_NAME="VOCALS"), src_audio=args.source,
            thinking=False, lyrics=lyrics, instrumental=False, vocal_language=args.language,
            repainting_start=args.start, repainting_end=args.end, **common,
        )
    else:
        # "repaint": the part between start and end is made again; the music around it stays as it was.
        params = GenerationParams(
            task_type="repaint", instruction=TASK_INSTRUCTIONS["repaint"], src_audio=args.source, thinking=False,
            lyrics=lyrics or "[Instrumental]", instrumental=not lyrics, vocal_language=args.language,
            repainting_start=args.start, repainting_end=args.end, **common,
        )
    # A fixed seed (>= 0) makes the same song again; -1 picks a new random one.
    fixed = args.seed >= 0
    config = GenerationConfig(batch_size=1, audio_format="wav", use_random_seed=not fixed, seeds=[args.seed] if fixed else None)
    # ACE-Step reports progress as a fraction with a description.
    report = lambda fraction, desc=None, **_: progress(round(fraction * 100), 100, phase=desc)
    result = generate_music(models["dit"], models["llm"], params=params, config=config, save_dir=args.folder, progress=report)
    if not result.success:
        raise SystemExit(f"Song generation failed: {result.status_message}")
    audio = result.audios[0]
    return {
        "file": audio["path"], "duration": args.duration, "seed": audio.get("params", {}).get("seed", args.seed), "model": name,
        "device": models["device"], "tier": models["tier"], "lm": models["lm"], "backend": models["backend"], "offload": models["offload"],
    }


if __name__ == "__main__":
    joedit_pack.main("song", parser, download, load, make)

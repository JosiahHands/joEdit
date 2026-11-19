# Score pictures against a text description with SigLIP 2.
# Usage: python run.py --query "a red car" --cache embeddings.npz <picture> [more pictures...]
# Picture embeddings are saved in --cache, so searching the same pictures again only reads the text.
# Prints one line of JSON: {"scores": [0..1 for each picture]}.
import argparse
import json
import os
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import torch
from PIL import Image
from transformers import AutoModel, AutoProcessor

parser = argparse.ArgumentParser()
parser.add_argument("pictures", nargs="+")
parser.add_argument("--query", required=True)
parser.add_argument("--cache", default=None)
args = parser.parse_args()

MODEL = "google/siglip2-base-patch16-224"
device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
model = AutoModel.from_pretrained(MODEL).to(device).eval()
processor = AutoProcessor.from_pretrained(MODEL)


def normalized(vectors):
    # Newer transformers return an output object; the embedding is its pooled output.
    if not torch.is_tensor(vectors):
        vectors = vectors.pooler_output
    return vectors / vectors.norm(dim=-1, keepdim=True)


# Picture embeddings: from the cache if it has exactly these pictures, otherwise computed in batches.
embeddings = None
if args.cache and os.path.exists(args.cache):
    saved = np.load(args.cache, allow_pickle=False)
    if list(saved["names"]) == [os.path.basename(p) for p in args.pictures]:
        embeddings = torch.from_numpy(saved["vectors"]).to(device)
if embeddings is None:
    parts = []
    with torch.no_grad():
        for start in range(0, len(args.pictures), 32):
            batch = [Image.open(p).convert("RGB") for p in args.pictures[start : start + 32]]
            inputs = processor(images=batch, return_tensors="pt").to(device)
            parts.append(normalized(model.get_image_features(**inputs)))
    embeddings = torch.cat(parts)
    if args.cache:
        names = np.array([os.path.basename(p) for p in args.pictures])
        np.savez(args.cache, names=names, vectors=embeddings.cpu().numpy())

with torch.no_grad():
    # SigLIP 2 was trained on lowercase text padded to 64 tokens.
    inputs = processor(text=[args.query.lower()], padding="max_length", max_length=64, return_tensors="pt").to(device)
    text = normalized(model.get_text_features(**inputs))
    logits = (embeddings @ text.T).squeeze(-1) * model.logit_scale.exp() + model.logit_bias
    scores = torch.sigmoid(logits).cpu().tolist()

print(json.dumps({"scores": [round(s, 4) for s in scores], "device": device}))

# Remove the background from pictures with rembg (BiRefNet model).
# Usage: python run.py <out-folder> <picture> [more pictures...] [--mask] [--model birefnet-general-lite]
# Writes <out-folder>/<n>.png for each picture (see-through background, or a black/white mask with --mask).
# Prints one line of JSON: {"files": [...]}.
import argparse
import json
import os

from PIL import Image
from rembg import new_session, remove

parser = argparse.ArgumentParser()
parser.add_argument("folder")
parser.add_argument("pictures", nargs="+")
parser.add_argument("--mask", action="store_true")
parser.add_argument("--model", default="birefnet-general-lite")
args = parser.parse_args()

# The model is downloaded the first time and then loaded once for all pictures.
session = new_session(args.model)
os.makedirs(args.folder, exist_ok=True)
files = []
for n, path in enumerate(args.pictures):
    picture = Image.open(path).convert("RGB")
    result = remove(picture, session=session, only_mask=args.mask, post_process_mask=True)
    out = os.path.join(args.folder, f"{n}.png")
    result.save(out)
    files.append(out)
print(json.dumps({"files": files, "model": args.model}))

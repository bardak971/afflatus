"""The pod base's Python packages, locked: base/requirements-<cuda>.lock, one per CUDA build, made by this script.

The base (base/Dockerfile) installs every Python package from its lock alone, by version and SHA-256 (pip's
--require-hashes): what PyPI or PyTorch's index serve under a name later, or a package a requirement list leaves open
picked anew at the next build, never gets in unnoticed (the 2026-11-02 review, L10). The lock is resolved here, once, by uv,
for the image's platform (Linux x86_64, CPython 3.12), from what the base installs: ComfyUI's requirements and its
Manager's at the commit the Dockerfile pins, the built-in packs' lists at theirs (VideoHelperSuite, KJNodes, the Impact
Pack without sam2, its Subpack), torch from PyTorch's index for that CUDA, and the image's own packages below (InsightFace, ONNX
Runtime, Ultralytics, PySceneDetect, psutil, av, nvidia-ml-py). Its first line says what it was made from:
tests/test_image.py fails when the Dockerfile has moved on since.

    python deploy/runpod/base_lock.py      (needs uv and the network; writes both locks)

Each package is one line, its hashes on it, so that the Dockerfile takes its layers' parts with grep.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(HERE, "base")
CUDAS = ("cu130", "cu128")

# the image's own packages, beside ComfyUI's and the packs' lists: InsightFace and ONNX Runtime (Face Match), Ultralytics
# and PySceneDetect (Face refine), at the versions the owner's ComfyUI runs; psutil, av and nvidia-ml-py (the packs')
OWN = ["insightface==0.7.3", "onnxruntime==1.20.1", "ultralytics==8.4.163", "scenedetect==0.7.2", "psutil", "av", "nvidia-ml-py"]

# the lists read at the Dockerfile's commits: (its ARG, the repository, the file)
LISTS = [
    ("COMFYUI_COMMIT", "comfyanonymous/ComfyUI", "requirements.txt"),
    ("COMFYUI_COMMIT", "comfyanonymous/ComfyUI", "manager_requirements.txt"),
    ("VHS_COMMIT", "Kosinkadink/ComfyUI-VideoHelperSuite", "requirements.txt"),
    ("KJNODES_COMMIT", "kijai/ComfyUI-KJNodes", "requirements.txt"),
    ("IMPACT_COMMIT", "ltdrdata/ComfyUI-Impact-Pack", "requirements.txt"),
    ("SUBPACK_COMMIT", "ltdrdata/ComfyUI-Impact-Subpack", "requirements.txt"),
]
# what the made-from line names, in this order
MADE_FROM = ("COMFYUI_COMMIT", "VHS_COMMIT", "KJNODES_COMMIT", "IMPACT_COMMIT", "SUBPACK_COMMIT", "TORCH_VERSION", "TORCHVISION_VERSION", "TORCHAUDIO_VERSION")


def args_of(dockerfile_text):
    """The Dockerfile's ARG defaults, by name."""
    return dict(re.findall(r"(?m)^ARG (\w+)=(\S+)$", dockerfile_text))


def made_from(args, own=OWN):
    """The lock's first line: what it was made from, as the test compares it with the Dockerfile."""
    return "# made by deploy/runpod/base_lock.py from " + " ".join(f"{k}={args[k]}" for k in MADE_FROM) + " own=" + ",".join(own)


def wanted(text):
    """A requirement list's lines worth resolving: no comment, no blank, no git source (Impact's sam2, which the image leaves
    out: only its SAM2 models import it, which no Afflatus route loads)."""
    out = []
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if line and not line.startswith(("git+", "-")) and "sam2" not in line:
            out.append(line)
    return out


def one_line_each(compiled):
    """uv's output (a package, then its hashes on lines continued with a backslash, then comments) as one line per package."""
    lines, current = [], None
    for raw in compiled.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("--hash="):
            current.append(line.rstrip("\\").strip())
            continue
        if current:
            lines.append(" ".join(current))
        current = [line.rstrip("\\").strip()]
    if current:
        lines.append(" ".join(current))
    return lines


def pyproject(requirements, args, cuda):
    deps = ",\n".join(f'  "{r}"' for r in requirements)
    return f'''[project]
name = "afflatus-pod-base"
version = "0"
requires-python = "==3.12.*"
dependencies = [
{deps},
  "torch=={args["TORCH_VERSION"]}", "torchvision=={args["TORCHVISION_VERSION"]}", "torchaudio=={args["TORCHAUDIO_VERSION"]}",
]

[[tool.uv.index]]
name = "pytorch"
url = "https://download.pytorch.org/whl/{cuda}"
explicit = true

[tool.uv.sources]
torch = {{ index = "pytorch" }}
torchvision = {{ index = "pytorch" }}
torchaudio = {{ index = "pytorch" }}
'''


def main():
    with open(os.path.join(BASE, "Dockerfile"), encoding="utf-8") as f:
        args = args_of(f.read())
    requirements = []
    for arg, repo, name in LISTS:
        url = f"https://raw.githubusercontent.com/{repo}/{args[arg]}/{name}"
        with urllib.request.urlopen(url, timeout=60) as res:
            requirements += wanted(res.read().decode("utf-8"))
    # torch is ComfyUI's, unpinned there: the Dockerfile's versions, from PyTorch's index, take its place
    requirements = [r for r in dict.fromkeys(requirements + OWN) if not re.match(r"(?i)^(torch|torchvision|torchaudio)\b", r)]
    for cuda in CUDAS:
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "pyproject.toml"), "w", encoding="utf-8") as f:
                f.write(pyproject(requirements, args, cuda))
            out = os.path.join(tmp, "lock.txt")
            # the lock as it stands, where uv reads the versions to keep: a list added (a pack built in) brings its own
            # packages, and moves none of the others to whatever PyPI has newest now (uv pip compile prefers the output
            # file's pins; --upgrade would not)
            kept = os.path.join(BASE, f"requirements-{cuda}.lock")
            if os.path.exists(kept):
                shutil.copyfile(kept, out)
            subprocess.run(["uv", "pip", "compile", "pyproject.toml", "--python-platform", "x86_64-manylinux_2_28", "--python-version", "3.12", "--generate-hashes", "--no-header", "--no-annotate", "-o", out], cwd=tmp, check=True)
            with open(out, encoding="utf-8") as f:
                lines = one_line_each(f.read())
        with open(os.path.join(BASE, f"requirements-{cuda}.lock"), "w", encoding="utf-8", newline="\n") as f:
            f.write(made_from(args) + "\n" + "\n".join(lines) + "\n")
        print(f"requirements-{cuda}.lock: {len(lines)} packages")


if __name__ == "__main__":
    sys.exit(main())

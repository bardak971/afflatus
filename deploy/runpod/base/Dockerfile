# The Afflatus pod's base: everything heavy and slow to change, under the pod image proper (../Dockerfile, FROM this one by
# its digest). The OS, PyTorch with its CUDA libraries (the 3.7 GB layer), ComfyUI at its pinned commit and its Manager,
# the built-in node packs with their Python packages, NVIDIA's VFX runtime, InsightFace. A pod tag then pushes a few MB
# instead of ~9 GB (each tag's two builds shared no layer with the last, 2026-10-19), and a RunPod host that already holds
# this base pulls only the top.
#
#   built and pushed by .github/workflows/pod-base-image.yml on a pod-base-v* tag:
#   ghcr.io/bardak971/afflatus-pod-base:<n> (CUDA 13.0) and :<n>-cu128
#
# A new base is made only when something here changes: a ComfyUI or torch upgrade, a pack's commit, InsightFace,
# nvidia-vfx. Then ../Dockerfile's FROM is pointed at the new digests and a pod-v* tag builds the top on it. The top's
# workflow checks the base it builds on was built from this file as it stands in that commit (the label below), so a change
# here can't ship without its base.
#
# It copies nothing: its build context is this folder, which holds this file only.
#
# The base is one exact python:3.12-slim-bookworm, pinned by the digest of its multi-arch index, as the app's own
# Dockerfile is. Torch comes from PyTorch's CUDA wheels, which carry their CUDA libraries; the host gives the driver. Two
# builds of the same torch: CUDA 13.0 (TORCH_CUDA=cu130, the default, as ComfyUIs at home run it now) and 12.8 (cu128, for
# a GPU whose hosts do not offer 13); Afflatus asks RunPod for a host whose driver runs the one it deploys.

FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258

# the ComfyUI release the image is built on: the one Afflatus is tested against
ARG COMFYUI_VERSION=v0.41.2
# the commit that tag names: a tag can be moved, a commit cannot
ARG COMFYUI_COMMIT=b53f77a74e21091cbdebfdf7b85fc80326932646
# PyTorch's build and versions: torch, torchvision and torchaudio of one release, for one CUDA
ARG TORCH_CUDA=cu130
ARG TORCH_VERSION=2.10.0
ARG TORCHVISION_VERSION=0.25.0
ARG TORCHAUDIO_VERSION=2.10.0
# the sha256 of this file with LF line ends, given by the workflow: the top's build compares it with the file in its own
# commit (pod-image.yml), which a label made from inside the file could not be
ARG BASE_DOCKERFILE_SHA256=

LABEL org.opencontainers.image.title="afflatus-pod-base" \
      afflatus.comfyui="${COMFYUI_VERSION}" \
      afflatus.torch="${TORCH_VERSION}" \
      afflatus.cuda="${TORCH_CUDA}" \
      afflatus.base-dockerfile-sha256="${BASE_DOCKERFILE_SHA256}"

ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 DEBIAN_FRONTEND=noninteractive
# what NVIDIA's own CUDA images set: the GPU and its compute libraries handed to the container by the host's runtime
ENV NVIDIA_VISIBLE_DEVICES=all NVIDIA_DRIVER_CAPABILITIES=compute,utility
# the ComfyUI it carries, said to what runs on it; the top says its own for Manager's registry list (its COMFYUI_VERSION,
# held equal to this one by test_image.py) since 0.1.27, made outside the base
ENV AFFLATUS_COMFYUI_VERSION="${COMFYUI_VERSION}"

# git for the Manager (it clones node packs), ffmpeg for the video nodes, the GL and GLib libraries OpenCV wants
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ffmpeg libgl1 libglib2.0-0 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${COMFYUI_VERSION}" https://github.com/comfyanonymous/ComfyUI /comfyui \
 && test "$(git -C /comfyui rev-parse HEAD)" = "${COMFYUI_COMMIT}"
WORKDIR /comfyui

# torch's CUDA libraries first, in layers of their own, at the very versions torch's wheel asks for (its metadata on
# PyTorch's index, read here): torch, its libraries and ComfyUI's packages were one 3.7 GB layer, pulled as one stream.
# A host pulls a few layers at once and retries a dropped one alone, and may cap each stream (2026-10-19, US-WA-1: three
# layers at 78 MB/s together, the big one then alone at 35; EU-RO-1: one layer crawling at 5 MB/s, dropped at 1.8 GB and
# begun again). pip -c holds each to torch's pin, so torch's install below finds them all there: the same packages at the
# same versions as one install gives. NCCL stays although a pod has one GPU: libtorch_cuda.so links it (NEEDED
# libnccl.so.2), and torch does not import without it (checked 2026-10-20).
RUN python -c "import os, re, urllib.request; c, v = os.environ['TORCH_CUDA'], os.environ['TORCH_VERSION']; m = urllib.request.urlopen(f'https://download.pytorch.org/whl/{c}/torch-{v}%2B{c}-cp312-cp312-manylinux_2_28_x86_64.whl.metadata', timeout=60).read().decode(); pins = re.findall(r'^Requires-Dist: ((?:nvidia-[\w-]+|cuda-bindings|triton)==[\w.]+)', m, re.M); assert len(pins) >= 10, pins; open('/torch-cuda.txt', 'w').write('\n'.join(pins) + '\n')"
# each layer one or a few of them, the biggest alone (cu128's cuDNN 0.7 GB, cuBLAS 0.6; cu130's 0.35 and 0.42), the small
# ones they need first; a name that matches none fails the build (pip asks for at least one)
RUN pip install -c /torch-cuda.txt $(grep -E '^(nvidia-cuda-|nvidia-nvjitlink|nvidia-nvtx|nvidia-cufile|nvidia-curand|cuda-bindings|triton)' /torch-cuda.txt | cut -d= -f1)
RUN pip install -c /torch-cuda.txt $(grep -E '^nvidia-cublas' /torch-cuda.txt | cut -d= -f1)
RUN pip install -c /torch-cuda.txt $(grep -E '^nvidia-cudnn' /torch-cuda.txt | cut -d= -f1)
RUN pip install -c /torch-cuda.txt $(grep -E '^nvidia-cusparse' /torch-cuda.txt | cut -d= -f1)
RUN pip install -c /torch-cuda.txt $(grep -E '^nvidia-(cufft|cusolver)' /torch-cuda.txt | cut -d= -f1)
RUN pip install -c /torch-cuda.txt $(grep -E '^nvidia-(nccl|nvshmem)' /torch-cuda.txt | cut -d= -f1)

# torch then, from the CUDA wheels, its libraries all there already (said if one is not); ComfyUI's requirements after it,
# in a layer of their own, so that they find it there; then its Manager's
RUN pip install --index-url "https://download.pytorch.org/whl/${TORCH_CUDA}" "torch==${TORCH_VERSION}" "torchvision==${TORCHVISION_VERSION}" "torchaudio==${TORCHAUDIO_VERSION}" \
 && python -c "import subprocess; have = set(subprocess.check_output(['pip', 'freeze'], text=True).split()); lack = [p for p in open('/torch-cuda.txt').read().split() if p not in have]; assert not lack, lack" \
 && pip freeze | grep -iE '^(torch|torchvision|torchaudio)==' > /constraints.txt
RUN pip install -c /constraints.txt -r requirements.txt \
 && if [ -f manager_requirements.txt ]; then pip install -c /constraints.txt -r manager_requirements.txt; else pip install -c /constraints.txt comfyui_manager; fi

# The node packs the built-in forms use most, built in at the commits Afflatus is tested against (packs.ts names their
# nodes): DaSiWa's (H3's step cache, the RTX upscale route), VideoHelperSuite, KJNodes and the MMH3 upscale. Their sources
# stay here with their Python packages, as each commit's requirements go with it. Those packages are held to the image's
# torch; DaSiWa's own list is not, as it asks for llama-cpp-python (a compile) for its LLM nodes, which import it only when
# used: what it imports at load, ComfyUI brings. Its RTX node's nvidia-vfx comes in a layer of its own, below. start.sh puts
# them in ComfyUI's custom_nodes, over an older copy a volume holds.
ARG DASIWA_COMMIT=18ed2d23c36363ead84f35c06bfcc0a5f8b710b2
ARG VHS_COMMIT=4d907bee61e92c2e65af3bd6383a4e4d356126d1
ARG KJNODES_COMMIT=d3cfe21625e5170126ce06fbfcfe1d88108688c3
ARG MMH3_COMMIT=fe6658f6d144066f14150d3526247b417683ff2b
RUN set -e; mkdir -p /opt/packs; cd /opt/packs; \
    pin() { git init -q "$1" && git -C "$1" remote add origin "$2" && git -C "$1" fetch -q --depth 1 origin "$3" && git -C "$1" checkout -q FETCH_HEAD && echo "$1" >> /opt/packs/BUILT_IN; }; \
    pin ComfyUI-DaSiWa-Nodes https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes "${DASIWA_COMMIT}"; \
    pin ComfyUI-VideoHelperSuite https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite "${VHS_COMMIT}"; \
    pin ComfyUI-KJNodes https://github.com/kijai/ComfyUI-KJNodes "${KJNODES_COMMIT}"; \
    pin Comfyui-MMH3-UltimateUpscale https://github.com/bbaudio-2025/Comfyui-MMH3-UltimateUpscale "${MMH3_COMMIT}"; \
    pip install -c /constraints.txt -r ComfyUI-VideoHelperSuite/requirements.txt -r ComfyUI-KJNodes/requirements.txt psutil av nvidia-ml-py

# NVIDIA's Video Effects runtime (the nvvfx module), which DaSiWa's RTX Upscaler & Refiner imports when it runs: without it
# every finish on the RTX VSR route failed on a pod with "NVIDIA RTX VFX (nvvfx) module not found" (2026-10-18). PyPI has a
# stub only; the wheel is NVIDIA's own (pypi.nvidia.com), its libraries inside (VSR, NPP: 443 MB), needing no other
# package, taken by its exact address and checked against its hash
RUN pip install --no-deps "nvidia-vfx @ https://pypi.nvidia.com/nvidia-vfx/nvidia_vfx-0.2.0.0-cp312-abi3-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl#sha256=0252866a7b798a6f92c8543443d88f716e8c5bbc6a7ddd77a2754728dada9fa8"

# InsightFace and ONNX Runtime for the node pack's Face Match (how much a face in a render is the person it is of: the
# pictures a Motion transfer is made from, a clip's face along its run), on the CPU. InsightFace's own package is built
# from source (a small extension): the compilers come for that and go after. Its face models (buffalo_l, ~300 MB) are not
# in the image: their licence is for non-commercial research, so the image does not hand them out; the pod fetches them from
# InsightFace's own release at its start (start.sh), into the models folder, where a volume keeps them for the next pod
RUN apt-get update && apt-get install -y --no-install-recommends build-essential  && pip install -c /constraints.txt insightface==0.7.3 onnxruntime==1.20.1  && apt-get purge -y build-essential && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# every pip run after this one holds torch to the image's build: ComfyUI-Manager's installs of node packs too (a pack's
# requirement that pulls another torch would swap the CUDA one for one that does not run here)
ENV PIP_CONSTRAINT=/constraints.txt

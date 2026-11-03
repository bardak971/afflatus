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
# nvidia-vfx, a package of its lock. Then ../Dockerfile's FROM is pointed at the new digests and a pod-v* tag builds the top
# on it. The top's workflow checks the base it builds on was built from this folder as it stands in that commit (the label
# below), so a change here can't ship without its base.
#
# Its build context is this folder, which holds this file and its locks only: every Python package is installed from
# requirements-<cuda>.lock alone, at its version and by its SHA-256 (pip's --require-hashes), each install --no-deps, so
# that nothing PyPI or PyTorch's index serve later gets in unnoticed (the 2026-11-02 review, L10). ../base_lock.py makes
# the locks from ComfyUI's and the packs' lists at the commits below; run it again after changing one (tests/test_image.py
# fails until then).
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
# the sha256 of this file and its locks with LF line ends, given by the workflow: the top's build compares it with the
# folder in its own commit (pod-image.yml), which a label made from inside the file could not be
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

# The lock for this CUDA, and `locked <pattern> [pip options]`: its lines that match, installed by their hashes alone. A
# pattern that matches none fails the build (grep), as does a file whose bytes are not the lock's
COPY requirements-${TORCH_CUDA}.lock /base.lock
RUN printf '%s\n' '#!/bin/sh' 'set -e' 'pattern=$1; shift' 'grep -E "$pattern" /base.lock > /tmp/locked.txt' 'pip install --no-deps --require-hashes -r /tmp/locked.txt "$@"' 'rm /tmp/locked.txt' > /usr/local/bin/locked \
 && chmod +x /usr/local/bin/locked

# torch's CUDA libraries first, in layers of their own, at the very versions torch's wheel asks for (the lock has them so):
# torch, its libraries and ComfyUI's packages were one 3.7 GB layer, pulled as one stream. A host pulls a few layers at once
# and retries a dropped one alone, and may cap each stream (2026-10-19, US-WA-1: three layers at 78 MB/s together, the big
# one then alone at 35; EU-RO-1: one layer crawling at 5 MB/s, dropped at 1.8 GB and begun again). NCCL stays although a
# pod has one GPU: libtorch_cuda.so links it (NEEDED libnccl.so.2), and torch does not import without it (checked
# 2026-10-20). Each layer one or a few of them, the biggest alone (cu128's cuDNN 0.7 GB, cuBLAS 0.6; cu130's 0.35 and
# 0.42), the small ones they need first
RUN locked '^(nvidia-cuda-|nvidia-nvjitlink|nvidia-nvtx|nvidia-cufile|nvidia-curand|cuda-bindings|cuda-pathfinder|triton==)'
RUN locked '^nvidia-cublas'
RUN locked '^nvidia-cudnn'
RUN locked '^nvidia-cusparse'
RUN locked '^nvidia-(cufft|cusolver)'
RUN locked '^nvidia-(nccl|nvshmem)'

# torch then, from the CUDA wheels, at the Dockerfile's versions (the lock's, checked)
RUN locked '^(torch|torchvision|torchaudio)==' --index-url "https://download.pytorch.org/whl/${TORCH_CUDA}" \
 && pip freeze | grep -iE '^(torch|torchvision|torchaudio)==' > /constraints.txt \
 && grep -qx "torch==${TORCH_VERSION}+${TORCH_CUDA}" /constraints.txt && grep -qx "torchvision==${TORCHVISION_VERSION}+${TORCH_CUDA}" /constraints.txt && grep -qx "torchaudio==${TORCHAUDIO_VERSION}+${TORCH_CUDA}" /constraints.txt
# Every other package of the lock after it, in a layer of its own: ComfyUI's requirements and its Manager's, the built-in
# packs' (below), the image's own (Ultralytics, PySceneDetect, ONNX Runtime). InsightFace alone comes later, built with its
# compilers. Of ComfyUI's requirements, the workflow templates' pictures and videos and the nodes' docs go again in the same
# layer, never in the image: ~535 MB of the 8.9 GB a pod unpacks at every boot, and unpacking is all of its pull
# (2026-10-25, card #44: downloaded in ~20 s, unpacked in 80-185 s), for what only the browser's Templates and node help
# show, which no pod's ComfyUI is opened for. The templates' index and their workflows stay (core, json): ComfyUI lists them
# without an error, their pictures missing; without the docs it says so at the info level (frontend_management.py at v0.41.2)
RUN grep -vE '^(nvidia-(cu|nv|nccl)|cuda-|triton==|torch==|torchvision==|torchaudio==|insightface==)' /base.lock > /tmp/rest.lock \
 && pip install --no-deps --require-hashes -r /tmp/rest.lock && rm /tmp/rest.lock \
 && pip uninstall -y comfyui-workflow-templates-media-api comfyui-workflow-templates-media-video comfyui-workflow-templates-media-image comfyui-workflow-templates-media-other comfyui-workflow-templates-media-assets-01 comfyui-workflow-templates-media-assets-02 comfyui-embedded-docs \
 && python -c "import comfyui_workflow_templates, comfyui_workflow_templates_json, comfyui_manager"

# The node packs the built-in forms use most, built in at the commits Afflatus is tested against (packs.ts names their
# nodes): DaSiWa's (H3's step cache, the RTX upscale route), VideoHelperSuite, KJNodes, the MMH3 upscale, LTX 2.5's MSR
# references (its LoRA's own loader and guide; it needs no Python package) and Krea2Edit 2.0 (Krea 2's person reference:
# no Python package either; never installed through ComfyUI-Manager, whose only way to 2.0 is its repository's head, read
# at this commit before it was taken). Their Python packages are in the lock, from each commit's requirements; DaSiWa's
# own list is not, as it asks for llama-cpp-python (a compile) for its LLM nodes, which import it only when used: what it
# imports at load, ComfyUI brings. Its RTX node's nvidia-vfx comes in a layer of its own, below. start.sh puts them in
# ComfyUI's custom_nodes, over an older copy a volume holds.
ARG DASIWA_COMMIT=18ed2d23c36363ead84f35c06bfcc0a5f8b710b2
ARG VHS_COMMIT=4d907bee61e92c2e65af3bd6383a4e4d356126d1
ARG KJNODES_COMMIT=d3cfe21625e5170126ce06fbfcfe1d88108688c3
ARG MMH3_COMMIT=fe6658f6d144066f14150d3526247b417683ff2b
ARG MSR_COMMIT=03061c18f8a79d26f3c63931dd8e28f5e5d872a6
ARG KREA2EDIT_COMMIT=13ef60f20828949becada815d3cbc371eb5ccaab
RUN set -e; mkdir -p /opt/packs; cd /opt/packs; \
    pin() { git init -q "$1" && git -C "$1" remote add origin "$2" && git -C "$1" fetch -q --depth 1 origin "$3" && git -C "$1" checkout -q FETCH_HEAD && echo "$1" >> /opt/packs/BUILT_IN; }; \
    pin ComfyUI-DaSiWa-Nodes https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes "${DASIWA_COMMIT}"; \
    pin ComfyUI-VideoHelperSuite https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite "${VHS_COMMIT}"; \
    pin ComfyUI-KJNodes https://github.com/kijai/ComfyUI-KJNodes "${KJNODES_COMMIT}"; \
    pin Comfyui-MMH3-UltimateUpscale https://github.com/bbaudio-2025/Comfyui-MMH3-UltimateUpscale "${MMH3_COMMIT}"; \
    pin ComfyUI-LTX2.5-MSR https://github.com/liconstudio/ComfyUI-LTX2.5-MSR "${MSR_COMMIT}"; \
    pin comfyui-krea2edit https://github.com/lbouaraba/comfyui-krea2edit "${KREA2EDIT_COMMIT}"

# NVIDIA's Video Effects runtime (the nvvfx module), which DaSiWa's RTX Upscaler & Refiner imports when it runs: without it
# every finish on the RTX VSR route failed on a pod with "NVIDIA RTX VFX (nvvfx) module not found" (2026-10-18). PyPI has a
# stub only; the wheel is NVIDIA's own (pypi.nvidia.com), its libraries inside (VSR, NPP: 443 MB), needing no other
# package, taken by its exact address and checked against its hash
RUN pip install --no-deps "nvidia-vfx @ https://pypi.nvidia.com/nvidia-vfx/nvidia_vfx-0.2.0.0-cp312-abi3-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl#sha256=0252866a7b798a6f92c8543443d88f716e8c5bbc6a7ddd77a2754728dada9fa8"

# InsightFace and ONNX Runtime for the node pack's Face Match (how much a face in a render is the person it is of: the
# pictures a Motion transfer is made from, a clip's face along its run), on the CPU. InsightFace's own package is built
# from source (a small extension), its sdist checked by the lock: the compilers come for that and go after (the tools pip
# fetches to build it, in a build environment of its own, are the one thing here no lock holds). Its face models
# (buffalo_l, ~300 MB) are not in the image: their licence is for non-commercial research, so the image does not hand them
# out; the pod fetches them from InsightFace's own release at its start (start.sh), into the models folder, where a volume
# keeps them for the next pod, checked against their release's hashes (face_models.py)
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && locked '^insightface==' && apt-get purge -y build-essential && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Face refine (H3's forms and SCAIL-2 at 24 fps): the pack that tracks and crops the face per frame, sets the denoise by
# face size and pastes it back, built in at the commit Afflatus is tested against; what it imports beside InsightFace,
# ultralytics (its face and person detectors) and PySceneDetect, is in the lock, at the versions the owner's ComfyUI runs. Its models (the
# detectors, SAM, the fused reference turbo) are sent to the pod with the jobs that load them, as any model. Ultralytics is
# AGPL-3.0 (the owner's call, 2026-10-21). start.sh puts the pack in custom_nodes with the others (BUILT_IN)
ARG FACEREFINE_COMMIT=d8521d14fe0d721d80cd9417fff5a559cbc21aba
RUN set -e; cd /opt/packs; \
    git init -q ComfyUI-H3-FaceRefine && git -C ComfyUI-H3-FaceRefine remote add origin https://github.com/Carasibana/ComfyUI-H3-FaceRefine; \
    git -C ComfyUI-H3-FaceRefine fetch -q --depth 1 origin "${FACEREFINE_COMMIT}" && git -C ComfyUI-H3-FaceRefine checkout -q FETCH_HEAD; \
    echo ComfyUI-H3-FaceRefine >> /opt/packs/BUILT_IN
# Ultralytics, left to itself, sends usage events to Google Analytics on each predict (settings' sync, on by default) and
# pip-installs a requirement it finds missing: neither from a pod. YOLO_OFFLINE makes it take itself for offline (no DNS
# check at import, so no events and no Sentry reports), and YOLO_AUTOINSTALL=false stops its installs (ultralytics 8.4's
# utils/__init__.py and checks.py)
ENV YOLO_OFFLINE=1 YOLO_AUTOINSTALL=false

# The Impact Pack, for Face refine's SAM outline (its SAMLoader; the Klein and Flux face detailers use it too), built in at
# the commit the owner's ComfyUI runs (8.28.3): ComfyUI-Manager's install of it failed on every pod, its sam2 requirement
# being built in pip's isolated build env, where /constraints.txt's torch cannot be had (2026-10-23, card #45). Its list is
# in the lock without sam2, which it imports only when there, for its SAM2 models alone: no Afflatus route loads those. Its
# install.py is not run (its one work beside that list is fetching SAM, which the jobs send)
ARG IMPACT_COMMIT=429d0159ad429e64d2b3916e6e7be9c22d025c3c
RUN set -e; cd /opt/packs; \
    git init -q ComfyUI-Impact-Pack && git -C ComfyUI-Impact-Pack remote add origin https://github.com/ltdrdata/ComfyUI-Impact-Pack; \
    git -C ComfyUI-Impact-Pack fetch -q --depth 1 origin "${IMPACT_COMMIT}" && git -C ComfyUI-Impact-Pack checkout -q FETCH_HEAD; \
    echo ComfyUI-Impact-Pack >> /opt/packs/BUILT_IN

# every pip run after this one holds torch to the image's build: ComfyUI-Manager's installs of node packs too (a pack's
# requirement that pulls another torch would swap the CUDA one for one that does not run here)
ENV PIP_CONSTRAINT=/constraints.txt

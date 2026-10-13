# The Afflatus pod: ComfyUI, its Manager and the Afflatus node pack, for a GPU deployed from Afflatus (Settings ›
# Rented GPUs). Nothing else is open on it: one port, 8188, locked from its first second by the node pack, which reads
# the token Afflatus gives the pod as a RunPod secret (AFFLATUS_TOKEN). The node packs and models a render needs are
# fetched by Afflatus after it is up, through the Manager and the node pack's downloader.
#
#   built and pushed by .github/workflows/pod-image.yml on a pod-v* tag: ghcr.io/bardak971/afflatus-pod:<version>
#
# The build context is the repository's root (for comfy-nodes/afflatus-nodes); Dockerfile.dockerignore beside this
# file keeps the rest out of it.
#
# The base is one exact python:3.12-slim-bookworm, pinned by the digest of its multi-arch index, as the app's own
# Dockerfile is. Torch comes from PyTorch's CUDA wheels, which carry their CUDA libraries; the host gives the driver. Two
# builds of the same torch: CUDA 13.0 (TORCH_CUDA=cu130, the default, as ComfyUIs at home run it now) and 12.8 (cu128, for
# a GPU whose hosts do not offer 13); Afflatus asks RunPod for a host whose driver runs the one it deploys.

FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258

# the ComfyUI release the image is built on: the one Afflatus is tested against
ARG COMFYUI_VERSION=v0.37.0
# PyTorch's build and versions: torch, torchvision and torchaudio of one release, for one CUDA
ARG TORCH_CUDA=cu130
ARG TORCH_VERSION=2.10.0
ARG TORCHVISION_VERSION=0.25.0
ARG TORCHAUDIO_VERSION=2.10.0

ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 DEBIAN_FRONTEND=noninteractive
# what NVIDIA's own CUDA images set: the GPU and its compute libraries handed to the container by the host's runtime
ENV NVIDIA_VISIBLE_DEVICES=all NVIDIA_DRIVER_CAPABILITIES=compute,utility

# git for the Manager (it clones node packs), ffmpeg for the video nodes, the GL and GLib libraries OpenCV wants
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ffmpeg libgl1 libglib2.0-0 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${COMFYUI_VERSION}" https://github.com/comfyanonymous/ComfyUI /comfyui
WORKDIR /comfyui

# torch first, from the CUDA wheels, so that ComfyUI's requirements find it there; then ComfyUI's own and its Manager's
RUN pip install --index-url "https://download.pytorch.org/whl/${TORCH_CUDA}" "torch==${TORCH_VERSION}" "torchvision==${TORCHVISION_VERSION}" "torchaudio==${TORCHAUDIO_VERSION}" \
 && pip install -r requirements.txt \
 && if [ -f manager_requirements.txt ]; then pip install -r manager_requirements.txt; else pip install comfyui_manager; fi \
 && pip freeze | grep -iE '^(torch|torchvision|torchaudio)==' > /constraints.txt

COPY comfy-nodes/afflatus-nodes /opt/afflatus-nodes
COPY deploy/runpod/start.sh /start.sh
COPY deploy/runpod/broken.py /opt/afflatus-pod/broken.py
# a checkout on Windows may hand the script over with CRLF: sh would not read its first line
RUN sed -i 's/\r$//' /start.sh && chmod +x /start.sh && rm -rf /opt/afflatus-nodes/tests

EXPOSE 8188
CMD ["/start.sh"]

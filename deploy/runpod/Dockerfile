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
# Dockerfile is. Torch comes from PyTorch's CUDA 12.8 wheels: they carry their CUDA libraries, the host gives the driver
# (Afflatus asks RunPod for hosts with CUDA 12.8 or later).

FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258

# the ComfyUI release the image is built on: the one Afflatus is tested against
ARG COMFYUI_VERSION=v0.37.0

ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 DEBIAN_FRONTEND=noninteractive

# git for the Manager (it clones node packs), ffmpeg for the video nodes, the GL and GLib libraries OpenCV wants
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ffmpeg libgl1 libglib2.0-0 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${COMFYUI_VERSION}" https://github.com/comfyanonymous/ComfyUI /comfyui
WORKDIR /comfyui

# torch first, from the CUDA wheels, so that ComfyUI's requirements find it there; then ComfyUI's own and its Manager's
RUN pip install --index-url https://download.pytorch.org/whl/cu128 torch torchvision torchaudio \
 && pip install -r requirements.txt \
 && if [ -f manager_requirements.txt ]; then pip install -r manager_requirements.txt; else pip install comfyui_manager; fi \
 && pip freeze | grep -iE '^(torch|torchvision|torchaudio)==' > /constraints.txt

COPY comfy-nodes/afflatus-nodes /opt/afflatus-nodes
COPY deploy/runpod/start.sh /start.sh
# a checkout on Windows may hand the script over with CRLF: sh would not read its first line
RUN sed -i 's/\r$//' /start.sh && chmod +x /start.sh && rm -rf /opt/afflatus-nodes/tests

EXPOSE 8188
CMD ["/start.sh"]

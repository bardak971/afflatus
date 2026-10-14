# The Afflatus pod: ComfyUI, its Manager and the Afflatus node pack, for a GPU deployed from Afflatus (Settings ›
# Rented GPUs). Nothing else is open on it: one port, 8188, locked from its first second by the node pack, which reads
# the token Afflatus gives the pod as a RunPod secret (AFFLATUS_TOKEN). The node packs and models a render needs are
# fetched by Afflatus after it is up, through the Manager and the node pack's downloader; the packs most video renders
# use are built in (below), so that a deploy does not install them and restart ComfyUI on billed time.
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
# the commit that tag names: a tag can be moved, a commit cannot
ARG COMFYUI_COMMIT=73c9bad4d21e7addbe1d13bc92eee0f1431b017d
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

RUN git clone --depth 1 --branch "${COMFYUI_VERSION}" https://github.com/comfyanonymous/ComfyUI /comfyui \
 && test "$(git -C /comfyui rev-parse HEAD)" = "${COMFYUI_COMMIT}"
WORKDIR /comfyui

# torch first, from the CUDA wheels, so that ComfyUI's requirements find it there; then ComfyUI's own and its Manager's
RUN pip install --index-url "https://download.pytorch.org/whl/${TORCH_CUDA}" "torch==${TORCH_VERSION}" "torchvision==${TORCHVISION_VERSION}" "torchaudio==${TORCHAUDIO_VERSION}" \
 && pip install -r requirements.txt \
 && if [ -f manager_requirements.txt ]; then pip install -r manager_requirements.txt; else pip install comfyui_manager; fi \
 && pip freeze | grep -iE '^(torch|torchvision|torchaudio)==' > /constraints.txt

# The node packs the built-in forms use most, built in at the commits Afflatus is tested against (packs.ts names their
# nodes): DaSiWa's (H3's step cache, the RTX upscale route), VideoHelperSuite, KJNodes and the MMH3 upscale. Their Python
# packages are installed here, held to the image's torch; DaSiWa's own list is not, as it asks for llama-cpp-python (a
# compile) and nvidia-vfx for its LLM and RTX nodes, which import them only when used: what it imports at load,
# ComfyUI brings. start.sh puts them in ComfyUI's custom_nodes, over an older copy a volume holds.
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

# InsightFace and ONNX Runtime for the node pack's Face Match (how much a face in a render is the person it is of: the
# pictures a Motion transfer is made from, a clip's face along its run), on the CPU. InsightFace's own package is built
# from source (a small extension): the compilers come for that and go after. Its face models (buffalo_l, ~300 MB) are
# fetched now into /opt/insightface, where the node finds them when ComfyUI's models folder has none
RUN apt-get update && apt-get install -y --no-install-recommends build-essential  && pip install -c /constraints.txt insightface==0.7.3 onnxruntime==1.20.1  && python -c "from insightface.app import FaceAnalysis; FaceAnalysis(name='buffalo_l', root='/opt/insightface', allowed_modules=['detection', 'recognition'], providers=['CPUExecutionProvider']).prepare(ctx_id=-1)"  && apt-get purge -y build-essential && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# every pip run after this one holds torch to the image's build: ComfyUI-Manager's installs of node packs too (a pack's
# requirement that pulls another torch would swap the CUDA one for one that does not run here)
ENV PIP_CONSTRAINT=/constraints.txt

# the registry's list of node packs, as Manager caches it: a pod just up installs a pack by its name at once, instead of
# after Manager's own reading of the whole registry (minutes). start.sh puts it in Manager's cache folder
COPY deploy/runpod/registry_cache.py /opt/afflatus-pod/registry_cache.py
RUN python /opt/afflatus-pod/registry_cache.py /opt/afflatus-pod/manager-cache "${COMFYUI_VERSION#v}"

COPY comfy-nodes/afflatus-nodes /opt/afflatus-nodes
COPY deploy/runpod/start.sh /start.sh
COPY deploy/runpod/broken.py /opt/afflatus-pod/broken.py
# a checkout on Windows may hand the script over with CRLF: sh would not read its first line
RUN sed -i 's/\r$//' /start.sh && chmod +x /start.sh && rm -rf /opt/afflatus-nodes/tests

EXPOSE 8188
CMD ["/start.sh"]

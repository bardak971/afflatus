# The Afflatus pod: ComfyUI, its Manager and the Afflatus node pack, for a GPU deployed from Afflatus (Settings ›
# Rented GPUs). Nothing else is open on it: 8188, locked from its first second by the node pack, which reads the token
# Afflatus gives the pod as a RunPod secret (AFFLATUS_TOKEN), and 8189, its boot log (bootlog.py), for that token only.
# The node packs and models a render needs are fetched by Afflatus after it is up, through the Manager and the node pack's
# downloader; the packs most video renders use are built in (the base), so that a deploy does not install them and restart
# ComfyUI on billed time.
#
#   built and pushed by .github/workflows/pod-image.yml on a pod-v* tag: ghcr.io/bardak971/afflatus-pod:<version>
#
# This file is the thin top: what changes often (the node pack, the pod's scripts, Manager's registry list), a few MB. All
# the rest (the OS, PyTorch with CUDA, ComfyUI at its commit, the built-in packs, nvidia-vfx, InsightFace) is the base,
# base/Dockerfile, built a few times a year by a pod-base-v* tag. Two builds of the same torch, as before: CUDA 13.0
# (TORCH_CUDA=cu130, the default) and 12.8 (cu128), each on its own base, pinned by digest so that a moved tag cannot
# change a release; only the stage the build asks for is pulled. A new base: its two digests here, then a pod-v* tag.
# pod-image.yml checks the base was built from base/Dockerfile as it stands in the tagged commit.
#
# The build context is the repository's root (for comfy-nodes/afflatus-nodes); Dockerfile.dockerignore beside this
# file keeps the rest out of it.

ARG BASE_CU130=ghcr.io/bardak971/afflatus-pod-base:1@sha256:b9eab8c9ffd2d1cee76e838c82de2d68792a8242f1dc539019811d0726f103c3
ARG BASE_CU128=ghcr.io/bardak971/afflatus-pod-base:1-cu128@sha256:dd2fd71042a4e6696c811f7ba033da5f5a5003235ea58a15d41931efda26075f
ARG TORCH_CUDA=cu130
FROM ${BASE_CU130} AS base-cu130
FROM ${BASE_CU128} AS base-cu128
FROM base-${TORCH_CUDA}

# the registry's list of node packs, as Manager caches it: a pod just up installs a pack by its name at once, instead of
# after Manager's own reading of the whole registry (minutes). start.sh puts it in Manager's cache folder. REGISTRY_REQUIRED
# set (pod-image.yml, for an image it publishes): a registry that cannot be read fails the build rather than ship an image
# whose every pod waits on billed time for Manager's own reading; a local build goes on without the list
ARG REGISTRY_REQUIRED=
COPY deploy/runpod/registry_cache.py /opt/afflatus-pod/registry_cache.py
RUN python /opt/afflatus-pod/registry_cache.py /opt/afflatus-pod/manager-cache "${AFFLATUS_COMFYUI_VERSION#v}" ${REGISTRY_REQUIRED:+--required}

COPY comfy-nodes/afflatus-nodes /opt/afflatus-nodes
COPY deploy/runpod/start.sh /start.sh
COPY deploy/runpod/broken.py /opt/afflatus-pod/broken.py
COPY deploy/runpod/bootlog.py /opt/afflatus-pod/bootlog.py
COPY deploy/runpod/died.py /opt/afflatus-pod/died.py
# a checkout on Windows may hand the script over with CRLF: sh would not read its first line
RUN sed -i 's/\r$//' /start.sh && chmod +x /start.sh && rm -rf /opt/afflatus-nodes/tests

# 8188: ComfyUI; 8189: the boot log (bootlog.py), for the pod's token only
EXPOSE 8188 8189
CMD ["/start.sh"]

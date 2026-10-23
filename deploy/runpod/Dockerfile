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
# change a release; only the stage the build asks for is used, and its layers are not pulled
# (the last stage copies only). A new base: its two digests here, then a pod-v* tag.
# pod-image.yml checks the base was built from base/Dockerfile as it stands in the tagged commit.
#
# The build context is the repository's root (for comfy-nodes/afflatus-nodes); Dockerfile.dockerignore beside this
# file keeps the rest out of it.

ARG BASE_CU130=ghcr.io/bardak971/afflatus-pod-base:3@sha256:3527fb89a84267dc1d15a88b1b13e74c5fd0b61ab60f0ba0717200172353d481
ARG BASE_CU128=ghcr.io/bardak971/afflatus-pod-base:3-cu128@sha256:0a49f8463cbbde26c8e9d35257e0908b2ac47f73d3a9ff3e5c100eb5d6e46243
ARG TORCH_CUDA=cu130
# the ComfyUI the base is built on (base/Dockerfile's COMFYUI_VERSION; test_image.py holds the two together), for Manager's
# registry list below, made outside the base (the base's AFFLATUS_COMFYUI_VERSION says the same, but only to a stage on it)
ARG COMFYUI_VERSION=v0.41.2

# What the top makes it makes here, on the small Python image the base starts from, not on the base: the last stage then
# only copies, each copy a layer of its own (--link), so the build pushes the top without pulling the base's GBs (6–8 min
# a build when it ran on the base).
FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258 AS made
ARG COMFYUI_VERSION
# the registry's list of node packs, as Manager caches it: a pod just up installs a pack by its name at once, instead of
# after Manager's own reading of the whole registry (minutes). start.sh puts it in Manager's cache folder. REGISTRY_REQUIRED
# set (pod-image.yml, for an image it publishes): a registry that cannot be read fails the build rather than ship an image
# whose every pod waits on billed time for Manager's own reading; a local build goes on without the list
ARG REGISTRY_REQUIRED=
COPY deploy/runpod/registry_cache.py /opt/afflatus-pod/registry_cache.py
RUN python /opt/afflatus-pod/registry_cache.py /opt/afflatus-pod/manager-cache "${COMFYUI_VERSION#v}" ${REGISTRY_REQUIRED:+--required}
# a checkout on Windows may hand the script over with CRLF: sh would not read its first line
COPY deploy/runpod/start.sh /start.sh
RUN sed -i 's/\r$//' /start.sh && chmod +x /start.sh

FROM ${BASE_CU130} AS base-cu130
FROM ${BASE_CU128} AS base-cu128
FROM base-${TORCH_CUDA}
COPY --link --from=made /opt/afflatus-pod /opt/afflatus-pod
COPY --link --from=made /start.sh /start.sh
# the node pack without its tests (Dockerfile.dockerignore leaves them out of the context)
COPY --link comfy-nodes/afflatus-nodes /opt/afflatus-nodes
COPY --link deploy/runpod/broken.py deploy/runpod/bootlog.py deploy/runpod/died.py /opt/afflatus-pod/

# 8188: ComfyUI; 8189: the boot log (bootlog.py), for the pod's token only
EXPOSE 8188 8189
CMD ["/start.sh"]

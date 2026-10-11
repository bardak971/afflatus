"""Afflatus nodes for ComfyUI.

Eleven nodes, all for continuing a MiniMax H3 clip from its own latent rather than from re-encoded pixels:

- Afflatus: Save H3 Latent / Load H3 Latent — a MiniMax H3 video+audio latent as one safetensors file
  (ComfyUI's own SaveLatent cannot store the nested pair); Normalize H3 Latent — a sampled window's audio
  rounded to its own frame boundary, so it can be continued from; Trim H3 Latent — its first frames, for a clip handed over before its end; H3 Tail Guide — the clip before's tail as
  the guide, its decoded frames re-encoded for the picture (a chain of exact latents drifts softer and darker)
  and its exact latent for the sound; H3 Latent Head Guide — the clip after's first tokens anchored at the
  end of the window, for a clip that must land on another; H3 Latent Landing — the same from where any of its
  17-frame chunks begins, for a clip that lands inside another; H3 Seam Latent — a continuation's new tokens after
  the clip before's own last ones, so that decoded, the join is the whole chain's decoded at once.
- MiniMax H3 Guided Continuation Window, Latent Tail Guide, Append Continuation — the native latent-tail
  continuation by ttulttul (MIT, see LICENSE-continuation), vendored with one change: the check for a recent
  enough ComfyUI says "update ComfyUI" when the module it reads is missing, instead of a bare ImportError.

Afflatus writes this pack into ComfyUI's custom_nodes folder itself when it knows the folder (Settings →
ComfyUI); ComfyUI picks it up at its next start. It can also be installed by hand: copy this folder into
custom_nodes/ and restart ComfyUI. Needs ComfyUI 0.3.x with the arbitrary-frame MiniMax H3 guides
(commit e01fb4c or newer).
"""

import os
import re

from comfy_api.latest import ComfyExtension, io

from .continuation_nodes import (
    MiniMaxH3AppendContinuation,
    MiniMaxH3GuidedContinuationWindow,
    MiniMaxH3LatentTailGuide,
)
from .latent_io import AfflatusH3LatentHeadGuide, AfflatusH3LatentLanding, AfflatusH3SeamLatent, AfflatusH3TailGuide, AfflatusLoadH3Latent, AfflatusNormalizeH3Latent, AfflatusSaveH3Latent, AfflatusTrimH3Latent


def _version() -> str:
    """The pack's version, written once in its pyproject.toml: Afflatus reads it there too, to tell an older pack still loaded."""
    try:
        with open(os.path.join(os.path.dirname(__file__), "pyproject.toml"), encoding="utf-8") as f:
            found = re.search(r'^version\s*=\s*"([^"]+)"', f.read(), re.M)
    except OSError:
        return "0"
    return found.group(1) if found else "0"


VERSION = _version()


class AfflatusExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            AfflatusSaveH3Latent,
            AfflatusLoadH3Latent,
            AfflatusNormalizeH3Latent,
            AfflatusTrimH3Latent,
            AfflatusH3TailGuide,
            AfflatusH3LatentHeadGuide,
            AfflatusH3LatentLanding,
            AfflatusH3SeamLatent,
            MiniMaxH3GuidedContinuationWindow,
            MiniMaxH3LatentTailGuide,
            MiniMaxH3AppendContinuation,
        ]


async def comfy_entrypoint() -> AfflatusExtension:
    return AfflatusExtension()


# a safetensors header is a JSON index of the tensors: a few hundred KB on the largest models, so 8 MiB is ample
_HEADER_MOST = 8 * 1024 * 1024


def read_header(path: str):
    """A safetensors file's header, each tensor's dtype and shape and the metadata; None when it is not one."""
    import json
    import struct

    try:
        with open(path, "rb") as f:
            size = struct.unpack("<Q", f.read(8))[0]
            if size <= 0 or size > _HEADER_MOST:
                return None
            header = json.loads(f.read(size))
    except Exception:
        return None
    # a file whose header is not an object (a list, a number) is not a safetensors file
    if not isinstance(header, dict):
        return None
    out = {}
    for key, value in header.items():
        if key == "__metadata__":
            out[key] = value
        elif isinstance(value, dict):
            out[key] = {"dtype": value.get("dtype"), "shape": value.get("shape")}
    return out


# the names ComfyUI's SaveVideo gives the videos Afflatus has it write (filename_prefix "Afflatus/video"): video_00001_.mp4
_OUR_VIDEO = re.compile(r"^video_\d+_\.(mp4|webm)$")


def clean_folder(folder: str, hours: float, ours=lambda name: name.startswith("afflatus_")) -> int:
    """Remove the files directly in `folder` whose names are Afflatus's (`ours`; by default afflatus_*) and that are older than `hours` (never under one hour). How many went."""
    import time

    # never younger than an hour: a picture a queued job is about to read is not taken from under it
    cutoff = time.time() - max(1.0, hours) * 3600
    removed = 0
    if not os.path.isdir(folder):
        return 0
    for name in os.listdir(folder):
        path = os.path.join(folder, name)
        if not ours(name) or not os.path.isfile(path):
            continue
        try:
            if os.path.getmtime(path) < cutoff:
                os.remove(path)
                removed += 1
        except OSError:
            pass
    return removed


def clean_output(output_dir: str, hours: float) -> int:
    """Remove the videos Afflatus had SaveVideo write into output/Afflatus/ that are older than `hours` (never under one hour). How many went."""
    return clean_folder(os.path.join(output_dir, "Afflatus"), hours, lambda name: bool(_OUR_VIDEO.match(name)))


# Small routes on ComfyUI's own web server, for an Afflatus that runs on another machine (its container,
# say) and cannot reach ComfyUI's disk:
#   GET /afflatus/header?folder=loras&filename=x.safetensors  → the file's safetensors header (its metadata,
#       and each tensor's dtype and shape: what tells which model the file is for). 404 when there is no such file.
#   GET /afflatus/version  → this pack's version.
#   POST /afflatus/clean-input {"older_than_hours": 24}  → removes the pictures Afflatus uploaded to input/afflatus/
#       (for nodes that read only from the input folder, the DaSiWa Director) that are older than that. Only files
#       named afflatus_* in that one folder; ComfyUI clears its temp folder itself, not its input folder. A JSON body
#       only: a page of another site cannot send one without asking first.
#       With {"folder": "output"}: the videos ComfyUI's own SaveVideo wrote for Afflatus (when VideoHelperSuite is absent)
#       instead, output/Afflatus/video_<n>_.mp4 only, by the same rules.
#   POST /afflatus/download, GET and DELETE /afflatus/download/<id>  → a model file fetched from Afflatus's one-time
#       address into a model folder, to disk as it comes and picked up again after a cut (downloads.py says how).
# The first two are read-only, the first bytes of a file only, nothing loaded. ComfyUI's own /view_metadata gives the metadata alone.
# The disk is read and written off ComfyUI's event loop, which the progress of a render goes through.
try:
    import asyncio

    import folder_paths
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/afflatus/header")
    async def _afflatus_header(request):
        folder = request.rel_url.query.get("folder")
        name = request.rel_url.query.get("filename")
        if not folder or not name or not name.lower().endswith(".safetensors"):
            return web.Response(status=404)
        try:
            path = folder_paths.get_full_path(folder, name)
        except Exception:
            path = None
        if path is None:
            return web.Response(status=404)
        out = await asyncio.to_thread(read_header, path)
        return web.Response(status=404) if out is None else web.json_response(out)

    @PromptServer.instance.routes.get("/afflatus/version")
    async def _afflatus_version(request):
        return web.json_response({"pack": "afflatus-nodes", "version": VERSION})

    @PromptServer.instance.routes.post("/afflatus/clean-input")
    async def _afflatus_clean_input(request):
        if request.content_type != "application/json":
            return web.Response(status=415, text="a JSON body is expected")
        try:
            body = await request.json()
        except Exception:
            body = {}
        body = body if isinstance(body, dict) else {}
        try:
            hours = float(body.get("older_than_hours", 24))
        except Exception:
            hours = 24.0
        which = body.get("folder", "input")
        if which == "output":
            removed = await asyncio.to_thread(clean_output, folder_paths.get_output_directory(), hours)
        elif which == "input":
            removed = await asyncio.to_thread(clean_folder, os.path.join(folder_paths.get_input_directory(), "afflatus"), hours)
        else:
            return web.Response(status=400, text="the folder is input or output")
        return web.json_response({"removed": removed})

    from .downloads import register as _register_downloads

    _register_downloads(PromptServer.instance.routes, web, folder_paths)
except Exception:
    # outside ComfyUI's server (a bare import, a test): the nodes still load, the routes are simply not there
    pass

"""Afflatus nodes for ComfyUI.

Eight nodes, all for continuing a MiniMax H3 clip from its own latent rather than from re-encoded pixels:

- Afflatus: Save H3 Latent / Load H3 Latent — a MiniMax H3 video+audio latent as one safetensors file
  (ComfyUI's own SaveLatent cannot store the nested pair); Normalize H3 Latent — a sampled window's audio
  rounded to its own frame boundary, so it can be continued from; H3 Tail Guide — the clip before's tail as
  the guide, its decoded frames re-encoded for the picture (a chain of exact latents drifts softer and darker)
  and its exact latent for the sound; H3 Latent Head Guide — the clip after's first tokens anchored at the
  end of the window, for a clip that must land on another.
- MiniMax H3 Guided Continuation Window, Latent Tail Guide, Append Continuation — the native latent-tail
  continuation by ttulttul (MIT, see LICENSE-continuation), vendored unchanged.

Afflatus writes this pack into ComfyUI's custom_nodes folder itself when it knows the folder (Settings →
ComfyUI); ComfyUI picks it up at its next start. It can also be installed by hand: copy this folder into
custom_nodes/ and restart ComfyUI. Needs ComfyUI 0.3.x with the arbitrary-frame MiniMax H3 guides
(commit e01fb4c or newer).
"""

from comfy_api.latest import ComfyExtension, io

from .continuation_nodes import (
    MiniMaxH3AppendContinuation,
    MiniMaxH3GuidedContinuationWindow,
    MiniMaxH3LatentTailGuide,
)
from .latent_io import AfflatusH3LatentHeadGuide, AfflatusH3TailGuide, AfflatusLoadH3Latent, AfflatusNormalizeH3Latent, AfflatusSaveH3Latent

VERSION = "0.4.0"


class AfflatusExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            AfflatusSaveH3Latent,
            AfflatusLoadH3Latent,
            AfflatusNormalizeH3Latent,
            AfflatusH3TailGuide,
            AfflatusH3LatentHeadGuide,
            MiniMaxH3GuidedContinuationWindow,
            MiniMaxH3LatentTailGuide,
            MiniMaxH3AppendContinuation,
        ]


async def comfy_entrypoint() -> AfflatusExtension:
    return AfflatusExtension()


# Two small routes on ComfyUI's own web server, for an Afflatus that runs on another machine (its container,
# say) and cannot read ComfyUI's model files from the disk:
#   GET /afflatus/header?folder=loras&filename=x.safetensors  → the file's safetensors header (its metadata,
#       and each tensor's dtype and shape: what tells which model the file is for). 404 when there is no such file.
#   GET /afflatus/version  → this pack's version.
# Read-only, the first bytes of a file only, nothing loaded. ComfyUI's own /view_metadata gives the metadata alone.
try:
    import json
    import struct

    import folder_paths
    from aiohttp import web
    from server import PromptServer

    _HEADER_MOST = 64 * 1024 * 1024

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
        try:
            with open(path, "rb") as f:
                size = struct.unpack("<Q", f.read(8))[0]
                if size <= 0 or size > _HEADER_MOST:
                    return web.Response(status=404)
                header = json.loads(f.read(size))
        except Exception:
            return web.Response(status=404)
        out = {}
        for key, value in header.items():
            if key == "__metadata__":
                out[key] = value
            elif isinstance(value, dict):
                out[key] = {"dtype": value.get("dtype"), "shape": value.get("shape")}
        return web.json_response(out)

    @PromptServer.instance.routes.get("/afflatus/version")
    async def _afflatus_version(request):
        return web.json_response({"pack": "afflatus-nodes", "version": VERSION})
except Exception:
    # outside ComfyUI's server (a bare import, a test): the nodes still load, the routes are simply not there
    pass

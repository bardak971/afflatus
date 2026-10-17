"""Afflatus nodes for ComfyUI.

Eleven nodes for continuing a MiniMax H3 clip from its own latent rather than from re-encoded pixels, and one more:

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
- Afflatus: Face Match — how much a face in a picture is the person of some photos (InsightFace's ArcFace, on the CPU),
  to rank the pictures a Motion transfer is made from; registered only when insightface is installed.

Afflatus writes this pack into ComfyUI's custom_nodes folder itself when it knows the folder (Settings →
ComfyUI); ComfyUI picks it up at its next start. It can also be installed by hand: copy this folder into
custom_nodes/ and restart ComfyUI. Needs ComfyUI 0.3.x with the arbitrary-frame MiniMax H3 guides
(commit e01fb4c or newer).
"""

import os
import re


def _lock_first():
    """The lock in front of ComfyUI's server before anything else of the pack: nothing the pack does after (a route, an
    import) can leave a locked ComfyUI open by failing first. With AFFLATUS_TOKEN set (a rented pod, reached at a public
    address) and no lock in, ComfyUI stops rather than run open to anyone with its address: the pod never answers, and
    Afflatus ends it at its boot limit. The same with a lock file in ComfyUI's user folder (a ComfyUI locked from Afflatus,
    often behind --listen): it was meant to be locked, so it stops too, and says how to start it open on purpose."""
    try:
        import folder_paths
        from aiohttp import web
        from server import PromptServer
    except ImportError:
        # outside ComfyUI's server (a bare import, a test): no server to lock
        return
    try:
        from .lock import install

        install(PromptServer.instance, web, folder_paths)
    except Exception as err:
        print(f"[afflatus-nodes] the lock could not be put in front of ComfyUI's server: {err}")
        why = _locked_without_lock(folder_paths)
        if why:
            print(f"[afflatus-nodes] {why}")
            os._exit(1)


# lock.py's LOCK_FILE, named here as well: this is read when lock.py itself may be what failed to load
_LOCK_FILE = "afflatus-lock.json"


def _locked_without_lock(folder_paths, env=None):
    """Why ComfyUI must stop when the lock could not be put in, or None when it may run open: the lock is off on purpose
    (AFFLATUS_LOCK=off), or nothing said it should be locked (no AFFLATUS_TOKEN, no lock file)."""
    env = os.environ if env is None else env
    if (env.get("AFFLATUS_LOCK") or "").strip().lower() == "off":
        return None
    if (env.get("AFFLATUS_TOKEN") or "").strip():
        return "AFFLATUS_TOKEN is set and the lock is not in: ComfyUI stops rather than run open."
    try:
        path = os.path.join(folder_paths.get_user_directory(), _LOCK_FILE)
    except Exception:
        # no user folder to read: nothing tells that a lock was set, and a ComfyUI of one's own is not stopped on a guess
        return None
    if os.path.exists(path):
        return f"this ComfyUI is locked ({path}) and the lock is not in: ComfyUI stops rather than run open. To start it open, delete that file or start ComfyUI with AFFLATUS_LOCK=off."
    return None


_lock_first()

from comfy_api.latest import ComfyExtension, io  # noqa: E402

from .continuation_nodes import (  # noqa: E402
    MiniMaxH3AppendContinuation,
    MiniMaxH3GuidedContinuationWindow,
    MiniMaxH3LatentTailGuide,
)
from .latent_io import AfflatusH3LatentHeadGuide, AfflatusH3LatentLanding, AfflatusH3SeamLatent, AfflatusH3TailGuide, AfflatusLoadH3Latent, AfflatusNormalizeH3Latent, AfflatusSaveH3Latent, AfflatusTrimH3Latent  # noqa: E402
from .face_match import AfflatusFaceAt, AfflatusFaceMatch, available as face_available  # noqa: E402
from .swap_mask import AfflatusSwapMask  # noqa: E402


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
            # the person a swap redraws, from SAM 3.1's track (H3 · Swap character)
            AfflatusSwapMask,
            # a face's likeness to some photos, for the pictures a Motion transfer is made from: only with insightface installed
            *([AfflatusFaceMatch, AfflatusFaceAt] if face_available() else []),
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
#   POST /afflatus/upload, PUT, GET and DELETE /afflatus/upload/<id>  → a model file Afflatus sends itself, a piece at a
#       time, for one no site has (uploads.py says how).
#   GET and POST /afflatus/alive  → the watchdog of a rented machine: "still here" from Afflatus; silent past its minutes,
#       the pod stops itself (watchdog.py says how).
#   GET /afflatus/power  → the GPU's power draw in watts (null where it cannot be read), for the electricity Afflatus says
#       a render on this PC cost (power.py says how).
#   GET and POST /afflatus/lock, POST /afflatus/unlock, POST /afflatus/login-code, /afflatus/login  → the lock: once set,
#       every route of ComfyUI's server needs this machine's token (lock.py says how, and how to take it off by hand).
# The first two are read-only, the first bytes of a file only, nothing loaded. ComfyUI's own /view_metadata gives the metadata alone.
# The disk is read and written off ComfyUI's event loop, which the progress of a render goes through.
try:
    import asyncio

    # on Windows a client gone before its connection was accepted closed ComfyUI's listening socket for good (accept_guard.py)
    from .accept_guard import install as _guard_accept

    _guard_accept()

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

    from .uploads import register as _register_uploads

    _register_uploads(PromptServer.instance.routes, web, folder_paths)

    from .watchdog import register as _register_watchdog

    _register_watchdog(PromptServer.instance.routes, web)

    from .power import register as _register_power

    _register_power(PromptServer.instance.routes, web)
except ImportError:
    # outside ComfyUI's server (a bare import, a test): the nodes still load, the routes are simply not there
    pass
except Exception as err:
    # said in ComfyUI's console, never swallowed: a route missing is looked for there (the lock is in already, above)
    print(f"[afflatus-nodes] its routes could not all be added: {err}")

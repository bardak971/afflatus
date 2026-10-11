"""Model downloads for an Afflatus that cannot write ComfyUI's model folders itself (ComfyUI on another machine).

ComfyUI-Manager reads a file from any address but a few sites whole into memory before it writes it, and a model
of several gigabytes failed half way. Here the pack fetches the file to disk as it comes, to `<name>.part` beside
where it goes, asks again from the byte it had when the connection is cut (a Range request), and gives the file its
name only once all of it is there: ComfyUI never lists half a model.

The address is always Afflatus's own one-time address for that download (`/api/downloads/fetch/<id>?t=<token>`),
which Afflatus streams from Civitai or Hugging Face: a Civitai key never reaches ComfyUI. Only that shape of address
is taken, redirects are not followed, the file goes only into the first path ComfyUI reads a model folder from
(never custom_nodes, never outside it), and only under a model file's name. Nothing fetched is ever sent back: the
caller learns how far it is, never what it got. (Checking that the address is the caller's own was weighed and
left: an Afflatus in a container or behind a proxy calls from another address than the one ComfyUI reaches it at.)

Routes (registered by __init__.py on ComfyUI's server; a JSON body only, which a page of another site cannot send
without asking first):
  POST   /afflatus/download {url, folder, filename, total}  → {id, path}
  GET    /afflatus/download/<id>  → {state: downloading|done|error|stopped, bytes, total, error, note}
  DELETE /afflatus/download/<id>  → stops it, and removes its .part
"""

import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

MODEL_FILE = re.compile(r"\.(safetensors|ckpt|gguf|sft|pt|pth|bin|onnx)$", re.I)
# what a name must not hold on any system: a path's separators, a drive's colon, Windows' reserved characters
BAD_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
RELAY = re.compile(r"^/api/downloads/fetch/[\w-]{1,64}$")
# folders ComfyUI lists that hold code or settings, not models
NOT_MODELS = {"custom_nodes", "configs"}
# finished downloads are forgotten after an hour
KEEP_S = 3600


class Refused(ValueError):
    """A request the pack will not carry out: said back as a 400 with this message."""


def relay_ok(url) -> bool:
    """Whether `url` is an Afflatus one-time address: http(s), a host, /api/downloads/fetch/<id>, and a token."""
    if not isinstance(url, str) or len(url) > 2000:
        return False
    try:
        at = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    return at.scheme in ("http", "https") and bool(at.hostname) and bool(RELAY.match(at.path)) and bool(urllib.parse.parse_qs(at.query).get("t"))


def model_dir(folder, folder_paths):
    """The directory a model folder's downloads go into: the first of ComfyUI's paths for it that exists and can be written, as its real path."""
    if not isinstance(folder, str) or folder in NOT_MODELS or folder not in folder_paths.folder_names_and_paths:
        return None
    for path in folder_paths.get_folder_paths(folder):
        if os.path.isdir(path) and os.access(path, os.W_OK):
            return os.path.realpath(path)
    return None


def target(folder, filename, folder_paths):
    """Where `filename` (a model file's name, with sub-folders when it has some) goes in `folder`. Raises Refused for anything else."""
    if not isinstance(filename, str) or not filename or len(filename) > 400:
        raise Refused("a filename is needed")
    parts = re.split(r"[\\/]", filename)
    if any(p in ("", ".", "..") or BAD_NAME.search(p) for p in parts) or not MODEL_FILE.search(parts[-1]):
        raise Refused(f"{filename} is not a model file's name")
    root = model_dir(folder, folder_paths)
    if root is None:
        raise Refused(f"{folder} is not a model folder ComfyUI can write here")
    path = os.path.realpath(os.path.join(root, *parts))
    # a sub-folder that is a link elsewhere does not take the file out of the folder
    if os.path.commonpath([root, path]) != root or path == root:
        raise Refused(f"{filename} would land outside {folder}")
    return root, path


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Afflatus's address answers itself: a redirect would lead the download anywhere."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "redirects are not followed", headers, fp)


# no proxy from the environment: Afflatus is on the same network
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)


class Job:
    def __init__(self, url, path, total=0):
        self.id = uuid.uuid4().hex
        self.url = url
        self.path = path
        self.total = int(total) if isinstance(total, (int, float)) and total > 0 else 0
        self.bytes = 0
        self.state = "downloading"
        self.error = None
        self.note = None
        self.ended = None
        self.cancelled = threading.Event()

    def view(self):
        return {"state": self.state, "bytes": self.bytes, "total": self.total, "error": self.error, "note": self.note}


class _Stopped(Exception):
    pass


def _remove(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def run(job, attempts=5, backoff=2.0, opener=_OPENER.open, chunk=1 << 20, timeout=60):
    """Fetch `job.url` into `job.path`, through `<path>.part`: picked up with a Range after a cut, tried again with a
    growing wait, named only once whole. Sets job.state to done, error or stopped; the .part never outlives a failure."""
    part = job.path + ".part"
    have = 0
    fails = 0
    try:
        _remove(part)
        os.makedirs(os.path.dirname(job.path), exist_ok=True)
        while True:
            if job.cancelled.is_set():
                raise _Stopped()
            before = have
            try:
                req = urllib.request.Request(job.url, headers={"User-Agent": "afflatus-nodes", **({"Range": f"bytes={have}-"} if have else {})})
                with opener(req, timeout=timeout) as res:
                    got = re.match(r"^bytes (\d+)-\d+/(\d+|\*)$", res.headers.get("Content-Range") or "") if res.status == 206 else None
                    if have and got and int(got.group(1)) == have:
                        mode = "ab"
                        if got.group(2) != "*":
                            job.total = int(got.group(2))
                    else:
                        # the whole file (a source that does not resume sends it from the start): what was there goes
                        if have:
                            job.note = "The source does not resume downloads: starting over."
                        have = 0
                        mode = "wb"
                        size = int(res.headers.get("Content-Length") or 0)
                        if size:
                            job.total = size
                    with open(part, mode) as f:
                        while True:
                            if job.cancelled.is_set():
                                raise _Stopped()
                            block = res.read(chunk)
                            if not block:
                                break
                            f.write(block)
                            have += len(block)
                            job.bytes = have
                if job.total and have < job.total:
                    raise ConnectionError(f"the connection was cut at {have} of {job.total} bytes")
                if job.total and have > job.total:
                    raise Refused(f"more than the {job.total} bytes it said came")
                break
            except (_Stopped, Refused):
                raise
            except urllib.error.HTTPError as e:
                if e.code == 416 and job.total and have == job.total:
                    break
                if e.code < 500 and e.code != 429:
                    raise Refused(f"Afflatus answered {e.code}: the download is no longer there")
                why = f"Afflatus answered {e.code}"
            except Exception as e:  # a cut, a timeout, a reset: tried again
                why = str(e) or type(e).__name__
            # what is on disk is what counts: a write cut half way leaves less than was read
            have = os.path.getsize(part) if os.path.exists(part) else 0
            job.bytes = have
            fails = 1 if have > before else fails + 1
            if fails >= attempts:
                raise Refused(f"the download failed {attempts} times in a row ({why})")
            job.note = f"{why}: trying again from byte {have} ({fails + 1} of {attempts})."
            if job.cancelled.wait(backoff * 2 ** (fails - 1)):
                raise _Stopped()
        # never over a file that is there: ComfyUI may have it in use
        if os.path.exists(job.path):
            raise Refused("a file of that name is in the folder already")
        os.replace(part, job.path)
        job.state = "done"
        job.note = None
    except _Stopped:
        _remove(part)
        job.state = "stopped"
    except Exception as e:
        _remove(part)
        job.state = "error"
        job.error = str(e)
    finally:
        job.ended = time.time()


def register(routes, web, folder_paths):
    """The download routes on ComfyUI's server (`routes`, aiohttp's `web`)."""
    jobs = {}

    def forget():
        now = time.time()
        for key in [k for k, j in jobs.items() if j.ended and now - j.ended > KEEP_S]:
            del jobs[key]

    @routes.post("/afflatus/download")
    async def _afflatus_download(request):
        if request.content_type != "application/json":
            return web.Response(status=415, text="a JSON body is expected")
        try:
            body = await request.json()
        except Exception:
            body = None
        if not isinstance(body, dict):
            return web.Response(status=400, text="a JSON object is expected")
        if not relay_ok(body.get("url")):
            return web.Response(status=400, text="only Afflatus's one-time download addresses are fetched")
        try:
            _root, path = target(body.get("folder"), body.get("filename"), folder_paths)
        except Refused as e:
            return web.Response(status=400, text=str(e))
        forget()
        if os.path.exists(path) or any(j.path == path and j.state == "downloading" for j in jobs.values()):
            return web.Response(status=409, text="that file is there already, or being downloaded")
        job = Job(body["url"], path, body.get("total") or 0)
        jobs[job.id] = job
        threading.Thread(target=run, args=(job,), name=f"afflatus-download-{job.id[:8]}", daemon=True).start()
        return web.json_response({"id": job.id, "path": path})

    @routes.get("/afflatus/download/{id}")
    async def _afflatus_download_state(request):
        job = jobs.get(request.match_info.get("id", ""))
        return web.Response(status=404) if job is None else web.json_response(job.view())

    @routes.delete("/afflatus/download/{id}")
    async def _afflatus_download_stop(request):
        job = jobs.get(request.match_info.get("id", ""))
        if job is None:
            return web.Response(status=404)
        job.cancelled.set()
        return web.json_response({"ok": True})

    return jobs

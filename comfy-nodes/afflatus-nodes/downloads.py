"""Model downloads for an Afflatus that cannot write ComfyUI's model folders itself (ComfyUI on another machine).

ComfyUI-Manager reads a file from any address but a few sites whole into memory before it writes it, and a model
of several gigabytes failed half way. Here the pack fetches the file to disk as it comes, to `<name>.part` beside
where it goes, asks again from the byte it had when the connection is cut (a Range request), and gives the file its
name only once all of it is there: ComfyUI never lists half a model.

The address is Afflatus's own one-time address for that download (`/api/downloads/fetch/<id>?t=<token>`), which
Afflatus streams from Civitai or Hugging Face, or (0.12.0) the source's own signed download link: Afflatus asks the site
with its key, at home, and hands over only the temporary link the site answers with, which holds no key. Then the file
comes straight from the site's servers, never through Afflatus's computer and its upload: what a rented ComfyUI needs,
which cannot reach Afflatus at all. Only https links on Hugging Face's and Civitai's download hosts (DIRECT_HOSTS) are
taken that way. A signed link lasts an hour or so: when it is refused half way, the download waits for Afflatus to send
a fresh one (POST /afflatus/download/<id>/url) and carries on from the byte it had, its .part kept. A Civitai key never
reaches ComfyUI either way. Only that shape of address
is taken, redirects are not followed, the file goes only into the first path ComfyUI reads a model folder from
(never custom_nodes, never outside it), and only under a model file's name. Nothing fetched is ever sent back: the
caller learns how far it is, never what it got. (Checking that the address is the caller's own was weighed and
left: an Afflatus in a container or behind a proxy calls from another address than the one ComfyUI reaches it at.)

Routes (registered by __init__.py on ComfyUI's server; a JSON body only, which a page of another site cannot send
without asking first):
  POST   /afflatus/download {url, folder, filename, total}  → {id, path}
  GET    /afflatus/download/<id>  → {state: downloading|done|error|stopped, bytes, total, error, note, expired}
  POST   /afflatus/download/<id>/url {url}  → a fresh signed link for a download whose link expired (`expired` true)
  DELETE /afflatus/download/<id>  → stops it, and removes its .part

Afflatus always says the file's size (the one-time address answers with its length): a download whose size is not
known is refused, and one that sends more than it said is cut off there, so a source cannot fill the disk. At most
MAX_JOBS run at once (a 429 past that).
"""

import asyncio
import os
import shutil
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
# a model download's .part: this pack's (with its download's id) or Afflatus's own
PART = re.compile(r"\.(safetensors|ckpt|gguf|sft|pt|pth|bin|onnx)(\.[0-9a-f]{8})?\.part$", re.I)
RELAY = re.compile(r"^/api/downloads/fetch/[\w-]{1,64}$")
# the hosts a signed download link of Hugging Face or Civitai is on (Civitai's files are served from Cloudflare R2)
DIRECT_HOSTS = ("huggingface.co", "hf.co", "civitai.com", "r2.cloudflarestorage.com")
# how long a download whose link expired waits for Afflatus to send a fresh one
RENEW_WAIT_S = 120
# folders ComfyUI lists that hold code or settings, not models
NOT_MODELS = {"custom_nodes", "configs"}
# finished downloads are forgotten after an hour
KEEP_S = 3600
# Afflatus runs two of its downloads at a time (downloads.ts AT_ONCE): more here would only be someone else's
MAX_JOBS = 2
# a .part not written to for this long belongs to no download under way: one cut short by ComfyUI stopping
STALE_PART_S = 3600


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


def direct_ok(url) -> bool:
    """Whether `url` is a download link of Hugging Face or Civitai themselves: https, on one of DIRECT_HOSTS (or under one)."""
    if not isinstance(url, str) or len(url) > 4000:
        return False
    try:
        at = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    host = (at.hostname or "").lower()
    return at.scheme == "https" and not at.username and not at.password and any(host == h or host.endswith("." + h) for h in DIRECT_HOSTS)


def _code_dirs(folder_paths):
    """The real paths of the node packs' folders: a folder a pack registers inside its own code is never a model folder."""
    try:
        return [os.path.realpath(p) for p in folder_paths.get_folder_paths("custom_nodes")]
    except Exception:
        return []


def _inside(root, path):
    try:
        return os.path.commonpath([root, path]) == root
    except ValueError:
        return False


def model_dir(folder, folder_paths):
    """The directory a model folder's downloads go into: the first of ComfyUI's paths for it that exists and can be written, as its real path."""
    if not isinstance(folder, str) or folder in NOT_MODELS or folder not in folder_paths.folder_names_and_paths:
        return None
    code = _code_dirs(folder_paths)
    for path in folder_paths.get_folder_paths(folder):
        if os.path.isdir(path) and os.access(path, os.W_OK):
            real = os.path.realpath(path)
            # a pack's own folder (VideoHelperSuite's video formats, say) takes no file from outside
            if any(_inside(c, real) for c in code):
                return None
            return real
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
    # a sub-folder that is a link elsewhere does not take the file out of the folder; one linked to another drive
    # has no path in common with it at all (commonpath raises), and is refused the same way
    try:
        outside = os.path.commonpath([root, path]) != root or path == root
    except ValueError:
        outside = True
    if outside:
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
        # a signed link of the source itself (not Afflatus's address): it may expire half way, and be sent again
        self.direct = direct_ok(url)
        self.expired = False
        self.renewed = threading.Event()
        self.path = path
        self.total = int(total) if isinstance(total, (int, float)) and total > 0 else 0
        # the size Afflatus said: what the source says may not be more (a source never fills the disk past it)
        self.declared = self.total
        self.bytes = 0
        self.state = "downloading"
        self.error = None
        self.note = None
        self.ended = None
        self.cancelled = threading.Event()

    @property
    def part(self):
        # its own .part: a download stopped and asked for again at once never shares one with the first, still letting go
        return f"{self.path}.{self.id[:8]}.part"

    def view(self):
        return {"state": self.state, "bytes": self.bytes, "total": self.total, "error": self.error, "note": self.note, "expired": self.expired}

    def renew(self, url):
        """A fresh link for a download whose link expired: it carries on from the byte it had."""
        self.url = url
        self.renewed.set()

    def wait_renewed(self, wait):
        """Wait for a fresh link, `wait` seconds at most: True when one came, False when none did; a stop ends the wait."""
        self.expired = True
        self.note = "The download link expired: waiting for Afflatus to send a fresh one."
        ends = time.time() + wait
        while time.time() < ends:
            if self.cancelled.is_set():
                raise _Stopped()
            if self.renewed.wait(min(1.0, max(0.0, ends - time.time()))):
                self.renewed.clear()
                self.expired = False
                self.note = "Carrying on with a fresh link."
                return True
        return False

    def stop(self):
        """Stopped as soon as it is asked: said so at once, and a retry of the same file is not turned away while the thread lets go."""
        self.cancelled.set()
        if self.state == "downloading":
            self.state = "stopped"
            self.ended = time.time()


class _Stopped(Exception):
    pass


def _remove(path):
    """The file gone; one that cannot be removed now (held open on Windows) is left to the start's sweep, never raised."""
    try:
        os.remove(path)
    except OSError:
        pass


def _within(job, size):
    """The size a source says, held to the one Afflatus said: more is refused before anything of it is written."""
    if job.declared and size > job.declared:
        raise Refused(f"the source says {size} bytes, {job.declared} were said")
    return size


def run(job, attempts=5, backoff=2.0, opener=_OPENER.open, chunk=1 << 20, timeout=60, renew_wait=RENEW_WAIT_S):
    """Fetch `job.url` into `job.path`, through `<path>.part`: picked up with a Range after a cut, tried again with a
    growing wait, named only once whole. Sets job.state to done, error or stopped; the .part never outlives a failure."""
    part = job.part
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
                            job.total = _within(job, int(got.group(2)))
                    else:
                        # the whole file (a source that does not resume sends it from the start): what was there goes
                        if have:
                            job.note = "The source does not resume downloads: starting over."
                        have = 0
                        mode = "wb"
                        size = int(res.headers.get("Content-Length") or 0)
                        if size:
                            job.total = _within(job, size)
                    if not job.total:
                        raise Refused("the size of the file is not known")
                    with open(part, mode) as f:
                        while True:
                            if job.cancelled.is_set():
                                raise _Stopped()
                            block = res.read(min(chunk, job.total - have + 1))
                            if not block:
                                break
                            if have + len(block) > job.total:
                                # never more than it said: the rest is not written, and the download fails
                                raise Refused(f"more than the {job.total} bytes it said came")
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
                # a signed link refused: it expired. Afflatus is asked for a fresh one, and what is on disk stays
                if job.direct and e.code in (401, 403, 410):
                    if not job.wait_renewed(renew_wait):
                        raise Refused("the download link expired, and Afflatus sent no fresh one")
                    have = os.path.getsize(part) if os.path.exists(part) else 0
                    job.bytes = have
                    continue
                where = "the source" if job.direct else "Afflatus"
                if e.code < 500 and e.code != 429:
                    raise Refused(f"{where} answered {e.code}: the download is no longer there")
                why = f"{where} answered {e.code}"
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
        if job.cancelled.is_set():
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
        # a stop said at once (Job.stop) stays a stop, whatever the thread met while letting go
        if job.state == "downloading":
            job.state = "error"
            job.error = str(e)
    finally:
        job.ended = job.ended or time.time()


def sweep_parts(folder_paths, older_than=STALE_PART_S, now=None):
    """Remove the .part files of model downloads left in the model folders by a ComfyUI that stopped half way: only
    those of a model file's name, not written to for `older_than` seconds (a download under way writes all the time,
    Afflatus's own included). Returns the paths removed."""
    now = time.time() if now is None else now
    removed = []
    for folder in list(folder_paths.folder_names_and_paths):
        if folder in NOT_MODELS:
            continue
        try:
            paths = folder_paths.get_folder_paths(folder)
        except Exception:
            continue
        for base in paths:
            if not os.path.isdir(base):
                continue
            for top, _dirs, files in os.walk(base):
                for name in files:
                    if not PART.search(name):
                        continue
                    path = os.path.join(top, name)
                    try:
                        if now - os.path.getmtime(path) > older_than:
                            os.remove(path)
                            removed.append(path)
                    except OSError:
                        pass
    return removed


def register(routes, web, folder_paths):
    """The download routes on ComfyUI's server (`routes`, aiohttp's `web`)."""
    jobs = {}
    # what a ComfyUI stopped half way left behind, looked for without holding up its start
    threading.Thread(target=sweep_parts, args=(folder_paths,), name="afflatus-sweep-parts", daemon=True).start()

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
        if not relay_ok(body.get("url")) and not direct_ok(body.get("url")):
            return web.Response(status=400, text="only Afflatus's one-time download addresses, and Hugging Face's and Civitai's own download links, are fetched")
        try:
            root, path = target(body.get("folder"), body.get("filename"), folder_paths)
        except Refused as e:
            return web.Response(status=400, text=str(e))
        forget()
        if os.path.exists(path) or any(j.path == path and j.state == "downloading" for j in jobs.values()):
            return web.Response(status=409, text="that file is there already, or being downloaded")
        if sum(j.state == "downloading" for j in jobs.values()) >= MAX_JOBS:
            return web.Response(status=429, text=f"{MAX_JOBS} downloads are under way already")
        total = body.get("total") or 0
        # a disk without the room is said now, not once it is full
        if isinstance(total, (int, float)) and total > 0:
            free = await asyncio.to_thread(lambda: shutil.disk_usage(root).free)
            if free < total:
                return web.Response(status=507, text=f"the disk has {free} bytes free, the file is {int(total)}")
        job = Job(body["url"], path, total)
        jobs[job.id] = job
        threading.Thread(target=run, args=(job,), name=f"afflatus-download-{job.id[:8]}", daemon=True).start()
        return web.json_response({"id": job.id, "path": path})

    @routes.get("/afflatus/download/{id}")
    async def _afflatus_download_state(request):
        job = jobs.get(request.match_info.get("id", ""))
        return web.Response(status=404) if job is None else web.json_response(job.view())

    @routes.post("/afflatus/download/{id}/url")
    async def _afflatus_download_renew(request):
        job = jobs.get(request.match_info.get("id", ""))
        if job is None:
            return web.Response(status=404)
        if request.content_type != "application/json":
            return web.Response(status=415, text="a JSON body is expected")
        try:
            body = await request.json()
        except Exception:
            body = None
        url = body.get("url") if isinstance(body, dict) else None
        if not job.direct or not direct_ok(url):
            return web.Response(status=400, text="only a download that came from a source's own link takes a fresh one, and only another such link")
        job.renew(url)
        return web.json_response({"ok": True})

    @routes.delete("/afflatus/download/{id}")
    async def _afflatus_download_stop(request):
        job = jobs.get(request.match_info.get("id", ""))
        if job is None:
            return web.Response(status=404)
        job.stop()
        return web.json_response({"ok": True})

    return jobs

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
  DELETE /afflatus/download/<id>  → stops it, and removes its .part (`?keep=1`, 0.36.6: keeps it, for the next download of
         that file to carry on from: Afflatus put it back in line, or ComfyUI restarts to load node packs)
  GET    /afflatus/disk  → {free, total, downloading}: the bytes of the disk the model folders are on (0.19.0)
  POST   /afflatus/models/remove {folder, filename}  → {removed}: a model file taken off the disk, to make room (0.19.0)
  GET    /afflatus/models/list  → {files: [{folder, path, bytes, modified}]}: every model file of the models folder, with its
         size, for Afflatus's view of a network volume (0.21.0)

Afflatus always says the file's size (the one-time address answers with its length): a download whose size is not
known is refused, and one that sends more than it said is cut off there, so a source cannot fill the disk. At most
MAX_JOBS run at once (a 429 past that).
"""

import asyncio
import errno
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


class _Passing(Refused):
    """Tried and failed too many times in a row on something that passes (a cut, a 5xx, a 429): its .part is kept, for
    Afflatus's next try of the file to carry on from."""


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


# the name a model folder ComfyUI does not know yet may have: one plain folder, as node packs name theirs ("veda")
NEW_FOLDER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
# what such a folder lists, until its pack says otherwise: ComfyUI's own model file types
MODEL_EXTS = {".safetensors", ".ckpt", ".pt", ".pt2", ".pth", ".bin", ".pkl", ".sft", ".gguf", ".onnx"}


def known(folder, folder_paths):
    """
    Whether `folder` is a model folder downloads may go into. One ComfyUI does not know yet is made known as
    models/<folder>, the way a node pack registers its own when it loads (the Veda pack's models/veda): a file fetched
    before its pack is installed, or before ComfyUI restarts with it, then lands where the pack reads it, and is listed.
    Only a plain folder name, in ComfyUI's models directory; never a folder of code or settings.
    """
    if not isinstance(folder, str) or folder in NOT_MODELS:
        return False
    if folder in folder_paths.folder_names_and_paths:
        return True
    base = getattr(folder_paths, "models_dir", None)
    if not NEW_FOLDER.match(folder) or not base or not os.path.isdir(base):
        return False
    exts = set(getattr(folder_paths, "supported_pt_extensions", None) or MODEL_EXTS)
    folder_paths.folder_names_and_paths[folder] = ([os.path.join(base, folder)], exts)
    return True


def model_dir(folder, folder_paths):
    """
    The directory a model folder's downloads go into: the first of ComfyUI's paths for it that exists and can be written,
    as its real path. When none exists yet (a fresh network volume holds an empty models folder: ComfyUI started on it
    with --base-directory has made none of its folders), the first is made, where its parent can be written. A folder
    ComfyUI does not know yet is made known first (known).
    """
    if not known(folder, folder_paths):
        return None
    code = _code_dirs(folder_paths)
    paths = list(folder_paths.get_folder_paths(folder))
    for path in paths:
        if os.path.isdir(path) and os.access(path, os.W_OK):
            real = os.path.realpath(path)
            # a pack's own folder (VideoHelperSuite's video formats, say) takes no file from outside
            if any(_inside(c, real) for c in code):
                return None
            return real
    first = paths[0] if paths else None
    parent = os.path.dirname(first) if first else None
    if first and not os.path.exists(first) and parent and os.path.isdir(parent) and os.access(parent, os.W_OK):
        real = os.path.join(os.path.realpath(parent), os.path.basename(first))
        if any(_inside(c, real) for c in code):
            return None
        try:
            os.makedirs(real, exist_ok=True)
        except OSError:
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


def located(folder, filename, folder_paths):
    """The file `filename` of model folder `folder` as it is on disk, in any of the folder's paths (never a pack's code); None
    when none holds it. Raises Refused for a name that is not a model file's, or a folder that is not a model folder."""
    if not isinstance(filename, str) or not filename or len(filename) > 400:
        raise Refused("a filename is needed")
    parts = re.split(r"[\\/]", filename)
    if any(p in ("", ".", "..") or BAD_NAME.search(p) for p in parts) or not MODEL_FILE.search(parts[-1]):
        raise Refused(f"{filename} is not a model file's name")
    if not isinstance(folder, str) or folder in NOT_MODELS or folder not in folder_paths.folder_names_and_paths:
        raise Refused(f"{folder} is not a model folder")
    code = _code_dirs(folder_paths)
    for base in folder_paths.get_folder_paths(folder):
        if not os.path.isdir(base):
            continue
        root = os.path.realpath(base)
        if any(_inside(c, root) for c in code):
            continue
        path = os.path.realpath(os.path.join(root, *parts))
        if _inside(root, path) and path != root and os.path.isfile(path):
            return path
    return None


def listed_models(folder_paths):
    """Every model file under ComfyUI's models folder (models_dir), for Afflatus's view of what a network volume holds: its
    model folder (the name `located` and the remove route take), its path from the models folder ("loras/wan/a.safetensors",
    as the volume's own listing names it), its bytes and when it was written (seconds). A file two folders share (unet and
    diffusion_models read the same directory) is listed once; a pack's code and the folders outside the models folder (an
    extra_model_paths.yaml) are not listed."""
    root = getattr(folder_paths, "models_dir", None)
    if not root or not os.path.isdir(root):
        return []
    root = os.path.realpath(root)
    code = _code_dirs(folder_paths)
    seen = set()
    out = []
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
            real = os.path.realpath(base)
            if not _inside(root, real) or any(_inside(c, real) for c in code):
                continue
            for top, dirs, files in os.walk(real):
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                for name in files:
                    if not MODEL_FILE.search(name):
                        continue
                    path = os.path.join(top, name)
                    if path in seen:
                        continue
                    seen.add(path)
                    try:
                        st = os.stat(path)
                    except OSError:
                        continue
                    out.append({
                        "folder": folder,
                        "path": os.path.relpath(path, root).replace(os.sep, "/"),
                        "name": os.path.relpath(path, real).replace(os.sep, "/"),
                        "bytes": st.st_size,
                        "modified": st.st_mtime,
                    })
    return out


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
        # the bytes the other downloads under way still have to write: room this one cannot count on (register sets it)
        self.reserved = lambda: 0
        # the .part files of the other downloads whose thread still runs: never taken over (register sets it)
        self.busy_parts = lambda: set()
        # its thread runs (run sets it false as it ends); a stop asked to keep its .part (stop)
        self.alive = True
        self.keep = False

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

    def stop(self, keep=False):
        """Stopped as soon as it is asked: said so at once, and a retry of the same file is not turned away while the thread lets go.
        `keep`: its .part stays, for the next download of the file to carry on from."""
        self.keep = keep
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


# a disk with no room left: no try after this one would fare better
DISK_FULL = {errno.ENOSPC, getattr(errno, "EDQUOT", errno.ENOSPC)}


def _gb(n):
    return f"{n / 2**30:.1f} GB"


def _room(job, have):
    """Refused at once when what is left of the file does not fit beside what the other downloads still write."""
    free = shutil.disk_usage(os.path.dirname(job.path)).free
    need = job.total - have
    kept = job.reserved()
    if free - kept < need:
        raise Refused(f"the disk is full: {_gb(free)} free, {_gb(kept)} of it kept for other downloads, {_gb(need)} of this file to come")


def _taken_over(job):
    """The bytes of the same file an earlier download left (stopped to be asked again, failed on something that passes,
    or cut by ComfyUI restarting), moved to this one's .part to carry on from: the largest one no running download writes.
    A file of 21 GB 60 % done was fetched again from its first byte. Returns how many bytes it has (0: none)."""
    folder, name = os.path.split(job.path)
    left = re.compile(re.escape(name) + r"\.[0-9a-f]{8}\.part$")
    try:
        found = [os.path.join(folder, f) for f in os.listdir(folder) if left.match(f)]
    except OSError:
        return 0
    busy = job.busy_parts()
    found = [p for p in found if p != job.part and p not in busy]
    best = None
    for p in found:
        try:
            size = os.path.getsize(p)
        except OSError:
            continue
        # one larger than the file said is not of this file
        if job.declared and size > job.declared:
            continue
        if best is None or size > best[1]:
            best = (p, size)
    for p in found:
        if not best or p != best[0]:
            _remove(p)
    if not best or not best[1]:
        return 0
    try:
        os.replace(best[0], job.part)
    except OSError:
        return 0
    return best[1]


def run(job, attempts=5, backoff=2.0, opener=_OPENER.open, chunk=1 << 20, timeout=60, renew_wait=RENEW_WAIT_S):
    """Fetch `job.url` into `job.path`, through `<path>.part`: picked up with a Range after a cut (or from what an earlier
    download of it left, _taken_over), tried again with a growing wait, named only once whole. Sets job.state to done,
    error or stopped; the .part outlives only a stop asked to keep it and a failure that passes (_Passing)."""
    part = job.part
    have = 0
    fails = 0
    try:
        _remove(part)
        os.makedirs(os.path.dirname(job.path), exist_ok=True)
        have = _taken_over(job)
        job.bytes = have
        if have:
            job.note = f"Carrying on from byte {have}, as an earlier download of it left it."
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
                    _room(job, have)
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
                # a full disk stays full: said at once (Afflatus fails the file, and makes room or sends its job elsewhere)
                if isinstance(e, OSError) and e.errno in DISK_FULL:
                    raise Refused(f"the disk is full ({e.strerror or e})")
                why = str(e) or type(e).__name__
            # what is on disk is what counts: a write cut half way leaves less than was read
            have = os.path.getsize(part) if os.path.exists(part) else 0
            job.bytes = have
            fails = 1 if have > before else fails + 1
            if fails >= attempts:
                raise _Passing(f"the download failed {attempts} times in a row ({why})")
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
        if not job.keep:
            _remove(part)
        job.state = "stopped"
    except Exception as e:
        if not isinstance(e, _Passing):
            _remove(part)
        # a stop said at once (Job.stop) stays a stop, whatever the thread met while letting go
        if job.state == "downloading":
            job.state = "error"
            job.error = str(e)
    finally:
        job.ended = job.ended or time.time()
        job.alive = False


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

    def reserved(but=None):
        return sum(max(0, j.total - j.bytes) for j in jobs.values() if j is not but and j.state == "downloading")

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
        # a disk without the room is said now, not once it is full: beside what the downloads under way still write
        if isinstance(total, (int, float)) and total > 0:
            free = await asyncio.to_thread(lambda: shutil.disk_usage(root).free) - reserved()
            if free < total:
                return web.Response(status=507, text=f"the disk has {max(0, free)} bytes free, the file is {int(total)}")
        job = Job(body["url"], path, total)
        job.reserved = lambda: reserved(job)
        job.busy_parts = lambda: {j.part for j in jobs.values() if j is not job and j.alive}
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
        job.stop(keep=request.query.get("keep") == "1")
        return web.json_response({"ok": True})

    @routes.get("/afflatus/disk")
    async def _afflatus_disk(request):
        # the disk of the models folder: the one model downloads fill (a pod's container disk, or its volume)
        root = getattr(folder_paths, "models_dir", None) or model_dir("checkpoints", folder_paths)
        if not root or not os.path.isdir(root):
            return web.Response(status=404, text="no models folder")
        usage = await asyncio.to_thread(shutil.disk_usage, root)
        return web.json_response({"free": usage.free, "total": usage.total, "downloading": reserved()})

    @routes.get("/afflatus/models/list")
    async def _afflatus_models_list(request):
        # what the models folder holds, with sizes: on a pod with a network volume, what the volume holds
        return web.json_response({"files": await asyncio.to_thread(listed_models, folder_paths)})

    @routes.post("/afflatus/models/remove")
    async def _afflatus_models_remove(request):
        # a model file taken off to make room: only a model file's name, in a model folder's own paths, never one a download
        # writes now; what ComfyUI holds in memory of it stays usable until it is let go
        if request.content_type != "application/json":
            return web.Response(status=415, text="a JSON body is expected")
        try:
            body = await request.json()
        except Exception:
            body = None
        if not isinstance(body, dict):
            return web.Response(status=400, text="a JSON object is expected")
        try:
            found = located(body.get("folder"), body.get("filename"), folder_paths)
        except Refused as e:
            return web.Response(status=400, text=str(e))
        if found is None:
            return web.Response(status=404, text="no such file")
        if any(j.path == found and j.state == "downloading" for j in jobs.values()):
            return web.Response(status=409, text="it is being downloaded")
        size = os.path.getsize(found)
        try:
            await asyncio.to_thread(os.remove, found)
        except OSError as e:
            return web.Response(status=409, text=f"it could not be removed ({e.strerror or e})")
        return web.json_response({"removed": size})

    return jobs

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
  POST   /afflatus/download {url, folder, filename, total, sha256?}  → {id, path}
  GET    /afflatus/download/<id>  → {state: downloading|done|error|stopped, bytes, total, error, note, expired}
  POST   /afflatus/download/<id>/url {url}  → a fresh signed link for a download whose link expired (`expired` true)
  DELETE /afflatus/download/<id>  → stops it, and removes its .part (`?keep=1`, 0.36.6: keeps it, for the next download of
         that file to carry on from: Afflatus put it back in line, or ComfyUI restarts to load node packs; 0.49.7: answered
         once its thread let go, LET_GO_S at most, so that a restart asked right after finds the .part cut back)
  GET    /afflatus/disk  → {free, total, downloading}: the bytes of the disk the model folders are on (0.19.0)
  POST   /afflatus/models/remove {folder, filename}  → {removed}: a model file taken off the disk, to make room (0.19.0)
  GET    /afflatus/models/list  → {files: [{folder, path, bytes, modified}]}: every model file of the models folder, with its
         size, for Afflatus's view of a network volume (0.21.0)

Afflatus always says the file's size (the one-time address answers with its length): a download whose size is not
known is refused, and one that sends more than it said is cut off there, so a source cannot fill the disk. A source
that says another size than Afflatus's is refused before anything is written (0.44.1): a short answer was named a whole
model before. At most
MAX_JOBS run at once (a 429 past that).

A big file on a source's own link (0.44.0) comes over several connections at once: Civitai serves each connection at
20–33 MB/s and no more, and 8 at once came at 233–256 MB/s on a pod (Afflatus card #199), a file of 21 GB in ~85 s
instead of ~15 min. The link is asked for one byte first: a 206 with the file's size and the file splits into pieces,
each asked for with its own Range by CONNECTIONS threads and written at its offset into `<name>.<id>.parts` (another
name than the .part, which an interrupted download hands to the next one as bytes from the first on: these are not).
The connections are shared by every download of this ComfyUI (two files at once share the 8). Whatever ends it, the
.parts is cut back to the bytes whole from the first on and becomes the .part again, so a stop asked to keep it, a
failure that passes, or a source that stops answering parts (carried on over one connection) lose no more than the
pieces under way. A sha256 Afflatus says (Civitai lists it) is checked before the file is named, read as the pieces
come.

A file asked for with a sha256 that is in the folder already (0.49.7) is not answered "there already" (409): something
else put it there unchecked (Impact Subpack's installer fetched the YOLO pickles from Hugging Face's main on every pod
before Afflatus's checked fetch, card #265). Its bytes are read: the download is done at once when they are the ones its
source lists; else the file is removed (a pickle with other bytes is never left for ComfyUI to load) and fetched as any.

A 429 (0.50.3) is a rate limit, no try that failed: its Retry-After is waited out (held within LIMIT's bounds, else a wait
that grows from 30 s), by every download from that host, and the download is given up only once the 429s have gone on for
LIMIT's patience with nothing of the file coming. A 429 to a piece leaves the file in parts on the same link, over half the
connections for a while (the downloads from that host together), never over one at once. Civitai's file server, behind
Cloudflare, answered 429 with Retry-After 56 (2026-11-12): five tries over 30 s, as for a 5xx, gave two files of 20 GB up.
Since 0.50.4 a request that waited for a connection while a 429 came waits its hold out before it asks (_turn), the wait grows
only at the first 429 of a rush, and the patience is counted to when it is spent, the last wait cut to what is left of it.
"""

import asyncio
import collections
import contextlib
import datetime
import email.utils
import errno
import hashlib
import os
import shutil
import re
import socket
import ssl
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
PART = re.compile(r"\.(safetensors|ckpt|gguf|sft|pt|pth|bin|onnx)(\.[0-9a-f]{8})?\.parts?$", re.I)
# this pack's own, with its download's id: an older pack's had none, as Afflatus's own still has
OWN_PART = re.compile(r"\.[0-9a-f]{8}\.parts?$", re.I)
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
# how long a stop asked to keep its .part waits for its thread to let go before it answers: the pieces over several
# connections are cut back to the .part only then, and ComfyUI restarting first (node packs) lost them all (card #265)
LET_GO_S = 20
# a .part not written to for this long belongs to no download under way: one cut short by ComfyUI stopping
STALE_PART_S = 3600
# a .part with no download's id (Afflatus's own, on a ComfyUI on its machine) is kept for its next try to carry on from, and
# removed by Afflatus once its failure leaves the list: swept here only when it is a week old, an older pack's left behind
STALE_BARE_PART_S = 7 * 24 * 3600
# the connections all downloads of this ComfyUI share (measured on pods: 8 give 233–256 MB/s from Civitai, 16 up to 599
# but no more on a pod's disk and line most of the time); a file from this size on is fetched over them, smaller over one
CONNECTIONS = 8
PARTS_FROM = 256 * 2**20
# the size of a piece: a connection asks for one at a time, so that two downloads at once share the connections piece by
# piece, and the last pieces of a file are not left to one connection for long
PIECE_MIN = 32 * 2**20
PIECE_MAX = 256 * 2**20
_SLOTS = threading.BoundedSemaphore(CONNECTIONS)
SHA256 = re.compile(r"^[0-9a-f]{64}$")
# how a source's 429 is waited out, in seconds: a Retry-After held within `least` and `most`, else `first` doubling (to 8
# times it at most); given up once the 429s went on for `patience` with nothing of the file coming; `fewer`: how long a host
# keeps half the connections after a 429 to a piece
LIMIT = {"first": 30.0, "least": 5.0, "most": 600.0, "patience": 18 * 60.0, "fewer": 600.0}


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


def _current(folder, folder_paths):
    """The name ComfyUI keeps a folder under: its older names (unet, clip) are read as diffusion_models and text_encoders
    (folder_paths.map_legacy), and are no key of their own."""
    mapped = getattr(folder_paths, "map_legacy", None)
    if callable(mapped) and isinstance(folder, str):
        try:
            return mapped(folder)
        except Exception:
            return folder
    return folder


def known(folder, folder_paths):
    """
    Whether `folder` is a model folder downloads may go into. One ComfyUI does not know yet is made known as
    models/<folder>, the way a node pack registers its own when it loads (the Veda pack's models/veda): a file fetched
    before its pack is installed, or before ComfyUI restarts with it, then lands where the pack reads it, and is listed.
    Only a plain folder name, in ComfyUI's models directory; never a folder of code or settings. A folder's older name
    (unet, clip) is the folder ComfyUI reads it as: it was made a folder of its own, models/unet, beside it.
    """
    if not isinstance(folder, str) or folder in NOT_MODELS:
        return False
    if folder in folder_paths.folder_names_and_paths or _current(folder, folder_paths) in folder_paths.folder_names_and_paths:
        return True
    base = getattr(folder_paths, "models_dir", None)
    if not NEW_FOLDER.match(folder) or not base or not os.path.isdir(base):
        return False
    exts = set(getattr(folder_paths, "supported_pt_extensions", None) or MODEL_EXTS)
    folder_paths.folder_names_and_paths[folder] = ([os.path.join(base, folder)], exts)
    return True


# a folder's other name in ComfyUI's models directory: a download into one goes to the other second
OTHER_NAME = {"diffusion_models": "unet", "unet": "diffusion_models", "text_encoders": "clip", "clip": "text_encoders"}


def _same(a, b):
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def ordered(folder, paths, models_dir):
    """
    ComfyUI's paths for a model folder in the order downloads go into them: its own models/<folder> first, then the
    folder's other name there (unet, clip), then the others in ComfyUI's order. ComfyUI lists the older name and
    extra_model_paths.yaml's folders first, and a download landed where nobody looked for it (Afflatus card #59).
    """
    if not models_dir:
        return list(paths)
    own = [p for p in paths if _same(p, os.path.join(models_dir, folder))]
    other = OTHER_NAME.get(folder)
    older = [p for p in paths if other and _same(p, os.path.join(models_dir, other)) and p not in own]
    return own + older + [p for p in paths if p not in own and p not in older]


def model_dir(folder, folder_paths, chosen=None):
    """
    The directory a model folder's downloads go into: `chosen` when ComfyUI lists it for the folder and it can be written,
    else the first of ComfyUI's paths for it, in `ordered`'s order, that exists and can be written, as its real path.
    When none exists yet (a fresh network volume holds an empty models folder: ComfyUI started on it with --base-directory
    has made none of its folders), the first is made, where its parent can be written. A folder ComfyUI does not know yet
    is made known first (known).
    """
    if not known(folder, folder_paths):
        return None
    code = _code_dirs(folder_paths)
    paths = ordered(folder, list(folder_paths.get_folder_paths(folder)), getattr(folder_paths, "models_dir", None))
    if isinstance(chosen, str) and chosen:
        # only a path ComfyUI itself lists for the folder: never one the request names on its own
        picked = [p for p in paths if _same(p, chosen)]
        paths = picked + [p for p in paths if p not in picked]
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


def target(folder, filename, folder_paths, chosen=None):
    """Where `filename` (a model file's name, with sub-folders when it has some) goes in `folder`. Raises Refused for anything else."""
    if not isinstance(filename, str) or not filename or len(filename) > 400:
        raise Refused("a filename is needed")
    parts = re.split(r"[\\/]", filename)
    if any(p in ("", ".", "..") or BAD_NAME.search(p) for p in parts) or not MODEL_FILE.search(parts[-1]):
        raise Refused(f"{filename} is not a model file's name")
    root = model_dir(folder, folder_paths, chosen)
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
    if not isinstance(folder, str) or folder in NOT_MODELS or _current(folder, folder_paths) not in folder_paths.folder_names_and_paths:
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
    def __init__(self, url, path, total=0, sha256=None):
        self.id = uuid.uuid4().hex
        # the file's sha256 as its source lists it: checked before the file is named (0.44.0)
        self.sha256 = sha256.lower() if isinstance(sha256, str) and SHA256.match(sha256.lower()) else None
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
        # a file of its name was in the folder when it was asked for (with a sha256 only): checked before anything is fetched
        self.there = False
        # and its bytes were the ones its source lists: nothing fetched
        self.found = False

    @property
    def part(self):
        # its own .part: a download stopped and asked for again at once never shares one with the first, still letting go
        return f"{self.path}.{self.id[:8]}.part"

    @property
    def parts(self):
        # the file while its pieces come over several connections: holes in it, so never taken for a .part's first bytes
        return self.part + "s"

    def view(self):
        view = {"state": self.state, "bytes": self.bytes, "total": self.total, "error": self.error, "note": self.note, "expired": self.expired}
        # done without fetching a byte: the file was there, its bytes the ones its source lists (_checked_there)
        if self.found:
            view["there"] = True
        return view

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


# what a page or an API says, never a model file's bytes: a sign-in page, an error in JSON, of any size
NOT_A_FILE = re.compile(r"text/html|application/json", re.I)


def _a_file(res, where):
    """Refused when the answer is a page or JSON in place of the file: of the size said, it was named as the model."""
    kind = res.headers.get("Content-Type") or ""
    if NOT_A_FILE.search(kind):
        raise Refused(f"{where} sent {kind.split(';')[0].strip()} in place of the file")


def _gone(where, code):
    """A 4xx in words: a 404 or a 410 is a download that is no longer there; any other only the status (a 400, a 405, a 416)."""
    return f"{where} answered {code}: the download is no longer there" if code in (404, 410) else f"{where} answered {code}"


def _unreachable(e):
    """Whether a request failed because its host cannot be reached at all (no such name, refused, a bad certificate), not a
    cut: trying it again a moment later changes nothing. A name that does not resolve for now (EAI_AGAIN) is a blip."""
    reason = getattr(e, "reason", e)
    if isinstance(reason, socket.gaierror):
        return reason.errno == getattr(socket, "EAI_NONAME", -2)
    return isinstance(reason, (ConnectionRefusedError, ssl.SSLCertVerificationError))


def _within(job, size):
    """The size a source says, held to the one Afflatus said: another is refused before anything of it is written. More
    would fill the disk past it; less was named as a whole model once whole (a short answer, without a sha256 to tell)."""
    if job.declared and size != job.declared:
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


def _take(job, slots):
    """One of the connections every download shares, waited for as long as it takes; a stop ends the wait."""
    while not slots.acquire(timeout=0.5):
        if job.cancelled.is_set():
            raise _Stopped()


def _retry_after(headers):
    """A 429's Retry-After in seconds, said as seconds or as an HTTP date; None when there is none, or nothing readable."""
    said = ((headers.get("Retry-After") if headers is not None else None) or "").strip()
    if not said:
        return None
    if said.isdigit():
        return float(said)
    try:
        at = email.utils.parsedate_to_datetime(said)
    except (TypeError, ValueError):
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=datetime.timezone.utc)
    return max(0.0, at.timestamp() - time.time())


def _words(s):
    return f"{max(1, round(s))} s" if s < 90 else f"{round(s / 60)} min"


class _Limited(Exception):
    """A source's 429, with its Retry-After in seconds when it says one."""

    def __init__(self, said):
        super().__init__("the source answered 429")
        self.said = said


class _Calm:
    """What every download of this ComfyUI knows of a host's 429s (the host and port of its link): until when none asks it
    again, when its last 429 came, how many connections it takes at once for a while after a 429 to a piece, and how many
    of the downloads in parts are at it."""

    def __init__(self):
        self.lock = threading.Lock()
        self.hosts = {}

    def _of(self, host):
        return self.hosts.setdefault(host, {"until": 0.0, "last": float("-inf"), "width": None, "fewer_until": 0.0, "busy": 0})

    def hold(self, host, wait, now):
        with self.lock:
            h = self._of(host)
            h["until"] = max(h["until"], now + wait)
            h["last"] = now

    def until(self, host):
        with self.lock:
            return self._of(host)["until"]

    def last(self, host):
        with self.lock:
            return self._of(host)["last"]

    def width(self, host, full, now):
        with self.lock:
            h = self._of(host)
            if h["width"] is not None and now >= h["fewer_until"]:
                h["width"] = None
            return min(full, h["width"] or full)

    def lower(self, host, full, wait, now):
        """Half as many connections at once to the host (one at least), for `wait` seconds."""
        width = self.width(host, full, now)
        with self.lock:
            h = self._of(host)
            h["width"] = max(1, -(-width // 2))
            h["fewer_until"] = now + wait
            return h["width"]

    def join(self, host, n=1):
        with self.lock:
            self._of(host)["busy"] += n

    def busy(self, host):
        with self.lock:
            return self._of(host)["busy"]


_CALM = _Calm()


class _Patience:
    """How long one download's 429s have gone on, counted in time (several connections meeting the same rush count it once,
    and wait as long): the wait before the next request, or _Passing once they went on for LIMIT's patience with nothing of
    the file coming."""

    def __init__(self, limit):
        self.limit = limit
        self.since = None
        self.times = 0
        # when its last 429 came: one to a request sent before it is of the same rush
        self.last = float("-inf")
        self.lock = threading.Lock()

    def wait(self, said, now, sent):
        """A 429 at `now` to a request sent at `sent`."""
        lim = self.limit
        with self.lock:
            if self.since is None:
                self.since = now
            if now - self.since >= lim["patience"]:
                raise _Passing(f"the source kept asking to slow down for {_words(now - self.since)} (it answered 429)")
            # the first 429 of a rush waits longer than the last did: eight connections meeting the same one jumped to the
            # longest wait
            if sent > self.last:
                self.times += 1
            self.last = now
            wait = min(lim["first"] * 2 ** (self.times - 1), lim["first"] * 8) if said is None else min(lim["most"], max(lim["least"], said))
            # never past the patience: the source is asked once more as it ends (two 429s saying 10 min gave up at 10, not 18)
            return min(wait, self.since + lim["patience"] - now)

    def gained(self):
        with self.lock:
            self.since = None
            self.times = 0


def _held(calm, host, mine):
    """Whether the host is held for a request: another request met a 429 it has not waited out yet (`mine`: [the hold it
    waited out, when it was last sent])."""
    until = calm.until(host)
    return until > time.time() and until > mine[0]


def _calm_first(job, calm, host, mine):
    """Before a request: the hold another request met at the host waited out, unless this one's (`mine`) already took it."""
    if _held(calm, host, mine):
        mine[0] = calm.until(host)
        if job.cancelled.wait(max(0.0, mine[0] - time.time())):
            raise _Stopped()


@contextlib.contextmanager
def _turn(job, slots, calm, host, mine):
    """A request's turn: the host's hold waited out, one of the connections every download shares taken, and the hold looked
    at again; one that began while it waited for it (another's 429) is waited out with it let go. Two files at once, the
    requests that waited for the 8 connections took those the 429s let go and asked straight into the hold, each pushing it
    later. When it goes is noted (mine[1]): a 429 to it is of the rush that began after."""
    while True:
        _calm_first(job, calm, host, mine)
        _take(job, slots)
        if not _held(calm, host, mine):
            break
        slots.release()
    mine[1] = time.time()
    try:
        yield
    finally:
        slots.release()


def _limited(calm, host, patience, mine, said):
    """A 429 met: how long to wait, held for every download from the host; _Passing once the patience is spent."""
    now = time.time()
    wait = patience.wait(said, now, mine[1])
    calm.hold(host, wait, now)
    mine[0] = now + wait
    return wait


class _NoParts(Exception):
    """The source no longer answers parts of the file (a 200 to a Range, links refused again and again): the rest
    comes over one connection."""


class _Piece:
    __slots__ = ("start", "end", "done")

    def __init__(self, start, end):
        self.start, self.end, self.done = start, end, 0

    @property
    def left(self):
        return self.end - self.start - self.done


def _answers_parts(job, have, opener, timeout):
    """Whether the source answers parts of the file: a 206 to one byte at `have`, saying the file's size (held to the one
    Afflatus said). Any other answer, a refusal or a cut leaves the file to one connection, which says what is wrong."""
    req = urllib.request.Request(job.url, headers={"User-Agent": "afflatus-nodes", "Range": f"bytes={have}-{have}"})
    try:
        with opener(req, timeout=timeout) as res:
            got = re.match(r"^bytes (\d+)-(\d+)/(\d+)$", res.headers.get("Content-Range") or "")
            if res.status != 206 or not got or int(got.group(1)) != have or NOT_A_FILE.search(res.headers.get("Content-Type") or ""):
                return False
            job.total = _within(job, int(got.group(3)))
            return have < job.total
    except Refused:
        raise
    except urllib.error.HTTPError as e:
        # a rate limit is waited out (run), never a reason to leave the file to one connection
        if e.code == 429:
            raise _Limited(_retry_after(e.headers))
        return False
    except Exception:
        return False


def _read_piece(job, url, piece, f, opener, chunk, timeout, moved):
    """One piece from where it was left, written at its offset: `piece.done` counts what is on disk."""
    at = piece.start + piece.done
    req = urllib.request.Request(url, headers={"User-Agent": "afflatus-nodes", "Range": f"bytes={at}-{piece.end - 1}"})
    with opener(req, timeout=timeout) as res:
        got = re.match(r"^bytes (\d+)-(\d+)/(\d+|\*)$", res.headers.get("Content-Range") or "")
        if res.status != 206 or not got:
            raise _NoParts("the source sent the whole file to a request for part of it")
        _a_file(res, "the source")
        if int(got.group(1)) != at or int(got.group(2)) != piece.end - 1 or (got.group(3) != "*" and int(got.group(3)) != job.total):
            raise Refused(f"the source sent bytes {got.group(1)}-{got.group(2)}/{got.group(3)} for {at}-{piece.end - 1}/{job.total}")
        f.seek(at)
        while piece.left:
            if job.cancelled.is_set():
                raise _Stopped()
            block = res.read(min(chunk, piece.left + 1))
            if not block:
                raise ConnectionError(f"the connection was cut {piece.left} bytes before the end of a part")
            if len(block) > piece.left:
                raise Refused("more than the part asked for came")
            view = memoryview(block)
            while view:
                n = f.write(view)
                view = view[n:]
                piece.done += n
                moved(n)


def _in_parts(job, have, opener, attempts, backoff, chunk, timeout, renew_wait, slots, width, piece_size=None, waits=None):
    """
    The rest of the file from byte `have` over `width` connections at once, a piece each at a time, into job.parts (the
    .part taken over first, when there is one). Returns (bytes whole from the first on, the file's sha256 when it is known
    and all of it came, else None). However it ends, job.parts is cut back to its bytes whole from the first on and
    becomes job.part again, for a stop that keeps it, a failure that passes, or one connection to carry on from: the
    pieces beyond the first not whole are lost, never taken for bytes they are not.
    """
    if have:
        os.replace(job.part, job.parts)
    else:
        open(job.parts, "wb").close()
    size = piece_size or min(PIECE_MAX, max(PIECE_MIN, (job.total - have) // (width * 4)))
    pieces = [_Piece(a, min(job.total, a + size)) for a in range(have, job.total, size)]
    todo = collections.deque(pieces)
    lock = threading.Lock()
    renewing = threading.Lock()
    ended = []
    renewals = [0]
    over = threading.Event()
    calm, host, patience, limit = waits or (_Calm(), "", _Patience(LIMIT), LIMIT)
    full = width

    def crowded(extra):
        # fewer connections at the host for a while after a 429 (its downloads together), and more than that at it
        now_width = calm.width(host, full, time.time())
        return now_width < full and calm.busy(host) + extra > now_width

    def whole():
        # the bytes whole from the first on: up to the first piece not all there, and what of it came
        for p in pieces:
            if p.left:
                return p.start + p.done
        return job.total

    def moved(n):
        with lock:
            job.bytes += n

    def end(e):
        with lock:
            if not ended:
                ended.append(e)

    def connection():
        fails = 0
        mine = [0.0, 0.0]
        joined = [True]
        calm.join(host)
        try:
            with open(job.parts, "r+b", buffering=0) as f:
                while True:
                    # the host wants fewer at once: this one steps aside until there is room again (the while is over, or
                    # another ended)
                    if crowded(0):
                        calm.join(host, -1)
                        joined[0] = False
                        while crowded(1):
                            with lock:
                                if ended or not todo:
                                    return
                            if job.cancelled.wait(0.25):
                                return
                        calm.join(host)
                        joined[0] = True
                    with lock:
                        if ended or not todo:
                            return
                        piece = todo.popleft()
                    try:
                        while piece.left:
                            if ended or job.cancelled.is_set():
                                return
                            before = piece.done
                            url = job.url
                            try:
                                with _turn(job, slots, calm, host, mine):
                                    # the link as it is once its turn came: one renewed while it waited is the one asked
                                    url = job.url
                                    _read_piece(job, url, piece, f, opener, chunk, timeout, moved)
                                patience.gained()
                                continue
                            except urllib.error.HTTPError as e:
                                if e.code in (401, 403, 410):
                                    # a signed link refused: it expired, and one connection asks Afflatus for a fresh one
                                    # while the others wait for it. Refused again and again, the source may not want this
                                    # many connections: the rest over one
                                    with renewing:
                                        if job.url == url and not ended:
                                            renewals[0] += 1
                                            if renewals[0] > 2:
                                                raise _NoParts(f"the source refused its link {renewals[0]} times")
                                            if not job.wait_renewed(renew_wait):
                                                raise Refused("the download link expired, and Afflatus sent no fresh one")
                                    continue
                                if e.code == 429:
                                    # the link still holds: the source asks for fewer requests. Waited out (its Retry-After),
                                    # and fewer connections for a while: half, by the first 429 of a rush (to a request sent
                                    # after the last one), never one at once
                                    rush = mine[1] <= calm.last(host)
                                    wait = _limited(calm, host, patience, mine, _retry_after(e.headers))
                                    now = time.time()
                                    n = calm.width(host, full, now) if rush else calm.lower(host, full, limit["fewer"], now)
                                    job.note = f"The source asks to slow down (429): waiting {_words(wait)}, then carrying on over {n} connection{'' if n == 1 else 's'} from byte {whole()}."
                                    if job.cancelled.wait(wait):
                                        return
                                    # one too many now: the piece goes back, for one that stays
                                    if crowded(0):
                                        break
                                    continue
                                if e.code < 500:
                                    raise Refused(_gone("the source", e.code))
                                why = f"the source answered {e.code}"
                            except (_Stopped, Refused, _NoParts):
                                raise
                            except Exception as e:  # a cut, a timeout, a reset: this piece tried again
                                if isinstance(e, OSError) and e.errno in DISK_FULL:
                                    raise Refused(f"the disk is full ({e.strerror or e})")
                                why = str(e) or type(e).__name__
                            fails = 1 if piece.done > before else fails + 1
                            if fails >= attempts:
                                raise _Passing(f"the download failed {attempts} times in a row ({why})")
                            job.note = f"{why}: trying that part again ({fails + 1} of {attempts})."
                            if job.cancelled.wait(backoff * 2 ** (fails - 1)):
                                return
                    finally:
                        if piece.left:
                            with lock:
                                todo.appendleft(piece)
        except BaseException as e:  # noqa: BLE001 -- whatever ends one connection ends them all, said once
            end(e)
        finally:
            if joined[0]:
                calm.join(host, -1)

    digest = [None]

    def follow():
        # the sha256 read as the bytes become whole from the first on (the pages just written, still in memory): the
        # check costs no wait at the end
        sha = hashlib.sha256()
        at = 0
        # unbuffered: a buffered read would read ahead into bytes not written yet, and serve them later as the file's
        with open(job.parts, "rb", buffering=0) as r:
            while True:
                edge = whole()
                while at < edge:
                    block = r.read(min(8 << 20, edge - at))
                    if not block:
                        break
                    sha.update(block)
                    at += len(block)
                if at >= job.total:
                    digest[0] = sha.hexdigest()
                    return
                if over.is_set() and at >= whole():
                    return
                over.wait(0.2)

    threads = [threading.Thread(target=connection, name=f"afflatus-download-{job.id[:8]}-{n}", daemon=True) for n in range(width)]
    hasher = threading.Thread(target=follow, name=f"afflatus-sha256-{job.id[:8]}", daemon=True) if job.sha256 else None
    try:
        for t in threads + ([hasher] if hasher else []):
            t.start()
        for t in threads:
            t.join()
    finally:
        # every connection let go first (a stop is seen within a block): nothing writes while the file is cut back
        for t in threads:
            t.join()
        over.set()
        if hasher:
            hasher.join()
        have = whole()
        try:
            os.truncate(job.parts, have)
            os.replace(job.parts, job.part)
        except OSError:
            _remove(job.parts)
            have = 0
        job.bytes = have
    if ended and not isinstance(ended[0], _NoParts):
        raise ended[0]
    if job.cancelled.is_set():
        raise _Stopped()
    if ended:
        job.note = f"{ended[0]}: the rest over one connection, from byte {have}."
    return have, digest[0] if have == job.total else None


def _sha256_of(path, moved=None):
    sha = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(8 << 20), b""):
            sha.update(block)
            if moved:
                moved(len(block))
    return sha.hexdigest()


def _checked_there(job):
    """The file in the folder when it was asked for with a sha256: True when its bytes are those its source lists (nothing
    to fetch). Else it is removed, before anything else, so that ComfyUI never loads it, and the file is fetched as any."""
    try:
        size = os.path.getsize(job.path)
    except OSError:
        # gone meanwhile: fetched as any
        return False
    job.note = "Checking the file that is there against the sha256 its source lists."
    job.bytes = 0
    if not job.declared or size == job.declared:

        def moved(n):
            job.bytes += n

        if _sha256_of(job.path, moved) == job.sha256:
            job.total = job.bytes = size
            return True
    job.bytes = 0
    try:
        os.remove(job.path)
    except OSError as e:
        raise Refused(f"a file of that name is in the folder with other bytes than its source lists, and it could not be removed ({e.strerror or e})")
    job.note = "The file that was there is not the one its source lists: removed, and fetched again."
    return False


def run(job, attempts=5, backoff=2.0, opener=_OPENER.open, chunk=1 << 20, timeout=60, renew_wait=RENEW_WAIT_S,
        slots=_SLOTS, width=CONNECTIONS, parts_from=PARTS_FROM, piece_size=None, limit=None, calm=_CALM):
    """Fetch `job.url` into `job.path`, through `<path>.part`: picked up with a Range after a cut (or from what an earlier
    download of it left, _taken_over), tried again with a growing wait, named only once whole. Sets job.state to done,
    error or stopped; the .part outlives only a stop asked to keep it and a failure that passes (_Passing). A big file on a
    source's own link that answers parts of it comes over `width` connections at once first (_in_parts); every request
    takes one of `slots`, the connections all downloads share. A 429 is waited out as `limit` says (LIMIT), the host's hold
    kept on `calm` for every download from it."""
    part = job.part
    have = 0
    fails = 0
    limit = {**LIMIT, **(limit or {})}
    host = urllib.parse.urlsplit(job.url).netloc
    patience = _Patience(limit)
    # the host's 429 this download waited out already (a later hold, another's, is waited for, never this one twice), and when
    # its last request went
    mine = [0.0, 0.0]
    digest = None
    # all of it came over several connections: nothing left for one
    came = False
    try:
        _remove(part)
        _remove(job.parts)
        if job.there and job.sha256 and _checked_there(job):
            job.found = True
            job.state = "done"
            job.note = None
            return
        os.makedirs(os.path.dirname(job.path), exist_ok=True)
        have = _taken_over(job)
        job.bytes = have
        if have:
            job.note = f"Carrying on from byte {have}, as an earlier download of it left it."
        # only a source's own link: Afflatus's one-time address streams one request at a time (a second lets the first go)
        if job.direct and width > 1 and job.total >= parts_from and have < job.total:
            while True:
                try:
                    with _turn(job, slots, calm, host, mine):
                        parts = _answers_parts(job, have, opener, timeout)
                    break
                except _Limited as e:
                    wait = _limited(calm, host, patience, mine, e.said)
                    job.note = f"The source asks to slow down (429): waiting {_words(wait)}, then {f'carrying on from byte {have}' if have else 'starting'}."
                    if job.cancelled.wait(wait):
                        raise _Stopped()
            if parts and job.total >= parts_from:
                _room(job, have)
                have, digest = _in_parts(job, have, opener, attempts, backoff, chunk, timeout, renew_wait, slots, width, piece_size,
                                         (calm, host, patience, limit))
                came = have == job.total
        while not came:
            if job.cancelled.is_set():
                raise _Stopped()
            before = have
            try:
                req = urllib.request.Request(job.url, headers={"User-Agent": "afflatus-nodes", **({"Range": f"bytes={have}-"} if have else {})})
                with _turn(job, slots, calm, host, mine), opener(req, timeout=timeout) as res:
                    _a_file(res, "the source" if job.direct else "Afflatus")
                    got = re.match(r"^bytes (\d+)-\d+/(\d+|\*)$", res.headers.get("Content-Range") or "") if res.status == 206 else None
                    if have and got and int(got.group(1)) == have:
                        mode = "ab"
                        if got.group(2) != "*":
                            job.total = _within(job, int(got.group(2)))
                    else:
                        # a part that starts elsewhere than asked is not the file from its first byte, and its length is
                        # not the file's: written as the whole file, it was named whole once that many bytes came
                        if res.status == 206 and not (got and got.group(1) == "0"):
                            raise Refused(f"the source sent {res.headers.get('Content-Range') or 'a part with no range'} for bytes {have}-")
                        # the whole file (a source that does not resume sends it from the start): what was there goes
                        if have:
                            job.note = "The source does not resume downloads: starting over."
                        have = 0
                        mode = "wb"
                        size = int(got.group(2)) if got and got.group(2) != "*" else int(res.headers.get("Content-Length") or 0)
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
                # a rate limit (Cloudflare's page in front of Civitai's file server): its Retry-After waited out, no try
                # counted, as long as the patience lasts
                if e.code == 429:
                    wait = _limited(calm, host, patience, mine, _retry_after(e.headers))
                    job.note = f"{where[0].upper()}{where[1:]} asks to slow down (429): waiting {_words(wait)}, then {f'carrying on from byte {have}' if have else 'trying again'}."
                    if job.cancelled.wait(wait):
                        raise _Stopped()
                    continue
                if e.code < 500:
                    raise Refused(_gone(where, e.code))
                why = f"{where} answered {e.code}"
            except Exception as e:  # a cut, a timeout, a reset: tried again
                # a full disk stays full: said at once (Afflatus fails the file, and makes room or sends its job elsewhere)
                if isinstance(e, OSError) and e.errno in DISK_FULL:
                    raise Refused(f"the disk is full ({e.strerror or e})")
                # a host that cannot be reached before a byte came: five tries and their waits changed nothing (Afflatus's own
                # downloads say it at once too)
                if not have and _unreachable(e):
                    host = urllib.parse.urlsplit(job.url).hostname or "the source"
                    raise Refused(f"could not reach {host} ({getattr(e, 'reason', e)})")
                why = str(e) or type(e).__name__
            # what is on disk is what counts: a write cut half way leaves less than was read
            have = os.path.getsize(part) if os.path.exists(part) else 0
            job.bytes = have
            if have > before:
                patience.gained()
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
        if job.sha256:
            if not digest:
                job.note = "Checking the file against the sha256 its source lists."
                digest = _sha256_of(part)
            if digest != job.sha256:
                raise Refused(f"the file that came is not the one its source lists (sha256 {digest[:12]}…, {job.sha256[:12]}… listed)")
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


def sweep_parts(folder_paths, older_than=STALE_PART_S, now=None, bare_older_than=STALE_BARE_PART_S):
    """Remove the .part files of model downloads left in the model folders by a ComfyUI that stopped half way: only
    those of a model file's name, not written to for `older_than` seconds (a download under way writes all the time,
    Afflatus's own included). One with no download's id (Afflatus's own, kept for its next try to carry on from) only
    after `bare_older_than`. Returns the paths removed."""
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
                    age = older_than if OWN_PART.search(name) else bare_older_than
                    try:
                        if now - os.path.getmtime(path) > age:
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
            root, path = target(body.get("folder"), body.get("filename"), folder_paths, body.get("dir"))
        except Refused as e:
            return web.Response(status=400, text=str(e))
        forget()
        job = Job(body["url"], path, body.get("total") or 0, body.get("sha256"))
        # a file there asked for with the bytes it must have is checked against them (run, _checked_there): one put there
        # unchecked was taken as Afflatus's own. Without a sha256 there is nothing to check it by: there already
        job.there = os.path.exists(path)
        if (job.there and not job.sha256) or any(j.path == path and j.state == "downloading" for j in jobs.values()):
            return web.Response(status=409, text="that file is there already, or being downloaded")
        if sum(j.state == "downloading" for j in jobs.values()) >= MAX_JOBS:
            return web.Response(status=429, text=f"{MAX_JOBS} downloads are under way already")
        # a disk without the room is said now, not once it is full: beside what the downloads under way still write (a file
        # there, checked, may need none; run says it if it does)
        if job.total and not job.there:
            free = await asyncio.to_thread(lambda: shutil.disk_usage(root).free) - reserved()
            if free < job.total:
                return web.Response(status=507, text=f"the disk has {max(0, free)} bytes free, the file is {int(job.total)}")
        job.reserved = lambda: reserved(job)
        job.busy_parts = lambda: {j.part for j in jobs.values() if j is not job and j.alive}
        jobs[job.id] = job
        threading.Thread(target=run, args=(job,), name=f"afflatus-download-{job.id[:8]}", daemon=True).start()
        return web.json_response({"id": job.id, "path": path, "root": root})

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
        keep = request.query.get("keep") == "1"
        job.stop(keep=keep)
        # a kept .part is what the next download carries on from: answered once the thread has cut it back (the pieces over
        # several connections), so that ComfyUI's restart asked right after does not lose them
        ends = time.monotonic() + LET_GO_S
        while keep and job.alive and time.monotonic() < ends:
            await asyncio.sleep(0.05)
        return web.json_response({"ok": True, "let_go": not job.alive})

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

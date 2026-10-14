"""Model files sent by Afflatus itself, for a file no site has (a LoRA of your own): the other way from downloads.py.

A rented ComfyUI cannot reach Afflatus's computer, so a file only Afflatus has is pushed to it, a piece at a time: each
piece is written at the byte the upload is at, to `<name>.<id>.part` beside where the file goes, and the file is given
its name only once all of it is there, as a download is. A piece cut short is sent again from the byte the upload says
it has (GET answers it), so a connection that drops loses one piece, not the file.

Routes (registered by __init__.py on ComfyUI's server):
  POST   /afflatus/upload {folder, filename, total}  → {id, path}
  PUT    /afflatus/upload/<id>?offset=<n>  (application/octet-stream, at most PIECE_MAX bytes)  → {state, bytes, total}
  GET    /afflatus/upload/<id>  → {state: uploading|done|error|stopped, bytes, total, error}
  DELETE /afflatus/upload/<id>  → stops it, and removes its .part

Neither body is one a page of another site can send without asking first (a JSON body, then raw bytes). The file goes
where a download would (downloads.target: a model folder, a model file's name, never outside it, never over a file
that is there), its size is said first and nothing past it is written, and a folder without the room for it is said at
the start, not once the disk is full. An upload nothing is sent to for IDLE_S is dropped with its .part.
"""

import asyncio
import os
import shutil
import threading
import time
import uuid

from .downloads import Refused, _remove, target

# Afflatus sends one file at a time to a machine; two leaves room for a second Afflatus, no more
MAX_UPLOADS = 2
# the most one piece may hold: Afflatus sends 32 MB pieces
PIECE_MAX = 64 << 20
# read from the connection this much at a time
READ = 1 << 20
# an upload not sent to for this long is given up: the sender stopped
IDLE_S = 600
# a piece whose bytes stop coming this long is given up: the connection is gone (a sleeping PC leaves it half open)
READ_S = 60
# how often uploads left alone are looked for (their .part removed), whether or not anyone asks
TIDY_S = 60
# finished uploads are forgotten after an hour
KEEP_S = 3600


class Upload:
    def __init__(self, path, total):
        self.id = uuid.uuid4().hex
        self.path = path
        self.total = total
        self.bytes = 0
        self.state = "uploading"
        self.error = None
        self.last = time.time()
        self.ended = None
        # one piece at a time: a second one sent while the first is written is turned away
        self.writing = False

    @property
    def part(self):
        return f"{self.path}.{self.id[:8]}.part"

    def view(self):
        return {"state": self.state, "bytes": self.bytes, "total": self.total, "error": self.error}

    def end(self, state, error=None):
        if self.state != "uploading":
            return
        # said first: a .part that cannot be removed now (held open on Windows) never leaves it "uploading"
        self.state = state
        self.error = error
        self.ended = time.time()
        if state != "done":
            try:
                _remove(self.part)
            except OSError:
                pass  # the start's sweep removes it (downloads.sweep_parts)


def write_piece(upload, offset, data):
    """Write `data` at `offset` of the upload's .part; once all of it is there, give the file its name. Raises Refused."""
    if offset != upload.bytes:
        raise Refused(f"the upload is at byte {upload.bytes}, not {offset}")
    if upload.bytes + len(data) > upload.total:
        raise Refused(f"more than the {upload.total} bytes it said")
    os.makedirs(os.path.dirname(upload.path), exist_ok=True)
    with open(upload.part, "r+b" if offset else "wb") as f:
        f.seek(offset)
        f.write(data)
    if upload.state != "uploading":
        # stopped while this piece was written: its .part goes, as the stop said
        _remove(upload.part)
        raise Refused(f"the upload is {upload.state}")
    upload.bytes += len(data)
    if upload.bytes == upload.total:
        # never over a file that is there: ComfyUI may have it in use
        if os.path.exists(upload.path):
            raise Refused("a file of that name is in the folder already")
        os.replace(upload.part, upload.path)
        upload.state = "done"
        upload.ended = time.time()


def register(routes, web, folder_paths):
    """The upload routes on ComfyUI's server (`routes`, aiohttp's `web`)."""
    uploads = {}

    def tidy_forever():
        while True:
            time.sleep(TIDY_S)
            try:
                tidy()
            except Exception:
                pass

    def tidy():
        now = time.time()
        for u in list(uploads.values()):
            if u.state == "uploading" and not u.writing and now - u.last > IDLE_S:
                u.end("stopped", "nothing was sent for a while: the upload was given up")
        for key in [k for k, u in uploads.items() if u.ended and now - u.ended > KEEP_S]:
            del uploads[key]

    # an upload left alone drops its .part even when nobody asks for uploads any more (Afflatus gone silent)
    threading.Thread(target=tidy_forever, name="afflatus-uploads-tidy", daemon=True).start()

    @routes.post("/afflatus/upload")
    async def _afflatus_upload(request):
        if request.content_type != "application/json":
            return web.Response(status=415, text="a JSON body is expected")
        try:
            body = await request.json()
        except Exception:
            body = None
        if not isinstance(body, dict):
            return web.Response(status=400, text="a JSON object is expected")
        total = body.get("total")
        if not isinstance(total, int) or isinstance(total, bool) or total <= 0:
            return web.Response(status=400, text="the file's size is needed")
        try:
            root, path = target(body.get("folder"), body.get("filename"), folder_paths)
        except Refused as e:
            return web.Response(status=400, text=str(e))
        tidy()
        if os.path.exists(path) or any(u.path == path and u.state == "uploading" for u in uploads.values()):
            return web.Response(status=409, text="that file is there already, or being uploaded")
        if sum(u.state == "uploading" for u in uploads.values()) >= MAX_UPLOADS:
            return web.Response(status=429, text=f"{MAX_UPLOADS} uploads are under way already")
        free = await asyncio.to_thread(lambda: shutil.disk_usage(root).free)
        if free < total:
            return web.Response(status=507, text=f"the disk has {free} bytes free, the file is {total}")
        u = Upload(path, total)
        uploads[u.id] = u
        return web.json_response({"id": u.id, "path": path})

    @routes.put("/afflatus/upload/{id}")
    async def _afflatus_upload_piece(request):
        u = uploads.get(request.match_info.get("id", ""))
        if u is None:
            return web.Response(status=404)
        if request.content_type != "application/octet-stream":
            return web.Response(status=415, text="raw bytes are expected")
        if u.state != "uploading":
            return web.Response(status=409, text=f"the upload is {u.state}")
        try:
            offset = int(request.rel_url.query.get("offset", ""))
        except ValueError:
            return web.Response(status=400, text="the piece's offset is needed")
        size = request.content_length
        if size is None or size <= 0 or size > PIECE_MAX:
            return web.Response(status=400, text=f"a piece is 1 to {PIECE_MAX} bytes, with its length said")
        if offset != u.bytes or offset + size > u.total:
            # the sender carries on from where the upload is
            return web.Response(status=409, text=f"the upload is at byte {u.bytes} of {u.total}")
        if u.writing:
            return web.Response(status=409, text="a piece is being written")
        u.writing = True
        try:
            data = bytearray()
            while len(data) < size:
                try:
                    block = await asyncio.wait_for(request.content.read(min(READ, size - len(data))), READ_S)
                except asyncio.TimeoutError:
                    block = b""
                if not block:
                    break
                data += block
            u.last = time.time()
            if len(data) != size:
                # cut short: nothing of this piece is kept, it is sent again
                return web.Response(status=400, text=f"the piece came short: {len(data)} of {size} bytes")
            await asyncio.to_thread(write_piece, u, offset, bytes(data))
        except Refused as e:
            u.end("error", str(e))
            return web.Response(status=409 if u.state == "stopped" else 400, text=str(e))
        except OSError as e:
            u.end("error", str(e))
            return web.Response(status=500, text=str(e))
        finally:
            u.writing = False
            u.last = time.time()
        return web.json_response(u.view())

    @routes.get("/afflatus/upload/{id}")
    async def _afflatus_upload_state(request):
        tidy()
        u = uploads.get(request.match_info.get("id", ""))
        return web.Response(status=404) if u is None else web.json_response(u.view())

    @routes.delete("/afflatus/upload/{id}")
    async def _afflatus_upload_stop(request):
        u = uploads.get(request.match_info.get("id", ""))
        if u is None:
            return web.Response(status=404)
        u.end("stopped")
        return web.json_response({"ok": True})

    return uploads

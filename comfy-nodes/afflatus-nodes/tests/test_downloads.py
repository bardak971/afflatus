"""The pack's model downloads: to disk as the file comes, picked up again after a cut, named only once whole. A real
HTTP server on this machine stands in for Afflatus's one-time address; no ComfyUI."""

import asyncio
import hashlib
import http.server
import os
import re
import threading
import types

import pytest

from afflatus_nodes import downloads
from afflatus_nodes.downloads import Job, Refused, relay_ok, run, target

SIZE = 3 * 2**20
FILE = bytes(((i * 31) + (i >> 12)) & 255 for i in range(SIZE))
RELAY = "/api/downloads/fetch/abc-123"


class _Site:
    """Afflatus's one-time address: the file from the byte asked for, cut short `cuts` times; `ranges` ignores Range when false."""

    def __init__(self, cuts=0, ranges=True, status=200):
        self.cuts = cuts
        self.ranges = ranges
        self.status = status
        self.asked = []
        site = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                site.asked.append(self.headers.get("Range"))
                if site.status != 200:
                    self.send_response(site.status)
                    self.end_headers()
                    return
                got = re.match(r"^bytes=(\d+)-$", self.headers.get("Range") or "")
                start = int(got.group(1)) if got and site.ranges else 0
                body = FILE[start:]
                self.send_response(206 if start else 200)
                self.send_header("Content-Length", str(len(body)))
                if start:
                    self.send_header("Content-Range", f"bytes {start}-{SIZE - 1}/{SIZE}")
                self.end_headers()
                if site.cuts > 0:
                    site.cuts -= 1
                    self.wfile.write(body[: SIZE // 3])
                    self.wfile.flush()
                    self.connection.shutdown(2)
                    return
                self.wfile.write(body)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}{RELAY}?t=token"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class _FolderPaths:
    """ComfyUI's folder_paths, over model folders of a test's own."""

    def __init__(self, root):
        self.folder_names_and_paths = {}
        for name in ("loras", "custom_nodes", "configs"):
            path = os.path.join(root, name)
            os.makedirs(path, exist_ok=True)
            self.folder_names_and_paths[name] = ([os.path.join(root, "missing"), path], set())

    def get_folder_paths(self, name):
        return self.folder_names_and_paths[name][0]


@pytest.fixture
def site():
    made = []

    def make(**kw):
        s = _Site(**kw)
        made.append(s)
        return s

    yield make
    for s in made:
        s.close()


def _fetch(tmp_path, url, **kw):
    job = Job(url, str(tmp_path / "loras" / "model.safetensors"))
    run(job, backoff=0.01, **kw)
    return job


def test_picks_up_after_each_cut_and_the_file_is_the_same(tmp_path, site):
    s = site(cuts=2)
    job = _fetch(tmp_path, s.url)
    assert (job.state, job.error, job.bytes, job.total) == ("done", None, SIZE, SIZE)
    with open(job.path, "rb") as f:
        assert hashlib.sha256(f.read()).digest() == hashlib.sha256(FILE).digest()
    # asked again from exactly where each cut left it
    assert s.asked == [None, f"bytes={SIZE // 3}-", f"bytes={2 * (SIZE // 3)}-"]
    assert os.listdir(tmp_path / "loras") == ["model.safetensors"]


def test_starts_over_when_ranges_are_ignored(tmp_path, site):
    s = site(cuts=1, ranges=False)
    job = _fetch(tmp_path, s.url)
    assert job.state == "done"
    with open(job.path, "rb") as f:
        assert f.read() == FILE


def test_gives_up_after_tries_that_gain_nothing_and_leaves_nothing(tmp_path, site):
    s = site(status=503)
    job = _fetch(tmp_path, s.url, attempts=3)
    assert job.state == "error" and "3 times in a row" in job.error
    assert len(s.asked) == 3
    assert os.listdir(tmp_path / "loras") == []


def test_a_gone_address_is_not_tried_again(tmp_path, site):
    s = site(status=404)
    job = _fetch(tmp_path, s.url)
    assert job.state == "error" and "404" in job.error
    assert len(s.asked) == 1


def test_only_afflatus_one_time_addresses():
    assert relay_ok("http://192.168.1.5:8721/api/downloads/fetch/0f3a-9?t=abc")
    for url in ("http://x/api/downloads/fetch/1", "file:///etc/passwd", "http://x/other?t=1", "http:///api/downloads/fetch/1?t=1", 42, None):
        assert not relay_ok(url)


def test_only_into_a_model_folder_and_under_a_model_name(tmp_path):
    fp = _FolderPaths(str(tmp_path))
    root, path = target("loras", "wan/high.safetensors", fp)
    # the first of the folder's paths that is there
    assert root == os.path.realpath(tmp_path / "loras")
    assert path == os.path.join(root, "wan", "high.safetensors")
    for folder, name in (
        ("loras", "../x.safetensors"),
        ("loras", "a/../../x.safetensors"),
        ("loras", "run.py"),
        ("loras", "C:x.safetensors"),
        ("custom_nodes", "x.safetensors"),
        ("configs", "x.ckpt"),
        ("nowhere", "x.safetensors"),
    ):
        with pytest.raises(Refused):
            target(folder, name, fp)


class _Request:
    def __init__(self, body=None, content_type="application/json", match=None):
        self.content_type = content_type
        self._body = body
        self.match_info = match or {}

    async def json(self):
        return self._body


def _routes():
    found = {}

    def register(method):
        return lambda path: lambda fn: found.setdefault((method, path), fn)

    routes = types.SimpleNamespace(get=register("GET"), post=register("POST"), delete=register("DELETE"))
    web = types.SimpleNamespace(
        Response=lambda status=200, text="": types.SimpleNamespace(status=status, text=text, body=None),
        json_response=lambda body: types.SimpleNamespace(status=200, text="", body=body),
    )
    return found, routes, web


def test_the_routes_start_say_and_stop_a_download(tmp_path, site):
    found, routes, web = _routes()
    fp = _FolderPaths(str(tmp_path))
    downloads.register(routes, web, fp)
    start, state = found[("POST", "/afflatus/download")], found[("GET", "/afflatus/download/{id}")]
    s = site()

    said = asyncio.run(start(_Request({"url": s.url, "folder": "loras", "filename": "a.safetensors", "total": SIZE})))
    assert said.status == 200 and said.body["path"].endswith("a.safetensors")
    for _ in range(500):
        now = asyncio.run(state(_Request(match={"id": said.body["id"]}))).body
        if now["state"] != "downloading":
            break
        threading.Event().wait(0.01)
    assert now["state"] == "done" and now["bytes"] == SIZE
    # the same again: it is there
    assert asyncio.run(start(_Request({"url": s.url, "folder": "loras", "filename": "a.safetensors"}))).status == 409
    assert asyncio.run(start(_Request({"url": "http://elsewhere/x", "folder": "loras", "filename": "b.safetensors"}))).status == 400
    assert asyncio.run(start(_Request({"url": s.url, "folder": "custom_nodes", "filename": "b.safetensors"}))).status == 400
    assert asyncio.run(start(_Request("{}", content_type="text/plain"))).status == 415
    assert asyncio.run(state(_Request(match={"id": "nope"}))).status == 404


def test_a_stop_removes_the_part(tmp_path):
    job = Job("http://127.0.0.1:9/api/downloads/fetch/x?t=1", str(tmp_path / "loras" / "m.safetensors"))
    job.cancelled.set()
    run(job)
    assert job.state == "stopped"
    assert not os.path.exists(job.path + ".part")

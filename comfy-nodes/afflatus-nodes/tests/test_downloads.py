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
from afflatus_nodes.downloads import Job, Refused, direct_ok, relay_ok, run, target

SIZE = 3 * 2**20
FILE = bytes(((i * 31) + (i >> 12)) & 255 for i in range(SIZE))
RELAY = "/api/downloads/fetch/abc-123"


class _Site:
    """Afflatus's one-time address: the file from the byte asked for, cut short `cuts` times; `ranges` ignores Range when false."""

    def __init__(self, cuts=0, ranges=True, status=200, length=True, extra=0, expires=False):
        self.cuts = cuts
        # a signed link that expires at its first cut: every request after it is refused (403)
        self.expires = expires
        self.expired = False
        self.ranges = ranges
        self.status = status
        # without a length, the end of the body is the end of the connection; `extra` bytes more than the file
        self.length = length
        self.extra = extra
        self.asked = []
        site = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                site.asked.append(self.headers.get("Range"))
                if site.expired:
                    self.send_response(403)
                    self.end_headers()
                    return
                if site.status != 200:
                    self.send_response(site.status)
                    self.end_headers()
                    return
                got = re.match(r"^bytes=(\d+)-$", self.headers.get("Range") or "")
                start = int(got.group(1)) if got and site.ranges else 0
                body = FILE[start:] + bytes(site.extra)
                self.send_response(206 if start else 200)
                if site.length:
                    self.send_header("Content-Length", str(len(body)))
                if start:
                    self.send_header("Content-Range", f"bytes {start}-{SIZE - 1}/{SIZE}")
                self.end_headers()
                if site.cuts > 0:
                    site.cuts -= 1
                    site.expired = site.expires
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


def test_a_source_saying_more_than_was_declared_is_refused_before_writing(tmp_path, site):
    s = site()
    job = Job(s.url, str(tmp_path / "loras" / "model.safetensors"), total=SIZE // 2)
    run(job, backoff=0.01)
    assert job.state == "error" and f"{SIZE // 2} were said" in job.error
    assert not [n for n in os.listdir(tmp_path / "loras")] if os.path.isdir(tmp_path / "loras") else True


def test_a_file_of_unknown_size_is_refused(tmp_path, site):
    s = site(length=False)
    job = _fetch(tmp_path, s.url)
    assert job.state == "error" and "size of the file is not known" in job.error
    assert os.listdir(tmp_path / "loras") == []


def test_never_more_than_the_size_it_said(tmp_path, site):
    # Afflatus said the size; the address sends on past it, with no length of its own
    s = site(length=False, extra=5 * 2**20)
    job = Job(s.url, str(tmp_path / "loras" / "model.safetensors"), SIZE)
    run(job, backoff=0.01)
    assert job.state == "error" and f"more than the {SIZE} bytes" in job.error
    assert job.bytes <= SIZE
    assert os.listdir(tmp_path / "loras") == []


def test_a_sub_folder_on_another_drive_is_refused_not_a_crash(tmp_path, monkeypatch):
    fp = _FolderPaths(str(tmp_path))

    def other_drive(paths):
        raise ValueError("Paths don't have the same drive")

    monkeypatch.setattr(downloads.os.path, "commonpath", other_drive)
    with pytest.raises(Refused):
        target("loras", "linked/x.safetensors", fp)


def test_old_parts_are_swept_and_nothing_else(tmp_path):
    fp = _FolderPaths(str(tmp_path))
    loras = tmp_path / "loras"
    (loras / "wan").mkdir()
    names = ["old.safetensors.0123abcd.part", "wan/old.ckpt.part", "fresh.safetensors.part", "notes.txt.part", "kept.safetensors"]
    for name in names:
        (loras / name).write_bytes(b"x")
    nodes = tmp_path / "custom_nodes" / "old.safetensors.part"
    nodes.write_bytes(b"x")
    now = os.path.getmtime(loras / "kept.safetensors")
    # all of them but the fresh one untouched for two hours
    for path in [loras / n for n in names if not n.startswith("fresh")] + [nodes]:
        os.utime(path, (now - 7200, now - 7200))
    removed = downloads.sweep_parts(fp, now=now)
    assert sorted(os.path.relpath(p, loras).replace(os.sep, "/") for p in removed) == ["old.safetensors.0123abcd.part", "wan/old.ckpt.part"]
    assert sorted(os.listdir(loras)) == ["fresh.safetensors.part", "kept.safetensors", "notes.txt.part", "wan"]
    assert nodes.exists()


def test_at_most_two_at_once_and_a_stop_is_said_at_once(tmp_path, site):
    found, routes, web = _routes()
    fp = _FolderPaths(str(tmp_path))
    jobs = downloads.register(routes, web, fp)
    start, stop = found[("POST", "/afflatus/download")], found[("DELETE", "/afflatus/download/{id}")]
    s = site()
    # two under way (their threads stand-ins: nothing runs them)
    for name in ("a", "b"):
        job = Job(s.url, str(tmp_path / "loras" / f"{name}.safetensors"), SIZE)
        jobs[job.id] = job
    assert asyncio.run(start(_Request({"url": s.url, "folder": "loras", "filename": "c.safetensors", "total": SIZE}))).status == 429
    # one stopped: it says so at once, and the same file can be asked for again straight away
    first = next(iter(jobs.values()))
    assert asyncio.run(stop(_Request(match={"id": first.id}))).status == 200
    assert first.state == "stopped" and first.cancelled.is_set()
    again = asyncio.run(start(_Request({"url": s.url, "folder": "loras", "filename": "a.safetensors", "total": SIZE})))
    assert again.status == 200
    assert jobs[again.body["id"]].part != first.part
    for _ in range(500):
        if jobs[again.body["id"]].state != "downloading":
            break
        threading.Event().wait(0.01)
    assert jobs[again.body["id"]].state == "done"


def test_only_the_sources_own_download_links():
    for url in (
        "https://huggingface.co/org/model/resolve/main/model.safetensors",
        "https://us.aws.cdn.hf.co/xet-bridge-us/abc?X-Xet-Signed=1",
        "https://cas-bridge.xethub.hf.co/xet-bridge-us/abc?sig=1",
        "https://civitai-delivery-worker-prod.abc123.r2.cloudflarestorage.com/1/model/x.safetensors?X-Amz-Signature=1",
    ):
        assert direct_ok(url), url
    for url in (
        "http://huggingface.co/x.safetensors",  # not https
        "https://huggingface.co.evil.example/x",  # only looks like it
        "https://evilhuggingface.co/x",
        "https://user:pass@huggingface.co/x",
        "https://example.com/x.safetensors",
        "file:///etc/passwd",
        None,
        "https://huggingface.co/" + "a" * 4000,
    ):
        assert not direct_ok(url), url


def test_an_expired_link_waits_for_a_fresh_one_and_carries_on(tmp_path, site):
    first = site(cuts=1, expires=True)
    fresh = site()
    job = Job(first.url, str(tmp_path / "loras" / "model.safetensors"))
    # the stand-in sites are local http; a real signed link is https on the source's host
    job.direct = True
    t = threading.Thread(target=run, args=(job,), kwargs={"backoff": 0.01, "renew_wait": 5})
    t.start()
    for _ in range(500):
        if job.expired:
            break
        threading.Event().wait(0.01)
    assert job.expired and "expired" in job.note and job.view()["expired"] is True
    job.renew(fresh.url)
    t.join(10)
    assert (job.state, job.error, job.expired) == ("done", None, False)
    with open(job.path, "rb") as f:
        assert f.read() == FILE
    # the fresh link was asked from the byte the first left off at: the .part was kept
    assert fresh.asked == [f"bytes={SIZE // 3}-"]


def test_an_expired_link_without_a_fresh_one_gives_up_and_leaves_nothing(tmp_path, site):
    first = site(cuts=1, expires=True)
    job = Job(first.url, str(tmp_path / "loras" / "model.safetensors"))
    job.direct = True
    run(job, backoff=0.01, renew_wait=0.2)
    assert job.state == "error" and "expired" in job.error
    assert os.listdir(tmp_path / "loras") == []


def test_afflatus_own_address_refused_is_still_gone(tmp_path, site):
    # Afflatus's one-time address answering 403 is not a link to renew: the download is over
    s = site(status=403)
    job = _fetch(tmp_path, s.url)
    assert job.state == "error" and "Afflatus answered 403" in job.error


def test_a_missing_model_folder_is_made_where_its_parent_can_be_written(tmp_path):
    """A fresh network volume: ComfyUI's models folder is there, none of its folders; the first path of one is made."""

    class Paths:
        folder_names_and_paths = {"vae": ([str(tmp_path / "models" / "vae")], set()), "custom_nodes": ([str(tmp_path / "custom_nodes")], set())}

        def get_folder_paths(self, name):
            return self.folder_names_and_paths[name][0]

    (tmp_path / "models").mkdir()
    made = downloads.model_dir("vae", Paths())
    assert made == os.path.realpath(str(tmp_path / "models" / "vae"))
    assert os.path.isdir(made)
    # a parent that is not there: nothing is made out of thin air
    Paths.folder_names_and_paths["vae"] = ([str(tmp_path / "nowhere" / "vae")], set())
    assert downloads.model_dir("vae", Paths()) is None
    assert not (tmp_path / "nowhere").exists()


def test_a_full_disk_is_said_at_once_and_not_tried_again(tmp_path, site, monkeypatch):
    # no room for what is left of the file: refused before a byte of it is written, one request only
    s = site()
    monkeypatch.setattr(downloads.shutil, "disk_usage", lambda path: types.SimpleNamespace(free=SIZE // 2, total=10 * SIZE, used=0))
    job = _fetch(tmp_path, s.url)
    assert job.state == "error" and job.error.startswith("the disk is full")
    assert len(s.asked) == 1
    assert os.listdir(tmp_path / "loras") == []


def test_a_write_that_finds_the_disk_full_is_not_tried_again(tmp_path, site, monkeypatch):
    s = site()
    real = open

    def full(path, mode="r", *a, **kw):
        if str(path).endswith(".part") and "b" in mode and ("w" in mode or "a" in mode):
            raise OSError(downloads.errno.ENOSPC, "No space left on device")
        return real(path, mode, *a, **kw)

    monkeypatch.setattr("builtins.open", full)
    job = _fetch(tmp_path, s.url)
    assert job.state == "error" and "the disk is full" in job.error
    assert len(s.asked) == 1


def test_the_room_counts_what_other_downloads_still_write(tmp_path, site, monkeypatch):
    s = site()
    monkeypatch.setattr(downloads.shutil, "disk_usage", lambda path: types.SimpleNamespace(free=SIZE + SIZE // 2, total=10 * SIZE, used=0))
    job = Job(s.url, str(tmp_path / "loras" / "model.safetensors"))
    job.reserved = lambda: SIZE
    run(job, backoff=0.01)
    assert job.state == "error" and "kept for other downloads" in job.error


def test_the_disk_is_said_and_a_model_file_removed_only_from_a_model_folder(tmp_path):
    found, routes, web = _routes()
    fp = _FolderPaths(str(tmp_path))
    fp.models_dir = str(tmp_path)
    downloads.register(routes, web, fp)
    disk, remove = found[("GET", "/afflatus/disk")], found[("POST", "/afflatus/models/remove")]
    said = asyncio.run(disk(_Request())).body
    assert said["free"] > 0 and said["total"] >= said["free"] and said["downloading"] == 0

    (tmp_path / "loras" / "wan").mkdir()
    (tmp_path / "loras" / "wan" / "a.safetensors").write_bytes(b"x" * 1000)
    (tmp_path / "custom_nodes" / "b.safetensors").write_bytes(b"x")
    gone = asyncio.run(remove(_Request({"folder": "loras", "filename": "wan/a.safetensors"})))
    assert gone.status == 200 and gone.body == {"removed": 1000}
    assert not (tmp_path / "loras" / "wan" / "a.safetensors").exists()
    assert asyncio.run(remove(_Request({"folder": "loras", "filename": "wan/a.safetensors"}))).status == 404
    for folder, name in (("custom_nodes", "b.safetensors"), ("loras", "../custom_nodes/b.safetensors"), ("loras", "run.py"), ("nowhere", "a.safetensors")):
        assert asyncio.run(remove(_Request({"folder": folder, "filename": name}))).status == 400
    assert (tmp_path / "custom_nodes" / "b.safetensors").exists()
    assert asyncio.run(remove(_Request("{}", content_type="text/plain"))).status == 415

"""The pack's model downloads: to disk as the file comes, picked up again after a cut, named only once whole. A real
HTTP server on this machine stands in for Afflatus's one-time address; no ComfyUI."""

import asyncio
import contextlib
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
    def __init__(self, body=None, content_type="application/json", match=None, query=None):
        self.content_type = content_type
        self._body = body
        self.match_info = match or {}
        self.query = query or {}

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


def test_a_folder_comfyui_does_not_know_yet_is_made_in_models_and_known(tmp_path):
    """A pack's own folder (Veda's models/veda) before the pack is there: the file goes where the pack will read it."""
    fp = _FolderPaths(str(tmp_path))
    fp.models_dir = str(tmp_path / "models")
    (tmp_path / "models").mkdir()
    root, path = target("veda", "minimax_h3_r2va_veda_preview_fp8.safetensors", fp)
    assert root == os.path.realpath(tmp_path / "models" / "veda")
    assert path == os.path.join(root, "minimax_h3_r2va_veda_preview_fp8.safetensors")
    # ComfyUI lists it from now on, as it would once the pack registers it
    assert fp.folder_names_and_paths["veda"][0] == [str(tmp_path / "models" / "veda")]
    assert ".safetensors" in fp.folder_names_and_paths["veda"][1]
    # only a plain folder name, and never a folder of code or settings
    for folder in ("../veda", "a/b", ".hidden", "", "custom_nodes", "configs"):
        with pytest.raises(Refused):
            target(folder, "x.safetensors", fp)
    assert not (tmp_path / "hidden").exists() and not (tmp_path / "a").exists()


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


def test_the_models_folder_is_listed_with_sizes_each_file_once_and_never_a_packs_code(tmp_path):
    found, routes, web = _routes()
    fp = _FolderPaths(str(tmp_path))
    fp.models_dir = str(tmp_path)
    # two folders reading one directory, as unet and diffusion_models do
    fp.folder_names_and_paths["unet"] = ([str(tmp_path / "loras")], set())
    downloads.register(routes, web, fp)
    listing = found[("GET", "/afflatus/models/list")]
    (tmp_path / "loras" / "wan").mkdir()
    (tmp_path / "loras" / "wan" / "a.safetensors").write_bytes(b"x" * 1000)
    (tmp_path / "loras" / "notes.txt").write_bytes(b"x")
    (tmp_path / "loras" / ".hidden").mkdir()
    (tmp_path / "loras" / ".hidden" / "c.safetensors").write_bytes(b"x")
    (tmp_path / "custom_nodes" / "b.safetensors").write_bytes(b"x")
    files = asyncio.run(listing(_Request())).body["files"]
    assert [(f["folder"], f["path"], f["name"], f["bytes"]) for f in files] == [("loras", "loras/wan/a.safetensors", "wan/a.safetensors", 1000)]
    assert files[0]["modified"] > 0


def test_a_failure_that_passes_keeps_its_part_and_the_next_download_carries_on_from_it(tmp_path, site):
    s = site(cuts=1)
    first = _fetch(tmp_path, s.url, attempts=1)
    assert first.state == "error" and "1 times in a row" in first.error
    assert os.path.getsize(first.part) == SIZE // 3
    # Afflatus asks for the file again: the new download takes the bytes over, and asks only for the rest
    again = _fetch(tmp_path, s.url)
    assert (again.state, again.bytes) == ("done", SIZE)
    assert s.asked == [None, f"bytes={SIZE // 3}-"]
    with open(again.path, "rb") as f:
        assert hashlib.sha256(f.read()).digest() == hashlib.sha256(FILE).digest()
    assert os.listdir(tmp_path / "loras") == ["model.safetensors"]


def test_a_stop_asked_to_keep_its_part_keeps_it_and_one_still_written_is_never_taken(tmp_path, site):
    path = str(tmp_path / "loras" / "model.safetensors")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # what an earlier download of the file left (its own id in its name)
    with open(path + ".0badc0de.part", "wb") as f:
        f.write(FILE[:1000])
    # the route's stop with ?keep=1: the bytes it took over stay
    found, routes, web = _routes()
    jobs = downloads.register(routes, web, _FolderPaths(str(tmp_path)))
    kept = Job("http://127.0.0.1:9/api/downloads/fetch/x?t=1", path)
    jobs[kept.id] = kept
    assert asyncio.run(found[("DELETE", "/afflatus/download/{id}")](_Request(match={"id": kept.id}, query={"keep": "1"}))).status == 200
    run(kept)
    assert kept.state == "stopped" and os.path.getsize(kept.part) == 1000
    assert not os.path.exists(path + ".0badc0de.part")
    # a part another download's thread still writes is left to it: this one starts from its first byte
    s = site()
    busy = Job(s.url, path)
    busy.busy_parts = lambda: {kept.part}
    run(busy, backoff=0.01)
    assert busy.state == "done" and s.asked == [None]
    assert os.path.exists(kept.part)
    # a stop without keep removes what it had, as before
    gone = Job("http://127.0.0.1:9/api/downloads/fetch/x?t=1", str(tmp_path / "loras" / "other.safetensors"))
    with open(str(tmp_path / "loras" / "other.safetensors.0badc0de.part"), "wb") as f:
        f.write(FILE[:1000])
    gone.stop()
    run(gone)
    assert gone.state == "stopped" and not os.path.exists(gone.part)


def test_a_download_goes_to_comfyuis_own_folder_first_then_the_place_chosen(tmp_path):
    """ComfyUI lists the older name and extra_model_paths.yaml's folders first (an A1111 install's Lora): a download went
    there, where nobody looked for it (Afflatus card #59). ComfyUI's own models/<folder> comes first now, and the place
    asked for (`dir`) only when ComfyUI lists it for the folder."""
    models = tmp_path / "comfy" / "models"
    a1111 = tmp_path / "a1111" / "Lora"
    for d in (models / "loras", models / "unet", models / "diffusion_models", a1111, tmp_path / "comfy" / "custom_nodes"):
        d.mkdir(parents=True)

    class Paths:
        models_dir = str(models)
        folder_names_and_paths = {
            "loras": ([str(a1111), str(models / "loras")], set()),
            "diffusion_models": ([str(models / "unet"), str(models / "diffusion_models")], set()),
            "custom_nodes": ([str(tmp_path / "comfy" / "custom_nodes")], set()),
        }

        def get_folder_paths(self, name):
            return self.folder_names_and_paths[name][0]

    real = lambda p: os.path.realpath(str(p))  # noqa: E731
    assert downloads.model_dir("loras", Paths()) == real(models / "loras")
    assert downloads.model_dir("diffusion_models", Paths()) == real(models / "diffusion_models")
    # the place chosen, when ComfyUI lists it
    assert downloads.model_dir("loras", Paths(), str(a1111)) == real(a1111)
    root, _ = target("loras", "x.safetensors", Paths(), str(a1111))
    assert root == real(a1111)
    # a path ComfyUI does not list for the folder is never taken
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    assert downloads.model_dir("loras", Paths(), str(elsewhere)) == real(models / "loras")
    # its own folder gone: the older name, then the others in ComfyUI's order
    assert downloads.ordered("diffusion_models", [str(a1111), str(models / "unet")], str(models)) == [str(models / "unet"), str(a1111)]


class _PartsSite:
    """A source's own signed link that answers parts of the file (a 206 to `bytes=a-b`), as Civitai's storage does.
    `fault(n, start)` may answer the n-th request otherwise: "cut" (half of it, then the connection shut), a status code
    (an int), "whole" (a 200 with all of the file, as a source that does not answer parts), "redirect"; None: as asked.
    It keeps every request's Range and Authorization."""

    def __init__(self, fault=None, data=FILE, delay=0.0):
        self.fault = fault or (lambda n, start: None)
        self.data = data
        self.delay = delay
        self.asked = []
        self.auth = []
        self.lock = threading.Lock()
        site = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                with site.lock:
                    n = len(site.asked)
                    site.asked.append(self.headers.get("Range"))
                    site.auth.append(self.headers.get("Authorization"))
                try:
                    self.answer(n)
                except OSError:
                    # the pack let the connection go (a stop): nothing to answer to
                    pass

            def answer(self, n):
                size = len(site.data)
                got = re.match(r"^bytes=(\d+)-(\d*)$", self.headers.get("Range") or "")
                start = int(got.group(1)) if got else 0
                end = int(got.group(2)) if got and got.group(2) else size - 1
                what = site.fault(n, start)
                if isinstance(what, int):
                    self.send_response(what)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if what == "redirect":
                    self.send_response(302)
                    self.send_header("Location", site.elsewhere)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if what == "whole" or not got:
                    start, end = 0, size - 1
                    self.send_response(200)
                else:
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                body = site.data[start : end + 1]
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if site.delay:
                    threading.Event().wait(site.delay)
                if what == "cut":
                    self.wfile.write(body[: len(body) // 2])
                    self.wfile.flush()
                    self.connection.shutdown(2)
                    return
                self.wfile.write(body)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/file.safetensors?X-Amz-Signature=1"
        self.elsewhere = self.url

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def parts_site():
    made = []

    def make(**kw):
        s = _PartsSite(**kw)
        made.append(s)
        return s

    yield make
    for s in made:
        s.close()


PIECE = 256 * 1024
SHA = hashlib.sha256(FILE).hexdigest()


def _direct(tmp_path, url, name="model.safetensors", sha256=SHA):
    job = Job(url, str(tmp_path / "loras" / name), SIZE, sha256)
    # the stand-in sites are local http; a real signed link is https on the source's host
    job.direct = True
    return job


class _Counted:
    """The pack's own opener, counting the connections open at once on this side (a server counts its answers a moment late)."""

    def __init__(self):
        self.now = 0
        self.most = 0
        self.lock = threading.Lock()

    @contextlib.contextmanager
    def __call__(self, req, timeout=None):
        with downloads._OPENER.open(req, timeout=timeout) as res:
            with self.lock:
                self.now += 1
                self.most = max(self.most, self.now)
            try:
                yield res
            finally:
                with self.lock:
                    self.now -= 1


def _in_parts(job, **kw):
    kw = {"backoff": 0.01, "parts_from": 1, "width": 4, "piece_size": PIECE, "slots": threading.BoundedSemaphore(4), **kw}
    run(job, **kw)
    return job


def _start_of(r):
    return int(r[6:].split("-")[0])


def _ranges_asked(site):
    return [r for r in site.asked if r and not re.match(r"^bytes=(\d+)-\1$", r)]


def test_a_big_file_comes_in_parts_over_several_connections_and_is_the_same(tmp_path, parts_site):
    s = parts_site(delay=0.02)
    counted = _Counted()
    job = _in_parts(_direct(tmp_path, s.url), opener=counted)
    assert (job.state, job.error, job.bytes, job.total) == ("done", None, SIZE, SIZE)
    with open(job.path, "rb") as f:
        assert f.read() == FILE
    # one byte asked first, then each piece once, over up to 4 connections at once
    assert s.asked[0] == "bytes=0-0"
    assert sorted(_ranges_asked(s), key=_start_of) == [f"bytes={a}-{min(SIZE, a + PIECE) - 1}" for a in range(0, SIZE, PIECE)]
    assert 1 < counted.most <= 4
    assert os.listdir(tmp_path / "loras") == ["model.safetensors"]


def test_a_part_cut_or_refused_for_a_moment_is_asked_again_from_where_it_was(tmp_path, parts_site):
    # the third request cut half way, the fifth a 503: each piece asked again, the cut one from the byte it had
    s = parts_site(fault=lambda n, start: "cut" if n == 2 else 503 if n == 4 else None)
    job = _in_parts(_direct(tmp_path, s.url))
    assert (job.state, job.error) == ("done", None)
    with open(job.path, "rb") as f:
        assert f.read() == FILE
    cut = _start_of(s.asked[2])
    assert f"bytes={cut + PIECE // 2}-{cut + PIECE - 1}" in s.asked


def test_a_file_other_than_its_sha256_is_never_named(tmp_path, parts_site):
    s = parts_site()
    job = _in_parts(_direct(tmp_path, s.url, sha256="0" * 64))
    assert job.state == "error" and "sha256" in job.error
    assert os.listdir(tmp_path / "loras") == []


def test_the_sha256_is_checked_over_one_connection_too(tmp_path, site):
    s = site()
    job = Job(s.url, str(tmp_path / "loras" / "model.safetensors"), SIZE, "f" * 64)
    run(job, backoff=0.01)
    assert job.state == "error" and "sha256" in job.error
    assert os.listdir(tmp_path / "loras") == []
    good = Job(s.url, str(tmp_path / "loras" / "model.safetensors"), SIZE, SHA)
    run(good, backoff=0.01)
    assert (good.state, good.error) == ("done", None)


def test_a_source_that_does_not_answer_parts_is_read_over_one_connection(tmp_path, parts_site):
    s = parts_site(fault=lambda n, start: "whole")
    job = _in_parts(_direct(tmp_path, s.url))
    assert job.state == "done"
    with open(job.path, "rb") as f:
        assert f.read() == FILE
    # the one byte asked, answered with all of the file: then one request, as before
    assert s.asked == ["bytes=0-0", None]


def test_a_small_file_and_afflatus_own_address_come_over_one_connection(tmp_path, parts_site):
    s = parts_site()
    job = _direct(tmp_path, s.url)
    run(job, backoff=0.01, parts_from=SIZE + 1, slots=threading.BoundedSemaphore(4))
    assert job.state == "done" and s.asked == [None]
    relay = Job(s.url, str(tmp_path / "loras" / "relay.safetensors"), SIZE)
    assert relay.direct is False
    run(relay, backoff=0.01, parts_from=1, slots=threading.BoundedSemaphore(4))
    assert relay.state == "done" and s.asked == [None, None]


def test_a_source_that_stops_answering_parts_half_way_carries_on_over_one_connection(tmp_path, parts_site):
    # a 200 with the whole file from the fourth request on: the pieces whole from the first on are kept, the rest over one
    s = parts_site(fault=lambda n, start: "whole" if n >= 3 else None, delay=0.01)
    job = _in_parts(_direct(tmp_path, s.url), width=2)
    assert (job.state, job.error) == ("done", None)
    with open(job.path, "rb") as f:
        assert f.read() == FILE


def test_too_many_requests_falls_back_to_one_connection(tmp_path, parts_site):
    s = parts_site(fault=lambda n, start: 429 if n == 3 else None)
    job = _in_parts(_direct(tmp_path, s.url))
    assert job.state == "done"
    with open(job.path, "rb") as f:
        assert f.read() == FILE
    # the last request is one connection's, from the bytes whole from the first on: with none whole yet (the 429 came before
    # the first piece ended, as a busy runner has it) it asks for the whole file, with no Range at all
    assert s.asked[-1] is None or re.match(r"^bytes=\d+-$", s.asked[-1])


def test_a_stop_ends_every_connection_and_keeps_only_whole_bytes_when_asked(tmp_path, parts_site):
    for keep in (False, True):
        s = parts_site(delay=0.05)
        job = _direct(tmp_path, s.url, name=f"m{int(keep)}.safetensors")
        t = threading.Thread(target=_in_parts, args=(job,), kwargs={"width": 4})
        t.start()
        for _ in range(500):
            if job.bytes >= 3 * PIECE:
                break
            threading.Event().wait(0.01)
        job.stop(keep=keep)
        t.join(10)
        assert not t.is_alive() and job.state == "stopped"
        assert not [x for x in threading.enumerate() if x.name.startswith(f"afflatus-download-{job.id[:8]}")]
        assert not os.path.exists(job.parts) and not os.path.exists(job.path)
        if keep:
            # what is kept is bytes from the first on, as the file has them: a next download carries on from it as from any .part
            with open(job.part, "rb") as f:
                kept = f.read()
            assert kept == FILE[: len(kept)]
        else:
            assert not os.path.exists(job.part)


def test_a_failure_that_passes_keeps_only_bytes_whole_from_the_first_and_the_next_one_carries_on(tmp_path, parts_site):
    # the pieces from the middle on keep failing: the download gives up, its .part holds the first half, whole
    s = parts_site(fault=lambda n, start: 503 if start >= SIZE // 2 else None)
    first = _in_parts(_direct(tmp_path, s.url), attempts=2)
    assert first.state == "error" and "2 times in a row" in first.error
    with open(first.part, "rb") as f:
        kept = f.read()
    assert len(kept) == SIZE // 2 and kept == FILE[: SIZE // 2]
    s.fault = lambda n, start: None
    again = _in_parts(_direct(tmp_path, s.url))
    assert (again.state, again.error) == ("done", None)
    with open(again.path, "rb") as f:
        assert f.read() == FILE
    assert f"bytes={SIZE // 2}-{SIZE // 2}" in s.asked
    assert os.listdir(tmp_path / "loras") == ["model.safetensors"]


def test_two_downloads_at_once_share_the_connections(tmp_path, parts_site):
    s = parts_site(delay=0.02)
    slots = threading.BoundedSemaphore(3)
    counted = _Counted()
    jobs = [_direct(tmp_path, s.url, name=f"{n}.safetensors") for n in "ab"]
    threads = [threading.Thread(target=_in_parts, args=(j,), kwargs={"width": 3, "slots": slots, "opener": counted}) for j in jobs]
    for t in threads:
        t.start()
    for t in threads:
        t.join(20)
    assert [j.state for j in jobs] == ["done", "done"]
    assert 1 < counted.most <= 3


def test_an_expired_link_is_renewed_once_for_every_connection(tmp_path, parts_site):
    first = parts_site(fault=lambda n, start: 403 if n >= 4 else None, delay=0.01)
    fresh = parts_site()
    job = _direct(tmp_path, first.url)
    t = threading.Thread(target=_in_parts, args=(job,), kwargs={"renew_wait": 5})
    t.start()
    for _ in range(500):
        if job.expired:
            break
        threading.Event().wait(0.01)
    assert job.expired
    job.renew(fresh.url)
    t.join(10)
    assert (job.state, job.error) == ("done", None)
    with open(job.path, "rb") as f:
        assert f.read() == FILE
    # the fresh link asked only for parts, each from where the first link left it
    assert fresh.asked and all(r and re.match(r"^bytes=\d+-\d+$", r) for r in fresh.asked)


def test_no_key_is_ever_sent_and_a_redirect_is_not_followed(tmp_path, parts_site):
    # the pack holds no key (Afflatus asks the site with it, at home): its requests carry none, and a part answered with
    # a redirect does not lead the download elsewhere
    storage = parts_site()
    s = parts_site(fault=lambda n, start: "redirect" if n == 2 else None)
    s.elsewhere = storage.url
    job = _direct(tmp_path, s.url)
    run(job, backoff=0.01, parts_from=1, width=2, piece_size=PIECE, slots=threading.BoundedSemaphore(2))
    assert job.state == "error" and "302" in job.error
    assert storage.asked == []
    assert s.auth == [None] * len(s.asked)
    assert os.listdir(tmp_path / "loras") == []


def test_the_route_takes_the_sha256_afflatus_says(tmp_path, site):
    found, routes, web = _routes()
    jobs = downloads.register(routes, web, _FolderPaths(str(tmp_path)))
    start = found[("POST", "/afflatus/download")]
    s = site()
    said = asyncio.run(start(_Request({"url": s.url, "folder": "loras", "filename": "a.safetensors", "total": SIZE, "sha256": SHA.upper()})))
    assert jobs[said.body["id"]].sha256 == SHA
    other = asyncio.run(start(_Request({"url": s.url, "folder": "loras", "filename": "b.safetensors", "total": SIZE, "sha256": "not a hash"})))
    assert jobs[other.body["id"]].sha256 is None
    for _ in range(500):
        if all(j.state != "downloading" for j in jobs.values()):
            break
        threading.Event().wait(0.01)
    assert [j.state for j in jobs.values()] == ["done", "done"]


def test_a_source_saying_less_than_was_declared_is_refused_before_writing(tmp_path, site, parts_site):
    # no sha256 to tell (a Hugging Face copy before 0.44.0's check): a short answer was named the whole model (0.44.1)
    s = site()
    job = Job(s.url, str(tmp_path / "loras" / "model.safetensors"), SIZE + 4096)
    run(job, backoff=0.01)
    assert job.state == "error" and f"the source says {SIZE} bytes, {SIZE + 4096} were said" in job.error
    assert os.listdir(tmp_path / "loras") == []
    # the same over several connections: the one byte asked first says the file's size
    p = parts_site()
    parts = Job(p.url, str(tmp_path / "loras" / "parts.safetensors"), SIZE + 4096)
    parts.direct = True
    _in_parts(parts)
    assert parts.state == "error" and f"{SIZE + 4096} were said" in parts.error
    assert p.asked == ["bytes=0-0"]
    assert os.listdir(tmp_path / "loras") == []


def test_a_part_that_starts_elsewhere_than_asked_is_never_written_as_the_whole_file(tmp_path):
    # the first answer cut a third of the way; the next one, asked from there, a 206 from byte 1000 on: its length is not
    # the file's, and it was written from the first byte and named whole (no size declared, no sha256)
    asked = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            asked.append(self.headers.get("Range"))
            if len(asked) == 1:
                self.send_response(200)
                self.send_header("Content-Length", str(SIZE))
                self.end_headers()
                self.wfile.write(FILE[: SIZE // 3])
                self.wfile.flush()
                self.connection.shutdown(2)
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes 1000-{SIZE - 1}/*")
            self.send_header("Content-Length", str(SIZE - 1000))
            self.end_headers()
            self.wfile.write(FILE[1000:])

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        job = _fetch(tmp_path, f"http://127.0.0.1:{server.server_address[1]}{RELAY}?t=token")
    finally:
        server.shutdown()
        server.server_close()
    assert job.state == "error" and f"bytes 1000-{SIZE - 1}/* for bytes {SIZE // 3}-" in job.error
    assert asked == [None, f"bytes={SIZE // 3}-"]
    assert not os.path.exists(job.path)

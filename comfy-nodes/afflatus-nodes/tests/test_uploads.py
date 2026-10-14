"""The pack's uploads: a model file sent a piece at a time, at the byte the upload is at, named only once whole. No ComfyUI."""

import asyncio
import os
import types
from collections import namedtuple

from afflatus_nodes import uploads

SIZE = 5 * 2**20 + 123
FILE = bytes(((i * 7) + (i >> 10)) & 255 for i in range(SIZE))


class _FolderPaths:
    """ComfyUI's folder_paths, over model folders of a test's own."""

    def __init__(self, root):
        self.folder_names_and_paths = {}
        for name in ("loras", "custom_nodes"):
            path = os.path.join(root, name)
            os.makedirs(path, exist_ok=True)
            self.folder_names_and_paths[name] = ([path], set())

    def get_folder_paths(self, name):
        return self.folder_names_and_paths[name][0]


class _Content:
    def __init__(self, data):
        self.data = data

    async def read(self, n):
        block, self.data = self.data[:n], self.data[n:]
        return block


class _Request:
    def __init__(self, body=None, content_type="application/json", match=None, query=None, length=None):
        self.content_type = content_type
        self._body = body
        self.match_info = match or {}
        self.rel_url = types.SimpleNamespace(query=query or {})
        self.content = _Content(body if isinstance(body, bytes) else b"")
        self.content_length = len(body) if isinstance(body, bytes) and length is None else length

    async def json(self):
        return self._body


def _routes(tmp_path):
    found = {}

    def register(method):
        return lambda path: lambda fn: found.setdefault((method, path), fn)

    routes = types.SimpleNamespace(get=register("GET"), post=register("POST"), put=register("PUT"), delete=register("DELETE"))
    web = types.SimpleNamespace(
        Response=lambda status=200, text="": types.SimpleNamespace(status=status, text=text, body=None),
        json_response=lambda body: types.SimpleNamespace(status=200, text="", body=body),
    )
    held = uploads.register(routes, web, _FolderPaths(str(tmp_path)))
    call = lambda method, path, req: asyncio.run(found[(method, path)](req))  # noqa: E731
    return call, held


def _start(call, name="mine.safetensors", total=SIZE, folder="loras"):
    return call("POST", "/afflatus/upload", _Request({"folder": folder, "filename": name, "total": total}))


def _put(call, uid, offset, data, **kw):
    return call("PUT", "/afflatus/upload/{id}", _Request(data, "application/octet-stream", {"id": uid}, {"offset": str(offset)}, **kw))


def test_pieces_make_the_file_named_only_once_whole(tmp_path):
    call, _held = _routes(tmp_path)
    said = _start(call)
    assert said.status == 200
    uid, path = said.body["id"], said.body["path"]
    piece = 2 * 2**20
    at = 0
    while at < SIZE:
        assert not os.path.exists(path)
        got = _put(call, uid, at, FILE[at : at + piece])
        assert got.status == 200, got.text
        at += min(piece, SIZE - at)
    assert got.body == {"state": "done", "bytes": SIZE, "total": SIZE, "error": None}
    with open(path, "rb") as f:
        assert f.read() == FILE
    assert not [n for n in os.listdir(tmp_path / "loras") if n.endswith(".part")]


def test_a_piece_at_the_wrong_byte_is_turned_away_and_says_where_it_is(tmp_path):
    call, _held = _routes(tmp_path)
    uid = _start(call).body["id"]
    assert _put(call, uid, 0, FILE[:1000]).status == 200
    # sent again after a cut that did arrive: the sender is told the upload is past it
    again = _put(call, uid, 0, FILE[:1000])
    assert again.status == 409 and "byte 1000" in again.text
    assert call("GET", "/afflatus/upload/{id}", _Request(match={"id": uid})).body["bytes"] == 1000


def test_a_piece_cut_short_keeps_nothing_of_it(tmp_path):
    call, _held = _routes(tmp_path)
    uid = _start(call).body["id"]
    short = _put(call, uid, 0, FILE[:500], length=1000)
    assert short.status == 400
    assert call("GET", "/afflatus/upload/{id}", _Request(match={"id": uid})).body == {"state": "uploading", "bytes": 0, "total": SIZE, "error": None}
    assert _put(call, uid, 0, FILE[:1000]).status == 200


def test_never_past_the_size_it_said(tmp_path):
    call, _held = _routes(tmp_path)
    uid = _start(call, total=100).body["id"]
    assert _put(call, uid, 0, FILE[:101]).status == 409
    assert _put(call, uid, 0, FILE[:100]).body["state"] == "done"


def test_only_model_names_in_model_folders_with_a_size(tmp_path):
    call, _held = _routes(tmp_path)
    assert _start(call, name="x.py").status == 400
    assert _start(call, name="../x.safetensors").status == 400
    assert _start(call, folder="custom_nodes").status == 400
    assert _start(call, total=0).status == 400
    assert _start(call, total=True).status == 400
    assert call("POST", "/afflatus/upload", _Request("{}", content_type="text/plain")).status == 415
    uid = _start(call).body["id"]
    assert call("PUT", "/afflatus/upload/{id}", _Request(b"abc", "text/plain", {"id": uid}, {"offset": "0"})).status == 415
    assert _put(call, uid, 0, b"x" * 10, length=uploads.PIECE_MAX + 1).status == 400


def test_never_over_a_file_that_is_there_nor_two_of_one(tmp_path):
    call, _held = _routes(tmp_path)
    (tmp_path / "loras" / "there.safetensors").write_bytes(b"x")
    assert _start(call, name="there.safetensors").status == 409
    assert _start(call, name="twice.safetensors").status == 200
    assert _start(call, name="twice.safetensors").status == 409


def test_at_most_two_at_once(tmp_path):
    call, _held = _routes(tmp_path)
    assert _start(call, name="a.safetensors").status == 200
    assert _start(call, name="b.safetensors").status == 200
    assert _start(call, name="c.safetensors").status == 429


def test_a_disk_without_room_is_said_at_the_start(tmp_path, monkeypatch):
    call, _held = _routes(tmp_path)
    Usage = namedtuple("Usage", "total used free")
    monkeypatch.setattr(uploads.shutil, "disk_usage", lambda _p: Usage(10, 9, 1000))
    said = _start(call)
    assert said.status == 507 and "1000 bytes free" in said.text


def test_a_stop_removes_the_part_and_takes_no_more(tmp_path):
    call, _held = _routes(tmp_path)
    uid = _start(call).body["id"]
    _put(call, uid, 0, FILE[:1000])
    assert [n for n in os.listdir(tmp_path / "loras") if n.endswith(".part")]
    assert call("DELETE", "/afflatus/upload/{id}", _Request(match={"id": uid})).status == 200
    assert not [n for n in os.listdir(tmp_path / "loras") if n.endswith(".part")]
    assert _put(call, uid, 1000, FILE[1000:2000]).status == 409


def test_an_upload_left_alone_is_given_up(tmp_path, monkeypatch):
    call, held = _routes(tmp_path)
    uid = _start(call).body["id"]
    _put(call, uid, 0, FILE[:1000])
    held[uid].last -= uploads.IDLE_S + 1
    now = call("GET", "/afflatus/upload/{id}", _Request(match={"id": uid})).body
    assert now["state"] == "stopped" and "given up" in now["error"]
    assert not [n for n in os.listdir(tmp_path / "loras") if n.endswith(".part")]
    # its name is free again
    assert _start(call).status == 200


def test_a_piece_whose_bytes_stop_coming_frees_its_upload(tmp_path, monkeypatch):
    call, _held = _routes(tmp_path)
    monkeypatch.setattr(uploads, "READ_S", 0.05)
    uid = _start(call).body["id"]

    class Stuck:
        async def read(self, n):
            await asyncio.sleep(5)
            return b"x"

    req = _Request(FILE[:1000], "application/octet-stream", {"id": uid}, {"offset": "0"})
    req.content = Stuck()
    assert call("PUT", "/afflatus/upload/{id}", req).status == 400
    # the same piece sent again is taken: nothing holds the upload
    assert _put(call, uid, 0, FILE[:1000]).status == 200


def test_the_part_is_one_the_sweep_knows():
    from afflatus_nodes.downloads import PART

    u = uploads.Upload("/m/loras/a.safetensors", 10)
    assert PART.search(os.path.basename(u.part))

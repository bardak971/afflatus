"""The pack's cleanups of ComfyUI's input and output folders, and the route that asks for them: no ComfyUI."""

import asyncio
import importlib.util
import json
import os
import sys
import types

from conftest import PACK

from afflatus_nodes import clean_output


def _touch(path, old):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"x")
    if old:
        os.utime(path, (1, 1))


def test_the_output_cleanup_takes_only_old_videos_afflatus_had_saved(tmp_path):
    out = tmp_path / "output"
    ours_old = out / "Afflatus" / "video_00001_.mp4"
    ours_new = out / "Afflatus" / "video_00002_.mp4"
    for path, old in (
        (ours_old, True),
        (ours_new, False),
        # a picture, a file of another name, a sub-folder's video and a video of the output folder itself are not Afflatus's videos
        (out / "Afflatus" / "h3_00001_.safetensors", True),
        (out / "Afflatus" / "my_video_00001_.mp4", True),
        (out / "Afflatus" / "keep" / "video_00001_.mp4", True),
        (out / "video_00001_.mp4", True),
        (out / "ComfyUI_00001_.png", True),
    ):
        _touch(str(path), old)
    assert clean_output(str(out), 24) == 1
    assert not ours_old.exists() and ours_new.exists()
    assert sorted(p.name for p in (out / "Afflatus").iterdir()) == ["h3_00001_.safetensors", "keep", "my_video_00001_.mp4", "video_00002_.mp4"]
    assert (out / "video_00001_.mp4").exists() and (out / "Afflatus" / "keep" / "video_00001_.mp4").exists()
    # no Afflatus folder in it yet: nothing to do
    assert clean_output(str(tmp_path / "none"), 24) == 0


def test_never_younger_than_an_hour(tmp_path):
    out = tmp_path / "output"
    recent = out / "Afflatus" / "video_00001_.mp4"
    _touch(str(recent), False)
    os.utime(recent, (os.path.getmtime(recent) - 1800, os.path.getmtime(recent) - 1800))
    assert clean_output(str(out), 0) == 0
    assert recent.exists()


class _Response:
    def __init__(self, status=200, text="", body=None):
        self.status = status
        self.text = text
        self.body = body


class _Request:
    def __init__(self, body, content_type="application/json"):
        self.content_type = content_type
        self._body = body

    async def json(self):
        return json.loads(self._body)


def _routes(folders):
    """The pack loaded again with a stand-in for ComfyUI's server and aiohttp: its routes, by method and path."""
    routes = {}

    def register(method):
        return lambda path: lambda fn: routes.setdefault((method, path), fn)

    instance = types.SimpleNamespace(routes=types.SimpleNamespace(get=register("GET"), post=register("POST")))
    web = types.SimpleNamespace(Response=lambda status=200, text="": _Response(status, text), json_response=lambda body: _Response(200, body=body))
    saved = {name: sys.modules.get(name) for name in ("server", "aiohttp", "aiohttp.web")}
    sys.modules["server"] = types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=instance))
    sys.modules["aiohttp"] = types.SimpleNamespace(web=web)
    sys.modules["aiohttp.web"] = web
    try:
        spec = importlib.util.spec_from_file_location("afflatus_nodes_routes", os.path.join(PACK, "__init__.py"), submodule_search_locations=[PACK])
        module = importlib.util.module_from_spec(spec)
        sys.modules["afflatus_nodes_routes"] = module
        spec.loader.exec_module(module)
    finally:
        for name, was in saved.items():
            if was is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = was
    return routes


def test_the_route_cleans_the_folder_asked_for_and_refuses_others(folders):
    clean = _routes(folders)[("POST", "/afflatus/clean-input")]
    _touch(os.path.join(folders.input, "afflatus", "afflatus_a.png"), True)
    _touch(os.path.join(folders.output, "Afflatus", "video_00001_.mp4"), True)

    said = asyncio.run(clean(_Request('{"folder": "output", "older_than_hours": 24}')))
    assert said.body == {"removed": 1}
    assert os.path.exists(os.path.join(folders.input, "afflatus", "afflatus_a.png"))

    said = asyncio.run(clean(_Request('{"older_than_hours": 24}')))
    assert said.body == {"removed": 1}
    assert not os.path.exists(os.path.join(folders.input, "afflatus", "afflatus_a.png"))

    assert asyncio.run(clean(_Request('{"folder": "../models"}'))).status == 400
    assert asyncio.run(clean(_Request("{}", "text/plain"))).status == 415

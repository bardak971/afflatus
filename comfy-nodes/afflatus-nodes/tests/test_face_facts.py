"""Face facts (face_facts.py): what a person's picture holds of a face, for Afflatus to pick the clearest of their pictures.

InsightFace is not loaded: a stand-in finds the faces it is told. Needs numpy (ComfyUI has it).
"""

import asyncio
import types

import pytest

np = pytest.importorskip("numpy")

from afflatus_nodes import face_facts, face_match  # noqa: E402


class Face(dict):
    __getattr__ = dict.get


def face(box, score=0.9, embedding=(3.0, 4.0)):
    x0, y0, x1, y1 = box
    kps = [[x0 + (x1 - x0) * 0.3, y0 + (y1 - y0) * 0.4], [x0 + (x1 - x0) * 0.7, y0 + (y1 - y0) * 0.4], [(x0 + x1) / 2, y0 + (y1 - y0) * 0.6], [x0 + (x1 - x0) * 0.35, y0 + (y1 - y0) * 0.8], [x0 + (x1 - x0) * 0.65, y0 + (y1 - y0) * 0.8]]
    return Face(bbox=np.array(box, dtype=np.float32), kps=np.array(kps, dtype=np.float32), det_score=score, normed_embedding=np.array(embedding, dtype=np.float32))


class App:
    def __init__(self, faces):
        self.faces = faces

    def get(self, bgr):
        return list(self.faces)


def checks(h, w, cell):
    """A black and white board, `cell` pixels a square: fine detail at 2, broad at 16."""
    y, x = np.mgrid[0:h, 0:w]
    a = (((y // cell) + (x // cell)) % 2 * 255).astype(np.uint8)
    return np.stack([a, a, a], axis=2)


def test_the_largest_sure_face_is_described():
    bgr = checks(400, 300, 4)
    out = face_facts.facts_of(bgr, App([face([10, 10, 60, 70]), face([100, 100, 260, 300], score=0.8), face([0, 0, 390, 290], score=0.3), face([5, 5, 25, 300])]))
    assert out["width"] == 300 and out["height"] == 400 and out["version"] == face_facts.FACTS_VERSION
    # a face the detector is unsure of (0.3) and one too narrow to read (20 px) are not counted
    assert out["faces"] == 2
    f = out["face"]
    assert f["box"] == [100.0, 100.0, 260.0, 300.0] and f["score"] == 0.8
    assert len(f["points"]) == 5 and f["points"][2] == [180.0, 220.0]
    # the embedding as a unit vector
    assert f["embedding"] == [0.6, 0.8]
    assert f["sharp"] > 0


def test_a_picture_without_a_face_says_so():
    out = face_facts.facts_of(checks(64, 64, 4), App([]))
    assert out["faces"] == 0 and out["face"] is None


def blurred(bgr, k):
    """A picture averaged over `k` x `k` blocks: what a soft, out-of-focus face keeps of its detail."""
    h, w = bgr.shape[:2]
    a = bgr[: h - h % k, : w - w % k].astype(np.float64).reshape(h // k, k, w // k, k, 3).mean(axis=(1, 3))
    return np.repeat(np.repeat(a, k, axis=0), k, axis=1).astype(np.uint8)


def test_a_blurred_face_reads_less_sharp_than_a_sharp_one_of_any_size():
    sharp = checks(224, 224, 6) // 2 + checks(224, 224, 2) // 2
    soft = blurred(sharp, 8)
    assert face_facts.sharpness(sharp, [0, 0, 224, 224]) > 5 * face_facts.sharpness(soft, [0, 0, 224, 224])
    # the face read at the square's size whatever its size in the picture: a smaller sharp face still reads sharp
    small = checks(112, 112, 3)
    assert face_facts.sharpness(small, [0, 0, 112, 112]) > 5 * face_facts.sharpness(soft, [0, 0, 224, 224])
    # a flat face has no detail at all
    assert face_facts.sharpness(np.full((80, 80, 3), 128, dtype=np.uint8), [0, 0, 80, 80]) == 0


def test_a_box_past_the_picture_is_read_inside_it():
    assert face_facts.sharpness(checks(50, 50, 2), [-20, -20, 500, 500]) > 0


def test_insightface_loaded_for_the_route_is_let_go_after_its_idle_minute(monkeypatch):
    loads = []
    monkeypatch.setattr(face_match, "_loaded", lambda: loads.append(1) or object())
    monkeypatch.setattr(face_match, "_app", None)
    monkeypatch.setattr(face_match, "_app_for_route", False)
    clock = [100.0]
    facts = face_facts.Facts(now=lambda: clock[0])
    monkeypatch.setattr(facts, "_watch", lambda: None)
    monkeypatch.setattr(face_facts, "_decode", lambda body: checks(32, 32, 4))
    monkeypatch.setattr(face_facts, "facts_of", lambda bgr, app: {"app": app})
    first = facts.read(b"x")["app"]
    assert loads == [1] and face_match._app is first
    clock[0] += face_facts.IDLE_S - 1
    assert not facts.idle_check() and face_match._app is first
    clock[0] += 2
    assert facts.idle_check() and face_match._app is None
    # asked again: loaded again
    facts.read(b"x")
    assert loads == [1, 1]


def test_insightface_a_node_uses_stays_loaded(monkeypatch):
    monkeypatch.setattr(face_match, "_loaded", lambda: object())
    monkeypatch.setattr(face_match, "_app", None)
    monkeypatch.setattr(face_match, "_app_for_route", False)
    app = face_match.app_for_route()
    # a render's Face Match used it meanwhile: it is the node's now
    assert face_match._face_app() is app
    face_match.release_route_app()
    assert face_match._app is app
    # loaded by a node first, the route's use does not make it the route's
    monkeypatch.setattr(face_match, "_app", None)
    node = face_match._face_app()
    assert face_match.app_for_route() is node
    face_match.release_route_app()
    assert face_match._app is node


class _Request:
    def __init__(self, body, content_type="application/octet-stream"):
        self.content_type = content_type
        self.content_length = len(body)
        self._body = body

    async def read(self):
        return self._body


def _route(monkeypatch, facts):
    found = {}
    routes = types.SimpleNamespace(post=lambda path: lambda fn: found.setdefault(path, fn))
    web = types.SimpleNamespace(
        Response=lambda status=200, text="": types.SimpleNamespace(status=status, text=text, body=None),
        json_response=lambda body: types.SimpleNamespace(status=200, text="", body=body),
    )
    face_facts.register(routes, web, facts)
    return lambda req: asyncio.run(found["/afflatus/face-facts"](req))


def test_the_route_answers_the_facts_of_the_bytes_sent(monkeypatch):
    monkeypatch.setattr(face_match, "available", lambda: True)
    seen = []
    call = _route(monkeypatch, types.SimpleNamespace(read=lambda body: seen.append(body) or {"faces": 0, "face": None}))
    res = call(_Request(b"picture"))
    assert res.status == 200 and res.body == {"faces": 0, "face": None} and seen == [b"picture"]
    assert call(_Request(b"{}", "application/json")).status == 415
    assert call(_Request(b"")).status == 400


def test_the_route_says_a_picture_it_cannot_read(monkeypatch):
    monkeypatch.setattr(face_match, "available", lambda: True)
    monkeypatch.setattr(face_match, "_loaded", lambda: App([]))
    monkeypatch.setattr(face_match, "_app", None)
    monkeypatch.setattr(face_match, "_app_for_route", False)
    facts = face_facts.Facts()
    monkeypatch.setattr(facts, "_watch", lambda: None)
    res = _route(monkeypatch, facts)(_Request(b"not a picture"))
    assert res.status == 422 and "cannot identify" in res.text


def test_insightface_that_cannot_load_is_no_word_on_the_picture(monkeypatch):
    # its files not fetched (offline, a download that failed) or onnxruntime not loading: answered 422, Afflatus filed every
    # picture "no face" for good (card #233); 503, it asks again later
    monkeypatch.setattr(face_match, "available", lambda: True)
    monkeypatch.setattr(face_match, "_app", None)
    monkeypatch.setattr(face_match, "_app_for_route", False)

    def offline():
        raise OSError("could not fetch buffalo_l")

    monkeypatch.setattr(face_match, "_loaded", offline)
    monkeypatch.setattr(face_facts, "_decode", lambda body: checks(32, 32, 4))
    facts = face_facts.Facts()
    monkeypatch.setattr(facts, "_watch", lambda: None)
    res = _route(monkeypatch, facts)(_Request(b"picture"))
    assert res.status == 503 and "buffalo_l" in res.text


def test_without_insightface_the_route_says_so(monkeypatch):
    monkeypatch.setattr(face_match, "available", lambda: False)
    res = _route(monkeypatch, types.SimpleNamespace(read=lambda body: {}))(_Request(b"picture"))
    assert res.status == 501

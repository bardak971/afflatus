"""Face Match's work per render (face_match.py): the photos' faces found once, a frame's at the smaller size, its two largest only.

InsightFace is not loaded: a stand-in finds one face in each picture and says how it was asked. Needs numpy (ComfyUI has it).
"""

import sys
import types

import pytest

np = pytest.importorskip("numpy")

from afflatus_nodes import face_match  # noqa: E402


class Face(dict):
    __getattr__ = dict.get

    def __setattr__(self, name, value):
        self[name] = value


class Recognition:
    def get(self, img, face):
        # the picture's mean as its "identity": the same picture, the same embedding
        face.normed_embedding = np.full(4, float(img.mean()) + 1.0, dtype=np.float32)


class Detection:
    def __init__(self, asked):
        self.asked = asked

    def detect(self, img, input_size=None, max_num=0, metric="default"):
        self.asked.append(("detect", input_size, max_num, metric))
        return np.array([[0, 0, 64, 64, 0.9]], dtype=np.float32), np.zeros((1, 5, 2), dtype=np.float32)


class App:
    def __init__(self):
        self.asked = []
        self.det_model = Detection(self.asked)
        self.models = {"detection": self.det_model, "recognition": Recognition()}

    def get(self, img):
        self.asked.append(("get",))
        face = Face(bbox=np.array([0, 0, 64, 64], dtype=np.float32), kps=None, det_score=0.9)
        self.models["recognition"].get(img, face)
        return [face]


class Batch:
    """A ComfyUI image batch as the node reads it: [n, h, w, c], 0 to 1."""

    def __init__(self, a):
        self.a = a
        self.shape = a.shape

    def __getitem__(self, key):
        return Batch(self.a[key])

    def detach(self):
        return self

    cpu = detach

    def numpy(self):
        return self.a


@pytest.fixture
def app(monkeypatch):
    fake = App()
    monkeypatch.setattr(face_match, "_face_app", lambda: fake)
    common = types.ModuleType("insightface.app.common")
    common.Face = Face
    for name in ("insightface", "insightface.app"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    monkeypatch.setitem(sys.modules, "insightface.app.common", common)
    face_match._refs.clear()
    return fake


def picture(level, n=1):
    return Batch(np.full((n, 72, 96, 3), level, dtype=np.float32))


def test_the_photos_faces_are_found_once_for_every_take_of_them(app):
    photos = (picture(0.2), picture(0.4))
    first = face_match.AfflatusFaceMatch.execute(picture(0.3, 12), *photos, samples=4).ui["afflatus_face"][0]
    second = face_match.AfflatusFaceMatch.execute(picture(0.5, 12), *photos, samples=4).ui["afflatus_face"][0]
    assert first["photos"] == second["photos"] == 2
    # each photo found at the full size, once: the second take reads them back
    assert app.asked.count(("get",)) == 2
    # another photo is another person: found anew
    face_match.AfflatusFaceMatch.execute(picture(0.5, 12), picture(0.6), samples=4)
    assert app.asked.count(("get",)) == 3


def test_a_frame_is_read_at_the_smaller_size_for_its_two_largest_faces(app):
    out = face_match.AfflatusFaceMatch.execute(picture(0.3, 12), picture(0.2), samples=4).ui["afflatus_face"][0]
    frames = [a for a in app.asked if a[0] == "detect"]
    assert out["read"] == 4 and out["frames"] == 4
    assert frames == [("detect", (face_match.FRAME_DET, face_match.FRAME_DET), face_match.FRAME_FACES, "max")] * 4
    assert face_match.FRAME_DET < face_match.PHOTO_DET and face_match.FRAME_FACES == 2


ME = np.array([1, 0, 0, 0], dtype=np.float32)
OTHER = np.array([0, 1, 0, 0], dtype=np.float32)


@pytest.fixture
def faces_of(monkeypatch):
    """Face At with the faces of each picture given: by the picture's level, a list of (embedding, box)."""
    table = {}

    def faces(bgr, det=face_match.PHOTO_DET, most=0):
        found = table[round(float(bgr.mean()) / 255, 2)]
        return [(e, b[2] - b[0], b) for e, b in (found[:most] if most else found)]

    monkeypatch.setattr(face_match, "_faces", faces)
    monkeypatch.setattr(face_match, "_reference", lambda photo: ME)
    return table


def at(image, frame):
    return face_match.AfflatusFaceAt.execute(image, frame, picture(0.9)).ui["afflatus_face"][0]


def test_the_face_scored_is_the_one_where_the_frames_main_person_stands(faces_of):
    faces_of[0.1] = [(OTHER, [30, 10, 60, 40])]  # the frame: its main person
    faces_of[0.3] = [(ME * 0.9 + OTHER * 0.1, [32, 12, 62, 42]), (OTHER, [0, 0, 20, 20])]  # put in, a stranger
    out = at(picture(0.3), picture(0.1))
    assert out["placed"] and out["face"] > 0.8 and out["copies"] == 0


def test_the_original_kept_and_the_person_pasted_in_beside_is_said(faces_of):
    faces_of[0.1] = [(OTHER, [30, 10, 60, 40])]
    faces_of[0.3] = [(OTHER, [31, 11, 61, 41]), (ME, [0, 0, 20, 20]), (ME, [70, 0, 90, 20])]
    out = at(picture(0.3), picture(0.1))
    # the best match anywhere would read 1.0: at the place, it is the original
    assert out["face"] < 0.1 and out["copies"] == 2


def test_a_picture_larger_than_its_frame_is_matched_at_the_same_place(faces_of):
    faces_of[0.1] = [(OTHER, [30, 10, 60, 40])]
    faces_of[0.3] = [(ME, [60, 20, 120, 80]), (OTHER, [30, 10, 60, 40])]
    big = Batch(np.full((1, 144, 192, 3), 0.3, dtype=np.float32))
    out = at(big, picture(0.1))
    assert out["face"] == 1.0 and out["copies"] == 0

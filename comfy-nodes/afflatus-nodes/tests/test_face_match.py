"""Face Match's work per render (face_match.py): the photos' faces found once, a frame's at the smaller size, its two largest only.

InsightFace is not loaded: a stand-in finds one face in each picture and says how it was asked. Needs numpy (ComfyUI has it).
"""

import os
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


def test_a_photo_already_seen_is_not_converted_again(app, monkeypatch):
    """A 12 MP photo was converted to 8-bit and hashed whole on every render (0.12 to 0.16 s each): its key is read off some of
    its pixels and its size, and only a photo not seen yet is converted."""
    converted = []
    bgr = face_match._bgr
    monkeypatch.setattr(face_match, "_bgr", lambda image, index: converted.append(image.shape) or bgr(image, index))
    photo = picture(0.2)
    face_match.AfflatusFaceMatch.execute(picture(0.3, 4), photo, samples=4)
    assert converted.count(photo.shape) == 1
    converted.clear()
    face_match.AfflatusFaceMatch.execute(picture(0.5, 4), picture(0.2), samples=4)
    # the frames only: the photo's face is read back
    assert converted == [(4, 72, 96, 3)] * 4 and app.asked.count(("get",)) == 1
    # another photo of the same size, or the same pixels at another size, is another photo
    face_match.AfflatusFaceMatch.execute(picture(0.5, 4), picture(0.25), samples=4)
    face_match.AfflatusFaceMatch.execute(picture(0.5, 4), Batch(np.full((1, 72, 97, 3), 0.2, dtype=np.float32)), samples=4)
    assert app.asked.count(("get",)) == 3


def test_onnx_runtime_runs_the_models_on_a_few_threads(monkeypatch):
    """ONNX Runtime's default, a thread per core, fought torch's own inside ComfyUI (Face Match 8 to 12 s a render against about
    1 s on its own): its sessions run on THREADS, without spinning between runs (as fast, 60 % less CPU, faster beside torch).
    InsightFace 2 takes the options; one that drops them (0.7.3, the pod image's) has its sessions made again on them."""

    class Options:
        intra_op_num_threads = 0

        def __init__(self):
            self.entries = {}

        def add_session_config_entry(self, key, value):
            self.entries[key] = value

        def get_session_config_entry(self, key):
            # as ONNX Runtime: a key never set raises
            if key not in self.entries:
                raise RuntimeError(f"SessionOptions does not have configuration with key: {key}")
            return self.entries[key]

    class Session:
        def __init__(self, path, sess_options=None, providers=None):
            self.path, self.options, self.providers = path, sess_options or Options(), providers

        def get_session_options(self):
            return self.options

        def get_providers(self):
            return self.providers or ["CPUExecutionProvider"]

    made = {}

    class FaceAnalysis:
        def __init__(self, name, root, allowed_modules, providers, sess_options, drops=False):
            made["options"] = sess_options
            kept = None if drops is True else sess_options
            if drops == "entries":
                # an InsightFace that would copy the thread count alone: its sessions spin, so they are made again too
                kept = Options()
                kept.intra_op_num_threads = sess_options.intra_op_num_threads
            self.models = {"detection": types.SimpleNamespace(model_file="det.onnx", session=Session("det.onnx", kept)), "recognition": types.SimpleNamespace(model_file="rec.onnx", session=Session("rec.onnx", kept))}

        def prepare(self, ctx_id, det_size):
            made["prepared"] = ctx_id

    ort = types.ModuleType("onnxruntime")
    ort.SessionOptions = Options
    ort.InferenceSession = Session
    monkeypatch.setitem(sys.modules, "onnxruntime", ort)
    app_module = types.ModuleType("insightface.app")
    monkeypatch.setitem(sys.modules, "insightface", types.ModuleType("insightface"))
    monkeypatch.setitem(sys.modules, "insightface.app", app_module)
    monkeypatch.setattr(face_match.face_models, "fetch", lambda root: root)
    monkeypatch.setattr(face_match.folder_paths, "models_dir", "models", raising=False)
    for drops in (False, True, "entries"):
        app_module.FaceAnalysis = lambda drops=drops, **kw: FaceAnalysis(drops=drops, **kw)
        monkeypatch.setattr(face_match, "_app", None)
        app = face_match._face_app()
        threads = min(face_match.THREADS, os.cpu_count() or face_match.THREADS)
        assert made["options"].intra_op_num_threads == threads and face_match.THREADS == 4
        assert {k: m.session.get_session_options().intra_op_num_threads for k, m in app.models.items()} == {"detection": threads, "recognition": threads}
        assert made["options"].get_session_config_entry("session.intra_op.allow_spinning") == "0"
        assert {k: m.session.get_session_options().get_session_config_entry("session.intra_op.allow_spinning") for k, m in app.models.items()} == {"detection": "0", "recognition": "0"}
        assert [m.session.path for m in app.models.values()] == ["det.onnx", "rec.onnx"]


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
    # no one like the photos where someone stood: both are copies, whatever the figure
    assert not out["placed"] and out["copies"] == 2


def test_a_picture_larger_than_its_frame_is_matched_at_the_same_place(faces_of):
    faces_of[0.1] = [(OTHER, [30, 10, 60, 40])]
    faces_of[0.3] = [(ME, [60, 20, 120, 80]), (OTHER, [30, 10, 60, 40])]
    big = Batch(np.full((1, 144, 192, 3), 0.3, dtype=np.float32))
    out = at(big, picture(0.1))
    assert out["face"] == 1.0 and out["copies"] == 0


def test_a_stranger_larger_in_the_foreground_is_not_taken_for_the_person_replaced(faces_of):
    # the meme at 8.5 s: a man's large face in the foreground, the one replaced further back
    faces_of[0.1] = [(OTHER, [0, 30, 50, 80]), (OTHER, [55, 5, 75, 25])]
    faces_of[0.3] = [(OTHER, [0, 30, 50, 80]), (ME, [56, 6, 76, 26])]
    out = at(picture(0.3), picture(0.1))
    assert out["placed"] and out["face"] == 1.0 and out["copies"] == 0


def test_the_man_behind_made_them_too_is_a_copy(faces_of):
    faces_of[0.1] = [(OTHER, [30, 10, 60, 40]), (OTHER, [70, 5, 85, 20])]
    faces_of[0.3] = [(ME, [30, 10, 60, 40]), (ME, [70, 5, 85, 20])]
    out = at(picture(0.3), picture(0.1))
    assert out["placed"] and out["copies"] == 1

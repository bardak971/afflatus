"""Face Crop (face_match.py): a person's picture cut to a square around their face for LTX 2.5's MSR guide, which fits the whole
picture in a slot the size of the clip's frame. InsightFace is not loaded: a stand-in detector finds the faces it is told.
Needs numpy (ComfyUI has it).
"""

import pytest

np = pytest.importorskip("numpy")

from afflatus_nodes import face_match  # noqa: E402


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


class Detection:
    def __init__(self, boxes):
        self.boxes = boxes

    def detect(self, img, input_size=None, max_num=0, metric="default"):
        return np.array(self.boxes, dtype=np.float32).reshape(-1, 5), None


class App:
    def __init__(self, boxes):
        self.det_model = Detection(boxes)


def found(monkeypatch, *boxes):
    monkeypatch.setattr(face_match, "_face_app", lambda: App(list(boxes)))


def portrait(w=3024, h=4032):
    """A large phone portrait, its pixels numbered so a cut can be told by where it comes from."""
    a = np.zeros((1, h, w, 3), dtype=np.float32)
    a[0, :, :, 0] = np.arange(w)[None, :]
    a[0, :, :, 1] = np.arange(h)[:, None]
    return Batch(a)


def test_the_square_is_two_and_a_half_face_heights_centred_on_the_face():
    # a 600 px face in the middle of a 3024 x 4032 portrait: a 1500 px square around it
    assert face_match.face_square((1212, 1700, 1812, 2300), 3024, 4032) == (762, 1250, 1500)


def test_the_square_stays_inside_the_picture_and_no_larger_than_its_short_side():
    # a face at the top left corner: moved in, not padded past the edge
    assert face_match.face_square((0, 0, 200, 300), 3024, 4032) == (0, 0, 750)
    # at the bottom right
    assert face_match.face_square((2900, 3900, 3024, 4032), 3024, 4032) == (3024 - 330, 4032 - 330, 330)
    # a close portrait: the face already fills it, the square is the short side
    assert face_match.face_square((150, 100, 600, 700), 750, 1000) == (0, 25, 750)
    assert face_match.face_square((150, 100, 600, 500), 750, 750) == (0, 0, 750)


def test_a_far_portrait_is_cut_to_its_largest_face(monkeypatch):
    found(monkeypatch, [100, 100, 160, 180, 0.9], [1212, 1700, 1812, 2300, 0.95], [2000, 3000, 2010, 3010, 0.99])
    (cut,) = face_match.AfflatusFaceCrop.execute(portrait()).args
    assert cut.shape == (1, 1500, 1500, 3)
    # its left and top pixels are where the square begins in the picture
    assert (cut.a[0, 0, 0, 0], cut.a[0, 0, 0, 1]) == (762, 1250)


def test_a_close_square_portrait_is_left_as_it_is(monkeypatch):
    found(monkeypatch, [200, 150, 550, 600, 0.9])
    (cut,) = face_match.AfflatusFaceCrop.execute(portrait(750, 750)).args
    assert cut.shape == (1, 750, 750, 3)


def test_without_a_face_or_when_insightface_fails_the_picture_goes_on_whole(monkeypatch):
    picture = portrait(800, 600)
    # faces too unsure or too small are not taken
    found(monkeypatch, [10, 10, 300, 300, 0.3], [400, 300, 410, 310, 0.9])
    assert face_match.AfflatusFaceCrop.execute(picture).args == (picture,)

    def broken():
        raise RuntimeError("no model files")

    monkeypatch.setattr(face_match, "_face_app", broken)
    assert face_match.AfflatusFaceCrop.execute(picture).args == (picture,)

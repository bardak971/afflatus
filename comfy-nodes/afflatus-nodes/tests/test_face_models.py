"""InsightFace's face models fetched whole or not at all (face_models.py): a half-extracted folder is not taken for them."""

import hashlib
import os

import pytest

from afflatus_nodes import face_models as F


def _extract(root, files=F.FILES):
    """What InsightFace's fetch leaves under a root: the folder, then the files of the zip in it."""
    where = F.folder(root)
    os.makedirs(where, exist_ok=True)
    for name in files:
        with open(os.path.join(where, name), "wb") as f:
            f.write(b"onnx")


# the bytes _extract writes, as the release's for these tests
ONNX = {name: hashlib.sha256(b"onnx").hexdigest() for name in F.FILES}


def _left(root):
    return sorted(n for n in os.listdir(root) if n != "models")


def test_a_folder_left_half_extracted_is_fetched_again(tmp_path):
    root = str(tmp_path)
    # a pod ended during the extraction: the folder is there, the recognition model not
    _extract(root, files=("det_10g.onnx",))
    assert not F.complete(root)
    fetched = []
    F.fetch(root, download=lambda into: fetched.append(into) or _extract(into), sha256=ONNX)
    assert len(fetched) == 1 and F.complete(root)
    # nothing of the fetch's own folder left beside the models
    assert _left(root) == []


def test_models_already_whole_are_not_fetched(tmp_path):
    root = str(tmp_path)
    _extract(root)
    F.fetch(root, download=lambda into: pytest.fail("fetched again"))


def test_a_fetch_without_both_files_leaves_nothing_in_their_place(tmp_path):
    root = str(tmp_path)
    with pytest.raises(RuntimeError):
        F.fetch(root, download=lambda into: _extract(into, files=("det_10g.onnx",)), sha256=ONNX)
    assert not os.path.exists(F.folder(root)) and _left(root) == []


def test_another_fetch_that_moved_its_models_in_first_is_used(tmp_path):
    root = str(tmp_path)

    def both(into):
        # the pod's start finishes its own fetch while this one downloads
        _extract(root)
        _extract(into)

    assert F.fetch(root, download=both, sha256=ONNX) == F.folder(root)
    assert F.complete(root) and _left(root) == []


def test_a_fetch_of_other_bytes_than_the_release_is_refused(tmp_path):
    # the zip's address carries no hash: whatever it gives is checked against the release's own files
    root = str(tmp_path)
    with pytest.raises(RuntimeError, match="other bytes"):
        F.fetch(root, download=_extract)
    assert not os.path.exists(F.folder(root)) and _left(root) == []
    assert set(F.FILES) <= set(F.SHA256) and len(F.SHA256) == 5 and all(len(h) == 64 for h in F.SHA256.values())


def test_a_fetch_with_another_file_of_the_pack_changed_is_refused(tmp_path):
    # FaceID loads the whole pack: a file Face Match never reads is checked all the same
    root = str(tmp_path)
    every = {**ONNX, "genderage.onnx": hashlib.sha256(b"release").hexdigest()}
    with pytest.raises(RuntimeError, match="genderage"):
        F.fetch(root, download=lambda into: _extract(into, files=(*F.FILES, "genderage.onnx")), sha256=every)
    assert not os.path.exists(F.folder(root)) and _left(root) == []
    # and one missing from the zip is not moved in either
    with pytest.raises(RuntimeError, match="genderage"):
        F.fetch(root, download=_extract, sha256=every)


def test_models_for_faceid_are_fetched_checked_and_read_once(tmp_path, monkeypatch):
    # IP-Adapter's FaceID loads the pack through AfflatusInsightFaceLoader: fetched as Face Match's are when not there yet
    monkeypatch.setattr(F, "_checked", set())
    root = str(tmp_path)
    assert F.ready(root, download=_extract, sha256=ONNX) == F.folder(root) and F.complete(root)
    read = []
    monkeypatch.setattr(F, "_sha256", lambda path: read.append(path) or ONNX[os.path.basename(path)])
    F.ready(root, download=lambda into: pytest.fail("fetched again"), sha256=ONNX)
    assert read == []


def test_models_already_there_with_other_bytes_are_refused_for_faceid(tmp_path, monkeypatch):
    # what InsightFace's own fetch (IP-Adapter's loader) left there unhashed: never loaded, and the render says why
    monkeypatch.setattr(F, "_checked", set())
    root = str(tmp_path)
    _extract(root)
    every = {**ONNX, "w600k_r50.onnx": hashlib.sha256(b"release").hexdigest()}
    with pytest.raises(RuntimeError, match="w600k_r50.onnx.*Delete that folder"):
        F.ready(root, download=lambda into: pytest.fail("fetched again"), sha256=every)
    # nothing of the user's folder is removed
    assert F.complete(root)


def _put(root, name, data=b"onnx"):
    with open(os.path.join(F.folder(root), name), "wb") as f:
        f.write(data)


def test_a_folder_missing_a_file_of_the_pack_is_fetched_again_for_faceid(tmp_path, monkeypatch):
    # FaceID builds FaceAnalysis on what is in the folder: one with Face Match's two files alone is not the whole pack
    monkeypatch.setattr(F, "_checked", set())
    root = str(tmp_path)
    _extract(root)
    every = {**ONNX, "genderage.onnx": ONNX["det_10g.onnx"]}
    fetched = []
    F.ready(root, download=lambda into: fetched.append(into) or _extract(into, files=tuple(every)), sha256=every)
    assert len(fetched) == 1 and F.complete(root, need=tuple(every)) and _left(root) == []
    # Face Match needs its two only: the same folder is not fetched again for it
    F.fetch(root, download=lambda into: pytest.fail("fetched again"), sha256=every)


def test_an_onnx_the_release_has_not_is_refused_for_both_loaders(tmp_path, monkeypatch):
    # FaceAnalysis opens every *.onnx of the folder before allowed_modules is read, the first of each task kept: one named
    # to sort first would take the detector's place
    monkeypatch.setattr(F, "_checked", set())
    root = str(tmp_path)
    _extract(root)
    F.ready(root, download=lambda into: pytest.fail("fetched again"), sha256=ONNX)
    _put(root, "0det.onnx")
    _put(root, "notes.txt")
    with pytest.raises(RuntimeError, match=r"0det\.onnx.*Move them out"):
        F.ready(root, download=lambda into: pytest.fail("fetched again"), sha256=ONNX)
    with pytest.raises(RuntimeError, match=r"0det\.onnx"):
        F.fetch(root, download=lambda into: pytest.fail("fetched again"), sha256=ONNX)
    assert F.strangers(F.folder(root), ONNX) == ["0det.onnx"]
    # nothing of the user's folder is removed
    assert os.path.isfile(os.path.join(F.folder(root), "0det.onnx")) and F.complete(root)

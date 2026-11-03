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
    assert set(F.SHA256) == set(F.FILES) and all(len(h) == 64 for h in F.SHA256.values())

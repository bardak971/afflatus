"""InsightFace's face models (buffalo_l) for Face Match and Face At, fetched whole or not at all.

InsightFace's own fetch makes the models folder before it extracts the zip into it, and later takes any folder of that
name as complete: a pod ended during the extraction leaves a part of it on its volume, and from then on every pod using
that volume has no face figure, silently. And the pod's start (start.sh) and a Face Match render in its first minutes could
write the same zip at once. So the models are fetched into a folder of their own, beside the real one, and moved in only
when the two files Face Match uses are there; a folder without them is taken as not there.

The two files are checked against their SHA-256 as InsightFace's release gives them before they are moved in: the zip
comes from an address that carries no hash of its own (the 2026-11-02 review, L10).

Standard library only at import (InsightFace is imported only to fetch): start.sh runs this file as a script, outside
ComfyUI, with the models folder as its argument.
"""

import hashlib
import os
import shutil
import sys
import tempfile

NAME = "buffalo_l"
# What Face Match loads of the pack: the face detector and the recognition model (FaceAnalysis's allowed_modules)
FILES = ("det_10g.onnx", "w600k_r50.onnx")
# their bytes in InsightFace's buffalo_l release (v0.7), read from two copies fetched apart (2026-11-03)
SHA256 = {
    "det_10g.onnx": "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91",
    "w600k_r50.onnx": "4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43",
}


def folder(root):
    """Where FaceAnalysis(root=root) looks for the models."""
    return os.path.join(root, "models", NAME)


def complete(root):
    """Whether the models under `root` are whole: both files there, and not empty."""
    where = folder(root)
    return all(os.path.isfile(os.path.join(where, f)) and os.path.getsize(os.path.join(where, f)) > 0 for f in FILES)


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _insightface_fetch(into):
    from insightface.utils.storage import ensure_available

    ensure_available("models", NAME, root=into)


def fetch(root, download=_insightface_fetch, sha256=SHA256):
    """The models whole under `root`, fetched when they are not: into a folder of their own, moved in once complete and
    their bytes the release's (`sha256`). A folder left half-extracted is replaced. Raises when the fetch did not give both
    files, or gave other bytes."""
    if complete(root):
        return folder(root)
    os.makedirs(os.path.join(root, "models"), exist_ok=True)
    # a hidden folder beside the real one: on the same disk, so that the move is a rename; ComfyUI lists no dot folder
    temp = tempfile.mkdtemp(prefix=".fetch-", dir=root)
    try:
        download(temp)
        if not complete(temp):
            raise RuntimeError(f"InsightFace's {NAME} came without {' or '.join(FILES)}")
        other = [f for f in FILES if _sha256(os.path.join(folder(temp), f)) != sha256[f]]
        if other:
            raise RuntimeError(f"InsightFace's {NAME} came with other bytes than its release's ({', '.join(other)}): not used")
        if not complete(root):
            # what a pod ended mid-extraction left: never complete, and in the way of the rename
            shutil.rmtree(folder(root), ignore_errors=True)
            try:
                os.replace(folder(temp), folder(root))
            except OSError:
                # another fetch (the pod's start, a render) moved its own in first: that one is used
                if not complete(root):
                    raise
        return folder(root)
    finally:
        shutil.rmtree(temp, ignore_errors=True)


if __name__ == "__main__":
    fetch(sys.argv[1])

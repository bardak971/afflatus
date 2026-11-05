"""InsightFace's face models (buffalo_l) for Face Match and Face At, fetched whole or not at all.

InsightFace's own fetch makes the models folder before it extracts the zip into it, and later takes any folder of that
name as complete: a pod ended during the extraction leaves a part of it on its volume, and from then on every pod using
that volume has no face figure, silently. And the pod's start (start.sh) and a Face Match render in its first minutes could
write the same zip at once. So the models are fetched into a folder of their own, beside the real one, and moved in only
when the two files Face Match uses are there; a folder without them is taken as not there.

Every file of the pack is checked against its SHA-256 as InsightFace's release gives it before they are moved in: the zip
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
# the bytes of every file of InsightFace's buffalo_l release (v0.7), read from two copies fetched apart (2026-11-03, the
# other three 2026-11-05): IP-Adapter's FaceID builds FaceAnalysis on the whole pack, so the three Face Match does not load
# are checked too (the 2026-11-05 review, S5)
SHA256 = {
    "det_10g.onnx": "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91",
    "w600k_r50.onnx": "4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43",
    "1k3d68.onnx": "df5c06b8a0c12e422b2ed8947b8869faa4105387f199c477af038aa01f9a45cc",
    "2d106det.onnx": "f001b856447c413801ef5c42091ed0cd516fcd21f2d6b79635b1e733a7109dbf",
    "genderage.onnx": "4fde69b1c810857b88c64a335084f1c3fe8f01246c9a191b48c7bb756d6652fb",
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
        # every file the release has a hash for, there and with its bytes: one missing or other is not moved in
        other = [f for f in sha256 if not os.path.isfile(os.path.join(folder(temp), f)) or _sha256(os.path.join(folder(temp), f)) != sha256[f]]
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


# the models folders whose files were read against their hashes in this process: ~330 MB, read once, not at every render
_checked = set()


def ready(root, download=_insightface_fetch, sha256=SHA256):
    """The models under `root` whole and with the release's bytes, for a loader that builds FaceAnalysis on the whole pack
    (IP-Adapter's FaceID, AfflatusInsightFaceLoader): fetched as `fetch` does when they are not there, and the files already
    there read against `sha256` once a process, since IP-Adapter's own loader (or InsightFace's fetch from another pack) may
    have put them there without a hash. Raises, naming the files, when their bytes are not the release's."""
    where = fetch(root, download, sha256)
    if where in _checked:
        return where
    other = [f for f in sha256 if os.path.isfile(os.path.join(where, f)) and _sha256(os.path.join(where, f)) != sha256[f]]
    if other:
        raise RuntimeError(f"InsightFace's {NAME} in {where} has other bytes than its release's ({', '.join(other)}): not used. Delete that folder for it to be fetched again")
    _checked.add(where)
    return where

if __name__ == "__main__":
    fetch(sys.argv[1])

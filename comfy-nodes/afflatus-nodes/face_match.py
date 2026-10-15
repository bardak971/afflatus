"""How much the face in a made picture is the person of some photos: InsightFace's ArcFace (buffalo_l), on the CPU.

The picture a Motion transfer moves is made three times and picked by the user; this ranks them. Every face of the picture
is set against every face of the photos (the largest face of each photo) and the best match is kept: the person put in,
wherever they stand. Cosine similarity of the embeddings, -1 to 1: the same person reads about 0.6 and up, a close likeness
0.85 and up (the meme test, 2026-10-14). Registered only when insightface is installed (`available()`), so that a ComfyUI
without it gives no figure rather than a failed job; its model files are fetched into models/insightface the first time.

On the CPU, inside the render: kept short. A photo's face is found once (cached by a hash of its pixels: the same photos
come with every take of a person), at the full detection size; a frame's faces at half of it, the two largest only (the
person put in fills the frame of a Motion transfer; a crowd behind them is not who is matched). ~2.3 s a render for one
face, 12.6 s for a crowded set before (2026-10-15).
"""

import hashlib
import importlib.util
import os
from collections import OrderedDict

import folder_paths
from comfy_api.latest import io

_app = None

# The detection size for the photos (as InsightFace is prepared) and for the frames of the picture made, in pixels.
PHOTO_DET = 640
FRAME_DET = 320
# How many faces of a frame are matched, the largest first.
FRAME_FACES = 2
# The photos' faces by a hash of their pixels: the last few dozen.
_refs: "OrderedDict[str, object]" = OrderedDict()
_REFS_KEPT = 32


def available() -> bool:
    return importlib.util.find_spec("insightface") is not None and importlib.util.find_spec("onnxruntime") is not None


def _face_app():
    global _app
    if _app is None:
        from insightface.app import FaceAnalysis

        # ComfyUI's own models folder (where InstantID, PuLID and the like keep these), else the Afflatus pod's built-in copy;
        # with neither, InsightFace fetches them into the first the first time
        roots = [os.path.join(folder_paths.models_dir, "insightface"), "/opt/insightface"]
        root = next((r for r in roots if os.path.isdir(os.path.join(r, "models", "buffalo_l"))), roots[0])
        _app = FaceAnalysis(name="buffalo_l", root=root, allowed_modules=["detection", "recognition"], providers=["CPUExecutionProvider"])
        _app.prepare(ctx_id=-1, det_size=(PHOTO_DET, PHOTO_DET))
    return _app


def _bgr(image, index: int):
    """One picture of a ComfyUI image batch as InsightFace reads it: 8-bit BGR, colour only (an RGBA picture as its RGB)."""
    import numpy as np

    rgb = (image[index, :, :, :3].detach().cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
    return rgb[:, :, ::-1].copy()


def _faces(bgr, det: int = PHOTO_DET, most: int = 0) -> list:
    """The faces of a picture, each a unit embedding with its width in pixels: found at `det`, the `most` largest (0: all)."""
    import numpy as np

    app = _face_app()
    if det == PHOTO_DET and not most:
        faces = app.get(bgr)
    else:
        # FaceAnalysis.get with the detection size and the count of its own: the faces found, then each recognised
        from insightface.app.common import Face

        boxes, points = app.det_model.detect(bgr, input_size=(det, det), max_num=most, metric="max")
        faces = []
        for i in range(boxes.shape[0]):
            face = Face(bbox=boxes[i, 0:4], kps=points[i] if points is not None else None, det_score=boxes[i, 4])
            for task, model in app.models.items():
                if task != "detection":
                    model.get(bgr, face)
            faces.append(face)
    out = []
    for f in faces:
        if f.bbox[2] - f.bbox[0] >= 32 and f.det_score >= 0.5:
            v = np.asarray(f.normed_embedding, dtype=np.float32)
            out.append((v / (np.linalg.norm(v) + 1e-9), float(f.bbox[2] - f.bbox[0]), [float(x) for x in f.bbox[:4]]))
    return out


def _reference(photo):
    """The largest face of a photo, as a unit embedding (None without one): found once per photo, by a hash of its pixels."""
    bgr = _bgr(photo, 0)
    key = hashlib.sha1(bgr.tobytes() + repr(bgr.shape).encode()).hexdigest()
    if key in _refs:
        _refs.move_to_end(key)
        return _refs[key]
    faces = _faces(bgr)
    ref = max(faces, key=lambda f: f[1])[0] if faces else None
    _refs[key] = ref
    while len(_refs) > _REFS_KEPT:
        _refs.popitem(last=False)
    return ref


class AfflatusFaceMatch(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusFaceMatch",
            display_name="Afflatus: Face Match",
            category="Afflatus",
            description="How much a face in the image is the person of the photos (ArcFace, InsightFace buffalo_l, on the CPU): the best match, -1 to 1. A batch of frames (a clip) is read at a few of them, evenly: the median and the lowest. Handed back to Afflatus with the prompt's outputs.",
            inputs=[
                io.Image.Input("image", tooltip="The picture made, or a clip's frames: its faces are set against the photos'."),
                io.Int.Input("samples", default=8, min=1, max=64, optional=True, tooltip="Of a batch of frames, how many are read, evenly spread."),
                io.Image.Input("photo_1", tooltip="A photo of the person."),
                io.Image.Input("photo_2", optional=True, tooltip="Another photo of them."),
                io.Image.Input("photo_3", optional=True, tooltip="A third."),
            ],
            outputs=[],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, image, photo_1, photo_2=None, photo_3=None, samples: int = 8) -> io.NodeOutput:
        # a figure beside a render, never its failure: whatever goes wrong here gives no figure, and the render is kept
        try:
            return cls._measure(image, photo_1, photo_2, photo_3, samples)
        except Exception as err:  # noqa: BLE001 — any error of InsightFace or of a picture it cannot read
            return io.NodeOutput(ui={"afflatus_face": [{"face": None, "error": str(err)[:200]}]})

    @classmethod
    def _measure(cls, image, photo_1, photo_2, photo_3, samples: int) -> io.NodeOutput:
        import numpy as np

        refs = [r for r in (_reference(p) for p in (photo_1, photo_2, photo_3) if p is not None) if r is not None]
        n = int(image.shape[0])
        picked = sorted({round(i * (n - 1) / max(1, samples - 1)) for i in range(min(samples, n))}) if n > 1 else [0]
        # each frame read: its best match among its faces (the person put in, wherever they stand); none when no face is read
        found = []
        for i in picked:
            scores = [float(np.dot(f[0], r)) for f in _faces(_bgr(image, i), FRAME_DET, FRAME_FACES) for r in refs]
            if scores:
                found.append(max(scores))
        face = round(float(np.median(found)), 3) if found else None
        low = round(float(min(found)), 3) if found else None
        return io.NodeOutput(ui={"afflatus_face": [{"face": face, "low": low, "frames": len(found), "read": len(picked), "photos": len(refs)}]})


# A face elsewhere in the picture this much like the photos is the person again: a copy pasted in. Strangers in a crowd read
# under 0.2; the copies of the 2026-10-15 test read 0.5 and up.
COPY = 0.4


class AfflatusFaceAt(io.ComfyNode):
    """
    Face Match for a picture made from a frame (Motion transfer's): the face where the frame's main person stands, and the
    copies of the person anywhere else. The best match anywhere ranked first the pictures that kept the original and pasted
    the person in beside them, or turned the man behind into them too (HANDOVER-motion-picture-report.md: 9 of 12 such
    pictures read 0.78 to 0.94). The main person is the frame's largest face; the made picture's face nearest its place
    (within one face's width, the two pictures' sizes matched) is the one scored.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusFaceAt",
            display_name="Afflatus: Face At",
            category="Afflatus",
            description="How much the face at the frame's main person's place is the person of the photos (ArcFace, on the CPU), and how many copies of them are elsewhere in the picture. Handed back to Afflatus with the prompt's outputs.",
            inputs=[
                io.Image.Input("image", tooltip="The picture made."),
                io.Image.Input("frame", tooltip="The frame it was made from: its largest face is the place scored."),
                io.Image.Input("photo_1", tooltip="A photo of the person."),
                io.Image.Input("photo_2", optional=True, tooltip="Another photo of them."),
                io.Image.Input("photo_3", optional=True, tooltip="A third."),
            ],
            outputs=[],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, image, frame, photo_1, photo_2=None, photo_3=None) -> io.NodeOutput:
        # a figure beside a render, never its failure, as Face Match
        try:
            return cls._measure(image, frame, photo_1, photo_2, photo_3)
        except Exception as err:  # noqa: BLE001 — any error of InsightFace or of a picture it cannot read
            return io.NodeOutput(ui={"afflatus_face": [{"face": None, "error": str(err)[:200]}]})

    @classmethod
    def _measure(cls, image, frame, photo_1, photo_2, photo_3) -> io.NodeOutput:
        import numpy as np

        refs = [r for r in (_reference(p) for p in (photo_1, photo_2, photo_3) if p is not None) if r is not None]
        # every face of the picture (a copy can be small, behind), each with its best match among the photos
        faces = [(max((float(np.dot(f[0], r)) for r in refs), default=-1.0), f[2]) for f in _faces(_bgr(image, 0))]
        mains = _faces(_bgr(frame, 0), PHOTO_DET, 1)
        nearest = None
        if mains:
            x0, y0, x1, y1 = mains[0][2]
            sx, sy = image.shape[2] / frame.shape[2], image.shape[1] / frame.shape[1]
            cx, cy, reach = (x0 + x1) / 2 * sx, (y0 + y1) / 2 * sy, (x1 - x0) * sx
            dist = lambda b: ((b[0] + b[2]) / 2 - cx) ** 2 + ((b[1] + b[3]) / 2 - cy) ** 2  # noqa: E731
            close = min(faces, key=lambda f: dist(f[1]), default=None)
            nearest = close if close is not None and dist(close[1]) < reach**2 else None
        elif faces:
            # no face read in the frame: the best match anywhere, as Face Match
            nearest = max(faces, key=lambda f: f[0])
        copies = sum(1 for f in faces if f is not nearest and f[0] >= COPY)
        face = round(nearest[0], 3) if nearest is not None and refs else None
        return io.NodeOutput(ui={"afflatus_face": [{"face": face, "low": face, "frames": 1 if face is not None else 0, "read": 1, "photos": len(refs), "copies": copies, "placed": nearest is not None}]})

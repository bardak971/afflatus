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

from . import face_models

_app = None

# The detection size for the photos (as InsightFace is prepared) and for the frames of the picture made, in pixels.
PHOTO_DET = 640
FRAME_DET = 320
# How many faces of a frame are matched, the largest first.
FRAME_FACES = 2
# The photos' faces by a hash of their pixels: the last few dozen.
_refs: "OrderedDict[str, object]" = OrderedDict()
_REFS_KEPT = 32
# What of a photo its key is read from: about this many pixels, evenly spread, with its size
_KEY_PIXELS = 1 << 16
# ONNX Runtime's threads for one model run. Its default, one per core, fought torch's own threads inside ComfyUI: Face Match
# took 8 to 12 s a render there against about 1 s on its own at 4 threads (2026-10-22)
THREADS = 4
# ONNX Runtime's threads wait for the next run without spinning: as fast on their own (60-62 against 65-71 ms an ArcFace run),
# 60 % less CPU, and a quarter faster beside torch's busy threads (166-183 to 128-130 ms) (2026-10-23)
SPINNING = "session.intra_op.allow_spinning"


def available() -> bool:
    return importlib.util.find_spec("insightface") is not None and importlib.util.find_spec("onnxruntime") is not None


def _face_app():
    global _app
    if _app is None:
        from insightface.app import FaceAnalysis

        # ComfyUI's own models folder (where InstantID, PuLID and the like keep these): fetched whole there the first time,
        # a folder left half-extracted replaced (face_models.py), before InsightFace, which takes any folder as complete
        root = os.path.join(folder_paths.models_dir, "insightface")
        face_models.fetch(root)
        options = _session_options()
        app = FaceAnalysis(name=face_models.NAME, root=root, allowed_modules=["detection", "recognition"], providers=["CPUExecutionProvider"], sess_options=options)
        _capped(app, options)
        app.prepare(ctx_id=-1, det_size=(PHOTO_DET, PHOTO_DET))
        _app = app
    return _app


def _session_options():
    import onnxruntime

    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = max(1, min(THREADS, os.cpu_count() or THREADS))
    options.add_session_config_entry(SPINNING, "0")
    return options


def _capped(app, options) -> None:
    """Each model's session on `options`' threads, not spinning. InsightFace 2 makes them with the options it is given; 0.7.3
    (the pod image's) drops them, so a session made on the default is made again on the same file."""
    import onnxruntime

    for model in app.models.values():
        session = getattr(model, "session", None)
        path = getattr(model, "model_file", None)
        if session is None or not path:
            continue
        made = session.get_session_options()
        if made.intra_op_num_threads == options.intra_op_num_threads and _spinning(made) == "0":
            continue
        model.session = onnxruntime.InferenceSession(path, sess_options=options, providers=session.get_providers())


def _spinning(options):
    """The session's allow_spinning entry; None when it has none (ONNX Runtime raises for a key never set: spinning, its default)."""
    try:
        return options.get_session_config_entry(SPINNING)
    except Exception:
        return None


def _bgr(image, index: int):
    """One picture of a ComfyUI image batch as InsightFace reads it: 8-bit BGR, colour only (an RGBA picture as its RGB)."""
    import numpy as np

    rgb = (image[index, :, :, :3].detach().cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
    return rgb[:, :, ::-1].copy()


def face_boxes(images, every: int = 1, det: int = PHOTO_DET, frames=None) -> dict[int, list[tuple[float, float, float, float]]]:
    """The faces of a ComfyUI image batch ([N, H, W, 3]), boxes only (detection, no recognition), on the CPU: of every
    `every`th frame, or of the `frames` named; empty without InsightFace. The swap's mask picks its person with them,
    and a face pass would follow the face with them."""
    if not available():
        return {}
    det_model = _face_app().det_model
    found = {}
    for i in frames if frames is not None else range(0, images.shape[0], every):
        boxes, _ = det_model.detect(_bgr(images, i), input_size=(det, det), max_num=0, metric="max")
        found[i] = [tuple(float(v) for v in b[:4]) for b in boxes if b[4] >= 0.5 and b[2] - b[0] >= 24]
    return found


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
    """
    The largest face of a photo, as a unit embedding (None without one): found once per photo, by a hash of some of its
    pixels and its size. Converting and hashing all of a 12 MP photo took 0.12 to 0.16 s on every render (2026-10-22); a
    photo changed only between the pixels read is taken for the same one, its face then found where it was.
    """
    h, w = int(photo.shape[1]), int(photo.shape[2])
    step = max(1, int((h * w / _KEY_PIXELS) ** 0.5))
    some = photo[0, ::step, ::step, :3].detach().cpu().numpy()
    key = hashlib.sha1(some.tobytes() + repr((tuple(photo.shape), str(some.dtype))).encode()).hexdigest()
    if key in _refs:
        _refs.move_to_end(key)
        return _refs[key]
    bgr = _bgr(photo, 0)
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
    Face Match for a picture made from a frame (Motion transfer's): the person of the photos where someone stood in the
    frame, and the copies of them anywhere else. The best match anywhere ranked first the pictures that kept the original and
    pasted the person in beside them, or turned the man behind into them too (HANDOVER-motion-picture-report.md: 9 of 12 such
    pictures read 0.78 to 0.94). Every face of the picture like the photos is found; one at the place of a face of the frame
    (within that face's width, the two pictures' sizes matched) is the person put in, any other a copy. Not the frame's
    largest face: that was a stranger in the foreground of the meme at 8.5 s, and the swaps beside him read as pasted in.
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
                io.Image.Input("frame", tooltip="The frame it was made from: where its people stood."),
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
        sx, sy = image.shape[2] / frame.shape[2], image.shape[1] / frame.shape[1]
        stood = [(f[2][0] * sx, f[2][1] * sy, f[2][2] * sx, f[2][3] * sy) for f in _faces(_bgr(frame, 0))]

        def at_someone(b) -> bool:
            cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
            return any(((o[0] + o[2]) / 2 - cx) ** 2 + ((o[1] + o[3]) / 2 - cy) ** 2 < (o[2] - o[0]) ** 2 for o in stood)

        alike = [f for f in faces if f[0] >= COPY]
        placed = [f for f in alike if at_someone(f[1])]
        # the person put in: the best like them where someone stood; none there (the original kept, them pasted in beside),
        # the best anywhere, and every one like them is a copy
        best = max(placed or faces, key=lambda f: f[0], default=None)
        copies = len(alike) - (1 if placed else 0)
        face = round(best[0], 3) if best is not None and refs else None
        nearest = best if placed else None
        return io.NodeOutput(ui={"afflatus_face": [{"face": face, "low": face, "frames": 1 if face is not None else 0, "read": 1, "photos": len(refs), "copies": copies, "placed": nearest is not None}]})


# The side of the square a person's picture is cut to, in face heights: H3 Face refine's crop, the face at about 40 % of it
# with the hair and the neck in. A reference close and square held the face best (Timeline 10, 2026-10-25: a 750 x 750
# portrait kept it, a far one did not).
FACE_SQUARE = 2.5


def face_square(box, width: int, height: int, factor: float = FACE_SQUARE) -> tuple[int, int, int]:
    """The square (left, top, side) a picture is cut to around a face's box (x0, y0, x1, y1): `factor` face heights a side,
    centred on the face, no larger than the picture's short side, and moved inside the picture rather than past its edges
    (a reference with its edges smeared or padded would be followed with them)."""
    x0, y0, x1, y1 = box
    side = max(1, min(round((y1 - y0) * factor), width, height))
    left = min(max(round((x0 + x1) / 2 - side / 2), 0), width - side)
    top = min(max(round((y0 + y1) / 2 - side / 2), 0), height - side)
    return int(left), int(top), int(side)


class AfflatusFaceCrop(io.ComfyNode):
    """
    A person's reference picture cut to a square around their face, for a model that fits the whole picture into a slot
    the size of the clip's frame (LTX 2.5's MSR guide): a 3024 x 4032 portrait in a 16:9 clip's slot is about 264 x 352
    between white bars there, its face a couple of latent cells. The largest face is taken; a picture with no face found
    (a back, a figure far off), or one InsightFace cannot read, goes through as it is.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusFaceCrop",
            display_name="Afflatus: Face Crop",
            category="Afflatus",
            description="The picture cut to a square around its largest face (InsightFace's detector, on the CPU), 2.5 face heights a side, kept inside the picture. Without a face found, the picture as it is.",
            inputs=[
                io.Image.Input("image", tooltip="A person's picture: its first image is read, the batch cut where its face is."),
                io.Float.Input("factor", default=FACE_SQUARE, min=1.2, max=8.0, step=0.1, optional=True, tooltip="The square's side, in face heights."),
            ],
            outputs=[io.Image.Output("image")],
        )

    @classmethod
    def execute(cls, image, factor: float = FACE_SQUARE) -> io.NodeOutput:
        # a better reference, never a failed render: whatever goes wrong here, the picture goes on as it was given
        try:
            box = cls._largest(image)
        except Exception as err:  # noqa: BLE001 — any error of InsightFace or of a picture it cannot read
            print(f"[afflatus-nodes] Face Crop: the picture is taken whole ({str(err)[:200]})")
            return io.NodeOutput(image)
        if box is None:
            return io.NodeOutput(image)
        left, top, side = face_square(box, int(image.shape[2]), int(image.shape[1]), factor)
        return io.NodeOutput(image[:, top : top + side, left : left + side, :])

    @staticmethod
    def _largest(image):
        """The box of the picture's largest face, at the photos' detection size; None without one."""
        det_model = _face_app().det_model
        boxes, _ = det_model.detect(_bgr(image, 0), input_size=(PHOTO_DET, PHOTO_DET), max_num=0, metric="max")
        found = [tuple(float(v) for v in b[:4]) for b in boxes if b[4] >= 0.5 and b[2] - b[0] >= 24]
        return max(found, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), default=None)

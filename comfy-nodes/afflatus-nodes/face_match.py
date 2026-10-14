"""How much the face in a made picture is the person of some photos: InsightFace's ArcFace (buffalo_l), on the CPU.

The picture a Motion transfer moves is made three times and picked by the user; this ranks them. Every face of the picture
is set against every face of the photos (the largest face of each photo) and the best match is kept: the person put in,
wherever they stand. Cosine similarity of the embeddings, -1 to 1: the same person reads about 0.6 and up, a close likeness
0.85 and up (the meme test, 2026-10-14). Registered only when insightface is installed (`available()`), so that a ComfyUI
without it gives no figure rather than a failed job; its model files are fetched into models/insightface the first time.
"""

import importlib.util
import os

import folder_paths
from comfy_api.latest import io

_app = None


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
        _app.prepare(ctx_id=-1, det_size=(640, 640))
    return _app


def _faces(image, index: int = 0) -> list:
    """The faces of one picture of a ComfyUI image batch, each a unit embedding with its width in pixels."""
    import numpy as np

    rgb = (image[index].detach().cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
    out = []
    for f in _face_app().get(rgb[:, :, ::-1].copy()):
        if f.bbox[2] - f.bbox[0] >= 32 and f.det_score >= 0.5:
            v = np.asarray(f.normed_embedding, dtype=np.float32)
            out.append((v / (np.linalg.norm(v) + 1e-9), float(f.bbox[2] - f.bbox[0])))
    return out


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
        import numpy as np

        refs = []
        for photo in (photo_1, photo_2, photo_3):
            if photo is None:
                continue
            faces = _faces(photo)
            if faces:
                refs.append(max(faces, key=lambda f: f[1])[0])
        n = int(image.shape[0])
        picked = sorted({round(i * (n - 1) / max(1, samples - 1)) for i in range(min(samples, n))}) if n > 1 else [0]
        # each frame read: its best match among its faces (the person put in, wherever they stand); none when no face is read
        found = []
        for i in picked:
            scores = [float(np.dot(f[0], r)) for f in _faces(image, i) for r in refs]
            if scores:
                found.append(max(scores))
        face = round(float(np.median(found)), 3) if found else None
        low = round(float(min(found)), 3) if found else None
        return io.NodeOutput(ui={"afflatus_face": [{"face": face, "low": low, "frames": len(found), "read": len(picked), "photos": len(refs)}]})

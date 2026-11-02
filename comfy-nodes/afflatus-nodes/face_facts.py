"""What a person's picture holds of a face, for Afflatus to pick the clearest of a cast person's pictures (card #220).

A model that takes one picture of a person (Krea 2's person reference, H3's first reference, Klein's) was sent the first
one of the Prompt kit; a purple-lit selfie first cost 0.06 to 0.09 of likeness against the person's best picture (the #219
pod test). Afflatus asks this route once per picture and ranks them itself: the largest face's box and five points, how
sure the detector is, how sharp the face is, and its ArcFace embedding (the likeness to the person's other pictures). The
picture is only read: nothing is cut, changed or kept.

`POST /afflatus/face-facts` with the picture's bytes (`application/octet-stream`, a JPEG or PNG Afflatus made at most 1536
pixels a side). Never in ComfyUI's queue: no prompt, no GPU (InsightFace on the CPU, 4 threads), off the server's event
loop and one picture at a time, so that ComfyUI's API and websocket keep answering. InsightFace is loaded the first time
and let go after a minute without a picture, unless a node (Face Match) used it meanwhile: a render that needs it keeps
it as before. 501 without insightface (Afflatus keeps its order then).
"""

import asyncio
import io
import threading
import time

from . import face_match

# The version of what is answered: Afflatus asks a picture again when it changes.
FACTS_VERSION = 1
# The largest body taken: Afflatus sends a picture made at 1536 pixels a side at most, a few hundred kilobytes.
MAX_BYTES = 40 << 20
# Faces kept as the Face Match node keeps them: sure enough and wide enough to read.
MIN_SCORE = 0.5
MIN_WIDTH = 32
# The side of the square a face's sharpness is read at: every face the same size, so that two pictures compare.
SHARP_SIDE = 112
# InsightFace let go after this long without a picture asked here.
IDLE_S = 60


def _gray_square(bgr, box, side: int = SHARP_SIDE):
    """The face's box of a BGR picture as a grey `side` x `side` square, each cell the mean of the pixels it covers (numpy
    only: no resampler adds or takes away fine detail of its own)."""
    import numpy as np

    h, w = bgr.shape[:2]
    x0, y0, x1, y1 = (int(round(v)) for v in box)
    x0, y0 = max(0, min(x0, w - 1)), max(0, min(y0, h - 1))
    x1, y1 = max(x0 + 1, min(x1, w)), max(y0 + 1, min(y1, h))
    crop = bgr[y0:y1, x0:x1, :3].astype(np.float64)
    gray = crop[:, :, 0] * 0.114 + crop[:, :, 1] * 0.587 + crop[:, :, 2] * 0.299
    # each cell's sum read off the summed-area table; a face smaller than the square repeats its pixels (a cell at least one)
    table = np.zeros((gray.shape[0] + 1, gray.shape[1] + 1))
    table[1:, 1:] = gray.cumsum(0).cumsum(1)

    def edges(n):
        start = np.minimum(np.floor(np.arange(side) * n / side).astype(int), n - 1)
        end = np.maximum(np.floor(np.arange(1, side + 1) * n / side).astype(int), start + 1)
        return start, end

    r0, r1 = edges(gray.shape[0])
    c0, c1 = edges(gray.shape[1])
    sums = table[r1][:, c1] - table[r0][:, c1] - table[r1][:, c0] + table[r0][:, c0]
    return sums / np.outer(r1 - r0, c1 - c0)


def sharpness(bgr, box) -> float:
    """How sharp a face is: the variance of the Laplacian of its box brought to SHARP_SIDE pixels a side, 0 to 255 grey. A
    blurred or smeared face reads tens; a sharp photo's hundreds."""
    import numpy as np

    g = _gray_square(bgr, box)
    lap = -4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:]
    return float(np.var(lap))


def facts_of(bgr, app) -> dict:
    """What a BGR picture holds of a face, as the route answers it: its size, how many faces, and of the largest (None
    without one) its box, five points (eyes, nose, mouth corners), the detector's score, its sharpness and its unit
    ArcFace embedding."""
    import numpy as np

    h, w = int(bgr.shape[0]), int(bgr.shape[1])
    found = [f for f in app.get(bgr) if float(f.det_score) >= MIN_SCORE and float(f.bbox[2] - f.bbox[0]) >= MIN_WIDTH]
    out = {"version": FACTS_VERSION, "width": w, "height": h, "faces": len(found), "face": None}
    if not found:
        return out
    f = max(found, key=lambda x: float((x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1])))
    box = [float(v) for v in f.bbox[:4]]
    v = np.asarray(f.normed_embedding, dtype=np.float64)
    v = v / (np.linalg.norm(v) + 1e-9)
    out["face"] = {
        "box": [round(x, 1) for x in box],
        "points": [[round(float(p[0]), 1), round(float(p[1]), 1)] for p in f.kps] if getattr(f, "kps", None) is not None else None,
        "score": round(float(f.det_score), 4),
        "sharp": round(sharpness(bgr, box), 2),
        "embedding": [round(float(x), 5) for x in v],
    }
    return out


def _decode(body: bytes):
    """The picture's bytes as InsightFace reads them: 8-bit BGR, turned as its EXIF says (a phone's portrait)."""
    import numpy as np
    from PIL import Image, ImageOps

    with Image.open(io.BytesIO(body)) as im:
        rgb = ImageOps.exif_transpose(im).convert("RGB")
        return np.asarray(rgb)[:, :, ::-1].copy()


class Facts:
    """The route's work: one picture at a time, InsightFace let go after IDLE_S without a picture."""

    def __init__(self, now=time.monotonic):
        self._now = now
        self._lock = threading.Lock()
        self._last = 0.0
        self._watching = False

    def read(self, body: bytes) -> dict:
        with self._lock:
            try:
                return facts_of(_decode(body), face_match.app_for_route())
            finally:
                self._last = self._now()
                self._watch()

    def _watch(self):
        if self._watching:
            return
        self._watching = True
        threading.Thread(target=self._let_go_when_idle, name="afflatus-face-facts-idle", daemon=True).start()

    def _let_go_when_idle(self):
        while True:
            time.sleep(IDLE_S / 4)
            if self.idle_check():
                return

    def idle_check(self) -> bool:
        """InsightFace let go once no picture was asked for IDLE_S; says whether the watch is over."""
        with self._lock:
            if self._now() - self._last < IDLE_S:
                return False
            face_match.release_route_app()
            self._watching = False
            return True


def register(routes, web, facts=None):
    facts = facts or Facts()

    @routes.post("/afflatus/face-facts")
    async def _afflatus_face_facts(request):
        if not face_match.available():
            return web.Response(status=501, text="insightface is not installed in this ComfyUI")
        if request.content_type != "application/octet-stream":
            return web.Response(status=415, text="the picture's bytes are expected, as application/octet-stream")
        if (request.content_length or 0) > MAX_BYTES:
            return web.Response(status=413, text="the picture is too large")
        body = await request.read()
        if not body or len(body) > MAX_BYTES:
            return web.Response(status=400 if not body else 413, text="a picture is expected")
        try:
            # off ComfyUI's event loop: InsightFace takes a second or so on the CPU, its API and websocket keep answering
            return web.json_response(await asyncio.to_thread(facts.read, body))
        except Exception as err:  # noqa: BLE001 — a picture PIL or InsightFace cannot read is said, never a dead route
            return web.Response(status=422, text=f"the picture could not be read: {str(err)[:200]}")

    return facts

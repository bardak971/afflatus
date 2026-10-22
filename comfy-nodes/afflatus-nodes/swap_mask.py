"""The person a swap replaces, as masks for MiniMax H3 (Afflatus's H3 · Swap character).

A swap that starts from the source's own latent and redraws only the person keeps the room, the crowd and the light as the
source has them; the source pasted back outside the person makes them its own pixels (HANDOVER-swap-lipsync-plan.md §9.9:
the change outside the person fell from 15 to 1.6 out of 255, the swap as often). This node turns SAM 3.1's video track
into the two masks that takes:

- the noise mask, on H3's latent grid: a 16 px cell redrawn where the person is in any of its pixels, in any frame of
  its latent frame (the frames go 1, 4, 4, 4, 4 to each 17), grown by `grow` px, holes filled, and one latent frame each
  way. Exactly 0 or 1 per cell: core resizes a pixel mask to the latent trilinearly, which leaves fractions at the edges.
  It is the idea of roycho's Masking v7.4 (GrowMaskWithBlur 50, BlockifyMask 32, MVEx_MaskToLatentSpace grow 36), made
  here rather than taken from the GPLv3 MaskVidExperiments pack.
- the paste-back mask, in pixels: the person grown by `paste_grow` px and blurred by `paste_blur`, where the render is
  kept over the source frames (roycho's "Repair Video").

Who is replaced, in this order:
0. The one the user clicked on the window's first frame (pick_x, pick_y): the track under the click on its first frames,
   else the nearest within 40 px. Only a first window has a click: the windows after it follow it (1). Starting SAM's
   track from a mask of the person instead lost his head mid-clip; "person" found on every frame kept him (§9.11).
1. A window carrying on from the window before: the same person. The window before's last frames (handed over) and this
   window's first source frames are the same moment, and they differ only where the window before redrew its person;
   the track that lies most over that difference is theirs. Each window choosing anew swapped the meme's man in the
   second window but someone else in the first, and the man changed at the join (§9.9, the app test of 2026-10-17).
2. Else the one whose faces are the largest over the clip (the face detector on every few frames): a swap is about the
   face, and over a window that opens on someone's back three people came out level by their share of the frame.
3. Else (no face anywhere, or no InsightFace) the largest share of the frame.
When SAM tracked no one, both masks are whole: the whole frame is redrawn and kept, as a swap without a mask, and the
node's note says so. The whole person is redrawn, not the head alone: with only the head open H3 rebuilt the source's
own person from its reference video (§9.9, the clothes test).

The cell arithmetic is numpy (the tests run it without torch); torch is only for the pixel-size paste mask.
"""

import math

import numpy as np
from comfy_api.latest import io

FRAME_PER_TOKEN = (1, 4, 4, 4, 4)
CELL = 16

SAM3TrackData = io.Custom("SAM3_TRACK_DATA")


def latent_frames(frames: int) -> int:
    """H3's video latent frames for a clip of `frames` (17k + 5): 2 for 5 frames, 5 more for each 17 after."""
    return 2 if frames <= 5 else ((frames - 5) // 17) * 5 + 2


def latent_spans(n_latent: int) -> list[tuple[int, int]]:
    """The frames each latent frame holds: [0, 1), [1, 5), [5, 9), … in the 1, 4, 4, 4, 4 pattern."""
    spans, at = [], 0
    for k in range(n_latent):
        spans.append((at, at + FRAME_PER_TOKEN[k % 5]))
        at += FRAME_PER_TOKEN[k % 5]
    return spans


def dilate_cells(cells: np.ndarray, radius: int) -> np.ndarray:
    """[N, h, w] bool grown by a disk of `radius` cells (shifted copies: the cell grid is small)."""
    if radius <= 0:
        return cells
    n, h, w = cells.shape
    padded = np.pad(cells, ((0, 0), (radius, radius), (radius, radius)))
    out = np.zeros_like(cells)
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dy * dy + dx * dx <= radius * radius:
                out |= padded[:, radius + dy : radius + dy + h, radius + dx : radius + dx + w]
    return out


def fill_holes(cells: np.ndarray) -> np.ndarray:
    """[N, h, w] bool with its enclosed holes filled: what the border cannot reach through empty cells is the person's."""
    free = ~cells
    outside = np.zeros_like(cells)
    outside[:, 0, :], outside[:, -1, :], outside[:, :, 0], outside[:, :, -1] = free[:, 0, :], free[:, -1, :], free[:, :, 0], free[:, :, -1]
    while True:
        grown = outside.copy()
        grown[:, 1:, :] |= outside[:, :-1, :]
        grown[:, :-1, :] |= outside[:, 1:, :]
        grown[:, :, 1:] |= outside[:, :, :-1]
        grown[:, :, :-1] |= outside[:, :, 1:]
        grown &= free
        if np.array_equal(grown, outside):
            return ~outside
        outside = grown


def most_prominent(tracks: list[np.ndarray]) -> np.ndarray | None:
    """The track ([N, H, W] bool) with the largest share of the frame over the clip; None when no track holds anyone."""
    areas = [float(t.mean()) for t in tracks]
    if not areas or max(areas) <= 0:
        return None
    return tracks[int(np.argmax(areas))]


# A track follows the window before when at least this share of what the window before redrew lies in it.
FOLLOW_SHARE = 0.2


def followed(tracks: list[np.ndarray], changed: np.ndarray) -> int | None:
    """The track lying most over `changed` ([k, H, W] bool: the first frames where the window before differs from the
    source, its redrawn person), when it holds at least FOLLOW_SHARE of it; None otherwise."""
    total = int(changed.sum())
    if not tracks or total == 0:
        return None
    k = changed.shape[0]
    over = [int((t[:k] & changed[: t[:k].shape[0]]).sum()) for t in tracks]
    best = int(np.argmax(over))
    return best if over[best] >= FOLLOW_SHARE * total else None


def by_faces(tracks: list[np.ndarray], faces: dict[int, list[tuple[float, float, float, float]]]) -> int | None:
    """The track whose faces are the largest over the clip: each face (x0, y0, x1, y1, on the frame it was found in)
    counts its width for the track its centre lies in. None when no face lies in any track."""
    if not tracks:
        return None
    score = [0.0] * len(tracks)
    for frame, boxes in faces.items():
        for x0, y0, x1, y1 in boxes:
            cx, cy = int((x0 + x1) / 2), int((y0 + y1) / 2)
            for i, t in enumerate(tracks):
                if frame < t.shape[0] and 0 <= cy < t.shape[1] and 0 <= cx < t.shape[2] and t[frame, cy, cx]:
                    score[i] += x1 - x0
    best = int(np.argmax(score))
    return best if score[best] > 0 else None


# A click finds the track under it on the first frames of the window; within this many pixels when on no one's mask.
CLICK_FRAMES = 5
CLICK_NEAR = 40


def clicked(tracks: list[np.ndarray], point: tuple[float, float]) -> int | None:
    """The track under `point` (x, y in pixels) on the window's first frames, else the nearest within CLICK_NEAR pixels
    on its first frame; None when no one is there (the user clicked on the room, or SAM did not find that person)."""
    x, y = int(round(point[0])), int(round(point[1]))
    for f in range(CLICK_FRAMES):
        for i, t in enumerate(tracks):
            if f < t.shape[0] and 0 <= y < t.shape[1] and 0 <= x < t.shape[2] and t[f, y, x]:
                return i
    best, near = None, CLICK_NEAR + 1.0
    for i, t in enumerate(tracks):
        ys, xs = np.nonzero(t[0]) if t.shape[0] else (np.array([]), np.array([]))
        if len(xs):
            d = float(np.min(np.hypot(xs - x, ys - y)))
            if d < near:
                best, near = i, d
    return best


def pick(tracks: list[np.ndarray], faces, changed: np.ndarray | None, point: tuple[float, float] | None = None) -> tuple[np.ndarray | None, str]:
    """Who is replaced, and how they were found: "clicked", "followed", "face", "area" or "none" (see the module's note).
    `faces`: the boxes, or a function that finds them, called only when neither a click nor the window before decided
    (on the CPU, the faces of a window took 16 s of the node's time)."""
    if point is not None:
        i = clicked(tracks, point)
        if i is not None:
            return tracks[i], "clicked"
    if changed is not None:
        i = followed(tracks, changed)
        if i is not None:
            return tracks[i], "followed"
    if callable(faces):
        faces = faces()
    if faces:
        i = by_faces(tracks, faces)
        if i is not None:
            return tracks[i], "face"
    person = most_prominent(tracks)
    return person, "area" if person is not None else "none"


# Faces looked for on one frame in this many: the person's face over the clip, not each frame's.
FACE_EVERY = 3


def face_boxes(images, every: int = FACE_EVERY) -> dict[int, list[tuple[float, float, float, float]]]:
    """The faces of every `every`th frame ([N, H, W, 3] ComfyUI image), boxes only, on the CPU; empty without InsightFace."""
    from . import face_match

    return face_match.face_boxes(images, every)


def changed_from(previous, images, threshold: float = 0.1) -> np.ndarray:
    """[k, H, W] bool: where the window before's handed-over frames differ from this window's first source frames (its
    redrawn person; the rest was pasted back from the same source, so it differs by the encoding only)."""
    k = min(previous.shape[0], images.shape[0])
    a = previous[:k, :, :, :3].detach().cpu().float().numpy()
    b = images[:k, :, :, :3].detach().cpu().float().numpy()
    if a.shape != b.shape:
        return np.zeros((0, *b.shape[1:3]), bool)
    return np.abs(a - b).max(axis=-1) > threshold


# frames either side of each whose person the paste-back keeps too
PASTE_REACH = 3
# The paste-back mask is grown and blurred at this fraction of the frame's size, then enlarged: its edge is blurred anyway,
# and at full size its 30 grow passes over a window's 141 frames took most of the node's two minutes on the CPU
# (render stats of 2026-10-17: 2 min of a 6 min 50 s swap clip).
PASTE_SCALE = 4


def fit_frames(mask: np.ndarray, frames: int) -> np.ndarray:
    """The first `frames` of [N, ...], the last one held when the track is shorter."""
    if mask.shape[0] >= frames:
        return mask[:frames]
    return np.concatenate([mask, np.repeat(mask[-1:], frames - mask.shape[0], axis=0)])


def noise_mask(person: np.ndarray | None, frames: int, width: int, height: int, grow: int) -> np.ndarray:
    """[T_lat, height/16, width/16] float32, 1 = redrawn: from the person's [N, height, width] bool track (None: all of it)."""
    n_lat = latent_frames(frames)
    h, w = height // CELL, width // CELL
    if person is None:
        return np.ones((n_lat, h, w), np.float32)
    px = fit_frames(person, frames)[:, : h * CELL, : w * CELL]
    # a cell is the person's when any of its pixels is: then grown on the cell grid, holes filled, any over each latent frame
    cells = px.reshape(frames, h, CELL, w, CELL).any(axis=(2, 4))
    values = fill_holes(dilate_cells(cells, int(math.ceil(grow / CELL)))).astype(np.float32)
    lat = np.stack([values[a:b].max(axis=0) for a, b in latent_spans(n_lat)])
    near = lat.copy()
    near[1:] = np.maximum(near[1:], lat[:-1])
    near[:-1] = np.maximum(near[:-1], lat[1:])
    return near.astype(np.float32)


def paste_mask(person, frames: int, width: int, height: int, grow: int, sigma: float, reach: int = PASTE_REACH, scale: int = PASTE_SCALE):
    """
    [frames, height, width] torch float: the person over the `reach` frames either side of each (an arm SAM loses for a few
    frames of a fast gesture stays the render's, not the source's pasted back over it: the owner's Bulin 47 take,
    2026-10-17), grown about `grow` px (3 x 3 steps, square and cross in turn) and blurred: all of it on a grid `scale`
    times coarser (a cell is the person's when any of its pixels is), then enlarged to the frame smoothly.
    """
    import torch
    import torch.nn.functional as F

    if person is None:
        return torch.ones(frames, height, width)
    px = fit_frames(person, frames)
    s = scale if scale > 1 and height % scale == 0 and width % scale == 0 and px.shape[1] >= height and px.shape[2] >= width else 1
    if s > 1:
        px = px[:, :height, :width].reshape(frames, height // s, s, width // s, s).any(axis=(2, 4))
        grow, sigma = int(round(grow / s)), sigma / s
    m = torch.from_numpy(np.ascontiguousarray(px)).float()[:, None]
    if reach > 0:
        m = F.max_pool3d(m.permute(1, 0, 2, 3)[None], (2 * reach + 1, 1, 1), 1, (reach, 0, 0))[0].permute(1, 0, 2, 3)
    cross = torch.tensor([[0.0, 1.0, 0.0], [1.0, 1.0, 1.0], [0.0, 1.0, 0.0]])[None, None]
    for i in range(grow):
        m = F.max_pool2d(m, 3, 1, 1) if i % 2 == 0 else (F.conv2d(m, cross, padding=1) > 0).float()
    if sigma > 0:
        r = int(math.ceil(3 * sigma))
        x = torch.arange(-r, r + 1, dtype=torch.float32)
        k = torch.exp(-(x**2) / (2 * sigma * sigma))
        k = k / k.sum()
        m = F.conv2d(F.pad(m, (r, r, 0, 0), mode="replicate"), k[None, None, None, :])
        m = F.conv2d(F.pad(m, (0, 0, r, r), mode="replicate"), k[None, None, :, None])
    if s > 1:
        m = F.interpolate(m, size=(height, width), mode="bilinear", align_corners=False)
    return m[:, 0].clamp(0, 1)


def person_tracks(track_data, width: int, height: int) -> list[np.ndarray]:
    """Each tracked object's masks, [N, height, width] bool (the tracker keeps them packed, at its own size)."""
    packed = track_data.get("packed_masks")
    if packed is None or packed.shape[1] == 0:
        return []
    import torch.nn.functional as F
    from comfy.ldm.sam3.tracker import unpack_masks

    out = []
    for i in range(packed.shape[1]):
        m = unpack_masks(packed[:, i].clone()).float().cpu()[:, None]
        out.append((F.interpolate(m, size=(height, width), mode="bilinear", align_corners=False)[:, 0] > 0.5).numpy())
    return out


class AfflatusSwapMask(io.ComfyNode):
    """The masks of a masked H3 swap, from SAM 3.1's track: see the module's note."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusSwapMask",
            display_name="Afflatus: Swap Mask (H3)",
            category="Afflatus",
            description="The person a swap replaces, from a SAM 3.1 video track (the one the window before replaced, else the largest face, else the largest), as a MiniMax H3 noise mask (on the latent grid, 0 or 1 per cell) and a paste-back mask (pixels): the swap redraws only them and keeps the rest of the source.",
            inputs=[
                SAM3TrackData.Input("track_data", tooltip="SAM3 Video Track of the source's frames, at the swap's size."),
                io.Int.Input("frames", default=141, min=5, max=100000, tooltip="The clip's frames (17k + 5)."),
                io.Int.Input("width", default=576, min=32, max=16384, step=32),
                io.Int.Input("height", default=1024, min=32, max=16384, step=32),
                # 100: the tested mask's reach (grow 50, blockify 32, then 36 on the latent), 98 % of its tokens on the meme (§9.9)
                io.Int.Input("grow", default=100, min=0, max=1024, tooltip="Pixels the redrawn region reaches past the person, in whole 16 px cells."),
                # Not used since 0.31 (the soft zone went), but kept in its place: ComfyUI's frontend gives a saved graph's
                # widget values back by position, so without it a 0.5.2 graph's paste_reach, pick_x and pick_y each took the
                # value before theirs (pick_x then 3, refused)
                io.Int.Input("soft", default=0, min=0, max=512, optional=True, tooltip="Not used: kept so that graphs saved before 0.31 load with the right values."),
                io.Int.Input("paste_grow", default=10, min=0, max=256, tooltip="Pixels the kept render reaches past the person."),
                io.Float.Input("paste_blur", default=5.0, min=0.0, max=64.0, tooltip="The paste-back edge's blur, in pixels."),
                io.Int.Input("paste_reach", default=PASTE_REACH, min=0, max=24, optional=True, tooltip="The person of this many frames either side of each is kept too: a limb SAM loses for a moment is not pasted over."),
                io.Image.Input("images", optional=True, tooltip="The frames SAM tracked: their faces pick the person."),
                io.Image.Input("previous", optional=True, tooltip="The window before's last frames, handed over at this window's start: the person it replaced is followed."),
                # the user's click on the window's first frame, as shares of its width and height; below 0: none
                io.Float.Input("pick_x", default=-1.0, min=-1.0, max=1.0, optional=True, tooltip="Where the person replaced was clicked on the first frame, as a share of the width (below 0: no click)."),
                io.Float.Input("pick_y", default=-1.0, min=-1.0, max=1.0, optional=True, tooltip="The same, as a share of the height."),
            ],
            outputs=[io.Mask.Output(display_name="noise_mask"), io.Mask.Output(display_name="paste_mask")],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, track_data, frames: int = 141, width: int = 576, height: int = 1024, grow: int = 100, paste_grow: int = 10, paste_blur: float = 5.0, images=None, previous=None, pick_x: float = -1.0, pick_y: float = -1.0, paste_reach: int = PASTE_REACH, soft: int = 0) -> io.NodeOutput:
        import torch

        tracks = person_tracks(track_data, width, height)
        changed = changed_from(previous, images) if previous is not None and images is not None else None
        # found only when needed: a click or the window before decides most windows
        faces = (lambda: face_boxes(images)) if images is not None and tracks else None
        point = (pick_x * width, pick_y * height) if pick_x is not None and pick_y is not None and pick_x >= 0 and pick_y >= 0 else None
        person, how = pick(tracks, faces, changed, point)
        print(f"[afflatus] Swap Mask: {len(tracks)} people tracked, the one replaced found by {how}")
        note = []
        if person is None:
            note.append("No one was found in the source video: the whole frame was redrawn, as a swap without a mask.")
        elif point is not None and how != "clicked":
            note.append("No one was found where the person to replace was clicked: the one with the largest face was taken, which may be someone else.")
        elif changed is not None and how != "followed":
            note.append("The person the window before replaced was not found in this one: the one with the largest face was taken, which may be someone else.")
        noise = torch.from_numpy(noise_mask(person, frames, width, height, grow))
        return io.NodeOutput(noise, paste_mask(person, frames, width, height, paste_grow, paste_blur, reach=paste_reach), ui={"afflatus_note": note})


# The theme's accent (the owner, 2026-10-18: the mask in the accent colour, not green), as RGB 0-1
PREVIEW_COLOUR = (0.949, 0.573, 0.431)


def preview_alpha(noise: np.ndarray, paste: np.ndarray, frames: int) -> np.ndarray:
    """[frames, H, W] float32, how strongly each pixel is tinted: 0.5 where H3 makes it again (the noise mask's cells, each
    latent frame over the frames it holds), 0.25 where the render is only pasted back (the paste mask's band), else 0."""
    n_lat, h, w = noise.shape
    H, W = paste.shape[1], paste.shape[2]
    per_frame = np.zeros((frames, h, w), np.float32)
    for k, (a, b) in enumerate(latent_spans(n_lat)):
        per_frame[a:min(b, frames)] = noise[k]
    cells = np.repeat(np.repeat(per_frame, CELL, axis=1), CELL, axis=2)[:, :H, :W]
    full = np.zeros((frames, H, W), np.float32)
    full[:, : cells.shape[1], : cells.shape[2]] = cells
    return np.maximum(0.5 * full, 0.25 * np.clip(paste[:frames], 0, 1)).astype(np.float32)


class AfflatusSwapMaskPreview(io.ComfyNode):
    """The swap's masks drawn over the frames they were made from, for the timeline's Show the mask: what H3 makes again
    in the accent colour, the band the render is pasted back over lighter, the rest as the source has it."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusSwapMaskPreview",
            display_name="Afflatus: Swap Mask Preview (H3)",
            category="Afflatus",
            description="The Swap Mask's two masks drawn over the source frames: the cells H3 redraws in the accent colour, the paste-back band lighter.",
            inputs=[
                io.Image.Input("images", tooltip="The frames the masks were made from, at the swap's size."),
                io.Mask.Input("noise_mask", tooltip="Swap Mask's noise mask (H3's latent grid)."),
                io.Mask.Input("paste_mask", tooltip="Swap Mask's paste-back mask (pixels)."),
            ],
            outputs=[io.Image.Output(display_name="images")],
        )

    @classmethod
    def execute(cls, images, noise_mask, paste_mask) -> io.NodeOutput:
        import torch

        frames = images.shape[0]
        alpha = preview_alpha(noise_mask.detach().cpu().float().numpy(), paste_mask.detach().cpu().float().numpy(), frames)
        a = torch.from_numpy(alpha)[..., None].to(images.device, images.dtype)
        colour = torch.tensor(PREVIEW_COLOUR, device=images.device, dtype=images.dtype)
        return io.NodeOutput(images[..., :3] * (1 - a) + colour * a)


def zone_cells(noise: np.ndarray, frames: int, height: int, width: int, scale: int) -> np.ndarray:
    """[frames, height/scale, width/scale] bool: the latent cells H3 redraws (the noise mask, each latent frame over the
    frames it holds), on a grid `scale` times coarser than the frame."""
    n_lat, h, w = noise.shape
    per = np.zeros((frames, h, w), bool)
    for k, (a, b) in enumerate(latent_spans(n_lat)):
        per[a:min(b, frames)] = noise[k] > 0
    step = CELL // scale
    cells = np.repeat(np.repeat(per, step, axis=1), step, axis=2)
    out = np.zeros((frames, height // scale, width // scale), bool)
    out[:, : cells.shape[1], : cells.shape[2]] = cells[:, : out.shape[1], : out.shape[2]]
    return out


def difference_alpha(render, source, noise: np.ndarray, paste, threshold: float = 0.06, grow: int = 8, sigma: float = 4.0, reach: int = 1, scale: int = PASTE_SCALE, spread: int = 40):
    """
    [frames, H, W] torch float, where the render is kept over the source: inside the zone H3 redrew, where it differs
    clearly from the source (a new person's limb over the wall), plus the person's own paste-back mask; elsewhere the
    source's own pixels, so the wall H3 redrew close to the source's does not show as a wavering band around the person
    (the owner's Timeline 19, 2026-10-18); only what is joined to the person, never someone H3 invented elsewhere in the
    zone. The difference is read as a local mean (the VAE's grain is not a change),
    held over `reach` frames either side, grown about `grow` px and blurred, all on a grid `scale` times coarser.
    """
    import torch
    import torch.nn.functional as F

    frames, H, W = render.shape[0], render.shape[1], render.shape[2]
    s = scale if scale > 1 and H % scale == 0 and W % scale == 0 and CELL % scale == 0 else 1
    d = (render[..., :3].float() - source[:frames, ..., :3].float()).abs().amax(-1)[:, None].cpu()
    if s > 1:
        d = F.avg_pool2d(d, s)
    d = F.avg_pool2d(d, 3, 1, 1)
    keep = (d > threshold).float()
    zone = torch.from_numpy(zone_cells(noise, frames, H, W, s)).float()[:, None]
    person = paste[:frames].float().cpu()[:, None]
    if s > 1:
        person = F.max_pool2d(person, s)
    keep = torch.maximum(keep * zone, person)
    # only what is joined to the person: a new limb or a longer garment is, people H3 invented elsewhere in the zone are
    # not (the owner's Timeline 19 take, Grow 160: two women at the table, 2026-10-18). Grown from the person through
    # what differs, until it no longer grows
    # and no further from the person than `spread` px: someone invented right behind an arm is not joined through it
    near = person.clone()
    for _ in range(int(round(spread / s))):
        near = F.max_pool2d(near, 3, 1, 1)
    keep = keep * near
    joined = person.clone()
    for _ in range(4 * max(H, W) // s):
        grown = F.max_pool2d(joined, 3, 1, 1) * keep
        if torch.equal(grown, joined):
            break
        joined = grown
    keep = joined
    if reach > 0:
        keep = F.max_pool3d(keep.permute(1, 0, 2, 3)[None], (2 * reach + 1, 1, 1), 1, (reach, 0, 0))[0].permute(1, 0, 2, 3)
    for _ in range(int(round(grow / s))):
        keep = F.max_pool2d(keep, 3, 1, 1)
    sig = sigma / s
    if sig > 0:
        r = int(math.ceil(3 * sig))
        x = torch.arange(-r, r + 1, dtype=torch.float32)
        k = torch.exp(-(x**2) / (2 * sig * sig))
        k = k / k.sum()
        keep = F.conv2d(F.pad(keep, (r, r, 0, 0), mode="replicate"), k[None, None, None, :])
        keep = F.conv2d(F.pad(keep, (0, 0, r, r), mode="replicate"), k[None, None, :, None])
    if s > 1:
        keep = F.interpolate(keep, size=(H, W), mode="bilinear", align_corners=False)
    return keep[:, 0].clamp(0, 1)


class AfflatusSwapPaste(io.ComfyNode):
    """The swap's render put back over its source by difference: see difference_alpha."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusSwapPaste",
            display_name="Afflatus: Swap Paste by Difference (H3)",
            category="Afflatus",
            description="The swap's render kept over the source where it clearly differs from it inside the zone H3 redrew, and over the person; elsewhere the source's own pixels.",
            inputs=[
                io.Image.Input("render", tooltip="The swap's decoded frames."),
                io.Image.Input("source", tooltip="The source's frames at the swap's size."),
                io.Mask.Input("noise_mask", tooltip="Swap Mask's noise mask: the zone H3 redrew."),
                io.Mask.Input("paste_mask", tooltip="Swap Mask's paste-back mask: the person, always kept."),
                io.Float.Input("threshold", default=0.06, min=0.0, max=1.0, step=0.01, tooltip="How much a pixel has to differ from the source (a local mean, 0-1) to be the render's."),
                io.Int.Input("grow", default=8, min=0, max=128, tooltip="Pixels the kept part reaches past what differs."),
                io.Float.Input("blur", default=4.0, min=0.0, max=64.0, tooltip="The edge's blur, in pixels."),
                io.Int.Input("reach", default=1, min=0, max=12, tooltip="Frames either side whose kept part is kept too: the edge does not flicker."),
                io.Int.Input("spread", default=40, min=0, max=400, optional=True, tooltip="How far from the person, in pixels, what differs is kept: no further, someone H3 invented nearby is not."),
            ],
            outputs=[io.Image.Output(display_name="images")],
        )

    @classmethod
    def execute(cls, render, source, noise_mask, paste_mask, threshold: float = 0.06, grow: int = 8, blur: float = 4.0, reach: int = 1, spread: int = 40) -> io.NodeOutput:
        a = difference_alpha(render, source, noise_mask.detach().cpu().float().numpy(), paste_mask, threshold, grow, blur, reach, spread=spread)
        a = a[..., None].to(render.device, render.dtype)
        src = source[: render.shape[0], ..., :3].to(render.device, render.dtype)
        return io.NodeOutput(src * (1 - a) + render[..., :3] * a)


class AfflatusSwapMatch(io.ComfyNode):
    """The swap's render as it is: the colour match it made is gone (pack 0.31), the node kept for graphs that name it."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusSwapMatch",
            display_name="Afflatus: Swap Colour Match (H3)",
            category="Afflatus",
            # Afflatus no longer uses it (its match washed the redrawn wall white): still registered, with the inputs it had,
            # so that a graph saved from a 0.5.2 Swap character loads, and marked deprecated so that ComfyUI hides it from
            # the node search. It passes the render through.
            is_deprecated=True,
            description="Deprecated: passes the swap's render through unchanged. It matched the render's colours to the source's on the wall around the person; kept so that graphs which name it still load.",
            inputs=[
                io.Image.Input("render", tooltip="The swap's decoded frames."),
                io.Image.Input("source", tooltip="The source's frames at the swap's size (not used)."),
                io.Mask.Input("noise_mask", tooltip="Swap Mask's noise mask (not used)."),
                io.Mask.Input("paste_mask", tooltip="Swap Mask's paste-back mask (not used)."),
                io.Float.Input("strength", default=1.0, min=0.0, max=1.0, step=0.05),
                io.Int.Input("smooth", default=2, min=0, max=12),
            ],
            outputs=[io.Image.Output(display_name="images")],
        )

    @classmethod
    def execute(cls, render, source, noise_mask, paste_mask, strength: float = 1.0, smooth: int = 2) -> io.NodeOutput:
        return io.NodeOutput(render)

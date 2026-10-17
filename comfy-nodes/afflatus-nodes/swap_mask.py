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

The person is the most prominent one tracked: the largest share of the frame over the clip (a crowd test picked the
right man at 16 % of the frame against 9 % for the next). When SAM tracked no one, both masks are whole: the whole frame
is redrawn and kept, as a swap without a mask, and the node's note says so. The whole person is redrawn, not the head
alone: with only the head open H3 rebuilt the source's own person from its reference video (§9.9, the clothes test).

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
    cells = fill_holes(dilate_cells(cells, int(math.ceil(grow / CELL))))
    lat = np.stack([cells[a:b].any(axis=0) for a, b in latent_spans(n_lat)])
    near = lat.copy()
    near[1:] |= lat[:-1]
    near[:-1] |= lat[1:]
    return near.astype(np.float32)


def paste_mask(person, frames: int, width: int, height: int, grow: int, sigma: float):
    """[frames, height, width] torch float: the person grown about `grow` px (3 x 3 steps, square and cross in turn) and blurred."""
    import torch
    import torch.nn.functional as F

    if person is None:
        return torch.ones(frames, height, width)
    m = torch.from_numpy(fit_frames(person, frames)).float()[:, None]
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
            description="The most prominent person of a SAM 3.1 video track as a MiniMax H3 noise mask (on the latent grid, 0 or 1 per cell) and a paste-back mask (pixels): the swap redraws only them and keeps the rest of the source.",
            inputs=[
                SAM3TrackData.Input("track_data", tooltip="SAM3 Video Track of the source's frames, at the swap's size."),
                io.Int.Input("frames", default=141, min=5, max=100000, tooltip="The clip's frames (17k + 5)."),
                io.Int.Input("width", default=576, min=32, max=16384, step=32),
                io.Int.Input("height", default=1024, min=32, max=16384, step=32),
                # 100: the tested mask's reach (grow 50, blockify 32, then 36 on the latent), 98 % of its tokens on the meme (§9.9)
                io.Int.Input("grow", default=100, min=0, max=1024, tooltip="Pixels the redrawn region reaches past the person, in whole 16 px cells."),
                io.Int.Input("paste_grow", default=10, min=0, max=256, tooltip="Pixels the kept render reaches past the person."),
                io.Float.Input("paste_blur", default=5.0, min=0.0, max=64.0, tooltip="The paste-back edge's blur, in pixels."),
            ],
            outputs=[io.Mask.Output(display_name="noise_mask"), io.Mask.Output(display_name="paste_mask")],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, track_data, frames: int = 141, width: int = 576, height: int = 1024, grow: int = 100, paste_grow: int = 10, paste_blur: float = 5.0) -> io.NodeOutput:
        import torch

        person = most_prominent(person_tracks(track_data, width, height))
        note = [] if person is not None else ["No one was found in the source video: the whole frame was redrawn, as a swap without a mask."]
        noise = torch.from_numpy(noise_mask(person, frames, width, height, grow))
        return io.NodeOutput(noise, paste_mask(person, frames, width, height, paste_grow, paste_blur), ui={"afflatus_note": note})

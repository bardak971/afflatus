"""A clip's colours brought to a reference video's moment by moment, smoothed over time (Afflatus: Follow Colours).

Motion transfer matched a window's colours to its driving video with one transform pooled over the whole window: a model
that drifts inside a window (SCAIL-2 warming up, then staying warm while the driving video cooled again) kept the drift,
and the window after, held to the clip before's last frame, carried it on (Timeline 8, 2026-10-21: 4 to 5 levels redder
than its driving video for all of its 5 s). Here each frame is matched to the reference at the same moment, both sides'
colour figures averaged over a second or so first: a slow drift is followed, a frame's own flicker is not added, and two
windows of one source meet on the same colours, both aiming at the same moment of it.

The arithmetic is numpy (the tests run it without torch); torch only carries the frames in and out.
"""

import numpy as np
from comfy_api.latest import io

# sRGB (D65) to CIE Lab and back, as numpy on (..., 3) arrays in 0..1
_M = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
_M_INV = np.linalg.inv(_M)
_WHITE = np.array([0.95047, 1.0, 1.08883])
_EPS = 216 / 24389
_KAPPA = 24389 / 27


def rgb_to_lab(rgb):
    c = np.clip(rgb, 0, 1)
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    xyz = lin @ _M.T / _WHITE
    f = np.where(xyz > _EPS, np.cbrt(xyz), (_KAPPA * xyz + 16) / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], axis=-1)


def lab_to_rgb(lab):
    fy = (lab[..., 0] + 16) / 116
    f = np.stack([fy + lab[..., 1] / 500, fy, fy - lab[..., 2] / 200], axis=-1)
    xyz = np.where(f ** 3 > _EPS, f ** 3, (116 * f - 16) / _KAPPA) * _WHITE
    lin = np.clip(xyz @ _M_INV.T, 0, None)
    return np.clip(np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * lin ** (1 / 2.4) - 0.055), 0, 1)


def frame_stats(rgb, step=4):
    """A frame's Lab mean and spread, read off every `step`-th pixel each way: (mean[3], std[3])."""
    lab = rgb_to_lab(np.asarray(rgb, dtype=np.float64)[::step, ::step]).reshape(-1, 3)
    return lab.mean(axis=0), lab.std(axis=0)


def smoothed(values, radius):
    """
    Each row as a straight line fitted through the rows within `radius` of it reads at it: a figure along the clip, its flicker
    averaged out. A line, not a mean: at the clip's ends a mean leans into the clip (its last frame read as a few frames
    earlier), and two windows of one changing source met a step apart.
    """
    v = np.asarray(values, dtype=np.float64)
    if radius <= 0 or len(v) < 3:
        return v.copy()
    out = np.empty_like(v)
    for i in range(len(v)):
        a, b = max(0, i - radius), min(len(v), i + radius + 1)
        x = np.arange(a, b, dtype=np.float64) - i
        w = v[a:b].reshape(b - a, -1)
        xm = x.mean()
        slope = ((x - xm)[:, None] * (w - w.mean(axis=0))).sum(axis=0) / max(((x - xm) ** 2).sum(), 1e-9)
        out[i] = (w.mean(axis=0) - slope * xm).reshape(v.shape[1:])
    return out


def ref_index(i, frames, ref_frames):
    """The reference frame at the clip's frame `i`, both covering the same stretch of time."""
    if ref_frames <= 1 or frames <= 1:
        return 0
    return min(ref_frames - 1, round(i * (ref_frames - 1) / (frames - 1)))


def follow_params(target_stats, ref_stats, radius, scale_most=2.0):
    """
    Per frame of the clip, the scale and offset (Lab) that bring its averaged colours to the reference's averaged ones at the
    same moment. `target_stats` and `ref_stats`: lists of (mean, std), one per frame of each.
    """
    n, m = len(target_stats), len(ref_stats)
    t_mean = smoothed([s[0] for s in target_stats], radius)
    t_std = smoothed([s[1] for s in target_stats], radius)
    r_rows = [ref_stats[ref_index(i, n, m)] for i in range(n)]
    r_mean = smoothed([s[0] for s in r_rows], radius)
    r_std = smoothed([s[1] for s in r_rows], radius)
    scale = np.clip(r_std / np.maximum(t_std, 1e-6), 1 / scale_most, scale_most)
    offset = r_mean - scale * t_mean
    return scale, offset


def apply_follow(rgb, scale, offset, strength=1.0):
    """One frame moved by its scale and offset in Lab, `strength` of the way."""
    lab = rgb_to_lab(np.asarray(rgb, dtype=np.float64))
    moved = lab * scale + offset
    return lab_to_rgb(lab + strength * (moved - lab))


class AfflatusColorFollow(io.ComfyNode):
    """A clip's colours brought to a reference video's at each moment, both averaged over a little time first."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusColorFollow",
            display_name="Afflatus: Follow Colours",
            category="Afflatus",
            description="Brings each frame's colours to the reference video's at the same moment (Lab mean and spread), both averaged over a stretch of frames first: a slow drift is followed, no flicker is added, and clips cut from one reference meet on the same colours.",
            inputs=[
                io.Image.Input("images", tooltip="The clip's frames."),
                io.Image.Input("reference", tooltip="The reference video's frames over the same stretch of time (any size, any count: matched by moment)."),
                io.Int.Input("radius", default=8, min=0, max=240, tooltip="Frames either side its figures are averaged over (8 at 16 a second: a second in all)."),
                io.Float.Input("strength", default=1.0, min=0.0, max=1.0, step=0.01),
            ],
            outputs=[io.Image.Output(display_name="images")],
        )

    @classmethod
    def execute(cls, images, reference, radius: int = 8, strength: float = 1.0) -> io.NodeOutput:
        import torch

        frames = images.shape[0]
        target = [frame_stats(images[i].cpu().numpy()) for i in range(frames)]
        ref = [frame_stats(reference[j].cpu().numpy()) for j in range(reference.shape[0])]
        scale, offset = follow_params(target, ref, radius)
        out = torch.empty_like(images)
        for i in range(frames):
            moved = apply_follow(images[i].cpu().numpy(), scale[i], offset[i], strength)
            out[i] = torch.from_numpy(moved.astype(np.float32)).to(images.device, dtype=images.dtype)
        return io.NodeOutput(out)

"""A clip's colours brought to a reference video's moment by moment, smoothed over time (Afflatus: Follow Colours).

Motion transfer matched a window's colours to its driving video with one transform pooled over the whole window: a model
that drifts inside a window (SCAIL-2 warming up, then staying warm while the driving video cooled again) kept the drift,
and the window after, held to the clip before's last frame, carried it on (Timeline 8, 2026-10-21: 4 to 5 levels redder
than its driving video for all of its 5 s). Here each frame is matched to the reference at the same moment, both sides'
colour figures averaged over a second or so first: a slow drift is followed, a frame's own flicker is not added, and two
windows of one source meet on the same colours, both aiming at the same moment of it.

The figures are numpy (the tests run them without torch). The node converts the frames to Lab and back in torch, float32 on
their own device and a few frames at a time: numpy's float64 took 0.3 s a frame at 576x1024 and nearly 1 s at 1080p, minutes
on a long clip, for the same figures to a hundredth of a level. `rgb_to_lab` and `lab_to_rgb` stay as the reference for it.
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


# A step in a frame's mean Lab colour from the frame before this large is a jump, not a drift (a frame to the next moves by
# a level or two in a calm shot): the figures of the clip and of its reference are averaged on each side of it, never across
JUMP = 6.0

# Frames either side a step in the reference must hold for to be a cut: a driving video's flicker steps as far and comes back,
# and taken for cuts its steps went into the clip unaveraged
HOLD = 6

# Times the reference's own flicker around it a cut must stand out by, as well as by `JUMP`. A strongly flickering driving
# video (3 to 4 levels a frame, or a slower wander) holds a 6-level step for 6 frames now and then by chance, and each one
# taken for a cut stepped the clip by 10 to 20 levels where averaging kept it under 3. The flicker is each frame's distance
# from the median of the frames within 2 `hold` of it (a running median keeps a cut's step, so a cut nearby does not count
# as flicker), its median over the frames within 8 `hold`: a calm shot's cut of 6 levels stays one
NOISE = 6.0


def stretches(means, jump=JUMP, hold=1, noise=0.0):
    """
    Frames as runs between their jumps, read off each frame's mean: (first, past-the-last) pairs. With `hold`, a step is a
    jump only when the `hold` frames after it are that far from the `hold` frames before it too, by their medians (a flash
    of a frame or two does not move a median). With `noise`, both must also be `noise` times the flicker around it (see
    `NOISE`).
    """
    if not len(means):
        return [(0, 0)]
    m = np.asarray(means, dtype=np.float64).reshape(len(means), -1)
    n = len(m)
    flicker = None
    if noise:
        flicker = np.abs(m - np.array([np.median(m[max(0, j - 2 * hold) : j + 2 * hold + 1], axis=0) for j in range(n)]))

    def least(i):
        if flicker is None:
            return jump
        return max(jump, noise * np.median(flicker[max(0, i - 8 * hold) : i + 8 * hold], axis=0).max())

    def apart(a, b, by):
        return np.abs(a - b).max() > by

    def cut(i):
        if not apart(m[i], m[i - 1], jump):
            return False
        by = least(i)
        return apart(m[i], m[i - 1], by) and apart(np.median(m[i : i + hold], axis=0), np.median(m[max(0, i - hold) : i], axis=0), by)

    edges = [0, *[i for i in range(1, n) if cut(i)], n]
    return [(edges[k], edges[k + 1]) for k in range(len(edges) - 1)]


def smoothed_within(values, radius, runs):
    """`smoothed` on each run of rows on its own."""
    v = np.asarray(values, dtype=np.float64)
    out = np.empty_like(v)
    for a, b in runs:
        out[a:b] = smoothed(v[a:b], radius)
    return out


def follow_params(target_stats, ref_stats, radius, scale_most=2.0):
    """
    Per frame of the clip, the scale and offset (Lab) that bring its averaged colours to the reference's averaged ones at the
    same moment. `target_stats` and `ref_stats`: lists of (mean, std), one per frame of each. The clip's own figures are
    averaged within its runs between jumps: averaged across one, a first frame that already looked like its picture took the
    transform of the brighter frames after it (Timeline 7: an H3 take that left its start picture at its second frame, its
    first then darker and bluer than the picture, 39 for 55). The reference's jumps that hold (its cuts) split the runs too,
    and both sides are averaged within the same runs: a cut in the driving video averaged across became a second-long colour
    fade around it, whether the clip cut with it (its own side then split, the reference's not: a full fade) or kept its
    light.
    """
    n, m = len(target_stats), len(ref_stats)
    r_rows = [ref_stats[ref_index(i, n, m)] for i in range(n)]
    edges = sorted({e for a, b in stretches([s[0] for s in target_stats]) + stretches([s[0] for s in r_rows], hold=HOLD, noise=NOISE) for e in (a, b)})
    runs = list(zip(edges[:-1], edges[1:]))
    t_mean = smoothed_within([s[0] for s in target_stats], radius, runs)
    t_std = smoothed_within([s[1] for s in target_stats], radius, runs)
    r_mean = smoothed_within([s[0] for s in r_rows], radius, runs)
    r_std = smoothed_within([s[1] for s in r_rows], radius, runs)
    scale = np.clip(r_std / np.maximum(t_std, 1e-6), 1 / scale_most, scale_most)
    offset = r_mean - scale * t_mean
    return scale, offset


def apply_follow(rgb, scale, offset, strength=1.0):
    """One frame moved by its scale and offset in Lab, `strength` of the way."""
    lab = rgb_to_lab(np.asarray(rgb, dtype=np.float64))
    moved = lab * scale + offset
    return lab_to_rgb(lab + strength * (moved - lab))


def _torch_lab(torch, rgb):
    """`rgb_to_lab` in torch, on the frames' own device and dtype: (..., 3) in 0..1."""
    m = torch.tensor(_M.T / _WHITE, dtype=rgb.dtype, device=rgb.device)
    c = rgb.clamp(0, 1)
    lin = torch.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    xyz = lin @ m
    # torch has no cube root; xyz is not negative from clamped colours, and its branch below the threshold is linear anyway
    f = torch.where(xyz > _EPS, xyz.clamp_min(0) ** (1 / 3), (_KAPPA * xyz + 16) / 116)
    return torch.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], dim=-1)


def _torch_rgb(torch, lab):
    """`lab_to_rgb` in torch."""
    m = torch.tensor(_WHITE[:, None] * _M_INV.T, dtype=lab.dtype, device=lab.device)
    fy = (lab[..., 0] + 16) / 116
    f = torch.stack([fy + lab[..., 1] / 500, fy, fy - lab[..., 2] / 200], dim=-1)
    xyz = torch.where(f ** 3 > _EPS, f ** 3, (116 * f - 16) / _KAPPA)
    lin = (xyz @ m).clamp_min(0)
    return torch.where(lin <= 0.0031308, 12.92 * lin, 1.055 * lin.clamp_min(1e-12) ** (1 / 2.4) - 0.055).clamp(0, 1)


# Pixels converted at once: a few 1080p frames, so that the float32 copies a conversion makes stay a few hundred MB whatever
# the clip's length and size
_CHUNK_PIXELS = 1 << 23


def _chunks(frames, height, width):
    step = max(1, _CHUNK_PIXELS // max(1, height * width))
    return [(a, min(frames, a + step)) for a in range(0, frames, step)]


def torch_stats(torch, frames, step=4):
    """`frame_stats` of each frame of a (frames, H, W, 3) tensor, read in torch: a list of (mean[3], std[3]) as numpy."""
    small = frames[:, ::step, ::step, :3]
    out = []
    for a, b in _chunks(*small.shape[:3]):
        lab = _torch_lab(torch, small[a:b].float()).reshape(b - a, -1, 3)
        mean = lab.mean(dim=1)
        std = (lab - mean[:, None]).square().mean(dim=1).sqrt()
        out += list(zip(mean.double().cpu().numpy(), std.double().cpu().numpy()))
    return out


def torch_follow(torch, images, scale, offset, strength=1.0):
    """`apply_follow` on each frame of a (frames, H, W, 3) tensor by its row of `scale` and `offset`, on the frames' device."""
    out = torch.empty_like(images)
    for a, b in _chunks(*images.shape[:3]):
        s = torch.tensor(np.asarray(scale[a:b]), dtype=torch.float32, device=images.device)[:, None, None, :]
        o = torch.tensor(np.asarray(offset[a:b]), dtype=torch.float32, device=images.device)[:, None, None, :]
        lab = _torch_lab(torch, images[a:b].float())
        out[a:b] = _torch_rgb(torch, lab + strength * (lab * s + o - lab)).to(images.dtype)
    return out


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

        # Frames with an alpha channel (some loaders keep one) are taken as their colour: Lab is of three channels
        images = images[..., :3]
        with torch.no_grad():
            scale, offset = follow_params(torch_stats(torch, images), torch_stats(torch, reference), radius)
            return io.NodeOutput(torch_follow(torch, images, scale, offset, strength))

"""A clip's colours brought to a reference video's moment by moment, smoothed over time (Afflatus: Follow Colours).

Motion transfer matched a window's colours to its driving video with one transform pooled over the whole window: a model
that drifts inside a window (SCAIL-2 warming up, then staying warm while the driving video cooled again) kept the drift,
and the window after, held to the clip before's last frame, carried it on (Timeline 8, 2026-10-21: 4 to 5 levels redder
than its driving video for all of its 5 s). Here each frame is matched to the reference at the same moment, both sides'
colour figures averaged over a second or so first: a slow drift is followed, a frame's own flicker is not added, and two
windows of one source meet on the same colours, both aiming at the same moment of it.

The figures are numpy (the tests run them without torch). The node reads and moves the frames in torch, float32 on their own
device and a piece at a time (torch_follow): numpy's float64 took 0.3 s a frame at 576x1024 and nearly 1 s at 1080p, minutes
on a long clip, for the same figures to a hundredth of a level. `rgb_to_lab`, `lab_to_rgb` and `apply_follow` stay as the
reference for it.
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
# from the median of the frames within 2 `hold` of it and in its shot (see `GRAIN`; a running median keeps a cut's step,
# so a cut nearby does not count as flicker), its median over the frames within 8 `hold`: a calm shot's cut of 6 levels
# stays one. Each side of the step is also measured on its own and the larger taken (three quarters of it at least, the
# two sides' figures differing by chance even in one steady flicker): measured across both, a calm side set the bar near a
# flickering one where a flicker started or stopped, and its first steps were taken for cuts. The `hold` frames nearest
# the step on each side count as a side too, their flicker read off their frame-to-frame steps: within a second or two of
# a window's end one side is too short to count, and the other mostly holds frames from before the flicker started (or
# after it stopped), so a flicker starting in a window's last second or two was taken for cuts there, on the frames the
# next window is held to
NOISE = 6.0

# Times the grain of the shots on both sides a step between two runs of frames must stand out by for the flicker around it
# to be measured within each shot: a running median across a cut reads the cut as flicker, and a fast-cut driving video in a
# level of grain lost a third to most of its cuts. The grain is read off a run's frame-to-frame steps, which a cut the runs
# missed moves by one step of many. A flicker or a wander steps nearly as far within its runs as between them, and stays
# measured as one: at 3 times a wander's false cuts rose, and at 6 a montage in 1.5 levels of grain kept fewer cuts than
# before
GRAIN = 4.5

# A frame-to-frame step this small (in levels) is a frame shown again, not a step: a driving video of 5 or 6 frames a second
# brought to 16 by repeating its frames, or drawn on threes, steps by exactly nothing two times in three, and its grain read
# with those steps as calm, so its flicker was split into shots of a few frames and taken for cuts
HELD = 1e-3


def _grain(*runs, mean=False):
    """
    The flicker of runs of frames read off their frame-to-frame steps, as the flicker figure reads a steady grain (its median
    distance from its level), the largest of its channels: from the median step over the square root of 2, which a cut
    among the steps does not move, or with `mean` from the mean step (a steady grain's is 2 / sqrt(pi) times its spread),
    which a few frames give more surely (read off their median, a calm-looking handful let a flicker's step through, and a
    cut inside a flicker near the window's ends was lost more often). A held frame's step tells nothing and is left out
    (see `HELD`); frames that all hold read as calm.
    """
    d = np.abs(np.concatenate([np.diff(r, axis=0) for r in runs]))
    d = d[d.max(axis=1) > HELD]
    if not len(d):
        return 0.0
    return (np.mean(d, axis=0) * 0.6745 * np.sqrt(np.pi) / 2 if mean else np.median(d, axis=0) / np.sqrt(2)).max()


def _shots(m, jump, hold):
    """
    Each frame's shot, as (first, past-the-last): the frames between steps that hold (`stretches` without `noise`) and that
    stand out `GRAIN` times the grain of the runs on both sides of them. A run shorter than `hold` inside the clip has too
    few steps for a grain of its own, and merges both of its neighbours into one shot; within 2 `hold` of the clip's start
    or end, where a shot's flicker read across a cut set the bar near the end's few frames, its steps are judged instead by
    the runs past it on both sides and by its own frame-to-frame steps, read with any short runs next to it as one: a calm
    shot's insert of 4 or 5 frames is then a shot of its own, the few runs a cut inside a flicker breaks into split once
    at the cut, and a flicker that held a step here and there stays one (merged, two cuts 4 or 5 frames apart near a
    window's end were both lost, and a cut in a strong flicker 6 to 10 frames from it more often than before; judged so
    everywhere, a wander or a fade's few frames stood as shots and were cut). A run at the clip's start or end is short
    because the clip is, and the run beside it decides alone (a calm shot's cut 3 frames from the end, joined to the shot
    before, read as flicker there). A clip shorter than 2 `hold` has no such run on both sides of a step: its runs count
    from half its length, a single frame as calm. A frame in a shot shorter than `hold` is in the whole clip, but for one of
    4 or 5 frames or at either end of a clip of 4 `hold` or more: its flicker read within 1 to 3 frames, a flash or a fast
    strobe near the end stood as a shot and was cut, and a short clip's flicker was cut more often.
    """
    runs = stretches(m, jump, hold)
    n, need = len(m), min(hold, len(m) // 2)

    def grain(a, b):
        if b - a < need:
            if a == 0 or b == n:
                return 0.0
            return None if a < 2 * hold or b > n - 2 * hold else np.inf
        return _grain(m[a:b]) if b - a > 1 else 0.0

    # Each run's grain, None for a short one near the clip's ends; and each such one's own, read with its short neighbours
    known, own = [grain(a, b) for a, b in runs], [0.0] * len(runs)
    k = 0
    while k < len(runs):
        j = k
        while known[j] is None:
            j += 1
        if j > k:
            a, b = runs[k][0], runs[j - 1][1]
            own[k:j] = [_grain(m[a:b], mean=True)] * (j - k)
        k = j + 1

    def past(k, by):
        while known[k] is None:
            k += by
        return known[k]

    shots = [list(runs[0])]
    for k, (a, b) in enumerate(runs[1:], 1):
        step = np.abs(np.median(m[a : a + hold], axis=0) - np.median(m[max(0, a - hold) : a], axis=0)).max()
        if step > GRAIN * max(past(k - 1, -1), past(k, 1), own[k - 1], own[k]):
            shots.append([a, b])
        else:
            shots[-1][1] = b
    out = [(0, n)] * n
    for a, b in shots:
        if b - a >= need or n >= 4 * hold and (a == 0 or b == n or b - a >= hold - 2):
            out[a:b] = [(a, b)] * (b - a)
    return out


def stretches(means, jump=JUMP, hold=1, noise=0.0):
    """
    Frames as runs between their jumps, read off each frame's mean: (first, past-the-last) pairs. With `hold`, a step is a
    jump only when the `hold` frames after it are that far from the `hold` frames before it too, by their medians (a flash
    of a frame or two does not move a median). With `noise`, both must also be `noise` times the flicker around it (see
    `NOISE` and `GRAIN`).
    """
    if not len(means):
        return [(0, 0)]
    m = np.asarray(means, dtype=np.float64).reshape(len(means), -1)
    n = len(m)
    flicker = None
    if noise:
        shot = _shots(m, jump, hold)
        flicker = np.abs(m - np.array([np.median(m[max(j - 2 * hold, shot[j][0]) : min(j + 2 * hold + 1, shot[j][1])], axis=0) for j in range(n)]))

    def spread(a, b):
        return np.median(flicker[a:b], axis=0).max()

    def least(i):
        if flicker is None:
            return jump
        a, b = max(0, i - 8 * hold), min(n, i + 8 * hold)
        sides = [spread(x, y) for x, y in ((a, i), (i, b)) if y - x >= hold]
        # The frames nearest the step within its shots: a cut a few frames away read as flicker here
        lo, hi = shot[i - 1][0], shot[i][1]
        near = [x for x in (m[max(lo, i - hold) : i], m[i : min(hi, i + hold)]) if len(x) > 1]
        if near:
            sides.append(_grain(*near, mean=True))
        v = max([spread(a, b), *[0.75 * s for s in sides]])
        # A few frames' steps can read calm by chance: within `hold` of an end, where the next window is held to these
        # frames, the 2 `hold` nearest count as well (as they are: doubled below, a calm shot's 7-level cut on the last
        # frames was lost)
        wide = [x for x in (m[max(lo, i - 2 * hold) : i], m[i : min(hi, i + 2 * hold)]) if len(x) > 1] if min(i, n - i) < hold else []
        wide = 0.75 * _grain(*wide, mean=True) if wide else 0.0
        # Within 2 frames of either end a step has too few frames on that side to show it holds, and one taken for a cut there
        # left the window's end frames on the reference's raw flicker, where the window beside it is held to this one: it must
        # stand out twice as far (a calm shot's cut there still does)
        edge = 2 if min(i, n - i) < 3 else 1
        return max(jump, noise * max(edge * v, wide))

    def apart(a, b, by):
        return np.abs(a - b).max() > by

    def cut(i):
        if not apart(m[i], m[i - 1], jump):
            return False
        by = least(i)
        after, before = np.median(m[i : i + hold], axis=0), np.median(m[max(0, i - hold) : i], axis=0)
        if not (apart(m[i], m[i - 1], by) and apart(after, before, by)):
            return False
        if flicker is None or hold <= min(i, n - i):
            return True
        # Within `hold` of either end, every frame on the short side must lie past the middle of the step, on its own side:
        # a calm shot's cut there holds to the end, and a flicker's few frames fall back across it (its shot's frames: past a
        # cut nearer the end, they are another shot's)
        c = np.argmax(np.abs(after - before))
        short, own = (m[i : shot[i][1], c], after[c]) if n - i < hold else (m[shot[i - 1][0] : i, c], before[c])
        middle = (after[c] + before[c]) / 2
        return bool(np.all((short - middle) * (own - middle) > 0))

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


# Lab is linear in f, the cube roots of XYZ over the white (L = 116 fy - 16, a = 500 (fx - fy), b = 200 (fy - fz)): Lab = P f + q
_P = np.array([[0.0, 116.0, 0.0], [500.0, -500.0, 0.0], [0.0, 200.0, -200.0]])
_Q = np.array([-16.0, 0.0, 0.0])
_P_INV = np.linalg.inv(_P)


def follow_transforms(scale, offset, strength=1.0):
    """
    Per frame, the 3x3 `A` and the offset `c` with f' = A f + c: exactly Lab + strength (Lab scale + offset - Lab), as the
    scale and offset act on Lab and Lab is linear in f. Float64, (n, 3, 3) and (n, 3).
    """
    s = 1 + strength * (np.asarray(scale, dtype=np.float64) - 1)
    o = strength * np.asarray(offset, dtype=np.float64)
    a = _P_INV @ (s[:, :, None] * _P)
    c = (s * _Q + o - _Q) @ _P_INV.T
    return a, c


# Pixels of a frame moved at once by torch_follow: small enough that the conversion's float32 copies stay in the CPU's cache
_PIECE_PIXELS = 1 << 18


def torch_follow(torch, images, scale, offset, strength=1.0):
    """
    `apply_follow` on each frame of a (frames, H, W, 3) tensor by its row of `scale` and `offset`, on the frames' device.
    Lab is never made: the frame's scale, offset and strength act on f, between the two halves of the conversion, as one 3x3
    and an offset, on a piece of a frame at a time and in place. Converting to Lab and back over a few frames at once took
    43.7 ms a frame at 576x1024 and held a gigabyte of copies above the output; this takes 18.9, for the same frames to 2e-5
    (2026-10-22).
    """
    n, h, w = images.shape[:3]
    out = torch.empty((n, h, w, 3), dtype=images.dtype, device=images.device)
    a, c = follow_transforms(scale, offset, strength)
    at = torch.tensor(a.transpose(0, 2, 1), dtype=torch.float32, device=images.device)
    c = torch.tensor(c, dtype=torch.float32, device=images.device)
    to_xyz = torch.tensor(_M.T / _WHITE, dtype=torch.float32, device=images.device)
    to_rgb = torch.tensor(_WHITE[:, None] * _M_INV.T, dtype=torch.float32, device=images.device)
    dst = out.view(n, h * w, 3)
    for k in range(n):
        src = images[k].reshape(h * w, 3)
        for p in range(0, h * w, _PIECE_PIXELS):
            v = src[p : p + _PIECE_PIXELS].float().clamp(0, 1)
            lin = torch.where(v <= 0.04045, v / 12.92, v.add(0.055).div_(1.055).pow_(2.4))
            xyz = lin @ to_xyz
            # as _torch_lab: no cube root in torch, and xyz is not negative from clamped colours
            f = torch.where(xyz > _EPS, xyz.clamp_min(0).pow_(1 / 3), xyz.mul(_KAPPA).add_(16).div_(116))
            f = torch.addmm(c[k], f, at[k])
            f3 = f.pow(3)
            xyz = torch.where(f3 > _EPS, f3, f.mul_(116).sub_(16).div_(_KAPPA))
            lin = (xyz @ to_rgb).clamp_min_(0)
            rgb = torch.where(lin <= 0.0031308, lin * 12.92, lin.clamp_min(1e-12).pow_(1 / 2.4).mul_(1.055).sub_(0.055))
            dst[k, p : p + _PIECE_PIXELS] = rgb.clamp_(0, 1)
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

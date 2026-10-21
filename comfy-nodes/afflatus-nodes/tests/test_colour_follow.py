"""Afflatus: Follow Colours, on small numpy frames: no torch, no ComfyUI, no GPU."""

import numpy as np
from afflatus_nodes.colour_follow import apply_follow, follow_params, frame_stats, lab_to_rgb, ref_index, rgb_to_lab, smoothed


def clip(colours, size=16, noise=0.04, seed=0):
    """Frames of one colour each (RGB 0..1), with a fixed grain so their spread is not nothing."""
    rng = np.random.default_rng(seed)
    grain = rng.normal(0, noise, (size, size, 3))
    return [np.clip(np.array(c, dtype=np.float64) + grain, 0, 1) for c in colours]


def followed(target, ref, radius=8):
    scale, offset = follow_params([frame_stats(f, 1) for f in target], [frame_stats(f, 1) for f in ref], radius)
    return [apply_follow(f, scale[i], offset[i]) for i, f in enumerate(target)]


def lab_mean(frames):
    return np.array([rgb_to_lab(f).reshape(-1, 3).mean(axis=0) for f in frames])


def test_lab_goes_there_and_back():
    rgb = np.random.default_rng(1).random((8, 8, 3))
    assert np.abs(lab_to_rgb(rgb_to_lab(rgb)) - rgb).max() < 1e-6


def test_smoothing_follows_a_line_to_the_ends_and_averages_out_a_flicker():
    assert np.allclose(smoothed([[1.0], [1.0], [1.0]], 2), 1.0)
    # a straight change read where it is, ends included (a mean read the last row as one of the middle)
    assert np.allclose(smoothed([[float(i)] for i in range(10)], 3)[:, 0], np.arange(10))
    # a frame's flicker, averaged out
    assert np.abs(smoothed([[0.0], [3.0], [0.0], [3.0], [0.0], [3.0], [0.0]], 3)[3, 0] - 1.29).max() < 0.05
    assert np.allclose(smoothed([[0.0], [3.0]], 0)[:, 0], [0.0, 3.0])


def test_a_reference_frame_is_taken_at_the_same_moment():
    assert [ref_index(i, 5, 9) for i in range(5)] == [0, 2, 4, 6, 8]
    assert ref_index(3, 4, 1) == 0


def test_a_drift_inside_the_clip_is_followed_back_to_the_reference():
    # the clip warms up halfway and stays warm (SCAIL-2 on Timeline 8), its reference stays as it was
    target = clip([(0.45, 0.40, 0.42)] * 16 + [(0.55, 0.40, 0.36)] * 16)
    ref = clip([(0.45, 0.40, 0.42)] * 32, seed=1)
    out = lab_mean(followed(target, ref, radius=2))
    want = lab_mean(ref)
    # away from the change itself (its averaging stretch), every frame on the reference's colours
    assert np.abs(out[:12] - want[:12]).max() < 1.0
    assert np.abs(out[20:] - want[20:]).max() < 1.0
    # pooled over the whole clip, as before, the second half stayed warm by several levels
    assert np.abs(lab_mean(target)[20:, 1] - want[20:, 1]).max() > 4


def test_a_reference_that_flickers_adds_no_flicker():
    rng = np.random.default_rng(2)
    target = clip([(0.5, 0.45, 0.4)] * 32)
    ref = clip([(0.5 + d, 0.45 + d, 0.4 + d) for d in rng.normal(0, 0.03, 32)], seed=3)
    out = lab_mean(followed(target, ref))
    ref_l = lab_mean(ref)[:, 0]
    # frame to frame, the clip's lightness moves far less than its reference's does
    assert np.abs(np.diff(out[:, 0])).mean() < 0.25 * np.abs(np.diff(ref_l)).mean()


def test_two_clips_of_one_reference_meet_on_its_colours():
    # one reference cooling slowly; the clip before came out warm, the clip after cool: matched, they meet at the join
    ref = clip([(0.5 - 0.004 * i, 0.45, 0.4 + 0.004 * i) for i in range(64)], seed=4)
    before = followed(clip([(0.6, 0.42, 0.35)] * 32, seed=5), ref[:32])
    after = followed(clip([(0.4, 0.45, 0.5)] * 32, seed=6), ref[32:])
    step = np.abs(lab_mean(before)[-1] - lab_mean(after)[0]).max()
    assert step < 2.0
    # as made, they stepped by far more
    assert np.abs(lab_mean(clip([(0.6, 0.42, 0.35)], seed=5))[0] - lab_mean(clip([(0.4, 0.45, 0.5)], seed=6))[0]).max() > 10

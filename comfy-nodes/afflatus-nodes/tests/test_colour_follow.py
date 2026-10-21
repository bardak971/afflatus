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


def test_a_jump_inside_the_clip_is_not_averaged_across():
    from afflatus_nodes.colour_follow import stretches

    # an opening frame that is its picture, then the model's own frames far brighter (Timeline 7): two runs
    picture = clip([(0.30, 0.25, 0.35)], seed=7)
    target = clip([(0.30, 0.25, 0.35)] + [(0.60, 0.52, 0.48)] * 23, seed=8)
    assert stretches([frame_stats(f, 1)[0] for f in target]) == [(0, 1), (1, 24)]
    out = lab_mean(followed(target, picture, radius=8))
    want = lab_mean(picture)[0]
    # the opening stays the picture's, the rest is brought to it too
    assert np.abs(out[0] - want).max() < 1.0
    assert np.abs(out[4:] - want).max() < 1.0
    # a calm clip is one run
    assert stretches([frame_stats(f, 1)[0] for f in clip([(0.5, 0.45, 0.4 + 0.002 * i) for i in range(20)])]) == [(0, 20)]


def test_a_cut_in_the_reference_is_a_hard_change_whether_or_not_the_clip_cuts_with_it():
    # a driving video with a hard cut at frame 20, bright to dark and blue (Motion transfer on an edited video)
    ref = clip([(0.80, 0.80, 0.80)] * 20 + [(0.20, 0.20, 0.30)] * 20, seed=9)
    want = lab_mean(ref)
    # the clip cuts with it (a little warmer than it throughout), or keeps its own light across it
    shared = clip([(0.84, 0.80, 0.76)] * 20 + [(0.21, 0.20, 0.28)] * 20, seed=10)
    steady = clip([(0.60, 0.55, 0.50)] * 40, seed=11)
    for target in (shared, steady):
        out = lab_mean(followed(target, ref))
        # right up to the cut and right after it, each frame on its own shot's colours: no second-long fade between the two
        assert np.abs(out - want).max() < 1.0


# The node's own path, in torch float32, against the numpy float64 figures above. The tests' torch is a stand-in, so this runs
# in a fresh interpreter, and only where a real torch is installed (ComfyUI's own venv).
_TORCH_CHECK = r"""
import importlib.util, sys, types
import numpy as np
import torch

io = types.SimpleNamespace(ComfyNode=object, Schema=object, NodeOutput=lambda x: x)
sys.modules["comfy_api"] = types.ModuleType("comfy_api")
sys.modules["comfy_api.latest"] = types.SimpleNamespace(io=io)
spec = importlib.util.spec_from_file_location("colour_follow", sys.argv[1])
cf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cf)
# small chunks, so that the frames are converted over several of them
cf._CHUNK_PIXELS = 3 * 40 * 48

rng = np.random.default_rng(0)
images = rng.random((7, 40, 48, 3)) * np.linspace(0.3, 1.0, 7)[:, None, None, None]
reference = rng.random((5, 24, 32, 3)) * 0.8
# figures read off the frames: the same to a hundredth of a level
for frames in (images, reference):
    got = cf.torch_stats(torch, torch.from_numpy(frames.astype(np.float32)))
    want = [cf.frame_stats(f) for f in frames]
    for (gm, gs), (wm, ws) in zip(got, want):
        assert np.abs(gm - wm).max() < 0.01 and np.abs(gs - ws).max() < 0.01, (gm, wm, gs, ws)
scale, offset = cf.follow_params([cf.frame_stats(f) for f in images], [cf.frame_stats(f) for f in reference], 2)
out = cf.AfflatusColorFollow.execute(torch.from_numpy(images.astype(np.float32)), torch.from_numpy(reference.astype(np.float32)), 2, 0.8)
assert out.dtype == torch.float32 and tuple(out.shape) == images.shape
want = np.stack([cf.apply_follow(images[i], scale[i], offset[i], 0.8) for i in range(len(images))])
assert np.abs(out.numpy() - want).max() < 2e-4, np.abs(out.numpy() - want).max()
print("same")
"""


def test_the_nodes_torch_conversion_gives_the_numpy_figures():
    import os
    import subprocess
    import sys

    import pytest

    if subprocess.run([sys.executable, "-I", "-c", "import torch"], capture_output=True).returncode != 0:
        pytest.skip("no torch here: ComfyUI's own venv runs this")
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(os.path.dirname(here), "colour_follow.py")
    run = subprocess.run([sys.executable, "-I", "-c", _TORCH_CHECK, path], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0 and "same" in run.stdout, run.stderr[-2000:]


def test_a_flash_in_the_reference_is_not_a_cut_and_a_cut_is():
    from afflatus_nodes.colour_follow import HOLD, stretches

    # a frame of a flash, then the shot as it was: averaged over like a flicker, not followed into the clip
    flash = clip([(0.4, 0.4, 0.4)] * 10 + [(0.9, 0.9, 0.9)] + [(0.4, 0.4, 0.4)] * 10, seed=12)
    assert stretches([frame_stats(f, 1)[0] for f in flash], hold=HOLD) == [(0, 21)]
    cut = clip([(0.4, 0.4, 0.4)] * 10 + [(0.9, 0.9, 0.9)] * 3, seed=13)
    assert stretches([frame_stats(f, 1)[0] for f in cut], hold=HOLD) == [(0, 10), (10, 13)]
    # the clip's own side splits at any step, as it did
    assert stretches([frame_stats(f, 1)[0] for f in flash]) == [(0, 10), (10, 11), (11, 21)]

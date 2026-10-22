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
# frames with an alpha channel: followed by their colour, as the same frames without it
rgba = np.concatenate([images, np.ones(images.shape[:3] + (1,))], axis=-1).astype(np.float32)
out4 = cf.AfflatusColorFollow.execute(torch.from_numpy(rgba), torch.from_numpy(reference.astype(np.float32)), 2, 0.8)
assert tuple(out4.shape) == images.shape and np.abs(out4.numpy() - out.numpy()).max() < 1e-6
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


def flicker(frames, sd, seed, ar=0.0):
    """A driving video's grey flicker, frame by frame (RGB shares): white, or wandering from frame to frame by `ar`."""
    rng = np.random.default_rng(seed)
    out = rng.normal(0, sd, frames)
    for i in range(1, frames):
        out[i] = ar * out[i - 1] + np.sqrt(1 - ar * ar) * out[i]
    return out


def test_a_long_strongly_flickering_reference_steps_the_clip_at_no_frame():
    # 241 frames of a steady clip against a driving video flickering by 4 levels a frame, or wandering by 3: by chance its
    # flicker holds a 6-level step for 6 frames here and there, and each one taken for a cut stepped the clip by 10 to 20
    # levels at once. The worst step is what shows, not the mean of them: one hard step in 240 moves a mean by little
    target = clip([(0.5, 0.45, 0.4)] * 241)
    for sd, ar in ((0.04, 0.0), (0.03, 0.7)):
        for seed in range(4):
            ref = clip([(0.5 + d, 0.45 + d, 0.4 + d) for d in flicker(241, sd, 100 + seed, ar)], seed=3)
            worst = np.abs(np.diff(lab_mean(followed(target, ref))[:, 0])).max()
            assert worst < 3.0, (sd, ar, seed, worst)


def test_a_cut_stands_out_of_a_flickering_reference_and_a_calm_ones_soft_cut_stays_one():
    from afflatus_nodes.colour_follow import HOLD, NOISE, stretches

    def runs(shift, at, sd, seed):
        grey = flicker(241, sd, seed) - np.where(np.arange(241) >= at, shift, 0.0)
        frames = clip([(0.5 + g, 0.45 + g, 0.4 + g) for g in grey], seed=14)
        return stretches([frame_stats(f, 1)[0] for f in frames], hold=HOLD, noise=NOISE)

    for seed in range(4):
        # 8 levels down in a calm shot, near the start and in the middle; 15 down in a shot flickering by 2 levels a frame
        assert runs(0.08, 120, 0.005, 200 + seed) == [(0, 120), (120, 241)]
        assert runs(0.08, 3, 0.005, 210 + seed) == [(0, 3), (3, 241)]
        assert runs(0.15, 120, 0.02, 220 + seed) == [(0, 120), (120, 241)]


def test_a_flash_in_the_reference_is_not_a_cut_and_a_cut_is():
    from afflatus_nodes.colour_follow import HOLD, NOISE, stretches

    # a frame of a flash, then the shot as it was: averaged over like a flicker, not followed into the clip
    flash = clip([(0.4, 0.4, 0.4)] * 10 + [(0.9, 0.9, 0.9)] + [(0.4, 0.4, 0.4)] * 10, seed=12)
    assert stretches([frame_stats(f, 1)[0] for f in flash], hold=HOLD, noise=NOISE) == [(0, 21)]
    cut = clip([(0.4, 0.4, 0.4)] * 10 + [(0.9, 0.9, 0.9)] * 3, seed=13)
    assert stretches([frame_stats(f, 1)[0] for f in cut], hold=HOLD, noise=NOISE) == [(0, 10), (10, 13)]
    # the clip's own side splits at any step, as it did
    assert stretches([frame_stats(f, 1)[0] for f in flash]) == [(0, 10), (10, 11), (11, 21)]


def ref_cuts(grey):
    """Where Follow Colours cuts a driving video of one uniform colour moved by `grey` (RGB shares) frame by frame."""
    from afflatus_nodes.colour_follow import HOLD, NOISE, stretches

    means = [rgb_to_lab(np.array([0.5 + g, 0.45 + g, 0.4 + g])) for g in grey]
    return [a for a, b in stretches(means, hold=HOLD, noise=NOISE)][1:]


def test_a_flicker_that_starts_or_stops_inside_the_window_is_no_cut():
    # A calm shot that starts flickering by 3 to 6 levels a frame at frame 60, 120 or 180, or a flickering one that calms
    # down there: measured across both, the calm side set the bar near the flickering one, and its first steps were cuts
    for sd in (0.03, 0.04, 0.06):
        for at in (60, 120, 180):
            for seed in range(4):
                calm, strong = flicker(241, 0.005, 300 + seed), flicker(241, sd, 310 + seed)
                starts = np.concatenate([calm[:at], strong[at:]])
                stops = np.concatenate([strong[:at], calm[at:]])
                assert ref_cuts(starts) == [], (sd, at, seed, "starts")
                assert ref_cuts(stops) == [], (sd, at, seed, "stops")


def test_a_steady_flicker_or_wander_of_1_to_6_levels_is_no_cut():
    for sd in (0.01, 0.02, 0.03, 0.04, 0.06):
        for ar in (0.0, 0.7):
            for seed in range(3):
                assert ref_cuts(flicker(241, sd, 320 + seed, ar)) == [], (sd, ar, seed)


def test_a_calm_fast_cut_montage_keeps_its_cuts():
    # Shots of 6 to 12 frames, each 8 to 10 levels from the one before: the 2 `hold` running median spans two or three of
    # them and read their cuts as flicker, and a montage cut every 7 to 12 frames lost every cut
    rng = np.random.default_rng(330)
    for gap in (6, 7, 8, 10, 12, None):
        kept = total = 0
        for seed in range(4):
            lengths = rng.integers(6, 13, 40) if gap is None else [gap] * 40
            ats = [a for a in np.cumsum(lengths) if a < 241]
            level, grey = 0.0, np.zeros(241)
            for a in ats:
                # 0.08 to 0.1 of RGB: 8 to 10 levels; up from below the middle, down from above it
                level += rng.uniform(0.08, 0.1) * (1 if level <= 0 else -1)
                grey[a:] = level
            got = ref_cuts(grey + flicker(241, 0.005, 340 + seed))
            kept += sum(a in got for a in ats)
            total += len(ats)
        assert kept >= 0.9 * total, (gap, kept, total)


def test_a_calm_shots_cuts_near_the_ends_and_6_frames_apart_stay_cuts():
    # 7 to 12 levels (a 6-level one is at `JUMP` itself, kept or not by the shot's grain as before)
    for size in (0.07, 0.08, 0.12):
        for seed in range(3):
            calm = flicker(241, 0.005, 350 + seed)
            for at in (1, 2, 3, 6, 235, 238, 239, 240):
                assert ref_cuts(calm - np.where(np.arange(241) >= at, size, 0.0)) == [at], (size, at, seed)
            for at in (3, 100, 232):
                shot = np.where((np.arange(241) >= at) & (np.arange(241) < at + 6), size, 0.0)
                assert ref_cuts(calm - shot) == [at, at + 6], (size, at, seed)


def test_a_flicker_step_in_a_windows_last_frames_is_no_cut():
    # By chance its last two frames stood out of a 4-level flicker: taken for a cut, they kept the reference's raw flicker
    # where the next window is held to this one
    assert ref_cuts(np.random.default_rng(78159).normal(0, 0.04, 241)) == []


def test_a_10_level_cut_in_a_2_level_flicker_is_kept_as_often_as_before():
    # 0.36.1 kept it 24 times in these 40; the rules for montages and for a flicker that starts must not lose more of them
    kept = sum(ref_cuts(flicker(241, 0.02, 500 + seed) - np.where(np.arange(241) >= 120, 0.1, 0.0)) == [120] for seed in range(40))
    assert kept >= 24, kept

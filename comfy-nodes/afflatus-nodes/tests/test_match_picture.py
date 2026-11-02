"""Afflatus: Match Picture Colours, on small numpy pictures: no torch, no ComfyUI, no GPU (card #222)."""

import numpy as np
from afflatus_nodes.colour_follow import PICTURE_SPREAD_MOST, PICTURE_TINT_MOST, apply_follow, frame_stats, picture_params, rgb_to_lab


def picture(colour, size=24, noise=0.04, seed=0):
    rng = np.random.default_rng(seed)
    return np.clip(np.array(colour, dtype=np.float64) + rng.normal(0, noise, (size, size, 3)), 0, 1)


def matched(image, reference):
    scale, offset = picture_params([frame_stats(image, 1)], [frame_stats(reference, 1)])
    return apply_follow(image, scale, offset)


def lab(image):
    flat = rgb_to_lab(image).reshape(-1, 3)
    return flat.mean(axis=0), flat.std(axis=0)


def test_a_dark_neutral_picture_takes_a_bright_warm_frames_light():
    # the owner's case: a night selfie (dark, neutral) given beside a sunny beach's frame (bright, warm)
    selfie, beach = picture([0.22, 0.22, 0.23], noise=0.05), picture([0.78, 0.70, 0.52], noise=0.07, seed=1)
    (m, s), (want_m, want_s) = lab(matched(selfie, beach)), lab(beach)
    assert abs(m[0] - want_m[0]) < 1.0
    # its colour moved towards the beach's, as far as the tint may go
    before = lab(selfie)[0]
    assert np.all(np.abs(m[1:] - want_m[1:]) < np.abs(before[1:] - want_m[1:]))
    assert abs(s[0] / lab(selfie)[1][0] - min(PICTURE_SPREAD_MOST, want_s[0] / lab(selfie)[1][0])) < 0.1


def test_a_picture_already_in_the_frames_light_stays_as_it_is():
    a = picture([0.6, 0.5, 0.4])
    b = picture([0.6, 0.5, 0.4], seed=3)
    assert np.abs(matched(a, b) - a).max() < 0.02


def test_the_spread_and_the_tint_are_bounded():
    flat, busy = picture([0.5, 0.5, 0.5], noise=0.01), picture([0.5, 0.5, 0.5], noise=0.2, seed=2)
    scale, _ = picture_params([frame_stats(flat, 1)], [frame_stats(busy, 1)])
    assert np.allclose(scale, PICTURE_SPREAD_MOST)
    scale, _ = picture_params([frame_stats(busy, 1)], [frame_stats(flat, 1)])
    assert np.allclose(scale, 1 / PICTURE_SPREAD_MOST)
    # a frame filled by a lawn's green: the face's colour moves 12 levels its way, its lightness all the way
    face, lawn = picture([0.75, 0.58, 0.48]), picture([0.15, 0.6, 0.12], seed=4)
    (m, _s), before, (want, _w) = lab(matched(face, lawn)), lab(face)[0], lab(lawn)
    assert abs(m[0] - want[0]) < 1.0
    moved = m[1:] - before[1:]
    assert np.all(np.abs(moved) <= PICTURE_TINT_MOST + 0.5) and np.abs(moved).max() > PICTURE_TINT_MOST - 1.5


def test_several_reference_frames_are_read_together():
    image = picture([0.3, 0.3, 0.3])
    dark, bright = picture([0.2, 0.2, 0.2], seed=5), picture([0.8, 0.8, 0.8], seed=6)
    one = picture_params([frame_stats(image, 1)], [frame_stats(dark, 1), frame_stats(bright, 1)])
    mean = [(frame_stats(dark, 1)[k] + frame_stats(bright, 1)[k]) / 2 for k in (0, 1)]
    both = picture_params([frame_stats(image, 1)], [tuple(mean)])
    assert np.allclose(one[0], both[0]) and np.allclose(one[1], both[1])


# The node's own path, in torch float32, against the numpy figures above. The tests' torch is a stand-in, so this runs in a
# fresh interpreter, and only where a real torch is installed (ComfyUI's own venv).
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

rng = np.random.default_rng(0)
image = (rng.random((1, 40, 32, 3)) * 0.3).astype(np.float32)
reference = (0.4 + rng.random((1, 48, 64, 3)) * 0.6).astype(np.float32)
scale, offset = cf.picture_params([cf.frame_stats(image[0])], [cf.frame_stats(reference[0])])
out = cf.AfflatusMatchPicture.execute(torch.from_numpy(image), torch.from_numpy(reference), 1.0)
assert out.dtype == torch.float32 and tuple(out.shape) == image.shape
want = cf.apply_follow(image[0], scale, offset)
assert np.abs(out.numpy()[0] - want).max() < 2e-3, np.abs(out.numpy()[0] - want).max()
# a picture with an alpha channel (LoadImage of a PNG keeps it in its mask, some loaders in the image): moved by its colour
rgba = np.concatenate([image, np.ones(image.shape[:3] + (1,), dtype=np.float32)], axis=-1)
out4 = cf.AfflatusMatchPicture.execute(torch.from_numpy(rgba), torch.from_numpy(reference), 1.0)
assert tuple(out4.shape) == image.shape and np.abs(out4.numpy() - out.numpy()).max() < 1e-6
# strength 0: the picture as it was
out0 = cf.AfflatusMatchPicture.execute(torch.from_numpy(image), torch.from_numpy(reference), 0.0)
assert np.abs(out0.numpy() - image).max() < 2e-4
print("same")
"""


def test_the_nodes_torch_path_gives_the_numpy_figures():
    import os
    import subprocess
    import sys

    import pytest

    if subprocess.run([sys.executable, "-I", "-c", "import torch"], capture_output=True).returncode != 0:
        pytest.skip("no torch here: ComfyUI's own venv runs this")
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(os.path.dirname(here), "colour_follow.py")
    run = subprocess.run([sys.executable, "-I", "-c", _TORCH_CHECK, path], capture_output=True, text=True, timeout=120, env={**os.environ, "CUDA_VISIBLE_DEVICES": "-1"})
    assert run.returncode == 0 and "same" in run.stdout, run.stderr[-2000:]

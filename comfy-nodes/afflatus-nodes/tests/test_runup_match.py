"""Afflatus: H3 Run-up Match: its figures on numpy arrays, its checks on stand-in tensors, the node itself with the real torch."""

import json
import os

import numpy as np
import pytest
import safetensors.torch
from conftest import av, with_torch

from afflatus_nodes.latent_io import (
    RUNUP_KEY,
    AfflatusH3RunUpMatch,
    AfflatusLoadH3Latent,
    AfflatusNormalizeH3Latent,
    AfflatusSaveH3Latent,
    runup_match,
)

CHANNELS = 24


def tail(seed=0, n=7 * 32):
    """The clip before's last tokens, each channel flattened: a spread of about 1.1 and a mean of its own, as H3's."""
    rng = np.random.default_rng(seed)
    return rng.normal(rng.normal(0, 0.3, (CHANNELS, 1)), 1.1, (CHANNELS, n))


def bias():
    """The per-channel mean bias seen at every hop (2026-10-05): channels 14/15 +0.06, 22 -0.09, the rest a little."""
    b = np.linspace(-0.02, 0.02, CHANNELS)
    b[14] = b[15] = 0.06
    b[22] = -0.09
    return b[:, None]


def applied(match, values):
    return values * match.scale[:, None] + match.offset[:, None]


def test_a_run_up_wider_than_its_tail_and_biased_is_brought_back_to_it():
    a = tail()
    noise = np.random.default_rng(1).normal(0, 0.03, a.shape)
    # the sampler's copy: 3.5 % wider in every channel, the same biases, a little of its own
    r = a * 1.035 + bias() + noise
    match = runup_match(a, r)
    assert match.why is None
    assert match.width == pytest.approx(1.035, abs=0.003)
    assert match.correlation > 0.999
    fixed = applied(match, r)
    # matched: the run-up's spread and mean are the tail's, channel by channel
    assert np.abs(fixed.std(axis=1) / a.std(axis=1) - 1).max() < 0.002
    assert np.abs(fixed.mean(axis=1) - a.mean(axis=1)).max() < 1e-9
    assert runup_match(a, fixed).width == pytest.approx(1.0, abs=0.002)
    # still as close a copy: the correction is the same line for every token of a channel
    assert runup_match(a, fixed).correlation == pytest.approx(match.correlation, abs=1e-4)


def test_the_windows_own_part_loses_the_same_gain():
    a = tail()
    r = a * 1.035 + bias()
    own = tail(seed=5) * 1.035 + bias()
    match = runup_match(a, r)
    # what the sampler made wider is put back: the own part's spread is the one it had before the gain
    assert np.abs(applied(match, own).std(axis=1) / tail(seed=5).std(axis=1) - 1).max() < 1e-9


def test_a_run_up_that_is_not_a_copy_is_left_as_sampled():
    # a cut: the window left its guide, there is nothing to match and a new shot's look must not be pulled to the old one's
    match = runup_match(tail(), tail(seed=9))
    assert match.scale is None and match.offset is None
    assert "not a copy" in match.why and abs(match.correlation) < 0.2


@pytest.mark.parametrize("gain", [0.85, 1.15])
def test_a_gain_past_what_the_sampler_adds_is_left_as_sampled(gain):
    a = tail()
    match = runup_match(a, a * gain)
    assert match.scale is None and "outside" in match.why
    assert match.width == pytest.approx(gain)


def test_one_channel_past_the_bound_leaves_the_whole_window_as_sampled():
    a = tail()
    r = a * 1.03
    r[3] = a[3] * 1.2
    assert runup_match(a, r).scale is None


def test_a_mean_far_off_the_tails_is_left_as_sampled():
    a = tail()
    r = a.copy()
    r[7] += 0.3
    match = runup_match(a, r)
    assert match.scale is None and "mean" in match.why


def test_a_flat_channel_is_left_as_sampled():
    a = tail()
    a[0] = 0.5
    match = runup_match(a, a.copy())
    assert match.scale is None and "flat" in match.why


def test_the_node_refuses_what_the_seam_would_refuse():
    with pytest.raises(ValueError, match="fewer than"):
        AfflatusH3RunUpMatch.execute(av(5, "before"), av(73, "window"), 22)
    with pytest.raises(ValueError, match="no new frames"):
        AfflatusH3RunUpMatch.execute(av(73, "before"), av(22, "window"), 22)
    with pytest.raises(ValueError, match="same size"):
        AfflatusH3RunUpMatch.execute(av(73, "before", width=8), av(73, "window"), 22)


def test_the_width_as_sampled_goes_into_the_kept_latents_metadata_and_back(folders):
    window = {**av(73, "window"), RUNUP_KEY: 1.0347}
    # Normalize passes it on (it builds a dict of its own), Save writes it
    normalized = AfflatusNormalizeH3Latent.execute(window).args[0]
    assert normalized[RUNUP_KEY] == 1.0347
    (saved,) = AfflatusSaveH3Latent.execute(normalized, "Afflatus/h3").ui["latents"]
    path = os.path.join(folders.temp, saved["subfolder"], saved["filename"])
    assert safetensors.torch.saved[path][1]["runup_width"] == "1.0347"
    # a latent without it (a first clip, an older pack's window) writes none
    (plain,) = AfflatusSaveH3Latent.execute(AfflatusNormalizeH3Latent.execute(av(22, "clip")).args[0], "Afflatus/h3x").ui["latents"]
    path = os.path.join(folders.temp, plain["subfolder"], plain["filename"])
    assert "runup_width" not in safetensors.torch.saved[path][1]
    # a finish loads the draft's latent: the figure comes back with it, read from the file's header
    file = os.path.join(folders.input, "kept.safetensors")
    head = json.dumps({"__metadata__": {"format": "afflatus-h3-av-latent/1", "frames": "73", "runup_width": "1.0347"}}).encode()
    with open(file, "wb") as f:
        f.write(len(head).to_bytes(8, "little") + head)
    streams = av(73, "kept")["samples"].tensors
    safetensors.torch.saved[file] = ({"video": streams[0], "audio": streams[1]}, None)
    assert AfflatusLoadH3Latent.execute("kept.safetensors").args[0][RUNUP_KEY] == pytest.approx(1.0347)
    # and none from a file without it
    safetensors.torch.saved[path] = ({"video": streams[0], "audio": streams[1]}, None)
    assert RUNUP_KEY not in AfflatusLoadH3Latent.execute(os.path.relpath(path, folders.temp).replace(os.sep, "/") + " [temp]").args[0]


def test_the_node_matches_the_window_and_leaves_its_sound_alone_with_the_real_torch():
    out = with_torch(
        r"""
import json

nested = types.ModuleType("comfy.nested_tensor")


class NestedTensor:
    def __init__(self, tensors):
        self.tensors = list(tensors)


nested.NestedTensor = NestedTensor
sys.modules.update({"comfy": types.ModuleType("comfy"), "comfy.nested_tensor": nested})
for name in ("comfy.utils", "folder_paths", "node_helpers", "safetensors", "safetensors.torch"):
    sys.modules.setdefault(name, types.ModuleType(name))
pack = types.ModuleType("pack")
pack.__path__ = [sys.argv[1]]
sys.modules["pack"] = pack
for name in ("continuation_nodes", "latent_io"):
    spec = importlib.util.spec_from_file_location("pack." + name, os.path.join(sys.argv[1], name + ".py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules["pack." + name] = module
    spec.loader.exec_module(module)
latent_io = sys.modules["pack.latent_io"]
torch.manual_seed(0)
prev = torch.randn(1, 24, 22, 6, 8) * 1.1
bias = torch.linspace(-0.05, 0.05, 24).view(1, 24, 1, 1, 1)
# the window: its 7-token run-up the clip before's last 7, 3.5 % wider and biased; then 15 tokens of its own
run_up = prev[:, :, -7:] * 1.035 + bias + torch.randn(1, 24, 7, 6, 8) * 0.02
video = torch.cat([run_up, torch.randn(1, 24, 15, 6, 8) * 1.1 * 1.035 + bias], dim=2)
audio = torch.randn(1, 32, 2, 120)
window = {"samples": NestedTensor((video, audio)), "noise_mask": "kept"}
out = latent_io.AfflatusH3RunUpMatch.execute({"samples": NestedTensor((prev, torch.randn(1, 32, 2, 120)))}, window, 22)
v, a = out["samples"].tensors


def channels(x):
    return x.transpose(0, 1).reshape(24, -1)


spread = channels(v[:, :, :7]).std(dim=1, unbiased=False) / channels(prev[:, :, -7:]).std(dim=1, unbiased=False)
mean = channels(v[:, :, :7]).mean(dim=1) - channels(prev[:, :, -7:]).mean(dim=1)
print(json.dumps({
    "shape": list(v.shape), "dtype": str(v.dtype), "same_audio": a is audio, "noise_mask": out.get("noise_mask"),
    "width": out[latent_io.RUNUP_KEY], "spread": [float(spread.min()), float(spread.max())], "mean": float(mean.abs().max()),
    "own": float((v[:, :, 7:] - video[:, :, 7:]).abs().max()),
}))
# a cut: the window's run-up is not the clip before's tail; left as it was sampled, its width still said
other = torch.randn(1, 24, 22, 6, 8)
cut = latent_io.AfflatusH3RunUpMatch.execute({"samples": NestedTensor((prev, audio))}, {"samples": NestedTensor((other, audio))}, 22)
print(json.dumps({"cut_same": cut["samples"].tensors[0] is other, "cut_width": cut[latent_io.RUNUP_KEY]}))
""",
        needs=("torch", "numpy"),
    )
    # (the node's own line, saying why the cut was left as sampled, is printed between them)
    first, second = (json.loads(line) for line in out.splitlines() if line.startswith("{"))
    assert "left as sampled, the run-up is not a copy" in out
    assert first["shape"] == [1, 24, 22, 6, 8] and first["dtype"] == "torch.float32"
    # the sound is the window's own tensor, untouched; the window's other entries are kept
    assert first["same_audio"] is True and first["noise_mask"] == "kept"
    assert first["width"] == pytest.approx(1.035, abs=0.005)
    # the run-up on the tail's spread and mean in every channel; the own part corrected too
    assert 0.999 < first["spread"][0] <= first["spread"][1] < 1.001
    assert first["mean"] < 1e-4
    assert first["own"] > 0.01
    assert second["cut_same"] is True and second["cut_width"] == pytest.approx(1.0, abs=0.1)

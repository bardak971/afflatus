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
    detail_and_broad,
    runup_match,
)

CHANNELS = 24


def tail(seed=0, n=7):
    """The clip before's last tokens [channels, n, 8, 12]: a broad picture (a smooth field) and fine detail over it, a
    spread of about 1.1 and a mean of its own per channel, as H3's."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:8, 0:12]
    phase = rng.uniform(0, 2 * np.pi, (CHANNELS, n, 1, 1))
    broad = np.sin(x / 3.0 + phase) + np.cos(y / 2.5 + phase)
    return rng.normal(0, 0.3, (CHANNELS, 1, 1, 1)) + 0.7 * broad + rng.normal(0, 0.5, (CHANNELS, n, 8, 12))


def bias():
    """The per-channel mean bias seen at every hop (2026-10-05): channels 14/15 +0.06, 22 -0.09, the rest a little."""
    b = np.linspace(-0.02, 0.02, CHANNELS)
    b[14] = b[15] = 0.06
    b[22] = -0.09
    return b[:, None, None, None]


def sampled(values, detail=1.03, start=1.02):
    """What the sampler makes of `values`: its fine detail grown by `detail` (the creep), the whole `start` wider (the
    excess a window starts with, which does not build up), the per-channel biases."""
    d, b = detail_and_broad(values)
    return (b + d * detail) * start + bias()


def applied(match, values):
    d, b = detail_and_broad(values)
    return b + d * match.scale[:, None, None, None]


def spreads(values):
    d, b = detail_and_broad(values)
    return d.reshape(CHANNELS, -1).std(axis=1), b.reshape(CHANNELS, -1).std(axis=1)


def test_the_fine_details_growth_past_the_broad_pictures_is_read_and_taken_back():
    a = tail()
    noise = np.random.default_rng(1).normal(0, 0.02, a.shape)
    r = sampled(a) + noise
    match = runup_match(a, r)
    assert match.why is None
    assert match.gain.mean() == pytest.approx(1.03, abs=0.005)
    # the width as sampled is the plain spread as Afflatus reads it from two latents: the start excess, and some of the detail's
    assert 1.02 < match.width < 1.02 * 1.03
    assert match.correlation > 0.999
    fixed = applied(match, r)
    # the fine detail back on the broad picture's growth, the broad picture and the means as they were sampled
    assert runup_match(a, fixed).gain.mean() == pytest.approx(1.0, abs=0.005)
    (_d, b), (_fd, fb) = detail_and_broad(r), detail_and_broad(fixed)
    assert np.abs(fixed.mean(axis=(1, 2, 3)) - r.mean(axis=(1, 2, 3))).max() < 1e-9
    assert np.abs(fb.reshape(CHANNELS, -1).std(axis=1) / b.reshape(CHANNELS, -1).std(axis=1) - 1).max() < 0.01
    # still as close a copy
    assert runup_match(a, fixed).correlation == pytest.approx(match.correlation, abs=1e-3)


def test_a_window_only_wider_at_its_start_is_not_read_as_creep():
    # pack 0.45.0 took this excess for creep and shrank the whole window: a chain went softer and darker clip after clip
    a = tail()
    match = runup_match(a, sampled(a, detail=1.0, start=1.025))
    assert match.width == pytest.approx(1.025, abs=1e-6)
    assert np.abs(match.gain - 1).max() < 1e-9
    assert np.abs(match.scale - 1).max() < 1e-9


def test_the_windows_own_part_loses_the_same_fine_detail_and_keeps_its_broad_picture():
    a, own = tail(), tail(seed=5)
    match = runup_match(a, sampled(a))
    before = spreads(sampled(own))
    after = spreads(applied(match, sampled(own)))
    assert np.abs(after[0] / before[0] * match.gain - 1).max() < 0.01
    assert np.abs(after[1] / before[1] - 1).max() < 0.01
    assert np.abs(applied(match, sampled(own)).mean(axis=(1, 2, 3)) - sampled(own).mean(axis=(1, 2, 3))).max() < 1e-9


def test_a_run_up_that_is_not_a_copy_is_left_as_sampled():
    # a cut: the window left its guide, there is nothing to match and a new shot's look must not be pulled to the old one's
    match = runup_match(tail(), tail(seed=9))
    assert match.scale is None
    assert "not a copy" in match.why and match.correlation < 0.5


@pytest.mark.parametrize("detail", [0.85, 1.15])
def test_a_gain_past_what_the_sampler_adds_is_left_as_sampled(detail):
    a = tail()
    match = runup_match(a, sampled(a, detail=detail))
    assert match.scale is None and "outside" in match.why
    assert match.gain.mean() == pytest.approx(detail, abs=0.02)


def test_one_channel_past_the_bound_leaves_the_whole_window_as_sampled():
    a = tail()
    r = sampled(a)
    r[3] = sampled(a, detail=1.2)[3]
    assert runup_match(a, r).scale is None


def test_a_mean_bias_is_no_reason_to_leave_the_window_and_is_left_where_it_is():
    # the means are not what builds up (they drifted alike with the 0.45.0 match and without it): only the detail moves
    a = tail()
    r = sampled(a)
    r[7] += 0.3
    match = runup_match(a, r)
    assert match.why is None
    assert applied(match, r)[7].mean() == pytest.approx(r[7].mean(), abs=1e-9)


@pytest.mark.parametrize("flat", ["tail", "detail"])
def test_a_flat_channel_is_left_as_sampled(flat):
    a = tail()
    # a channel the same everywhere, or one with no fine detail (each of its tokens one value)
    a[0] = 0.5 if flat == "tail" else np.arange(7.0)[:, None, None]
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



def test_the_node_matches_the_windows_fine_detail_and_leaves_its_sound_alone_with_the_real_torch():
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
smooth = torch.nn.functional.interpolate(torch.randn(24, 22, 4, 3), size=(16, 12), mode="bilinear", align_corners=False)
prev = (smooth + torch.randn(24, 22, 16, 12) * 0.5).unsqueeze(0)


def grown(x):
    # the sampler's window: fine detail 3 % up, the whole 2 % wider, a bias per channel
    d, b = latent_io.detail_and_broad(x[0].double().numpy())
    return (torch.from_numpy((b + d * 1.03) * 1.02).float() + torch.linspace(-0.05, 0.05, 24).view(24, 1, 1, 1)).unsqueeze(0)


# its 7-token run-up the clip before's last 7, then 15 tokens of its own
video = torch.cat([grown(prev[:, :, -7:] + torch.randn(1, 24, 7, 16, 12) * 0.01), grown(torch.randn(1, 24, 15, 16, 12))], dim=2)
audio = torch.randn(1, 32, 2, 120)
window = {"samples": NestedTensor((video, audio)), "noise_mask": "kept"}
out = latent_io.AfflatusH3RunUpMatch.execute({"samples": NestedTensor((prev, torch.randn(1, 32, 2, 120)))}, window, 22)
v, a = out["samples"].tensors
match = latent_io.runup_match(prev[0, :, -7:].double().numpy(), video[0, :, :7].double().numpy())
# what numpy's split makes of the window, to hold the node's torch blur to it
d, b = latent_io.detail_and_broad(video[0].double().numpy())
expected = b + d * match.scale[:, None, None, None]
after = latent_io.runup_match(prev[0, :, -7:].double().numpy(), v[0, :, :7].double().numpy())
print(json.dumps({
    "shape": list(v.shape), "dtype": str(v.dtype), "same_audio": a is audio, "noise_mask": out.get("noise_mask"),
    "width": out[latent_io.RUNUP_KEY], "gain": float(match.gain.mean()), "after": float(after.gain.mean()),
    "vs_numpy": float(np.abs(v[0].double().numpy() - expected).max()),
    "means": float((v.mean(dim=(0, 2, 3, 4)) - video.mean(dim=(0, 2, 3, 4))).abs().max()),
    "own": float((v[:, :, 7:] - video[:, :, 7:]).abs().max()),
}))
# a cut: the window's run-up is not the clip before's tail; left as it was sampled, its width still said
other = torch.randn(1, 24, 22, 16, 12)
cut = latent_io.AfflatusH3RunUpMatch.execute({"samples": NestedTensor((prev, audio))}, {"samples": NestedTensor((other, audio))}, 22)
print(json.dumps({"cut_same": cut["samples"].tensors[0] is other, "cut_width": cut[latent_io.RUNUP_KEY]}))
""",
        needs=("torch", "numpy"),
    )
    # (the node's own lines, saying what it did and why the cut was left as sampled, are printed between them)
    first, second = (json.loads(line) for line in out.splitlines() if line.startswith("{"))
    assert "H3 Run-up Match: fine detail /1.0" in out
    assert "left as sampled, the run-up is not a copy" in out
    assert first["shape"] == [1, 24, 22, 16, 12] and first["dtype"] == "torch.float32"
    # the sound is the window's own tensor, untouched; the window's other entries are kept
    assert first["same_audio"] is True and first["noise_mask"] == "kept"
    assert 1.02 < first["width"] < 1.02 * 1.03
    # the split reads a little less than the 3 % put in: the blur of the detail is not nothing
    assert 1.015 < first["gain"] < 1.035
    # the fine detail brought back: read again, the run-up's growth is mostly gone; the means where they were
    assert abs(first["after"] - 1) < 0.2 * (first["gain"] - 1)
    assert first["vs_numpy"] < 1e-5
    assert first["means"] < 1e-5
    assert first["own"] > 0.005
    assert second["cut_same"] is True and second["cut_width"] == pytest.approx(1.0, abs=0.2)


def test_a_window_that_ends_on_frames_of_its_own_has_the_match_faded_out_over_them_with_the_real_torch():
    # card #234: on a landing, the landed tokens (the clip after's own, pinned) came out 2 to 3 % softer than that clip's
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
smooth = torch.nn.functional.interpolate(torch.randn(24, 22, 4, 3), size=(16, 12), mode="bilinear", align_corners=False)
prev_video = (smooth + torch.randn(24, 22, 16, 12) * 0.5).unsqueeze(0)


def grown(x):
    d, b = latent_io.detail_and_broad(x[0].double().numpy())
    return (torch.from_numpy((b + d * 1.03) * 1.02).float() + torch.linspace(-0.05, 0.05, 24).view(24, 1, 1, 1)).unsqueeze(0)


# the run-up (7 tokens) the clip before's last 7, then 15 of its own, the last 7 of them landed (22 frames)
video = torch.cat([grown(prev_video[:, :, -7:] + torch.randn(1, 24, 7, 16, 12) * 0.01), grown(torch.randn(1, 24, 15, 16, 12))], dim=2)
audio = torch.randn(1, 32, 2, 120)
look = latent_io.run_look(prev_video[0, :, -7:].double().numpy())
prev = {"samples": NestedTensor((prev_video, audio)), latent_io.RUN_KEY: look}
whole = latent_io.AfflatusH3RunUpMatch.execute(prev, {"samples": NestedTensor((video, audio))}, 22)
none = latent_io.AfflatusH3RunUpMatch.execute(prev, {"samples": NestedTensor((video, audio))}, 22, 0)
landed = latent_io.AfflatusH3RunUpMatch.execute(prev, {"samples": NestedTensor((video, audio))}, 22, 22)
w, n, l = (x["samples"].tensors[0] for x in (whole, none, landed))
# how far each token is from as sampled, as a share of how far the whole match moved it
moved = [float((l[:, :, i] - video[:, :, i]).abs().mean() / (w[:, :, i] - video[:, :, i]).abs().mean()) for i in range(22)]
# a cut: no run carried across it
other = torch.randn(1, 24, 22, 16, 12)
cut = latent_io.AfflatusH3RunUpMatch.execute(prev, {"samples": NestedTensor((other, audio))}, 22, 22)
plain = latent_io.AfflatusH3RunUpMatch.execute({"samples": NestedTensor((prev_video, audio))}, {"samples": NestedTensor((video, audio))}, 22)
print(json.dumps({
    "same_without": bool(torch.equal(w, n)), "moved": moved, "last_same": float((l[:, :, -1] - video[:, :, -1]).abs().max()),
    "look": whole[latent_io.RUN_KEY] == look and landed[latent_io.RUN_KEY] == look,
    "cut_look": latent_io.RUN_KEY in cut, "plain_look": latent_io.RUN_KEY in plain,
}))
""",
        needs=("torch", "numpy"),
    )
    got = json.loads(next(line for line in out.splitlines() if line.startswith("{")))
    assert "faded out over the last 7 tokens" in out
    # end_frames 0 is the node as before
    assert got["same_without"] is True
    moved = got["moved"]
    # the whole correction up to the landed tokens, then less and less, none at the last
    assert all(m == pytest.approx(1.0, abs=1e-4) for m in moved[:15])
    assert all(a >= b - 1e-6 for a, b in zip(moved[15:], moved[16:]))
    # (as sampled but for the float rounding of its blur taken off and put back)
    assert moved[-1] < 1e-5 and got["last_same"] < 1e-5
    # the run's look carried on for a window no Run Anchor follows; not across a cut, nor when the clip before has none
    assert got["look"] is True
    assert got["cut_look"] is False and got["plain_look"] is False

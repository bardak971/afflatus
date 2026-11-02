"""Afflatus: H3 Run Anchor: its figures on numpy arrays, the run's look through the kept latents, the node itself with the real torch."""

import json
import os

import numpy as np
import pytest
import safetensors.torch
from conftest import av, with_torch

from afflatus_nodes.latent_io import (
    RUN_KEY,
    RUN_NEW_LOOK,
    RUNUP_KEY,
    AfflatusH3RunAnchor,
    AfflatusLoadH3Latent,
    AfflatusNormalizeH3Latent,
    AfflatusSaveH3Latent,
    AfflatusTrimH3Latent,
    detail_and_broad,
    run_anchor,
    run_look,
    run_ramp,
    valid_look,
)

CHANNELS = 24


def clip(seed=0, n=35):
    """A clip's tokens [channels, n, 8, 12]: a broad picture (a smooth field) and fine detail over it, a mean of its own per
    channel, as H3's."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:8, 0:12]
    phase = rng.uniform(0, 2 * np.pi, (CHANNELS, n, 1, 1))
    broad = np.sin(x / 3.0 + phase) + np.cos(y / 2.5 + phase)
    return np.random.default_rng(1).normal(0, 0.3, (CHANNELS, 1, 1, 1)) + 0.7 * broad + rng.normal(0, 0.5, (CHANNELS, n, 8, 12))


def drift():
    """What a run's continuations add up to after a few joins (2026-11-01): channel 23 down, 17 to 20 up, the rest a little."""
    b = np.linspace(-0.02, 0.02, CHANNELS)
    b[17:21] = 0.12
    b[23] = -0.3
    return b[:, None, None, None]


def drifted(values, detail=1.08, shift=1.0):
    d, b = detail_and_broad(values)
    return b + d * detail + drift() * shift


def applied(anchor, values, hold=None):
    """`values` (a window's new part) as the node leaves it: the whole correction, or phased in when `hold` is given."""
    d, b = detail_and_broad(values)
    w = np.ones(values.shape[1]) if hold is None else run_ramp(values.shape[1], hold)
    w = w[None, :, None, None]
    return b + anchor.shift[:, None, None, None] * w + d * anchor.scale[:, None, None, None] ** w


def figures(values):
    d, b = detail_and_broad(values)
    flat = lambda v: v.reshape(CHANNELS, -1)
    return flat(values).mean(axis=1), flat(d).std(axis=1), flat(b).std(axis=1)


def test_a_drifted_clip_is_brought_back_to_its_runs_first_clips_means_and_fine_detail():
    first, later = clip(), clip(seed=4)
    look = run_look(first)
    anchor = run_anchor(look, drifted(later))
    assert anchor.why is None and anchor.look is look
    assert 0.03 < anchor.distance < RUN_NEW_LOOK
    fixed = applied(anchor, drifted(later))
    mean, fine, broad = figures(fixed)
    assert np.abs(mean - np.asarray(look["mean"])).max() < 1e-9
    # (the box split bleeds a little of the scaled detail into the broad picture: within half a per cent of an 8 % correction)
    assert np.abs(fine / np.asarray(look["fine"]) - 1).max() < 0.006
    # the broad picture's spread as sampled: what the clip shows (its contrast, a flash) is its own
    assert np.abs(broad / figures(drifted(later))[2] - 1).max() < 0.006


def test_a_clip_already_on_its_runs_look_is_left_as_it_is():
    # the first clip's own tokens in another order: the same look
    first = clip()
    anchor = run_anchor(run_look(first), first[:, ::-1].copy())
    assert anchor.why is None and anchor.distance < 1e-9
    assert np.abs(anchor.scale - 1).max() < 1e-9 and np.abs(anchor.shift).max() < 1e-9


def test_the_correction_is_phased_in_from_the_join_to_the_tail():
    ramp = run_ramp(35, 7)
    # none at the join, all of it on the tail the clip after copies, rising smoothly in between
    assert ramp[0] == 0 and np.all(ramp[-7:] == 1)
    assert np.all(np.diff(ramp) >= 0) and np.abs(np.diff(ramp)).max() < 0.06
    # a new part no longer than the tail: all of it at its last token only (a single token too: it is its last, card #234)
    assert run_ramp(5, 7)[0] == 0 and run_ramp(5, 7)[-1] == 1 and run_ramp(1, 7).tolist() == [1.0]


def test_the_join_stays_as_sampled_and_the_tail_is_held_to_the_runs_first_clips():
    # the drift growing over the clip, as a continuation's does: none at its first token, all of it at its end (the same
    # picture as the first clip's, so that its tail differs by the drift alone, as a still chain's does)
    first = clip()
    later = first.copy()
    grow = np.linspace(0, 1, 35)[None, :, None, None]
    d, b = detail_and_broad(later)
    later = b + d * (1 + 0.08 * grow) + drift() * grow
    anchor = run_anchor(run_look(first[:, -7:]), later[:, -7:])
    assert anchor.why is None
    fixed = applied(anchor, later, hold=7)
    assert np.abs(fixed[:, 0] - later[:, 0]).max() < 1e-12
    mean, fine, _ = figures(fixed[:, -7:])
    look = run_look(first[:, -7:])
    assert np.abs(mean - np.asarray(look["mean"])).max() < 1e-9
    assert np.abs(fine / np.asarray(look["fine"]) - 1).max() < 0.006
    # no step anywhere: from one token to the next the means move by the ramp's slope at most, a 1/18 of the tail's shift
    step = lambda v: np.abs(v[:, 1:].mean(axis=(2, 3)) - v[:, :-1].mean(axis=(2, 3)))
    assert (step(fixed) - step(later)).max() <= np.abs(anchor.shift).max() * np.diff(run_ramp(35, 7)).max() + 1e-9


def test_a_brief_flash_keeps_its_height():
    # a prompted flash: two tokens of the clip much brighter in their broad picture, before its tail. Held to the run, the
    # tokens around it move with the ramp alike; the flash stands as high over them
    first = clip()
    later = drifted(first)
    later[:, 20:22] += 1.5
    anchor = run_anchor(run_look(first[:, -7:]), later[:, -7:])
    assert anchor.why is None
    fixed = applied(anchor, later, hold=7)
    height = lambda v: v[:, 20:22].mean() - np.concatenate([v[:, 17:20], v[:, 22:25]], axis=1).mean()
    assert height(fixed) == pytest.approx(height(later), rel=0.02)


@pytest.mark.parametrize("change", ["means", "fine", "darker"])
def test_a_new_look_is_left_as_sampled_and_starts_a_new_run(change):
    # a cut the model made after its run-up, a room change or a light fading the prompt asked for: far from the run's look
    first, later = clip(), clip(seed=4)
    if change == "means":
        later = later + 0.6
    elif change == "fine":
        d, b = detail_and_broad(later)
        later = b + d * 1.6
    else:
        # a sunset's fade: the means slide one way over the clip, a quarter at its end (the pod test's sunset read 0.30)
        later = later - 0.25 * np.linspace(0, 1, 35)[None, :, None, None]
    anchor = run_anchor(run_look(first[:, -7:]), later[:, -7:])
    assert anchor.scale is None and anchor.shift is None
    assert anchor.distance > RUN_NEW_LOOK and "new run" in anchor.why
    # the clips after are held to this one's end now
    assert anchor.look == pytest.approx(run_look(later[:, -7:]))


def test_the_broad_pictures_spread_alone_does_not_end_the_run():
    # the anchor leaves it as sampled; per channel it wanders a little along a still chain, a lot under a prompted flash
    first, later = clip(), clip(seed=4)
    d, b = detail_and_broad(later)
    m = b.mean(axis=(1, 2, 3), keepdims=True)
    anchor = run_anchor(run_look(first), m + (b - m) * 1.3 + d)
    assert anchor.why is None and anchor.distance < RUN_NEW_LOOK


def test_a_flat_channel_is_left_as_sampled_and_the_run_kept():
    first, later = clip(), clip(seed=4)
    later[3] = 0.25
    look = run_look(first)
    anchor = run_anchor(look, later)
    assert anchor.scale is None and "flat" in anchor.why and anchor.look is look


def test_a_look_is_checked_before_it_is_used():
    look = run_look(clip())
    assert valid_look(look, CHANNELS) == look
    assert valid_look(look, 16) is None
    assert valid_look({**look, "fine": [0.0] * CHANNELS}, CHANNELS) is None
    assert valid_look({**look, "mean": [float("nan")] * CHANNELS}, CHANNELS) is None
    assert valid_look({"mean": look["mean"]}, CHANNELS) is None
    assert valid_look("0.5", CHANNELS) is None and valid_look(None, CHANNELS) is None


def test_the_node_refuses_what_the_seam_would_refuse():
    with pytest.raises(ValueError, match="no new frames"):
        AfflatusH3RunAnchor.execute(av(73, "before"), av(22, "window"), 22)
    with pytest.raises(ValueError, match="same size"):
        AfflatusH3RunAnchor.execute(av(73, "before", width=8), av(73, "window"), 22)


def test_the_runs_look_goes_into_the_kept_latents_metadata_and_back(folders):
    look = run_look(clip())
    window = {**av(73, "window", width=12, height=8), RUN_KEY: look, RUNUP_KEY: 1.031}
    normalized = AfflatusNormalizeH3Latent.execute(window).args[0]
    assert normalized[RUN_KEY] is look and normalized[RUNUP_KEY] == 1.031
    (saved,) = AfflatusSaveH3Latent.execute(normalized, "Afflatus/h3").ui["latents"]
    path = os.path.join(folders.temp, saved["subfolder"], saved["filename"])
    meta = safetensors.torch.saved[path][1]
    written = json.loads(meta["run_look"])
    assert sorted(written) == ["broad", "fine", "mean"]
    assert np.abs(np.asarray(written["fine"]) / np.asarray(look["fine"]) - 1).max() < 1e-5
    # the clip after loads it: the look comes back with the latent, read from the file's header
    file = os.path.join(folders.input, "kept.safetensors")
    head = json.dumps({"__metadata__": {"format": "afflatus-h3-av-latent/1", "frames": "73", "run_look": meta["run_look"]}}).encode()
    with open(file, "wb") as f:
        f.write(len(head).to_bytes(8, "little") + head)
    streams = av(73, "kept")["samples"].tensors
    safetensors.torch.saved[file] = ({"video": streams[0], "audio": streams[1]}, None)
    loaded = AfflatusLoadH3Latent.execute("kept.safetensors").args[0]
    assert loaded[RUN_KEY] == pytest.approx(written)
    assert RUNUP_KEY not in loaded
    # a clip handed over early is continued from its first frames: the same run
    assert AfflatusTrimH3Latent.execute(loaded, 39).args[0][RUN_KEY] is loaded[RUN_KEY]


def test_a_broken_or_missing_look_is_not_written_nor_read(folders):
    (plain,) = AfflatusSaveH3Latent.execute(AfflatusNormalizeH3Latent.execute({**av(22, "clip"), RUN_KEY: {"mean": [1.0]}}).args[0], "Afflatus/h3x").ui["latents"]
    assert "run_look" not in safetensors.torch.saved[os.path.join(folders.temp, plain["subfolder"], plain["filename"])][1]
    file = os.path.join(folders.input, "bad.safetensors")
    head = json.dumps({"__metadata__": {"format": "afflatus-h3-av-latent/1", "frames": "73", "run_look": "{not json"}}).encode()
    with open(file, "wb") as f:
        f.write(len(head).to_bytes(8, "little") + head)
    streams = av(73, "kept")["samples"].tensors
    safetensors.torch.saved[file] = ({"video": streams[0], "audio": streams[1]}, None)
    assert RUN_KEY not in AfflatusLoadH3Latent.execute("bad.safetensors").args[0]


def test_a_re_encoded_window_keeps_the_figures_of_the_window_it_was_made_from():
    # Face refine's re-encode hands on its samples alone: Normalize takes the run's look and the run-up width from the window
    look = run_look(clip())
    window = {**av(73, "window"), RUN_KEY: look, RUNUP_KEY: 1.031}
    out = AfflatusNormalizeH3Latent.execute(av(73, "refined"), figures_from=window).args[0]
    assert out[RUN_KEY] is look and out[RUNUP_KEY] == 1.031
    # what the latent itself carries comes first
    other = run_look(clip(seed=3))
    assert AfflatusNormalizeH3Latent.execute({**av(73, "refined"), RUN_KEY: other}, figures_from=window).args[0][RUN_KEY] is other
    assert RUN_KEY not in AfflatusNormalizeH3Latent.execute(av(73, "refined")).args[0]


def test_the_node_holds_a_window_to_its_runs_first_clip_and_carries_the_look_on_with_the_real_torch():
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


def picture(n):
    smooth = torch.nn.functional.interpolate(torch.randn(24, n, 4, 3), size=(16, 12), mode="bilinear", align_corners=False)
    return (smooth + torch.randn(24, n, 16, 12) * 0.5).unsqueeze(0)


def grown(x):
    # a few joins on: fine detail 8 % up, channel 23 down and 17-20 up
    d, b = latent_io.detail_and_broad(x[0].double().numpy())
    bias = torch.zeros(24)
    bias[17:21] = 0.12
    bias[23] = -0.3
    return (torch.from_numpy(b + d * 1.08).float() + bias.view(24, 1, 1, 1)).unsqueeze(0)


first = picture(22)
audio = torch.randn(1, 32, 2, 120)
# a continuation: its run-up the clip before's tail, its new part going on from it (the same picture), grown
window = {"samples": NestedTensor((torch.cat([first[:, :, -7:], grown(first[:, :, -15:])], dim=2), audio)), "noise_mask": "kept"}
# the clip before is the run's first clip: its look is read on its tail
out = latent_io.AfflatusH3RunAnchor.execute({"samples": NestedTensor((first, audio))}, window, 22)
v, a = out["samples"].tensors
video = window["samples"].tensors[0]
look = latent_io.run_look(first[0, :, -7:].double().numpy())
anchor = latent_io.run_anchor(look, video[0, :, -7:].double().numpy())
d, b = latent_io.detail_and_broad(video[0].double().numpy())
w = np.concatenate([np.zeros(7), latent_io.run_ramp(15, 7)])[None, :, None, None]
expected = b + anchor.shift[:, None, None, None] * w + d * anchor.scale[:, None, None, None] ** w
after = latent_io.run_look(v[0, :, -7:].double().numpy())
# the clip after: continued from this window, carrying the look on (a later clip of the run, its own picture)
nxt = {"samples": NestedTensor((torch.cat([v[:, :, -7:], grown(v[:, :, -15:])], dim=2), audio))}
again = latent_io.AfflatusH3RunAnchor.execute(out, nxt, 22)
print(json.dumps({
    "shape": list(v.shape), "dtype": str(v.dtype), "same_audio": a is audio, "noise_mask": out.get("noise_mask"),
    "vs_numpy": float(np.abs(v[0].double().numpy() - expected).max()),
    "join_same": float((v[0, :, :8] - video[0, :, :8]).abs().max()),
    "mean_off": float(np.abs(np.asarray(after["mean"]) - np.asarray(look["mean"])).max()),
    "fine_off": float(np.abs(np.asarray(after["fine"]) / np.asarray(look["fine"]) - 1).max()),
    "look_is_first": out[latent_io.RUN_KEY] == look, "carried": again[latent_io.RUN_KEY] == out[latent_io.RUN_KEY],
    "held_again": again["samples"].tensors[0] is not nxt["samples"].tensors[0],
}))
# a new scene sent as a continuation: left as sampled, its own look starts a new run
other = torch.randn(1, 24, 22, 16, 12) * 2 + 1
cut = latent_io.AfflatusH3RunAnchor.execute(out, {"samples": NestedTensor((other, audio))}, 22)
print(json.dumps({"cut_same": cut["samples"].tensors[0] is other, "new_look": cut[latent_io.RUN_KEY] == latent_io.run_look(other[0, :, -7:].double().numpy())}))
""",
        needs=("torch", "numpy"),
    )
    first, second = (json.loads(line) for line in out.splitlines() if line.startswith("{"))
    assert "H3 Run Anchor: tail held to the run's first clip, phased in from the join" in out and "the run read on the clip before" in out
    assert "left as sampled, its look is" in out and "a new run" in out
    assert first["shape"] == [1, 24, 22, 16, 12] and first["dtype"] == "torch.float32"
    # the sound is the window's own tensor, untouched; the window's other entries are kept
    assert first["same_audio"] is True and first["noise_mask"] == "kept"
    assert first["vs_numpy"] < 1e-5
    # the run-up and the first new token as sampled: the join is not moved
    assert first["join_same"] < 1e-6
    # read again, the window's tail sits on the first clip's means and fine detail (less the box split's bleed)
    assert first["mean_off"] < 1e-4 and first["fine_off"] < 0.01
    assert first["look_is_first"] is True and first["carried"] is True and first["held_again"] is True
    assert second["cut_same"] is True and second["new_look"] is True

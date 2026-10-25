"""The LTX latent nodes' frame, token and sound-step arithmetic, on stand-in tensors (see conftest.py): no torch, no GPU."""

import pytest
from conftest import NestedTensor, Tensor

from afflatus_nodes.latent_ltx import (
    FORMAT,
    AfflatusLoadLTXLatent,
    AfflatusLTXContinuation,
    AfflatusLTXSeamLatent,
    AfflatusSaveLTXLatent,
    AfflatusTrimLTXLatent,
    ltx_frames,
    ltx_tokens,
    run_up_tokens,
)


def ltx(frames, tag, steps=None, device="cpu", width=40, height=22):
    """An LTX latent of `frames` frames: its video tokens labelled (tag, i), its sound steps (tag, "a", i), 25 a second at 25 fps."""
    tokens = ltx_tokens(frames)
    steps = steps if steps is not None else frames
    video = Tensor((1, 128, tokens, height, width), [(tag, i) for i in range(tokens)], device=device)
    sound = Tensor((1, 8, steps, 16), [(tag, "a", i) for i in range(steps)], axis=2, device=device)
    return {"samples": NestedTensor((video, sound))}


def silence(steps):
    return {"samples": Tensor((1, 8, steps, 16), ["quiet"] * steps, axis=2), "type": "audio"}


def test_the_frame_grid():
    assert [ltx_tokens(f) for f in (1, 9, 25, 121)] == [1, 2, 4, 16]
    assert [ltx_frames(t) for t in (1, 2, 4, 16)] == [1, 9, 25, 121]
    assert [run_up_tokens(f) for f in (9, 25)] == [2, 4]
    with pytest.raises(ValueError, match=r"8k \+ 1"):
        ltx_tokens(24)
    with pytest.raises(ValueError, match="8k - 7"):
        run_up_tokens(22)


def test_save_writes_both_streams_with_frames_rate_and_size(tmp_path, monkeypatch):
    import folder_paths
    import safetensors.torch

    from conftest import Folders

    folders = Folders(str(tmp_path))
    for name in ("get_temp_directory", "get_save_image_path"):
        monkeypatch.setattr(folder_paths, name, getattr(folders, name), raising=False)
    out = AfflatusSaveLTXLatent.execute(ltx(121, "clip"), 24.0, "Afflatus/ltx")
    saved = out.ui["latents"][0]
    assert saved["type"] == "temp" and saved["filename"].endswith(".safetensors")
    path = next(p for p in safetensors.torch.saved if p.endswith(saved["filename"]))
    tensors, metadata = safetensors.torch.saved[path]
    assert set(tensors) == {"video", "audio"}
    assert metadata == {"format": FORMAT, "frames": "121", "fps": "24", "width": "1280", "height": "704"}


def test_trim_keeps_the_first_frames_and_the_sound_under_them():
    out = AfflatusTrimLTXLatent.execute(ltx(121, "clip"), 49)
    video, sound = out.args[0]["samples"].tensors
    assert out.args[1] == 49
    assert video.labels == [("clip", i) for i in range(7)]
    assert sound.labels == [("clip", "a", i) for i in range(49)]
    with pytest.raises(ValueError, match="fewer than"):
        AfflatusTrimLTXLatent.execute(ltx(25, "clip"), 49)


def test_continuation_pins_the_last_tokens_and_lays_the_last_sound_at_the_head():
    # a clip before of 121 frames (16 tokens, 121 sound steps); a run-up of 25 frames is its last 4 tokens and 25 steps
    guide, audio, mask = AfflatusLTXContinuation.execute(ltx(121, "before"), silence(150), 25).args
    assert guide["samples"].labels == [("before", i) for i in range(12, 16)]
    assert audio["samples"].shape == (1, 8, 150, 16)
    assert audio["samples"].labels == [("before", "a", i) for i in range(96, 121)] + ["quiet"] * 125
    # the mask: 0 (kept) over those steps, 1 (made) after, as [1, steps, frequency]
    assert mask.shape == (1, 150, 16)
    assert mask.labels == [0] * 25 + [1] * 125
    assert audio["noise_mask"] is mask
    # the short run-up: 9 frames, 2 tokens
    short, _audio, short_mask = AfflatusLTXContinuation.execute(ltx(121, "before"), silence(60), 9).args
    assert short["samples"].labels == [("before", 14), ("before", 15)]
    assert short_mask.labels[:10] == [0] * 9 + [1]


def test_continuation_refuses_another_kind_of_sound_or_too_short_a_clip():
    with pytest.raises(ValueError, match="too few"):
        AfflatusLTXContinuation.execute(ltx(9, "before"), silence(60), 25)
    with pytest.raises(ValueError, match="kind"):
        AfflatusLTXContinuation.execute(ltx(121, "before"), {"samples": Tensor((1, 32, 2, 60), axis=3)}, 25)


def test_seam_puts_the_clip_befores_tokens_before_the_continuations_own():
    before = ltx(121, "before")
    # a continuation of 145 frames: a 25-frame run-up (4 tokens), then 120 frames of its own (15 tokens)
    sampled = {"samples": Tensor((1, 128, 19, 22, 40), [("new", i) for i in range(19)], device="cuda:0"), "noise_mask": "x"}
    out = AfflatusLTXSeamLatent.execute(before, sampled, 25, 4).args[0]
    assert "noise_mask" not in out
    labels = out["samples"].labels
    # 4 tokens of context and the 4 of the run-up from the clip before, then the continuation's own from its token 4
    assert labels == [("before", i) for i in range(8, 16)] + [("new", i) for i in range(4, 19)]
    # decoded: 8 × 4 context frames to drop, then exactly the continuation's frame count
    assert ltx_frames(len(labels)) - 8 * 4 == ltx_frames(19)
    assert out["samples"].device == "cuda:0"


def test_seam_refuses_mismatched_sizes_or_a_continuation_with_nothing_of_its_own():
    before = ltx(121, "before")
    with pytest.raises(ValueError, match="same size"):
        AfflatusLTXSeamLatent.execute(before, {"samples": Tensor((1, 128, 19, 11, 20))}, 25, 4)
    with pytest.raises(ValueError, match="nothing|no frames"):
        AfflatusLTXSeamLatent.execute(before, {"samples": Tensor((1, 128, 4, 22, 40))}, 25, 4)
    with pytest.raises(ValueError, match="fewer than"):
        AfflatusLTXSeamLatent.execute(ltx(25, "before"), {"samples": Tensor((1, 128, 19, 22, 40))}, 25, 4)


def test_load_refuses_another_models_latent(tmp_path, monkeypatch):
    import folder_paths
    import safetensors.torch

    import afflatus_nodes
    import afflatus_nodes.latent_io as latent_io

    path = tmp_path / "x.safetensors"
    path.write_text("stand-in")
    monkeypatch.setattr(latent_io, "latent_path", lambda name: str(path))
    video, sound = ltx(25, "kept")["samples"].tensors
    safetensors.torch.saved[str(path)] = ({"video": video, "audio": sound}, None)
    monkeypatch.setattr(afflatus_nodes, "read_header", lambda p: {"__metadata__": {"format": FORMAT}})
    out = AfflatusLoadLTXLatent.execute("x.safetensors [temp]")
    assert out.args[1] == 25
    assert out.args[0]["samples"].tensors[0].labels == [("kept", i) for i in range(4)]
    monkeypatch.setattr(afflatus_nodes, "read_header", lambda p: {"__metadata__": {"format": "afflatus-h3-av-latent/1"}})
    with pytest.raises(ValueError, match="not an LTX latent"):
        AfflatusLoadLTXLatent.execute("x.safetensors [temp]")

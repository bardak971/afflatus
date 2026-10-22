"""The pack's frame and token arithmetic, on stand-in tensors (see conftest.py): no torch, no ComfyUI, no GPU."""

import os
import re
import sys

import pytest
from conftest import PACK, Tensor, av, conditioning

from afflatus_nodes import VERSION, clean_folder, read_header
from afflatus_nodes.continuation_nodes import audio_t_at_frame_boundary, video_latent_t
from afflatus_nodes.latent_io import (
    AfflatusH3LatentHeadGuide,
    AfflatusH3LatentLanding,
    AfflatusH3SeamLatent,
    AfflatusLoadH3Latent,
    AfflatusSaveH3Latent,
    AfflatusTrimH3Latent,
    guide_frames_of,
)


def streams(out):
    return out.args[0]["samples"].tensors


@pytest.mark.parametrize("frames, tokens, audio", [(22, 7, 37), (39, 12, 65), (56, 17, 93)])
def test_trim_keeps_the_first_frames_with_their_tokens_and_their_sound(frames, tokens, audio):
    out = AfflatusTrimH3Latent.execute(av(73, "clip"), frames)
    video, sound = streams(out)
    assert out.args[1] == frames
    assert video.shape[2] == tokens and video.labels == [("clip", i) for i in range(tokens)]
    # the sound up to the last kept frame: 40 audio steps a second, 24 frames
    assert sound.shape[-1] == audio == audio_t_at_frame_boundary(frames)


def test_trim_refuses_more_frames_than_the_latent_holds():
    with pytest.raises(ValueError, match="fewer than"):
        AfflatusTrimH3Latent.execute(av(39, "clip"), 56)


def test_seam_puts_the_clip_befores_own_last_tokens_where_the_window_overlapped():
    before = av(73, "before")
    # a window of 22 overlap frames and 51 new ones, sampled on another device than the latent loaded from disk
    window = av(73, "window", device="cuda:0")
    video, sound = streams(AfflatusH3SeamLatent.execute(before, window, 22))
    overlap = video_latent_t(22)
    assert video.shape[2] == video_latent_t(73)
    assert video.labels[:overlap] == [("before", i) for i in range(22 - overlap, 22)]
    assert video.labels[overlap:] == [("window", i) for i in range(overlap, 22)]
    # the sound: the clip before's from its frame 51, then the window's after its overlap; as long as the window's
    lead = audio_t_at_frame_boundary(73) - audio_t_at_frame_boundary(73 - 22)
    assert sound.shape[-1] == lead + audio_t_at_frame_boundary(73) - audio_t_at_frame_boundary(22)
    assert sound.labels[0] == ("before", "a", audio_t_at_frame_boundary(51))
    # what came from the disk is moved to the window's device, so the two can be joined
    assert video.device == sound.device == "cuda:0"


@pytest.mark.parametrize("before_frames", [107, 141, 73, 124])
def test_seam_takes_as_many_sound_tokens_as_it_skips(before_frames):
    # the window as MiniMaxH3GuidedContinuationWindow makes it: its overlap's sound counted on the clip before's clock
    overlap = audio_t_at_frame_boundary(before_frames) - audio_t_at_frame_boundary(before_frames - 22)
    new = audio_t_at_frame_boundary(before_frames + 119) - audio_t_at_frame_boundary(before_frames)
    window = av(141, "window", audio=overlap + new)
    _, sound = streams(AfflatusH3SeamLatent.execute(av(before_frames, "before"), window, 22))
    # as long as the window's, the clip before's last tokens and then the window's own from the first one after its overlap:
    # after a 107-frame clip the overlap is 36 tokens, and skipping audio_t(22) = 37 lost the window's first own token
    assert sound.shape[-1] == overlap + new
    assert sound.labels[overlap - 1] == ("before", "a", audio_t_at_frame_boundary(before_frames) - 1)
    assert sound.labels[overlap] == ("window", "a", overlap)


def test_seam_refuses_a_window_with_nothing_after_its_overlap():
    with pytest.raises(ValueError, match="no new frames"):
        AfflatusH3SeamLatent.execute(av(73, "before"), av(22, "window"), 22)


@pytest.mark.parametrize("land_at, start_t", [(0, 0), (17, 5), (34, 10)])
def test_landing_starts_where_a_chunk_of_the_clip_after_begins(land_at, start_t):
    out = AfflatusH3LatentLanding.execute(conditioning(), av(90, "next"), av(73, "window"), 22, land_at)
    (guide,) = out.args[0][0][1]["minimax_keyframes"]
    assert guide["latent"].labels == [("next", i) for i in range(start_t, start_t + video_latent_t(22))]
    assert guide["audio_latent"].labels[0] == ("next", "a", audio_t_at_frame_boundary(land_at))
    # pinned at the window's last 22 frames
    assert guide["resolved_frame_index"] == 73 - 22


def test_landing_refuses_a_frame_off_the_chunks():
    with pytest.raises(ValueError, match="17j"):
        AfflatusH3LatentLanding.execute(conditioning(), av(90, "next"), av(73, "window"), 22, 22)


def test_head_guide_skips_the_clip_afters_own_overlap_on_the_17k_plus_5_grid():
    out = AfflatusH3LatentHeadGuide.execute(conditioning(), av(90, "next"), av(73, "window"), 22, 22)
    (guide,) = out.args[0][0][1]["minimax_keyframes"]
    assert guide["latent"].labels[0] == ("next", video_latent_t(22))


def test_head_guide_refuses_a_window_whose_last_frames_another_guide_holds():
    # the tail guide of the clip before: 22 frames from frame 0, 7 tokens
    tail = {"resolved_frame_index": 0, "latent": Tensor((1, 24, 7, 4, 4)), "audio_latent": Tensor((1, 32, 2, 37))}
    # a 39-frame window: the head guide wants frames 17 on, the tail guide holds them up to 22
    with pytest.raises(ValueError, match="the head guide needs them"):
        AfflatusH3LatentHeadGuide.execute(conditioning(tail), av(56, "next"), av(39, "window"), 22, 0)
    # a 56-frame window: frames 34 on are free
    out = AfflatusH3LatentHeadGuide.execute(conditioning(tail), av(56, "next"), av(56, "window"), 22, 0)
    assert [k["resolved_frame_index"] for k in out.args[0][0][1]["minimax_keyframes"]] == [0, 34]


def test_a_guide_without_a_video_latent_spans_nothing_and_a_picture_one_frame():
    assert guide_frames_of({"resolved_frame_index": 3}) == 0
    assert guide_frames_of({"latent": Tensor((1, 24, 1, 4, 4))}) == 1
    assert guide_frames_of({"latent": Tensor((1, 24, 7, 4, 4))}) == 22
    sound_only = {"resolved_frame_index": 10, "audio_latent": Tensor((1, 32, 2, 37))}
    out = AfflatusH3LatentLanding.execute(conditioning(sound_only), av(56, "next"), av(56, "window"), 22, 0)
    assert len(out.args[0][0][1]["minimax_keyframes"]) == 2


def test_a_saved_latent_goes_to_the_temp_folder_and_says_so(folders):
    out = AfflatusSaveH3Latent.execute(av(22, "clip"), "Afflatus/h3")
    (saved,) = out.ui["latents"]
    assert saved["type"] == "temp"
    assert os.path.isfile(os.path.join(folders.temp, saved["subfolder"], saved["filename"]))
    assert not os.listdir(folders.output)


def test_a_latent_is_loaded_only_from_the_folder_its_name_says_and_only_a_safetensors_file(folders):
    with open(os.path.join(folders.temp, "a.safetensors"), "w") as f:
        f.write("x")
    with open(os.path.join(folders.output, "b.safetensors"), "w") as f:
        f.write("x")
    with open(os.path.join(folders.temp, "c.json"), "w") as f:
        f.write("x")
    os.makedirs(os.path.join(folders.output, "Afflatus"))
    with open(os.path.join(folders.output, "Afflatus", "d.safetensors"), "w") as f:
        f.write("x")
    assert AfflatusLoadH3Latent.validate_inputs("a.safetensors [temp]") is True
    # one this ComfyUI wrote into its output folder, read where it is (a continuation on the same machine, pack 0.36.5)
    assert AfflatusLoadH3Latent.validate_inputs("b.safetensors [output]") is True
    assert AfflatusLoadH3Latent.validate_inputs("Afflatus/d.safetensors [output]") is True
    # a name that climbs out of the folder it names, even into another one read, or a file that is not a latent
    assert AfflatusLoadH3Latent.validate_inputs("../output/b.safetensors [temp]") is not True
    assert AfflatusLoadH3Latent.validate_inputs("../temp/a.safetensors [output]") is not True
    assert AfflatusLoadH3Latent.validate_inputs("../../a.safetensors [output]") is not True
    assert AfflatusLoadH3Latent.validate_inputs("c.json [temp]") is not True
    with pytest.raises(ValueError, match="not found"):
        AfflatusLoadH3Latent.execute("../output/b.safetensors [temp]")


def test_the_version_is_the_one_in_pyproject():
    with open(os.path.join(PACK, "pyproject.toml"), encoding="utf-8") as f:
        assert VERSION == re.search(r'^version\s*=\s*"([^"]+)"', f.read(), re.M).group(1)


def test_a_header_that_is_not_an_object_is_no_header(tmp_path):
    path = tmp_path / "list.safetensors"
    body = b"[1, 2, 3]"
    path.write_bytes(len(body).to_bytes(8, "little") + body)
    assert read_header(str(path)) is None
    good = tmp_path / "good.safetensors"
    body = b'{"__metadata__": {"a": "1"}, "w": {"dtype": "F16", "shape": [2], "data_offsets": [0, 4]}}'
    good.write_bytes(len(body).to_bytes(8, "little") + body)
    assert read_header(str(good)) == {"__metadata__": {"a": "1"}, "w": {"dtype": "F16", "shape": [2]}}


def test_cleaning_takes_only_old_files_of_afflatus(tmp_path):
    old, new, other = tmp_path / "afflatus_old.png", tmp_path / "afflatus_new.png", tmp_path / "theirs.png"
    for p in (old, new, other):
        p.write_bytes(b"x")
    os.utime(old, (1, 1))
    os.utime(other, (1, 1))
    assert clean_folder(str(tmp_path), 24) == 1
    assert sorted(p.name for p in tmp_path.iterdir()) == ["afflatus_new.png", "theirs.png"]
    assert clean_folder(str(tmp_path / "none"), 24) == 0


if __name__ == "__main__":
    sys.exit(pytest.main([__file__]))

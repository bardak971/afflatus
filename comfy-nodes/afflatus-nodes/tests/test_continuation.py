"""The H3 chain's core on stand-in tensors (see conftest.py): the continuation window's token layout and the
normalising of a sampled window's sound. A token off here shifts every later clip's sound against its pictures."""

import pytest
from conftest import av

from afflatus_nodes.continuation_nodes import MiniMaxH3GuidedContinuationWindow, audio_t_at_frame_boundary, video_latent_t
from afflatus_nodes.latent_io import AfflatusNormalizeH3Latent


def streams(out):
    return out.args[0]["samples"].tensors


@pytest.mark.parametrize(
    "previous, overlap, extension, window, overlap_video, overlap_audio, audio",
    [
        # the form's usual window: 22 hidden frames and 119 new ones after a 73-frame clip
        (73, 22, 119, 141, 7, 37, 235),
        # a short clip continued by one group, where the overlap's sound starts off a whole token (frame 34 is 56.7 steps)
        (56, 22, 17, 39, 7, 36, 65),
        # the whole clip as hidden context
        (39, 39, 34, 73, 12, 65, 122),
    ],
)
def test_the_window_lays_its_tokens_on_the_whole_chains_time(previous, overlap, extension, window, overlap_video, overlap_audio, audio):
    out = MiniMaxH3GuidedContinuationWindow.execute(av(previous, "before", device="cuda:0", width=6, height=5), overlap, extension)
    video, sound = streams(out)
    assert out.args[1:] == (window, overlap_video, overlap_audio, 0, 0)
    assert video.shape == (1, 24, video_latent_t(window), 5, 6)
    assert video_latent_t(overlap) == overlap_video
    # the overlap's sound is cut at the chain's own frame boundaries, not the window's: the steps from the overlap's first
    # frame to the clip's end, then those of the new frames
    assert overlap_audio == audio_t_at_frame_boundary(previous) - audio_t_at_frame_boundary(previous - overlap)
    assert sound.shape == (1, 32, 2, audio)
    assert audio == audio_t_at_frame_boundary(previous + extension) - audio_t_at_frame_boundary(previous - overlap)
    # a fresh target, on the clip's device
    assert set(video.labels) == {None} and set(sound.labels) == {None}
    assert video.device == sound.device == "cuda:0"


@pytest.mark.parametrize(
    "previous, overlap, extension, match",
    [
        (73, 21, 119, "17k \\+ 5"),
        (39, 56, 17, "cannot exceed"),
        (73, 22, 18, "multiple of 17"),
        (73, 22, 0, "at least 17"),
    ],
)
def test_the_window_refuses_lengths_off_the_grid(previous, overlap, extension, match):
    with pytest.raises(ValueError, match=match):
        MiniMaxH3GuidedContinuationWindow.execute(av(previous, "before"), overlap, extension)


def test_the_window_refuses_a_clip_whose_sound_is_not_on_its_own_boundary():
    with pytest.raises(ValueError, match="audio temporal length must be 122"):
        MiniMaxH3GuidedContinuationWindow.execute(av(73, "before", audio=123), 22, 119)


@pytest.mark.parametrize("have", [66, 64, 65])
def test_normalize_puts_a_windows_sound_on_its_own_boundary(have):
    # a 39-frame window sampled on a chain's boundaries can carry one step more or less than its 65
    out = AfflatusNormalizeH3Latent.execute(av(39, "w", audio=have))
    video, sound = streams(out)
    assert out.args[1] == 39
    assert video.labels == [("w", i) for i in range(video_latent_t(39))]
    want = audio_t_at_frame_boundary(39)
    assert sound.shape == (1, 32, 2, want)
    # a longer sound loses its last steps, a shorter one is padded with silence at its end
    kept = min(have, want)
    assert sound.labels[:kept] == [("w", "a", i) for i in range(kept)]
    assert sound.labels[kept:] == [None] * (want - kept)

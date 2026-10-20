"""Face refine's audio lock, on stand-in tensors (see conftest.py): the sound in, held, the video left to redraw."""

import pytest
from conftest import Tensor, av

from afflatus_nodes.face_refine import AfflatusH3AudioLock


class AudioVae:
    """H3's audio VAE as the node uses it: a rate, and a waveform encoded to `steps` audio tokens."""

    audio_sample_rate = 32000

    def __init__(self, steps):
        self.steps = steps
        self.given = None

    def encode(self, waveform):
        self.given = waveform
        return Tensor((1, 32, 2, self.steps), [("sound", i) for i in range(self.steps)])


def sound(rate=32000):
    return {"waveform": Tensor((1, 2, rate * 4)), "sample_rate": rate}


def locked(frames, steps):
    out = AfflatusH3AudioLock.execute(av(frames, "clip"), AudioVae(steps), sound())
    return out.args[0]


def test_the_sound_replaces_the_audio_stream_and_the_video_is_kept():
    out = locked(107, 178)
    video, audio = out["samples"].tensors
    assert video.labels == [("clip", i) for i in range(32)]
    assert audio.labels == [("sound", i) for i in range(178)]


@pytest.mark.parametrize("steps", [170, 178, 190])
def test_the_sound_is_cut_or_padded_to_the_latent_audio_length(steps):
    want = av(107, "clip")["samples"].tensors[1].shape[-1]
    audio = locked(107, steps)["samples"].tensors[1]
    assert audio.shape[-1] == want
    # what was encoded comes first, in order; padding after it holds no sound token
    kept = min(steps, want)
    assert audio.labels[:kept] == [("sound", i) for i in range(kept)]
    assert all(label is None for label in audio.labels[kept:])


def test_the_noise_mask_redraws_the_video_and_holds_the_sound():
    out = locked(107, 178)
    video_mask, audio_mask = out["noise_mask"].tensors
    video, audio = out["samples"].tensors
    assert video_mask.shape == video.shape and set(video_mask.labels) == {1}
    assert audio_mask.shape == audio.shape and set(audio_mask.labels) == {0}


def test_the_waveform_goes_to_the_vae_channels_last():
    vae = AudioVae(178)
    AfflatusH3AudioLock.execute(av(107, "clip"), vae, sound())
    assert vae.given.shape == (1, 32000 * 4, 2)

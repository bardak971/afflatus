"""A faint noise laid into a sound's stretches of digital silence (Afflatus: Room Tone), before LTX encodes it to be pinned.

LTX 2.3 made a sung clip fade to black over its last 0.7 s, where the sound it was pinned to was exact digital silence (the
song's pause), and the clip after it carried that fade on (#85's series, 2026-10-25). Exact silence is at the floor of the
audio VAE's mel spectrogram (log of 1e-5 in every band): encoded by 2.3's audio VAE it gives latents of RMS 2.1 to 2.3, where
the song and the voice around it give 1.3 and 1.0, and a recording with any room in it never reaches it. Filled with a white
noise at -50 dBFS, the same stretches encode to 1.1. Only silence is filled: the noise laid under the whole sound moved the
voice's own latents by 30 to 56 % even at -60 dBFS, on a voice as clean as a synthesised one. What the take carries is the
sound as it was: this is for the copy the model is given.

The figures are numpy (the tests run them without torch); the node moves the waveform to numpy and back.
"""

import numpy as np
from comfy_api.latest import io

# a sample this quiet in every channel is silence: 16-bit audio's smallest step is -90 dBFS, and a recording's own room is
# far above it
SILENT = 10 ** (-90 / 20)
# looked at 10 ms at a time; a stretch of silence is filled from 20 ms on, faded in and out over 10 ms inside it
BLOCK_S = 0.01
SHORTEST_BLOCKS = 2


def silent_gain(wave, sample_rate):
    """How much of the noise each sample gets, 0 to 1: 1 inside a stretch of digital silence at least 20 ms long, faded in and
    out over its first and last 10 ms, so that no sound of the recording's own is ever touched. `wave` is (channels, samples)."""
    n = wave.shape[-1]
    block = max(1, int(round(sample_rate * BLOCK_S)))
    blocks = -(-n // block)
    padded = np.zeros((wave.shape[0], blocks * block), dtype=np.float64)
    padded[:, :n] = np.abs(wave)
    # a block is silent when it holds no sample above the threshold, its padding past the end included
    quiet = padded.reshape(wave.shape[0], blocks, block).max(axis=(0, 2)) < SILENT
    gain = np.zeros(blocks * block, dtype=np.float64)
    ramp = np.linspace(0, 1, block + 2)[1:-1]
    start = None
    for i in range(blocks + 1):
        if i < blocks and quiet[i]:
            if start is None:
                start = i
            continue
        if start is not None and i - start >= SHORTEST_BLOCKS:
            a, b = start * block, i * block
            gain[a:b] = 1
            gain[a : a + block] = ramp
            gain[b - block : b] = np.minimum(gain[b - block : b], ramp[::-1])
        start = None
    return gain[:n]


def room_tone(wave, sample_rate, level_db=-50.0, seed=0):
    """`wave` (channels, samples) with a white noise at `level_db` (RMS, dBFS) laid into its stretches of digital silence."""
    wave = np.asarray(wave, dtype=np.float64)
    gain = silent_gain(wave, sample_rate)
    if not gain.any():
        return wave
    noise = np.random.default_rng(seed).standard_normal(wave.shape) * 10 ** (level_db / 20)
    return wave + noise * gain


class AfflatusRoomTone(io.ComfyNode):
    """A sound's stretches of digital silence filled with a faint noise, before it is encoded for a model to be pinned to."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusRoomTone",
            display_name="Afflatus: Room Tone",
            category="Afflatus",
            description="Lays a faint white noise into a sound's stretches of exact digital silence (20 ms or more), faded in and out inside them, and leaves the rest as it is. For the copy of a sound LTX is pinned to: exact silence is the floor of its audio VAE's spectrogram, far from any recording's quiet, and LTX 2.3 faded the picture to black over it.",
            inputs=[
                io.Audio.Input("audio", tooltip="The sound to give the model."),
                io.Float.Input("level_db", default=-50.0, min=-90.0, max=-20.0, step=1.0, tooltip="The noise's level, RMS in dBFS."),
                io.Int.Input("seed", default=0, min=0, max=2**31 - 1, tooltip="The noise's seed: the same sound and seed give the same noise."),
            ],
            outputs=[io.Audio.Output(display_name="audio")],
        )

    @classmethod
    def execute(cls, audio, level_db: float = -50.0, seed: int = 0) -> io.NodeOutput:
        import torch

        waveform = audio["waveform"]
        rate = int(audio["sample_rate"])
        out = torch.stack([torch.from_numpy(room_tone(w.detach().float().cpu().numpy(), rate, level_db, seed + i)) for i, w in enumerate(waveform)])
        return io.NodeOutput({**audio, "waveform": out.to(device=waveform.device, dtype=waveform.dtype)})

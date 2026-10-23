"""The sound held as it is while H3 redraws a video: Face refine's crops are sampled again with the clip's own sound.

An H3 latent is a nested pair (video, audio) sampled together. To redraw only the picture, the audio stream is the clip's
own sound encoded, and a noise mask of zeros on it keeps the sampler from touching it, while the video stream is redrawn
as the denoise asks (ones). The picture is still drawn with that sound beside it, so mouths keep to what is heard.
"""

import torch
from comfy.nested_tensor import NestedTensor
from comfy_api.latest import io

from .continuation_nodes import _extract_h3_av_streams


class AfflatusH3AudioLock(io.ComfyNode):
    """Put a clip's sound into an H3 latent's audio stream, masked so that sampling leaves it as it is."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusH3AudioLock",
            display_name="Afflatus: H3 Audio Lock",
            category="Afflatus",
            description="Encodes a sound into a MiniMax H3 latent's audio stream and masks it from the noise: the sampler redraws the video only, with that sound beside it.",
            inputs=[
                io.Latent.Input("av_latent", tooltip="The MiniMax H3 latent to sample (video and audio)."),
                io.Vae.Input("audio_vae", tooltip="H3's audio VAE."),
                io.Audio.Input("audio", tooltip="The sound to hold: the clip's own."),
            ],
            outputs=[io.Latent.Output(display_name="av_latent")],
        )

    @classmethod
    def execute(cls, av_latent, audio_vae, audio) -> io.NodeOutput:
        video, template = _extract_h3_av_streams(av_latent, name="av_latent")
        waveform = audio["waveform"][:1]
        rate = int(audio["sample_rate"])
        wanted = int(getattr(audio_vae, "audio_sample_rate", 32000))
        if rate != wanted:
            # only when the rates differ: the clip's own decoded sound is at the VAE's rate already. ComfyUI's own resample
            # first, since ComfyUI no longer requires torchaudio (2026-09-21); torchaudio for a ComfyUI from before it
            try:
                from comfy.audio import resample
            except ImportError:
                import torchaudio

                resample = torchaudio.functional.resample
            waveform = resample(waveform, rate, wanted)
        sound = audio_vae.encode(waveform.movedim(1, -1))
        # as long as the latent's own audio stream: the sound may end a token early or late against the frames
        want, have = int(template.shape[-1]), int(sound.shape[-1])
        if have > want:
            sound = sound[..., :want]
        elif have < want:
            sound = torch.cat((sound, sound.new_zeros((*sound.shape[:-1], want - have))), dim=-1)
        sound = sound.to(device=template.device, dtype=template.dtype)
        out = dict(av_latent)
        out["samples"] = NestedTensor((video, sound))
        out["noise_mask"] = NestedTensor((torch.ones_like(video), torch.zeros_like(sound)))
        return io.NodeOutput(out)

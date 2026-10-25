"""Keep an LTX video+audio latent, and continue a clip from it: the LTX side of what latent_io.py does for MiniMax H3.

LTX (2.3, 2.5) samples one nested latent, a video stream [1, 128, T, H, W] and an audio stream [1, 8, T_audio, 16]. Its video
VAE is causal: the first token is one frame, every other one eight, so a clip of F frames (8k + 1) has (F - 1) / 8 + 1 tokens.
Its audio runs on a clock of its own (25 steps a second for LTX-2's audio VAE): the steps of a stretch of frames are counted
here as that stretch's share of the latent's own steps, so no VAE and no frame rate are needed to cut it.

A clip carries on from the one before the way LTX's own extend sampler does (ComfyUI-LTXVideo's LTXVExtendSampler): the clip
before's last k tokens pinned at the start of the new latent (LTXVAddLatentGuide, latent_idx 0), its first output token, a
one-frame token standing for those eight frames, set aside. Here the head is that run-up: 8k - 7 frames, 25 for four tokens.
Decoded alone, a clip's decoder starts cold at its first frame; decoded after the clip before's own tokens (the Seam), the
frames from the join on are those of the whole chain decoded at once, and the head shows the clip before's real frames.

File layout: safetensors with tensors "video" and "audio" as sampled, and metadata {"format": "afflatus-ltx-av-latent/1",
"frames": "<pixel frames>", "fps": "<model rate>", "width", "height": "<pixel size>"}.
"""

import os

import folder_paths
import safetensors.torch
import torch
from comfy.nested_tensor import NestedTensor
from comfy_api.latest import io

FORMAT = "afflatus-ltx-av-latent/1"
# the video VAE's steps: 8 frames a token after the first, 32 pixels a token across
TIME_STEP = 8
SPACE_STEP = 32


def ltx_tokens(frames: int) -> int:
    """The video tokens of an LTX clip of `frames` frames (8k + 1)."""
    if frames < 1 or (frames - 1) % TIME_STEP:
        raise ValueError(f"an LTX clip has 8k + 1 frames (9, 17, 25…), not {frames}")
    return (frames - 1) // TIME_STEP + 1


def ltx_frames(tokens: int) -> int:
    """The frames of an LTX video latent of `tokens` tokens."""
    return 1 + TIME_STEP * (tokens - 1)


def run_up_tokens(frames: int) -> int:
    """The clip before's tokens a run-up of `frames` frames is made of: 8k - 7 frames (9, 17, 25…) are k tokens, the first of
    them standing in the new latent's one-frame slot."""
    if frames < 1 or (frames + 7) % TIME_STEP:
        raise ValueError(f"a run-up of the clip before is 8k - 7 frames (1, 9, 17, 25…), not {frames}")
    return (frames + 7) // TIME_STEP


def audio_steps(audio_t: int, frames: int, of_frames: int) -> int:
    """How many of a latent's `audio_t` sound steps the first (or last) `of_frames` of its `frames` frames hold."""
    return max(0, min(audio_t, round(audio_t * of_frames / frames)))


def ltx_streams(latent, name: str):
    """The video and audio streams of an LTX latent, checked: [1, C, T, H, W] and [1, C, T_audio, F]."""
    if not isinstance(latent, dict) or "samples" not in latent:
        raise ValueError(f"{name} is not a latent")
    samples = latent["samples"]
    if not isinstance(samples, NestedTensor) or len(samples.tensors) != 2:
        raise ValueError(f"{name} is not an LTX video+audio latent (a nested pair, video then audio)")
    video, audio = samples.tensors
    if video.ndim != 5 or audio.ndim != 4:
        raise ValueError(f"{name}: an LTX latent's video is [1, C, T, H, W] and its audio [1, C, T, F], not {tuple(video.shape)} and {tuple(audio.shape)}")
    return video, audio


def _av(video, audio):
    return {"samples": NestedTensor((video.contiguous(), audio.contiguous()))}


class AfflatusSaveLTXLatent(io.ComfyNode):
    """Write an LTX video+audio latent to ComfyUI's temp folder, both streams, with its frame count, rate and size."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusSaveLTXLatent",
            display_name="Afflatus: Save LTX Latent",
            category="Afflatus",
            description="Saves an LTX video+audio latent as one safetensors file (both streams) in ComfyUI's temp folder, so that the clip can be continued later from its own latent. Fetch it when the prompt is done: ComfyUI clears the folder when it starts.",
            inputs=[
                io.Latent.Input("samples", tooltip="The sampled LTX latent (video and audio), as it is decoded."),
                io.Float.Input("fps", default=25.0, min=1.0, max=240.0, step=0.001, tooltip="The model's frame rate: written beside the frames."),
                io.String.Input("filename_prefix", default="Afflatus/ltx", tooltip="Where under the temp folder, and how the file is named."),
            ],
            outputs=[],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, samples, fps: float = 25.0, filename_prefix: str = "Afflatus/ltx") -> io.NodeOutput:
        video, audio = ltx_streams(samples, "samples")
        temp_dir = folder_paths.get_temp_directory()
        full_output_folder, filename, counter, subfolder, _prefix = folder_paths.get_save_image_path(filename_prefix, temp_dir)
        os.makedirs(full_output_folder, exist_ok=True)
        name = f"{filename}_{counter:05}_.safetensors"
        metadata = {
            "format": FORMAT,
            "frames": str(ltx_frames(int(video.shape[2]))),
            "fps": f"{fps:g}",
            "width": str(int(video.shape[4]) * SPACE_STEP),
            "height": str(int(video.shape[3]) * SPACE_STEP),
        }
        safetensors.torch.save_file(
            {"video": video.detach().to("cpu").contiguous(), "audio": audio.detach().to("cpu").contiguous()},
            os.path.join(full_output_folder, name),
            metadata=metadata,
        )
        return io.NodeOutput(ui={"latents": [{"filename": name, "subfolder": subfolder, "type": "temp"}]})


class AfflatusLoadLTXLatent(io.ComfyNode):
    """Read an LTX video+audio latent saved by Afflatus: Save LTX Latent."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusLoadLTXLatent",
            display_name="Afflatus: Load LTX Latent",
            category="Afflatus",
            description="Loads an LTX video+audio latent saved by Afflatus: Save LTX Latent. The name may carry ComfyUI's folder annotation (\"name.safetensors [temp]\").",
            inputs=[io.String.Input("latent", default="", tooltip="The file's name in ComfyUI's input, temp or output folder, as an upload answers it.")],
            outputs=[io.Latent.Output(display_name="latent"), io.Int.Output(display_name="frames")],
        )

    @classmethod
    def fingerprint_inputs(cls, latent: str = ""):
        from .latent_io import latent_path

        path = latent_path(latent)
        if path is None:
            return latent
        try:
            return f"{path}:{os.path.getmtime(path)}:{os.path.getsize(path)}"
        except OSError:
            return path

    @classmethod
    def validate_inputs(cls, latent: str = ""):
        from .latent_io import latent_path

        if not latent or latent_path(latent) is None or not folder_paths.exists_annotated_filepath(latent):
            return f"LTX latent file not found: {latent!r}"
        return True

    @classmethod
    def execute(cls, latent: str = "") -> io.NodeOutput:
        from . import read_header
        from .latent_io import latent_path

        path = latent_path(latent)
        if path is None:
            raise ValueError(f"LTX latent file not found: {latent!r}")
        # another model's latent (an H3 one, sent across a change of model) is said, not sampled with
        said = ((read_header(path) or {}).get("__metadata__") or {}).get("format")
        if said is not None and said != FORMAT:
            raise ValueError(f"{os.path.basename(path)} is not an LTX latent ({said})")
        tensors = safetensors.torch.load_file(path, device="cpu")
        if "video" not in tensors or "audio" not in tensors:
            raise ValueError(f"{os.path.basename(path)} is not an Afflatus LTX latent (no video/audio streams)")
        video, audio = ltx_streams({"samples": NestedTensor((tensors["video"].float(), tensors["audio"].float()))}, os.path.basename(path))
        return io.NodeOutput(_av(video, audio), ltx_frames(int(video.shape[2])))


class AfflatusTrimLTXLatent(io.ComfyNode):
    """An LTX latent's first frames (8k + 1) with their sound: a clip handed over before its end is continued from there."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusTrimLTXLatent",
            display_name="Afflatus: Trim LTX Latent",
            category="Afflatus",
            description="Cuts an LTX video+audio latent to its first frames (8k + 1) and the sound under them, for a clip continued from before the end of the one before.",
            inputs=[
                io.Latent.Input("samples", tooltip="An LTX latent (video and audio)."),
                io.Int.Input("frames", default=25, min=1, max=100000, step=8, tooltip="How many first frames to keep: 8k + 1."),
            ],
            outputs=[io.Latent.Output(display_name="latent"), io.Int.Output(display_name="frames")],
        )

    @classmethod
    def execute(cls, samples, frames: int = 25) -> io.NodeOutput:
        video, audio = ltx_streams(samples, "samples")
        tokens = ltx_tokens(frames)
        have = int(video.shape[2])
        if tokens > have:
            raise ValueError(f"the latent holds {ltx_frames(have)} frames, fewer than the {frames} asked")
        steps = audio_steps(int(audio.shape[2]), ltx_frames(have), frames)
        return io.NodeOutput(_av(video[:, :, :tokens], audio[:, :, :steps]), frames)


class AfflatusLTXContinuation(io.ComfyNode):
    """What a clip that carries on from the clip before's latent starts from: that clip's last tokens as the guide, and its
    sound under them laid at the head of the clip's silence and pinned there."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusLTXContinuation",
            display_name="Afflatus: LTX Continuation",
            category="Afflatus",
            description="For an LTX clip carrying on from the clip before's own latent: its last tokens to pin at frame 0 (LTXV Add Latent Guide, latent_idx 0), and the clip's audio latent with that clip's last sound laid at its head and pinned by a noise mask (also given apart, to pin it again on a later pass).",
            inputs=[
                io.Latent.Input("previous_av_latent", tooltip="The clip before's latent (cut to its hand-over frame when it was)."),
                io.Latent.Input("audio_latent", tooltip="The clip's own empty audio latent (Empty LTXV Latent Audio)."),
                io.Int.Input("overlap_frames", default=25, min=1, max=4097, step=8, tooltip="The run-up in frames: 8k - 7 (9, 17, 25…), k tokens of the clip before."),
            ],
            outputs=[io.Latent.Output(display_name="video_guide"), io.Latent.Output(display_name="audio_latent"), io.Mask.Output(display_name="audio_mask")],
        )

    @classmethod
    def execute(cls, previous_av_latent, audio_latent, overlap_frames: int = 25) -> io.NodeOutput:
        video, audio = ltx_streams(previous_av_latent, "previous_av_latent")
        k = run_up_tokens(overlap_frames)
        have = int(video.shape[2])
        if k > have:
            raise ValueError(f"the clip before has {ltx_frames(have)} frames, too few for a run-up of {overlap_frames}")
        guide = dict(previous_av_latent)
        guide["samples"] = video[:, :, have - k :].contiguous()
        guide.pop("noise_mask", None)
        silence = audio_latent["samples"]
        if silence.ndim != 4 or tuple(silence.shape[:2]) != tuple(audio.shape[:2]) or silence.shape[3] != audio.shape[3]:
            raise ValueError(f"the clip's audio latent {tuple(silence.shape)} is not the clip before's kind {tuple(audio.shape)}")
        # the sound of the clip before's last overlap_frames, counted on that clip's own frames and steps
        steps = min(audio_steps(int(audio.shape[2]), ltx_frames(have), overlap_frames), int(silence.shape[2]))
        tail = audio[:, :, int(audio.shape[2]) - steps :].to(device=silence.device, dtype=silence.dtype)
        laid = torch.cat([tail, silence[:, :, steps:]], dim=2)
        mask = torch.cat([torch.zeros_like(silence[:, :1, :steps]), torch.ones_like(silence[:, :1, steps:])], dim=2).squeeze(1)
        out = dict(audio_latent)
        out["samples"] = laid.contiguous()
        out["noise_mask"] = mask
        return io.NodeOutput(guide, out, mask)


class AfflatusLTXSeamLatent(io.ComfyNode):
    """A continuation's video tokens to decode as one piece with the clip before: that clip's own last tokens, then the new ones."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusLTXSeamLatent",
            display_name="Afflatus: LTX Seam Latent",
            category="Afflatus",
            description="For decoding an LTX continuation as one piece with the clip before: the clip before's last tokens (its run-up, and `context` more before it), then the continuation's tokens after its run-up. Decoded, the first context × 8 frames are the clip before's and are dropped; the rest is the continuation, its head the clip before's real frames.",
            inputs=[
                io.Latent.Input("previous_av_latent", tooltip="The clip before's latent, as the continuation was made from it."),
                io.Latent.Input("sampled", tooltip="The continuation's video latent after sampling, its guides taken out (its run-up, then its own frames)."),
                io.Int.Input("overlap_frames", default=25, min=1, max=4097, step=8, tooltip="The run-up in frames: 8k - 7."),
                io.Int.Input("context", default=4, min=0, max=64, tooltip="Tokens of the clip before put before the run-up for the decoder to start on: their 8 × context frames are dropped after decoding."),
            ],
            outputs=[io.Latent.Output(display_name="latent")],
        )

    @classmethod
    def execute(cls, previous_av_latent, sampled, overlap_frames: int = 25, context: int = 4) -> io.NodeOutput:
        prev, _sound = ltx_streams(previous_av_latent, "previous_av_latent")
        new = sampled["samples"]
        if isinstance(new, NestedTensor):
            new = new.tensors[0]
        k = run_up_tokens(overlap_frames)
        have = int(prev.shape[2])
        if k + context > have:
            raise ValueError(f"the clip before has {have} tokens, fewer than the run-up's {k} and {context} of context")
        if int(new.shape[2]) <= k:
            raise ValueError("the continuation holds no frames of its own after its run-up")
        if tuple(prev.shape[:2]) != tuple(new.shape[:2]) or tuple(prev.shape[3:]) != tuple(new.shape[3:]):
            raise ValueError(f"the clip before's latent {tuple(prev.shape)} and the continuation {tuple(new.shape)} are not the same size")
        lead = prev[:, :, have - k - context :].to(device=new.device, dtype=new.dtype)
        out = dict(sampled)
        out.pop("noise_mask", None)
        out["samples"] = torch.cat([lead, new[:, :, k:]], dim=2).contiguous()
        return io.NodeOutput(out)

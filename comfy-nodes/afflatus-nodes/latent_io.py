"""Save and load a MiniMax H3 video+audio latent as one safetensors file.

ComfyUI's own SaveLatent writes `samples["samples"]` as a single tensor; H3's latent is a nested pair
(video, audio), so it cannot be stored that way. These two nodes keep both streams, with the frame count
in the file's metadata, so that a finished clip's latent can be continued later with the MiniMax H3
continuation nodes (Guided Continuation Window, Latent Tail Guide, Append Continuation).

File layout: safetensors with tensors "video" [1, 24, T, H, W] and "audio" [1, 32, 2, T_audio], and
metadata {"format": "afflatus-h3-av-latent/1", "frames": "<pixel frames>"}.
"""

import json
import os

import comfy.utils
import folder_paths
import node_helpers
import safetensors.torch
import torch
from comfy.nested_tensor import NestedTensor
from comfy_api.latest import io

from .continuation_nodes import (
    FPS,
    _existing_keyframes,
    _extract_h3_av_streams,
    _reject_conflicting_head_guides,
    _require_native_arbitrary_guides,
    _validate_append_compatibility,
    _validate_overlap_tokens,
    audio_t_at_frame_boundary,
    frame_count_from_video_latent_t,
    validate_h3_av_latent,
    validate_h3_av_window,
    video_latent_t,
)

FORMAT = "afflatus-h3-av-latent/1"


class AfflatusSaveH3Latent(io.ComfyNode):
    """Write an H3 video+audio latent to ComfyUI's output folder, both streams, with the frame count."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusSaveH3Latent",
            display_name="Afflatus: Save H3 Latent",
            category="Afflatus",
            description="Saves a MiniMax H3 video+audio latent as one safetensors file (both streams), so that the clip can be continued later from its own latent.",
            inputs=[
                io.Latent.Input("samples", tooltip="The sampled MiniMax H3 latent (video and audio)."),
                io.String.Input("filename_prefix", default="Afflatus/h3", tooltip="Where under the output folder, and how the file is named."),
            ],
            outputs=[],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, samples, filename_prefix: str = "Afflatus/h3") -> io.NodeOutput:
        video, audio = _extract_h3_av_streams(samples, name="samples")
        output_dir = folder_paths.get_output_directory()
        full_output_folder, filename, counter, subfolder, _prefix = folder_paths.get_save_image_path(filename_prefix, output_dir)
        name = f"{filename}_{counter:05}_.safetensors"
        path = os.path.join(full_output_folder, name)
        frames = frame_count_from_video_latent_t(int(video.shape[2]))
        metadata = {"format": FORMAT, "frames": str(frames), "fps": str(FPS)}
        safetensors.torch.save_file(
            {"video": video.detach().to("cpu").contiguous(), "audio": audio.detach().to("cpu").contiguous()},
            path,
            metadata=metadata,
        )
        results = [{"filename": name, "subfolder": subfolder, "type": "output"}]
        return io.NodeOutput(ui={"latents": results})


class AfflatusLoadH3Latent(io.ComfyNode):
    """Read an H3 video+audio latent saved by Afflatus: Save H3 Latent (an uploaded file, or one of the input folder)."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusLoadH3Latent",
            display_name="Afflatus: Load H3 Latent",
            category="Afflatus",
            description="Loads a MiniMax H3 video+audio latent saved by Afflatus: Save H3 Latent. The name may carry ComfyUI's folder annotation (\"name.safetensors [temp]\").",
            inputs=[
                io.String.Input("latent", default="", tooltip="The file's name in ComfyUI's input or temp folder, as an upload answers it."),
            ],
            outputs=[io.Latent.Output(display_name="latent"), io.Int.Output(display_name="frames")],
        )

    @classmethod
    def fingerprint_inputs(cls, latent: str = ""):
        path = folder_paths.get_annotated_filepath(latent)
        try:
            return f"{path}:{os.path.getmtime(path)}:{os.path.getsize(path)}"
        except OSError:
            return path

    @classmethod
    def validate_inputs(cls, latent: str = ""):
        if not latent or not folder_paths.exists_annotated_filepath(latent):
            return f"H3 latent file not found: {latent!r}"
        return True

    @classmethod
    def execute(cls, latent: str = "") -> io.NodeOutput:
        path = folder_paths.get_annotated_filepath(latent)
        tensors = safetensors.torch.load_file(path, device="cpu")
        if "video" not in tensors or "audio" not in tensors:
            raise ValueError(f"{os.path.basename(path)} is not an Afflatus H3 latent (no video/audio streams)")
        # ComfyUI samples its latents in float32: the continuation nodes want the previous latent to match
        video = tensors["video"].float()
        audio = tensors["audio"].float()
        frames = frame_count_from_video_latent_t(int(video.shape[2]))
        return io.NodeOutput({"samples": NestedTensor((video, audio))}, frames)


def read_frames(path: str) -> int:
    """The frame count of a saved latent, from its header alone (no tensors read)."""
    with open(path, "rb") as f:
        n = int.from_bytes(f.read(8), "little")
        header = json.loads(f.read(n))
    meta = header.get("__metadata__") or {}
    return int(meta.get("frames", 0))


class AfflatusNormalizeH3Latent(io.ComfyNode):
    """Round a sampled H3 window's audio to its own frame boundary, so that it can be continued from later."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusNormalizeH3Latent",
            display_name="Afflatus: Normalize H3 Latent",
            category="Afflatus",
            description="A sampled MiniMax H3 continuation window carries its audio on the previous run's boundaries, one token more or less than its own frame count says. This trims or pads it to its own boundary, so the window is a valid clip to continue from.",
            inputs=[io.Latent.Input("samples", tooltip="A sampled MiniMax H3 latent (video and audio).")],
            outputs=[io.Latent.Output(display_name="latent"), io.Int.Output(display_name="frames")],
        )

    @classmethod
    def execute(cls, samples) -> io.NodeOutput:
        video, audio = _extract_h3_av_streams(samples, name="samples")
        frames = frame_count_from_video_latent_t(int(video.shape[2]))
        want = audio_t_at_frame_boundary(frames)
        have = int(audio.shape[-1])
        if have > want:
            audio = audio[..., :want]
        elif have < want:
            audio = torch.cat((audio, audio.new_zeros((*audio.shape[:-1], want - have))), dim=-1)
        return io.NodeOutput({"samples": NestedTensor((video, audio))}, frames)


class AfflatusH3LatentHeadGuide(io.ComfyNode):
    """Anchor the first tokens of the clip after at the end of a continuation window: the clip arrives at it."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusH3LatentHeadGuide",
            display_name="Afflatus: H3 Latent Head Guide",
            category="Afflatus",
            description="Adds the clip after's first tokens (video and audio, from its own latent) as a native H3 guide at the last frames of the window being sampled, so the clip lands exactly where the clip after begins. The counterpart of the Latent Tail Guide at frame zero.",
            inputs=[
                io.Conditioning.Input("positive", tooltip="Positive conditioning for the window (after the tail guide, when there is one)."),
                io.Latent.Input("next_av_latent", tooltip="The clip after's own latent (a sampled window, normalized)."),
                io.Latent.Input("target_av_latent", tooltip="The window that will be sampled."),
                io.Int.Input("guide_frames", default=22, min=5, max=3600, step=17, tooltip="How many of its first frames are pinned at the end: 5, 22 or 39 (17k + 5)."),
                io.Int.Input("skip_frames", default=0, min=0, max=3600, step=17, tooltip="Frames of the clip after to skip first: its own overlap with the clip it extended (0, 5, 22, 39…: 0 or 17k + 5)."),
            ],
            outputs=[io.Conditioning.Output(display_name="positive")],
            is_experimental=True,
        )

    @classmethod
    def execute(cls, positive, next_av_latent, target_av_latent, guide_frames: int = 22, skip_frames: int = 0) -> io.NodeOutput:
        _require_native_arbitrary_guides()
        next_video, next_audio = _extract_h3_av_streams(next_av_latent, name="next_av_latent")
        target_video, _target_audio, target_frames = validate_h3_av_window(target_av_latent, name="target_av_latent")
        if guide_frames % 17 != 5:
            raise ValueError("guide_frames must be 5, 22, 39… (17k + 5)")
        if skip_frames != 0 and skip_frames % 17 != 5:
            raise ValueError("skip_frames must be 0 or 17k + 5")
        skip_t = 0 if skip_frames == 0 else video_latent_t(skip_frames)
        guide_t = video_latent_t(guide_frames)
        if skip_t + guide_t > int(next_video.shape[2]):
            raise ValueError(f"the clip after's latent has {int(next_video.shape[2])} video tokens: not enough for {skip_frames} skipped + {guide_frames} guide frames")
        skip_a = audio_t_at_frame_boundary(skip_frames)
        guide_a = audio_t_at_frame_boundary(skip_frames + guide_frames) - skip_a
        have_a = int(next_audio.shape[-1])
        if skip_a >= have_a:
            raise ValueError("the clip after's audio latent is shorter than the frames to skip")
        guide_a = min(guide_a, have_a - skip_a)
        at = target_frames - guide_frames
        if at < 0:
            raise ValueError(f"a {guide_frames}-frame guide does not fit in a {target_frames}-frame window")
        if next_video.dtype != target_video.dtype:
            next_video = next_video.to(target_video.dtype)
            next_audio = next_audio.to(target_video.dtype)
        keyframes = _existing_keyframes(positive)
        for k in keyframes:
            end = float(k["resolved_frame_index"]) + int(k["latent"].shape[2]) * 17 / 5
            if end > at:
                raise ValueError("another guide reaches into the window's last frames: the head guide needs them")
        keyframes.append(
            {
                "resolved_frame_index": at,
                "latent": next_video[:, :, skip_t : skip_t + guide_t].clone(),
                "audio_latent": next_audio[..., skip_a : skip_a + guide_a].clone(),
            }
        )
        keyframes.sort(key=lambda keyframe: float(keyframe["resolved_frame_index"]))
        return io.NodeOutput(node_helpers.conditioning_set_values(positive, {"minimax_keyframes": keyframes}))


class AfflatusH3TailGuide(io.ComfyNode):
    """The clip before's tail as the frame-zero guide: its decoded frames re-encoded for the picture, its own latent for the sound.

    Measured on chains of continuations (Afflatus, 2026-10-05): a window guided by the clip before's *sampled*
    latent reproduces that tail almost exactly (correlation 0.999), but 2 to 4 % wider in every latent channel,
    with the same small per-channel biases at every hop. Nothing re-anchors the chain to real pixels, so the
    error compounds: clip after clip the picture gets softer and darker. A guide encoded from the decoded frames
    has no such direction (the VAE's encoder puts it back on its own manifold), and a chain of those stays flat.
    The sound shows no drift and the exact audio latent keeps the voice, so it is used as it is.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusH3TailGuide",
            display_name="Afflatus: H3 Tail Guide",
            category="Afflatus",
            description="Conditions a continuation window on the clip before's tail like the MiniMax H3 Latent Tail Guide, but the picture guide is encoded from the clip's decoded frames (connect its last frames and the video VAE) while the sound guide stays its exact audio latent. The round trip re-anchors each clip to real pixels: a chain continued from exact latents gets softer and darker clip after clip, the sound does not drift and keeps the voice. Without frames it is the exact latent tail guide.",
            inputs=[
                io.Conditioning.Input("positive", tooltip="Positive conditioning for the complete continuation window."),
                io.Latent.Input("previous_av_latent", tooltip="The clip before's own latent (as Load H3 Latent gives it)."),
                io.Latent.Input("target_av_latent", tooltip="The continuation window that will be sampled."),
                io.Int.Input("overlap_video_tokens", min=1, force_input=True),
                io.Int.Input("overlap_audio_tokens", min=1, force_input=True),
                io.Image.Input("frames", optional=True, tooltip="The clip before's last frames, as the model made them (at least as many as the overlap: 22 for 7 tokens; the last ones are taken). Resized to the window's frame."),
                io.Vae.Input("vae", optional=True, tooltip="The MiniMax H3 video VAE, to encode the frames."),
            ],
            outputs=[io.Conditioning.Output(display_name="positive")],
            is_experimental=True,
        )

    @classmethod
    def execute(cls, positive, previous_av_latent, target_av_latent, overlap_video_tokens: int, overlap_audio_tokens: int, frames=None, vae=None) -> io.NodeOutput:
        _require_native_arbitrary_guides()
        previous_video, previous_audio, previous_frame_count = validate_h3_av_latent(previous_av_latent, name="previous_av_latent")
        target_video, target_audio, _target_frames = validate_h3_av_window(target_av_latent, name="target_av_latent")
        _validate_append_compatibility(previous_video, previous_audio, target_video, target_audio)
        _validate_overlap_tokens(overlap_video_tokens, overlap_audio_tokens, int(target_video.shape[2]), int(target_audio.shape[-1]), previous_frame_count)
        guide_frames = frame_count_from_video_latent_t(overlap_video_tokens)
        if frames is not None:
            if vae is None:
                raise ValueError("encoding the frames needs the vae input (the MiniMax H3 video VAE)")
            if int(frames.shape[0]) < guide_frames:
                raise ValueError(f"the tail guide needs the clip before's last {guide_frames} frames, got {int(frames.shape[0])}")
            height = int(target_video.shape[3]) * 16
            width = int(target_video.shape[4]) * 16
            tail = frames[-guide_frames:][..., :3].movedim(-1, 1)
            tail = comfy.utils.common_upscale(tail, width, height, "lanczos", "center").movedim(1, -1)
            video_guide = vae.encode(tail)
            if video_guide.ndim != 5 or int(video_guide.shape[2]) != overlap_video_tokens:
                raise ValueError(f"the encoded frames give {tuple(video_guide.shape)}: not the {overlap_video_tokens} video tokens of the overlap")
            video_guide = video_guide.to(device=target_video.device, dtype=target_video.dtype)
        else:
            video_guide = previous_video[:, :, -overlap_video_tokens:].clone()
        keyframes = _existing_keyframes(positive)
        _reject_conflicting_head_guides(keyframes, guide_frames)
        keyframes.append(
            {
                "resolved_frame_index": 0,
                "latent": video_guide,
                "audio_latent": previous_audio[..., -overlap_audio_tokens:].clone(),
            }
        )
        keyframes.sort(key=lambda keyframe: float(keyframe["resolved_frame_index"]))
        return io.NodeOutput(node_helpers.conditioning_set_values(positive, {"minimax_keyframes": keyframes}))

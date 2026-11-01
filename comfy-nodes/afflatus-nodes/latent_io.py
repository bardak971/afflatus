"""Save and load a MiniMax H3 video+audio latent as one safetensors file.

ComfyUI's own SaveLatent writes `samples["samples"]` as a single tensor; H3's latent is a nested pair
(video, audio), so it cannot be stored that way. These two nodes keep both streams, with the frame count
in the file's metadata, so that a finished clip's latent can be continued later with the MiniMax H3
continuation nodes (Guided Continuation Window, Latent Tail Guide, Append Continuation).

File layout: safetensors with tensors "video" [1, 24, T, H, W] and "audio" [1, 32, 2, T_audio], and
metadata {"format": "afflatus-h3-av-latent/1", "frames": "<pixel frames>"}, and "runup_width" for a continuation window
whose fine detail H3 Run-up Match corrected (its run-up width as sampled, pack 0.45.0).
"""

import os
import re

import comfy.utils
import numpy as np
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
    """Write an H3 video+audio latent to ComfyUI's temp folder, both streams, with the frame count.

    Afflatus downloads it as soon as the prompt is done and keeps it itself: in the temp folder, which ComfyUI
    clears when it starts, one is not left behind for every render the way the output folder would keep them.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusSaveH3Latent",
            display_name="Afflatus: Save H3 Latent",
            category="Afflatus",
            description="Saves a MiniMax H3 video+audio latent as one safetensors file (both streams) in ComfyUI's temp folder, so that the clip can be continued later from its own latent. Fetch it when the prompt is done: ComfyUI clears the folder when it starts.",
            inputs=[
                io.Latent.Input("samples", tooltip="The sampled MiniMax H3 latent (video and audio)."),
                io.String.Input("filename_prefix", default="Afflatus/h3", tooltip="Where under the temp folder, and how the file is named."),
            ],
            outputs=[],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, samples, filename_prefix: str = "Afflatus/h3") -> io.NodeOutput:
        video, audio = _extract_h3_av_streams(samples, name="samples")
        temp_dir = folder_paths.get_temp_directory()
        full_output_folder, filename, counter, subfolder, _prefix = folder_paths.get_save_image_path(filename_prefix, temp_dir)
        os.makedirs(full_output_folder, exist_ok=True)
        name = f"{filename}_{counter:05}_.safetensors"
        path = os.path.join(full_output_folder, name)
        frames = frame_count_from_video_latent_t(int(video.shape[2]))
        metadata = {"format": FORMAT, "frames": str(frames), "fps": str(FPS)}
        if samples.get(RUNUP_KEY) is not None and np.isfinite(samples[RUNUP_KEY]):
            metadata["runup_width"] = f"{float(samples[RUNUP_KEY]):.4f}"
        safetensors.torch.save_file(
            {"video": video.detach().to("cpu").contiguous(), "audio": audio.detach().to("cpu").contiguous()},
            path,
            metadata=metadata,
        )
        results = [{"filename": name, "subfolder": subfolder, "type": "temp"}]
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
                io.String.Input("latent", default="", tooltip="The file's name in ComfyUI's input, temp or output folder, as an upload answers it (\"name.safetensors [temp]\")."),
            ],
            outputs=[io.Latent.Output(display_name="latent"), io.Int.Output(display_name="frames")],
        )

    @classmethod
    def fingerprint_inputs(cls, latent: str = ""):
        path = latent_path(latent)
        if path is None:
            return latent
        try:
            return f"{path}:{os.path.getmtime(path)}:{os.path.getsize(path)}"
        except OSError:
            return path

    @classmethod
    def validate_inputs(cls, latent: str = ""):
        if not latent or latent_path(latent) is None or not folder_paths.exists_annotated_filepath(latent):
            return f"H3 latent file not found: {latent!r}"
        return True

    @classmethod
    def execute(cls, latent: str = "") -> io.NodeOutput:
        path = latent_path(latent)
        if path is None:
            raise ValueError(f"H3 latent file not found: {latent!r}")
        tensors = safetensors.torch.load_file(path, device="cpu")
        if "video" not in tensors or "audio" not in tensors:
            raise ValueError(f"{os.path.basename(path)} is not an Afflatus H3 latent (no video/audio streams)")
        # ComfyUI samples its latents in float32: the continuation nodes want the previous latent to match
        video = tensors["video"].float()
        audio = tensors["audio"].float()
        frames = frame_count_from_video_latent_t(int(video.shape[2]))
        out = {"samples": NestedTensor((video, audio))}
        # the run-up width as sampled, when Run-up Match wrote it: a finish keeps the draft's latent, and its figure with it
        from . import read_header

        width = ((read_header(path) or {}).get("__metadata__") or {}).get("runup_width")
        if isinstance(width, str) and re.fullmatch(r"\d+(\.\d+)?", width):
            out[RUNUP_KEY] = float(width)
        return io.NodeOutput(out, frames)


def latent_path(name: str):
    """Where a latent named as an upload answers it is ("x.safetensors [temp]"): only a .safetensors file inside the folder its annotation names (input without one; temp; output), else None.

    The name comes from the prompt: ComfyUI resolves it against the folder its annotation names, so a name that
    climbs out of it ("../") or a link that points elsewhere is refused here, once the path is resolved for real.
    A latent this ComfyUI saved itself is named where it is (" [temp]", or " [output]" for one written there): a
    continuation on the same machine reads it in place rather than being sent it again (pack 0.36.5).
    """
    if not name:
        return None
    path = os.path.realpath(folder_paths.get_annotated_filepath(name))
    if not path.lower().endswith(".safetensors"):
        return None
    if name.endswith(" [output]"):
        root = folder_paths.get_output_directory()
    elif name.endswith(" [temp]"):
        root = folder_paths.get_temp_directory()
    else:
        root = folder_paths.get_input_directory()
    root = os.path.realpath(root)
    try:
        inside = os.path.commonpath([root, path]) == root and path != root
    except ValueError:
        # another drive
        inside = False
    return path if inside else None


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
        return io.NodeOutput(with_runup({"samples": NestedTensor((video, audio))}, samples), frames)


class AfflatusTrimH3Latent(io.ComfyNode):
    """The first frames of an H3 video+audio latent: a clip handed over before its end is continued from there."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusTrimH3Latent",
            display_name="Afflatus: Trim H3 Latent",
            category="Afflatus",
            description="Keeps the first frames of a MiniMax H3 video+audio latent (a count on the 17k + 5 grid): the video tokens that hold them and the audio up to their last frame. A clip that ends frozen is continued from where it still moved.",
            inputs=[
                io.Latent.Input("samples", tooltip="A MiniMax H3 latent (video and audio)."),
                io.Int.Input("frames", default=5, min=5, max=100000, tooltip="How many frames to keep, on the 17k + 5 grid (5, 22, 39, …)."),
            ],
            outputs=[io.Latent.Output(display_name="latent"), io.Int.Output(display_name="frames")],
        )

    @classmethod
    def execute(cls, samples, frames: int = 5) -> io.NodeOutput:
        video, audio = _extract_h3_av_streams(samples, name="samples")
        have = frame_count_from_video_latent_t(int(video.shape[2]))
        if frames > have:
            raise ValueError(f"the latent holds {have} frames, fewer than the {frames} to keep")
        tokens = video_latent_t(frames)
        video = video[:, :, :tokens]
        audio = audio[..., : audio_t_at_frame_boundary(frames)]
        return io.NodeOutput({"samples": NestedTensor((video.contiguous(), audio.contiguous()))}, frames)


def guide_frames_of(keyframe) -> int:
    """How many frames a guide already on the conditioning spans; 0 when it holds no video latent."""
    latent = keyframe.get("latent")
    if latent is None:
        return 0
    tokens = int(latent.shape[2])
    try:
        return frame_count_from_video_latent_t(tokens)
    except ValueError:
        # off the 5k + 2 grid (a picture's guide is one token): one frame for the first token, four for each after
        return 1 + 4 * (tokens - 1) if tokens > 0 else 0


def land_guide(positive, next_av_latent, target_av_latent, guide_frames: int, start_t: int, start_frame: int, what: str):
    """The clip after's frames from `start_frame` (its video tokens from `start_t`) pinned at the end of the window: the conditioning with that guide added.

    The Head Guide starts at a frame of the 17k + 5 grid, the Landing where a chunk begins; the rest is the same.
    `what` names the guide in the error when another guide already holds the window's last frames.
    """
    _require_native_arbitrary_guides()
    next_video, next_audio = _extract_h3_av_streams(next_av_latent, name="next_av_latent")
    target_video, _target_audio, target_frames = validate_h3_av_window(target_av_latent, name="target_av_latent")
    if guide_frames % 17 != 5:
        raise ValueError("guide_frames must be 5, 22, 39… (17k + 5)")
    # the clip after made at another frame size: its tokens are not this window's, and sampling would fail only after the
    # model loaded (or place them wrong). Afflatus lands on its frames then; this says why when a graph asks anyway
    if next_video.shape[:2] != target_video.shape[:2] or next_video.shape[3:] != target_video.shape[3:]:
        raise ValueError(f"the clip after's latent {tuple(next_video.shape)} and the window {tuple(target_video.shape)} are not the same frame size")
    guide_t = video_latent_t(guide_frames)
    if start_t + guide_t > int(next_video.shape[2]):
        raise ValueError(f"the clip after's latent has {int(next_video.shape[2])} video tokens: not enough for {guide_frames} guide frames from its frame {start_frame}")
    start_a = audio_t_at_frame_boundary(start_frame)
    guide_a = audio_t_at_frame_boundary(start_frame + guide_frames) - start_a
    have_a = int(next_audio.shape[-1])
    if start_a >= have_a:
        raise ValueError(f"the clip after's audio latent is shorter than its frame {start_frame}")
    guide_a = min(guide_a, have_a - start_a)
    at = target_frames - guide_frames
    if at < 0:
        raise ValueError(f"a {guide_frames}-frame guide does not fit in a {target_frames}-frame window")
    if next_video.dtype != target_video.dtype:
        next_video = next_video.to(target_video.dtype)
        next_audio = next_audio.to(target_video.dtype)
    keyframes = _existing_keyframes(positive)
    for k in keyframes:
        if float(k["resolved_frame_index"]) + guide_frames_of(k) > at:
            raise ValueError(f"another guide reaches into the window's last frames: {what} needs them")
    keyframes.append(
        {
            "resolved_frame_index": at,
            "latent": next_video[:, :, start_t : start_t + guide_t].clone(),
            "audio_latent": next_audio[..., start_a : start_a + guide_a].clone(),
        }
    )
    keyframes.sort(key=lambda keyframe: float(keyframe["resolved_frame_index"]))
    return node_helpers.conditioning_set_values(positive, {"minimax_keyframes": keyframes})


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
        if skip_frames != 0 and skip_frames % 17 != 5:
            raise ValueError("skip_frames must be 0 or 17k + 5")
        skip_t = 0 if skip_frames == 0 else video_latent_t(skip_frames)
        return io.NodeOutput(land_guide(positive, next_av_latent, target_av_latent, guide_frames, skip_t, skip_frames, "the head guide"))


class AfflatusH3LatentLanding(io.ComfyNode):
    """Anchor tokens from anywhere in the clip after at the end of a window: a clip lands inside another, on time.

    H3 packs its video latent in chunks of 17 frames, five tokens each: one token for one frame, then four of four
    frames (comfy/ldm/minimax FRAME_PER_TOKEN). A guide is laid out as a sequence of its own, so its first token is
    taken for a one-frame one. Sliced at a frame of the 17k + 5 grid (the Head Guide's skip), it starts on a
    four-frame token: every token got the wrong time span and a landing 56 frames in came out 6 frames late
    (Afflatus, measured 2026-10-07). Sliced where a chunk begins (frame 17j), the guide's spans are its own.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusH3LatentLanding",
            display_name="Afflatus: H3 Latent Landing",
            category="Afflatus",
            description="Adds frames of the clip after (video and audio, from its own latent), starting where one of its 17-frame chunks begins, as a native H3 guide at the last frames of the window being sampled: the clip lands on the clip after at that moment, exactly.",
            inputs=[
                io.Conditioning.Input("positive", tooltip="Positive conditioning for the window (after the tail guide, when there is one)."),
                io.Latent.Input("next_av_latent", tooltip="The clip after's own latent (a sampled window, normalized)."),
                io.Latent.Input("target_av_latent", tooltip="The window that will be sampled."),
                io.Int.Input("guide_frames", default=22, min=5, max=3600, step=17, tooltip="How many of its frames are pinned at the end: 5, 22 or 39 (17k + 5)."),
                io.Int.Input("land_at", default=0, min=0, max=100000, step=17, tooltip="The frame of the clip after to land on, where a chunk begins: 0, 17, 34… (17j)."),
            ],
            outputs=[io.Conditioning.Output(display_name="positive")],
            is_experimental=True,
        )

    @classmethod
    def execute(cls, positive, next_av_latent, target_av_latent, guide_frames: int = 22, land_at: int = 0) -> io.NodeOutput:
        if land_at % 17 != 0:
            raise ValueError("land_at must be where a chunk begins: 0, 17, 34… (17j)")
        start_t = (land_at // 17) * 5
        return io.NodeOutput(land_guide(positive, next_av_latent, target_av_latent, guide_frames, start_t, land_at, "the landing"))


class AfflatusH3SeamLatent(io.ComfyNode):
    """A continuation's frames to decode as one piece with the clip before: that clip's last tokens, then the new ones.

    A clip decoded on its own starts its decoder cold at its own first frame, and its hidden overlap is the model's
    copy of the clip before, never quite the same: decoded separately, the two sides of a join always differ a
    little. H3's video decoder works in 17-frame chunks with no memory past one chunk: a stretch decoded from a
    chunk boundary matches the whole timeline decoded at once from its sixth frame on (measured 2026-10-08, PSNR
    identical). So the window's overlap tokens are replaced by the clip before's own last tokens (as many, from a
    chunk boundary), and the new tokens follow: decoded, the frames from the join on are exactly those of the whole
    chain decoded in one piece, and the overlap shows the clip before's real frames. Same frame count as the window.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusH3SeamLatent",
            display_name="Afflatus: H3 Seam Latent",
            category="Afflatus",
            description="For decoding a continuation as one piece with the clip before: the window's hidden overlap replaced by the clip before's own last tokens (video and audio), the new tokens after them. Decoded, the join matches the whole chain decoded at once.",
            inputs=[
                io.Latent.Input("previous_av_latent", tooltip="The clip before's latent, as the window was made from it (cut to its hand-over frame when it was)."),
                io.Latent.Input("sampled_window", tooltip="The continuation window after sampling (overlap, then the new frames)."),
                io.Int.Input("overlap_frames", default=22, min=5, max=3600, step=17, tooltip="The window's hidden overlap in frames: 5, 22, 39… (17k + 5)."),
            ],
            outputs=[io.Latent.Output(display_name="latent")],
        )

    @classmethod
    def execute(cls, previous_av_latent, sampled_window, overlap_frames: int = 22) -> io.NodeOutput:
        prev_video, prev_audio = _extract_h3_av_streams(previous_av_latent, name="previous_av_latent")
        win_video, win_audio = _extract_h3_av_streams(sampled_window, name="sampled_window")
        overlap_t = video_latent_t(overlap_frames)
        prev_t = int(prev_video.shape[2])
        prev_frames = frame_count_from_video_latent_t(prev_t)
        if prev_t < overlap_t:
            raise ValueError(f"the clip before has {prev_frames} frames, fewer than the {overlap_frames} the window overlaps")
        if int(win_video.shape[2]) <= overlap_t:
            raise ValueError("the window holds no new frames after its overlap")
        if prev_video.shape[:2] != win_video.shape[:2] or prev_video.shape[3:] != win_video.shape[3:]:
            raise ValueError("the clip before's latent and the window are not the same size")
        # both counts are 5k + 2: the clip before's last overlap_t tokens start on a chunk boundary
        lead = prev_video[:, :, prev_t - overlap_t:].to(device=win_video.device, dtype=win_video.dtype)
        video = torch.cat([lead, win_video[:, :, overlap_t:]], dim=2)
        # the sound: as many of the clip before's last tokens as the window's overlap holds, and the window's own after
        # those. The window counted its overlap on the clip before's clock (MiniMaxH3GuidedContinuationWindow): after a
        # 107-frame clip that is 36 tokens, where the overlap on its own clock (audio_t(22)) is 37. Skipping 37 lost a
        # token of the new sound at the join: a 25 ms jump there, and the file's sound a token short of its picture
        # (measured on Timeline 24's kept latents, 2026-10-21)
        lead_audio = prev_audio[..., audio_t_at_frame_boundary(prev_frames - overlap_frames):].to(device=win_audio.device, dtype=win_audio.dtype)
        audio = torch.cat([lead_audio, win_audio[..., int(lead_audio.shape[-1]):]], dim=-1)
        return io.NodeOutput({"samples": NestedTensor((video.contiguous(), audio.contiguous()))})


# The key of a latent's dict that carries a window's run-up width as sampled (before Run-up Match corrected it): Normalize
# passes it on, Save writes it into the file's metadata ("runup_width") and Load reads it back, so that Afflatus's figure of
# the creep still reads what the model made, not what the corrected kept latent reads.
RUNUP_KEY = "afflatus_runup_width"
# A run-up guided by the exact latent copies it at a correlation of 0.999 (2026-10-05). Under this, the window left its
# guide (a cut): there is no copy to match, and a new shot's look must not be pulled to the clip before's.
RUNUP_MIN_CORRELATION = 0.98
# What the match may undo, per channel: the fine detail's growth past the broad picture's, 1.019 to 1.031 on average at
# the ten joins of the 2026-11-01 pod test (a cut and a flash among them). Past this it is not the sampler's creep, and the
# window is left as it was sampled.
RUNUP_GAIN = (0.9, 1.1)


def detail_and_broad(tokens):
    """`tokens` [channels, n, h, w] (each channel's n tokens of h by w) split into its fine detail and its broad picture:
    the broad picture is each token's 3x3 box blur (its edges repeated), the fine detail what the blur leaves out."""
    t = np.asarray(tokens, dtype=np.float64)
    h, w = t.shape[2:]
    p = np.pad(t, ((0, 0), (0, 0), (1, 1), (1, 1)), mode="edge")
    broad = sum(p[:, :, 1 + dy : 1 + dy + h, 1 + dx : 1 + dx + w] for dy in (-1, 0, 1) for dx in (-1, 0, 1)) / 9
    return t - broad, broad


class RunUpMatch:
    """What Run-up Match does to a window: `scale` per channel, what its fine detail is multiplied by (None when it is left
    as sampled, `why` then says why), the run-up's width as sampled (the mean over the channels of its spread over the
    tail's, as Afflatus reads it from two latents), its correlation with the tail, and `gain` per channel, the fine
    detail's growth the match takes back (None on a flat channel)."""

    def __init__(self, width, correlation, gain=None, scale=None, why=None):
        self.width = width
        self.correlation = correlation
        self.gain = gain
        self.scale = scale
        self.why = why


def runup_match(tail, runup) -> RunUpMatch:
    """How to bring a window's fine detail back to the tail of the clip before, channel by channel: `tail` and `runup` are
    [channels, n, h, w] (the clip before's last overlap tokens, the window's first ones).

    gain = (std(detail r) / std(detail a)) / (std(broad r) / std(broad a)), and the whole window's fine detail is divided
    by it, its broad picture and its means left as they are. A continuation window starts about 2 % wider than it ends,
    in the fine detail and the broad picture alike, and that start excess does not build up along a chain: the run-up's
    plain gain over the tail (pack 0.45.0) read it as creep and shrank the broad picture 2.2 % a clip, the chain going
    softer and darker. What does build up is the fine detail's growth past the broad picture's, which this ratio reads
    (1.031, 1.027, 1.025, 1.026, 1.023 against a real growth of 1.032, 1.026, 1.016, 1.020, 1.013 on a six-clip chain,
    2026-11-01). A channel scaled or shifted reads the same ratio, so a chain already matched reads alike.
    """
    a = np.asarray(tail, dtype=np.float64)
    r = np.asarray(runup, dtype=np.float64)
    channels = a.shape[0]
    (da, ba), (dr, br) = detail_and_broad(a), detail_and_broad(r)

    def spread(x):
        return x.reshape(channels, -1).std(axis=1)

    with np.errstate(divide="ignore", invalid="ignore"):
        width = float((spread(r) / spread(a)).mean())
        gain = (spread(dr) / spread(da)) / (spread(br) / spread(ba))
        # pooled over the channels, each centred on its own mean: a channel's mean is not what makes a copy
        fa, fr = a.reshape(channels, -1), r.reshape(channels, -1)
        ca, cr = fa - fa.mean(axis=1, keepdims=True), fr - fr.mean(axis=1, keepdims=True)
        correlation = float((ca * cr).sum() / np.sqrt((ca * ca).sum() * (cr * cr).sum()))
    if not (np.all(np.isfinite(gain)) and np.all(gain > 0) and np.isfinite(correlation)):
        return RunUpMatch(width, correlation, why="a channel of the tail or the run-up is flat")
    if correlation < RUNUP_MIN_CORRELATION:
        return RunUpMatch(width, correlation, gain, why=f"the run-up is not a copy of the clip before (correlation {correlation:.3f}): a cut")
    low, high = RUNUP_GAIN
    if gain.min() < low or gain.max() > high:
        return RunUpMatch(width, correlation, gain, why=f"a channel's fine detail grew x{gain.min():.3f} to x{gain.max():.3f} past its broad picture, outside x{low} to x{high}")
    return RunUpMatch(width, correlation, gain, scale=1.0 / gain)


def with_runup(out: dict, source) -> dict:
    """`out` with the run-up width `source` (a latent's dict) carries, when it carries one."""
    if isinstance(source, dict) and source.get(RUNUP_KEY) is not None:
        out[RUNUP_KEY] = source[RUNUP_KEY]
    return out


class AfflatusH3RunUpMatch(io.ComfyNode):
    """A sampled continuation window held at the clip before's sharpness: per channel, its fine detail brought back by the
    growth its run-up shows over the tail it copies, the broad picture left as it is.

    A window guided by the clip before's exact latent copies that tail almost exactly (correlation 0.999), but a few per
    cent wider (2026-10-05). The window is what the clip after continues from, so nothing pulls the chain back: over five
    clips sharpness doubled and the grain rose by half (2026-11-01). Re-anchoring through the VAE (the hybrid tail guide,
    2026-10-05) did hold it, but its guide was no longer the clip before's own tokens and the joins stopped being seamless.
    This keeps the guide exact and corrects the result instead, from the run-up alone.

    Only the fine detail is corrected (see `runup_match`): matching the whole spread and mean (pack 0.45.0) held the joins
    but over-read the creep, and a six-clip chain on a pod went x0.86 sharpness, its highlights 201 to 187 and its
    brightness 80 to 75, where the uncorrected one went x1.51 sharpness with its brightness flat. The sound is left as it
    is: it shows no drift, and the seam takes the clip before's own sound tokens anyway.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusH3RunUpMatch",
            display_name="Afflatus: H3 Run-up Match",
            category="Afflatus",
            description="Holds a sampled MiniMax H3 continuation window at the clip before's sharpness: per latent channel, how much more its fine detail (each token less its 3x3 blur) grew than its broad picture, read on the hidden overlap (the run-up) against the clip before's last tokens it copies, is taken back from the whole window's fine detail. The broad picture, the means and the sound are untouched. A chain continued from exact latents otherwise gets a few per cent sharper at every join. Left as sampled when the run-up is not a copy (a cut) or the correction would be large.",
            inputs=[
                io.Latent.Input("previous_av_latent", tooltip="The clip before's latent, as the window was made from it (cut to its hand-over frame when it was)."),
                io.Latent.Input("sampled_window", tooltip="The continuation window after sampling (overlap, then the new frames)."),
                io.Int.Input("overlap_frames", default=22, min=5, max=3600, step=17, tooltip="The window's hidden overlap in frames: 5, 22, 39… (17k + 5)."),
            ],
            outputs=[io.Latent.Output(display_name="latent")],
        )

    @classmethod
    def execute(cls, previous_av_latent, sampled_window, overlap_frames: int = 22) -> io.NodeOutput:
        prev_video, _prev_audio = _extract_h3_av_streams(previous_av_latent, name="previous_av_latent")
        win_video, win_audio = _extract_h3_av_streams(sampled_window, name="sampled_window")
        overlap_t = video_latent_t(overlap_frames)
        prev_t = int(prev_video.shape[2])
        if prev_t < overlap_t:
            raise ValueError(f"the clip before has {frame_count_from_video_latent_t(prev_t)} frames, fewer than the {overlap_frames} the window overlaps")
        if int(win_video.shape[2]) <= overlap_t:
            raise ValueError("the window holds no new frames after its overlap")
        if prev_video.shape[:2] != win_video.shape[:2] or prev_video.shape[3:] != win_video.shape[3:]:
            raise ValueError("the clip before's latent and the window are not the same size")
        channels = int(win_video.shape[1])

        def per_channel(tokens):
            # [channels, tokens, h, w], a batch's tokens counted as more tokens of each channel
            t = tokens.detach().to(device="cpu", dtype=torch.float64).transpose(0, 1)
            return t.reshape(channels, -1, *t.shape[-2:]).numpy()

        match = runup_match(per_channel(prev_video[:, :, prev_t - overlap_t :]), per_channel(win_video[:, :, :overlap_t]))
        # (plain ASCII: a Windows console on another code page fails on more)
        if match.why:
            print(f"[afflatus-nodes] H3 Run-up Match: left as sampled, {match.why} (run-up x{match.width:.3f})")
            video = win_video
        else:
            print(f"[afflatus-nodes] H3 Run-up Match: fine detail /{match.gain.mean():.3f} (x{match.gain.min():.3f} to x{match.gain.max():.3f} by channel; run-up x{match.width:.3f})")
            x = win_video.float()
            b, c, t, h, w = x.shape
            # each token's 3x3 box blur, its edges repeated, as detail_and_broad reads it
            tokens = x.permute(0, 2, 1, 3, 4).reshape(b * t, c, h, w)
            broad = torch.nn.functional.avg_pool2d(torch.nn.functional.pad(tokens, (1, 1, 1, 1), mode="replicate"), 3, stride=1)
            broad = broad.reshape(b, t, c, h, w).permute(0, 2, 1, 3, 4)
            scale = torch.tensor(match.scale, dtype=torch.float32, device=x.device).view(1, channels, 1, 1, 1)
            video = (broad + (x - broad) * scale).to(win_video.dtype).contiguous()
        # the window's other entries kept (a sampler's output may carry more than its samples), the sound the same tensor
        out = {**sampled_window, "samples": NestedTensor((video, win_audio)), RUNUP_KEY: match.width}
        return io.NodeOutput(out)


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
            # Afflatus no longer uses it: still registered so that a saved graph naming it loads, marked deprecated so
            # that ComfyUI hides it from the node search; kept for graphs that name it.
            is_deprecated=True,
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

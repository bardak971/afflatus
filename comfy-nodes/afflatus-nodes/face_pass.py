"""Face refine's pass made cheaper, and the skin kept (card #225).

Measured on the owner's PC (Timeline 17, 2026-11-02), the pass after an H3 continuation took ~87 s and the kept latent's
re-encode ~17 s more: SAM's face outline on every frame 22.6 s, the crops encoded 13.4 s, the text encoder loaded again for
the pass's prompt ~7 s, the crops sampled 27 s, decoded and pasted 14 s. And the face came back ~20 % softer than sampled
(face-crop Laplacian 5.36 to 4.3, hands and towel unchanged), plain at the join from a clip sampled with the person's picture.

- The pass's prompt is encoded while the clip's own encoder is loaded (H3 Reference Prompt, before the clip samples), and its
  picture and sound latents are put on it after (H3 Reference Latents): no second load of the ~15 GB Qwen3-VL. H3 packs its
  reference blocks apart from the text (comfy.ldm.minimax.model.PackedLayout reads the text's length alone), so the picture
  the encoder sees and the one the model is given may be cut at two sizes.
- SAM's outline on every few frames, blended in between (Face Mask Stride): the crops are face-stabilised, so the outline
  moves little from frame to frame, and the pack's own temporal smoothing already averages five of them.
- The sampled face's own fine detail laid back on the pasted one where the redraw kept its shape (Face Detail Keep): the
  likeness from the pass, the skin's grain from the sample.
- The kept latent takes the refined face's region alone (H3 Inject Region): the rest of the frame is the sampled latent as it
  was, not decoded and encoded again. H3's video encoder is a causal 3D CNN, tiled over 256 px with blended overlaps, so a
  region encoded with a margin around it gives the same tokens inside it as the whole frame does, to within the tiling's own.
"""

import logging
import math

from comfy_api.latest import io

log = logging.getLogger("afflatus")

# the reference model's sizes, as its own node has them (comfy_extras/nodes_minimax_h3.py)
_CANVAS_MULTIPLE = 32
_LATENT_SCALE = 16


def match_size(width, height, image_w, image_h):
    """A reference picture's size as MiniMax H3 Reference to Video's "match" makes it: scaled down only, aspect kept, to the
    generation's area, on its 32-px grid."""
    scale = min(1.0, math.sqrt((width * height) / (image_w * image_h)))
    tw = max(_CANVAS_MULTIPLE, round(image_w * scale / _CANVAS_MULTIPLE) * _CANVAS_MULTIPLE)
    th = max(_CANVAS_MULTIPLE, round(image_h * scale / _CANVAS_MULTIPLE) * _CANVAS_MULTIPLE)
    return tw, th


def _resized(image, width, height):
    import comfy.utils

    first = image[:1, ..., :3].movedim(-1, 1)
    w, h = match_size(width, height, int(first.shape[3]), int(first.shape[2]))
    return comfy.utils.common_upscale(first, w, h, "lanczos", "disabled").movedim(1, -1), w, h


class AfflatusH3ReferencePrompt(io.ComfyNode):
    """The text half of MiniMax H3 Reference to Video for one picture and, said, one sound: encoded now, its latents later."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusH3ReferencePrompt",
            display_name="Afflatus: H3 Reference Prompt",
            category="Afflatus",
            description="Encodes a MiniMax H3 reference prompt with <Picture 1> (and <Audio 1> when a sound is to come) by the text encoder alone, so that it can be encoded while the encoder is loaded for another prompt. H3 Reference Latents puts the picture's and the sound's latents on it later.",
            inputs=[
                io.Clip.Input("clip"),
                io.String.Input("prompt", multiline=True),
                io.Image.Input("ref_image", tooltip="The person's picture: <Picture 1>."),
                io.Int.Input("width", default=512, min=32, max=8192, step=32, tooltip="The size the picture is scaled to the area of, for the text encoder, as Reference to Video's match does."),
                io.Int.Input("height", default=512, min=32, max=8192, step=32),
                io.Boolean.Input("sound", default=True, tooltip="An <Audio 1> to come: the clip's own sound, put on by H3 Reference Latents."),
            ],
            outputs=[io.Conditioning.Output(display_name="text")],
        )

    @classmethod
    def execute(cls, clip, prompt, ref_image, width, height, sound=True) -> io.NodeOutput:
        resized, _, _ = _resized(ref_image, width, height)
        items = [{"type": "image", "data": resized}, *([{"type": "audio"}] if sound else [])]
        tokens = clip.tokenize(prompt, minimax_ref_items=items)
        return io.NodeOutput(clip.encode_from_tokens_scheduled(tokens))


def reference_blocks(picture_latent, picture_wh, sound=None):
    """The reference blocks MiniMax H3's model reads beside the text, in the order the prompt names them: <Picture 1>, then <Audio 1>."""
    w, h = picture_wh
    blocks = [{"kind": "image", "latent_h": h // _LATENT_SCALE, "latent_w": w // _LATENT_SCALE, "latent": picture_latent}]
    if sound is not None:
        audio_latent, steps = sound
        if steps:
            blocks.append({"kind": "audio", "ref_audio_t": steps, "audio_latent": audio_latent})
    return blocks


class AfflatusH3ReferenceLatents(io.ComfyNode):
    """The other half: the picture's and the sound's latents on the encoded prompt, and the empty H3 latent to sample."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusH3ReferenceLatents",
            display_name="Afflatus: H3 Reference Latents",
            category="Afflatus",
            description="Puts a reference picture's latent (and a sound's) on a prompt encoded by H3 Reference Prompt, as MiniMax H3 Reference to Video does, and makes the empty H3 latent of the size to sample.",
            inputs=[
                io.Conditioning.Input("text", tooltip="From H3 Reference Prompt."),
                io.Vae.Input("vae"),
                io.Image.Input("ref_image", tooltip="The same picture as the prompt's."),
                io.Int.Input("width", default=512, min=32, max=8192, step=32),
                io.Int.Input("height", default=512, min=32, max=8192, step=32),
                io.Int.Input("length", default=124, min=5, max=3600, step=17),
                io.Vae.Input("audio_vae", optional=True),
                io.Audio.Input("ref_audio", optional=True, tooltip="<Audio 1>: the clip's own sound, when the prompt was encoded with one."),
            ],
            outputs=[io.Conditioning.Output(display_name="positive"), io.Latent.Output()],
        )

    @classmethod
    def execute(cls, text, vae, ref_image, width, height, length, audio_vae=None, ref_audio=None) -> io.NodeOutput:
        import node_helpers
        from comfy_extras.nodes_minimax_h3 import _empty_av_latent, _encode_ref_audio

        latent, _ = _empty_av_latent(width, height, length)
        resized, w, h = _resized(ref_image, width, height)
        sound = _encode_ref_audio(audio_vae, ref_audio) if ref_audio is not None and audio_vae is not None else None
        blocks = reference_blocks(vae.encode(resized), (w, h), sound)
        return io.NodeOutput(node_helpers.conditioning_set_values(text, {"minimax_refs": blocks}), latent)


def key_frames(count, stride):
    """The frames the outline is made on: every `stride`-th, and the last."""
    step = max(1, int(stride))
    keys = list(range(0, count, step))
    if keys and keys[-1] != count - 1:
        keys.append(count - 1)
    return keys


def between(masks, keys, count):
    """Masks on `keys` (a [K, H, W] tensor) spread over `count` frames, each frame between two keys a blend of the two."""
    import torch

    out = torch.empty((count, *masks.shape[1:]), dtype=masks.dtype)
    for k in range(len(keys) - 1):
        a, b = keys[k], keys[k + 1]
        for i in range(a, b):
            t = (i - a) / (b - a)
            out[i] = masks[k] * (1 - t) + masks[k + 1] * t
    out[keys[-1]] = masks[-1]
    return out


def smooth_in_time(masks, window):
    """The FaceRefine pack's own averaging over `window` frames (H3FaceMaskSAM's temporal_smooth), on a [B, H, W] stack."""
    import torch
    import torch.nn.functional as F

    B, h, w = masks.shape
    if window <= 1 or B <= 2:
        return masks
    win = min(int(window) | 1, B if B % 2 else B - 1)
    if win < 3:
        return masks
    pad = win // 2
    t = F.pad(masks.permute(1, 2, 0).reshape(-1, 1, B).contiguous(), (pad, pad), mode="replicate")
    kern = torch.ones(1, 1, win, dtype=t.dtype, device=t.device) / win
    return F.conv1d(t, kern).reshape(h, w, B).permute(2, 0, 1).contiguous()


class AfflatusFaceMaskStride(io.ComfyNode):
    """H3 Face Mask (SAM) on every few crops, the outline blended in between: the same masks for a fraction of the time."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusFaceMaskStride",
            display_name="Afflatus: Face Mask on a Stride",
            category="Afflatus",
            description="Runs ComfyUI-H3-FaceRefine's H3 Face Mask (SAM) on every stride-th face crop and the last, blends each frame's mask from the two around it, then averages over time as that node does. On face-stabilised crops the outline moves little from frame to frame.",
            inputs=[
                io.Image.Input("crops", tooltip="H3 Face Track + Crop's crops (the input crops, not the redrawn ones)."),
                io.Custom("SAM_MODEL").Input("sam_model"),
                io.Custom("H3FACEXFORM").Input("transform"),
                io.Float.Input("threshold", default=0.93, min=0.0, max=1.0, step=0.01),
                io.Int.Input("dilation", default=0, min=0, max=128, step=2),
                io.Int.Input("temporal_smooth", default=5, min=1, max=31, step=2),
                io.Int.Input("stride", default=4, min=1, max=16, tooltip="SAM on every stride-th crop; 1 is every crop, as H3 Face Mask (SAM) itself."),
            ],
            outputs=[io.Mask.Output(display_name="masks")],
        )

    @classmethod
    def execute(cls, crops, sam_model, transform, threshold, dilation, temporal_smooth, stride=4) -> io.NodeOutput:
        import nodes

        sam = nodes.NODE_CLASS_MAPPINGS.get("H3FaceMaskSAM")
        if sam is None:
            raise RuntimeError("Face Mask on a Stride runs ComfyUI-H3-FaceRefine's H3 Face Mask (SAM), which is not loaded.")
        count = int(crops.shape[0])
        keys = key_frames(count, stride)
        rects = list(transform.get("face_rect") or [])
        picked = dict(transform)
        if rects:
            picked["face_rect"] = [rects[i] for i in keys if i < len(rects)]
        # (each key's own outline, grown as asked; the averaging over time comes after the frames between are filled)
        masks = sam().run(crops[keys], sam_model, picked, threshold, dilation, 1)[0]
        full = smooth_in_time(between(masks.float().cpu(), keys, count), temporal_smooth)
        log.info("[afflatus] face masks: SAM on %d of %d crops (every %d), blended between", len(keys), count, max(1, int(stride)))
        return io.NodeOutput(full)


def _gauss_kernel(sigma, torch):
    radius = max(1, int(math.ceil(3 * sigma)))
    x = torch.arange(-radius, radius + 1, dtype=torch.float32)
    k = torch.exp(-(x * x) / (2 * sigma * sigma))
    return k / k.sum(), radius


def blur(x, sigma):
    """A separable Gaussian blur of an [N, C, H, W] tensor, edges reflected."""
    import torch
    import torch.nn.functional as F

    k, r = _gauss_kernel(sigma, torch)
    k = k.to(device=x.device, dtype=x.dtype)
    c = x.shape[1]
    x = F.conv2d(F.pad(x, (r, r, 0, 0), mode="reflect"), k.view(1, 1, 1, -1).expand(c, 1, 1, -1), groups=c)
    return F.conv2d(F.pad(x, (0, 0, r, r), mode="reflect"), k.view(1, 1, -1, 1).expand(c, 1, -1, 1), groups=c)


def keep_detail(base, refined, sigma=1.2, tolerance=0.05, strength=1.0):
    """`refined` with `base`'s fine detail (finer than `sigma` px) where the two agree in their broad picture, on [N, C, H, W].

    The refined picture's broad part is kept everywhere: the likeness. Its detail finer than sigma becomes the base's, weighed
    by how close their broad parts are there (1 where they agree, down to 0 past `tolerance`), so that an eye or a mouth the
    redraw moved keeps the redraw's own edges rather than the base's beside them. Where nothing was redrawn the two are the
    same picture and it is left as it is.
    """
    import torch

    lb, lr = blur(base, sigma), blur(refined, sigma)
    apart = blur((lb - lr).abs().mean(dim=1, keepdim=True), 2 * sigma)
    weight = strength * torch.exp(-((apart / tolerance) ** 2))
    return (refined + weight * ((base - lb) - (refined - lr))).clamp(0.0, 1.0)


def changed_box(base, refined, threshold=1.0 / 255):
    """The box (x0, y0, x1, y1) around every pixel `refined` changed from `base` in any frame ([B, H, W, C]), None if none did."""
    # a few frames at a time: the difference of a whole 720p clip at once is gigabytes
    moved = None
    for i in range(0, int(base.shape[0]), 16):
        part = ((refined[i : i + 16, ..., :3] - base[i : i + 16, ..., :3]).abs().amax(dim=-1) > threshold).any(dim=0)
        moved = part if moved is None else moved | part
    if moved is None:
        return None
    rows, cols = moved.any(dim=1).nonzero(), moved.any(dim=0).nonzero()
    if rows.numel() == 0:
        return None
    return int(cols.min()), int(rows.min()), int(cols.max()) + 1, int(rows.max()) + 1


class AfflatusFaceDetailKeep(io.ComfyNode):
    """The sampled frames' own fine detail laid back on the face Face refine pasted, where the redraw kept its shape."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusFaceDetailKeep",
            display_name="Afflatus: Face Detail Keep",
            category="Afflatus",
            description="Gives the refined frames the sampled frames' detail finer than sigma (skin grain, pores, fine hair) wherever their broad picture agrees with the sampled one, and leaves the refined detail where the redraw moved a feature. Only the pixels the refine changed are touched.",
            inputs=[
                io.Image.Input("base_images", tooltip="The frames as sampled, before Face refine."),
                io.Image.Input("images", tooltip="The same frames with the refined face pasted (H3 Face Stitch)."),
                io.Float.Input("sigma", default=1.2, min=0.5, max=4.0, step=0.1, tooltip="Detail finer than this, in pixels, comes from the sampled frames."),
                io.Float.Input("tolerance", default=0.05, min=0.01, max=0.5, step=0.01, tooltip="How far apart the two broad pictures may be (0 to 1) before the refined detail is kept as it is."),
                io.Float.Input("strength", default=1.0, min=0.0, max=1.0, step=0.05),
            ],
            outputs=[io.Image.Output(display_name="images")],
        )

    @classmethod
    def execute(cls, base_images, images, sigma=1.2, tolerance=0.05, strength=1.0) -> io.NodeOutput:
        import comfy.model_management as mm

        if strength <= 0 or base_images.shape != images.shape:
            if base_images.shape != images.shape:
                log.warning("[afflatus] face detail not kept: the sampled frames are %s, the refined %s", tuple(base_images.shape), tuple(images.shape))
            return io.NodeOutput(images)
        box = changed_box(base_images, images)
        if box is None:
            return io.NodeOutput(images)
        # the box the refine changed, with room for the blur's reach: the rest is the sampled frame already
        pad = int(math.ceil(9 * sigma))
        H, W = int(images.shape[1]), int(images.shape[2])
        x0, y0, x1, y1 = max(0, box[0] - pad), max(0, box[1] - pad), min(W, box[2] + pad), min(H, box[3] + pad)
        out = images.clone()
        device = mm.get_torch_device()
        for i in range(0, int(images.shape[0]), 16):
            b = base_images[i : i + 16, y0:y1, x0:x1, :3].to(device).movedim(-1, 1)
            r = images[i : i + 16, y0:y1, x0:x1, :3].to(device).movedim(-1, 1)
            out[i : i + 16, y0:y1, x0:x1, :3] = keep_detail(b, r, sigma, tolerance, strength).movedim(1, -1).to(out.device, out.dtype)
        log.info("[afflatus] face detail kept: the sampled grain under %.1f px, over %dx%d px of the frame", sigma, x1 - x0, y1 - y0)
        return io.NodeOutput(out)


def token_span(lo, hi, size, margin, scale=_LATENT_SCALE):
    """Along one axis of `size` px: the pixels to encode (on the latent grid, `margin` px around [lo, hi) where the frame has
    them) and, in latent tokens, the span of that encode to keep and where it goes in the whole latent."""
    a, b = (lo // scale) * scale, -(-hi // scale) * scale
    e0, e1 = max(0, a - margin), min(size, b + margin)
    e0, e1 = (e0 // scale) * scale, -(-e1 // scale) * scale
    return (e0, min(e1, size)), ((a - e0) // scale, (b - e0) // scale), (a // scale, b // scale)


class AfflatusH3InjectRegion(io.ComfyNode):
    """An H3 latent with the region the frames changed in encoded from them, the rest of its tokens as they were."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusH3InjectRegion",
            display_name="Afflatus: H3 Inject Region",
            category="Afflatus",
            description="Encodes only the region where images differ from base_images (with a margin, on the latent grid) and puts those tokens into av_latent's video stream in place; every other token, and the sound, stay the latent's own. For a kept latent after Face refine: the face refined, the rest as sampled, a fraction of a whole re-encode.",
            inputs=[
                io.Latent.Input("av_latent", tooltip="The H3 latent the frames were decoded from."),
                io.Image.Input("base_images", tooltip="The frames as decoded from it."),
                io.Image.Input("images", tooltip="The same frames with a region changed (the refined face)."),
                io.Vae.Input("vae"),
                io.Int.Input("margin", default=64, min=0, max=512, step=16, tooltip="Pixels encoded around the region on each side and not kept: the encoder's reach from the cut's edges."),
            ],
            outputs=[io.Latent.Output(display_name="av_latent")],
        )

    @classmethod
    def execute(cls, av_latent, base_images, images, vae, margin=64) -> io.NodeOutput:
        import comfy.nested_tensor

        samples = av_latent["samples"]
        members = list(samples.unbind())
        video = members[0]
        H, W = int(images.shape[1]), int(images.shape[2])
        box = changed_box(base_images, images) if base_images.shape == images.shape else (0, 0, W, H)
        if box is None:
            return io.NodeOutput(av_latent)
        (ex0, ex1), (kx0, kx1), (px0, px1) = token_span(box[0], box[2], W, margin)
        (ey0, ey1), (ky0, ky1), (py0, py1) = token_span(box[1], box[3], H, margin)
        encoded = vae.encode(images[:, ey0:ey1, ex0:ex1, :3])
        if encoded.ndim == 4:
            encoded = encoded.unsqueeze(0).movedim(1, 2)
        t = min(int(encoded.shape[2]), int(video.shape[2]))
        if int(encoded.shape[2]) != int(video.shape[2]):
            log.warning("[afflatus] region encoded to %d latent frames, the latent has %d: the first %d taken", int(encoded.shape[2]), int(video.shape[2]), t)
        merged = video.clone()
        merged[:, :, :t, py0:py1, px0:px1] = encoded[:, :, :t, ky0:ky1, kx0:kx1].to(merged.device, merged.dtype)
        members[0] = merged
        out = dict(av_latent)
        out["samples"] = comfy.nested_tensor.NestedTensor(tuple(members))
        log.info("[afflatus] kept latent: %dx%d px of %dx%d encoded again (the refined face), the rest as sampled", (px1 - px0) * _LATENT_SCALE, (py1 - py0) * _LATENT_SCALE, W, H)
        return io.NodeOutput(out)

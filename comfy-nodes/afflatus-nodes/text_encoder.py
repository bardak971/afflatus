"""H3's text encoder let go once its prompt is encoded, before the sampler starts.

MiniMax H3's Qwen3-VL encoder is ~15 GB. ComfyUI keeps it loaded after the encode, with its VRAM and the host buffers
aimdo pinned for it (private RAM), and marked as used by the running prompt, so that its own eviction reaches it last. On
32 GB of RAM a swap then held 31-33 GB and Windows trimmed the process until no step moved (card #171). Unloading every
model before the sampler made the H3 model load again (768 s); this lets go of the encoder alone. The conditioning is
already plain tensors on the intermediate device, in the executor's cache: it is passed through as it is.
"""

import logging

from comfy_api.latest import io

log = logging.getLogger("afflatus")

_MB = 1024 * 1024


def _held(patcher):
    """What the encoder holds, in bytes: its weights on the GPU and the host buffers pinned for it (0 where it has none)."""
    vram = ram = 0
    try:
        vram = int(patcher.loaded_size() or 0)
    except Exception:
        pass
    pinned = getattr(patcher, "pinned_memory_size", None)
    if callable(pinned):
        try:
            ram = int(pinned() or 0)
        except Exception:
            pass
    return vram, ram


def _same(loaded, patcher):
    model = loaded.model
    if model is None:
        return False
    if model is patcher:
        return True
    uuid = getattr(patcher, "clone_base_uuid", None)
    return uuid is not None and getattr(model, "clone_base_uuid", None) == uuid


def _unload(mm, patcher):
    """Only the encoder and its clones: ComfyUI's own call when it has it, else the same by hand (a ComfyUI from before it)."""
    unload = getattr(mm, "unload_model_and_clones", None)
    if callable(unload):
        unload(patcher, unload_additional_models=False)
        return
    loaded = getattr(mm, "current_loaded_models", [])
    for i in range(len(loaded) - 1, -1, -1):
        if _same(loaded[i], patcher) and loaded[i].model_unload():
            loaded.pop(i)
    mm.soft_empty_cache()


def free_text_encoder(clip):
    """Unload `clip`'s model alone; what it held before, in bytes (VRAM, pinned RAM), or None when nothing was let go."""
    import comfy.model_management as mm

    patcher = getattr(clip, "patcher", None)
    if patcher is None:
        return None
    if mm.is_device_cpu(patcher.load_device):
        # an encoder that runs on the CPU keeps its weights in RAM as long as ComfyUI's cache holds the CLIP: not ours to drop
        log.info("[afflatus] text encoder on the CPU: nothing freed")
        return None
    if not any(_same(m, patcher) for m in getattr(mm, "current_loaded_models", [])):
        # not loaded: its encode came from ComfyUI's cache, or something unloaded it already
        return None
    vram, ram = _held(patcher)
    _unload(mm, patcher)
    log.info("[afflatus] text encoder unloaded: %.0f MB of VRAM, %.0f MB of pinned RAM", vram / _MB, ram / _MB)
    return vram, ram


class AfflatusFreeTextEncoder(io.ComfyNode):
    """Pass a conditioning through and unload the text encoder that made it, so that sampling has its memory."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusFreeTextEncoder",
            display_name="Afflatus: Free Text Encoder",
            category="Afflatus",
            description="Unloads the text encoder (its VRAM and pinned RAM) once the conditionings given are encoded, leaving every other model loaded. The conditionings pass through unchanged.",
            inputs=[
                io.Clip.Input("clip", tooltip="The text encoder that made the conditionings."),
                io.Conditioning.Input("conditioning", tooltip="Encoded by it: passed through as it is."),
                io.Conditioning.Input("also", optional=True, tooltip="A second conditioning by the same encoder, so that both are encoded before it is let go."),
            ],
            outputs=[io.Conditioning.Output(display_name="conditioning"), io.Conditioning.Output(display_name="also")],
        )

    @classmethod
    def execute(cls, clip, conditioning, also=None) -> io.NodeOutput:
        try:
            free_text_encoder(clip)
        except Exception as e:
            # freeing is a saving, never a reason for the render to fail
            log.warning("[afflatus] text encoder not unloaded: %s", e)
        return io.NodeOutput(conditioning, also if also is not None else conditioning)

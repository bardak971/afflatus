"""Afflatus nodes for ComfyUI.

Seven nodes, all for continuing a MiniMax H3 clip from its own latent rather than from re-encoded pixels:

- Afflatus: Save H3 Latent / Load H3 Latent — a MiniMax H3 video+audio latent as one safetensors file
  (ComfyUI's own SaveLatent cannot store the nested pair); Normalize H3 Latent — a sampled window's audio
  rounded to its own frame boundary, so it can be continued from; H3 Latent Head Guide — the clip after's
  first tokens anchored at the end of the window, for a clip that must land on another.
- MiniMax H3 Guided Continuation Window, Latent Tail Guide, Append Continuation — the native latent-tail
  continuation by ttulttul (MIT, see LICENSE-continuation), vendored unchanged.

Afflatus writes this pack into ComfyUI's custom_nodes folder itself when it knows the folder (Settings →
ComfyUI); ComfyUI picks it up at its next start. It can also be installed by hand: copy this folder into
custom_nodes/ and restart ComfyUI. Needs ComfyUI 0.3.x with the arbitrary-frame MiniMax H3 guides
(commit e01fb4c or newer).
"""

from comfy_api.latest import ComfyExtension, io

from .continuation_nodes import (
    MiniMaxH3AppendContinuation,
    MiniMaxH3GuidedContinuationWindow,
    MiniMaxH3LatentTailGuide,
)
from .latent_io import AfflatusH3LatentHeadGuide, AfflatusLoadH3Latent, AfflatusNormalizeH3Latent, AfflatusSaveH3Latent

VERSION = "0.2.0"


class AfflatusExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            AfflatusSaveH3Latent,
            AfflatusLoadH3Latent,
            AfflatusNormalizeH3Latent,
            AfflatusH3LatentHeadGuide,
            MiniMaxH3GuidedContinuationWindow,
            MiniMaxH3LatentTailGuide,
            MiniMaxH3AppendContinuation,
        ]


async def comfy_entrypoint() -> AfflatusExtension:
    return AfflatusExtension()

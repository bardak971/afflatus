"""The Impact Subpack's YOLO detectors (face_yolov8m, hand_yolov8s, person_yolov8m-seg…) run on the CPU.

On a ComfyUI with DynamicVRAM (comfy_aimdo, on by default since 0.4x on NVIDIA), a YOLO model the Subpack's
UltralyticsDetectorProvider put on the GPU went wrong once a diffusion model had loaded beside it (card #335, A40 pods,
2026-11-06): about 300 boxes at 0.7 or more on any picture, or none at all, and so until the provider was loaded again.
Detail face redrew tree tops and blacked out the real face. The same pod restarted with --disable-dynamic-vram kept it
right through the same renders, at about 17 % on Krea 2's sampling; the model is ComfyUI's to manage there, not the
Subpack's. On the CPU the boxes are the GPU's own when it works (fp32 both): ADetailer's results, in about 0.25 s a picture
on four threads.

The provider here is the Subpack's own, its model kept off the GPU: the Subpack's detectors are used as they are, given a
model whose every call is made with device="cpu". So SEGS, crops, dilation and its detailer hooks stay the Subpack's.
The Subpack is looked for when the node runs, not when the pack loads: ComfyUI loads custom_nodes in their folders' order,
and this pack may come before it. Without it the node says so when run (Afflatus only uses it beside the Subpack's).
"""

import os

from comfy_api.latest import io


def _subpack():
    """The Subpack's provider class and its subcore module, or None when the Subpack is not loaded."""
    try:
        import sys

        import nodes
    except ImportError:
        return None
    provider = getattr(nodes, "NODE_CLASS_MAPPINGS", {}).get("UltralyticsDetectorProvider")
    if provider is None:
        return None
    module = sys.modules.get(provider.__module__)
    subcore = getattr(module, "subcore", None)
    if subcore is None or not hasattr(subcore, "UltraBBoxDetector"):
        return None
    return provider, subcore


class OnCpu:
    """A YOLO model whose every call runs on the CPU, whatever device the caller asked for; anything else is the model's.

    CUDA_VISIBLE_DEVICES is put back after each call: ultralytics before 8.4 set it to -1 when asked for the CPU, which
    ComfyUI's own process no longer reads, but a ComfyUI restarted from it (the Manager's restart) would start without
    its GPU."""

    def __init__(self, model):
        self.model = model

    def __call__(self, *args, **kwargs):
        kwargs["device"] = "cpu"
        had = os.environ.get("CUDA_VISIBLE_DEVICES")
        try:
            return self.model(*args, **kwargs)
        finally:
            if had is None:
                os.environ.pop("CUDA_VISIBLE_DEVICES", None)
            else:
                os.environ["CUDA_VISIBLE_DEVICES"] = had

    def __getattr__(self, name):
        return getattr(self.model, name)


def _choices():
    try:
        import folder_paths
    except ImportError:
        return []
    names = []
    for kind in ("bbox", "segm"):
        try:
            names += [f"{kind}/{x}" for x in folder_paths.get_filename_list(f"ultralytics_{kind}")]
        except Exception:
            pass
    return names


class AfflatusDetectorProviderCPU(io.ComfyNode):
    """The Impact Subpack's UltralyticsDetectorProvider, its model run on the CPU."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AfflatusDetectorProviderCPU",
            display_name="Afflatus: YOLO Detector on CPU",
            category="Afflatus",
            description="The Impact Subpack's UltralyticsDetectorProvider with its YOLO model kept on the CPU: on a GPU it can go wrong once a diffusion model loads beside it (DynamicVRAM).",
            inputs=[io.Combo.Input("model_name", options=_choices(), tooltip="A YOLO model in models/ultralytics/bbox or segm, as the Subpack lists them.")],
            outputs=[io.Custom("BBOX_DETECTOR").Output("BBOX_DETECTOR"), io.Custom("SEGM_DETECTOR").Output("SEGM_DETECTOR")],
        )

    @classmethod
    def execute(cls, model_name) -> io.NodeOutput:
        found = _subpack()
        if found is None:
            raise RuntimeError("the Impact Subpack (UltralyticsDetectorProvider) is not loaded")
        provider, subcore = found
        # the Subpack's own provider finds the file and builds its detectors; the model under them swapped for the CPU one
        bbox, segm = provider().doit(model_name)
        model = OnCpu(bbox.bbox_model)
        bbox = subcore.UltraBBoxDetector(model)
        if isinstance(segm, subcore.UltraSegmDetector):
            segm = subcore.UltraSegmDetector(model)
        return io.NodeOutput(bbox, segm)

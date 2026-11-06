"""The YOLO detector provider on the CPU, on a stand-in Impact Subpack: its own detectors kept, their model called on the CPU."""

import os
import sys
import types

import pytest

from afflatus_nodes import detector_cpu
from afflatus_nodes.detector_cpu import AfflatusDetectorProviderCPU, OnCpu


class Yolo:
    """A YOLO model as the Subpack calls it: model(image, conf=..., device=...); each call's arguments kept."""

    def __init__(self):
        self.calls = []
        self.names = {0: "face"}

    def __call__(self, image, conf=0.3, device=""):
        self.calls.append((image, conf, device))
        # ultralytics before 8.4 hid the GPUs from the process when asked for the CPU
        if device == "cpu":
            os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
        return ["boxes"]


def subpack():
    """The Subpack's provider and subcore as ComfyUI loads them: the provider in nodes' mappings, subcore in its module."""

    class UltraBBoxDetector:
        def __init__(self, bbox_model):
            self.bbox_model = bbox_model

        def detect(self, image, threshold):
            # as subcore.inference_bbox: no device given, ultralytics' default (the GPU)
            return self.bbox_model(image, conf=threshold, device="")

    class UltraSegmDetector(UltraBBoxDetector):
        pass

    class NO_SEGM_DETECTOR:
        pass

    subcore = types.SimpleNamespace(UltraBBoxDetector=UltraBBoxDetector, UltraSegmDetector=UltraSegmDetector, NO_SEGM_DETECTOR=NO_SEGM_DETECTOR)
    module = types.ModuleType("comfyui-impact-subpack.modules.subpack_nodes")
    module.subcore = subcore

    class UltralyticsDetectorProvider:
        made = []

        def doit(self, model_name):
            model = Yolo()
            self.made.append((model_name, model))
            if model_name.startswith("bbox"):
                return subcore.UltraBBoxDetector(model), subcore.NO_SEGM_DETECTOR()
            return subcore.UltraBBoxDetector(model), subcore.UltraSegmDetector(model)

    UltralyticsDetectorProvider.__module__ = module.__name__
    return UltralyticsDetectorProvider, module, subcore


@pytest.fixture
def loaded(monkeypatch):
    provider, module, subcore = subpack()
    monkeypatch.setitem(sys.modules, module.__name__, module)
    monkeypatch.setitem(sys.modules, "nodes", types.SimpleNamespace(NODE_CLASS_MAPPINGS={"UltralyticsDetectorProvider": provider}))
    monkeypatch.delenv("CUDA_VISIBLE_DEVICES", raising=False)
    return provider, subcore


def test_bbox_model_runs_on_the_cpu(loaded):
    provider, subcore = loaded
    bbox, segm = AfflatusDetectorProviderCPU.execute("bbox/face_yolov8m.pt").args
    assert isinstance(bbox, subcore.UltraBBoxDetector)
    # a bbox model has no segm detector: the Subpack's placeholder passed on
    assert isinstance(segm, subcore.NO_SEGM_DETECTOR)
    bbox.detect("picture", 0.5)
    name, model = provider.made[-1]
    assert name == "bbox/face_yolov8m.pt"
    assert model.calls == [("picture", 0.5, "cpu")]


def test_segm_model_shares_the_cpu_model(loaded):
    provider, subcore = loaded
    bbox, segm = AfflatusDetectorProviderCPU.execute("segm/person_yolov8m-seg.pt").args
    assert isinstance(segm, subcore.UltraSegmDetector)
    segm.detect("picture", 0.3)
    bbox.detect("picture", 0.4)
    assert [c[2] for c in provider.made[-1][1].calls] == ["cpu", "cpu"]
    # one model loaded, not one per detector
    assert len(provider.made) == 1


def test_gpus_left_visible(loaded, monkeypatch):
    model = Yolo()
    OnCpu(model)("picture")
    assert "CUDA_VISIBLE_DEVICES" not in os.environ
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "0")
    OnCpu(model)("picture")
    assert os.environ["CUDA_VISIBLE_DEVICES"] == "0"


def test_model_attributes_passed_through():
    model = Yolo()
    assert OnCpu(model).names == {0: "face"}


def test_without_the_subpack_says_so(monkeypatch):
    monkeypatch.setitem(sys.modules, "nodes", types.SimpleNamespace(NODE_CLASS_MAPPINGS={}))
    with pytest.raises(RuntimeError, match="Impact Subpack"):
        AfflatusDetectorProviderCPU.execute("bbox/face_yolov8m.pt")


def test_choices_from_the_subpack_folders(folders, monkeypatch):
    fp = sys.modules["folder_paths"]
    lists = {"ultralytics_bbox": ["face_yolov8m.pt"], "ultralytics_segm": ["person_yolov8m-seg.pt"]}
    monkeypatch.setattr(fp, "get_filename_list", lambda kind: lists[kind], raising=False)
    assert detector_cpu._choices() == ["bbox/face_yolov8m.pt", "segm/person_yolov8m-seg.pt"]
    # the Subpack not loaded yet: its folders unknown, no choices rather than an error
    monkeypatch.setattr(fp, "get_filename_list", lambda kind: (_ for _ in ()).throw(KeyError(kind)), raising=False)
    assert detector_cpu._choices() == []

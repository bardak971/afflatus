"""The free text encoder node, on a stand-in model_management: only the encoder let go, the conditionings passed through."""

import sys
import types

import pytest

from afflatus_nodes.text_encoder import AfflatusFreeTextEncoder, free_text_encoder

GB = 1024**3


class Patcher:
    def __init__(self, uuid, vram=0, pinned=0, device="cuda:0"):
        self.clone_base_uuid = uuid
        self.load_device = device
        self.vram = vram
        self.pinned = pinned

    def loaded_size(self):
        return self.vram

    def pinned_memory_size(self):
        return self.pinned


class Loaded:
    """ComfyUI's LoadedModel as the fallback uses it: its patcher, and an unload that lets go of all it holds."""

    def __init__(self, model):
        self.model = model
        self.unloaded = False

    def model_unload(self, memory_to_free=None, unpatch_weights=True):
        self.unloaded = True
        self.model.vram = self.model.pinned = 0
        return True


class Clip:
    def __init__(self, patcher):
        self.patcher = patcher


def management(loaded, with_call=True):
    """A stand-in comfy.model_management: what is loaded, and ComfyUI's own unload of a model and its clones when asked for."""
    mm = types.SimpleNamespace(current_loaded_models=loaded, emptied=0, asked=[])
    mm.is_device_cpu = lambda device: device == "cpu"

    def soft_empty_cache(force=False):
        mm.emptied += 1

    mm.soft_empty_cache = soft_empty_cache
    if with_call:

        def unload_model_and_clones(model, unload_additional_models=True, all_devices=False):
            mm.asked.append((model, unload_additional_models))
            for i in range(len(loaded) - 1, -1, -1):
                if loaded[i].model.clone_base_uuid == model.clone_base_uuid:
                    loaded[i].model_unload()
                    loaded.pop(i)

        mm.unload_model_and_clones = unload_model_and_clones
    return mm


@pytest.fixture
def comfy(monkeypatch):
    def install(mm):
        monkeypatch.setitem(sys.modules, "comfy.model_management", mm)
        monkeypatch.setattr(sys.modules["comfy"], "model_management", mm, raising=False)
        return mm

    return install


@pytest.mark.parametrize("with_call", [True, False], ids=["ComfyUI's unload", "an older ComfyUI"])
def test_lets_go_of_the_encoder_alone(comfy, with_call):
    te, h3, vae = Patcher("te", 4 * GB, 11 * GB), Patcher("h3", 20 * GB, 6 * GB), Patcher("vae", GB)
    # a clone of the encoder (a hooked encode) goes with it
    clone = Patcher("te", GB)
    loaded = [Loaded(h3), Loaded(te), Loaded(vae), Loaded(clone)]
    kept = loaded[0], loaded[2]
    mm = comfy(management(loaded, with_call))
    assert free_text_encoder(Clip(te)) == (4 * GB, 11 * GB)
    assert [m.model for m in loaded] == [h3, vae]
    assert not any(m.unloaded for m in kept)
    assert h3.vram == 20 * GB and h3.pinned == 6 * GB
    assert te.vram == te.pinned == 0 and clone.vram == 0
    if with_call:
        assert mm.asked == [(te, False)]
    else:
        assert mm.emptied == 1


def test_passes_the_conditionings_through_as_they_are(comfy):
    te = Patcher("te", GB)
    comfy(management([Loaded(te)]))
    clip_cond, plain = [["clip", {}]], [["plain", {}]]
    out = AfflatusFreeTextEncoder.execute(Clip(te), clip_cond, plain).args
    assert out[0] is clip_cond and out[1] is plain
    # one alone: the second output is the same
    out = AfflatusFreeTextEncoder.execute(Clip(te), clip_cond).args
    assert out[0] is clip_cond and out[1] is clip_cond


def test_nothing_to_do_when_the_encoder_is_not_loaded(comfy):
    # its encode came from ComfyUI's cache: the encoder never loaded
    h3 = Patcher("h3", 20 * GB)
    mm = comfy(management([Loaded(h3)]))
    assert free_text_encoder(Clip(Patcher("te"))) is None
    assert mm.asked == [] and h3.vram == 20 * GB


def test_an_encoder_on_the_cpu_is_left_as_it_is(comfy):
    te = Patcher("te", 0, 0, device="cpu")
    loaded = [Loaded(te)]
    mm = comfy(management(loaded))
    assert free_text_encoder(Clip(te)) is None
    assert mm.asked == [] and len(loaded) == 1


def test_a_failed_unload_never_fails_the_render(comfy):
    te = Patcher("te", GB)
    mm = comfy(management([Loaded(te)]))

    def broken(model, unload_additional_models=True, all_devices=False):
        raise RuntimeError("aimdo said no")

    mm.unload_model_and_clones = broken
    cond = [["clip", {}]]
    assert AfflatusFreeTextEncoder.execute(Clip(te), cond).args[0] is cond

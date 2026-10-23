"""Stand-ins for what the pack imports from ComfyUI and torch, so its frame and token arithmetic runs without either.

A tensor here is its shape, its dtype and device, and a label for each step of its time axis (dim 2 of a video
latent, the last of an audio one): slicing and joining keep the labels, so a test can say which tokens went where.
"""

import importlib.util
import os
import sys
import types

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.dirname(HERE)


class Tensor:
    def __init__(self, shape, labels=None, axis=None, dtype="float32", device="cpu"):
        self.shape = tuple(shape)
        self.axis = axis if axis is not None else (2 if len(self.shape) == 5 else len(self.shape) - 1)
        self.labels = list(labels) if labels is not None else [None] * self.shape[self.axis]
        self.dtype = dtype
        self.device = device

    @property
    def ndim(self):
        return len(self.shape)

    def _like(self, shape=None, labels=None, **over):
        return Tensor(shape or self.shape, self.labels if labels is None else labels, self.axis, over.get("dtype", self.dtype), over.get("device", self.device))

    def __getitem__(self, key):
        key = key if isinstance(key, tuple) else (key,)
        if Ellipsis in key:
            at = key.index(Ellipsis)
            key = key[:at] + (slice(None),) * (len(self.shape) - len(key) + 1) + key[at + 1 :]
        shape = list(self.shape)
        labels = self.labels
        for dim, k in enumerate(key):
            if isinstance(k, int):
                raise NotImplementedError("the stand-in tensor slices, it does not index")
            picked = list(range(self.shape[dim]))[k]
            shape[dim] = len(picked)
            if dim == self.axis:
                labels = [self.labels[i] for i in picked]
        return self._like(shape, labels)

    def to(self, *args, **kwargs):
        dtype = kwargs.get("dtype", next((a for a in args if isinstance(a, str) and a.startswith("float")), self.dtype))
        device = kwargs.get("device", next((a for a in args if isinstance(a, str) and not a.startswith("float")), self.device))
        return self._like(dtype=dtype, device=device)

    def clone(self):
        return self._like()

    contiguous = detach = clone

    def float(self):
        return self._like(dtype="float32")

    def new_zeros(self, shape):
        return Tensor(shape, None, None, self.dtype, self.device)

    def movedim(self, source, destination):
        shape = list(self.shape)
        shape.insert(destination % len(shape), shape.pop(source))
        return Tensor(shape, None, None, self.dtype, self.device)


def _cat(tensors, dim=0):
    first = tensors[0]
    dim = dim % len(first.shape)
    shape = list(first.shape)
    shape[dim] = sum(t.shape[dim] for t in tensors)
    labels = [label for t in tensors for label in t.labels] if dim == first.axis else first.labels
    return Tensor(shape, labels, first.axis, first.dtype, first.device)


class NestedTensor:
    def __init__(self, tensors):
        self.tensors = tuple(tensors)


class NodeOutput:
    def __init__(self, *args, ui=None):
        self.args = args
        self.ui = ui


class _Anything:
    """Whatever a schema is built from: never looked at by these tests."""

    def __call__(self, *args, **kwargs):
        return _Anything()

    def __getattr__(self, name):
        return _Anything()


class _Io(types.ModuleType):
    ComfyNode = type("ComfyNode", (), {})
    NodeOutput = NodeOutput

    def __getattr__(self, name):
        return _Anything()


class PackedLayout:
    """The upstream layout of a recent enough ComfyUI: no frame_count argument."""

    def __init__(self, shapes, offsets=None):
        pass


def _module(name, **attrs):
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    sys.modules[name] = module
    parent, _, child = name.rpartition(".")
    if parent:
        setattr(sys.modules[parent], child, module)
    return module


class Folders:
    """ComfyUI's folder_paths, over three folders of a test's own."""

    def __init__(self, root):
        self.input = os.path.join(root, "input")
        self.temp = os.path.join(root, "temp")
        self.output = os.path.join(root, "output")
        for d in (self.input, self.temp, self.output):
            os.makedirs(d, exist_ok=True)

    def get_input_directory(self):
        return self.input

    def get_temp_directory(self):
        return self.temp

    def get_output_directory(self):
        return self.output

    def get_annotated_filepath(self, name):
        for tag, folder in ((" [temp]", self.temp), (" [output]", self.output), (" [input]", self.input)):
            if name.endswith(tag):
                return os.path.join(folder, name[: -len(tag)])
        return os.path.join(self.input, name)

    def exists_annotated_filepath(self, name):
        return os.path.exists(self.get_annotated_filepath(name))

    def get_save_image_path(self, prefix, base):
        sub, filename = os.path.split(prefix)
        folder = os.path.join(base, sub)
        os.makedirs(folder, exist_ok=True)
        return folder, filename, 1, sub, prefix


def _install_stubs():
    # ones_like / zeros_like: a fresh tensor of the same shape, its labels saying which it is
    def filled(value):
        return lambda t: Tensor(t.shape, [value] * t.shape[t.axis], t.axis, t.dtype, t.device)

    torch = _module("torch", Tensor=Tensor, cat=_cat, float32="float32", bfloat16="bfloat16", ones_like=filled(1), zeros_like=filled(0))
    saved = {}

    def save_file(tensors, path, metadata=None):
        saved[path] = (tensors, metadata)
        with open(path, "w", encoding="utf-8") as f:
            f.write("stand-in")

    _module("safetensors")
    _module("safetensors.torch", save_file=save_file, load_file=lambda path, device="cpu": saved[path][0], saved=saved)
    _module("comfy")
    _module("comfy.utils", common_upscale=lambda t, w, h, method, crop: t)
    _module("comfy.nested_tensor", NestedTensor=NestedTensor)
    _module("comfy.ldm")
    _module("comfy.ldm.minimax")
    _module("comfy.ldm.minimax.model", PackedLayout=PackedLayout)
    io = _Io("io")
    _module("comfy_api")
    _module("comfy_api.latest", io=io, ComfyExtension=type("ComfyExtension", (), {}))

    def conditioning_set_values(conditioning, values):
        return [[c[0], {**c[1], **values}] for c in conditioning]

    _module("node_helpers", conditioning_set_values=conditioning_set_values)
    # its model folders by name, as ComfyUI has them: the pack's parts sweep reads them in a thread at the start (none here)
    _module("folder_paths", folder_names_and_paths={})
    return torch


_install_stubs()


def _load_pack():
    spec = importlib.util.spec_from_file_location("afflatus_nodes", os.path.join(PACK, "__init__.py"), submodule_search_locations=[PACK])
    module = importlib.util.module_from_spec(spec)
    sys.modules["afflatus_nodes"] = module
    spec.loader.exec_module(module)
    return module


pack = _load_pack()


# What a script run with the real torch starts with: ComfyUI's io stood in for, and `load(name)` giving one of the pack's
# modules on its own (the pack folder is argv[1]); `peak_above(fn)`, the most memory `fn` held above what was held before it.
_TORCH_PREAMBLE = r"""
import importlib.util, os, sys, threading, types
import numpy as np
import torch

class _Io(types.ModuleType):
    ComfyNode = object

    @staticmethod
    def NodeOutput(*args, **kw):
        return args[0] if args else kw

    def __getattr__(self, name):
        return lambda *args, **kw: None


sys.modules["comfy_api"] = types.ModuleType("comfy_api")
sys.modules["comfy_api.latest"] = types.SimpleNamespace(io=_Io("io"))


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(sys.argv[1], name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def peak_above(fn):
    import psutil

    me = psutil.Process()
    start = me.memory_info().rss
    most = [start]
    done = threading.Event()

    def watch():
        while not done.is_set():
            most[0] = max(most[0], me.memory_info().rss)
            done.wait(0.002)

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    try:
        out = fn()
    finally:
        done.set()
        watcher.join()
    return out, (most[0] - start) / 2**20
"""


def with_torch(script, needs=("torch",)):
    """Runs `script` in a fresh interpreter with the real torch (the tests' torch is a stand-in), after _TORCH_PREAMBLE: what it
    prints. Skipped where torch (or another of `needs`) is not installed: ComfyUI's own venv runs it."""
    import subprocess

    if subprocess.run([sys.executable, "-I", "-c", "; ".join(f"import {n}" for n in needs)], capture_output=True).returncode != 0:
        pytest.skip(f"no {', '.join(needs)} here: ComfyUI's own venv runs this")
    run = subprocess.run([sys.executable, "-I", "-c", _TORCH_PREAMBLE + script, PACK], capture_output=True, text=True, timeout=300)
    assert run.returncode == 0, run.stderr[-3000:]
    return run.stdout


@pytest.fixture
def folders(tmp_path):
    """ComfyUI's input, temp and output folders, fresh for each test."""
    f = Folders(str(tmp_path))
    fp = sys.modules["folder_paths"]
    for name in ("get_input_directory", "get_temp_directory", "get_output_directory", "get_annotated_filepath", "exists_annotated_filepath", "get_save_image_path"):
        setattr(fp, name, getattr(f, name))
    return f


def av(frames, tag, audio=None, device="cpu", width=4, height=4):
    """An H3 latent of `frames` frames: its video tokens labelled (tag, i), its audio steps (tag, "a", i)."""
    from afflatus_nodes.continuation_nodes import audio_t_at_frame_boundary, video_latent_t

    tokens = video_latent_t(frames)
    steps = audio if audio is not None else audio_t_at_frame_boundary(frames)
    video = Tensor((1, 24, tokens, height, width), [(tag, i) for i in range(tokens)], device=device)
    sound = Tensor((1, 32, 2, steps), [(tag, "a", i) for i in range(steps)], device=device)
    return {"samples": NestedTensor((video, sound))}


def conditioning(*keyframes):
    return [["text", {"minimax_keyframes": list(keyframes)}]]

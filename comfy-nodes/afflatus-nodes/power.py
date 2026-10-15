"""The GPU's power draw, for the electricity Afflatus says a render on this PC cost (its Queue's Costs tab).

GET /afflatus/power → {"watts": 251.3, "gpus": [{"index": 0, "watts": 251.3}], "source": "nvml"}: the GPU ComfyUI renders on
when it can be told (its torch device, through CUDA_VISIBLE_DEVICES), else every NVIDIA GPU together. Read through NVML
(pynvml, from the nvidia-ml-py package) when it imports, else from `nvidia-smi` with a short time limit. Never fails: a
machine without an NVIDIA GPU, or without either, answers {"watts": null}. A reading is kept a second (Afflatus asks every
two at most, and two of its pages at once ask once), and a way that failed is not tried again for a minute: nvidia-smi is
a process started each time.
"""

import os
import shutil
import subprocess
import threading
import time

KEEP_S = 1.0
FAILED_S = 60.0
SMI_TIMEOUT_S = 2.0


def _nvml():
    try:
        import pynvml  # nvidia-ml-py

        pynvml.nvmlInit()
        return pynvml
    except Exception:
        return None


def read_nvml(nvml):
    """Each GPU's draw in watts through NVML, by its index; None when NVML does not answer."""
    try:
        out = []
        for i in range(nvml.nvmlDeviceGetCount()):
            try:
                out.append({"index": i, "watts": round(nvml.nvmlDeviceGetPowerUsage(nvml.nvmlDeviceGetHandleByIndex(i)) / 1000.0, 1)})
            except Exception:
                # a GPU that does not report its power (some older or passive cards): left out
                pass
        return out or None
    except Exception:
        return None


def read_smi(run=subprocess.run, which=shutil.which):
    """Each GPU's draw in watts from nvidia-smi, by its index; None without it, or when it does not answer in time."""
    exe = which("nvidia-smi")
    if not exe:
        return None
    try:
        done = run([exe, "--query-gpu=index,power.draw", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=SMI_TIMEOUT_S)
    except Exception:
        return None
    if done.returncode != 0:
        return None
    out = []
    for line in (done.stdout or "").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != 2:
            continue
        try:
            out.append({"index": int(parts[0]), "watts": round(float(parts[1]), 1)})
        except ValueError:
            # "[N/A]": a GPU that does not report it
            continue
    return out or None


def device_index(env=None):
    """The NVIDIA index of the GPU ComfyUI renders on, when it can be told: its torch device's index, through
    CUDA_VISIBLE_DEVICES when that lists indexes. None when it cannot (then every GPU is counted)."""
    env = os.environ if env is None else env
    try:
        import comfy.model_management as mm

        device = mm.get_torch_device()
        if getattr(device, "type", None) != "cuda":
            return None
        index = device.index or 0
    except Exception:
        return None
    visible = (env.get("CUDA_VISIBLE_DEVICES") or "").strip()
    if not visible:
        return index
    listed = [v.strip() for v in visible.split(",") if v.strip()]
    if index >= len(listed) or not listed[index].isdigit():
        # listed by UUID, or out of range: not told
        return None
    return int(listed[index])


class Power:
    """The readings, kept a second; NVML first, nvidia-smi after, each set aside a minute when it fails."""

    def __init__(self, nvml=_nvml, smi=read_smi, index=device_index, now=time.monotonic):
        self._nvml_of = nvml
        self._nvml = None
        self._nvml_tried = False
        self._smi = smi
        self._index = index
        self._now = now
        self._lock = threading.Lock()
        self._kept = None
        self._failed = {}

    def _usable(self, way):
        return self._now() >= self._failed.get(way, 0)

    def _gpus(self):
        if not self._nvml_tried:
            self._nvml_tried = True
            self._nvml = self._nvml_of()
        if self._nvml is not None and self._usable("nvml"):
            gpus = read_nvml(self._nvml)
            if gpus:
                return gpus, "nvml"
            self._failed["nvml"] = self._now() + FAILED_S
        if self._usable("smi"):
            gpus = self._smi()
            if gpus:
                return gpus, "nvidia-smi"
            self._failed["smi"] = self._now() + FAILED_S
        return None, None

    def read(self):
        with self._lock:
            if self._kept and self._now() - self._kept[0] < KEEP_S:
                return self._kept[1]
            gpus, source = self._gpus()
            if not gpus:
                said = {"watts": None, "gpus": [], "source": None}
            else:
                index = self._index()
                mine = [g for g in gpus if g["index"] == index] if index is not None else []
                watts = mine[0]["watts"] if mine else round(sum(g["watts"] for g in gpus), 1)
                said = {"watts": watts, "gpus": gpus, "source": source}
            self._kept = (self._now(), said)
            return said


def register(routes, web, power=None):
    power = power or Power()

    @routes.get("/afflatus/power")
    async def _afflatus_power(request):
        import asyncio

        # off ComfyUI's event loop: nvidia-smi is a process, which a render's progress must not wait for
        return web.json_response(await asyncio.to_thread(power.read))

    return power

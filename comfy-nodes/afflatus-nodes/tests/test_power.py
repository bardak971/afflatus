"""The GPU's power draw (GET /afflatus/power): NVML first, nvidia-smi after, kept a second, null where neither reads it."""

import subprocess
import sys
import types

from afflatus_nodes import power as P


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


class Nvml:
    """pynvml's calls that are used, over a list of milliwatts (None: that GPU does not report it)."""

    def __init__(self, milliwatts):
        self.milliwatts = milliwatts
        self.calls = 0

    def nvmlDeviceGetCount(self):
        self.calls += 1
        return len(self.milliwatts)

    def nvmlDeviceGetHandleByIndex(self, i):
        return i

    def nvmlDeviceGetPowerUsage(self, handle):
        if self.milliwatts[handle] is None:
            raise RuntimeError("not supported")
        return self.milliwatts[handle]


def test_nvml_reads_the_gpu_comfyui_renders_on():
    power = P.Power(nvml=lambda: Nvml([251_300, 30_000]), smi=lambda: None, index=lambda: 0, now=Clock())
    assert power.read() == {"watts": 251.3, "gpus": [{"index": 0, "watts": 251.3}, {"index": 1, "watts": 30.0}], "source": "nvml"}


def test_every_gpu_together_when_it_cannot_tell_which():
    power = P.Power(nvml=lambda: Nvml([200_000, 50_000, None]), smi=lambda: None, index=lambda: None, now=Clock())
    assert power.read()["watts"] == 250.0


def test_kept_a_second_then_read_again():
    clock = Clock()
    nvml = Nvml([100_000])
    power = P.Power(nvml=lambda: nvml, smi=lambda: None, index=lambda: 0, now=clock)
    power.read()
    nvml.milliwatts[0] = 300_000
    assert power.read()["watts"] == 100.0 and nvml.calls == 1
    clock.t += P.KEEP_S
    assert power.read()["watts"] == 300.0 and nvml.calls == 2


def test_nvidia_smi_when_nvml_is_not_there_and_null_when_neither_is():
    clock = Clock()
    asked = []

    def smi():
        asked.append(clock.t)
        return [{"index": 0, "watts": 180.5}]

    assert P.Power(nvml=lambda: None, smi=smi, index=lambda: 0, now=clock).read() == {"watts": 180.5, "gpus": [{"index": 0, "watts": 180.5}], "source": "nvidia-smi"}
    nothing = P.Power(nvml=lambda: None, smi=lambda: asked.append(clock.t) or None, index=lambda: 0, now=clock)
    asked.clear()
    assert nothing.read() == {"watts": None, "gpus": [], "source": None}
    # a way that failed is set aside a minute: not a process started every second for nothing
    clock.t += 5
    nothing.read()
    assert len(asked) == 1
    clock.t += P.FAILED_S
    nothing.read()
    assert len(asked) == 2


def test_nvidia_smi_output_parsed_its_na_left_out_and_a_slow_one_given_up():
    def run(args, **kwargs):
        assert args[1:] == ["--query-gpu=index,power.draw", "--format=csv,noheader,nounits"]
        assert kwargs["timeout"] == P.SMI_TIMEOUT_S
        return types.SimpleNamespace(returncode=0, stdout="0, 251.32\n1, [N/A]\n")

    assert P.read_smi(run=run, which=lambda name: "/usr/bin/nvidia-smi") == [{"index": 0, "watts": 251.3}]
    assert P.read_smi(run=run, which=lambda name: None) is None

    def slow(args, **kwargs):
        raise subprocess.TimeoutExpired(args, kwargs["timeout"])

    assert P.read_smi(run=slow, which=lambda name: "nvidia-smi") is None
    assert P.read_smi(run=lambda a, **k: types.SimpleNamespace(returncode=9, stdout=""), which=lambda name: "nvidia-smi") is None


def test_the_device_index_through_cuda_visible_devices(monkeypatch):
    device = types.SimpleNamespace(type="cuda", index=1)
    mm = types.ModuleType("comfy.model_management")
    mm.get_torch_device = lambda: device
    monkeypatch.setitem(sys.modules, "comfy.model_management", mm)
    monkeypatch.setattr(sys.modules["comfy"], "model_management", mm, raising=False)
    assert P.device_index({}) == 1
    assert P.device_index({"CUDA_VISIBLE_DEVICES": "2,3"}) == 3
    assert P.device_index({"CUDA_VISIBLE_DEVICES": "GPU-1234,GPU-5678"}) is None
    device.type = "cpu"
    assert P.device_index({}) is None

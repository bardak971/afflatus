"""ComfyUI opted out of Windows' EcoQoS at the pack's import (eco.py): a stand-in kernel32 says what it was asked; elsewhere nothing."""

import ctypes

from afflatus_nodes import eco


class Call:
    """A kernel32 function as ctypes gives it: argtypes and restype settable, each call kept."""

    def __init__(self, answer):
        self.answer, self.calls = answer, []

    def __call__(self, *args):
        self.calls.append(args)
        return self.answer() if callable(self.answer) else self.answer


class Kernel32:
    def __init__(self, answer=1):
        self.GetCurrentProcess = Call(-1)
        self.SetProcessInformation = Call(answer)


def test_windows_is_told_the_process_controls_its_execution_speed_and_keeps_it_on():
    kernel32 = Kernel32()
    assert eco.full_speed("win32", kernel32) is True
    [(process, kind, state, size)] = kernel32.SetProcessInformation.calls
    assert process == -1 and kind == 4  # the current process, ProcessPowerThrottling
    sent = state._obj  # what ctypes.byref points at
    assert isinstance(sent, eco.PowerThrottling) and size == ctypes.sizeof(sent) == 12
    assert (sent.Version, sent.ControlMask, sent.StateMask) == (1, 1, 0)
    assert kernel32.SetProcessInformation.argtypes[1] is ctypes.c_int


def test_nothing_is_done_off_windows():
    kernel32 = Kernel32()
    for platform in ("linux", "darwin"):
        assert eco.full_speed(platform, kernel32) is False
    assert kernel32.SetProcessInformation.calls == [] and kernel32.GetCurrentProcess.calls == []


def test_a_windows_that_refuses_or_lacks_it_changes_nothing_and_raises_nothing():
    # refused: a Windows before 10 1709 does not know the class
    assert eco.full_speed("win32", Kernel32(answer=0)) is False

    def raises():
        raise OSError("access denied")

    assert eco.full_speed("win32", Kernel32(answer=raises)) is False

    class Old:
        """A Windows before 8: no SetProcessInformation at all."""

        GetCurrentProcess = Call(-1)

    assert eco.full_speed("win32", Old()) is False


def test_the_pack_opts_out_once_at_its_import():
    """__init__.py calls it at import, before the nodes are loaded: read from its source, as importing the pack again would
    load every node module again too."""
    import inspect

    import afflatus_nodes

    source = inspect.getsource(afflatus_nodes)
    assert source.count("full_speed()") == 1 and source.index("full_speed()") < source.index("from .face_match import")

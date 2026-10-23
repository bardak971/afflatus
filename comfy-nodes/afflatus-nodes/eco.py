"""ComfyUI kept at full speed on Windows, however it was started.

Windows 11 runs a process it takes for background work under EcoQoS ("power throttling"): its threads go to the
efficiency cores at eco clocks. A ComfyUI started without a window (through WMI, a service, a hidden launcher) is taken for
one, and its CPU work slowed about seven times: Face Match's ArcFace took 437 ms a face against 61-71 ms started from a
console, the same as pinned to the E-cores (434 ms), on an i5-13600KF (2026-10-23). A process may say it is not background
work: execution-speed throttling under its own control and off. It is said once, at the pack's import, for the whole
process: ComfyUI renders for someone waiting, and its other CPU work (the prompt worker, the pack's other nodes, VAE steps on
the CPU) ran under the same throttle. Elsewhere (another OS, a Windows before 10 1709 without the setting) nothing is done,
and a failure is never more than a debug line.
"""

import ctypes
import logging
import sys

logger = logging.getLogger(__name__)

# SetProcessInformation's ProcessPowerThrottling class, and the one throttle it controls here (processthreadsapi.h)
PROCESS_POWER_THROTTLING = 4
PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1
PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1


class PowerThrottling(ctypes.Structure):
    """PROCESS_POWER_THROTTLING_STATE: which throttles the process controls (ControlMask), and which of those are on (StateMask)."""

    # Windows' ULONG is 32 bits everywhere; ctypes' c_ulong is 64 on Linux, where the tests (and a pod's CI) build it too
    _fields_ = [("Version", ctypes.c_uint32), ("ControlMask", ctypes.c_uint32), ("StateMask", ctypes.c_uint32)]


def full_speed(platform: str = sys.platform, windll=None) -> bool:
    """Opt this process out of EcoQoS on Windows; True when Windows took it. Never raises: off Windows, on a Windows without
    the setting, or on any failure, nothing changes and False is returned."""
    if platform != "win32":
        return False
    try:
        if windll is None:
            windll = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32 = windll
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        kernel32.SetProcessInformation.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        kernel32.SetProcessInformation.restype = ctypes.c_int
        # execution speed under the process's control, and off: whatever Windows would decide from its window, or lack of one
        state = PowerThrottling(PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED, 0)
        done = kernel32.SetProcessInformation(kernel32.GetCurrentProcess(), PROCESS_POWER_THROTTLING, ctypes.byref(state), ctypes.sizeof(state))
        if not done:
            logger.debug("afflatus-nodes: EcoQoS opt-out refused (error %s)", ctypes.get_last_error())
        return bool(done)
    except Exception as err:
        # a Windows before 8 has no SetProcessInformation; one before 10 1709 refuses the class: ComfyUI runs as it did
        logger.debug("afflatus-nodes: EcoQoS opt-out not available: %s", err)
        return False

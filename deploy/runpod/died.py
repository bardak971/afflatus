"""What the Afflatus pod knows when its ComfyUI ends without being asked to (start.sh runs it).

ComfyUI runs as start.sh's child, not in its place: when it dies (the kernel's out-of-memory killer, a crash in a
library) the container stays up, so RunPod does not start a fresh one that knows nothing of the render. Two steps:

  died.py start <state.json>               as ComfyUI starts: the time, and how many processes the out-of-memory killer
                                           had killed so far (a pip install may have been killed before, not ComfyUI)
  died.py end <exit code> <state.json> <report.json>
                                           when it has ended: the report broken.py serves as "comfy_died"

The report is numbers only: how ComfyUI ended, the container's memory (its peak and its limit, from its cgroup), the
GPU's memory at the end, how long it ran. Never a log line, a path or the environment: broken.py serves it to anyone
on ComfyUI's port. ComfyUI's last lines are in the boot log, served to the pod's token only.
"""

import json
import os
import subprocess
import sys
import time

CGROUP = "/sys/fs/cgroup"
GB = 1024**3


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read().strip()
    except OSError:
        return None


def number(text):
    """An integer from a cgroup file, or None ("max", missing, unreadable)."""
    try:
        return int(text)
    except (TypeError, ValueError):
        return None


def keyed(text, key):
    """The value of "<key> <n>" in a cgroup file of such lines (memory.events, memory.oom_control)."""
    for line in (text or "").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] == key:
            return number(parts[1])
    return None


def meminfo_total(root="/proc"):
    """The machine's RAM, for a container with no limit of its own."""
    for line in (read(f"{root}/meminfo") or "").splitlines():
        if line.startswith("MemTotal:"):
            kb = number(line.split()[1]) if len(line.split()) > 1 else None
            return kb * 1024 if kb is not None else None
    return None


def memory(root=CGROUP, proc="/proc"):
    """The container's memory as its cgroup counts it: {oom_kills, peak, limit, current} in bytes, None where unknown.
    cgroup v2 first (RunPod's hosts), v1's names after."""
    if read(f"{root}/memory.events") is not None:
        events = read(f"{root}/memory.events")
        oom = keyed(events, "oom_kill")
        peak = number(read(f"{root}/memory.peak"))
        limit = number(read(f"{root}/memory.max"))
        current = number(read(f"{root}/memory.current"))
    else:
        v1 = f"{root}/memory"
        oom = keyed(read(f"{v1}/memory.oom_control"), "oom_kill")
        peak = number(read(f"{v1}/memory.max_usage_in_bytes"))
        limit = number(read(f"{v1}/memory.limit_in_bytes"))
        current = number(read(f"{v1}/memory.usage_in_bytes"))
        # v1 says "no limit" as a huge number, near 2^63
        if limit is not None and limit >= 1 << 60:
            limit = None
    if limit is None:
        limit = meminfo_total(proc)
    return {"oom_kills": oom, "peak": peak, "limit": limit, "current": current}


def gpu_memory(run=subprocess.run):
    """The first GPU's memory used and total in bytes, as nvidia-smi says it now; (None, None) when it cannot."""
    try:
        out = run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=15,
        ).stdout
        used, total = (int(v.strip()) * 1024**2 for v in out.splitlines()[0].split(","))
        return used, total
    except Exception:
        return None, None


def how_it_ended(code):
    """(signal, exit code) from the shell's status: 128 + N for a process a signal ended."""
    return (code - 128, None) if code > 128 else (None, code)


def gb(n):
    return f"{n / GB:.1f}"


def summary(report):
    """One line, what Afflatus says first: why, with the memory's peak for a death of memory only. The container's peak counts
    the files it read too (the kernel's cache, given back on demand), so on any other death it reads near the limit and
    would point at the memory wrongly; it stays in the report's numbers."""
    peak, limit = report.get("ram_peak"), report.get("ram_limit")
    if report["cause"] == "oom":
        return "ComfyUI was killed: out of system memory" + (f" (peak {gb(peak)} of {gb(limit)} GB)" if peak and limit else "")
    if report["cause"] == "killed":
        return "ComfyUI was killed (SIGKILL), not by the out-of-memory killer"
    if report["cause"] == "signal":
        return f"ComfyUI ended on signal {report['signal']}"
    return f"ComfyUI stopped by itself (exit {report['exit']})"


def report_of(code, state, mem, gpu, now):
    signal, exit_code = how_it_ended(code)
    before = state.get("oom_kills") or 0
    oom = mem["oom_kills"] is not None and mem["oom_kills"] > before
    if signal == 9:
        cause = "oom" if oom else "killed"
    elif signal is not None:
        cause = "signal"
    else:
        cause = "exit"
    started = state.get("started")
    report = {
        "cause": cause,
        "signal": signal,
        "exit": exit_code,
        "oom_kills": (mem["oom_kills"] - before) if mem["oom_kills"] is not None else None,
        "ram_peak": mem["peak"],
        "ram_limit": mem["limit"],
        "vram_used": gpu[0],
        "vram_total": gpu[1],
        "ran_s": round(now - started) if isinstance(started, (int, float)) else None,
    }
    report["said"] = summary(report)
    return report


def main(argv):
    if len(argv) >= 3 and argv[1] == "start":
        with open(argv[2], "w", encoding="utf-8") as f:
            json.dump({"started": time.time(), "oom_kills": memory()["oom_kills"]}, f)
        return 0
    if len(argv) >= 5 and argv[1] == "end":
        try:
            code = int(argv[2])
        except ValueError:
            code = -1
        try:
            with open(argv[3], encoding="utf-8") as f:
                state = json.load(f)
        except (OSError, ValueError):
            state = {}
        report = report_of(code, state, memory(), gpu_memory(), time.time())
        tmp = argv[4] + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(report, f)
        os.replace(tmp, argv[4])
        print(f"[afflatus-pod] {report['said']}", flush=True)
        return 0
    print("usage: died.py start <state.json> | died.py end <exit code> <state.json> <report.json>", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

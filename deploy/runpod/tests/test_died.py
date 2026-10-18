"""died.py, what the pod writes when its ComfyUI ends without being asked to: how it ended, and the memory's numbers.

Standard library only, as the script is. The cgroup and /proc files are written in a temporary folder.
"""

import importlib.util
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("died", os.path.join(os.path.dirname(HERE), "died.py"))
died = importlib.util.module_from_spec(spec)
spec.loader.exec_module(died)

GB = 1024**3


def files(root, names):
    for name, text in names.items():
        path = os.path.join(root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)


class Memory(unittest.TestCase):
    def test_cgroup_v2(self):
        with tempfile.TemporaryDirectory() as d:
            files(d, {"memory.events": "low 0\nhigh 0\nmax 4\noom 1\noom_kill 2\n", "memory.peak": str(50 * GB),
                      "memory.max": str(52 * GB), "memory.current": str(3 * GB)})
            self.assertEqual(died.memory(d, proc=d), {"oom_kills": 2, "peak": 50 * GB, "limit": 52 * GB, "current": 3 * GB})

    def test_cgroup_v2_with_no_limit_takes_the_machines_ram(self):
        with tempfile.TemporaryDirectory() as d:
            files(d, {"memory.events": "oom_kill 0\n", "memory.max": "max", "meminfo": "MemTotal:       65536000 kB\nMemFree: 1 kB\n"})
            mem = died.memory(d, proc=d)
            self.assertEqual((mem["limit"], mem["peak"]), (65536000 * 1024, None))

    def test_cgroup_v1(self):
        with tempfile.TemporaryDirectory() as d:
            files(d, {"memory/memory.oom_control": "oom_kill_disable 0\nunder_oom 0\noom_kill 1\n",
                      "memory/memory.max_usage_in_bytes": str(40 * GB), "memory/memory.limit_in_bytes": str(1 << 62),
                      "memory/memory.usage_in_bytes": str(GB), "meminfo": "MemTotal: 1048576 kB\n"})
            self.assertEqual(died.memory(d, proc=d), {"oom_kills": 1, "peak": 40 * GB, "limit": GB, "current": GB})

    def test_nothing_readable(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(died.memory(d, proc=d), {"oom_kills": None, "peak": None, "limit": None, "current": None})


class Report(unittest.TestCase):
    mem = {"oom_kills": 3, "peak": int(49.8 * GB), "limit": 50 * GB, "current": GB}

    def test_the_out_of_memory_killer(self):
        r = died.report_of(137, {"started": 1000, "oom_kills": 2}, self.mem, (30 * GB, 48 * GB), 3100)
        self.assertEqual((r["cause"], r["signal"], r["exit"], r["oom_kills"], r["ran_s"]), ("oom", 9, None, 1, 2100))
        self.assertEqual(r["said"], "ComfyUI was killed: out of system memory (peak 49.8 of 50.0 GB)")

    def test_a_kill_the_out_of_memory_killer_did_not_make(self):
        r = died.report_of(137, {"started": 1000, "oom_kills": 3}, self.mem, (None, None), 1001)
        self.assertEqual((r["cause"], r["oom_kills"]), ("killed", 0))
        self.assertEqual(r["said"], "ComfyUI was killed (SIGKILL), not by the out-of-memory killer")
        self.assertEqual(r["ram_peak"], int(49.8 * GB))

    def test_a_crash_and_an_exit(self):
        # the memory's peak said only for a death of memory: on another, the kernel's file cache makes it read near the limit
        self.assertEqual(died.report_of(139, {}, self.mem, (None, None), 0)["said"], "ComfyUI ended on signal 11")
        r = died.report_of(1, {}, {"oom_kills": None, "peak": None, "limit": None, "current": None}, (None, None), 0)
        self.assertEqual((r["cause"], r["exit"], r["ran_s"], r["said"]), ("exit", 1, None, "ComfyUI stopped by itself (exit 1)"))

    def test_gpu_memory_from_nvidia_smi(self):
        class Done:
            stdout = "30210, 46068\n"

        self.assertEqual(died.gpu_memory(lambda *a, **k: Done()), (30210 * 1024**2, 46068 * 1024**2))

        def fails(*a, **k):
            raise FileNotFoundError("nvidia-smi")

        self.assertEqual(died.gpu_memory(fails), (None, None))


class Main(unittest.TestCase):
    def test_start_then_end_writes_a_report_of_numbers_only(self):
        with tempfile.TemporaryDirectory() as d:
            state, report = os.path.join(d, "state.json"), os.path.join(d, "died.json")
            self.assertEqual(died.main(["died.py", "start", state]), 0)
            self.assertEqual(died.main(["died.py", "end", "137", state, report]), 0)
            with open(report, encoding="utf-8") as f:
                got = json.load(f)
        self.assertEqual(set(got), {"cause", "signal", "exit", "oom_kills", "ram_peak", "ram_limit", "vram_used", "vram_total", "ran_s", "said"})
        self.assertEqual(got["signal"], 9)


if __name__ == "__main__":
    unittest.main()

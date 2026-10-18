"""broken.py, what the pod runs in ComfyUI's place when it cannot start it: what it says, and the watchdog it arms.

Standard library only, as the script is: `python -m unittest discover deploy/runpod/tests` runs them, and so does pytest.
"""

import importlib.util
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
spec = importlib.util.spec_from_file_location("broken", os.path.join(os.path.dirname(HERE), "broken.py"))
broken = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broken)

WATCHDOG = os.path.join(ROOT, "comfy-nodes", "afflatus-nodes", "watchdog.py")


class WhatFailed(unittest.TestCase):
    def test_a_start_that_failed_at_a_step(self):
        self.assertEqual(broken.what_failed(["broken.py", "--start", "putting in the node packs", "1"]), ("start_failed", "the start failed at putting in the node packs (exit 1)", None))
        self.assertEqual(broken.what_failed(["broken.py", "--start"]), ("start_failed", "the start failed at the start (exit ?)", None))

    def test_the_gpu_check_its_error_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "gpu.txt")
            with open(path, "w", encoding="utf-8") as f:
                f.write("Traceback\n  ...\nRuntimeError: CUDA error: unknown error\n\n")
            self.assertEqual(broken.what_failed(["broken.py", path]), ("gpu_failed", "RuntimeError: CUDA error: unknown error", None))
        self.assertEqual(broken.what_failed(["broken.py"]), ("gpu_failed", "the GPU check failed", None))

    def test_comfyui_that_died_its_report_and_nothing_else_of_the_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "died.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"cause": "oom", "signal": 9, "exit": None, "oom_kills": 1, "ram_peak": 53_000_000_000, "ram_limit": 53_687_091_200,
                           "vram_used": 30, "vram_total": 48, "ran_s": 2100, "said": "a line someone wrote, /workspace/secret/path",
                           "token": "secret", "ran_s_extra": "x"}, f)
            kind, error, report = broken.what_failed(["broken.py", "--died", path])
        # its line made again from the numbers served (died.py's), never the file's own: nothing else of it goes out
        self.assertEqual((kind, error), ("comfy_died", "ComfyUI was killed: out of system memory (peak 49.4 of 50.0 GB)"))
        self.assertEqual(report["cause"], "oom")
        self.assertEqual((report["signal"], report["ram_peak"], report["ran_s"]), (9, 53_000_000_000, 2100))
        self.assertNotIn("token", report)
        self.assertNotIn("ran_s_extra", report)

    def test_comfyui_that_died_without_a_report(self):
        kind, error, report = broken.what_failed(["broken.py", "--died", os.path.join(HERE, "no-such-report.json")])
        self.assertEqual((kind, error, report), ("comfy_died", "ComfyUI ended, and why could not be read", {"cause": None}))


class Answers(unittest.TestCase):
    def test_says_what_failed_at_its_address_and_503_elsewhere(self):
        body = json.dumps({"afflatus_pod": "start_failed", "error": "the start failed at x (exit 1)"}).encode()
        server = ThreadingHTTPServer(("127.0.0.1", 0), broken.handler(body))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            base = f"http://127.0.0.1:{server.server_address[1]}"
            with urllib.request.urlopen(base + "/afflatus/pod", timeout=5) as res:
                self.assertEqual(json.load(res)["afflatus_pod"], "start_failed")
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(base + "/prompt", timeout=5)
            self.assertEqual(caught.exception.code, 503)
        finally:
            server.shutdown()
            server.server_close()


class Watch(unittest.TestCase):
    def test_arms_the_node_packs_watchdog_from_the_pods_environment(self):
        env = {"RUNPOD_POD_ID": "pod1", "RUNPOD_API_KEY": "rpa_key", "AFFLATUS_WATCHDOG_MINUTES": "15", "AFFLATUS_WATCHDOG_ACTION": "stop"}
        dog = broken.watch(WATCHDOG, env=env)
        self.assertIsNotNone(dog)
        view = dog.view()
        self.assertTrue(view["watching"])
        self.assertEqual((view["minutes"], view["can"], view["end"]), (15, True, "stop"))

    def test_without_the_pack_it_says_so_and_goes_on(self):
        self.assertIsNone(broken.watch(os.path.join(HERE, "no-such-watchdog.py"), env={}))


if __name__ == "__main__":
    unittest.main()

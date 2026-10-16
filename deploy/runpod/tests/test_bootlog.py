"""The pod's boot log (bootlog.py): its stamping, and its server, which answers only with the pod's token.

Standard library only, as the script is: `python -m unittest discover deploy/runpod/tests` runs them, and so does pytest.
"""

import importlib.util
import io
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("bootlog", os.path.join(os.path.dirname(HERE), "bootlog.py"))
bootlog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootlog)

TOKEN = "t" * 43


class Stamp(unittest.TestCase):
    def test_each_line_stamped_and_echoed(self):
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "boot.log")
            echo = io.BytesIO()
            bootlog.stamp(log, io.BytesIO(b"[afflatus-pod] step: checking the GPU\n 10%|#\r 50%|#####\rdone\n"), echo)
            self.assertEqual(echo.getvalue(), b"[afflatus-pod] step: checking the GPU\n 10%|#\r 50%|#####\rdone\n")
            lines = bootlog.tail(log)
            self.assertEqual([x["m"] for x in lines], ["[afflatus-pod] step: checking the GPU", "done"])
            self.assertTrue(lines[0]["t"].endswith("Z"))

    def test_a_long_log_is_cut_to_its_last_half(self):
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "boot.log")
            line = b"x" * 1000 + b"\n"
            bootlog.stamp(log, io.BytesIO(line * (bootlog.MAX_FILE // 1000 + 10)), io.BytesIO())
            self.assertLessEqual(os.path.getsize(log), bootlog.MAX_FILE)
            self.assertTrue(all(x["m"] == "x" * 1000 for x in bootlog.tail(log)))

    def test_the_tail_is_bounded(self):
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "boot.log")
            with open(log, "w", encoding="utf-8", newline="
") as f:
                for i in range(1000):
                    f.write(f"2026-10-16T10:00:00.000Z line {i}\n")
            lines = bootlog.tail(log)
            self.assertEqual(len(lines), bootlog.MAX_LINES)
            self.assertEqual(lines[-1]["m"], "line 999")
            # the bytes read, and each line's {"t": …, "m": …} around it: a bound whatever the lines' length
            cut = bootlog.tail(log, 10_000, 4096)
            self.assertLessEqual(len(json.dumps(cut)), 4096 + 20 * len(cut))
            self.assertEqual(bootlog.tail(os.path.join(d, "none.log")), [])


class Token(unittest.TestCase):
    def test_only_a_token_that_is_one(self):
        self.assertEqual(bootlog.token_of({"AFFLATUS_TOKEN": TOKEN}), TOKEN)
        self.assertIsNone(bootlog.token_of({}))
        self.assertIsNone(bootlog.token_of({"AFFLATUS_TOKEN": "{{ RUNPOD_SECRET_afflatus-x }}"}))
        self.assertIsNone(bootlog.token_of({"AFFLATUS_TOKEN": "short"}))

    def test_bearer_compared(self):
        self.assertTrue(bootlog.allowed(f"Bearer {TOKEN}", TOKEN))
        self.assertTrue(bootlog.allowed(f"bearer {TOKEN}", TOKEN))
        self.assertFalse(bootlog.allowed(f"Bearer {TOKEN}x", TOKEN))
        self.assertFalse(bootlog.allowed(TOKEN, TOKEN))
        self.assertFalse(bootlog.allowed(None, TOKEN))
        self.assertFalse(bootlog.allowed("Bearer ", None))


class Server(unittest.TestCase):
    def serve(self, token):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        log = os.path.join(d.name, "boot.log")
        with open(log, "w", encoding="utf-8") as f:
            f.write("2026-10-16T10:00:00.000Z [afflatus-pod] step: starting ComfyUI\n")
        srv = bootlog.server(log, token, port=0, host="127.0.0.1")
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        return f"http://127.0.0.1:{srv.server_address[1]}"

    def ask(self, url, auth=None, method="GET"):
        req = urllib.request.Request(url, method=method, headers={"Authorization": auth} if auth else {})
        try:
            with urllib.request.urlopen(req, timeout=5) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read() or b"{}")

    def test_the_log_with_the_token(self):
        base = self.serve(TOKEN)
        status, body = self.ask(base + "/afflatus/boot", f"Bearer {TOKEN}")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"lines": [{"t": "2026-10-16T10:00:00.000Z", "m": "[afflatus-pod] step: starting ComfyUI"}]})

    def test_nothing_without_it(self):
        base = self.serve(TOKEN)
        self.assertEqual(self.ask(base + "/afflatus/boot")[0], 401)
        status, body = self.ask(base + "/afflatus/boot", "Bearer wrong-token-of-the-right-size-0000000000")
        self.assertEqual(status, 401)
        self.assertNotIn("lines", body)
        # a path elsewhere is refused before it is looked at, and with the token it is still only the one route
        self.assertEqual(self.ask(base + "/../../etc/passwd")[0], 401)
        self.assertEqual(self.ask(base + "/afflatus/boot/../../etc/passwd", f"Bearer {TOKEN}")[0], 404)
        self.assertEqual(self.ask(base + "/afflatus/boot", f"Bearer {TOKEN}", method="POST")[0], 405)

    def test_nobody_without_a_token_on_the_pod(self):
        base = self.serve(None)
        self.assertEqual(self.ask(base + "/afflatus/boot", "Bearer ")[0], 401)
        self.assertEqual(self.ask(base + "/afflatus/boot", f"Bearer {TOKEN}")[0], 401)


if __name__ == "__main__":
    unittest.main()

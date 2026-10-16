"""start.sh's failure path, run on its own with a stand-in python and sleep: a start that fails hands over to broken.py
(which arms the watchdog) instead of exiting into RunPod's restart loop, billed with no watchdog.

The part of start.sh between its "--- the failure path" marks is run under `set -e` as start.sh runs it, then a step that
fails. Needs a POSIX sh (skipped without one).
"""

import os
import re
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
START = os.path.join(os.path.dirname(HERE), "start.sh")
SH = shutil.which("sh")


def failure_path():
    with open(START, encoding="utf-8", newline="") as f:
        text = f.read()
    found = re.search(r"^# --- the failure path.*?^# --- end of the failure path$", text, re.M | re.S)
    if not found:
        raise AssertionError("start.sh has no failure path between its marks")
    return found.group(0)


@unittest.skipIf(SH is None, "no POSIX sh")
class FailurePath(unittest.TestCase):
    def run_start(self, then):
        with tempfile.TemporaryDirectory() as d:
            calls = os.path.join(d, "calls.txt")
            bin_dir = os.path.join(d, "bin")
            os.makedirs(bin_dir)
            # what start.sh's failure path runs, recorded rather than run: broken.py would serve forever, sleep wait 20 min
            for name in ("python", "sleep"):
                path = os.path.join(bin_dir, name)
                with open(path, "w", encoding="utf-8", newline="\n") as f:
                    f.write(f'#!/bin/sh\necho "{name} $*" >> "$CALLS"\n')
                os.chmod(path, 0o755)
            script = os.path.join(d, "start.sh")
            with open(script, "w", encoding="utf-8", newline="\n") as f:
                f.write("set -e\n" + failure_path() + "\n" + then + "\n")
            env = {**os.environ, "CALLS": calls, "PATH": bin_dir + os.pathsep + os.environ.get("PATH", "")}
            done = subprocess.run([SH, script], env=env, capture_output=True, text=True, timeout=60)
            if not os.path.exists(calls):
                return done, []
            with open(calls, encoding="utf-8") as f:
                return done, f.read().splitlines()

    def test_a_step_that_fails_hands_over_to_broken_py(self):
        done, said = self.run_start('step "putting in the node packs"\ncp /no/such/folder /no/such/place\necho "never here"')
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("[afflatus-pod] failed: putting in the node packs (exit 1)", done.stdout)
        self.assertNotIn("never here", done.stdout)
        self.assertEqual(said[0], "python -u /opt/afflatus-pod/broken.py --start putting in the node packs 1")
        # broken.py serves until the pod ends; should it not run, the start still waits rather than exit into a restart
        self.assertEqual(said[1:], ["sleep 1200"])

    def test_a_start_that_goes_on_to_comfyui_runs_nothing_of_it(self):
        done, said = self.run_start('step "starting ComfyUI"\ntrap - EXIT\necho "ComfyUI"')
        self.assertEqual(done.returncode, 0)
        self.assertEqual(said, [])

    def test_a_start_that_ends_well_runs_nothing_of_it(self):
        done, said = self.run_start('step "setting up ComfyUI-Manager"\ntrue')
        self.assertEqual(done.returncode, 0)
        self.assertEqual(said, [])


if __name__ == "__main__":
    unittest.main()

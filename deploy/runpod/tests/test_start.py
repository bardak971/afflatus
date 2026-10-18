"""start.sh's failure path and its run of ComfyUI, each run on its own with a stand-in python and sleep: a start that fails
hands over to broken.py (which arms the watchdog) instead of exiting into RunPod's restart loop, billed with no watchdog;
a ComfyUI that dies hands over to died.py and broken.py the same way; one that RunPod stops is stopped cleanly.

The part of start.sh between its "--- the failure path" marks is run under `set -e` as start.sh runs it, then a step that
fails. Needs a POSIX sh (skipped without one).
"""

import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
START = os.path.join(os.path.dirname(HERE), "start.sh")
SH = shutil.which("sh")


def part(name):
    with open(START, encoding="utf-8", newline="") as f:
        text = f.read()
    found = re.search(rf"^# --- the {name}.*?^# --- end of the {name}$", text, re.M | re.S)
    if not found:
        raise AssertionError(f"start.sh has no {name} between its marks")
    return found.group(0)


def failure_path():
    return part("failure path")


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


# a stand-in python: records its call, and as ComfyUI does what COMFY_DOES says
PYTHON = '#!/bin/sh\necho "python $*" >> "$CALLS"\ncase "$1" in /comfyui/main.py) echo "cli-session=${__COMFY_CLI_SESSION__:-}" >> "$CALLS"; eval "$COMFY_DOES";; esac\n'
# a ComfyUI that runs until it is stopped, and says it was
RUNS_UNTIL_STOPPED = 'trap \'echo comfy-stopped >> "$CALLS"; exit 0\' TERM; while :; do "$REAL_SLEEP" 0.1; done'


@unittest.skipIf(SH is None or sys.platform == "win32", "no POSIX sh with POSIX signals")
class Run(unittest.TestCase):
    """The run: ComfyUI started as start.sh's child, waited for, its end handed over or its stop passed on."""

    def start(self, comfy_does, d):
        calls = os.path.join(d, "calls.txt")
        bin_dir = os.path.join(d, "bin")
        os.makedirs(bin_dir)
        for name, text in (("python", PYTHON), ("sleep", '#!/bin/sh\necho "sleep $*" >> "$CALLS"\n')):
            path = os.path.join(bin_dir, name)
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
            os.chmod(path, 0o755)
        script = os.path.join(d, "start.sh")
        with open(script, "w", encoding="utf-8", newline="\n") as f:
            # its files in this test's folder, not /tmp
            f.write("set -e\nPOD=/opt/afflatus-pod\nBASE=/b\n" + part("run").replace("/tmp/", d + "/") + "\n")
        # set as comfy-cli sets it: ComfyUI-Manager's restart would then exit instead of restarting in place (start.sh unsets it)
        env = {**os.environ, "CALLS": calls, "COMFY_DOES": comfy_does, "REAL_SLEEP": shutil.which("sleep") or "/bin/sleep", "__COMFY_CLI_SESSION__": "1",
               "PATH": bin_dir + os.pathsep + os.environ.get("PATH", "")}
        return subprocess.Popen([SH, script], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True), calls

    def said(self, calls):
        if not os.path.exists(calls):
            return []
        with open(calls, encoding="utf-8") as f:
            return f.read().splitlines()

    def test_comfyui_that_dies_hands_over_to_died_py_and_broken_py(self):
        with tempfile.TemporaryDirectory() as d:
            proc, calls = self.start("kill -9 $$", d)
            out, _ = proc.communicate(timeout=60)
            said = self.said(calls)
        self.assertIn("[afflatus-pod] ComfyUI ended (status 137)", out)
        self.assertEqual(said[0], f"python -u /opt/afflatus-pod/died.py start {d}/afflatus-comfy.json")
        self.assertTrue(said[1].startswith("python /comfyui/main.py --listen 0.0.0.0 --port 8188"))
        # pinned memory off: the weights it pins filled a pod's RAM and got ComfyUI killed (start.sh)
        self.assertIn("--disable-pinned-memory", said[1])
        # never started again: the report, broken.py, and the wait should broken.py not run
        self.assertEqual(said[2], "cli-session=")
        self.assertEqual(said[3:], [
            f"python -u /opt/afflatus-pod/died.py end 137 {d}/afflatus-comfy.json {d}/afflatus-died.json",
            f"python -u /opt/afflatus-pod/broken.py --died {d}/afflatus-died.json",
            "sleep 1200",
        ])

    def test_comfyui_that_exits_on_an_error_is_said_with_its_code(self):
        with tempfile.TemporaryDirectory() as d:
            proc, calls = self.start("exit 3", d)
            out, _ = proc.communicate(timeout=60)
            said = self.said(calls)
        self.assertIn("[afflatus-pod] ComfyUI ended (status 3)", out)
        self.assertIn(f"python -u /opt/afflatus-pod/died.py end 3 {d}/afflatus-comfy.json {d}/afflatus-died.json", said)

    def test_a_stop_from_runpod_is_passed_on_and_ends_cleanly(self):
        with tempfile.TemporaryDirectory() as d:
            proc, calls = self.start(RUNS_UNTIL_STOPPED, d)
            pid = os.path.join(d, "afflatus-comfy.pid")
            for _ in range(200):
                if os.path.exists(pid) and os.path.getsize(pid) > 0:
                    break
                time.sleep(0.05)
            time.sleep(0.5)
            proc.send_signal(signal.SIGTERM)
            out, _ = proc.communicate(timeout=60)
            said = self.said(calls)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("comfy-stopped", said)
        self.assertNotIn("ComfyUI ended", out)
        self.assertFalse(any("died.py end" in line or "broken.py" in line for line in said))


if __name__ == "__main__":
    unittest.main()

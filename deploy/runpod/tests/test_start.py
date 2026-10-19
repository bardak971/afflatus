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


# a stand-in sleep: records its call, and at its second one stops the script as RunPod would (its parent: the script, or
# the script's own `child`). A wait that ends would have come back once only; one that loops until the pod ends, twice
SLEEP = '#!/bin/sh\necho "sleep $*" >> "$CALLS"\n[ "$(grep -c "^sleep" "$CALLS")" -lt 2 ] || kill -TERM "$PPID"\n'


@unittest.skipIf(SH is None, "no POSIX sh")
class FailurePath(unittest.TestCase):
    def run_start(self, then):
        with tempfile.TemporaryDirectory() as d:
            calls = os.path.join(d, "calls.txt")
            bin_dir = os.path.join(d, "bin")
            os.makedirs(bin_dir)
            # what start.sh's failure path runs, recorded rather than run: broken.py would serve forever, sleep wait 20 min
            for name, text in (("python", '#!/bin/sh\necho "python $*" >> "$CALLS"\n'), ("sleep", SLEEP)):
                path = os.path.join(bin_dir, name)
                with open(path, "w", encoding="utf-8", newline="\n") as f:
                    f.write(text)
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
        self.assertIn("[afflatus-pod] failed: putting in the node packs (exit 1)", done.stdout)
        self.assertNotIn("never here", done.stdout)
        self.assertEqual(said[0], "python -u /opt/afflatus-pod/broken.py --start putting in the node packs 1")
        # broken.py serves until the pod ends; should it not run, the start waits until the pod ends, never exits into a
        # restart (RunPod's every 20 minutes): its stop ends it (cleanly under dash, the image's sh: StopDuringTheStart)
        self.assertEqual(said[1:], ["sleep 1200", "sleep 1200"])

    def test_a_start_that_goes_on_to_comfyui_runs_nothing_of_it(self):
        done, said = self.run_start('step "starting ComfyUI"\ntrap - EXIT\necho "ComfyUI"')
        self.assertEqual(done.returncode, 0)
        self.assertEqual(said, [])

    def test_a_start_that_ends_well_runs_nothing_of_it(self):
        done, said = self.run_start('step "setting up ComfyUI-Manager"\ntrue')
        self.assertEqual(done.returncode, 0)
        self.assertEqual(said, [])


# a stand-in python: records its call, and as ComfyUI does what COMFY_DOES says
PYTHON = (
    '#!/bin/sh\necho "python $*" >> "$CALLS"\n'
    'case "$1" in /comfyui/main.py) echo "cli-session=${__COMFY_CLI_SESSION__:-}" >> "$CALLS"; eval "$COMFY_DOES";; esac\n'
    # broken.py serving until the pod ends; died.py's start taking a while (a stop can land meanwhile)
    'case "$*" in *broken.py*) [ -z "$BROKEN_FAILS" ] || exit 1; [ -z "$BROKEN_BLOCKS" ] || exec "$REAL_SLEEP" 30;; *"died.py start"*) [ -z "$START_BLOCKS" ] || "$REAL_SLEEP" 2;;'
    ' *"died.py end"*) [ -z "$END_BLOCKS" ] || "$REAL_SLEEP" 2;; esac\n'
    # the GPU check: a GPU that fails
    'case "$1" in -c) [ -z "$GPU_FAILS" ] || exit 1;; esac\n'
)
# a ComfyUI that runs until it is stopped, and says it was
RUNS_UNTIL_STOPPED = 'trap \'echo comfy-stopped >> "$CALLS"; exit 0\' TERM; while :; do "$REAL_SLEEP" 0.1; done'
# one that takes a while to stop (it saves, it unloads): the script must wait for it, not end at the first TERM
STOPS_SLOWLY = 'trap \'"$REAL_SLEEP" 1.5; echo comfy-stopped >> "$CALLS"; exit 0\' TERM; while :; do "$REAL_SLEEP" 0.1; done'


@unittest.skipIf(SH is None or sys.platform == "win32", "no POSIX sh with POSIX signals")
class Run(unittest.TestCase):
    """The run: ComfyUI started as start.sh's child, waited for, its end handed over or its stop passed on."""

    def start(self, comfy_does, d, **extra):
        calls = os.path.join(d, "calls.txt")
        bin_dir = os.path.join(d, "bin")
        os.makedirs(bin_dir)
        for name, text in (("python", PYTHON), ("sleep", SLEEP)):
            path = os.path.join(bin_dir, name)
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
            os.chmod(path, 0o755)
        script = os.path.join(d, "start.sh")
        with open(script, "w", encoding="utf-8", newline="\n") as f:
            # its files in this test's folder, not /tmp
            f.write("set -e\nPOD=/opt/afflatus-pod\nBASE=/b\n" + part("run").replace("/tmp/", d + "/") + "\n")
        # set as comfy-cli sets it: ComfyUI-Manager's restart would then exit instead of restarting in place (start.sh unsets it)
        env = {**os.environ, "CALLS": calls, "COMFY_DOES": comfy_does, "REAL_SLEEP": shutil.which("sleep") or "/bin/sleep", "__COMFY_CLI_SESSION__": "1", **extra,
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
            # until the pod ends, not 20 minutes: RunPod would start the container again, billed
            "sleep 1200", "sleep 1200",
        ])

    def test_comfyui_that_dies_with_no_broken_py_ends_the_start_after_20_minutes(self):
        # no broken.py, no watchdog: held for ever, the pod billed without end with Afflatus away. RunPod starts it again
        with tempfile.TemporaryDirectory() as d:
            proc, calls = self.start("kill -9 $$", d, BROKEN_FAILS="1")
            out, _ = proc.communicate(timeout=60)
            said = self.said(calls)
        self.assertIn("broken.py did not run: no watchdog; the start ends in 20 minutes", out)
        self.assertEqual(said[-2:], [f"python -u /opt/afflatus-pod/broken.py --died {d}/afflatus-died.json", "sleep 1200"])
        self.assertEqual(proc.returncode, 1)

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

    def wait_for(self, path, line=None):
        for _ in range(200):
            if os.path.exists(path) and os.path.getsize(path) > 0 and (line is None or any(line in x for x in self.said(path))):
                return
            time.sleep(0.05)
        raise AssertionError(f"never came: {line or path}")

    def test_a_comfyui_slow_to_stop_is_waited_for(self):
        # the trap ends `wait` at once: without waiting again, the script would end while ComfyUI still saves
        with tempfile.TemporaryDirectory() as d:
            proc, calls = self.start(STOPS_SLOWLY, d)
            self.wait_for(os.path.join(d, "afflatus-comfy.pid"))
            time.sleep(0.5)
            sent = time.monotonic()
            proc.send_signal(signal.SIGTERM)
            # the script's own end, not its output's: a ComfyUI it left behind would keep that open as long
            proc.wait(timeout=60)
            took = time.monotonic() - sent
            proc.communicate(timeout=60)
            said = self.said(calls)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("comfy-stopped", said)
        self.assertGreaterEqual(took, 1.2)

    def test_a_stop_after_a_death_ends_the_script_at_once(self):
        # broken.py serving; RunPod's stop must not be lost on PID 1 until its SIGKILL
        with tempfile.TemporaryDirectory() as d:
            proc, calls = self.start("exit 3", d, BROKEN_BLOCKS="1")
            self.wait_for(calls, "broken.py --died")
            time.sleep(0.3)
            sent = time.monotonic()
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=60)
            took = time.monotonic() - sent
            proc.communicate(timeout=60)
        self.assertEqual(proc.returncode, 0)
        self.assertLess(took, 5)

    def test_a_stop_while_the_report_is_written_starts_no_broken_py(self):
        # the stop came during died.py's end: taken by the run's own trap, it left broken.py started all the same
        with tempfile.TemporaryDirectory() as d:
            proc, calls = self.start("exit 3", d, END_BLOCKS="1")
            self.wait_for(calls, "died.py end")
            proc.send_signal(signal.SIGTERM)
            proc.communicate(timeout=60)
            said = self.said(calls)
        self.assertEqual(proc.returncode, 0)
        self.assertFalse(any("broken.py" in line for line in said))

    def test_a_stop_before_comfyui_starts_ends_cleanly_and_starts_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            proc, calls = self.start(RUNS_UNTIL_STOPPED, d, START_BLOCKS="1")
            self.wait_for(calls, "died.py start")
            proc.send_signal(signal.SIGTERM)
            out, _ = proc.communicate(timeout=60)
            said = self.said(calls)
            # never started: its PID is written once it is (a ComfyUI started then stopped may die before it says a word)
            started = os.path.exists(os.path.join(d, "afflatus-comfy.pid"))
        self.assertEqual(proc.returncode, 0)
        self.assertFalse(started)
        self.assertFalse(any("/comfyui/main.py" in line for line in said))
        self.assertNotIn("ComfyUI ended", out)


@unittest.skipIf(SH is None or sys.platform == "win32", "no POSIX sh with POSIX signals")
class StopDuringTheStart(unittest.TestCase):
    """RunPod's stop before ComfyUI runs: heard at once, during a long step, while broken.py serves after a failed step or a
    failed GPU check; never waited out to RunPod's SIGKILL."""

    said = Run.said
    wait_for = Run.wait_for

    def start(self, then, d, gpu=False, **extra):
        calls = os.path.join(d, "calls.txt")
        bin_dir = os.path.join(d, "bin")
        os.makedirs(bin_dir)
        for name, text in (("python", PYTHON), ("sleep", SLEEP)):
            path = os.path.join(bin_dir, name)
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
            os.chmod(path, 0o755)
        script = os.path.join(d, "start.sh")
        with open(script, "w", encoding="utf-8", newline="\n") as f:
            gpu_part = part("GPU check").replace("/tmp/", d + "/") + "\n" if gpu else ""
            f.write("set -e\n" + failure_path() + "\n" + gpu_part + then + "\n")
        env = {**os.environ, "CALLS": calls, "REAL_SLEEP": shutil.which("sleep") or "/bin/sleep", "COMFY_DOES": "", **extra,
               "PATH": bin_dir + os.pathsep + os.environ.get("PATH", "")}
        return subprocess.Popen([SH, script], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True), calls

    def stopped(self, proc, calls, line):
        self.wait_for(calls, line)
        time.sleep(0.3)
        sent = time.monotonic()
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=60)
        took = time.monotonic() - sent
        out, _ = proc.communicate(timeout=60)
        return took, out, self.said(calls)

    def test_during_a_long_step(self):
        # a node pack's packages, up to 10 minutes: the stop ends the step and the start at once, and nothing is handed over
        with tempfile.TemporaryDirectory() as d:
            proc, calls = self.start('step "installing the Python packages of x (1/1)"\necho installing >> "$CALLS"\nchild "$REAL_SLEEP" 30\necho "never here"', d)
            took, out, said = self.stopped(proc, calls, "installing")
        self.assertEqual(proc.returncode, 0)
        self.assertLess(took, 5)
        self.assertNotIn("never here", out)
        self.assertNotIn("failed:", out)
        self.assertFalse(any("broken.py" in line for line in said))

    def test_while_broken_py_serves_after_a_failed_step(self):
        with tempfile.TemporaryDirectory() as d:
            proc, calls = self.start('step "putting in the node packs"\nfalse', d, BROKEN_BLOCKS="1")
            took, _, _ = self.stopped(proc, calls, "broken.py --start")
        self.assertEqual(proc.returncode, 0)
        self.assertLess(took, 5)

    def test_a_failed_step_with_no_broken_py_ends_the_start_after_20_minutes(self):
        with tempfile.TemporaryDirectory() as d:
            proc, calls = self.start('step "putting in the node packs"\nfalse', d, BROKEN_FAILS="1")
            out, _ = proc.communicate(timeout=60)
            said = self.said(calls)
        self.assertIn("broken.py did not run: no watchdog; the start ends in 20 minutes", out)
        self.assertEqual(said, ["python -u /opt/afflatus-pod/broken.py --start putting in the node packs 1", "sleep 1200"])
        self.assertEqual(proc.returncode, 1)

    def test_a_failed_gpu_with_no_broken_py_ends_the_start_after_20_minutes(self):
        with tempfile.TemporaryDirectory() as d:
            proc, calls = self.start('echo "never here"', d, gpu=True, GPU_FAILS="1", BROKEN_FAILS="1")
            out, _ = proc.communicate(timeout=60)
            said = self.said(calls)
        self.assertNotIn("never here", out)
        self.assertEqual(said[-2:], [f"python /opt/afflatus-pod/broken.py {d}/afflatus-gpu.txt", "sleep 1200"])
        self.assertEqual(proc.returncode, 1)

    def test_while_broken_py_serves_after_the_gpu_failed(self):
        # broken.py was this script's replacement (exec), PID 1 then: RunPod's stop went unheard until its SIGKILL
        with tempfile.TemporaryDirectory() as d:
            proc, calls = self.start('echo "never here"', d, gpu=True, GPU_FAILS="1", BROKEN_BLOCKS="1")
            took, out, said = self.stopped(proc, calls, "broken.py")
        self.assertEqual(proc.returncode, 0)
        self.assertLess(took, 5)
        self.assertNotIn("never here", out)
        self.assertIn(f"python /opt/afflatus-pod/broken.py {d}/afflatus-gpu.txt", said)


if __name__ == "__main__":
    unittest.main()

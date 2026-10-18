"""The Afflatus pod's answer when it cannot start ComfyUI (start.sh runs it in place of ComfyUI).

Three cases. Its GPU does not work on this host (a host's driver or GPU in a bad state: "CUDA unknown error"), so ComfyUI
would crash at every start: `broken.py <file of torch's error>`. Or a step of the start failed (a volume full, a write
refused): `broken.py --start "<step>" <exit code>`; exiting would have RunPod start the container again, fail at the same
step and bill on with no watchdog, since the node pack's runs only inside ComfyUI. Or ComfyUI ran and died
(`broken.py --died <report.json>`, died.py's report): "comfy_died", served with its numbers, and Afflatus fails the
render it was doing, says why and terminates the pod.

Either way the pod would bill for nothing. This answers on ComfyUI's port instead: GET /afflatus/pod says what failed
("gpu_failed", which Afflatus terminates at once and says why; "start_failed", whose step the boot log says too, read by
Afflatus the same way), and every other address answers 503. It holds no secret and runs nothing. Afflatus away (its PC
asleep right after the deploy), the node pack's watchdog stops the pod by itself as it would in ComfyUI: its minutes from
the pod's environment, counted from now, since no "still here" ever comes here.
"""

import importlib.util
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PACK = "/opt/afflatus-nodes/watchdog.py"
# died.py, beside this script in the image: its line made again from the numbers served, never taken from the file as written
DIED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "died.py")


def say(line):
    """A line to the boot log, whose pipe may be gone (its stamper killed with ComfyUI): never in the way of what follows."""
    try:
        print(line, flush=True)
    except OSError:
        pass


def summary(report):
    """died.py's line for these numbers; a plain one when died.py cannot be loaded."""
    try:
        spec = importlib.util.spec_from_file_location("afflatus_died", DIED)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.summary(report)
    except Exception:
        return "ComfyUI died"


def watch(pack=PACK, env=None):
    """The node pack's watchdog, armed from the environment, in a thread: the pod stops when nobody ends it first. The
    watchdog, or None when the pack could not be loaded (said in the log)."""
    try:
        spec = importlib.util.spec_from_file_location("afflatus_watchdog", pack)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        dog = mod.armed_at_start(mod.Watchdog(mod.how_to_stop(env), env=env), env=env)
        threading.Thread(target=dog.loop, name="afflatus-watchdog", daemon=True).start()
        return dog
    except Exception as err:
        say(f"[afflatus-pod] no watchdog: {err}")
        return None


def said(path: str) -> str:
    """The last line torch wrote: its error, short."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = [line.strip() for line in f if line.strip()]
    except OSError:
        return "the GPU check failed"
    return (lines[-1] if lines else "the GPU check failed")[:300]


# what a report may hold: died.py writes only these, and only these are served, whatever the file holds
CAUSES = ("oom", "killed", "signal", "exit")
NUMBERS = ("signal", "exit", "oom_kills", "ram_peak", "ram_limit", "vram_used", "vram_total", "ran_s")


def died_report(path):
    """(error, report) from died.py's report: its line and its numbers, nothing else of the file."""
    try:
        with open(path, encoding="utf-8") as f:
            got = json.load(f)
    except (OSError, ValueError):
        got = None
    if not isinstance(got, dict) or got.get("cause") not in CAUSES:
        return "ComfyUI ended, and why could not be read", {"cause": None}
    report = {"cause": got["cause"]}
    for key in NUMBERS:
        value = got.get(key)
        report[key] = value if isinstance(value, int) and not isinstance(value, bool) else None
    return summary(report)[:300], report


def what_failed(argv):
    """(kind, error, report) from the command line: a start's step and exit code after --start, died.py's report after
    --died, else the GPU check's error file."""
    if len(argv) > 2 and argv[1] == "--died":
        return ("comfy_died",) + died_report(argv[2])
    if len(argv) > 1 and argv[1] == "--start":
        step = (argv[2] if len(argv) > 2 else "").strip() or "the start"
        code = argv[3] if len(argv) > 3 else "?"
        return "start_failed", f"the start failed at {step} (exit {code})"[:300], None
    return "gpu_failed", said(argv[1]) if len(argv) > 1 else "the GPU check failed", None


def handler(body: bytes):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            ok = self.path.split("?")[0] == "/afflatus/pod"
            self.send_response(200 if ok else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args) -> None:
            pass

    return Handler


def main(argv, port=8188):
    kind, error, report = what_failed(argv)
    answer = {"afflatus_pod": kind, "error": error}
    if report is not None:
        answer["report"] = report
    body = json.dumps(answer).encode()
    # the GPU's failure is said here; a start's was said by start.sh already, as the boot log's "failed:" line, and
    # ComfyUI's death by died.py
    if kind == "gpu_failed":
        say(f"[afflatus-pod] failed: the GPU does not work on this host: {error}")
    elif kind == "comfy_died":
        say("[afflatus-pod] the pod waits here, its watchdog armed")
    else:
        say(f"[afflatus-pod] {error}: the pod waits here, its watchdog armed")
    watch()
    ThreadingHTTPServer(("0.0.0.0", port), handler(body)).serve_forever()


if __name__ == "__main__":
    main(sys.argv)

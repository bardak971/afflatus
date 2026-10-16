"""The Afflatus pod's answer when it cannot start ComfyUI (start.sh runs it in place of ComfyUI).

Two cases. Its GPU does not work on this host (a host's driver or GPU in a bad state: "CUDA unknown error"), so ComfyUI
would crash at every start: `broken.py <file of torch's error>`. Or a step of the start failed (a volume full, a write
refused): `broken.py --start "<step>" <exit code>`; exiting would have RunPod start the container again, fail at the same
step and bill on with no watchdog, since the node pack's runs only inside ComfyUI.

Either way the pod would bill for nothing. This answers on ComfyUI's port instead: GET /afflatus/pod says what failed
("gpu_failed", which Afflatus terminates at once and says why; "start_failed", whose step the boot log says too, read by
Afflatus the same way), and every other address answers 503. It holds no secret and runs nothing. Afflatus away (its PC
asleep right after the deploy), the node pack's watchdog stops the pod by itself as it would in ComfyUI: its minutes from
the pod's environment, counted from now, since no "still here" ever comes here.
"""

import importlib.util
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PACK = "/opt/afflatus-nodes/watchdog.py"


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
        print(f"[afflatus-pod] no watchdog: {err}", flush=True)
        return None


def said(path: str) -> str:
    """The last line torch wrote: its error, short."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = [line.strip() for line in f if line.strip()]
    except OSError:
        return "the GPU check failed"
    return (lines[-1] if lines else "the GPU check failed")[:300]


def what_failed(argv):
    """(kind, error) from the command line: a start's step and exit code after --start, else the GPU check's error file."""
    if len(argv) > 1 and argv[1] == "--start":
        step = (argv[2] if len(argv) > 2 else "").strip() or "the start"
        code = argv[3] if len(argv) > 3 else "?"
        return "start_failed", f"the start failed at {step} (exit {code})"[:300]
    return "gpu_failed", said(argv[1]) if len(argv) > 1 else "the GPU check failed"


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
    kind, error = what_failed(argv)
    body = json.dumps({"afflatus_pod": kind, "error": error}).encode()
    # the GPU's failure is said here; a start's was said by start.sh already, as the boot log's "failed:" line
    if kind == "gpu_failed":
        print(f"[afflatus-pod] failed: the GPU does not work on this host: {error}", flush=True)
    else:
        print(f"[afflatus-pod] {error}: the pod waits here, its watchdog armed", flush=True)
    watch()
    ThreadingHTTPServer(("0.0.0.0", port), handler(body)).serve_forever()


if __name__ == "__main__":
    main(sys.argv)

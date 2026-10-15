"""The Afflatus pod's answer when its GPU does not work on this host (start.sh runs it in place of ComfyUI).

Torch could not use the GPU (a host's driver or GPU in a bad state: "CUDA unknown error"), so ComfyUI would crash at every
start and the pod would bill for nothing. This answers on ComfyUI's port instead: GET /afflatus/pod says what failed, so that
Afflatus terminates the pod at once and says why; every other address answers 503. It holds no secret and runs nothing.
Afflatus away (its PC asleep right after the deploy), the node pack's watchdog stops the pod by itself as it would in
ComfyUI: its minutes from the pod's environment, counted from now, since no "still here" ever comes here.
"""

import importlib.util
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PACK = "/opt/afflatus-nodes/watchdog.py"


def watch():
    """The node pack's watchdog, armed from the environment, in a thread: the pod stops when nobody ends it first."""
    try:
        spec = importlib.util.spec_from_file_location("afflatus_watchdog", PACK)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        dog = mod.armed_at_start(mod.Watchdog(mod.how_to_stop()))
        threading.Thread(target=dog.loop, name="afflatus-watchdog", daemon=True).start()
    except Exception as err:
        print(f"[afflatus-pod] no watchdog: {err}", flush=True)


def said(path: str) -> str:
    """The last line torch wrote: its error, short."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = [line.strip() for line in f if line.strip()]
    except OSError:
        return "the GPU check failed"
    return (lines[-1] if lines else "the GPU check failed")[:300]


ERROR = said(sys.argv[1]) if len(sys.argv) > 1 else "the GPU check failed"
BODY = json.dumps({"afflatus_pod": "gpu_failed", "error": ERROR}).encode()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        ok = self.path.split("?")[0] == "/afflatus/pod"
        self.send_response(200 if ok else 503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)

    def log_message(self, *args) -> None:
        pass


if __name__ == "__main__":
    print(f"[afflatus-pod] failed: the GPU does not work on this host: {ERROR}", flush=True)
    watch()
    ThreadingHTTPServer(("0.0.0.0", 8188), Handler).serve_forever()

"""The Afflatus pod's answer when its GPU does not work on this host (start.sh runs it in place of ComfyUI).

Torch could not use the GPU (a host's driver or GPU in a bad state: "CUDA unknown error"), so ComfyUI would crash at every
start and the pod would bill for nothing. This answers on ComfyUI's port instead: GET /afflatus/pod says what failed, so that
Afflatus terminates the pod at once and says why; every other address answers 503. It holds no secret and runs nothing.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


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
    print(f"[afflatus-pod] the GPU does not work on this host: {ERROR}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8188), Handler).serve_forever()

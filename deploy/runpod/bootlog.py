"""The Afflatus pod's boot log: each step of its start, stamped, and ComfyUI's own output after them (start.sh).

Two parts, one file, the standard library only (the image has nothing else before ComfyUI's requirements):

  bootlog.py stamp <log>   reads the start's output on its standard input and writes each line to the log with its time
                           (UTC, ISO), and as it is to its own output (RunPod's container log keeps it as before). The log is
                           kept short: past MAX_FILE it is cut to its last half.
  bootlog.py serve <log>   answers GET /afflatus/boot on BOOT_PORT with the log's last lines as JSON, for the pod's whole life:
                           Afflatus reads it through RunPod's proxy while ComfyUI is not up yet, and shows where the start is.

The server answers only with the pod's lock token (AFFLATUS_TOKEN, the one its node pack locks ComfyUI with), as a Bearer,
compared in constant time: nothing without it (401), and nothing at all when the pod has no token that is one (a RunPod
secret's reference left as it is). GET only, one route, one fixed file, its last MAX_LINES lines of at most MAX_BYTES. It
never says the environment or the token: start.sh writes only its steps, and ComfyUI does not print them.
"""

import hmac
import json
import os
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BOOT_PORT = 8189
ROUTE = "/afflatus/boot"
MAX_LINES = 300
MAX_BYTES = 64 * 1024
# a line of ComfyUI's longer than this (a progress bar redrawn many times on one line) is cut: its end is what says most
MAX_LINE = 2000
MAX_FILE = 2 * 1024 * 1024
# what lock.py takes for a token: what Afflatus makes, 43 characters; a value far longer or shorter is no token of its
MIN_TOKEN, MAX_TOKEN = 16, 200


def stamp_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def token_of(env):
    """The pod's lock token, or None when it has none that is one: then the server lets nobody in."""
    token = (env.get("AFFLATUS_TOKEN") or "").strip()
    ok = MIN_TOKEN <= len(token) <= MAX_TOKEN and token.isascii() and token.isprintable() and " " not in token
    return token if ok else None


def allowed(header, token):
    """Whether an Authorization header carries the token, compared in constant time."""
    if not token or not isinstance(header, str) or not header[:7].lower() == "bearer ":
        return False
    return hmac.compare_digest(header[7:].strip().encode("utf-8", "replace"), token.encode("utf-8"))


def tail(path, max_lines=MAX_LINES, max_bytes=MAX_BYTES):
    """The log's last lines as {t, m}: read from its end, at most max_bytes of it; none when there is no log yet."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            data = f.read(max_bytes)
    except OSError:
        return []
    lines = data.decode("utf-8", "replace").split("\n")
    # a read that starts inside a line leaves its first piece out: a line cut short says less than none
    if size > max_bytes:
        lines = lines[1:]
    out = []
    for line in lines[-(max_lines + 1):]:
        line = line.rstrip("\r")
        if not line:
            continue
        t, _, m = line.partition(" ")
        out.append({"t": t, "m": m})
    return out[-max_lines:]


def stamp(log, source=None, echo=None):
    """Each line of the start's output into the log with its time, and as it is to `echo`; until the output ends."""
    source = source or sys.stdin.buffer
    echo = echo if echo is not None else sys.stdout.buffer
    for raw in iter(source.readline, b""):
        text = raw.decode("utf-8", "replace").rstrip("\r\n")
        # a progress bar redraws itself with carriage returns on one line: its latest state is what counts
        text = text.rsplit("\r", 1)[-1][-MAX_LINE:]
        try:
            echo.write(raw)
            echo.flush()
        except (OSError, ValueError):
            pass
        try:
            with open(log, "a", encoding="utf-8", newline="\n") as f:
                f.write(f"{stamp_now()} {text}\n")
            if os.path.getsize(log) > MAX_FILE:
                shorten(log)
        except OSError:
            pass


def shorten(log):
    """The log cut to its last half, at a line's start: it lives as long as the pod, ComfyUI writing into it."""
    with open(log, "rb") as f:
        f.seek(-(MAX_FILE // 2), os.SEEK_END)
        kept = f.read()
    kept = kept[kept.find(b"\n") + 1:]
    tmp = log + ".tmp"
    with open(tmp, "wb") as f:
        f.write(kept)
    os.replace(tmp, log)


def handler_for(log, token):
    class Handler(BaseHTTPRequestHandler):
        def answer(self, status, body):
            data = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if not allowed(self.headers.get("Authorization"), token):
                return self.answer(401, {"error": "the pod's token is needed"})
            if self.path.split("?", 1)[0] != ROUTE:
                return self.answer(404, {"error": "not found"})
            return self.answer(200, {"lines": tail(log)})

        def refuse(self):
            self.answer(405, {"error": "GET only"})

        do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = refuse

        def log_message(self, *args):
            # its own requests are not written anywhere: the log is the start's, not the readers'
            pass

    return Handler


def server(log, token, port=BOOT_PORT, host="0.0.0.0"):
    srv = ThreadingHTTPServer((host, port), handler_for(log, token))
    srv.daemon_threads = True
    return srv


def main(argv):
    if len(argv) != 3 or argv[1] not in ("stamp", "serve"):
        print("usage: bootlog.py stamp|serve <log>", file=sys.stderr)
        return 2
    if argv[1] == "stamp":
        stamp(argv[2])
        return 0
    token = token_of(os.environ)
    if not token:
        print("[afflatus-pod] no lock token: the boot log is not served", flush=True)
    server(argv[2], token).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

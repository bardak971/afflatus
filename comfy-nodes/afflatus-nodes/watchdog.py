"""The watchdog of a rented machine: it stops the pod by itself when the Afflatus that rents it goes silent.

A rented GPU bills by the second. Afflatus stops one that sits idle, but Afflatus runs on the user's own computer, which
can crash, sleep or lose its internet; then nothing would stop the pod. So Afflatus says "still here" to this pack every
minute or so (POST /afflatus/alive {"minutes": 15}), and once it has, a thread here stops the pod when that long passes
without it.

How it stops the pod: on RunPod (RUNPOD_POD_ID set in the pod), with `runpodctl stop pod <id>`, or RunPod's API with the
RUNPOD_API_KEY of the pod when runpodctl is not there. Elsewhere it cannot, and says so (`can` false): Afflatus then says
"no watchdog" on the machine. A stop that fails is tried again every few minutes, and said in ComfyUI's console.

Nothing is armed until Afflatus says "still here" with minutes, or the pod's environment says AFFLATUS_WATCHDOG_MINUTES (set by
Afflatus before it starts the pod): then it is armed from ComfyUI's start, so that a PC gone silent right after pressing Start
still has the pod stop. Installing the pack on a ComfyUI of one's own changes nothing. {"minutes": 0} disarms it.

Routes (through the lock when there is one; a JSON body only):
  POST /afflatus/alive {minutes}  → {watching, minutes, can}
  GET  /afflatus/alive  → the same, and how long since the last "still here"
"""

import json
import os
import shutil
import subprocess
import threading
import time
import urllib.request

CHECK_S = 30
RETRY_S = 300
# a stop the provider took, and the pod still running this long after (this code still runs): asked again
AGAIN_S = 300


def how_to_stop(env=None):
    """The way this machine can stop itself, or None: ("runpodctl", pod) or ("api", pod, key)."""
    env = os.environ if env is None else env
    pod = (env.get("RUNPOD_POD_ID") or "").strip()
    if not pod:
        return None
    if shutil.which("runpodctl"):
        return ("runpodctl", pod)
    key = (env.get("RUNPOD_API_KEY") or "").strip()
    return ("api", pod, key) if key else None


def pod_end(env=None):
    """What stopping it means (AFFLATUS_WATCHDOG_ACTION, set by Afflatus): "terminate" for a pod that keeps nothing when
    stopped (no volume: its container disk is erased, its GPU may be taken), so that nothing is left of it; "stop" otherwise."""
    env = os.environ if env is None else env
    return "terminate" if (env.get("AFFLATUS_WATCHDOG_ACTION") or "").strip().lower() == "terminate" else "stop"


def stop_pod(way, run=subprocess.run, opener=urllib.request.urlopen, end=None):
    """Stop (or terminate, as pod_end says) the pod this runs on, the way `how_to_stop` found: True when the provider took it."""
    end = end or pod_end()
    if way[0] == "runpodctl":
        done = run(["runpodctl", "remove" if end == "terminate" else "stop", "pod", way[1]], capture_output=True, text=True, timeout=60)
        return done.returncode == 0
    req = urllib.request.Request(
        f"https://api.runpod.io/v2/pods/{way[1]}/action",
        data=json.dumps({"action": end}).encode("utf-8"),
        headers={"Authorization": f"Bearer {way[2]}", "Content-Type": "application/json"},
        method="POST",
    )
    with opener(req, timeout=60) as res:
        return 200 <= res.status < 300


class Watchdog:
    def __init__(self, way=None, now=time.time, stop=stop_pod):
        self.way = way
        self.now = now
        self.stop = stop
        self.minutes = 0
        self.last = None
        self.tried = None
        self.stopped = False
        self.stopped_at = None
        self._mutex = threading.Lock()

    def alive(self, minutes):
        with self._mutex:
            self.minutes = max(0, int(minutes))
            self.last = self.now()
            self.stopped = False
        return self.view()

    def view(self):
        since = None if self.last is None else round(self.now() - self.last)
        return {"watching": self.minutes > 0 and self.last is not None, "minutes": self.minutes, "can": self.way is not None, "silent_s": since}

    def check(self):
        """Once: stop the pod when Afflatus has been silent past its minutes. True when it was stopped now."""
        with self._mutex:
            if not self.minutes or self.last is None or self.way is None:
                return False
            # stopped, and this still runs: the provider took the stop and the pod goes on (billed); asked again a while after
            if self.stopped:
                if self.now() - self.stopped_at < AGAIN_S:
                    return False
                self.stopped = False
            if self.now() - self.last < self.minutes * 60:
                return False
            if self.tried is not None and self.now() - self.tried < RETRY_S:
                return False
            self.tried = self.now()
        print(f"[afflatus-nodes] Afflatus has been silent for {self.minutes} min: the watchdog {'terminates' if pod_end() == 'terminate' else 'stops'} this pod.")
        try:
            ok = bool(self.stop(self.way))
        except Exception as err:
            ok = False
            print(f"[afflatus-nodes] the watchdog could not stop the pod: {err}")
        if ok:
            with self._mutex:
                self.stopped = True
                self.stopped_at = self.now()
        return ok

    def loop(self):
        while True:
            time.sleep(CHECK_S)
            try:
                self.check()
            except Exception as err:
                print(f"[afflatus-nodes] watchdog: {err}")


def armed_at_start(dog, env=None):
    """Armed from ComfyUI's start when the pod's environment gives the minutes (AFFLATUS_WATCHDOG_MINUTES): the silence counts
    from now, as if Afflatus had just said "still here"."""
    env = os.environ if env is None else env
    try:
        minutes = int((env.get("AFFLATUS_WATCHDOG_MINUTES") or "0").strip())
    except ValueError:
        minutes = 0
    if 0 < minutes <= 24 * 60:
        dog.alive(minutes)
    return dog


def register(routes, web, dog=None):
    dog = armed_at_start(dog or Watchdog(how_to_stop()))

    @routes.get("/afflatus/alive")
    async def _afflatus_alive_state(request):
        return web.json_response(dog.view())

    @routes.post("/afflatus/alive")
    async def _afflatus_alive(request):
        if request.content_type != "application/json":
            return web.Response(status=415, text="a JSON body is expected")
        try:
            body = await request.json()
            minutes = int(body.get("minutes", 0)) if isinstance(body, dict) else 0
        except Exception:
            return web.Response(status=400, text="minutes is a number")
        if minutes < 0 or minutes > 24 * 60:
            return web.Response(status=400, text="minutes is 0 to 1440")
        return web.json_response(dog.alive(minutes))

    threading.Thread(target=dog.loop, name="afflatus-watchdog", daemon=True).start()
    return dog

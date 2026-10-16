"""The watchdog of a rented machine: armed by Afflatus's "still here", it stops the pod once Afflatus goes silent that long."""

import types

from afflatus_nodes import watchdog as W


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def test_nothing_is_armed_until_afflatus_says_still_here():
    stops = []
    dog = W.Watchdog(("runpodctl", "pod1"), now=Clock(), stop=lambda way, end=None: stops.append(way) or True)
    assert dog.view() == {"watching": False, "minutes": 0, "can": True, "silent_s": None, "tries": 0, "end": "stop"}
    assert dog.check() is False and stops == []


def test_stops_the_pod_once_silent_past_its_minutes_and_not_before():
    clock = Clock()
    stops = []
    dog = W.Watchdog(("runpodctl", "pod1"), now=clock, stop=lambda way, end=None: stops.append(way) or True)
    dog.alive(15)
    clock.t += 14 * 60
    assert dog.check() is False
    dog.alive(15)
    clock.t += 15 * 60
    assert dog.check() is True and stops == [("runpodctl", "pod1")]
    # stopped: not again at once
    clock.t += 60
    assert dog.check() is False and len(stops) == 1
    # still running well after a stop the provider took (this code would not run on a stopped pod): asked again
    clock.t += W.AGAIN_S
    assert dog.check() is True and len(stops) == 2


def test_a_stop_that_fails_is_tried_again_later():
    clock = Clock()
    tries = []
    dog = W.Watchdog(("api", "pod1", "key"), now=clock, stop=lambda way, end=None: tries.append(clock.t) and False)
    dog.alive(1)
    clock.t += 61
    assert dog.check() is False
    clock.t += 10
    dog.check()
    clock.t += W.RETRY_S
    dog.check()
    assert len(tries) == 2


def test_zero_minutes_disarms_it():
    clock = Clock()
    stops = []
    dog = W.Watchdog(("runpodctl", "pod1"), now=clock, stop=lambda way, end=None: stops.append(way) or True)
    dog.alive(5)
    dog.alive(0)
    clock.t += 3600
    assert dog.check() is False and stops == []


def test_how_it_stops_the_pod():
    assert W.how_to_stop({}) is None
    assert W.how_to_stop({"RUNPOD_POD_ID": "abc", "RUNPOD_API_KEY": "k"})[0] in ("runpodctl", "api")
    ran = []
    assert W.stop_pod(("runpodctl", "abc"), run=lambda cmd, **kw: ran.append(cmd) or types.SimpleNamespace(returncode=0)) is True
    assert ran == [["runpodctl", "stop", "pod", "abc"]]
    asked = []

    class Res:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    assert W.stop_pod(("api", "abc", "rpa_key"), opener=lambda req, timeout: asked.append(req) or Res()) is True
    assert asked[0].full_url == "https://api.runpod.io/v2/pods/abc/action" and asked[0].headers["Authorization"] == "Bearer rpa_key"


def test_a_pod_that_keeps_nothing_is_terminated_not_stopped():
    import json as J
    assert W.pod_end({}) == "stop"
    assert W.pod_end({"AFFLATUS_WATCHDOG_ACTION": "terminate"}) == "terminate"
    ran = []
    W.stop_pod(("runpodctl", "abc"), run=lambda cmd, **kw: ran.append(cmd) or types.SimpleNamespace(returncode=0), end="terminate")
    assert ran == [["runpodctl", "remove", "pod", "abc"]]
    asked = []

    class Res:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    W.stop_pod(("api", "abc", "rpa_key"), opener=lambda req, timeout: asked.append(req) or Res(), end="terminate")
    assert J.loads(asked[0].data) == {"action": "terminate"}


def test_without_a_way_to_stop_it_says_so_and_does_nothing():
    clock = Clock()
    dog = W.Watchdog(None, now=clock, stop=lambda way, end=None: True)
    assert dog.alive(5)["can"] is False
    clock.t += 3600
    assert dog.check() is False


def test_armed_from_its_start_when_the_pods_environment_says_so():
    clock = Clock()
    stops = []
    dog = W.armed_at_start(W.Watchdog(("runpodctl", "pod1"), now=clock, stop=lambda way, end=None: stops.append(way) or True), env={"AFFLATUS_WATCHDOG_MINUTES": "15"})
    assert dog.view()["watching"] is True and dog.minutes == 15
    # Afflatus never says anything (the PC went to sleep after Start): stopped all the same
    clock.t += 15 * 60
    assert dog.check() is True and stops == [("runpodctl", "pod1")]
    for env in ({}, {"AFFLATUS_WATCHDOG_MINUTES": "0"}, {"AFFLATUS_WATCHDOG_MINUTES": "soon"}):
        assert W.armed_at_start(W.Watchdog(("runpodctl", "pod1"), now=clock), env=env).view()["watching"] is False


def test_a_stop_that_keeps_failing_becomes_a_terminate():
    clock = Clock()
    asked = []
    dog = W.Watchdog(("api", "pod1", "key"), now=clock, stop=lambda way, end=None: asked.append(end) and False, env={})
    dog.alive(1)
    clock.t += 61
    for _ in range(W.ESCALATE_AFTER + 2):
        dog.check()
        clock.t += W.RETRY_S
    # the stops RunPod refused, then a terminate (a volume keeps its files through it), and terminates from then on
    assert asked[: W.ESCALATE_AFTER] == ["stop"] * W.ESCALATE_AFTER
    assert asked[W.ESCALATE_AFTER :] == ["terminate", "terminate"]
    # said where Afflatus (or a person) reads it
    assert dog.view()["end"] == "terminate" and dog.view()["tries"] == W.ESCALATE_AFTER + 2


def test_a_stop_taken_that_leaves_the_pod_running_becomes_a_terminate():
    clock = Clock()
    asked = []
    dog = W.Watchdog(("runpodctl", "pod1"), now=clock, stop=lambda way, end=None: asked.append(end) or True, env={})
    dog.alive(1)
    clock.t += 61
    for _ in range(W.ESCALATE_AFTER + 1):
        assert dog.check() is True
        clock.t += W.AGAIN_S
    assert asked == ["stop"] * W.ESCALATE_AFTER + ["terminate"]


def test_afflatus_back_starts_the_next_silence_with_a_stop_again():
    clock = Clock()
    asked = []
    dog = W.Watchdog(("api", "pod1", "key"), now=clock, stop=lambda way, end=None: asked.append(end) and False, env={})
    dog.alive(1)
    clock.t += 61
    for _ in range(W.ESCALATE_AFTER):
        dog.check()
        clock.t += W.RETRY_S
    dog.alive(1)
    assert dog.view()["tries"] == 0 and dog.view()["end"] == "stop"
    clock.t += 61
    dog.check()
    assert asked[-1] == "stop"


def test_a_pod_that_keeps_nothing_is_terminated_from_the_first_ask():
    clock = Clock()
    asked = []
    dog = W.Watchdog(("runpodctl", "pod1"), now=clock, stop=lambda way, end=None: asked.append(end) or True, env={"AFFLATUS_WATCHDOG_ACTION": "terminate"})
    dog.alive(1)
    clock.t += 61
    dog.check()
    assert asked == ["terminate"]

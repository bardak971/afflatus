"""ComfyUI's server keeps answering on Windows after a client went away before its connection was accepted."""

import types

from afflatus_nodes import accept_guard as G


class Future:
    def __init__(self, result=None, error=None):
        self.result_value, self.error, self.callbacks = result, error, []

    def result(self):
        if self.error:
            raise self.error
        return self.result_value

    def add_done_callback(self, cb):
        self.callbacks.append(cb)


class Sock:
    def __init__(self):
        self.closed = False

    def fileno(self):
        return -1 if self.closed else 7

    def close(self):
        self.closed = True


def stand_in():
    """asyncio.proactor_events as far as the guard uses it, with a loop that runs what it is given at once."""

    class BaseProactorEventLoop:
        def _start_serving(self, protocol_factory, sock, sslcontext=None, server=None, backlog=100, ssl_handshake_timeout=None, ssl_shutdown_timeout=None):
            raise AssertionError("the stock loop")

    module = types.SimpleNamespace(
        BaseProactorEventLoop=BaseProactorEventLoop, trsock=types.SimpleNamespace(TransportSocket=lambda s: s),
        exceptions=types.SimpleNamespace(CancelledError=type("CancelledError", (BaseException,), {})), logger=None,
    )
    return module


def a_loop(module, accepts):
    loop = module.BaseProactorEventLoop()
    loop._debug, loop._accept_futures, loop.errors, loop.made = False, {}, [], []
    loop.is_closed = lambda: False
    loop.call_soon = lambda fn: fn()
    loop.call_exception_handler = lambda ctx: loop.errors.append(ctx["message"])
    loop._make_socket_transport = lambda conn, protocol, extra, server: loop.made.append(conn)
    loop._proactor = types.SimpleNamespace(accept=lambda sock: accepts.pop(0))
    return loop


def gone(code):
    e = OSError(22, "gone")
    e.winerror = code
    return e


def test_a_client_gone_before_it_was_accepted_leaves_the_socket_listening():
    module = stand_in()
    assert G.install(module) is True
    # installed once
    assert G.install(module) is False
    sock = Sock()
    first, second, third = Future(error=gone(64)), Future(result=("conn", "addr")), Future()
    loop = a_loop(module, [first, second, third])
    loop._start_serving(lambda: "protocol", sock)
    first.callbacks[0](first)  # the client went away: WinError 64
    assert sock.closed is False and loop.errors == []
    second.callbacks[0](second)  # the next one comes in as usual
    assert loop.made == ["conn"] and third.callbacks


def test_any_other_accept_error_still_closes_the_socket_as_asyncio_does():
    module = stand_in()
    G.install(module)
    sock = Sock()
    first = Future(error=gone(10055))
    loop = a_loop(module, [first])
    loop._start_serving(lambda: "protocol", sock)
    first.callbacks[0](first)
    assert sock.closed is True and loop.errors == ["Accept failed on a socket"]


def test_a_loop_not_shaped_like_the_one_it_was_written_from_is_left_alone():
    module = stand_in()
    module.BaseProactorEventLoop._start_serving = lambda self, protocol_factory, sock: None
    assert G.install(module) is False

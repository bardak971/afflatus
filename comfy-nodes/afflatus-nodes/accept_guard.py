"""ComfyUI's server kept answering on Windows after a client went away.

On Windows, asyncio's proactor loop closes a server's listening socket for good when one accept fails, whatever the
reason (BaseProactorEventLoop._start_serving: "Accept failed on a socket", then sock.close()). A client that drops its
connection before it is accepted (a status poll that timed out, a page closed while it loaded) makes that accept fail
with WinError 64, ERROR_NETNAME_DELETED: ComfyUI then goes on rendering but never answers again, until it is restarted.
It happened twice on one machine in a night of renders (2026-10-13 and 14).

`install()` puts back the same accept loop, with one change: when the accept failed only because that one client went
away (WinError 64, or 1236, ERROR_CONNECTION_ABORTED), the next accept is armed instead of the socket being closed.
Every other error is handled as asyncio handles it. Nothing is changed off Windows, nor on a Python whose loop does not
look like the one this is written from (3.11 to 3.13): the guard then stays out.
"""

import inspect
import sys

# ERROR_NETNAME_DELETED, ERROR_CONNECTION_ABORTED: the client is gone, the socket that listens is fine
DROPPED = {64, 1236}


def dropped_client(exc) -> bool:
    return isinstance(exc, OSError) and getattr(exc, "winerror", None) in DROPPED


_PARAMS = ["self", "protocol_factory", "sock", "sslcontext", "server", "backlog", "ssl_handshake_timeout", "ssl_shutdown_timeout"]


def install(module=None) -> bool:
    """Puts the guarded accept loop in place: True when it did. `module`: asyncio.proactor_events, or a stand-in (tests)."""
    if module is None:
        if sys.platform != "win32":
            return False
        import asyncio.proactor_events as module
    cls = module.BaseProactorEventLoop
    if getattr(cls, "_afflatus_accept_guard", False):
        return False
    if list(inspect.signature(cls._start_serving).parameters) != _PARAMS:
        return False
    trsock, exceptions, logger = module.trsock, module.exceptions, module.logger

    # asyncio's own loop (CPython 3.12, Lib/asyncio/proactor_events.py), with the dropped client let through
    def _start_serving(self, protocol_factory, sock, sslcontext=None, server=None, backlog=100, ssl_handshake_timeout=None, ssl_shutdown_timeout=None):
        def loop(f=None):
            try:
                if f is not None:
                    conn, addr = f.result()
                    if self._debug:
                        logger.debug("%r got a new connection from %r: %r", server, addr, conn)
                    protocol = protocol_factory()
                    if sslcontext is not None:
                        self._make_ssl_transport(
                            conn, protocol, sslcontext, server_side=True, extra={"peername": addr}, server=server,
                            ssl_handshake_timeout=ssl_handshake_timeout, ssl_shutdown_timeout=ssl_shutdown_timeout)
                    else:
                        self._make_socket_transport(conn, protocol, extra={"peername": addr}, server=server)
                if self.is_closed():
                    return
                f = self._proactor.accept(sock)
            except OSError as exc:
                if dropped_client(exc) and sock.fileno() != -1 and not self.is_closed():
                    # only that client went away: wait for the next one, as if it had never come
                    self.call_soon(loop)
                elif sock.fileno() != -1:
                    self.call_exception_handler({"message": "Accept failed on a socket", "exception": exc, "socket": trsock.TransportSocket(sock)})
                    sock.close()
                elif self._debug:
                    logger.debug("Accept failed on socket %r", sock, exc_info=True)
            except exceptions.CancelledError:
                sock.close()
            else:
                self._accept_futures[sock.fileno()] = f
                f.add_done_callback(loop)

        self.call_soon(loop)

    cls._start_serving = _start_serving
    cls._afflatus_accept_guard = True
    return True
